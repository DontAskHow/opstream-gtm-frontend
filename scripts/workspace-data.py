#!/usr/bin/env python3
"""Shape the one-page GTM workspace's data: brain.db (read-only) -> one JSON.

    python3 scripts/workspace-data.py --db brain.db --lead-sources lead-sources.json \
        [--lost-reasons f] [--insights f] [--lead-insights f] [--prior live_deals.json ...] \
        [--current-page data.json] [--portal-id N] [--as-of ISO] --out workspace.json

onepage/build.mjs renders the JSON. All scope rules are applied here, once:
Sales Pipeline only, CS owners and customer companies out of meetings and calls,
the hidden owner rendered as "Unassigned" (shared/workspace-scope.json). Lead
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
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TZ = ZoneInfo('America/Phoenix')
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

    PAIRS = [('deals', 'companies'), ('meetings', 'contacts'), ('meetings', 'companies'), ('meetings', 'deals'),
             ('contacts', 'companies')]

    def __init__(self, brain):
        self.m = {}
        for a, b in self.PAIRS:
            for f, t in brain.q('SELECT from_id, to_id FROM hubspot_associations WHERE from_type=? AND to_type=?', (a, b)):
                self.m.setdefault((a, f, b), set()).add(t)
                self.m.setdefault((b, t, a), set()).add(f)

    def get(self, a, i, b):
        return self.m.get((a, i, b), set())


# ---------- the hidden owner ----------
class Scrubber:
    def __init__(self, pattern, names):
        self.pattern = pattern.lower()
        names = sorted({n for n in names if n and len(n) >= 3}, key=len, reverse=True)
        self.names = re.compile('|'.join(re.escape(n) for n in names), re.I) if names else None
        self.token = re.compile(r'[\w.+\-]*' + re.escape(pattern) + r'[\w.+\-]*(?:@[\w.\-]+)?', re.I)

    def text(self, s):
        if not isinstance(s, str) or self.pattern not in s.lower():
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
        """An owner/attribution field: the hidden person, blank or 'not assigned' -> Unassigned."""
        s = str(s or '').strip()
        if not s or s.lower() in ('not assigned', 'unassigned', 'none', 'n/a'):
            return UNASSIGNED
        return UNASSIGNED if self.pattern in s.lower() else self.text(s)


def load_owners(brain):
    pattern = SCOPE['hiddenOwner']['pattern'].lower()
    owners, hidden = {}, []
    for oid, first, last, email in brain.q('SELECT id, first_name, last_name, email FROM hubspot_owners'):
        name = ' '.join(x for x in [first, last] if x).strip() or (email or '').split('@')[0]
        is_hidden = pattern in ('%s %s %s' % (first or '', last or '', email or '')).lower()
        if is_hidden:
            hidden += [name, email]
        owners[str(oid)] = {'name': UNASSIGNED if is_hidden else name, 'email': (email or '').strip().lower(),
                            'hidden': is_hidden}
    return owners, Scrubber(pattern, hidden)


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
        'owner': owner, 'lostReason': p.get('closed_lost_reason') or None, 'companyIds': sorted(company_ids),
    }


def totals(deals):
    priced = [d for d in deals if d['amount'] is not None]
    weighted = [d for d in priced if d['probability'] is not None]
    return {'count': len(deals), 'amount': money0(sum(d['amount'] for d in priced)),
            'weighted': money0(sum(d['amount'] * d['probability'] for d in weighted)),
            'noAmount': len(deals) - len(priced), 'noProbability': len(priced) - len(weighted)}


def load_deals(brain, stages, owners, assoc):
    extras = {}
    for did, cids in brain.q('SELECT deal_id, company_ids FROM hubspot_deal_extras'):
        try:
            extras[str(did)] = set(json.loads(cids or '[]'))
        except ValueError:
            pass
    deals = []
    for hs_id, pj in brain.q("SELECT hs_id, properties_json FROM hubspot_objects WHERE object_type='deals'"):
        p = json.loads(pj or '{}')
        meta = stages.get((str(p.get('pipeline')), str(p.get('dealstage'))))
        cids = assoc.get('deals', str(hs_id), 'companies') or extras.get(str(hs_id), set())
        deals.append(shape_deal(hs_id, p, meta, owners, cids))
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
        t.update({'id': sid, 'label': label, 'onHold': letters(label) in ON_HOLD,
                  'probability': stages[(SCOPE['salesPipelineId'], sid)]['prob']})
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
                           'owner': owners.get(str(owner or ''), {}).get('name') or UNASSIGNED,
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
            'won': d['won'], 'owner': d['owner']} if d else None


# ---------- contacts ----------
def load_contacts(brain, owners, assoc):
    present = [p for p in CONTACT_SOURCE_PROPS + discover_utm_props(brain)
               if brain.q("SELECT 1 FROM hubspot_objects WHERE object_type='contacts' AND json_type(properties_json, '$.%s') IS NOT NULL LIMIT 1" % p)]
    fields = ['email', 'firstname', 'lastname', 'jobtitle', 'lifecyclestage', 'hubspot_owner_id', 'createdate'] + present
    contacts, by_email = {}, {}
    for row in brain.objects('contacts', fields):
        cid, rest = str(row[0]), dict(zip(fields, row[1:]))
        email = (rest.pop('email') or '').strip().lower()
        c = {'id': cid, 'email': email,
             'name': ' '.join(x for x in [rest.pop('firstname'), rest.pop('lastname')] if x).strip() or None,
             'title': rest.pop('jobtitle'), 'lifecycle': rest.pop('lifecyclestage') or '',
             'owner': owners.get(str(rest.pop('hubspot_owner_id') or ''), {}).get('name') or UNASSIGNED,
             'created': rest.pop('createdate'), 'props': {k: v for k, v in rest.items() if v not in (None, '')},
             'companies': assoc.get('contacts', cid, 'companies')}
        contacts[cid] = c
        if email:
            by_email.setdefault(email, c)
    return contacts, by_email, present


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


class LeadSources:
    """lead-sources.json, indexed. Everything from it is provisional (see provisional_label)."""

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
            b = str(c.get('bucket') or '')
            kind = ('excluded' if b.startswith('exclude') or b.startswith('nurture') else
                    'customer' if 'separate sub-source' in b else 'outbound' if b.startswith('sales_outbound') else 'other')
            self.campaigns[str(c.get('id'))] = {**c, 'kind': kind}
        self.campaigns_by_name = {norm(c.get('name')): c for c in self.campaigns.values()}
        self.uncertain_forms = sorted(f.get('name') for f in self.forms.values() if f.get('uncertain') and f.get('counts_as_lead_source'))

    @property
    def counted_event_lists(self):
        return sorted((l for l in self.lists.values() if l['counts']), key=lambda l: int(l['id']) if str(l['id']).isdigit() else 0)

    def campaign(self, cid, name=None):
        return self.campaigns.get(str(cid)) or self.campaigns_by_name.get(norm(name))

    def form_source(self, form):
        m = re.search(r'Sheet source:\s*([A-Za-z]+)', str(form.get('detail') or ''))
        return m.group(1) if m else SCOPE['formBucketSource'].get(form.get('bucket'))


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
    return (names[0]['name'] if len(names) == 1 else None), detail


def attribute(lead, lead_contacts, ctx):
    """HubSpot/Lemlist evidence for one lead, in rule order. Returns evidence rows (first = the rule that fired)."""
    ls, platforms = ctx['ls'], ctx['ls'].platforms
    ev = []
    for c in lead_contacts:
        email = c['email']
        if ctx['lemlist'] is not None and email in ctx['lemlist']:
            for r in ctx['lemlist'][email]:
                camp = ls.campaign(r.get('campaign_id'))
                if camp and camp['kind'] == 'excluded':
                    continue
                name = (camp or {}).get('name') or ctx['campaign_names'].get(str(r.get('campaign_id'))) or r.get('campaign_id')
                ev.append({'rule': 'Lemlist lead email', 'source': 'Outbound', 'detail': name, 'contactId': c['id'],
                           'subSource': 'Customer job changer' if camp and camp['kind'] == 'customer' else name,
                           'tag': 'customer→new company' if camp and camp['kind'] == 'customer' else None,
                           'replied': bool(r.get('replied_at')) and not is_auto_reply(r.get('raw_json')),
                           'at': r.get('replied_at') or r.get('contacted_at')})
        if ctx['submissions'] is not None and email in ctx['submissions']:
            for s in ctx['submissions'][email]:
                form = ls.forms.get(s['formId']) or ls.forms_by_name.get(norm(ctx['form_names'].get(s['formId'])))
                fname = (form or {}).get('name') or ctx['form_names'].get(s['formId']) or s['formId']
                if form and not form.get('counts_as_lead_source'):
                    continue
                paid = paid_from_values(s['values'], platforms)
                if form and form.get('bucket') == 'ads_conversion' or paid:
                    ev.append({'rule': 'HubSpot form / UTM', 'source': 'Paid', 'detail': fname + ('' if not paid else ' · ' + paid[1]),
                               'platform': paid[0] if paid else None, 'contactId': c['id'], 'at': s['at'],
                               'unconfirmed': bool(form and form.get('uncertain'))})
                    continue
                ev.append({'rule': 'HubSpot form submission', 'source': ls.form_source(form) if form else None,
                           'detail': fname, 'subSource': (form or {}).get('bucket') or 'form not in mapping',
                           'unconfirmed': bool(not form or form.get('uncertain')), 'contactId': c['id'], 'at': s['at']})
        if ctx['memberships'] is not None:
            for m in ctx['memberships'].get(c['id'], []):
                l = ls.lists.get(m['listId'])
                if l and l['counts']:
                    ev.append({'rule': 'Event list upload', 'source': 'Events', 'detail': l.get('show') or l.get('name'),
                               'subSource': l.get('show') or l.get('name'), 'contactId': c['id'], 'at': m['added']})
        p = c['props']
        if p.get('paid_touch_campaign'):
            names = platform_in_text(p['paid_touch_campaign'], platforms)
            ev.append({'rule': 'paid_touch_campaign', 'source': 'Paid', 'detail': p['paid_touch_campaign'],
                       'platform': names[0]['name'] if len(names) == 1 else None, 'contactId': c['id']})
        src = str(p.get('hs_analytics_source') or '').upper()
        if src in SCOPE['paidAnalyticsSources'] or p.get('hs_google_click_id'):
            text = ' '.join(str(p.get(k) or '') for k in ('hs_analytics_source_data_1', 'hs_analytics_source_data_2'))
            names = platform_in_text(text, platforms)
            if not names and p.get('hs_google_click_id'):
                names = [x for x in platforms if x['key'] == 'google']
            ev.append({'rule': 'HubSpot original source', 'source': 'Paid', 'detail': ('%s %s' % (src, text)).strip(),
                       'platform': names[0]['name'] if len(names) == 1 else None, 'contactId': c['id']})
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


RULE_ORDER = ['Lemlist lead email', 'HubSpot form / UTM', 'HubSpot form submission', 'Event list upload',
              'paid_touch_campaign', 'HubSpot original source', 'HubSpot import', 'Lead Tracker note']


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
            lead['flags'].append({'kind': 'sheet', 'text': 'Lead Tracker rows disagree on Source: %s (first row wins)' % ' vs '.join(sources)})
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
        # Evidence: HubSpot/Lemlist rules first (in order), then the Tracker note.
        ev = attribute(lead, lcontacts, ctx)
        note = ' '.join(lead['notes'])
        named = platform_in_text(note, platforms)
        if named and re.search(r'\b(ad|ads|paid|ppc|cpc)\b', note, re.I):
            ev.append({'rule': 'Lead Tracker note', 'source': 'Paid', 'platform': named[0]['name'] if len(named) == 1 else None,
                       'detail': 'note names %s' % ' / '.join(p['name'] for p in named)})
        ev.sort(key=lambda e: RULE_ORDER.index(e['rule']))
        lead['evidence'] = ev
        fired = ev[0] if ev else None
        lead['rule'] = fired['rule'] if fired else 'Lead Tracker Source (column B)'
        # Sub-source within the Sheet Source.
        sub, platform, unconfirmed, tag = None, None, False, None
        if lead['source'] == 'Paid':
            pe = next((e for e in ev if e['source'] == 'Paid' and e.get('platform')), None)
            platform = pe['platform'] if pe else None
            sub = platform or 'Platform not named'
            if pe:
                lead['rule'] = pe['rule']
                unconfirmed = bool(pe.get('unconfirmed'))
            else:
                t = squash(note)
                possible = sorted(name for name, terms in event_terms.items() if any(x in t for x in terms))
                if possible:
                    lead['possiblePlatforms'] = possible
        else:
            same = next((e for e in ev if e['source'] == lead['source'] and e.get('subSource')), None)
            if same:
                sub, unconfirmed, tag = same['subSource'], bool(same.get('unconfirmed')), same.get('tag')
                lead['rule'] = same['rule']
            elif lead['source'] == 'Outbound':
                sub = 'Campaign: Lemlist leads not yet synced' if ctx['lemlist'] is None else 'No Lemlist match'
            elif lead['source'] == 'Events':
                sub = 'List: memberships not yet synced' if ctx['memberships'] is None else 'No event list match'
            elif lead['source'] == 'Inbound':
                sub = 'Form: submissions not yet synced' if ctx['submissions'] is None else 'No form match'
        lead['subSource'] = sub
        lead['platform'] = platform
        lead['unconfirmed'] = unconfirmed
        lead['tag'] = tag
        # Conflicts: evidence naming a different source. The Sheet still wins.
        for e in ev:
            if e.get('source') and e['source'] != lead['source']:
                what = e.get('platform') or e.get('detail') or e['source']
                lead['flags'].append({'kind': 'conflict', 'text': '%s says %s (%s); Source says %s' % (e['rule'], e['source'], what, lead['source'])})
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
        confirmed = [l for l in items if l['platform'] == p['name'] or
                     any(e.get('platform') == p['name'] for e in l['evidence'])]
        possible = [l for l in items if l['source'] == 'Paid' and not l['platform'] and p['name'] in (l.get('possiblePlatforms') or [])]
        plat.append({'name': p['name'], 'key': p['key'], 'confirmed': len(confirmed),
                     'confirmedIds': [l['id'] for l in confirmed], 'inPaid': sum(1 for l in confirmed if l['source'] == 'Paid'),
                     'possible': len(possible), 'possibleIds': [l['id'] for l in possible],
                     'atMost': len(confirmed) + len(possible)})
    return {'connected': True, 'sheet': {'title': title, 'tab': tab}, 'total': total, 'mql': mql,
            'sql': sum(1 for l in items if l['sql']), 'rate': (mql / total) if total else None,
            'sources': sources, 'platforms': plat, 'openai': next((x for x in plat if openai and x['key'] == 'openai'), None),
            'conflicts': sum(1 for l in items if l['conflict']), 'items': items,
            'definition': 'A lead is a company on the Lead Tracker with its first lead date (Lead Date, else First Touch). '
                          'MQL counts companies with an MQL or an SQL date. Source is the Sheet\'s Source column; it wins '
                          'when other evidence disagrees, and the disagreement is flagged.'}


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
        cids |= p['companies']
    internal = ctx['internal_domains']
    external = [p for p in people if domain_of(p['email']) not in internal]
    cos = [comps[c] for c in cids if c in comps and comps[c]['domain'] not in internal]
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
        'items': items, 'byCompany': by_company, 'windowStart': iso(window_start),
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
    counts = {'total': 0, 'internal': 0, 'cs': 0, 'customer': 0, 'prospect': 0}
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
        if not ext:
            counts['internal'] += 1
            continue
        if remail in cs_emails:
            counts['cs'] += 1
            continue
        cos = {}
        for i in ext:
            c = contacts.get(ctx['contact_by_email'].get((i.get('email') or '').lower(), {}).get('id'))
            for co in (c['companies'] if c else []):
                if co in comps:
                    cos[co] = comps[co]
            d = domain_of(i.get('email'))
            if d and d not in FREE_MAIL:
                for co in domain_index.get(d, []):
                    cos[co['id']] = co
        if any(customer_at(c, t) for c in cos.values()):
            counts['customer'] += 1
            continue
        counts['prospect'] += 1
        if not t or t < window_start:
            continue
        rec = by_email_owner.get(remail)
        recorder = rec['name'] if rec else scrub.person((rname or '').title())
        deal_cos = [c for c in cos.values() if c['salesDeal']]
        items.append({'id': 'R%s' % rid, 'title': scrub.text(title or '(no title)'), 'start': iso(t), 'recorder': recorder,
                      'matched': bool(deal_cos),
                      'reason': None if deal_cos else ('no Sales Pipeline deal at the company' if cos else 'company not in HubSpot'),
                      'companies': [{'id': c['id'], 'name': c['name'], 'deal': deal_ref(sales_deal_of(c))} for c in list(cos.values())[:4]],
                      'contacts': [{'name': i.get('name'), 'company': None} for i in ext[:8]],
                      'emails': sorted({(i.get('email') or '').lower() for i in ext if i.get('email')}),
                      'summary': clean_summary(summary), 'transcript': rid in with_transcript})
    items.sort(key=lambda x: x['start'] or '')
    return {'items': items, 'scope': counts, 'windowStart': iso(window_start),
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


# ---------- outbound ----------
def outbound(brain, ls, leads_by_email):
    rows = brain.q('SELECT campaign_id, name, status, raw_json FROM lemlist_campaigns')
    perf, other = [], []
    for cid, name, status, raw in rows:
        try:
            r = json.loads(raw or '{}')
        except ValueError:
            r = {}
        s = r.get('stats') if isinstance(r.get('stats'), dict) else {}
        camp = ls.campaign(cid, name) or {}
        kind = camp.get('kind') or 'unmapped'
        replies = num(s.get('replied'))
        invite = sum(num(st.get('replied')) or 0 for st in s.get('steps') or [] if st.get('taskType') == 'linkedinInvite')
        row = {'id': str(cid), 'name': name, 'status': status, 'kind': kind, 'bucket': camp.get('bucket'),
               'sent': num(s.get('messagesSent')), 'delivered': num(s.get('delivered')), 'repliesReported': replies,
               'inviteReplies': invite or 0}
        if leads_by_email is not None:
            leads = [l for ls_ in leads_by_email.values() for l in ls_ if str(l.get('campaign_id')) == str(cid)]
            replied = [l for l in leads if l.get('replied_at')]
            row['replies'] = sum(1 for l in replied if not is_auto_reply(l.get('raw_json')))
            row['autoReplies'] = len(replied) - row['replies']
            row['replyBasis'] = 'leads'
        else:
            row['replies'] = None if replies is None else max(0, replies - (invite or 0))
            row['replyBasis'] = 'campaign'
        row['mostlyInvite'] = bool(replies and invite and invite / replies > 0.5)
        row['rate'] = (row['replies'] / row['delivered']) if row['replies'] is not None and row['delivered'] else None
        (perf if kind == 'outbound' and (row['sent'] or 0) > 0 else other).append(row)
    perf.sort(key=lambda r: -(r['delivered'] or 0))
    sent = sum(r['delivered'] or 0 for r in perf)
    replies = sum(r['replies'] or 0 for r in perf)
    basis = ('Real replies = leads with a reply that is not an auto-reply (Lemlist leads).' if leads_by_email is not None else
             'Real replies = Lemlist\'s reply count minus replies on the LinkedIn connection-invite step, which are mostly '
             'automatic accept messages. Other auto-replies (out-of-office) can\'t be separated until Lemlist leads are '
             'synced (not yet synced).')
    return {'campaigns': perf, 'excluded': [r for r in other if r['kind'] in ('customer', 'excluded', 'other', 'unmapped') or (r['sent'] or 0) == 0],
            'delivered': sent, 'replies': replies, 'rate': (replies / sent) if sent else None, 'basis': basis,
            'leadsSynced': leads_by_email is not None}


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
    brain = Brain(args.db)
    ls_doc = read_json(args.lead_sources, 'lead-sources', warn)
    ls = LeadSources(ls_doc)
    owners, scrub = load_owners(brain)
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
    spend = budget(brain, as_of)
    ga4 = ga4_unassigned(brain)
    lead_insights = load_lead_insights(read_json(args.lead_insights, 'lead-insights', warn) if args.lead_insights else None)
    ctx = {'brain': brain, 'ls': ls, 'owners': owners, 'scrub': scrub, 'assoc': assoc, 'comps': comps, 'contacts': contacts,
           'contact_by_email': contact_by_email, 'cs_ids': cs_ids, 'internal_domains': internal_domains(owners),
           'deal_by_id': {d['id']: d for d in deals}, 'ads': ads,
           'lemlist': lemlist_leads(brain), 'submissions': form_submissions(brain), 'memberships': list_memberships(brain),
           'form_names': {str(i): n for i, n in brain.q('SELECT form_id, name FROM hubspot_forms')} if brain.has('hubspot_forms') else {},
           'campaign_names': {str(i): n for i, n in brain.q('SELECT campaign_id, name FROM lemlist_campaigns')},
           'lead_insights': lead_insights}
    ctx['customer_title'] = customer_title_matcher(comps)
    meetings = build_meetings(brain, ctx, as_of)
    ctx['meetings_by_company'] = meetings.pop('byCompany')
    calls = build_calls(brain, ctx, as_of)
    link_recordings(meetings, calls)
    leads = build_leads(brain, ctx)
    out_bound = outbound(brain, ls, ctx['lemlist'])
    hl = headline(sales, stages)
    lost = [d for d in sales if d['lost']]
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
                'won': d['won'], 'lost': d['lost'], 'lostReason': d['lostReason'],
                'company': next((comp_name[c] for c in d['companyIds'] if c in comp_name), None)}
    lost_doc = read_json(args.lost_reasons, 'lost-reasons', warn) if args.lost_reasons else None
    insights = read_json(args.insights, 'insights', warn) if args.insights else None
    removed_customers = [c for c in comps.values() if is_customer_company(c)]
    out = {
        'meta': {'builtAt': iso(datetime.now(timezone.utc)), 'asOf': iso(as_of), 'tz': 'America/Phoenix', 'tzLabel': 'PT',
                 'hubspotAt': iso(data_at), 'portalId': args.portal_id, 'provisional': provisional_label(ls_doc),
                 'leadSourcesAt': (ls_doc or {}).get('generated_at'),
                 'notSynced': [label for t, label in NEW_SOURCES if not brain.has(t)] + ([] if contact_props else ['HubSpot contact source fields']),
                 'contactSourceFields': contact_props},
        'freshness': fresh,
        'flags': staleness(fresh, ads, spend, ga4, brain, contact_props, as_of),
        'headline': {**hl, 'change': headline_change(sales, priors, data_at, as_of),
                     'definition': OPEN_DEF['definition']},
        'deals': [deal_row(d) for d in pipeline_deals],
        'closed': {'won': totals(won), 'lostByStage': [{'stage': k, **totals(v)} for k, v in sorted(by_stage.items(), key=lambda kv: -len(kv[1]))],
                   'lost': [deal_row(d) for d in lost], 'reasonsDoc': lost_doc,
                   'reasonsNote': 'lost-reasons.json covers new-business Sales Pipeline deals only.'},
        'leads': leads,
        'ads': ads,
        'spend': spend,
        'ga4': ga4,
        'outbound': out_bound,
        'meetings': meetings,
        'calls': calls,
        'insights': insights,
        'leadSources': {'uncertainForms': ls.uncertain_forms, 'eventLists': [{'id': l['id'], 'name': l.get('name'), 'show': l.get('show')} for l in ls.counted_event_lists],
                        'excludedLists': [{'id': l['id'], 'name': l.get('name'), 'why': l['excludedBecause'] or l.get('kind')}
                                          for l in ls.lists.values() if not l['counts']],
                        'customerCampaigns': [c['name'] for c in ls.campaigns.values() if c['kind'] == 'customer'],
                        'loaded': ls_doc is not None},
        'scope': {'salesPipeline': SCOPE['salesPipelineId'], 'droppedPipelines': list(SCOPE['excludedPipelines'].values()),
                  'customerCompanies': len(removed_customers),
                  'currentPage': current_page_scope(args.current_page) if args.current_page else None},
    }
    out = scrub.deep(out)
    blob = json.dumps(out, ensure_ascii=False)
    if SCOPE['hiddenOwner']['pattern'] in blob.lower():
        raise SystemExit('scrub failed: the hidden owner still appears in the output')
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
        lines.append('leads: %d, MQL incl SQL %d (%.1f%%), conflicts %d' % (l['total'], l['mql'], 100 * (l['rate'] or 0), l['conflicts']))
        if l.get('openai'):
            lines.append('OpenAI leads: %d confirmed, at most %d' % (l['openai']['confirmed'], l['openai']['atMost']))
    lines.append('meetings: this month %d matched (+%d unmatched, +%d no contact), upcoming %d matched (+%d unmatched, +%d no contact)' % (
        m['thisMonth']['matched'], m['thisMonth']['unmatched'], m['thisMonth']['noContact'],
        m['upcoming']['matched'], m['upcoming']['unmatched'], m['upcoming']['noContact']))
    cp = d['scope'].get('currentPage')
    if cp:
        lines.append('current page: removes %d customer companies, %d meetings, %d of %d recordings' % (
            cp['companies'], cp['meetings'], cp['recordings'], cp['recordingsTotal']))
    return lines


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--db', required=True)
    ap.add_argument('--lead-sources')
    ap.add_argument('--lost-reasons')
    ap.add_argument('--insights')
    ap.add_argument('--lead-insights')
    ap.add_argument('--prior', action='append', help='earlier HubSpot deals export (live_deals.json shape); repeatable')
    ap.add_argument('--current-page', help='the current page data.json, to report what the redesign removes')
    ap.add_argument('--portal-id', help='HubSpot portal id, for record links')
    ap.add_argument('--as-of', help='ISO time the page is "as of" (default now)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args(argv)
    data = build(args)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    if not args.quiet:
        print('wrote %s' % args.out)
        for line in audit_lines(data):
            print('  ' + line)


if __name__ == '__main__':
    main()
