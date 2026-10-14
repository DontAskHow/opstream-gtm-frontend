#!/usr/bin/env python3
"""Shape the one-page GTM workspace's data: brain.db (read-only) -> one JSON.

    python3 scripts/workspace-data.py --db brain.db --lead-sources lead-sources.json \
        [--lost-reasons f] [--insights f] [--lead-insights f] [--prior live_deals.json ...] \
        [--current-page data.json] [--portal-id N] [--as-of ISO] --out workspace.json

onepage/build.mjs renders the JSON. All scope rules are applied here, once:
Sales Pipeline only, CS owners and customer companies out of meetings and calls,
the hidden owner rendered as "Unassigned" (shared/workspace-scope.json), and the
Oct 13 2026 reporting rules (config/lead-rules.json "reporting", ReportingScope):
customers, free-mail and internal addresses and careers forms out of the form
counts, meeting bookings, ad-platform leads and a separate lead -> MQL figure,
all in added fields (existing fields keep their meaning). 'fresh' carries
the record sets the fresh frontend read from its one-time extract, under the same rules
(docs/workspace-fresh.md). 'strategy' (added last) carries contact lifecycle and conversion
fields, contact -> deal ids and dealstage entry times, by HubSpot id (docs/workspace-strategy.md). Lead
sources are mapped from lead-sources.json only, so a mapping change edits that
file. Tables the sync has not written yet (forms, lists, imports, Lemlist leads,
contact source fields) are used when present and listed as "not yet synced"
when absent. Nothing is estimated: a missing value is null.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.parse
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_BYTES = 3 * 1048576
try:
    TZ = ZoneInfo('America/Phoenix')
except Exception:  # slim images may lack the tz database; Phoenix has no DST, so UTC-7 is exact
    TZ = timezone(timedelta(hours=-7), 'MST')
SCOPE = json.load(open(os.path.join(ROOT, 'shared', 'workspace-scope.json'), encoding='utf-8'))
OPEN_DEF = json.load(open(os.path.join(ROOT, 'shared', 'open-pipeline.json'), encoding='utf-8'))
UNASSIGNED = SCOPE['hiddenOwner']['label']
FREE_MAIL = {'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'me.com', 'msn.com', 'protonmail.com'}
NEW_SOURCES = [
    ('hubspot_forms', 'HubSpot forms'),
    ('hubspot_form_submissions', 'HubSpot form submissions'),
    ('hubspot_lists', 'HubSpot lists'),
    ('hubspot_list_memberships', 'HubSpot list memberships'),
    ('hubspot_imports', 'HubSpot imports'),
    ('lemlist_leads', 'Lemlist leads'),
]
CONTACT_SOURCE_PROPS = ['hs_analytics_source', 'hs_analytics_source_data_1', 'hs_analytics_source_data_2',
                        'first_conversion_event_name', 'first_conversion_date', 'hs_object_source',
                        'hs_object_source_label', 'hs_object_source_detail_1', 'hs_google_click_id', 'paid_touch_campaign']
# Read for the Oct 13 reporting rules; listed apart (meta.reportingContactFields), so meta.contactSourceFields keeps its meaning.
REPORTING_CONTACT_PROPS = ['recent_conversion_event_name', 'recent_conversion_date', 'num_conversion_events',
                           'hs_analytics_first_url', 'hs_analytics_first_referrer']
SOURCE_LABELS = {'hubspot': 'HubSpot', 'hubspot_extras': 'HubSpot deal history', 'sheets': 'Sheets', 'fathom': 'Fathom',
                 'lemlist': 'Lemlist', 'ga4': 'GA4', 'otterly': 'Otterly'}


# ---------- small helpers ----------
def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s or s in ('-', '—') or not re.search(r'\d', s):
        return None
    neg = s.startswith('(') and s.endswith(')')
    try:
        n = float(re.sub(r'[^0-9.\-]', '', s))
    except ValueError:
        return None
    return -n if neg else n


def parse_time(v):
    """ISO date-time, YYYY-MM-DD, M/D/YYYY or epoch ms -> aware UTC datetime (dates at noon PT)."""
    if v is None or v == '':
        return None
    s = str(v).strip()
    if re.fullmatch(r'\d{12,13}', s):
        return datetime.fromtimestamp(int(s) / 1000, timezone.utc)
    m = re.fullmatch(r'(\d{1,2})/(\d{1,2})/(\d{4})', s)
    if m:
        s = '%s-%02d-%02d' % (m.group(3), int(m.group(1)), int(m.group(2)))
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', s):
        try:
            return datetime.fromisoformat(s + 'T12:00:00').replace(tzinfo=TZ).astimezone(timezone.utc)
        except ValueError:
            return None
    try:
        d = datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z') if dt else None


def ymd(dt):
    return dt.astimezone(TZ).strftime('%Y-%m-%d') if dt else None


def fmt_pt(dt, with_time=True):
    if not dt:
        return '—'
    p = dt.astimezone(TZ)
    s = p.strftime('%b ') + str(p.day)
    if p.year != datetime.now(TZ).year:
        s += ', %d' % p.year
    if with_time:
        s += ', ' + p.strftime('%I:%M %p').lstrip('0') + ' PT'
    return s


def letters(s):
    return re.sub(r'[^a-z]', '', str(s or '').lower())


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()


def squash(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())


def domain_of(v):
    s = str(v or '').strip().lower()
    if '@' in s:
        s = s.rsplit('@', 1)[1]
    s = re.sub(r'^[a-z]+://', '', s).split('/')[0].split('?')[0]
    return s[4:] if s.startswith('www.') else s


def truthy(v):
    return str(v).strip().lower() in ('true', '1', 'yes')


def money0(v):
    return None if v is None else round(v, 2)


def provisional_label(lead_sources):
    """'provisional (awaiting <who>)', with who from lead-sources.json's needs_<who> key; no name in this repo."""
    key = next((k for k in (lead_sources or {}) if k.startswith('needs_') and k != 'needs_'), None)
    return 'provisional (awaiting %s)' % (key[6:].replace('_', ' ').title() if key else 'sign-off')


def read_json(path, what, warn):
    if not path:
        return None
    if not os.path.exists(path):
        warn('warn: %s %s not found; its part of the page shows an empty state' % (what, path))
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ---------- brain access ----------
class Brain:
    def __init__(self, path):
        if not os.path.exists(path):
            raise SystemExit('brain.db not found: %s' % path)
        self.con = sqlite3.connect('file:%s?mode=ro' % os.path.abspath(path), uri=True)
        self.tables = {r[0] for r in self.con.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    def has(self, table):
        return table in self.tables

    def cols(self, table):
        return [r[1] for r in self.con.execute('PRAGMA table_info(%s)' % table)] if self.has(table) else []

    def q(self, sql, args=()):
        try:
            return list(self.con.execute(sql, args))
        except sqlite3.Error:
            return []

    def objects(self, kind, fields):
        sel = ', '.join("json_extract(properties_json, '$.%s')" % f for f in fields)
        return self.q('SELECT hs_id, %s FROM hubspot_objects WHERE object_type=?' % sel, (kind,))

    def sheet(self, title, tab):
        out = []
        for n, raw in self.q('SELECT row_num, row_json FROM sheets_data WHERE spreadsheet_title=? AND tab=? ORDER BY row_num', (title, tab)):
            try:
                out.append((n, json.loads(raw) or []))
            except ValueError:
                out.append((n, []))
        return out


def cell(row, i):
    return str(row[i]).strip() if i is not None and isinstance(row, list) and len(row) > i and row[i] is not None else ''


class Assoc:
    """Both directions of the HubSpot association pairs the page needs."""

    PAIRS = [('deals', 'companies'), ('deals', 'contacts'), ('meetings', 'contacts'), ('meetings', 'companies'), ('meetings', 'deals'),
             ('contacts', 'companies')]

    def __init__(self, brain):
        self.m = {}
        for a, b in self.PAIRS:
            for f, t in brain.q('SELECT from_id, to_id FROM hubspot_associations WHERE from_type=? AND to_type=?', (a, b)):
                self.m.setdefault((a, f, b), set()).add(t)
                self.m.setdefault((b, t, a), set()).add(f)

    def get(self, a, i, b):
        # Sorted, so output order never depends on set iteration (hash randomization would
        # otherwise reorder lists between runs and look like a content change to the sync).
        return sorted(self.m.get((a, i, b), ()))


# ---------- hidden people (scrub patterns) ----------
def load_scrub_patterns(path=None, env=None):
    """Patterns for people who must not appear: env WORKSPACE_SCRUB_PATTERNS (comma list), else a file
    (WORKSPACE_SCRUB_PATTERNS_FILE or the given path; comma- or line-separated). Never stored in the repo."""
    env = os.environ if env is None else env
    raw = env.get('WORKSPACE_SCRUB_PATTERNS') or ''
    path = path or env.get('WORKSPACE_SCRUB_PATTERNS_FILE')
    if not raw.strip() and path and os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            raw = f.read()
    return sorted({x.strip().lower() for x in re.split(r'[,\n]', raw) if x.strip() and not x.strip().startswith('#')})


class Scrubber:
    def __init__(self, patterns, names):
        self.patterns = [p.lower() for p in patterns]
        names = sorted({n for n in names if n and len(n) >= 3}, key=len, reverse=True)
        self.names = re.compile('|'.join(re.escape(n) for n in names), re.I) if names else None
        self.token = re.compile(r'[\w.+\-]*(?:' + '|'.join(re.escape(p) for p in self.patterns) + r')[\w.+\-]*(?:@[\w.\-]+)?', re.I) if self.patterns else None

    def hit(self, s):
        low = s.lower()
        return any(p in low for p in self.patterns)

    def text(self, s):
        if not isinstance(s, str) or not self.hit(s):
            return s
        if self.names:
            s = self.names.sub(UNASSIGNED, s)
        return self.token.sub(UNASSIGNED, s)

    def deep(self, o):
        if isinstance(o, str):
            return self.text(o)
        if isinstance(o, list):
            return [self.deep(x) for x in o]
        if isinstance(o, dict):
            return {self.text(k): self.deep(v) for k, v in o.items()}
        return o

    def person(self, s):
        """An owner/attribution field: a hidden person, blank or 'not assigned' -> Unassigned."""
        s = str(s or '').strip()
        if not s or s.lower() in ('not assigned', 'unassigned', 'none', 'n/a'):
            return UNASSIGNED
        return UNASSIGNED if self.hit(s) else s


def load_owners(brain, patterns):
    owners, hidden = {}, []
    for oid, first, last, email in brain.q('SELECT id, first_name, last_name, email FROM hubspot_owners'):
        name = ' '.join(x for x in [first, last] if x).strip() or (email or '').split('@')[0]
        blob = ('%s %s %s' % (first or '', last or '', email or '')).lower()
        is_hidden = any(p in blob for p in patterns)
        if is_hidden:
            hidden += [name, email]
        owners[str(oid)] = {'name': UNASSIGNED if is_hidden else name, 'email': (email or '').strip().lower(),
                            'hidden': is_hidden}
    return owners, Scrubber(patterns, hidden)


# ---------- deals and the headline ----------
def load_stages(brain):
    stages = {}
    for pid, plabel, sid, slabel, order, closed, prob in brain.q(
            'SELECT pipeline_id, pipeline_label, stage_id, stage_label, display_order, is_closed, probability FROM hubspot_pipelines'):
        stages[(str(pid), str(sid))] = {'pipeline': plabel, 'label': slabel, 'order': order if order is not None else 99,
                                        'closed': bool(closed), 'prob': num(prob)}
    return stages


ON_HOLD = {letters(x) for x in OPEN_DEF['onHoldStageLabels']}


def shape_deal(hs_id, p, stage_meta, owners, company_ids):
    """One HubSpot deal. stage_meta: {label, closed, prob, order} or None."""
    closed = stage_meta['closed'] if stage_meta else truthy(p.get('hs_is_closed'))
    won_flag = p.get('hs_is_closed_won')
    won = closed and (truthy(won_flag) if won_flag is not None else bool(stage_meta and stage_meta.get('prob') == 1))
    label = stage_meta['label'] if stage_meta else OPEN_DEF['fallbackNames']['stage']
    prob = num(p.get('hs_deal_stage_probability'))
    if prob is None and stage_meta:
        prob = stage_meta.get('prob')
    owner = owners.get(str(p.get('hubspot_owner_id') or ''), {}).get('name') or UNASSIGNED
    return {
        'id': str(hs_id), 'name': p.get('dealname') or OPEN_DEF['fallbackNames']['deal'],
        'pipeline': str(p.get('pipeline') or ''), 'stageId': str(p.get('dealstage') or ''), 'stage': label,
        'stageOrder': stage_meta['order'] if stage_meta else 99,
        'amount': num(p.get('amount')), 'probability': prob,
        'open': not closed, 'onHold': (not closed) and letters(label) in ON_HOLD, 'won': won, 'lost': closed and not won,
        'close': p.get('closedate'), 'created': p.get('createdate'), 'modified': p.get('hs_lastmodifieddate'),
        'owner': owner, 'ownerId': str(p.get('hubspot_owner_id') or ''), 'lostReason': p.get('closed_lost_reason') or None,
        'companyIds': sorted(company_ids),
    }


def totals(deals):
    priced = [d for d in deals if d['amount'] is not None]
    weighted = [d for d in priced if d['probability'] is not None]
    return {'count': len(deals), 'amount': money0(sum(d['amount'] for d in priced)),
            'weighted': money0(sum(d['amount'] * d['probability'] for d in weighted)),
            'noAmount': len(deals) - len(priced), 'noProbability': len(priced) - len(weighted)}


def load_deals(brain, stages, owners, assoc):
    extras, history = {}, {}
    for did, cids in brain.q('SELECT deal_id, company_ids FROM hubspot_deal_extras'):
        try:
            extras[str(did)] = set(json.loads(cids or '[]'))
        except ValueError:
            pass
    # dealstage history (newest first), written by hubspot_sync.py; absent until that sync has run.
    if 'stage_history' in brain.cols('hubspot_deal_extras'):
        for did, raw in brain.q('SELECT deal_id, stage_history FROM hubspot_deal_extras WHERE stage_history IS NOT NULL'):
            try:
                history[str(did)] = [h for h in json.loads(raw) if isinstance(h, dict)]
            except (TypeError, ValueError):
                pass
    deals = []
    for hs_id, pj in brain.q("SELECT hs_id, properties_json FROM hubspot_objects WHERE object_type='deals'"):
        p = json.loads(pj or '{}')
        meta = stages.get((str(p.get('pipeline')), str(p.get('dealstage'))))
        cids = assoc.get('deals', str(hs_id), 'companies') or sorted(extras.get(str(hs_id), set()))
        d = shape_deal(hs_id, p, meta, owners, cids)
        d['stageHistory'] = history.get(d['id'])
        deals.append(d)
    return deals


def headline(sales, stages):
    open_ = [d for d in sales if d['open'] and not d['onHold']]
    hold = [d for d in sales if d['onHold']]
    order = sorted({(m['order'], sid, m['label']) for (pid, sid), m in stages.items()
                    if pid == SCOPE['salesPipelineId'] and not m['closed']})
    rows = []
    for o, sid, label in order:
        xs = [d for d in sales if d['open'] and d['stageId'] == sid]
        t = totals(xs)
        default = stages[(SCOPE['salesPipelineId'], sid)]['prob']
        # Blended: the stage's weighted ÷ its amount, so per-deal probabilities that differ from the stage default
        # show; mixed says some do.
        t.update({'id': sid, 'label': label, 'onHold': letters(label) in ON_HOLD, 'probability': default,
                  'blendedProbability': (t['weighted'] / t['amount']) if t['amount'] else None,
                  'probabilityMixed': any(d['probability'] is not None and default is not None
                                          and abs(d['probability'] - default) > 1e-9 for d in xs)})
        rows.append(t)
    return {'open': totals(open_), 'onHold': totals(hold), 'stages': rows}


def load_prior(path):
    with open(path, encoding='utf-8') as f:
        d = json.load(f)
    fetched = d.get('fetchedAt')
    if isinstance(d.get('live'), dict):
        d = d['live']
        fetched = d.get('fetchedAt') or fetched
    if not isinstance(d.get('deals'), list) or not isinstance(d.get('stages'), dict):
        raise ValueError('%s is not a HubSpot deals export (stages{}, deals[])' % path)
    if not fetched:
        fetched = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat()
    deals = {}
    for x in d['deals']:
        p = x.get('properties') or {}
        sid = str(p.get('dealstage') or '')
        s = d['stages'].get(sid)
        meta = None
        if isinstance(s, dict):
            meta = {'label': s.get('label'), 'closed': bool(s.get('closed')), 'prob': num(s.get('prob')), 'order': 99}
        deal = shape_deal(x.get('id') or p.get('hs_object_id'), p, meta, {}, set())
        deals[deal['id']] = deal
    return {'path': path, 'fetchedAt': parse_time(fetched), 'deals': deals}


def in_headline(d):
    return d['pipeline'] == SCOPE['salesPipelineId'] and d['open'] and not d['onHold']


def headline_change(sales, priors, data_at, as_of):
    """What moved the headline since an earlier HubSpot export (or, without one, since createdate)."""
    cur = {d['id']: d for d in sales}
    cur_open = {i for i, d in cur.items() if in_headline(d)}
    now_t = totals([cur[i] for i in cur_open])
    to = {'count': now_t['count'], 'amount': now_t['amount'], 'weighted': now_t['weighted']}
    usable = sorted((p for p in priors if p['fetchedAt'] and (not data_at or p['fetchedAt'] < data_at)),
                    key=lambda p: p['fetchedAt'], reverse=True)
    prior = None
    for p in usable:
        t = totals([d for d in p['deals'].values() if in_headline(d)])
        if (t['count'], t['amount']) != (to['count'], to['amount']):
            prior = (p, t)
            break
    if not prior and usable:
        p = usable[0]
        prior = (p, totals([d for d in p['deals'].values() if in_headline(d)]))
    moved = []
    if prior:
        p, t = prior
        old = p['deals']
        old_open = {i for i, d in old.items() if in_headline(d)}
        for i in sorted(cur_open | old_open | {i for i in cur_open & set(old) if old[i]['stageId'] != cur[i]['stageId']}):
            n, o = cur.get(i), old.get(i)
            row = {'id': i, 'name': (n or o)['name'], 'amount': (n or o)['amount'],
                   'fromStage': o['stage'] if o else None, 'toStage': n['stage'] if n else None,
                   'created': n['created'] if n else None}
            if i in cur_open and i not in old_open:
                row['kind'] = 'new' if not o else 'in'
            elif i in old_open and i not in cur_open:
                row['kind'] = 'out'
            elif n and o and n['amount'] != o['amount']:
                row.update(kind='amount', fromAmount=o['amount'])
            elif n and o and n['stageId'] != o['stageId']:
                row['kind'] = 'stage'
            else:
                continue
            moved.append(row)
        basis = ('Compared with the HubSpot deals export fetched %s (%s). "New" means the deal was not in that export '
                 '(HubSpot createdate shown); "stage" is a move between open stages, which leaves the totals unchanged.'
                 % (fmt_pt(p['fetchedAt']), os.path.basename(p['path'])))
        frm = {'count': t['count'], 'amount': t['amount'], 'weighted': t['weighted']}
        since = iso(p['fetchedAt'])
    else:
        since_dt = as_of - timedelta(days=1)
        for i in sorted(cur_open):
            d = cur[i]
            c = parse_time(d['created'])
            if c and c >= since_dt:
                moved.append({'id': i, 'name': d['name'], 'amount': d['amount'], 'fromStage': None, 'toStage': d['stage'],
                              'created': d['created'], 'kind': 'new'})
        new = [cur[m['id']] for m in moved]
        nt = totals(new)
        frm = {'count': to['count'] - nt['count'], 'amount': money0((to['amount'] or 0) - (nt['amount'] or 0)), 'weighted': None}
        basis = ('No earlier HubSpot export was given, so this lists open deals HubSpot created in the 24 hours before %s '
                 '(createdate); stage moves are not visible without an export.' % fmt_pt(as_of))
        since = iso(since_dt)
    order = {'new': 0, 'in': 1, 'out': 2, 'amount': 3, 'stage': 4}
    moved.sort(key=lambda m: (order[m['kind']], -(m['amount'] or 0), m['name']))
    return {'from': frm, 'to': to, 'since': since, 'deals': moved, 'basis': basis,
            'changed': (frm['count'], frm['amount']) != (to['count'], to['amount'])}


# ---------- companies, customers and the call rule ----------
def load_companies(brain, owners):
    comps = {}
    for cid, name, domain, life, owner in brain.objects('companies', ['name', 'domain', 'lifecyclestage', 'hubspot_owner_id']):
        comps[str(cid)] = {'id': str(cid), 'name': name or '', 'domain': domain_of(domain), 'lifecycle': life or '',
                           'owner': owners.get(str(owner or ''), {}).get('name') or UNASSIGNED, 'ownerId': str(owner or ''),
                           'deals': [], 'firstWon': None, 'csDeal': False, 'salesDeal': False}
    return comps


def attach_deals(comps, deals):
    for d in deals:
        for cid in d['companyIds']:
            c = comps.get(cid)
            if not c:
                continue
            c['deals'].append(d)
            if d['pipeline'] in SCOPE['customerPipelines']:
                c['csDeal'] = True
            if d['pipeline'] == SCOPE['salesPipelineId']:
                c['salesDeal'] = True
            if d['won']:
                t = parse_time(d['close'])
                if t and (c['firstWon'] is None or t < c['firstWon']):
                    c['firstWon'] = t


def is_customer_company(c):
    return c['lifecycle'] == 'customer' or c['firstWon'] is not None or c['csDeal']


def customer_at(c, t):
    """The call rule for one company at time t (None = unknown time: any customer sign counts)."""
    if c['csDeal']:
        return True
    if c['firstWon'] is not None:
        return t is None or t >= c['firstWon']
    return c['lifecycle'] == 'customer'


def sales_deal_of(c):
    """The company's most relevant Sales Pipeline deal: open first, then the largest."""
    xs = [d for d in c['deals'] if d['pipeline'] == SCOPE['salesPipelineId']]
    xs.sort(key=lambda d: (not d['open'], d['onHold'], -(d['amount'] or 0)))
    return xs[0] if xs else None


def deal_ref(d):
    return {'id': d['id'], 'name': d['name'], 'stage': d['stage'], 'amount': d['amount'], 'open': d['open'],
            'won': d['won'], 'owner': d['owner'], 'sourceOverride': d.get('sourceOverride')} if d else None


# ---------- contacts ----------
def load_contacts(brain, owners, assoc):
    present = [p for p in CONTACT_SOURCE_PROPS + discover_utm_props(brain) + REPORTING_CONTACT_PROPS
               if brain.q("SELECT 1 FROM hubspot_objects WHERE object_type='contacts' AND json_type(properties_json, '$.%s') IS NOT NULL LIMIT 1" % p)]
    fields = ['email', 'firstname', 'lastname', 'jobtitle', 'lifecyclestage', 'hubspot_owner_id', 'createdate'] + present
    contacts, by_email = {}, {}
    for row in brain.objects('contacts', fields):
        cid, rest = str(row[0]), dict(zip(fields, row[1:]))
        email = (rest.pop('email') or '').strip().lower()
        owner_id = str(rest.pop('hubspot_owner_id') or '')
        c = {'id': cid, 'email': email,
             'name': ' '.join(x for x in [rest.pop('firstname'), rest.pop('lastname')] if x).strip() or None,
             'title': rest.pop('jobtitle'), 'lifecycle': rest.pop('lifecyclestage') or '',
             'owner': owners.get(owner_id, {}).get('name') or UNASSIGNED, 'ownerId': owner_id,
             'created': rest.pop('createdate'), 'props': {k: v for k, v in rest.items() if v not in (None, '')},
             'companies': assoc.get('contacts', cid, 'companies')}
        contacts[cid] = c
        if email:
            by_email.setdefault(email, c)
    return contacts, by_email, present


def reporting_fields_synced(brain, present):
    """The reporting contact fields every stored contact has (config reporting.adLeads.contactFields): the contact
    backfill finished, having started after the field was added to the sync, or at least minCoverage of contacts
    carry the key. The sync stores requested-but-unset properties as JSON null, so one incremental run writes the
    key onto the contacts it read; that alone is partial. Returns ({field: synced}, {field: coverage})."""
    cfg = REPORTING['adLeads']['contactFields']
    fields = [p for p in REPORTING_CONTACT_PROPS if p in present]
    total, *have = brain.q("SELECT count(*)%s FROM hubspot_objects WHERE object_type='contacts'" % ''.join(
        ", sum(json_type(properties_json, '$.%s') IS NOT NULL)" % p for p in fields))[0] if fields else (0,)
    coverage = {p: round((n or 0) / total, 4) if total else 0.0 for p, n in zip(fields, have)}
    state = {}
    if brain.has('sync_state'):
        row = brain.q("SELECT watermark FROM sync_state WHERE source='hubspot_contact_backfill'")
        try:
            state = json.loads(row[0][0]) if row and row[0][0] else {}
        except (TypeError, ValueError):
            state = {}
    started = parse_time(state.get('startedAt')) if isinstance(state, dict) and state.get('done') else None
    synced = {}
    for p in REPORTING_CONTACT_PROPS:
        added = parse_time(cfg['addedAt'].get(p)) if cfg['addedAt'].get(p) else None
        by_backfill = bool(started and p in coverage and (added is None or started >= added))
        synced[p] = by_backfill or coverage.get(p, 0.0) >= cfg['minCoverage']
    return synced, coverage


def discover_utm_props(brain):
    rows = brain.q("SELECT properties_json FROM hubspot_objects WHERE object_type='contacts' AND properties_json LIKE '%utm%' LIMIT 200")
    keys = set()
    for (pj,) in rows:
        try:
            keys |= {k for k in json.loads(pj) if 'utm' in k.lower()}
        except ValueError:
            pass
    return sorted(keys)


# ---------- freshness and staleness ----------
def freshness(brain, as_of):
    rows = []
    for source, at, ok, _route, _http, detail, last_ok in brain.q(
            'SELECT source, at, ok, route, http, detail, last_ok_at FROM sync_outcomes ORDER BY source'):
        rows.append({'source': source, 'label': SOURCE_LABELS.get(source, source.replace('_', ' ').title()),
                     'ok': bool(ok), 'at': iso(parse_time(at)), 'lastOkAt': iso(parse_time(last_ok)),
                     'detail': detail})
    return rows


def ad_platforms(lead_sources):
    names = ((lead_sources or {}).get('ads') or {}).get('platforms') or []
    out = []
    for n in names:
        words = re.findall(r'[A-Za-z]+', n)
        keys = [w.lower() for w in words if w.lower() not in ('ads', 'ad')]
        out.append({'name': n, 'key': keys[0] if keys else squash(n), 'terms': keys})
    return out


def platform_in_text(text, platforms):
    t = ' ' + norm(text) + ' '
    hits = [p for p in platforms if any(' %s ' % term in t for term in p['terms'])]
    return hits


def sheet_titles(brain):
    return [r[0] for r in brain.q('SELECT DISTINCT spreadsheet_title FROM sheets_data')]


def header_index(rows, first):
    for i, (_n, r) in enumerate(rows):
        if r and (norm(cell(r, 0)) == first or (first != 'date' and norm(cell(r, 0)).startswith(first))):
            return i, {norm(h): j for j, h in enumerate(r) if str(h).strip()}
    return None, {}


def col(heads, *names):
    for n in names:
        for h, j in heads.items():
            if h == n or h.startswith(n):
                return j
    return None


def total_row(rows, start):
    for _n, r in rows[start:]:
        if r and norm(cell(r, 0)) in ('grand total', 'total'):
            return r
    return None


def platform_report(brain, platform, titles, as_of):
    """Spend, spend days and the platform's own conversion counts, from its report Sheets."""
    mine = [t for t in titles if norm(t).split(' ')[0] == platform['key']]
    if not mine:
        return None
    out = {'name': platform['name'], 'key': platform['key'], 'sheets': mine, 'spend': None, 'clicks': None,
           'impressions': None, 'conversions': None, 'allConversions': None, 'spendDays': None, 'window': None,
           'dataThrough': None, 'events': [], 'conversionType': None, 'conversionNote': None, 'landingPages': []}
    for title in mine:
        tabs = [r[0] for r in brain.q('SELECT DISTINCT tab FROM sheets_data WHERE spreadsheet_title=?', (title,))]
        for tab in tabs:
            rows = brain.sheet(title, tab)
            flat = ' '.join(' '.join(str(c) for c in r) for _n, r in rows[:3])
            m = re.search(r'Window:\s*(\d{4}-\d\d-\d\d) to (\d{4}-\d\d-\d\d)', flat)
            if m and not out['window']:
                out['window'] = {'start': m.group(1), 'end': m.group(2), 'basis': 'report window'}
            lt = tab.lower()
            if lt in ('summary - day of week', 'day of week') and out['spend'] is None:
                i, heads = header_index(rows, 'day of week')
                tot = total_row(rows, (i or 0) + 1) if i is not None else None
                if tot:
                    out['spend'] = num(cell(tot, col(heads, 'spend')))
                    out['clicks'] = num(cell(tot, col(heads, 'clicks')))
                    out['impressions'] = num(cell(tot, col(heads, 'impressions')))
                    out['conversions'] = num(cell(tot, heads.get('conversions')))
                    if 'all conversions' in heads:
                        out['allConversions'] = num(cell(tot, heads['all conversions']))
                    if 'days' in heads:
                        out['spendDays'] = num(cell(tot, heads['days']))
            elif lt == 'report':
                i, heads = header_index(rows, 'date')
                sc = col(heads, 'spend')
                days = {}
                for _n, r in rows[(i or 0) + 1:]:
                    d = cell(r, 0)
                    if re.fullmatch(r'\d{4}-\d\d-\d\d', d):
                        days[d] = days.get(d, 0) + (num(cell(r, sc)) or 0)
                spent = sorted(d for d, v in days.items() if v > 0)
                if spent:
                    out['spendDays'] = len(spent)
                    out['window'] = {'start': spent[0], 'end': spent[-1], 'basis': 'first and last day with spend'}
                if days:
                    out['dataThrough'] = max(days)
            elif lt == 'settings':
                in_events = False
                for _n, r in rows:
                    k = norm(cell(r, 0))
                    if k == 'conversion type':
                        out['conversionType'] = cell(r, 1) or None
                        out['conversionNote'] = cell(r, 2) or None
                    elif k.startswith('conversion events configured'):
                        in_events = True
                    elif in_events and k and k != 'name' and not any(e['name'] == cell(r, 0) for e in out['events']):
                        out['events'].append({'name': cell(r, 0), 'type': cell(r, 1) or None, 'count': None})
            elif lt == 'conversions breakdown' and not any(e['count'] is not None for e in out['events']):
                for _n, r in rows[1:]:
                    if cell(r, 0) and num(cell(r, 1)) is not None:
                        out['events'].append({'name': cell(r, 0), 'type': None, 'count': num(cell(r, 1))})
            elif lt == 'by landing page':
                i, heads = header_index(rows, 'landing page')
                cc = col(heads, 'conversions')
                for _n, r in rows[(i or 0) + 1:]:
                    if cell(r, 0).startswith('http') and num(cell(r, cc)):
                        out['landingPages'].append({'url': cell(r, 0), 'conversions': num(cell(r, cc))})
    if out['dataThrough'] is None and out['window']:
        out['dataThrough'] = out['window']['end']
    out['landingPages'].sort(key=lambda x: -x['conversions'])
    return out


HOW_COUNTED = {
    'google': 'Google Ads "Conversions" are the primary conversion actions set up in Google Ads; "All conversions" adds secondary actions. Google counts them from ad clicks and views, not from HubSpot contacts.',
    'reddit': 'Reddit counts pixel events it attributes to an ad view or click (page visits, scrolls, form events). The events are listed with their counts.',
    'openai': 'OpenAI Ads reports one account-wide "All Conversions" total across the configured events; it does not report per-event counts.',
    'linkedin': 'No LinkedIn Ads report is in the data.',
}


def ads_section(brain, lead_sources, as_of):
    titles = sheet_titles(brain)
    out = []
    for p in ad_platforms(lead_sources):
        r = platform_report(brain, p, titles, as_of)
        if r is None:
            out.append({'name': p['name'], 'key': p['key'], 'connected': False, 'how': HOW_COUNTED.get(p['key'],
                        'No report for this platform is in the data.')})
            continue
        r['connected'] = True
        r['how'] = HOW_COUNTED.get(p['key'], 'Counted by the platform, not from HubSpot contacts.')
        if r.get('conversionNote'):
            r['how'] += ' The report notes: "%s".' % r['conversionNote']
        through = parse_time(r['dataThrough']) if r.get('dataThrough') else None
        r['stale'] = bool(through and (as_of - through).days > 3)
        out.append(r)
    return out


def budget(brain, as_of):
    title = next((t for t in sheet_titles(brain) if 'marketing budget' in t.lower()), None)
    rows = brain.sheet(title, 'Actuals') if title else []
    if not rows:
        return None
    planned = next((r for _n, r in rows if cell(r, 1).lower() == 'planned'), [])
    actual = next((r for _n, r in rows if cell(r, 1).lower() == 'actual'), [])
    year = as_of.astimezone(TZ).year
    for _n, r in rows:
        m = re.fullmatch(r'\d{1,2}/\d{1,2}/(\d{4})', cell(r, 3))
        if m:
            year = int(m.group(1))
            break
    months = [{'month': '%d-%02d' % (year, i + 1), 'planned': num(cell(planned, 3 + i)), 'actual': num(cell(actual, 3 + i))}
              for i in range(12)]
    this = as_of.astimezone(TZ).strftime('%Y-%m')
    missing = [m['month'] for m in months if m['actual'] is None and m['planned'] and m['month'] <= this]
    return {'sheet': title, 'months': months, 'missingMonths': missing}


def ga4_unassigned(brain):
    row = brain.q("SELECT result_json, fetched_at FROM ga4_reports WHERE report_key='channels_90d'")
    if not row:
        return None
    try:
        payload = json.loads(row[0][0] or '{}')
    except ValueError:
        return None
    total = unassigned = 0
    for r in payload.get('rows') or []:
        name = ((r.get('dimensionValues') or [{}])[0] or {}).get('value')
        s = num(((r.get('metricValues') or [{}])[0] or {}).get('value')) or 0
        total += s
        if str(name).lower() in ('unassigned', '(not set)'):
            unassigned += s
    return {'sessions': total, 'unassigned': unassigned, 'share': (unassigned / total) if total else None,
            'fetchedAt': iso(parse_time(row[0][1]))}


def staleness(fresh, ads, spend, ga4, brain, contact_props, as_of):
    flags = []
    for f in fresh:
        if not f['ok']:
            flags.append({'key': f['source'], 'label': '%s down' % f['label'],
                          'text': '%s last good %s; showing that data.' % (f['label'], fmt_pt(parse_time(f['lastOkAt']))),
                          'level': 'alert'})
    for a in ads:
        if a.get('connected') and a.get('stale'):
            flags.append({'key': 'ads-' + a['key'], 'label': '%s data ends %s' % (a['name'], fmt_pt(parse_time(a['dataThrough']), False)),
                          'text': 'The %s report has no rows after %s.' % (a['name'], a['dataThrough']), 'level': 'warn'})
    if spend and spend['missingMonths']:
        ms = [datetime.strptime(m, '%Y-%m').strftime('%b') for m in spend['missingMonths']]
        rng = ms[0] if len(ms) == 1 else '%s–%s' % (ms[0], ms[-1])
        flags.append({'key': 'spend', 'label': 'Spend actuals missing %s' % rng,
                      'text': 'The marketing budget Sheet (Actuals) has a plan but no actual for %s.' % ', '.join(ms), 'level': 'warn'})
    if ga4 and ga4['share'] is not None and ga4['share'] >= 0.2:
        flags.append({'key': 'ga4', 'label': 'GA4 channels: %d%% Unassigned' % round(ga4['share'] * 100),
                      'text': '%d of %d GA4 sessions (90 days) have no channel ("Unassigned"): channel splits are low quality.'
                              % (ga4['unassigned'], ga4['sessions']), 'level': 'warn'})
    missing = [label for t, label in NEW_SOURCES if not brain.has(t)]
    if not contact_props:
        missing.append('HubSpot contact source fields')
    if missing:
        flags.append({'key': 'not-synced', 'label': 'Not yet synced: %d sources' % len(missing),
                      'text': 'Not yet synced: %s. Lead sub-sources that need them show "not yet synced".' % ', '.join(missing),
                      'level': 'info', 'items': missing})
    return flags


# ---------- leads ----------
def tracker_location(lead_sources):
    tab = ((lead_sources or {}).get('sheet') or {}).get('tab') or ''
    m = re.match(r'^(.*?)\s*\((.+)\)\s*$', tab)
    return (m.group(1).strip(), m.group(2).strip()) if m else (tab or 'Lead Tracker', None)


def tracker_rows(brain, lead_sources):
    tab, title = tracker_location(lead_sources)
    if title is None:
        found = brain.q('SELECT DISTINCT spreadsheet_title FROM sheets_data WHERE tab=?', (tab,))
        title = found[0][0] if found else None
    rows = brain.sheet(title, tab) if title else []
    i, heads = header_index(rows, 'company')
    if i is None or 'source' not in heads:
        return None, title, tab
    c = {k: col(heads, *names) for k, names in {
        'company': ['company'], 'source': ['source'], 'owner': ['owner'], 'lead': ['lead date'], 'mql': ['mql date'],
        'sql': ['sql date'], 'notes': ['deal notes', 'deal'], 'first': ['first touch'], 'hsid': ['hubspot company id'],
        'domain': ['company domain'], }.items()}
    out = []
    for n, r in rows[i + 1:]:
        if not cell(r, c['company']):
            continue
        out.append({'row': n, **{k: cell(r, j) for k, j in c.items()}})
    return out, title, tab


RULES = json.load(open(os.path.join(ROOT, 'config', 'lead-rules.json'), encoding='utf-8'))
REPORTING = RULES['reporting']


def campaign_tags(bucket, name):
    """Tags for a Lemlist campaign from config/lead-rules.json (bucket text and name rules)."""
    b, tags, flags = str(bucket or ''), [], []
    for t in RULES['lemlist']['tags']:
        if ('bucketContains' in t and t['bucketContains'] in b) or ('bucketStartsWith' in t and b.startswith(t['bucketStartsWith'])):
            tags.append(t['tag'])
    for f in RULES['lemlist']['flags']:
        if f['nameContains'].lower() in str(name or '').lower():
            flags.append(f['flag'])
    if not tags:
        tags = ['unmapped']
    return tags, flags


class LeadSources:
    """lead-sources.json, indexed, with config/lead-rules.json on top. Labelled provisional (see provisional_label)."""

    def __init__(self, doc):
        self.doc = doc or {}
        self.platforms = ad_platforms(doc)
        self.forms = {str(f.get('id')): f for f in self.doc.get('forms') or []}
        self.forms_by_name = {norm(f.get('name')): f for f in self.doc.get('forms') or []}
        excl = {k for k in SCOPE['eventListExclusions'] if k != 'about'}
        self.lists = {}
        for l in self.doc.get('list_uploads') or []:
            lid = str(l.get('id'))
            counts = bool(l.get('counts_as_lead_source')) and l.get('kind') == 'event' and lid not in excl
            self.lists[lid] = {**l, 'counts': counts, 'excludedBecause': SCOPE['eventListExclusions'].get(lid)}
        self.lists_by_name = {norm(l.get('name')): l for l in self.lists.values()}
        self.campaigns = {}
        for c in ((self.doc.get('lemlist') or {}).get('campaigns') or []):
            tags, flags = campaign_tags(c.get('bucket'), c.get('name'))
            self.campaigns[str(c.get('id'))] = {**c, 'tags': tags, 'flags': flags}
        self.campaigns_by_name = {norm(c.get('name')): c for c in self.campaigns.values()}
        # Forms by name, longest first, for conversion event names ('<page title>: <form name>').
        self.event_forms = sorted(((str(f.get('name') or '').strip().casefold(), f) for f in self.doc.get('forms') or []
                                   if str(f.get('name') or '').strip()), key=lambda x: -len(x[0]))
        ads = self.doc.get('ads') or {}
        pre = RULES['ads']['checksKeyPrefix']
        self.checks = {}
        for k, v in ads.items():
            if k.startswith(pre) and isinstance(v, dict):
                self.checks.update({str(n).lower(): str(t) for n, t in v.items() if isinstance(t, str)})

    @property
    def counted_event_lists(self):
        return sorted((l for l in self.lists.values() if l['counts']), key=lambda l: int(l['id']) if str(l['id']).isdigit() else 0)

    def campaign(self, cid, name=None):
        return self.campaigns.get(str(cid)) or self.campaigns_by_name.get(norm(name))

    def form_is_lead(self, form):
        return not form or form.get('bucket') not in RULES['forms']['notLeadBuckets']

    def form_for_event(self, event):
        """The lead-sources.json form a conversion event names: the event is '<page title>: <form name>' (or the bare
        name). Longest form name first, so a form whose name ends another form's name is not taken for it."""
        e = str(event or '').strip().casefold()
        if not e:
            return None
        sep = REPORTING['forms']['eventNameSeparator'].casefold()
        return next((f for n, f in self.event_forms if e == n or e.endswith(sep + n)), None)

    def form_source(self, form):
        m = re.search(r'Sheet source:\s*([A-Za-z]+)', str(form.get('detail') or ''))
        return m.group(1) if m else SCOPE['formBucketSource'].get(form.get('bucket'))

    def check_for(self, company):
        """A Pipeline paid check (lead-sources.json ads.checks_*) whose key starts the company name and that says
        'Paid <platform>' or 'Verdict: paid <platform> [branded]'."""
        n = norm(company)
        for key, text in self.checks.items():
            m = re.match(r'\s*paid\s+(\w+)', text, re.I) or re.search(r'verdict:\s*paid\s+(\w+)(\s+branded)?', text, re.I)
            if m and (n == key or n.startswith(key + ' ')):
                names = platform_in_text(m.group(1), self.platforms)
                branded = bool(m.re.groups > 1 and m.group(2))
                return {'platform': names[0]['name'] if names else None, 'text': text, 'branded': branded}
        return None

    def paid_lead_for(self, company):
        """ads.paid_leads: Pipeline's lead-level paid attribution (platform, conversion date, spend-window flag)."""
        n = norm(company)
        for x in (self.doc.get('ads') or {}).get('paid_leads') or []:
            k = norm(x.get('company'))
            if k and (n == k or n.startswith(k + ' ') or k.startswith(n + ' ')):
                names = platform_in_text(str(x.get('platform') or ''), self.platforms)
                return {**x, 'platformName': names[0]['name'] if names else x.get('platform')}
        return None

    def platform_check(self, key):
        return self.checks.get(key)


def match_tracker_company(lead, comps, by_domain, by_name):
    ids = [x for x in lead['hsids'] if x in comps]
    if ids:
        return ids, 'HubSpot Company ID column'
    for d in lead['domains']:
        ids = by_domain.get(domain_of(d), [])
        if ids:
            return ids, 'Company Domain column = HubSpot company domain'
    ids = by_name.get(norm(lead['company']), [])
    if len(ids) == 1:
        return ids, 'company name = HubSpot company name'
    return [], None


def lemlist_leads(brain):
    if not brain.has('lemlist_leads'):
        return None
    cols = brain.cols('lemlist_leads')
    want = [c for c in ['campaign_id', 'email', 'replied_at', 'contacted_at', 'meeting_booked_at', 'raw_json'] if c in cols]
    out = {}
    for row in brain.q('SELECT %s FROM lemlist_leads' % ', '.join(want)):
        r = dict(zip(want, row))
        email = (r.get('email') or '').strip().lower()
        if email:
            out.setdefault(email, []).append(r)
    return out


AUTO_REPLY = re.compile(r'out of (the )?office|auto(matic)?[- ]?(reply|response)|away from (my|the) (desk|office)|on (annual |parental )?leave|ooo\b', re.I)


def is_auto_reply(raw_json):
    try:
        raw = json.loads(raw_json or '{}')
    except ValueError:
        return False
    if not isinstance(raw, dict):
        return False
    for k, v in raw.items():
        kl = k.lower()
        if ('auto' in kl or 'outofoffice' in kl) and v is True:
            return True
    for k in ('replyText', 'lastReplyText', 'reply', 'lastReply', 'replySnippet'):
        if isinstance(raw.get(k), str) and AUTO_REPLY.search(raw[k]):
            return True
    return False


def form_submissions(brain):
    if not brain.has('hubspot_form_submissions'):
        return None
    out = {}
    for fid, at, email, url, title, values in brain.q(
            'SELECT form_id, submitted_at, contact_email, page_url, page_title, values_json FROM hubspot_form_submissions'):
        email = (email or '').strip().lower()
        if email:
            try:
                vals = json.loads(values or '{}')
            except ValueError:
                vals = {}
            if isinstance(vals, list):
                vals = {str(v.get('name')): v.get('value') for v in vals if isinstance(v, dict)}
            out.setdefault(email, []).append({'formId': str(fid), 'at': at, 'url': url, 'title': title, 'values': vals or {}})
    for xs in out.values():
        xs.sort(key=lambda s: str(parse_time(s['at']) or ''))
    return out


def list_memberships(brain):
    if not brain.has('hubspot_list_memberships'):
        return None
    out = {}
    for lid, rid, added in brain.q('SELECT list_id, record_id, added_at FROM hubspot_list_memberships'):
        out.setdefault(str(rid), []).append({'listId': str(lid), 'added': added})
    return out


def list_names(brain):
    return {str(i): n for i, n in brain.q('SELECT list_id, name FROM hubspot_lists')} if brain.has('hubspot_lists') else {}


def paid_from_values(vals, platforms):
    """Form/UTM evidence: utm_source / utm_medium / gclid -> (platform name or None, text) or None."""
    low = {str(k).lower(): str(v or '') for k, v in (vals or {}).items()}
    utm = {k: v for k, v in low.items() if 'utm' in k and v}
    gclid = next((v for k, v in low.items() if 'gclid' in k and v), None)
    paid_vals = set(SCOPE['paidUtmValues'])
    hit = any(norm(v) in paid_vals or any(w in paid_vals for w in norm(v).split()) for v in utm.values())
    if not hit and not gclid:
        return None
    text = ' '.join(utm.values())
    names = platform_in_text(text, platforms)
    if not names and gclid:
        names = [p for p in platforms if p['key'] == 'google']
    detail = ', '.join('%s=%s' % kv for kv in sorted(utm.items())) or 'gclid present'
    return (names[0]['name'] if len(names) == 1 else None), detail, bool(re.search(r'brand', text, re.I))


def attribute(lead, lead_contacts, ctx):
    """System evidence (Lemlist, HubSpot) for one lead. Each row: rule, source, detail, and whether it decides the source."""
    ls, platforms = ctx['ls'], ctx['ls'].platforms
    ev = []
    for c in lead_contacts:
        email = c['email']
        if ctx['lemlist'] is not None and email in ctx['lemlist']:
            for r in ctx['lemlist'][email]:
                camp = ls.campaign(r.get('campaign_id'))
                tags = (camp or {}).get('tags') or ['unmapped']
                if not set(tags) & set(RULES['lemlist']['outboundTags']):
                    continue
                name = (camp or {}).get('name') or ctx['campaign_names'].get(str(r.get('campaign_id'))) or r.get('campaign_id')
                job = 'job_changer' in tags
                ev.append({'rule': 'Lemlist lead email', 'source': 'Outbound', 'detail': name, 'contactId': c['id'],
                           'subSource': 'Job changer' if job else name, 'tag': 'job_changer' if job else None,
                           'replied': bool(r.get('replied_at')) and not is_auto_reply(r.get('raw_json')),
                           'at': r.get('replied_at') or r.get('contacted_at')})
        if ctx['submissions'] is not None and email in ctx['submissions']:
            for sub in ctx['submissions'][email]:
                form = ls.forms.get(sub['formId']) or ls.forms_by_name.get(norm(ctx['form_names'].get(sub['formId'])))
                fname = (form or {}).get('name') or ctx['form_names'].get(sub['formId']) or sub['formId']
                if not ls.form_is_lead(form):
                    continue
                note = ' (was "uncertain" in the mapping)' if form and form.get('uncertain') else ''
                paid = paid_from_values(sub['values'], platforms)
                if (form and form.get('bucket') == 'ads_conversion') or is_paid_form(fname) or paid:
                    ev.append({'rule': 'HubSpot form / UTM', 'source': 'Paid', 'detail': fname + note + ('' if not paid else ' · ' + paid[1]),
                               'platform': (paid[0] if paid else None) or platform_of_form(fname, platforms),
                               'branded': bool(paid and paid[2]), 'contactId': c['id'], 'at': sub['at']})
                    continue
                ev.append({'rule': 'HubSpot form submission', 'source': (ls.form_source(form) if form else None) or 'Inbound',
                           'detail': fname + note, 'subSource': fname, 'contactId': c['id'], 'at': sub['at']})
        if ctx['memberships'] is not None:
            for m in ctx['memberships'].get(c['id'], []):
                l = ls.lists.get(m['listId'])
                if l and l['counts']:
                    ev.append({'rule': 'Event list upload', 'source': 'Events', 'detail': l.get('show') or l.get('name'),
                               'subSource': l.get('show') or l.get('name'), 'contactId': c['id'], 'at': m['added']})
        cp = contact_paid(c, platforms)
        if cp:
            ev.append({**cp, 'source': 'Paid', 'contactId': c['id']})
        p = c['props']
        if str(p.get('hs_object_source') or '').upper() == 'IMPORT':
            iname = p.get('hs_object_source_detail_1') or ''
            l = ls.lists_by_name.get(norm(iname))
            if l and l.get('counts'):
                ev.append({'rule': 'HubSpot import', 'source': 'Events', 'detail': iname,
                           'subSource': l.get('show') or iname, 'contactId': c['id']})
            elif l:
                ev.append({'rule': 'HubSpot import', 'source': None, 'detail': '%s (%s, not a lead source)' % (iname, l.get('kind')),
                           'contactId': c['id']})
    return ev


def is_paid_form(name):
    return any(norm(f) in norm(name) for f in RULES['ads']['paidForms'])


def platform_of_form(name, platforms):
    names = platform_in_text(name, platforms)
    return names[0]['name'] if len(names) == 1 else None


def contact_paid(c, platforms):
    """Paid evidence on one contact's synced fields, best first: UTMs with a paid signal / click id,
    paid_touch_campaign, then original source. None when the contact has none."""
    p = {str(k).lower(): str(v) for k, v in c['props'].items() if v not in (None, '')}
    mediums = set(RULES['ads']['paidMediums'])
    utm = {k: v for k, v in p.items() if 'utm' in k}
    click = [k for k in RULES['ads']['clickIdKeys'] if p.get(k)]
    if any(norm(v).replace(' ', '_') in mediums or norm(v) in mediums for k, v in utm.items() if 'medium' in k) or click:
        text = ' '.join(utm.values())
        names = platform_in_text(text, platforms) or ([x for x in platforms if x['key'] == 'google'] if any('gclid' in k or 'google' in k for k in click) else [])
        detail = ', '.join('%s=%s' % kv for kv in sorted(utm.items())) or ', '.join(click)
        return {'rule': 'HubSpot UTM / click id', 'platform': names[0]['name'] if len(names) == 1 else None, 'detail': detail,
                'branded': bool(re.search(r'brand', ' '.join(utm.values()), re.I))}
    if p.get('paid_touch_campaign'):
        names = platform_in_text(p['paid_touch_campaign'], platforms)
        return {'rule': 'paid_touch_campaign', 'platform': names[0]['name'] if len(names) == 1 else None,
                'detail': p['paid_touch_campaign'], 'branded': 'brand' in p['paid_touch_campaign'].lower()}
    src = p.get('hs_analytics_source', '').upper()
    if src in SCOPE['paidAnalyticsSources']:
        text = ' '.join(p.get(k, '') for k in ('hs_analytics_source_data_1', 'hs_analytics_source_data_2'))
        names = platform_in_text(text, platforms)
        return {'rule': 'HubSpot original source', 'platform': names[0]['name'] if len(names) == 1 else None,
                'detail': ('%s %s' % (src, text)).strip(), 'branded': False}
    return None


# Rule order; "decides" rules are system evidence (HubSpot primary). The paid-deal export is deal-level
# (company fallback included), so it names the platform but does not move a lead's source.
RULE_ORDER = ['Source override', 'MQL touch (review list)', 'Lemlist lead email', 'HubSpot form / UTM', 'HubSpot form submission', 'Event list upload',
              'HubSpot UTM / click id', 'paid_touch_campaign', 'HubSpot original source', 'HubSpot import',
              'HubSpot source (review list)', 'HubSpot check (Pipeline)', 'Paid lead (Pipeline)', 'Paid deal (Pipeline export)',
              'Lead Tracker note']
NOT_DECIDING = {'Paid deal (Pipeline export)', 'Lead Tracker note'}


def conversion_event_terms(ads):
    """Per platform, the configured conversion event names (squashed, >= 10 letters), for 'possible platform'."""
    out = {}
    for a in ads:
        for e in a.get('events') or []:
            name = re.split(r'\s+-\s+', e['name'])[0]
            if e.get('count') == 0 or name.lower().startswith('exclusion'):
                continue
            t = squash(name)
            if len(t) >= 10:
                out.setdefault(a['name'], set()).add(t)
    return out


def build_leads(brain, ctx):
    rows, title, tab = tracker_rows(brain, ctx['ls'].doc)
    if rows is None:
        return {'connected': False, 'reason': 'The Lead Tracker tab is not in brain.db.', 'items': []}
    comps, deals_by_company = ctx['comps'], ctx['comps']
    by_domain, by_name = {}, {}
    for c in comps.values():
        if c['domain']:
            by_domain.setdefault(c['domain'], []).append(c['id'])
        if c['name']:
            by_name.setdefault(norm(c['name']), []).append(c['id'])
    groups = {}
    for r in rows:
        groups.setdefault(r['company'].strip().lower(), []).append(r)
    platforms = ctx['ls'].platforms
    event_terms = conversion_event_terms(ctx['ads'])
    contacts_by_company = {}
    for c in ctx['contacts'].values():
        for co in c['companies']:
            contacts_by_company.setdefault(co, []).append(c)
    meetings_by_company = ctx['meetings_by_company']
    items = []
    for _key, rs in groups.items():
        def first_date(r):
            return parse_time(r['lead']) or parse_time(r['first'])
        rs.sort(key=lambda r: (first_date(r) is None, first_date(r) or datetime.max.replace(tzinfo=timezone.utc), r['row']))
        lead_dt = next((first_date(r) for r in rs if first_date(r)), None)
        mql = min((parse_time(r['mql']) for r in rs if parse_time(r['mql'])), default=None)
        sql = min((parse_time(r['sql']) for r in rs if parse_time(r['sql'])), default=None)
        sources = []
        for r in rs:
            if r['source'] and r['source'] not in sources:
                sources.append(r['source'])
        top = min(rs, key=lambda r: r['row'])
        lead = {'id': 'L%d' % top['row'], 'company': top['company'], 'source': sources[0] if sources else 'No source',
                'owner': ctx['scrub'].person(next((r['owner'] for r in rs if r['owner']), '')),
                'leadDate': ymd(lead_dt), 'mqlDate': ymd(mql), 'sqlDate': ymd(sql), 'mql': bool(mql or sql), 'sql': bool(sql),
                'rows': sorted(r['row'] for r in rs), 'notes': [r['notes'] for r in sorted(rs, key=lambda r: r['row']) if r['notes']],
                'hsids': sorted({r['hsid'] for r in rs if r['hsid']}), 'domains': sorted({r['domain'] for r in rs if r['domain']}),
                'flags': []}
        if len(sources) > 1:
            lead['flags'].append({'kind': 'sheet', 'text': 'Lead Tracker rows disagree on Source: %s (earliest row used as the fallback)' % ' vs '.join(sources)})
        ids, rule = match_tracker_company(lead, comps, by_domain, by_name)
        lead['hubspot'] = {'companyIds': ids, 'matchRule': rule}
        cos = [comps[i] for i in ids]
        lead['lifecycle'] = next((c['lifecycle'] for c in cos if c['lifecycle']), None)
        lead['companyOwner'] = next((c['owner'] for c in cos), None)
        sdeals = [d for c in cos for d in c['deals'] if d['pipeline'] == SCOPE['salesPipelineId']]
        seen = set()
        sdeals = [d for d in sdeals if not (d['id'] in seen or seen.add(d['id']))]
        sdeals.sort(key=lambda d: (not d['open'], -(d['amount'] or 0)))
        lead['deals'] = [deal_ref(d) for d in sdeals]
        lead['openAmount'] = money0(sum(d['amount'] or 0 for d in sdeals if d['open'] and not d['onHold'])) if sdeals else None
        lcontacts = []
        for i in ids:
            lcontacts += contacts_by_company.get(i, [])
        lead['contactCount'] = len(lcontacts)
        lcontacts.sort(key=lambda c: str(c['created'] or ''))
        lead['contacts'] = [{'id': c['id'], 'name': c['name'], 'title': c['title'], 'lifecycle': c['lifecycle'],
                             'owner': c['owner'], 'created': c['created']} for c in lcontacts[:6]]
        ms = []
        for i in ids:
            ms += meetings_by_company.get(i, [])
        ms = sorted({m['id']: m for m in ms}.values(), key=lambda m: m['start'] or '', reverse=True)
        lead['meetings'] = [{'id': m['id'], 'title': m['title'], 'start': m['start'], 'owner': m['owner'], 'inList': m['inWindow']} for m in ms[:8]]
        # Evidence: system rules (Lemlist, HubSpot, Pipeline's HubSpot reads), then Sheet-side.
        ev = attribute(lead, lcontacts, ctx)
        rv = ctx['review'].get(lead['rows'][0]) or next((ctx['review'][r] for r in lead['rows'] if r in ctx['review']), None)
        status = str((rv or {}).get('status') or '').strip().lower()
        mql_ch = str((rv or {}).get('mql_channel') or '').strip()
        if rv and status == 'resolved' and mql_ch and mql_ch.lower() != 'undetermined':
            # Attribution rule: the channel of the touch at the MQL booking (Pipeline's review list).
            named = platform_in_text(' '.join([rv.get('attribution_evidence') or '', rv.get('evidence') or '']), platforms)
            ev.append({'rule': 'MQL touch (review list)', 'source': mql_ch, 'detail': rv.get('attribution_evidence') or rv.get('evidence') or '',
                       'platform': named[0]['name'] if mql_ch == 'Paid' and len(named) == 1 else None, 'subSource': None})
        if rv and (rv.get('different_first_touch') or '').strip():
            lead['firstTouch'] = rv['different_first_touch'].strip()
        if rv and status == 'undetermined':
            lead['mqlChannel'] = 'undetermined'
        if rv and rv.get('hubspot_sources'):
            hs = [x.strip() for x in re.split(r'[|/,;]', rv['hubspot_sources']) if x.strip()]
            named = platform_in_text(rv.get('evidence') or '', platforms)
            ev.append({'rule': 'HubSpot source (review list)', 'source': hs[0], 'detail': rv.get('evidence') or rv['hubspot_sources'],
                       'platform': named[0]['name'] if hs[0] == 'Paid' and len(named) == 1 else None, 'subSource': None})
        chk = ctx['ls'].check_for(lead['company'])
        if chk:
            ev.append({'rule': 'HubSpot check (Pipeline)', 'source': 'Paid', 'platform': chk['platform'], 'branded': chk['branded'], 'detail': chk['text']})
        pl = ctx['ls'].paid_lead_for(lead['company'])
        if pl:
            ev.append({'rule': 'Paid lead (Pipeline)', 'source': 'Paid', 'platform': pl['platformName'], 'at': pl.get('conversion_date'),
                       'predatesSpendWindow': pl.get('predates_spend_window'),
                       'detail': '; '.join(x for x in [('conversion %s' % pl['conversion_date']) if pl.get('conversion_date') else '',
                                                        'counts in ROI' if pl.get('counts_in_roi') else '', pl.get('note') or ''] if x)})
        for d in sdeals:
            pd = ctx['paid_deals'].get(d['id'])
            if pd:
                ev.append({'rule': 'Paid deal (Pipeline export)', 'source': 'Paid', 'platform': pd['platform'], 'at': pd.get('conversionDate'),
                           'predatesSpendWindow': pd.get('predatesSpendWindow'), 'branded': pd['branded'],
                           'detail': '%s: %s (%s%s)' % (d['name'], pd['platform'], pd['via'] or 'evidence', ', company-level' if pd['level'] == 'company' else '')})
        note = ' '.join(lead['notes'])
        named = platform_in_text(note, platforms)
        if named and re.search(r'\b(ad|ads|paid|ppc|cpc)\b', note, re.I):
            ev.append({'rule': 'Lead Tracker note', 'source': 'Paid', 'platform': named[0]['name'] if len(named) == 1 else None,
                       'detail': 'note names %s' % ' / '.join(p['name'] for p in named)})
        ov = ctx.get('overrides', {}).get('leads', {}).get(lead['id'])
        if ov:
            # A human ruling (source-overrides.json) decides over every other rule, a hold included. Paid evidence
            # that disagrees is kept, marked superseded, and counts nowhere.
            ev.append({'rule': 'Source override', 'source': ov['source'], 'detail': OVERRIDE_LABEL, 'platform': None, 'subSource': None})
            if ov['source'] != 'Paid':
                for e in ev:
                    if e['rule'] != 'Source override' and (e.get('source') == 'Paid' or e.get('platform')):
                        e['superseded'] = OVERRIDE_LABEL
        ev.sort(key=lambda e: RULE_ORDER.index(e['rule']))
        pipeline_platform = next((e['platform'] for e in ev if e['rule'] in ('HubSpot check (Pipeline)', 'Paid lead (Pipeline)') and e.get('platform')), None)
        hold = bool(rv and str(rv.get('status') or '').startswith('on_hold')) and not ov
        for e in ev:
            e['decides'] = e['rule'] not in NOT_DECIDING and bool(e.get('source')) and not hold
            if ov:
                e['decides'] = e['rule'] == 'Source override'
            if e.get('superseded'):
                continue
            if e['rule'] == 'Lead Tracker note' and pipeline_platform and e.get('platform') and e['platform'] != pipeline_platform:
                e['superseded'] = 'Pipeline\'s HubSpot check says %s' % pipeline_platform
        if hold:
            lead['hold'] = hold_label(rv)
        lead['evidence'] = ev
        # HubSpot is primary: the first deciding rule sets the source; the Sheet is the fallback.
        hub = next((e for e in ev if e['decides']), None)
        lead['sheetSource'] = lead['source']
        if ov:
            lead['source'], lead['sourceBasis'], lead['rule'] = ov['source'], 'override', OVERRIDE_LABEL
        elif hub:
            lead['source'], lead['sourceBasis'], lead['rule'] = hub['source'], 'hubspot', hub['rule']
        else:
            lead['sourceBasis'], lead['rule'] = 'sheet', RULES['source']['sheetLabel']
        if lead.get('firstTouch'):
            lead['flags'].append({'kind': 'note', 'text': 'Different first touch: %s' % lead['firstTouch']})
        if lead.get('mqlChannel') == 'undetermined':
            lead['flags'].append({'kind': 'note', 'text': 'MQL channel undetermined (no MQL booking yet): the HubSpot-primary source is kept'})
        if ov:
            lead['review'] = False
            if ov['source'] != lead['sheetSource']:
                lead['flags'].append({'kind': 'note', 'text': '%s: %s; the Lead Tracker says %s (the Sheet is not changed)'
                                      % (OVERRIDE_LABEL, ov['source'], lead['sheetSource'])})
        elif lead.get('hold'):
            lead['review'] = True
            lead['flags'].append({'kind': 'hold', 'text': '%s: %s' % (lead['hold'], rv.get('action') or 'held for review')})
        elif hub and hub['source'] != lead['sheetSource']:
            lead['review'] = True
            lead['flags'].append({'kind': 'review', 'text': '%s says %s; the Lead Tracker says %s. HubSpot is used; on the review list.'
                                  % (hub['rule'], hub['source'], lead['sheetSource'])})
        else:
            lead['review'] = bool(rv)
        sub, platform, tag = None, None, None
        if lead['source'] == 'Paid':
            pe = next((e for e in ev if e.get('source') == 'Paid' and e.get('platform') and not e.get('superseded')), None)
            dated = [e for e in ev if e['rule'] in ('Paid lead (Pipeline)', 'Paid deal (Pipeline export)') and e.get('at')]
            conv = (dated[0]['at'] if dated else None) or (pe.get('at') if pe else None)
            if conv:
                lead['conversionDate'] = str(conv)[:10]
            if any(e.get('predatesSpendWindow') for e in ev if e.get('source') == 'Paid'):
                lead['predatesSpendWindow'] = True
            platform = pe['platform'] if pe else None
            sub = platform or 'Platform not named'
            if pe and pe['rule'] != lead['rule'] and lead['sourceBasis'] in ('sheet', 'override'):
                lead['rule'] = '%s (platform: %s)' % (lead['rule'], pe['rule'])
            elif pe and lead['sourceBasis'] == 'hubspot' and pe['rule'] != lead['rule']:
                lead['rule'] = '%s (platform: %s)' % (lead['rule'], pe['rule'])
            if not pe:
                t = squash(note)
                possible = sorted(name for name, terms in event_terms.items() if any(x in t for x in terms))
                if possible:
                    lead['possiblePlatforms'] = possible
            if any(e.get('branded') for e in ev if e.get('source') == 'Paid'):
                tag = RULES['ads']['brandedFlag']
        elif ov:
            pass  # a ruled source carries no sub-source, platform or tag
        else:
            same = next((e for e in ev if e.get('source') == lead['source'] and e.get('subSource')), None)
            if same:
                sub, tag = same['subSource'], same.get('tag')
            elif lead['source'] == 'Outbound':
                sub = 'Campaign: Lemlist leads not yet synced' if ctx['lemlist'] is None else 'No Lemlist match'
            elif lead['source'] == 'Events':
                sub = 'List: memberships not yet synced' if ctx['memberships'] is None else 'No event list match'
            elif lead['source'] == 'Inbound':
                sub = 'Form: submissions not yet synced' if ctx['submissions'] is None else 'No form match'
        lead['subSource'] = sub
        lead['platform'] = platform
        lead['tag'] = tag
        # Other evidence naming a different source than the one used: shown, not resolved.
        for e in ev:
            if e.get('superseded') == OVERRIDE_LABEL:
                continue
            if e.get('source') and e['source'] != lead['source'] and e is not hub and not (e['rule'] == 'Lead Tracker note' and lead['sheetSource'] == lead['source']):
                what = e.get('platform') or e['source']
                lead['flags'].append({'kind': 'conflict', 'text': '%s says %s (%s); source used: %s' % (e['rule'], e['source'], what, lead['source'])})
        lead['conflict'] = any(f['kind'] == 'conflict' for f in lead['flags'])
        found = [ctx['lead_insights'][c['id']] for c in lcontacts if c['id'] in ctx['lead_insights']]
        lead['insight'] = max(found, key=lambda x: str(x.get('lastCall') or '')) if found else None
        del lead['hsids'], lead['domains']
        items.append(lead)
    items.sort(key=lambda l: (l['leadDate'] or '', l['company']), reverse=True)
    total, mql = len(items), sum(1 for l in items if l['mql'])
    order = [s for s in ['Inbound', 'Events', 'Webinar', 'RFP', 'Paid', 'Outbound']]
    seen_sources = []
    for l in items:
        if l['source'] not in seen_sources:
            seen_sources.append(l['source'])
    sources = [s for s in order if s in seen_sources] + sorted(s for s in seen_sources if s not in order)
    openai = next((p for p in platforms if p['key'] == 'openai'), None)
    plat = []
    for p in platforms:
        confirmed = [l for l in items if l['platform'] == p['name']]
        possible = [l for l in items if l['source'] == 'Paid' and not l['platform'] and p['name'] in (l.get('possiblePlatforms') or [])
                    and l not in confirmed]
        note_named = [l for l in items if any(e['rule'] == 'Lead Tracker note' and e.get('platform') == p['name'] and not e.get('superseded') for e in l['evidence'])]
        note_possible = [l for l in items if l['sheetSource'] == 'Paid' and l not in note_named and p['name'] in (l.get('possiblePlatforms') or [])]
        plat.append({'name': p['name'], 'key': p['key'], 'confirmed': len(confirmed),
                     'trackerNamed': len(note_named), 'trackerAtMost': len(note_named) + len(note_possible),
                     'confirmedIds': [l['id'] for l in confirmed], 'inPaid': sum(1 for l in confirmed if l['source'] == 'Paid'),
                     'possible': len(possible), 'possibleIds': [l['id'] for l in possible],
                     'atMost': len(confirmed) + len(possible)})
    return {'connected': True, 'sheet': {'title': title, 'tab': tab}, 'total': total, 'mql': mql,
            'sql': sum(1 for l in items if l['sql']),
            'sources': sources, 'platforms': plat, 'openai': next((x for x in plat if openai and x['key'] == 'openai'), None),
            'conflicts': sum(1 for l in items if l['conflict']), 'reviewLeads': sum(1 for l in items if l['review']),
            'hubspotSourced': sum(1 for l in items if l['sourceBasis'] == 'hubspot'), 'items': items,
            'overridden': sum(1 for l in items if l['sourceBasis'] == 'override'),
            'definition': 'A lead is a company on the Lead Tracker with its first lead date (Lead Date, else First Touch). '
                          'Source: HubSpot evidence first (where the conversion happened); the Lead Tracker Source only when '
                          'HubSpot has none; a human ruling (source override) wins over both. Disagreements go to the review list; '
                          'nothing is overwritten. Sheet MQL/SQL are the '
                          'Lead Tracker\'s dates.'}


def hold_label(rv):
    """'on_hold_pending_<who>' -> 'On hold, pending <Who>' (who comes from the data, not the repo)."""
    words = str(rv.get('status') or 'on_hold').split('_')
    if 'pending' in words:
        i = words.index('pending')
        return 'On hold, pending ' + ' '.join(w.title() for w in words[i + 1:]) if words[i + 1:] else 'On hold, pending'
    return 'On hold'


def load_review_list(path):
    """lead-source-review.csv (data-side): Sheet row -> row dict. None when no file."""
    if not path or not os.path.exists(path):
        return None
    import csv
    with open(path, encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))
    out = {}
    for r in rows:
        try:
            out[int(str(r.get('row') or '').strip())] = r
        except ValueError:
            continue
    return {'path': path, 'rows': rows, 'byRow': out}


def load_paid_export(path, platforms):
    """Pipeline's deals export with derived.paid_platform / paid_evidence / google_branded."""
    with open(path, encoding='utf-8') as f:
        d = json.load(f)
    live = d['live'] if isinstance(d.get('live'), dict) else d
    deals = {}
    for x in live.get('deals') or []:
        dv = x.get('derived') or {}
        if not dv.get('paid_platform'):
            continue
        ev, pr = dv.get('paid_evidence') or {}, x.get('properties') or {}
        names = platform_in_text(dv['paid_platform'], platforms)
        deals[str(x.get('id'))] = {'platform': names[0]['name'] if len(names) == 1 else dv['paid_platform'], 'raw': dv['paid_platform'],
                                   'via': ev.get('via'), 'level': ev.get('level'), 'contactId': ev.get('contactId'),
                                   'branded': bool(dv.get('google_branded')), 'pipeline': str(dv.get('pipelineId') or pr.get('pipeline') or ''),
                                   'name': pr.get('dealname'), 'stage': dv.get('stageLabel'), 'amount': dv.get('amount'),
                                   'conversionDate': dv.get('conversion_date'), 'predatesSpendWindow': dv.get('predates_spend_window')}
    has_field = any('paid_platform' in (x.get('derived') or {}) for x in live.get('deals') or [])
    if not has_field:
        raise ValueError('%s has no derived.paid_platform field' % path)
    return {'basis': 'Pipeline export', 'path': path, 'generatedAt': d.get('generated_at') or d.get('fetchedAt'), 'deals': deals}


def compute_paid_deals(deals, ctx):
    """The export's rules on synced contact fields: the deal's contacts first, then its company's contacts (level company)."""
    platforms, contacts, a = ctx['ls'].platforms, ctx['contacts'], ctx['assoc']
    out = {}
    for d in deals:
        found, level = None, 'deal'
        for cid in sorted(a.get('deals', d['id'], 'contacts')):
            c = contacts.get(cid)
            found = c and contact_paid(c, platforms)
            if found:
                found['contactId'] = cid
                break
        if not found:
            level = 'company'
            for co in d['companyIds']:
                for cid in sorted(a.get('companies', co, 'contacts')):
                    c = contacts.get(cid)
                    found = c and contact_paid(c, platforms)
                    if found:
                        found['contactId'] = cid
                        break
                if found:
                    break
        if found:
            c = contacts[found['contactId']]
            conv = str(c['props'].get('first_conversion_date') or c['created'] or '')[:10] or None
            start = RULES['ads']['spendWindowStart'].get(found['platform'] or '')
            out[d['id']] = {'platform': found['platform'] or 'Paid (platform unknown)', 'raw': found['platform'], 'via': found['rule'],
                            'level': level, 'contactId': found['contactId'], 'branded': found['branded'], 'pipeline': d['pipeline'],
                            'name': d['name'], 'stage': d['stage'], 'amount': d['amount'], 'conversionDate': conv,
                            'predatesSpendWindow': bool(start and conv and conv < start) if start else None}
    return {'basis': 'computed from synced HubSpot contact fields (no Pipeline export given)', 'path': None, 'generatedAt': None, 'deals': out}


OVERRIDE_LABEL = 'Source override (human ruling)'


def load_source_overrides(path, warn):
    """source-overrides.json (data-side): human source rulings, kept across refreshes. Returns ({'deals': {id: entry},
    'leads': {id: entry}}, ok). An entry keeps only 'source' and, on deals, 'paid'; 'provenance' (who ruled, why) is
    never read into the output. A missing or invalid file warns and applies nothing."""
    empty = {'deals': {}, 'leads': {}}
    if not path or not os.path.exists(path):
        return empty, False
    try:
        with open(path, encoding='utf-8') as f:
            doc = json.load(f)
        if not isinstance(doc, dict):
            raise ValueError('top level is not an object')
        out = {}
        for kind in ('deals', 'leads'):
            xs = {} if doc.get(kind) is None else doc[kind]
            if not isinstance(xs, dict):
                raise ValueError('%s is not an object' % kind)
            out[kind] = {}
            for k, v in xs.items():
                src = v.get('source') if isinstance(v, dict) else None
                if not isinstance(src, str) or not src.strip() or (kind == 'deals' and not isinstance(v.get('paid', False), bool)):
                    warn('warn: source-overrides.json: %s entry %s skipped (needs a source%s)' % (
                        kind[:-1], k, ' and a true/false paid' if kind == 'deals' else ''))
                    continue
                out[kind][str(k).strip()] = {'source': src.strip(), **({'paid': v.get('paid')} if kind == 'deals' else {})}
        return out, True
    except (OSError, ValueError) as e:
        warn('warn: source-overrides.json %s not used: %s' % (path, e))
        return empty, False


def apply_deal_overrides(paid, deals, overrides):
    """A deal ruled not paid (paid: false) leaves the paid deals; every overridden deal carries the ruling's source."""
    for d in deals:
        o = overrides.get(d['id'])
        if o:
            d['sourceOverride'] = o['source']
    for i, o in overrides.items():
        if o.get('paid') is False:
            paid['deals'].pop(i, None)
    return paid


def paid_deals_view(paid, deal_by_id, comp_name):
    sales = []
    for i, x in paid['deals'].items():
        d = deal_by_id.get(i)
        pipe = d['pipeline'] if d else x['pipeline']
        if pipe != SCOPE['salesPipelineId']:
            continue
        sales.append({'id': i, 'name': (d or {}).get('name') or x['name'], 'stage': (d or {}).get('stage') or x['stage'],
                      'amount': (d or {}).get('amount') if d else x['amount'], 'platform': x['platform'], 'via': x['via'],
                      'level': x['level'], 'branded': x['branded'], 'open': (d or {}).get('open'),
                      'conversionDate': x.get('conversionDate'), 'predatesSpendWindow': x.get('predatesSpendWindow'),
                      'company': next((comp_name[c] for c in (d or {}).get('companyIds', []) if c in comp_name), None)})
    sales.sort(key=lambda r: (r['platform'], -(r['amount'] or 0)))
    by = {}
    for r in sales:
        by[r['platform']] = by.get(r['platform'], 0) + 1
    return {'basis': paid['basis'], 'generatedAt': paid['generatedAt'], 'total': len(paid['deals']), 'sales': sales,
            'predates': sum(1 for r in sales if r.get('predatesSpendWindow')),
            'otherPipelines': len(paid['deals']) - len(sales), 'byPlatform': by,
            'branded': sum(1 for r in sales if r['branded']), 'companyLevel': sum(1 for r in sales if r['level'] == 'company')}


def mql_funnel(brain, ctx, as_of):
    """r12 lead_to_mql_rate (config/lead-rules.json "mql"): external contacts who booked through the book-a-demo
    scheduling page / external contacts who filled a lead form or booked, trailing window. Unavailable (the page
    hides it) when its inputs are missing, when the page ids match no booking while scheduling-page bookings exist,
    or while the config says show: false; the computed figures are kept in 'computed' for monitoring."""
    cfg = RULES['mql']
    since = as_of - timedelta(days=cfg['windowDays'])
    in_window = lambda t: t is not None and since <= t <= as_of
    src_prop, link_prop = cfg['meetingSourceProperty'], cfg['bookingLinkProperty']
    has = lambda kind, prop: bool(brain.q("SELECT 1 FROM hubspot_objects WHERE object_type=? AND json_type(properties_json, '$.%s') IS NOT NULL LIMIT 1" % prop, (kind,)))
    missing = []
    if not has('meetings', src_prop):
        missing.append('meeting source (%s)' % src_prop)
    if not has('meetings', link_prop):
        missing.append('meeting scheduling page (%s)' % link_prop)
    if ctx['submissions'] is None:
        missing.append('form submissions')
    if missing:
        return {'available': False, 'reason': 'not derivable from brain.db: no %s' % ', '.join(missing)}
    free = {d.lower() for d in cfg.get('freeMailDomains') or []}
    internal = (set(ctx['internal_domains']) - free) if cfg.get('excludeInternalContacts') else set()
    external = lambda c: bool(c) and domain_of(c['email']) not in internal
    # The Oct 13 reporting rules on top (customers, free-mail and internal addresses out; ReportingScope) go in
    # 'afterReportingRules', a separate figure, so the existing ones keep their meaning.
    in_scope = lambda c: external(c) and ctx['scope'].contact(c['id']) is None
    ids = {str(i) for i in cfg['bookingLinkIds']}
    booked, public, no_source = set(), 0, 0
    fields = [src_prop, link_prop, 'hs_createdate', 'hs_meeting_start_time']
    for row in brain.objects('meetings', fields):
        mid, vals = str(row[0]), dict(zip(fields, row[1:]))
        if not in_window(parse_time(vals.get('hs_createdate') or vals.get('hs_meeting_start_time'))):
            continue
        source = str(vals.get(src_prop) or '').upper()
        if not source:
            no_source += 1
        if source != cfg['meetingSourceValue']:
            continue
        public += 1
        if str(vals.get(link_prop) or '') in ids:
            booked |= {cid for cid in ctx['assoc'].get('meetings', mid, 'contacts') if external(ctx['contacts'].get(cid))}
    ls = ctx['ls']
    filled = set()
    for email, subs in ctx['submissions'].items():
        c = ctx['contact_by_email'].get(email)
        if external(c) and any(in_window(parse_time(x['at'])) and ls.form_is_lead(ls.forms.get(x['formId'])) for x in subs):
            filled.add(c['id'])

    def rate(booked, filled):
        leads = filled | booked if cfg.get('denominatorIncludesBookers') else filled
        return leads, {'numerator': len(booked), 'denominator': len(leads), 'rate': (len(booked) / len(leads)) if leads else None,
                       'formFillers': len(filled), 'bookersWithoutForm': len(booked - filled)}
    leads, computed = rate(booked, filled)
    computed.update({'schedulingPageBookings': public, 'meetingsWithoutSource': no_source, 'windowDays': cfg['windowDays'],  # no window start: it moves every run and would change the content hash
                     'afterReportingRules': rate({i for i in booked if in_scope(ctx['contacts'].get(i))},
                                                 {i for i in filled if in_scope(ctx['contacts'].get(i))})[1]})
    if not leads:
        return {'available': False, 'reason': 'no form-filling or booking contacts in the window', 'computed': computed}
    if not booked and public:
        return {'available': False, 'reason': 'the book-a-demo page ids match none of the %d scheduling-page bookings in the window: '
                'check bookingLinkIds' % public, 'computed': computed}
    if not cfg.get('show', True):
        return {'available': False, 'reason': cfg.get('hiddenBecause') or 'hidden by config', 'computed': computed}
    return {'available': True, **computed, 'label': cfg['label'], 'definition': cfg['definition'],
            'formBasis': 'hubspot_form_submissions'}


# ---------- Oct 13 2026 reporting rules (config/lead-rules.json "reporting") ----------
class ReportingScope:
    """The scope step: the reporting rules applied once. contact(id) says why a contact is out of every count
    ('customer' / 'internal' / 'freeMail', reason) or None; form_excluded(form) for careers forms; dropped_deals for
    the excluded pipelines. Form counts, bookings, ad-platform leads, lead -> MQL and the meetings list read it."""

    def __init__(self, contacts, comps, deals):
        cu, co = REPORTING['customers'], REPORTING['contacts']
        self.cs_owners = {str(x) for x in cu['ownerIds']}
        self.customer_stages = {str(x).lower() for x in cu['lifecycleStages']}
        self.pipelines = {str(x) for x in cu['dealPipelines']}
        self.free = {d.lower() for d in co['freeMailDomains']}
        self.internal = {d.lower() for d in co['internalDomains']} - self.free
        self.form_prefixes = [str(x).strip().casefold() for x in co['excludedFormNamePrefixes']]
        self.dropped_deals = {d['id'] for d in deals if d['pipeline'] in self.pipelines}
        self.cs_deals = {d['id'] for d in deals if str(d.get('ownerId') or '') in self.cs_owners}
        self.companies = {i: self._customer(c['lifecycle'], c.get('ownerId'), 'company') for i, c in comps.items()}
        self.contacts = {}
        for i, c in contacts.items():
            why = self._customer(c['lifecycle'], c.get('ownerId'), 'contact') or next(
                (self.companies[x] for x in c['companies'] if self.companies.get(x)), None)
            self.contacts[i] = ('customer', why) if why else self.address(c['email'])

    def _customer(self, lifecycle, owner_id, what):
        if str(lifecycle or '').lower() in self.customer_stages:
            return '%s lifecycle stage is customer' % what
        if str(owner_id or '') in self.cs_owners:
            return '%s owned by customer success' % what
        return None

    def address(self, email):
        dom = domain_of(email) if email else ''
        if dom in self.internal:
            return ('internal', 'internal address')
        if dom in self.free:
            return ('freeMail', 'free-mail address')
        return None

    def contact(self, cid):
        return self.contacts.get(str(cid))

    def customer_deal(self, did):
        """'deal owned by customer success' for a deal with a customer-success owner, else None. A deal in an excluded
        pipeline is only dropped: a booking on it still counts (its contacts and companies decide)."""
        return 'deal owned by customer success' if str(did) in self.cs_deals else None

    def customer(self, cid):
        why = self.contacts.get(str(cid))
        return why[1] if why and why[0] == 'customer' else None

    def form_excluded(self, form):
        name = str((form or {}).get('name') or '').strip().casefold()
        return any(name.startswith(p) for p in self.form_prefixes)

    def careers_event(self, event):
        e = str(event or '').strip().casefold()
        return any(e.startswith(p) or (': ' + p) in e for p in self.form_prefixes)


def submission_out(f, c, email, ctx):
    """Why one form submission is out of the form counts, in waterfall order: 'customer', then 'careers' (careers and
    non-lead forms), then 'internal' / 'freeMail'; None when it counts. c is its contact (None when no contact has the
    address)."""
    ls, scope = ctx['ls'], ctx['scope']
    why = scope.contact(c['id']) if c else scope.address(email)
    if why and why[0] == 'customer':
        return 'customer'
    if scope.form_excluded(f) or not ls.form_is_lead(f):
        return 'careers'
    return why[0] if why else None


def form_counts(brain, ctx):
    """Forms: every submission of every lead-sources.json form (the count of record), joined to contacts by email,
    as a waterfall (all -> customers out -> careers forms, free-mail and internal addresses out); per contact, the
    form its first_conversion_event_name names (recent_conversion_* is never used alone)."""
    ls, scope = ctx['ls'], ctx['scope']
    if not brain.has('hubspot_form_submissions'):
        return {'available': False, 'reason': 'form submissions not yet synced'}
    order = []
    for f in ls.forms.values():
        if f.get('bucket') not in order:
            order.append(f.get('bucket'))
    lead_buckets = [b for b in order if b not in RULES['forms']['notLeadBuckets']]
    stages = {k: Counter() for k in ('all', 'afterCustomers', 'counted')}
    excluded, people = Counter(), {}
    no_contact = 0
    for fid, conv, email in brain.q('SELECT form_id, conversion_id, contact_email FROM hubspot_form_submissions'):
        f = ls.forms.get(str(fid))
        if not f:
            continue
        b = f.get('bucket')
        stages['all'][b] += 1
        email = (email or '').strip().lower()
        c = ctx['contact_by_email'].get(email) if email else None
        out = submission_out(f, c, email, ctx)
        if out == 'customer':
            excluded['customer'] += 1
            continue
        stages['afterCustomers'][b] += 1
        if out:
            excluded[out] += 1
            continue
        stages['counted'][b] += 1
        no_contact += 0 if c else 1
        people.setdefault(b, set()).add(c['id'] if c else (email or 'conversion:' + str(conv)))
    first = {'afterCustomers': Counter(), 'counted': Counter()}
    other_events = 0
    for c in ctx['contacts'].values():
        event = c['props'].get('first_conversion_event_name')
        if not event:
            continue
        f = ls.form_for_event(event)
        if not f:
            other_events += 1
            continue
        why = scope.contact(c['id'])
        if why and why[0] == 'customer':
            continue
        first['afterCustomers'][f.get('bucket')] += 1
        if not why and ls.form_is_lead(f) and not scope.form_excluded(f):
            first['counted'][f.get('bucket')] += 1
    exportable = {}
    if 'submissions_exportable' in brain.cols('hubspot_forms'):
        exportable = {str(i): x for i, x in brain.q('SELECT form_id, submissions_exportable FROM hubspot_forms')}
    not_read = sorted(i for i in ls.forms if exportable.get(i) != 1) if exportable else []
    return {
        'available': True, 'definition': REPORTING['forms']['about'],
        'buckets': [{'bucket': b, 'submissions': stages['counted'][b], 'contacts': len(people.get(b, ())),
                     'firstConversion': first['counted'][b]} for b in lead_buckets],
        'total': sum(stages['counted'].values()),
        'waterfall': {k: dict(sorted(v.items())) for k, v in stages.items()},
        'excluded': dict(sorted(excluded.items())),
        'firstConversion': {k: dict(sorted(v.items())) for k, v in first.items()},
        'firstConversionNotAForm': other_events, 'noContact': no_contact,
        'formsInMapping': len(ls.forms), 'formsNotRead': not_read,
    }


def stage_at(history, t):
    """A deal's dealstage at time t, from its stage history; None when the deal did not exist yet."""
    best = None
    for h in history or []:
        ht = parse_time(h.get('timestamp'))
        if ht and ht <= t and (best is None or ht > best[0]):
            best = (ht, str(h.get('value') or ''))
    return best[1] if best else None


def booking_kind(mid, t, ctx):
    """One public meeting-link booking: (why it is out: 'customer', 'opportunity', 'internal', 'freeMail' or None,
    whether a Sales deal on it had no stage history to check, whether a Sales deal on it was On Hold then)."""
    cfg, scope, a = REPORTING['meetings'], ctx['scope'], ctx['assoc']
    whys = [scope.contact(cid) for cid in a.get('meetings', mid, 'contacts')]
    if any(w and w[0] == 'customer' for w in whys) or any(scope.customer_deal(did) for did in a.get('meetings', mid, 'deals')):
        return 'customer', False, False
    unknown = on_hold = False
    for did in a.get('meetings', mid, 'deals'):
        d = ctx['deal_by_id'].get(did)
        if not d or d['pipeline'] != cfg['dealPipeline']:
            continue
        if d.get('stageHistory') is None or t is None:
            unknown = True
            continue
        stage = stage_at(d['stageHistory'], t)
        if stage in cfg['pastDiscoveryStages']:
            return 'opportunity', False, False
        on_hold = on_hold or stage in cfg['notPastStages']
    if whys and all(whys):
        return ('internal' if any(w[0] == 'internal' for w in whys) else 'freeMail'), unknown, on_hold
    return None, unknown, on_hold


def booking_counts(brain, ctx):
    """Meeting-link bookings (hs_meeting_source MEETINGS_PUBLIC, dated by hs_createdate) as a waterfall: total ->
    customers and past-Discovery opportunities out (afterRules) -> all-free-mail / internal bookings out (counted);
    overall and by year (PT)."""
    cfg = REPORTING['meetings']
    src, tprop = cfg['sourceProperty'], cfg['timeProperty']
    keys = ('total', 'customer', 'opportunity', 'afterRules', 'internal', 'freeMail', 'counted')
    total, years = Counter(), {}
    unknown = on_hold = 0
    found = False
    for mid, source, created, start in brain.objects('meetings', [src, tprop, 'hs_meeting_start_time']):
        found = found or bool(source)
        if str(source or '').upper() != cfg['sourceValue']:
            continue
        t = parse_time(created) or parse_time(start)
        kind, no_history, held = booking_kind(str(mid), t, ctx)
        y = years.setdefault(str(t.astimezone(TZ).year) if t else 'unknown', Counter())
        for c in (total, y):
            c['total'] += 1
            c[kind or 'counted'] += 1
            if kind not in ('customer', 'opportunity'):
                c['afterRules'] += 1
        unknown += bool(no_history and kind not in ('customer', 'opportunity'))
        on_hold += bool(held and kind not in ('customer', 'opportunity'))
    if not found:
        return {'available': False, 'reason': 'meeting source (%s) not synced' % src}
    shape = lambda c: {k: c[k] for k in keys}
    return {'available': True, 'definition': cfg['about'], **shape(total),
            'byYear': {y: shape(c) for y, c in sorted(years.items())},
            'stageHistorySynced': any(d.get('stageHistory') is not None for d in ctx['deal_by_id'].values()
                                      if d['pipeline'] == cfg['dealPipeline']),
            'opportunityUnchecked': unknown, 'onHoldKept': on_hold, 'onHoldNote': cfg['notPastNote']}


def first_touch(c):
    """The contact's first-touch query (hs_analytics_first_url parameters, then its utm_* fields; keys lower-cased)
    and the first referrer's domain."""
    p = c['props']
    q = {}
    url = str(p.get('hs_analytics_first_url') or '')
    if url:
        for k, v in urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query):
            if v:
                q.setdefault(k.strip().lower(), v.strip())
    for k, v in p.items():
        k = str(k).lower()
        if k.startswith('utm_') and v not in (None, ''):
            q.setdefault('utm_source' if k == 'utm_sourse' else k, str(v).strip())  # the portal has a misspelt utm_sourse
    return q, domain_of(p.get('hs_analytics_first_referrer'))


def ad_touch(c, platforms):
    """('paid', platform name or None, evidence), ('ai', None, evidence) or None for one contact's first touch."""
    cfg = REPORTING['adLeads']
    p = c['props']
    q, ref = first_touch(c)
    src = str(p.get('hs_analytics_source') or '').upper()
    medium = norm(q.get('utm_medium')).replace(' ', '_')
    clicks = [k for k in cfg['clickIds'] if q.get(k)]
    net = str(q.get('hsa_net') or '').lower()
    shown = ', '.join('%s=%s' % (k, q[k]) for k in ('utm_source', 'utm_medium', 'utm_campaign', 'hsa_net') if q.get(k))
    named = lambda key: next((x['name'] for x in platforms if x['key'] == key), None)
    if medium in cfg['paidMediums'] or net or clicks or src in cfg['paidAnalyticsSources']:
        hits = platform_in_text(q.get('utm_source', ''), platforms) or platform_in_text(q.get('utm_campaign', ''), platforms)
        plat = hits[0]['name'] if len(hits) == 1 else None
        plat = plat or named(cfg['hsaNetworks'].get(net)) or next((named(cfg['clickIds'][k]) for k in clicks if cfg['clickIds'][k]), None)
        if not plat and src in cfg['paidAnalyticsSources']:
            hits = platform_in_text(' '.join(str(p.get(k) or '') for k in ('hs_analytics_source_data_1', 'hs_analytics_source_data_2')), platforms)
            plat = hits[0]['name'] if len(hits) == 1 else None
        return 'paid', plat, '; '.join(x for x in [shown, ', '.join(clicks), src] if x)
    ai = cfg['aiReferral']
    if src in ai['analyticsSources'] or ref in ai['referrerDomains'] or norm(q.get('utm_source')) in {norm(x) for x in ai['utmSources']}:
        return 'ai', None, '; '.join(x for x in [src, ref and 'referrer ' + ref, shown] if x)
    return None


def conversion_status(c, ctx):
    """'lead' when the contact converted (a lead form submission, a conversion event that is not a careers form,
    or a meeting-link booking); 'careers' when its only conversions are careers forms; else 'noConversion'."""
    ls, scope = ctx['ls'], ctx['scope']
    lead = careers = False
    for sub in (ctx['submissions'] or {}).get(c['email'], []):
        f = ls.forms.get(sub['formId'])
        if not f:
            continue
        if scope.form_excluded(f) or not ls.form_is_lead(f):
            careers = True
        else:
            lead = True
    first = c['props'].get('first_conversion_event_name')
    for e in [first, c['props'].get('recent_conversion_event_name')] if first else []:  # never recent_* alone
        if not e:
            continue
        f = ls.form_for_event(e)
        if scope.careers_event(e) or (f and (scope.form_excluded(f) or not ls.form_is_lead(f))):
            careers = True
        else:
            lead = True
    if lead or c['id'] in ctx['booked']:
        return 'lead'
    return 'careers' if careers else 'noConversion'


def ad_leads(ctx):
    """Per ad platform, HubSpot-sourced leads (config/lead-rules.json reporting.adLeads), and organic AI referrals apart."""
    cfg = REPORTING['adLeads']
    platforms = ctx['ls'].platforms
    row = lambda name, key: {'name': name, 'key': key, 'leads': 0, 'contacts': 0, 'excluded': Counter(), 'ids': []}
    rows = {p['name']: row(p['name'], p['key']) for p in platforms}
    unnamed = row('Paid (platform not named)', 'unnamed')
    ai = row(cfg['aiReferral']['label'], 'ai')
    for c in sorted(ctx['contacts'].values(), key=lambda c: c['id']):
        t = ad_touch(c, platforms)
        if not t:
            continue
        r = ai if t[0] == 'ai' else rows.get(t[1]) or unnamed
        r['contacts'] += 1
        why = ctx['scope'].contact(c['id'])
        status = why[0] if why else conversion_status(c, ctx)
        if status != 'lead':
            r['excluded'][status] += 1
            continue
        r['leads'] += 1
        r['ids'].append(c['id'])
    done = lambda r: {**r, 'excluded': dict(sorted(r['excluded'].items()))}
    return {'definition': cfg['about'], 'platformFigureLabel': cfg['platformFigureLabel'],
            'firstUrlSynced': ctx['reporting_synced']['hs_analytics_first_url'],
            'firstUrlCoverage': ctx['reporting_coverage'].get('hs_analytics_first_url', 0.0),
            'platforms': [done(rows[p['name']]) for p in platforms], 'unnamed': done(unnamed), 'aiReferral': done(ai)}


def booked_contacts(brain, assoc):
    """Contacts on a meeting-link booking (a conversion for the ad-lead check)."""
    cfg = REPORTING['meetings']
    out = set()
    for mid, source in brain.objects('meetings', [cfg['sourceProperty']]):
        if str(source or '').upper() == cfg['sourceValue']:
            out.update(assoc.get('meetings', str(mid), 'contacts'))
    return out


def load_call_classification(path, warn):
    if not path:
        return None, 'no CALL_CLASSIFICATION path given'
    if not os.path.exists(path):
        warn('warn: call classification %s not found; falling back to the built-in call rule' % path)
        return None, '%s not found' % os.path.basename(path)
    out = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('call_id') is not None and r.get('audience'):
                out[str(r['call_id'])] = r
    if not out:
        return None, '%s has no records' % os.path.basename(path)
    return out, None


def _is_fragment(v):
    return not isinstance(v, str) or not v.strip() or v.strip().startswith('//') or 'fathom.video/share' in v


def load_lead_insights(doc):
    """lead-insights.json -> {HubSpot contact id: insight}. Accepts {leads: {id: entry}}, {leads: [entry]} or {id: entry}."""
    if not isinstance(doc, dict):
        return {}
    rows = doc.get('leads') if isinstance(doc.get('leads'), (dict, list)) else {k: v for k, v in doc.items() if isinstance(v, dict)}
    if isinstance(rows, dict):
        rows = [dict(v, contact_id=v.get('contact_id') or k) for k, v in rows.items() if isinstance(v, dict)]
    out = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        cid = r.get('contact_id') or r.get('hubspot_contact_id') or r.get('contactId')
        if not cid:
            continue
        themes = r.get('themes') if isinstance(r.get('themes'), dict) else {}
        clean = lambda xs: [str(x).replace('_', ' ') for x in (xs or []) if not _is_fragment(x)]
        text = next((r.get(k) for k in ('insight', 'text', 'summary', 'note') if not _is_fragment(r.get(k))), None)
        ins = {'contactId': str(cid), 'lastCall': r.get('last_call_date'), 'calls': r.get('call_count'),
               'basis': r.get('basis') if not _is_fragment(r.get('basis')) else None, 'text': text,
               'objections': clean(themes.get('objections')), 'competitors': clean(themes.get('competitors')),
               'pains': clean(themes.get('pains')), 'nextStep': None if _is_fragment(r.get('next_step')) else r.get('next_step'),
               'risk': clean(r.get('risk'))}
        if any(ins[k] for k in ('text', 'basis', 'objections', 'competitors', 'pains', 'nextStep', 'risk')):
            out[str(cid)] = ins
    return out


# ---------- meetings and calls ----------
def internal_domains(owners):
    return {domain_of(o['email']) for o in owners.values() if o['email']}


def classify_meeting(mid, m, ctx):
    a, comps, contacts = ctx['assoc'], ctx['comps'], ctx['contacts']
    if m['ownerId'] in ctx['cs_ids']:
        return 'cs', None, []
    t = parse_time(m['start'])
    for did in a.get('meetings', mid, 'deals'):
        d = ctx['deal_by_id'].get(did)
        if d and d['pipeline'] in SCOPE['customerPipelines']:
            return 'customer', 'linked to a %s deal' % SCOPE['excludedPipelines'].get(d['pipeline'], 'customer'), []
    cids = set(a.get('meetings', mid, 'companies'))
    people = [contacts[c] for c in a.get('meetings', mid, 'contacts') if c in contacts]
    for p in people:
        cids.update(p['companies'])
    internal = ctx['internal_domains']
    external = [p for p in people if domain_of(p['email']) not in internal]
    cos = [comps[c] for c in sorted(cids) if c in comps and comps[c]['domain'] not in internal]
    if people and not external and not cos:
        return 'internal', None, []
    for c in cos:
        if customer_at(c, t):
            return 'customer', c['name'], cos
    if any(c['salesDeal'] for c in cos):
        return 'matched', None, cos
    if not people and not cos:
        hit = ctx['customer_title'](m.get('title')) if ctx.get('customer_title') else None
        if hit:
            return 'customer', 'title names %s' % hit['name'], [hit]
        return 'unmatched', 'no contact or company linked', cos
    return 'unmatched', 'no Sales Pipeline deal at the linked company' if cos else 'contact has no company', cos


def bucket_counts(xs):
    return {'matched': sum(1 for x in xs if x['matched']), 'unmatched': sum(1 for x in xs if not x['matched'] and x['linked']),
            'noContact': sum(1 for x in xs if not x['linked'])}


def customer_title_matcher(comps):
    """For meetings with nothing linked: a title naming a customer company (whole words, name >= 5 letters)."""
    names = {}
    for c in comps.values():
        if is_customer_company(c) and len(letters(c['name'])) >= 5:
            names.setdefault(norm(c['name']), c)
    if not names:
        return None
    rx = re.compile(r'(?<![a-z0-9])(' + '|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r')(?![a-z0-9])')
    def match(title):
        m = rx.search(norm(title))
        return names[m.group(1)] if m else None
    return match


def build_meetings(brain, ctx, as_of):
    owners, scrub = ctx['owners'], ctx['scrub']
    meetings = []
    for mid, title, start, ts, outcome, owner in brain.objects('meetings', ['hs_meeting_title', 'hs_meeting_start_time',
                                                                         'hs_timestamp', 'hs_meeting_outcome', 'hubspot_owner_id']):
        meetings.append({'id': str(mid), 'title': title or '(no title)', 'start': iso(parse_time(start or ts)),
                         'outcome': outcome, 'ownerId': str(owner or '')})
    this_month = as_of.astimezone(TZ).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    window_start = min(this_month, as_of - timedelta(days=SCOPE['meetingsWindowDays']))
    counts = {'total': len(meetings), 'cs': 0, 'customer': 0, 'internal': 0, 'inScope': 0}
    customer_companies = set()
    items, by_company = [], {}
    for m in meetings:
        kind, why, cos = classify_meeting(m['id'], m, ctx)
        if kind in ('cs', 'customer', 'internal'):
            counts[kind] += 1
            if kind == 'customer':
                customer_companies.update(c['id'] for c in cos if customer_at(c, parse_time(m['start'])))
            continue
        counts['inScope'] += 1
        t = parse_time(m['start'])
        people = [ctx['contacts'][c] for c in ctx['assoc'].get('meetings', m['id'], 'contacts') if c in ctx['contacts']]
        item = {'id': m['id'], 'title': scrub.text(m['title']), 'start': m['start'], 'outcome': m['outcome'],
                'owner': owners.get(m['ownerId'], {}).get('name') or UNASSIGNED, 'matched': kind == 'matched',
                'linked': bool(people or cos),
                'reason': why, 'inWindow': bool(t and t >= window_start),
                'contacts': [{'name': p['name'], 'title': p['title'],
                              'company': next((ctx['comps'][c]['name'] for c in p['companies'] if c in ctx['comps']), None)}
                             for p in people[:8] if domain_of(p['email']) not in ctx['internal_domains']],
                'companies': [{'id': c['id'], 'name': c['name'], 'deal': deal_ref(sales_deal_of(c))} for c in cos[:4]],
                'emails': sorted({p['email'] for p in people if p['email']})}
        for c in cos:
            by_company.setdefault(c['id'], []).append(item)
        if item['inWindow']:
            items.append(item)
    items.sort(key=lambda x: x['start'] or '')
    month_key = as_of.astimezone(TZ).strftime('%Y-%m')
    in_month = [x for x in items if x['start'] and parse_time(x['start']).astimezone(TZ).strftime('%Y-%m') == month_key]
    upcoming = [x for x in items if x['start'] and parse_time(x['start']) >= as_of]
    return {
        'items': items, 'byCompany': by_company, 'windowStart': ymd(window_start),
        'thisMonth': bucket_counts(in_month), 'upcoming': bucket_counts(upcoming),
        'scope': {**counts, 'customerCompanies': len(customer_companies)},
        'definition': 'HubSpot meetings, without CS owners, customer meetings (the call rule; a meeting with nothing linked '
                      'counts as a customer meeting when its title names a customer company) and internal-only meetings. '
                      'Matched: a linked contact or company belongs to a company with a Sales Pipeline deal. Unmatched: linked, '
                      'but no Sales Pipeline deal. No contact linked: nothing to check it against.',
    }


def build_calls(brain, ctx, as_of):
    owners, scrub, comps, contacts = ctx['owners'], ctx['scrub'], ctx['comps'], ctx['contacts']
    by_email_owner = {o['email']: o for o in owners.values() if o['email']}
    cs_emails = {owners[i]['email'] for i in ctx['cs_ids'] if i in owners and owners[i]['email']}
    internal = ctx['internal_domains']
    domain_index = {}
    for c in comps.values():
        if c['domain']:
            domain_index.setdefault(c['domain'], []).append(c)
    has_transcripts = brain.has('transcripts')
    with_transcript = {r[0] for r in brain.q('SELECT recording_id FROM transcripts WHERE n_turns > 0')} if has_transcripts else set()
    counts = ({'total': 0, 'prospect': 0, 'customer': 0, 'internal': 0, 'partner_other': 0} if ctx['call_class'] is not None
              else {'total': 0, 'internal': 0, 'cs': 0, 'customer': 0, 'prospect': 0})
    window_start = min(as_of.astimezone(TZ).replace(day=1, hour=0, minute=0, second=0, microsecond=0),
                       as_of - timedelta(days=SCOPE['callsWindowDays']))
    items = []
    for rid, title, sched, rec_start, created, rname, remail, inv, summary in brain.q(
            'SELECT recording_id, title, scheduled_start_time, recording_start_time, created_at, recorded_by_name, '
            'recorded_by_email, invitees_json, summary_markdown FROM meetings'):
        counts['total'] += 1
        t = parse_time(rec_start or sched or created)
        try:
            invitees = json.loads(inv or '[]') or []
        except ValueError:
            invitees = []
        ext = [i for i in invitees if i.get('is_external') and domain_of(i.get('email')) not in internal]
        remail = (remail or '').strip().lower()
        cls = ctx['call_class']
        rc = cls.get(str(rid)) if cls is not None else None
        if cls is not None:
            # Strategy's per-call classification decides; only prospect calls are counted or listed.
            aud = rc['audience'] if rc else 'unclassified'
            counts[aud] = counts.get(aud, 0) + 1
            if aud != 'prospect':
                continue
        elif not ext:
            counts['internal'] += 1
            continue
        elif remail in cs_emails:
            counts['cs'] += 1
            continue
        cos = {}
        if rc and str(rc.get('hubspot_company_id') or '') in comps:
            cos[str(rc['hubspot_company_id'])] = comps[str(rc['hubspot_company_id'])]
        for i in ext:
            c = contacts.get(ctx['contact_by_email'].get((i.get('email') or '').lower(), {}).get('id'))
            for co in (c['companies'] if c else []):
                if co in comps:
                    cos[co] = comps[co]
            d = domain_of(i.get('email'))
            if d and d not in FREE_MAIL:
                for co in domain_index.get(d, []):
                    cos[co['id']] = co
        if cls is None:
            if any(customer_at(c, t) for c in cos.values()):
                counts['customer'] += 1
                continue
            counts['prospect'] += 1
        if not t or t < window_start:
            continue
        rec = by_email_owner.get(remail)
        recorder = rec['name'] if rec else scrub.person((rname or '').title())
        deal_cos = [c for c in cos.values() if c['salesDeal']]
        strat = None
        if rc:
            dl = rc.get('deal') if isinstance(rc.get('deal'), dict) else None
            strat = {'reason': rc.get('audience_reason'), 'callType': rc.get('call_type'), 'buyerRoles': rc.get('buyer_roles') or [],
                     'deal': {'id': str(dl.get('id')), 'name': dl.get('name'), 'stage': dl.get('stage')} if dl else None,
                     'objections': [{'category': str(o.get('category') or '').replace('_', ' '), 'quote': o.get('quote')}
                                    for o in (rc.get('objections') or [])[:4] if isinstance(o, dict)],
                     'competitors': sorted((rc.get('competitors') or {}), key=lambda k: -(rc['competitors'][k] or 0))[:6]
                     if isinstance(rc.get('competitors'), dict) else [],
                     'nextSteps': [x for x in (rc.get('next_steps') or [])[:3] if isinstance(x, str)]}
        items.append({'id': 'R%s' % rid, 'title': scrub.text(title or '(no title)'), 'start': iso(t), 'recorder': recorder,
                      'matched': bool(deal_cos) or bool(strat and strat['deal']), 'strategy': strat,
                      'reason': None if deal_cos else ('no Sales Pipeline deal at the company' if cos else 'company not in HubSpot'),
                      'companies': [{'id': c['id'], 'name': c['name'], 'deal': deal_ref(sales_deal_of(c))} for c in list(cos.values())[:4]],
                      'contacts': [{'name': i.get('name'), 'company': None} for i in ext[:8]],
                      'emails': sorted({(i.get('email') or '').lower() for i in ext if i.get('email')}),
                      'summary': clean_summary(summary), 'transcript': rid in with_transcript})
    items.sort(key=lambda x: x['start'] or '')
    if ctx['call_class'] is not None:
        return {'items': items, 'scope': counts, 'windowStart': ymd(window_start), 'classification': 'strategy',
                'definition': 'Fathom recordings Strategy classifies as prospect calls (records.jsonl, audience = prospect; '
                              'rules in its CLASSIFICATION.md). Customer, internal and partner/other calls are not counted.'}
    return {'items': items, 'scope': counts, 'windowStart': ymd(window_start), 'classification': 'fallback',
            'classificationNote': 'call classification unavailable (%s): the built-in call rule is used' % ctx['call_class_reason'],
            'definition': 'Fathom recordings with an external guest, not recorded by a CS owner, and not a customer call. '
                          'A call at a company with a Closed Won deal counts as a prospect call only before its first win; '
                          'a call is a customer call after the first win, at a company with a Renewal or Customer Success '
                          'deal, or at a lifecycle-customer company with no won date.'}


def clean_summary(md):
    if not md:
        return None
    s = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', str(md))
    s = re.sub(r'[*_`#>]+', '', s)
    s = re.sub(r'\n{3,}', '\n\n', s).strip()
    return s[:1800] + ('…' if len(s) > 1800 else '')


def link_recordings(meetings, calls):
    """A HubSpot meeting gets the Fathom summary of a prospect call on the same PT day with a shared guest."""
    idx = {}
    for c in calls['items']:
        for e in c['emails']:
            idx.setdefault((ymd(parse_time(c['start'])), e), c)
    for m in meetings['items']:
        day = ymd(parse_time(m['start'])) if m['start'] else None
        hit = next((idx[(day, e)] for e in m['emails'] if (day, e) in idx), None)
        if hit:
            m['recordingId'] = hit['id']
    for x in meetings['items'] + calls['items']:
        x.pop('emails', None)


# ---------- fresh: the record sets the fresh frontend read from its one-time extract (docs/workspace-fresh.md) ----------
FRESH_VERSION = 1
FRESH_RULES = 'Oct 13 2026 reporting rules (config/lead-rules.json "reporting", ReportingScope)'


def compact(d):
    """d without its empty values (the extract's items carry only the properties that are set)."""
    return {k: v for k, v in d.items() if v not in (None, '')}


def fresh_submissions(brain, ctx):
    """Every form fill that counts (form_counts' 'counted' stage), one row each in gtm-static.json's submissions shape,
    oldest first. oct13: per lead bucket, the fills left once customers and careers / non-lead forms are out (the
    gtm-static.json oct13.forms basis)."""
    ls = ctx['ls']
    items, oct13 = [], Counter()
    for fid, at, email in brain.q('SELECT form_id, submitted_at, contact_email FROM hubspot_form_submissions'):
        f = ls.forms.get(str(fid))
        if not f:
            continue
        email = (email or '').strip().lower()
        c = ctx['contact_by_email'].get(email) if email else None
        out = submission_out(f, c, email, ctx)
        if out in ('customer', 'careers'):
            continue
        oct13[f.get('bucket')] += 1
        if not out:
            items.append({'formId': str(fid), 'submittedAt': iso(parse_time(at)), 'contactId': c['id'] if c else None})
    items.sort(key=lambda s: (s['submittedAt'] or '', s['formId'], s['contactId'] or ''))
    used = {s['formId'] for s in items}
    return {'items': items,
            'forms': {i: compact({k: f.get(k) for k in ('name', 'bucket', 'counts_as_lead_source')})
                      for i, f in sorted(ls.forms.items()) if i in used},
            'oct13': dict(sorted(oct13.items()))}


def booking_deal(mid, t, ctx, sales_by_company):
    """The Sales deal a booking belongs to (the fresh app's rule): a Sales deal on the meeting, else one at a linked
    company; the newest by create date. Its stage when booked comes from the stage history."""
    a, sales = ctx['assoc'], SCOPE['salesPipelineId']
    direct = [d for d in (ctx['deal_by_id'].get(i) for i in a.get('meetings', mid, 'deals')) if d and d['pipeline'] == sales]
    pool = direct or [d for c in a.get('meetings', mid, 'companies') for d in sales_by_company.get(c, ())]
    if not pool:
        return None
    d = max(pool, key=lambda d: (d['created'] or '', d['id']))
    at = stage_at(d['stageHistory'], t) if t and d.get('stageHistory') is not None else None
    return {'id': d['id'], 'stageId': d['stageId'], 'stageAtBooking': at, 'matchedBy': 'meeting' if direct else 'company'}


def fresh_meetings(brain, ctx, listed):
    """Every meeting-link booking that counts (booking_counts' 'counted' stage) in gtm-static.json's meetings shape.
    Titles name people, so a title is carried only for a meeting the meetings list already shows (listed: {id: title})."""
    cfg, a = REPORTING['meetings'], ctx['assoc']
    sales_by_company = {}
    for d in ctx['deal_by_id'].values():
        if d['pipeline'] == SCOPE['salesPipelineId']:
            for c in d['companyIds']:
                sales_by_company.setdefault(c, []).append(d)
    fields = [cfg['sourceProperty'], cfg['timeProperty'], 'hs_meeting_start_time', 'hubspot_owner_id', 'hs_meeting_outcome']
    items = []
    for row in brain.objects('meetings', fields):
        mid, v = str(row[0]), dict(zip(fields, row[1:]))
        if str(v[cfg['sourceProperty']] or '').upper() != cfg['sourceValue']:
            continue
        t = parse_time(v[cfg['timeProperty']]) or parse_time(v['hs_meeting_start_time'])
        if booking_kind(mid, t, ctx)[0]:
            continue
        item = {'id': mid, **compact({'hs_meeting_title': listed.get(mid), 'hs_createdate': v[cfg['timeProperty']],
                                      'hs_meeting_start_time': v['hs_meeting_start_time'], 'hubspot_owner_id': v['hubspot_owner_id'],
                                      'hs_meeting_outcome': v['hs_meeting_outcome']}),
                'contacts': a.get('meetings', mid, 'contacts'), 'companies': a.get('meetings', mid, 'companies'),
                'deals': a.get('meetings', mid, 'deals'), 'salesDeal': booking_deal(mid, t, ctx, sales_by_company)}
        items.append((t, item))
    items.sort(key=lambda x: (iso(x[0]) or '', x[1]['id']))
    return [x for _, x in items]


def fresh_deal_activity(brain, ctx, calls):
    """Per Sales deal, gtm-static.json's dealActivity: prospect calls to date (distinct PT days of Strategy's records.jsonl
    prospect calls on the deal), the last call day, the latest next step, and the start times of every HubSpot meeting on
    the deal or at its companies. A next step is carried only when the calls list already shows it."""
    sales = {d['id']: d for d in ctx['deal_by_id'].values() if d['pipeline'] == SCOPE['salesPipelineId']}
    shown = {c['id']: set((c.get('strategy') or {}).get('nextSteps') or []) for c in calls['items']}
    acts = {}
    for cid, r in ctx['call_class'].items():
        dl = r.get('deal') if isinstance(r.get('deal'), dict) else None
        did = str(dl.get('id') or '') if dl else ''
        if r.get('audience') != 'prospect' or did not in sales:
            continue
        day = str(r.get('datetime_pt') or '')[:10]
        a = acts.setdefault(did, {'days': set(), 'lastCall': None, 'step': None, 'stepAt': None})
        if not day:
            continue
        a['days'].add(day)
        a['lastCall'] = max(a['lastCall'] or day, day)
        steps = [x for x in (r.get('next_steps') or []) if not _is_fragment(x)]
        if steps and (not a['stepAt'] or day >= a['stepAt']):
            a['step'], a['stepAt'] = (steps[0], 'R%s' % cid), day
    by_company = {}
    for d in sales.values():
        for c in d['companyIds']:
            by_company.setdefault(c, []).append(d['id'])
    starts = {}
    for mid, start in brain.objects('meetings', ['hs_meeting_start_time']):
        if not start:
            continue
        mid = str(mid)
        for did in set(ctx['assoc'].get('meetings', mid, 'deals')) | {i for c in ctx['assoc'].get('meetings', mid, 'companies')
                                                                       for i in by_company.get(c, ())}:
            if did in sales:
                starts.setdefault(did, set()).add(start)
    out = {}
    for did in sorted(set(acts) | set(starts)):
        a = acts.get(did) or {'days': (), 'lastCall': None, 'step': None}
        step, call = a['step'] or (None, None)
        carried = step is not None and step in shown.get(call, ())
        out[did] = {'calls': len(a['days']), 'lastCall': a['lastCall'], 'nextStep': step if carried else None,
                    **({'nextStepCallId': call} if carried else {}), 'meetings': sorted(starts.get(did, ()))}
    return out


def build_fresh(brain, ctx, stages, freshness_rows, sections, as_of):
    """workspace.json 'fresh': form fills, meeting-link bookings, closed-won deals and per-deal call activity, the record
    sets the fresh frontend read from its one-time gtm-static.json extract, in the same shapes, synced each run and scoped
    by the same reporting rules. Person names and emails are left out: contact ids only, and an owner's name only when
    the rest of workspace.json already shows it (sections: the built sections so far). Company and deal names are
    HubSpot's, as elsewhere in the file."""
    last_ok = {f['source']: f['lastOkAt'] for f in freshness_rows}
    scope, sales_id = ctx['scope'], SCOPE['salesPipelineId']
    named = {d['owner'] for d in sections['deals'] + sections['closed']['lost']}
    named |= {m['owner'] for m in sections['meetings']['items']} | {c['recorder'] for c in sections['calls']['items']}

    def owner_name(oid):
        name = ctx['owners'].get(str(oid or ''), {}).get('name')
        return name if name in named else None

    def comp_name(cid):
        return (ctx['comps'].get(cid) or {}).get('name')

    if ctx['submissions'] is None:
        subs = {'available': False, 'reason': 'form submissions not yet synced'}
    else:
        s = fresh_submissions(brain, ctx)
        subs = {'available': True, 'fetchedAt': last_ok.get('hubspot_forms'),
                'provenance': {'source': 'HubSpot form submissions (brain.db hubspot_form_submissions, sync hubspot_forms)',
                               'rules': FRESH_RULES, 'stage': 'forms.waterfall.counted'},
                'count': len(s['items']), 'byYear': dict(sorted(Counter(ymd(parse_time(x['submittedAt']))[:4]
                                                                         for x in s['items'] if x['submittedAt']).items())),
                **s}

    bookings = sections['meetings']['bookings']
    if not bookings.get('available'):
        mtg = {'available': False, 'reason': bookings.get('reason')}
    else:
        items = fresh_meetings(brain, ctx, {m['id']: m['title'] for m in sections['meetings']['items']})
        year = str(as_of.astimezone(TZ).year)
        by = bookings['byYear']
        mtg = {'available': True, 'fetchedAt': last_ok.get('hubspot'),
               'provenance': {'source': 'HubSpot meetings with hs_meeting_source MEETINGS_PUBLIC (brain.db hubspot_objects, '
                                        'sync hubspot)', 'rules': FRESH_RULES, 'stage': 'meetings.bookings.counted'},
               'count': len(items), 'byYear': {y: c['counted'] for y, c in by.items()}, 'items': items,
               'oct13': {'overall': bookings['afterRules'], 'y' + year: (by.get(year) or {}).get('afterRules', 0),
                         'customerExcluded': bookings['customer'], 'pastDiscovery': bookings['opportunity'],
                         'publicBookings': bookings['total']}}

    won = sorted((d for d in ctx['deal_by_id'].values() if d['pipeline'] == sales_id and d['won'] and d['id'] not in scope.cs_deals),
                 key=lambda d: (d['close'] or '', d['id']))
    whole = lambda v: int(v) if isinstance(v, float) and v.is_integer() else v  # 40000, as the extract had, not 40000.0
    won_items = [{'id': d['id'], 'name': d['name'], 'amount': whole(d['amount']), 'close': d['close'], 'owner': owner_name(d['ownerId']),
                  'company': next((comp_name(c) for c in d['companyIds'] if comp_name(c)), None)} for d in won]
    won_sec = {'available': True, 'fetchedAt': last_ok.get('hubspot'),
               'provenance': {'source': 'HubSpot deals (brain.db hubspot_objects, sync hubspot)', 'rules': FRESH_RULES,
                              'stage': 'Sales Pipeline, closed won, not owned by customer success'},
               'count': len(won_items), 'byYear': dict(sorted(Counter(ymd(parse_time(w['close']))[:4] for w in won_items
                                                                       if parse_time(w['close'])).items())),
               'items': won_items}

    if ctx['call_class'] is None:
        calls = {'available': False, 'reason': 'call records unavailable (%s)' % ctx['call_class_reason']}
    else:
        act = fresh_deal_activity(brain, ctx, sections['calls'])
        days = [str(r.get('datetime_pt') or '')[:10] for r in ctx['call_class'].values() if r.get('audience') == 'prospect']
        calls = {'available': True, 'fetchedAt': last_ok.get('hubspot'), 'callsThrough': max((d for d in days if d), default=None),
                 'provenance': {'source': "Strategy's per-call records.jsonl (prospect calls, by deal) and HubSpot meetings "
                                          '(brain.db hubspot_objects, sync hubspot)', 'rules': FRESH_RULES,
                                'stage': 'Sales Pipeline deals; calls = distinct PT days with a prospect call'},
                 'count': len(act), 'dealActivity': act}

    ref_owners = {m.get('hubspot_owner_id') for m in (mtg.get('items') or [])} - {None}
    ref_comps = {c for m in (mtg.get('items') or []) for c in m['companies']}
    return {
        'version': FRESH_VERSION, 'contract': 'docs/workspace-fresh.md',
        'about': 'The record sets the fresh frontend read from its one-time HubSpot extract (gtm-static.json), synced every '
                 'run in the same shapes and scoped by the reporting rules. Contact ids only, no person names or emails.',
        'stages': {sid: m['label'] for (pid, sid), m in sorted(stages.items()) if pid == sales_id},
        'owners': {o: owner_name(o) for o in sorted(ref_owners) if owner_name(o)},
        'companies': {c: comp_name(c) for c in sorted(ref_comps) if comp_name(c)},
        'submissions': subs, 'meetings': mtg, 'won': won_sec, 'calls': calls,
    }


# ---------- strategy (docs/workspace-strategy.md) ----------
STRATEGY_VERSION = 1
# Contact lifecycle dates the sync fetches (hubspot_sync.py OBJECT_TYPES), as strategy.contacts columns.
LIFECYCLE_DATES = [('leadAt', 'hs_lifecyclestage_lead_date'), ('mqlAt', 'hs_lifecyclestage_marketingqualifiedlead_date'),
                   ('sqlAt', 'hs_lifecyclestage_salesqualifiedlead_date'), ('customerAt', 'hs_lifecyclestage_customer_date')]
PAST_LEAD_STAGES = {'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist'}
STRATEGY_FIELDS = ['id', 'lifecyclestage'] + [k for k, _p in LIFECYCLE_DATES] + [
    'firstConversion', 'firstConversionAt', 'recentConversion', 'recentConversionAt', 'conversions',
    'firstMeetingSource', 'bookings', 'firstBookingAt', 'firstBookingPage', 'bookADemo', 'dealIds', 'scope']


def utc_s(v):
    """Any HubSpot time -> ISO UTC to the second (shorter than iso(); strategy.contacts is the largest table)."""
    t = parse_time(v)
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if t else None


def id_order(i):
    return (len(i), i)  # HubSpot ids are numbers: shorter sorts first


def build_strategy(brain, ctx, stages, deals):
    """Contacts with their lifecycle dates, conversion events, meeting-link bookings and deal ids, and every deal's
    dealstage history with the time it entered each stage. Ids only: no names, emails or titles. Returns the section
    and the set of 'core' contact ids kept when the file is over budget."""
    contacts, assoc = ctx['contacts'], ctx['assoc']
    deal_contacts = {}  # contact -> deal ids: hubspot_associations, plus the deal extras' periodic re-read
    if 'contact_ids' in brain.cols('hubspot_deal_extras'):
        for did, raw in brain.q('SELECT deal_id, contact_ids FROM hubspot_deal_extras WHERE contact_ids IS NOT NULL'):
            try:
                for cid in json.loads(raw) or []:
                    deal_contacts.setdefault(str(cid), set()).add(str(did))
            except (TypeError, ValueError):
                pass
    dates = {}
    fields = [p for _k, p in LIFECYCLE_DATES]
    for row in brain.objects('contacts', fields):
        if any(row[1:]):
            dates[str(row[0])] = [utc_s(v) for v in row[1:]]
    # Meetings: the earliest one's source per contact, and the meeting-link bookings (config reporting.meetings),
    # with their scheduling page (config mql: the book-a-demo page ids).
    mcfg, qcfg = REPORTING['meetings'], RULES['mql']
    book_ids = {str(i) for i in qcfg['bookingLinkIds']}
    first_meeting, booked = {}, {}
    mfields = [mcfg['sourceProperty'], qcfg['bookingLinkProperty'], mcfg['timeProperty'], 'hs_meeting_start_time']
    for mid, source, page, created, start in brain.objects('meetings', mfields):
        if not source:
            continue
        t = parse_time(created) or parse_time(start)
        key = (iso(t) or '9999', str(mid))
        public = str(source).upper() == mcfg['sourceValue']
        for cid in assoc.get('meetings', str(mid), 'contacts'):
            if cid not in first_meeting or key < first_meeting[cid][0]:
                first_meeting[cid] = (key, str(source))
            if public:
                b = booked.setdefault(cid, {'n': 0, 'first': None, 'demo': False})
                b['n'] += 1
                b['demo'] = b['demo'] or str(page or '') in book_ids
                if b['first'] is None or key < b['first'][0]:
                    b['first'] = (key, utc_s(created) or utc_s(start), str(page) if page else None)
    rows, core = [], set()
    for cid in sorted(contacts, key=id_order):
        c, p = contacts[cid], contacts[cid]['props']
        deal_ids = sorted(set(assoc.get('contacts', cid, 'deals')) | deal_contacts.get(cid, set()), key=id_order)
        conv = num(p.get('num_conversion_events'))
        life = dates.get(cid) or [None] * len(LIFECYCLE_DATES)
        b = booked.get(cid)
        if deal_ids or b or any(life[1:]) or (c['lifecycle'] or '').lower() in PAST_LEAD_STAGES:
            core.add(cid)
        elif not (conv or p.get('first_conversion_event_name')):
            continue
        why = ctx['scope'].contact(cid)
        rows.append([cid, c['lifecycle'] or None, *life,
                     p.get('first_conversion_event_name') or None, utc_s(p.get('first_conversion_date')),
                     p.get('recent_conversion_event_name') or None, utc_s(p.get('recent_conversion_date')),
                     int(conv) if conv is not None else None,
                     first_meeting[cid][1] if cid in first_meeting else None,
                     b['n'] if b else 0, b['first'][1] if b else None, b['first'][2] if b else None, bool(b and b['demo']),
                     deal_ids, why[0] if why else None])
    history = {}
    for d in sorted(deals, key=lambda d: id_order(d['id'])):
        entered = None
        if d.get('stageHistory') is not None:
            entered = []
            for h in sorted(d['stageHistory'], key=lambda h: parse_time(h.get('timestamp')) or datetime.min.replace(tzinfo=timezone.utc)):
                sid, t = str(h.get('value') or ''), utc_s(h.get('timestamp'))
                if sid and t and (not entered or entered[-1][0] != sid):  # a re-save of the same stage is no entry
                    entered.append([sid, t])
        history[d['id']] = {'pipeline': d['pipeline'], 'stageId': d['stageId'], 'created': utc_s(d['created']),
                            'entered': entered}
    synced = lambda kind, prop: bool(brain.q("SELECT 1 FROM hubspot_objects WHERE object_type=? AND json_type(properties_json, '$.%s') IS NOT NULL LIMIT 1" % prop, (kind,)))
    section = {
        'version': STRATEGY_VERSION, 'contract': 'docs/workspace-strategy.md', 'available': True,
        'about': 'For Strategy: contacts with a deal, a conversion event, a meeting-link booking or a lifecycle stage past '
                 'lead, with their HubSpot lifecycle dates, conversion events, bookings and deal ids; and every deal\'s '
                 'dealstage history (propertiesWithHistory) as the time it entered each stage. HubSpot ids only.',
        'contactsScope': 'all',
        'stages': [{'pipeline': pid, 'pipelineLabel': m['pipeline'], 'id': sid, 'label': m['label'], 'order': m['order'],
                    'closed': m['closed']} for (pid, sid), m in sorted(stages.items(), key=lambda kv: (kv[0][0], kv[1]['order'], kv[0][1]))],
        'contacts': {'fields': STRATEGY_FIELDS, 'rows': rows},
        'dealStageHistory': history,
        'synced': {'lifecycleDates': [k for k, prop in LIFECYCLE_DATES if synced('contacts', prop)],
                   'conversionEvents': synced('contacts', 'first_conversion_event_name'),
                   'conversionCount': synced('contacts', 'num_conversion_events'),
                   'meetingSource': synced('meetings', mcfg['sourceProperty']),
                   'schedulingPage': synced('meetings', qcfg['bookingLinkProperty']),
                   'stageHistory': any(d.get('stageHistory') is not None for d in deals),
                   'dealContactsReread': 'contact_ids' in brain.cols('hubspot_deal_extras')},
    }
    return section, core


def strategy_finish(section, core=None):
    """Row conversion-event names -> an index into strategy.conversionEvents, and the counts; optionally only the
    core contacts (over budget)."""
    s = dict(section)
    f = STRATEGY_FIELDS
    rows = [list(r) for r in s['contacts']['rows'] if core is None or r[0] in core]
    events = sorted({r[i] for r in rows for i in (f.index('firstConversion'), f.index('recentConversion')) if r[i]})
    pos = {e: n for n, e in enumerate(events)}
    for r in rows:
        for i in (f.index('firstConversion'), f.index('recentConversion')):
            r[i] = pos.get(r[i])
    col = lambda name: [r[f.index(name)] for r in rows]
    s['contacts'] = {'fields': f, 'rows': rows}
    s['conversionEvents'] = events
    if core is not None:
        s['contactsScope'] = 'core: contacts with a deal, a booking or a lifecycle stage past lead (workspace.json over budget)'
    hist = s['dealStageHistory'].values()
    s['counts'] = {'contacts': len(rows), 'withDeals': sum(1 for x in col('dealIds') if x),
                   'contactDealPairs': sum(len(x) for x in col('dealIds')),
                   'withConversions': sum(1 for x, y in zip(col('conversions'), col('firstConversion')) if x or y is not None),
                   'bookers': sum(1 for x in col('bookings') if x), 'bookADemo': sum(1 for x in col('bookADemo') if x),
                   'byLifecycle': dict(sorted(Counter(x or 'none' for x in col('lifecyclestage')).items())),
                   'byScope': dict(sorted(Counter(x or 'in' for x in col('scope')).items())),
                   'deals': len(s['dealStageHistory']), 'dealsWithHistory': sum(1 for h in hist if h['entered'] is not None)}
    return s


def strategy_unavailable(reason):
    return {'version': STRATEGY_VERSION, 'contract': 'docs/workspace-strategy.md', 'available': False, 'reason': reason}


def add_strategy(out, build_section, scrub, warn):
    """out['strategy'], added after every other section is final (and within budget), so they are the same with or
    without it. Over budget it keeps the core contacts only, then leaves the section out; never fails the file."""
    try:
        section, core = build_section()
    except Exception as e:
        warn('warn: strategy left out: %s: %s' % (type(e).__name__, e))
        out['strategy'] = strategy_unavailable('left out: building it failed (%s)' % type(e).__name__)
        return
    size = lambda doc: len(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    base = size(out) + len(',"strategy":')
    for keep in (None, core):
        s = scrub.deep(strategy_finish(section, keep))
        if scrub.hit(json.dumps(s, ensure_ascii=False)):
            out['strategy'] = strategy_unavailable('left out: a scrub pattern was still in it')
            return
        if base + size(s) <= MAX_BYTES:
            out['strategy'] = s
            return
    warn('warn: workspace.json over %d bytes with strategy; strategy left out' % MAX_BYTES)
    out['strategy'] = strategy_unavailable('left out: workspace.json would be over its %d MiB budget' % (MAX_BYTES // 1048576))


# ---------- outbound ----------
def outbound(brain, ls, leads_by_email):
    """Every Lemlist campaign with its tags (filters). outbound_reply_rate = replies / sends over all of them (r12)."""
    rows = brain.q('SELECT campaign_id, name, status, raw_json FROM lemlist_campaigns')
    camps = []
    for cid, name, status, raw in rows:
        try:
            r = json.loads(raw or '{}')
        except ValueError:
            r = {}
        st = r.get('stats') if isinstance(r.get('stats'), dict) else {}
        camp = ls.campaign(cid, name)
        tags, flags = (camp['tags'], camp['flags']) if camp else campaign_tags(None, name)
        invite = sum(num(x.get('replied')) or 0 for x in st.get('steps') or [] if x.get('taskType') == 'linkedinInvite')
        row = {'id': str(cid), 'name': name, 'status': status, 'tags': tags, 'flags': flags, 'bucket': (camp or {}).get('bucket'),
               'sent': num(st.get('messagesSent')), 'delivered': num(st.get('delivered')), 'replies': num(st.get('replied')),
               'inviteReplies': invite or 0}
        row['mostlyInvite'] = bool(row['replies'] and invite and invite / row['replies'] > 0.5)
        if leads_by_email is not None:
            replied = [l for xs in leads_by_email.values() for l in xs if str(l.get('campaign_id')) == str(cid) and l.get('replied_at')]
            row['autoReplies'] = sum(1 for l in replied if is_auto_reply(l.get('raw_json')))
        row['rate'] = (row['replies'] / row['sent']) if row['replies'] is not None and row['sent'] else None
        camps.append(row)
    camps.sort(key=lambda r: (-(r['sent'] or 0), r['name']))
    sends = sum(r['sent'] or 0 for r in camps)
    replies = sum(r['replies'] or 0 for r in camps)
    labels = {t['tag']: t['label'] for t in RULES['lemlist']['tags']}
    labels['unmapped'] = 'Not in the mapping'
    return {'campaigns': camps, 'sends': sends, 'replies': replies, 'rate': (replies / sends) if sends else None,
            'count': len(camps), 'tagLabels': labels, 'leadsSynced': leads_by_email is not None,
            'definition': RULES['lemlist']['replyRate']['about'] + ' Sends = Lemlist messages sent; replies = Lemlist\'s reply count '
                          '(includes replies on the LinkedIn invite step and any auto-replies, flagged per campaign).'}


# ---------- current page cross-check ----------
def current_page_scope(path):
    """What the redesign removes from the current page: customer companies, their meetings and recordings."""
    with open(path, encoding='utf-8') as f:
        d = json.load(f)
    deals = {str(x.get('id')): x for x in d.get('deals') or []}
    def dl(i):
        return deals.get(str(i)) or deals.get('deal-' + str(i)) or {}
    comps = d.get('companies') or []
    cust = [c for c in comps if c.get('lifecycle') == 'customer' or any(dl(i).get('won') for i in c.get('dealIds') or [])
            or any(str(dl(i).get('pipelineId')) in SCOPE['customerPipelines'] for i in c.get('dealIds') or [])]
    return {'companies': len(cust), 'meetings': sum(len(c.get('meetings') or []) for c in cust),
            'recordings': sum(len(c.get('recordings') or []) for c in cust),
            'recordingsTotal': sum(len(c.get('recordings') or []) for c in comps),
            'builtAt': d.get('builtAt')}


# ---------- main ----------
def build(args, warn=lambda *a: print(*a, file=sys.stderr)):
    as_of = parse_time(args.as_of) if args.as_of else datetime.now(timezone.utc)
    inputs_used = resolve_inputs(args, warn)
    brain = Brain(args.db)
    ls_doc = read_json(args.lead_sources, 'lead-sources', warn)
    ls = LeadSources(ls_doc)
    patterns = load_scrub_patterns(args.scrub_patterns_file)
    if not patterns:
        raise SystemExit('no scrub patterns: set WORKSPACE_SCRUB_PATTERNS (comma list) or WORKSPACE_SCRUB_PATTERNS_FILE, '
                         'or put scrub-patterns.txt in --inputs-dir. The build refuses to run without them.')
    owners, scrub = load_owners(brain, patterns)
    cs_ids = set(SCOPE['csOwnerIds'])
    for ids in (((ls_doc or {}).get('customer_success') or {}).get('owners') or {}).values():
        cs_ids |= {str(i) for i in ids}
    assoc = Assoc(brain)
    stages = load_stages(brain)
    deals = load_deals(brain, stages, owners, assoc)
    sales = [d for d in deals if d['pipeline'] == SCOPE['salesPipelineId']]
    comps = load_companies(brain, owners)
    attach_deals(comps, deals)
    contacts, contact_by_email, contact_props = load_contacts(brain, owners, assoc)
    source_props = [p for p in contact_props if p not in REPORTING_CONTACT_PROPS]
    reporting_synced, reporting_coverage = reporting_fields_synced(brain, contact_props)
    # The scope step: the Oct 13 reporting rules, applied once; every count below reads it.
    scope = ReportingScope(contacts, comps, deals)
    fresh = freshness(brain, as_of)
    hub = next((f for f in fresh if f['source'] == 'hubspot'), None)
    data_at = parse_time(hub['lastOkAt']) if hub else None
    priors = []
    for p in args.prior or []:
        try:
            priors.append(load_prior(p))
        except (OSError, ValueError) as e:
            warn('warn: prior snapshot %s skipped: %s' % (p, e))
    ads = ads_section(brain, ls_doc, as_of)
    for a in ads:
        if ls.platform_check(a['key']):
            a['check'] = ls.platform_check(a['key'])
    spend = budget(brain, as_of)
    ga4 = ga4_unassigned(brain)
    lead_insights = load_lead_insights(read_json(args.lead_insights, 'lead-insights', warn) if args.lead_insights else None)
    ctx = {'brain': brain, 'ls': ls, 'owners': owners, 'scrub': scrub, 'assoc': assoc, 'comps': comps, 'contacts': contacts,
           'contact_by_email': contact_by_email, 'cs_ids': cs_ids, 'internal_domains': internal_domains(owners),
           'deal_by_id': {d['id']: d for d in deals}, 'ads': ads,
           'lemlist': lemlist_leads(brain), 'submissions': form_submissions(brain), 'memberships': list_memberships(brain),
           'form_names': {str(i): n for i, n in brain.q('SELECT form_id, name FROM hubspot_forms')} if brain.has('hubspot_forms') else {},
           'campaign_names': {str(i): n for i, n in brain.q('SELECT campaign_id, name FROM lemlist_campaigns')},
           'lead_insights': lead_insights, 'contact_props': contact_props, 'scope': scope,
           'reporting_synced': reporting_synced, 'reporting_coverage': reporting_coverage,
           'booked': booked_contacts(brain, assoc)}
    ctx['call_class'], ctx['call_class_reason'] = load_call_classification(args.call_classification, warn)
    review = load_review_list(args.review_list)
    ctx['review'] = review['byRow'] if review else {}
    paid = None
    if args.paid_export:
        try:
            paid = load_paid_export(args.paid_export, ls.platforms)
        except (OSError, ValueError) as e:
            warn('warn: paid export %s not used: %s' % (args.paid_export, e))
    if paid is None:
        paid = compute_paid_deals(deals, ctx)
    ctx['overrides'], inputs_used['source-overrides.json'] = load_source_overrides(getattr(args, 'source_overrides', None), warn)
    paid = apply_deal_overrides(paid, deals, ctx['overrides']['deals'])
    ctx['paid_deals'] = paid['deals']
    ctx['customer_title'] = customer_title_matcher(comps)
    meetings = build_meetings(brain, ctx, as_of)
    ctx['meetings_by_company'] = meetings.pop('byCompany')
    calls = build_calls(brain, ctx, as_of)
    link_recordings(meetings, calls)
    leads = build_leads(brain, ctx)
    out_bound = outbound(brain, ls, ctx['lemlist'])
    funnel = mql_funnel(brain, ctx, as_of)
    meetings['bookings'] = booking_counts(brain, ctx)
    forms = form_counts(brain, ctx)
    ad = ad_leads(ctx)
    for a in ads:
        a['figureLabel'] = ad['platformFigureLabel']
        hl_row = next((r for r in ad['platforms'] if r['name'] == a['name']), None)
        if hl_row:
            a['hubspotLeads'] = {k: hl_row[k] for k in ('leads', 'contacts', 'excluded')}
        if a['key'] == 'openai':
            a['aiReferral'] = {k: ad['aiReferral'][k] for k in ('name', 'leads', 'contacts', 'excluded')}
    hl = headline(sales, stages)
    lost = [d for d in sales if d['lost']]
    for d in lost:
        # A loss created after the company's first win is an expansion at a customer, not new business.
        made = parse_time(d['created'])
        d['postWin'] = any(comps[c]['firstWon'] and made and made > comps[c]['firstWon'] for c in d['companyIds'] if c in comps)
    by_stage = {}
    for d in lost:
        by_stage.setdefault(d['stage'], []).append(d)
    won = [d for d in sales if d['won']]
    pipeline_deals = sorted((d for d in sales if d['open']), key=lambda d: (d['onHold'], -(d['amount'] or 0), d['name']))
    comp_name = {c['id']: c['name'] for c in comps.values()}

    def deal_row(d):
        return {'id': d['id'], 'name': d['name'], 'stage': d['stage'], 'stageOrder': d['stageOrder'], 'amount': d['amount'],
                'probability': d['probability'], 'weighted': money0(d['amount'] * d['probability']) if d['amount'] is not None and d['probability'] is not None else None,
                'close': d['close'], 'created': d['created'], 'owner': d['owner'], 'onHold': d['onHold'], 'open': d['open'],
                'won': d['won'], 'lost': d['lost'], 'lostReason': d['lostReason'], 'postWin': d.get('postWin', False),
                'sourceOverride': d.get('sourceOverride'),
                'paid': ({k: ctx['paid_deals'][d['id']].get(k) for k in ('platform', 'via', 'level', 'branded', 'conversionDate', 'predatesSpendWindow')} if d['id'] in ctx['paid_deals'] else None),
                'company': next((comp_name[c] for c in d['companyIds'] if c in comp_name), None)}
    lost_doc = read_json(args.lost_reasons, 'lost-reasons', warn) if args.lost_reasons else None
    insights = read_json(args.insights, 'insights', warn) if args.insights else None
    removed_customers = [c for c in comps.values() if is_customer_company(c)]
    out = {
        'schemaVersion': SCOPE['workspaceSchemaVersion'],
        # Time keys use the sync job's volatile names (generatedAt, fetchedAt, at, lastOkAt), so a re-run with the
        # same content hashes the same there and in the preview refresh. asOf is written only when given.
        'meta': {'generatedAt': iso(datetime.now(timezone.utc)), **({'asOf': iso(as_of)} if args.as_of else {}),
                 'tz': 'America/Phoenix', 'tzLabel': 'PT',
                 'hubspot': {'fetchedAt': iso(data_at)}, 'portalId': args.portal_id, 'provisional': provisional_label(ls_doc),
                 'inputs': inputs_used,
                 'leadSourcesAt': (ls_doc or {}).get('generated_at'),
                 'notSynced': [label for t, label in NEW_SOURCES if not brain.has(t)] + ([] if source_props else ['HubSpot contact source fields']),
                 'contactSourceFields': source_props,
                 'reportingContactFields': [p for p in contact_props if reporting_synced.get(p)], 'leadInsights': len(lead_insights),
                 'callClassification': (len(ctx['call_class']) if ctx['call_class'] is not None else None)},
        'freshness': fresh,
        'flags': staleness(fresh, ads, spend, ga4, brain, source_props, as_of) + ([{'key': 'calls', 'label': 'Call classification unavailable',
                  'text': calls.get('classificationNote', ''), 'level': 'warn'}] if calls.get('classification') == 'fallback' else []),
        'headline': {**hl, 'change': headline_change(sales, priors, data_at, as_of),
                     'definition': OPEN_DEF['definition']},
        'deals': [deal_row(d) for d in pipeline_deals],
        'closed': {'won': totals(won), 'lostByStage': [{'stage': k, **totals(v)} for k, v in sorted(by_stage.items(), key=lambda kv: -len(kv[1]))],
                   'lost': [deal_row(d) for d in lost], 'reasonsDoc': lost_doc,
                   'reasonsNote': 'lost-reasons.json covers new-business Sales Pipeline deals only; losses created after the company\'s first win (expansion at a customer) are listed apart.'},
        'leads': leads,
        'forms': forms,
        'adLeads': ad,
        'mqlFunnel': funnel,
        'paidDeals': paid_deals_view(paid, ctx['deal_by_id'], comp_name),
        'reviewList': ({'path': os.path.basename(review['path']), 'rows': [{**{k: r.get(k) for k in ('row', 'company', 'sheet_source', 'hubspot_sources', 'evidence', 'action', 'status',
                                                    'mql_channel', 'different_first_touch', 'attribution_evidence')},
                                  'hold': hold_label(r) if str(r.get('status') or '').startswith('on_hold') else None} for r in review['rows']],
                        'leadIds': {str(r): l['id'] for l in leads.get('items', []) for r in l['rows'] if r in ctx['review']}}
                       if review else None),
        'rules': {'answeredAt': RULES['answeredAt'], 'reportingApprovedAt': REPORTING['approvedAt'],
                  'sourcePrimary': RULES['source']['primary'], 'mql': RULES['mql']['definition'],
                  'mainForms': RULES['forms']['mainForms'], 'brandedFlag': RULES['ads']['brandedFlag']},
        'ads': ads,
        'spend': spend,
        'ga4': ga4,
        'outbound': out_bound,
        'meetings': meetings,
        'calls': calls,
        'insights': insights,
        'leadSources': {'eventLists': [{'id': l['id'], 'name': l.get('name'), 'show': l.get('show')} for l in ls.counted_event_lists],
                        'excludedLists': [{'id': l['id'], 'name': l.get('name'), 'why': l['excludedBecause'] or l.get('kind')}
                                          for l in ls.lists.values() if not l['counts']],
                        'checks': {k: v for k, v in ls.checks.items()},
                        'loaded': ls_doc is not None},
        'scope': {'salesPipeline': SCOPE['salesPipelineId'], 'droppedPipelines': list(SCOPE['excludedPipelines'].values()),
                  'customerCompanies': len(removed_customers),
                  'reporting': {'about': REPORTING['about'], 'droppedDeals': len(scope.dropped_deals),
                                'contactsOut': dict(sorted(Counter(w[0] for w in scope.contacts.values() if w).items()))},
                  'currentPage': current_page_scope(args.current_page) if args.current_page else None},
    }
    # Added last, from the sections above; nothing else reads it (docs/workspace-fresh.md). A failure here leaves fresh
    # out instead of failing the whole file.
    try:
        out['fresh'] = build_fresh(brain, ctx, stages, fresh, out, as_of)
    except Exception as e:
        warn('warn: fresh left out: %s: %s' % (type(e).__name__, e))
        out['fresh'] = {'version': FRESH_VERSION, 'contract': 'docs/workspace-fresh.md', 'available': False,
                        'reason': 'left out: building it failed (%s)' % type(e).__name__}
    out = scrub.deep(out)
    if scrub.hit(json.dumps(out, ensure_ascii=False)):
        raise SystemExit('scrub failed: a scrub pattern still appears in the output')
    if len(json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > MAX_BYTES:
        # The refresh rejects a file over the budget and keeps the last good one; the page's own sections come first.
        warn('warn: workspace.json over %d bytes; fresh left out' % MAX_BYTES)
        out['fresh'] = {'version': FRESH_VERSION, 'contract': 'docs/workspace-fresh.md', 'available': False,
                        'reason': 'left out: workspace.json would be over its %d MiB budget' % (MAX_BYTES // 1048576)}
    # Added last, after the budget check above, so it never pushes fresh (or anything else) out.
    add_strategy(out, lambda: build_strategy(brain, ctx, stages, deals), scrub, warn)
    return out


def audit_lines(d):
    h, l, m = d['headline'], d['leads'], d['meetings']
    usd = lambda v: '—' if v is None else '$' + format(round(v), ',')
    lines = ['headline: %d open, %s, %s weighted; On Hold %d, %s' % (h['open']['count'], usd(h['open']['amount']),
             usd(h['open']['weighted']), h['onHold']['count'], usd(h['onHold']['amount']))]
    c = h['change']
    lines.append('what changed: %s / %s -> %s / %s (%d deals listed)' % (c['from']['count'], usd(c['from']['amount']),
                 c['to']['count'], usd(c['to']['amount']), len(c['deals'])))
    lines.append('closed: ' + ', '.join('%s %d (%s)' % (x['stage'], x['count'], usd(x['amount'])) for x in d['closed']['lostByStage']))
    if l.get('connected'):
        lines.append('leads: %d (HubSpot-sourced %d, Sheet fallback %d), Sheet MQL incl SQL %d, review %d, other conflicts %d' % (
            l['total'], l['hubspotSourced'], l['total'] - l['hubspotSourced'], l['mql'], l['reviewLeads'], l['conflicts']))
    f = d['mqlFunnel']
    lines.append('lead -> MQL (90 days, proposed): ' + ('%d / %d = %.1f%%' % (f['numerator'], f['denominator'], 100 * f['rate'])
                                                         if f['available'] else 'hidden (%s)%s' % (f['reason'][:120], '; computed %d / %d' % (
                                                             f['computed']['numerator'], f['computed']['denominator']) if f.get('computed') else '')))
    fm = d['forms']
    if fm.get('available'):
        lines.append('forms (submissions, after the reporting rules): %s; excluded %s' % (
            ', '.join('%s %d' % (b['bucket'], b['submissions']) for b in fm['buckets']), fm['excluded']))
    bk = d['meetings']['bookings']
    if bk.get('available'):
        lines.append('meeting-link bookings: %d -> %d after customers / opportunities (%d customer, %d opportunity%s) -> %d counted' % (
            bk['total'], bk['afterRules'], bk['customer'], bk['opportunity'],
            '' if bk['stageHistorySynced'] else ', stage history not synced', bk['counted']))
    ad = d['adLeads']
    lines.append('ad-platform HubSpot leads%s: %s; %s %d' % ('' if ad['firstUrlSynced'] else ' (first URL not synced)', ', '.join(
        '%s %d' % (r['name'], r['leads']) for r in ad['platforms'] + [ad['unnamed']]), ad['aiReferral']['name'], ad['aiReferral']['leads']))
    o = d['outbound']
    lines.append('outbound reply rate: %d / %d = %.1f%% over %d campaigns' % (o['replies'], o['sends'], 100 * (o['rate'] or 0), o['count']))
    p = d['paidDeals']
    lines.append('paid deals (%s): %d total, %d Sales Pipeline %s' % (p['basis'], p['total'], len(p['sales']), p['byPlatform']))
    lines.append('calls (%s): %s' % (d['calls']['classification'], {k: v for k, v in d['calls']['scope'].items()}))
    rl = [x for x in d['closed']['lost'] if not x['postWin']]
    lines.append('lost reasons cover %d new-business deals (%d post-win expansions apart)' % (len(rl), len(d['closed']['lost']) - len(rl)))
    if l.get('connected'):
        if l.get('openai'):
            o = l['openai']
            lines.append('OpenAI leads: Lead Tracker notes %d named, at most %d; with HubSpot evidence %d named, at most %d' % (
                o['trackerNamed'], o['trackerAtMost'], o['confirmed'], o['atMost']))
    lines.append('meetings: this month %d matched (+%d unmatched, +%d no contact), upcoming %d matched (+%d unmatched, +%d no contact)' % (
        m['thisMonth']['matched'], m['thisMonth']['unmatched'], m['thisMonth']['noContact'],
        m['upcoming']['matched'], m['upcoming']['unmatched'], m['upcoming']['noContact']))
    cp = d['scope'].get('currentPage')
    if cp:
        lines.append('current page: removes %d customer companies, %d meetings, %d of %d recordings' % (
            cp['companies'], cp['meetings'], cp['recordings'], cp['recordingsTotal']))
    st = d.get('strategy') or {}
    if st.get('available'):
        k = st['counts']
        lines.append('strategy: %d contacts (%s; %d with deals, %d bookers), %d deals (%d with stage history)' % (
            k['contacts'], st['contactsScope'].split(':')[0], k['withDeals'], k['bookers'], k['deals'], k['dealsWithHistory']))
    else:
        lines.append('strategy: %s' % st.get('reason', 'missing'))
    return lines


# The files --inputs-dir may hold (the sync job copies them from s3://<data bucket>/state/gtm-inputs/<name>).
INPUT_FILES = {
    'lead_sources': 'lead-sources.json', 'lost_reasons': 'lost-reasons.json', 'insights': 'insights.json',
    'lead_insights': 'lead-insights.json', 'call_classification': 'records.jsonl', 'review_list': 'lead-source-review.csv',
    'paid_export': 'paid-deals.json', 'scrub_patterns_file': 'scrub-patterns.txt', 'source_overrides': 'source-overrides.json',
}


def resolve_inputs(args, warn):
    """Explicit flags win, then --inputs-dir/<name>, then the environment defaults. Each input is optional:
    a missing one is reported and its part of the page degrades."""
    used = {}
    for attr, name in INPUT_FILES.items():
        if not getattr(args, attr, None) and args.inputs_dir and os.path.exists(os.path.join(args.inputs_dir, name)):
            setattr(args, attr, os.path.join(args.inputs_dir, name))
        path = getattr(args, attr, None)
        ok = bool(path) and os.path.exists(path)
        if path and not ok:
            warn('warn: %s %s not found; that part of the page degrades' % (name, path))
        if attr != 'scrub_patterns_file':
            used[name] = ok
    return used


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--db', required=True)
    ap.add_argument('--inputs-dir', help='directory with any of: ' + ', '.join(INPUT_FILES.values()))
    ap.add_argument('--lead-sources')
    ap.add_argument('--lost-reasons')
    ap.add_argument('--insights')
    ap.add_argument('--lead-insights')
    ap.add_argument('--prior', action='append', help='earlier HubSpot deals export (live_deals.json shape), e.g. the previous published run; repeatable')
    ap.add_argument('--current-page', help='the current page data.json, to report what the redesign removes')
    ap.add_argument('--portal-id', help='HubSpot portal id, for record links')
    ap.add_argument('--as-of', help='ISO time the page is "as of" (default now; written to the JSON only when given)')
    ap.add_argument('--call-classification', default=os.environ.get('CALL_CLASSIFICATION'),
                    help="Strategy's per-call records.jsonl (default $CALL_CLASSIFICATION); without it the built-in call rule is used")
    ap.add_argument('--review-list', default=os.environ.get('LEAD_SOURCE_REVIEW'), help='lead-source-review.csv (default $LEAD_SOURCE_REVIEW)')
    ap.add_argument('--paid-export', default=os.environ.get('PAID_EXPORT'),
                    help="Pipeline's deals export with derived.paid_platform (default $PAID_EXPORT); without it the rules run on synced fields")
    ap.add_argument('--source-overrides', help='source-overrides.json: human source rulings per deal / lead (provenance never written out)')
    ap.add_argument('--scrub-patterns-file', help='scrub patterns file (else $WORKSPACE_SCRUB_PATTERNS / $WORKSPACE_SCRUB_PATTERNS_FILE)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args(argv)
    data = build(args)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(text)
    if not args.quiet:
        print('wrote %s (%d KB)' % (args.out, len(text.encode('utf-8')) // 1024))
        for line in audit_lines(data):
            print('  ' + line)
    if len(text.encode('utf-8')) > MAX_BYTES:
        print('warn: workspace.json is over the %d MB budget' % (MAX_BYTES // 1048576), file=sys.stderr)


if __name__ == '__main__':
    main()
