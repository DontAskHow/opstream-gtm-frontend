#!/usr/bin/env python3
"""Build the GTM dashboard's out/data/*.json from the real company brain.

Reads ~/workspace/brain/brain.db (HubSpot objects + associations, Fathom
meetings/transcripts, findings, lemlist campaigns, sheets, GA4) and writes
the JSON files next to this script, under out/data. build.cjs runs this script,
and the agent server reads those files. The database itself is filled by the
separate sheets sync; this script does not talk to HubSpot, Sheets, or Fathom.

Honesty rules: never invent names, dates, or stage labels. Where the brain
lacks something (stage catalog, days-in-stage, MQL/SQL dates, an owner
name), use null or empty. When an owner id has no name, store "Owner {id}".
The workspace shows "Owner #…1234" (last four digits) and does not show the
full id. Never invent a person name, and never prefix a real name with "Owner".
"""
import sqlite3, json, os, re, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gtm_metrics import date_only, is_open_pipeline, phoenix_today, probability_fraction, stage_display

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.expanduser('~/workspace/brain/brain.db')
OUT = os.path.join(ROOT, 'out', 'data')
# Upcoming versus past meetings follow the Phoenix calendar on the day this
# file is generated, not a date frozen into the script.
TODAY = phoenix_today()
SNAPSHOT = 'brain-' + TODAY
NOW_ISO = datetime.now(timezone.utc).isoformat()

CLOSED_STAGES = {'closedwon', 'closedlost'}
NAMED_STAGES = {
    'closedwon': 'Closed won',
    'closedlost': 'Closed lost',
    'decisionmakerboughtin': 'Decision maker bought in',
    'contractsent': 'Contract sent',
}

def q(cur, sql, args=()):
    return list(cur.execute(sql, args))

def props_of(row):
    try:
        return json.loads(row[0]) if row and row[0] else {}
    except Exception:
        return {}

def iso_date(s):
    if not s:
        return None
    return str(s)[:10]

OWNER_NAMES = {}


def load_owner_names(cur):
    """Real names from an owners catalog, when the brain has one. Never invent one."""
    names = {}
    tables = {r[0] for r in q(cur, "SELECT name FROM sqlite_master WHERE type='table'")}

    def remember(oid, first, last, email):
        label = ' '.join(x for x in [first, last] if x).strip() or (email or '').strip()
        if oid and label and '@' not in label.split(' ')[0]:
            names[str(oid)] = label
        elif oid and label:
            names[str(oid)] = label

    if 'hubspot_owners' in tables:
        cols = {r[1] for r in q(cur, 'PRAGMA table_info(hubspot_owners)')}
        id_col = 'id' if 'id' in cols else 'hs_id' if 'hs_id' in cols else None
        if id_col:
            first = 'first_name' if 'first_name' in cols else 'firstname' if 'firstname' in cols else None
            last = 'last_name' if 'last_name' in cols else 'lastname' if 'lastname' in cols else None
            email = 'email' if 'email' in cols else None
            select = ', '.join(c for c in [id_col, first, last, email] if c)
            for row in q(cur, 'SELECT %s FROM hubspot_owners' % select):
                values = list(row) + [None, None, None]
                remember(values[0], values[1] if first else None, values[2] if last else None, values[3] if email else None)
    if 'hubspot_objects' in tables:
        for hs_id, pj in q(cur, "SELECT hs_id, properties_json FROM hubspot_objects WHERE object_type='owners'"):
            p = props_of((pj,))
            remember(hs_id, p.get('firstName') or p.get('first_name'), p.get('lastName') or p.get('last_name'), p.get('email'))
    return names


def owner_label(hubspot_owner_id):
    if not hubspot_owner_id:
        return 'Unassigned'
    name = OWNER_NAMES.get(str(hubspot_owner_id))
    if name:
        return name
    # Keep the id so the workspace can show a distinguishable "Owner #…1234".
    return 'Owner ' + str(hubspot_owner_id)


def clean_company_name(name):
    """Drop a dangling comma or semicolon. Keep 'Inc.' and similar endings."""
    return re.sub(r'[,;]+$', '', (name or '').strip()).strip()


_ANALYTICS_SOURCE = {
    'ORGANIC_SEARCH': 'Organic search',
    'PAID_SEARCH': 'Paid search',
    'EMAIL_MARKETING': 'Email',
    'SOCIAL_MEDIA': 'Social',
    'REFERRALS': 'Referral',
    'OTHER_CAMPAIGNS': 'Other campaigns',
    'DIRECT_TRAFFIC': 'Direct',
    'OFFLINE': 'Offline',
    'PAID_SOCIAL': 'Paid social',
    'AI_REFERRALS': 'AI referral',
}


def lead_channel(props):
    """Contact channel. Never the system name HubSpot — that collapsed every lead into one row."""
    for key in ('hs_analytics_source', 'hs_latest_source', 'leadsource'):
        raw = str((props or {}).get(key) or '').strip()
        if not raw or raw.lower() in ('hubspot', 'crm', 'integration', 'unknown'):
            continue
        return _ANALYTICS_SOURCE.get(raw, raw.replace('_', ' ').title())
    return 'Unknown source'

def num(v):
    if v is None or v == '':
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None

def clean_domain(d):
    if not d:
        return None
    d = str(d).strip().lower()
    d = re.sub(r'^https?://', '', d).split('/')[0]
    d = re.sub(r'^www\.', '', d)
    return d or None

def main():
    os.makedirs(os.path.join(OUT, 'transcripts'), exist_ok=True)
    # Remove stale synthetic transcripts (the agent server globs this dir).
    for f in os.listdir(os.path.join(OUT, 'transcripts')):
        if f.endswith('.json'):
            os.remove(os.path.join(OUT, 'transcripts', f))

    con = sqlite3.connect(DB)
    cur = con.cursor()
    global OWNER_NAMES
    OWNER_NAMES = load_owner_names(cur)

    # ---------- load all deals, find open ones ----------
    deal_rows = q(cur, "select hs_id, properties_json, fetched_at from hubspot_objects where object_type='deals'")
    deals = {}
    for hs_id, pj, fetched in deal_rows:
        p = props_of((pj,))
        deals[str(hs_id)] = (p, fetched)
    open_deal_ids = [i for i, (p, _) in deals.items() if (p.get('dealstage') or '') not in CLOSED_STAGES]
    print(f'deals: {len(deals)} total, {len(open_deal_ids)} open', flush=True)

    # ---------- scope companies via associations (both directions) ----------
    def linked(ids, a_type, b_type):
        out = set()
        if not ids:
            return out
        ch = 400
        ids = list(ids)
        for i in range(0, len(ids), ch):
            batch = ids[i:i+ch]
            ph = ','.join('?' * len(batch))
            for r in q(cur, f"select to_id from hubspot_associations where from_type=? and to_type=? and from_id in ({ph})", [a_type, b_type] + batch):
                out.add(str(r[0]))
            for r in q(cur, f"select from_id from hubspot_associations where from_type=? and to_type=? and to_id in ({ph})", [b_type, a_type] + batch):
                out.add(str(r[0]))
        return out

    scoped_company_ids = linked(open_deal_ids, 'deals', 'companies')
    print(f'scoped companies: {len(scoped_company_ids)}', flush=True)
    all_deal_ids = linked(scoped_company_ids, 'companies', 'deals')
    # keep deals not associated to any company out; add open deals back defensively
    all_deal_ids |= set(open_deal_ids)

    # ---------- per-company / per-deal association maps ----------
    scope_ids = list(scoped_company_ids | all_deal_ids)
    comp_links = {cid: {} for cid in scoped_company_ids}   # cid -> {otype: [ids]}
    deal_company = {}  # deal_id -> company_id (first found)
    ch = 400
    for i in range(0, len(scope_ids), ch):
        batch = scope_ids[i:i+ch]
        ph = ','.join('?' * len(batch))
        rows = q(cur, f"""select from_type, from_id, to_type, to_id from hubspot_associations
                          where (from_id in ({ph}) or to_id in ({ph}))""", batch + batch)
        for ft, fi, tt, ti in rows:
            fi, ti = str(fi), str(ti)
            if ft == 'companies' and fi in comp_links:
                comp_links[fi].setdefault(tt, []).append(ti)
            elif tt == 'companies' and ti in comp_links:
                comp_links[ti].setdefault(ft, []).append(fi)
            if ft == 'deals' and tt == 'companies' and ti in comp_links and fi in all_deal_ids:
                deal_company.setdefault(fi, ti)
            elif ft == 'companies' and tt == 'deals' and fi in comp_links and ti in all_deal_ids:
                deal_company.setdefault(ti, fi)

    # ---------- collect object ids to load ----------
    need = {}
    def want(otype, oid):
        need.setdefault(otype, set()).add(str(oid))
    for cid in scoped_company_ids:
        want('companies', cid)
        for otype, oids in comp_links[cid].items():
            if otype in ('contacts', 'notes', 'tasks', 'calls', 'meetings', 'emails', 'deals', 'companies'):
                for oid in oids:
                    want(otype, oid)
    for did in all_deal_ids:
        want('deals', did)

    objects = {}
    for otype, oids in need.items():
        oids = list(oids)
        objs = {}
        for i in range(0, len(oids), ch):
            batch = oids[i:i+ch]
            ph = ','.join('?' * len(batch))
            for hs_id, pj, fetched in q(cur, f"select hs_id, properties_json, fetched_at from hubspot_objects where object_type=? and hs_id in ({ph})", [otype] + batch):
                objs[str(hs_id)] = (props_of((pj,)), fetched)
        objects[otype] = objs
        print(f'loaded {otype}: {len(objs)}', flush=True)

    # ---------- sheet: deal stage labels + days in stage ----------
    sheet_stage, sheet_days = {}, {}
    for rn, rj in q(cur, "select row_num, row_json from sheets_data where spreadsheet_title='pipeline_meeting1_v2' and tab='HS_Data' order by row_num"):
        try:
            row = json.loads(rj)
        except Exception:
            continue
        if rn == 1 or not row or not isinstance(row, list):
            continue
        try:
            did = str(int(row[0])) if row[0] not in (None, '') else None
        except (ValueError, TypeError):
            did = None
        if not did:
            continue
        label = str(row[4]).strip() if len(row) > 4 and row[4] else None
        if label:
            sheet_stage[did] = label
        d = num(row[15]) if len(row) > 15 else None
        if d is not None:
            sheet_days[did] = int(d)
    print(f'sheet stage labels: {len(sheet_stage)}, days: {len(sheet_days)}', flush=True)

    def contact_display_name(op):
        """Reconcile a display name from firstname/lastname, falling back to
        a readable derivation from the email local part."""
        nm = ' '.join(x for x in [op.get('firstname'), op.get('lastname')] if x).strip()
        if nm:
            return nm
        em = (op.get('email') or '').strip()
        if em and '@' in em:
            local = em.split('@')[0]
            parts = [p for p in local.replace('.', ' ').replace('_', ' ').replace('-', ' ').split() if p]
            # Skip obvious non-names (info, support, noreply, etc.)
            if parts and parts[0].lower() not in ('info', 'support', 'noreply', 'no-reply', 'hello', 'contact', 'admin'):
                return ' '.join(p.capitalize() for p in parts)
            return em
        return 'Unknown'

    def stage_label(deal_id, raw):
        if deal_id in sheet_stage:
            return sheet_stage[deal_id]
        if raw in NAMED_STAGES:
            return NAMED_STAGES[raw]
        if raw in CLOSED_STAGES:
            return raw
        # Never show a raw HubSpot stage ID — it's meaningless to a human.
        # Return None so callers use describe_deal() instead.
        return None

    def describe_deal(deal_name, stage_label_val, amount, close):
        """Human-readable deal line reconciled from all available fields.
        Uses the stage label when known; otherwise infers the deal type from
        the deal's own name and always includes real amount/close data."""
        parts = []
        if stage_label_val:
            parts.append(stage_label_val)
        else:
            # Infer type from the deal name — reading, not inventing.
            nm = (deal_name or "").lower()
            if "renewal" in nm:
                parts.append("Renewal")
            elif "current agreement" in nm:
                parts.append("Current agreement")
            elif "expansion" in nm or "additional" in nm or "upsell" in nm:
                parts.append("Expansion")
            elif "pilot" in nm or "trial" in nm or "poc" in nm:
                parts.append("Pilot")
            elif "new deal" in nm or "new business" in nm:
                parts.append("New business")
        if amount:
            try:
                parts.append("$%s" % f"{int(float(amount)):,}")
            except (ValueError, TypeError):
                pass
        if close:
            parts.append("closes %s" % str(close)[:10])
        return " · ".join(parts) if parts else (deal_name or "Untitled deal")

    # ---------- evidence store ----------
    evidence = {}
    def add_evidence(ref, native_id, source, captured_at, title, content, fields):
        evidence[ref] = {'ref': ref, 'nativeId': native_id, 'source': source,
                         'capturedAt': captured_at, 'title': title,
                         'content': content, 'fields': fields}
        return ref

    # ---------- build companies ----------
    companies = []
    n_contacts = n_notes = 0
    def company_display_name(p, cid, links):
        """Reconcile a human company name. HubSpot sometimes stores a bare
        domain as the company name; when that happens, try the meeting and
        recording titles linked to the company (e.g. 'Allied World - Demo'
        reveals the real name behind 'awacservices.com')."""
        raw = clean_company_name(p.get('name'))
        if raw and not re.match(r'^[a-z0-9.-]+\.[a-z]{2,}$', raw, re.I):
            return raw
        # Name is a bare domain (or missing) — look at linked titles.
        candidates = []
        for oid in links.get('meetings', []):
            op, _ = objects['meetings'].get(oid, (None, None))
            t = op.get('hs_meeting_title') if op else None
            if t:
                candidates.append(t)
        for rid in links.get('recordings', []):
            # recordings are keyed separately; skip — meetings cover it
            pass
        for t in candidates:
            # Only trust "Company - Description" format titles; the head before
            # the separator is the company name. Skip generic titles.
            parts = re.split(r'\s[-–—|:/]\s', t, maxsplit=1)
            if len(parts) < 2:
                continue
            head = parts[0].strip()
            if head and len(head) > 2 and not re.match(r'^[a-z0-9.-]+\.[a-z]{2,}$', head, re.I) \
               and head.lower() not in ('sync', 'stand-up', 'standup', 'weekly', 'check-in', 'checkin', 'intro', 'demo', 'call', 'meeting'):
                return clean_company_name(head)
        return raw or ('Company ' + cid)

    for cid in sorted(scoped_company_ids):
        p, fetched = objects['companies'].get(cid, ({}, None))
        links = comp_links[cid]
        cname = company_display_name(p, cid, links)
        domain = clean_domain(p.get('domain'))
        owner = owner_label(p.get('hubspot_owner_id'))
        cref = f'hubspot:companies:{cid}'
        add_evidence(cref, cid, 'HubSpot', fetched, f'HubSpot company {cid}',
                     f"{cname} — {p.get('domain') or 'no domain'} · "
                     f"{', '.join(x for x in [p.get('city'), p.get('country')] if x) or 'location not recorded'} · "
                     f"lifecycle {p.get('lifecyclestage') or 'not set'}",
                     {'domain': p.get('domain'), 'industry': p.get('industry'),
                      'city': p.get('city'), 'country': p.get('country'),
                      'lifecycle': p.get('lifecyclestage'),
                      'employees': p.get('numberofemployees'), 'owner': owner})
        refs = [cref]

        # deals (all, open + closed)
        deal_objs = []
        for did in sorted(set(links.get('deals', [])) | {d for d, c in deal_company.items() if c == cid}):
            dp, dfetched = objects['deals'].get(did, (None, None))
            if dp is None:
                continue
            raw_stage = dp.get('dealstage')
            dlabel = stage_label(did, raw_stage)
            prob = probability_fraction(num(dp.get('hs_deal_stage_probability')))
            close_day = date_only(dp.get('closedate'))
            dref = f'hubspot:deals:{did}'
            add_evidence(dref, did, 'HubSpot', dfetched, f'HubSpot deal {did}',
                         f"{dp.get('dealname') or 'Untitled deal'} — stage {dlabel or 'not labeled'}, "
                         f"amount {dp.get('amount') or 'not entered'}, close {close_day or 'not set'}",
                         {'dealname': dp.get('dealname'), 'stage': dlabel,
                          'amount': dp.get('amount'),
                          'probability': None if prob is None else round(prob * 100, 1),
                          'close': close_day, 'owner': owner_label(dp.get('hubspot_owner_id'))})
            deal_objs.append({
                'id': 'deal-' + did, 'name': dp.get('dealname') or 'Untitled deal',
                'stage': raw_stage, 'stageLabel': dlabel,
                'displayLine': describe_deal(dp.get('dealname'), dlabel, num(dp.get('amount')), close_day),
                'amount': num(dp.get('amount')), 'currency': 'USD',
                'probability': None if prob is None else round(prob * 100, 1),
                'close': close_day, 'created': date_only(dp.get('createdate')),
                'owner': owner_label(dp.get('hubspot_owner_id')),
                'closed': (raw_stage or '') in CLOSED_STAGES,
                'history': [], 'amountHistory': [], 'closeHistory': [], 'refs': [dref]})
        deal_objs.sort(key=lambda d: (d['closed'], d['created'] or ''))

        # contacts
        contact_objs = []
        for oid in links.get('contacts', []):
            op, ofetched = objects['contacts'].get(oid, (None, None))
            if op is None:
                continue
            nm = contact_display_name(op)
            oref = f'hubspot:contacts:{oid}'
            add_evidence(oref, oid, 'HubSpot', ofetched, f'HubSpot contact {oid}',
                         f"{nm} <{op.get('email') or 'no email'}> — {op.get('jobtitle') or 'title not recorded'} · lifecycle {op.get('lifecyclestage') or 'not set'}",
                         {'email': op.get('email'), 'title': op.get('jobtitle'),
                          'lifecyclestage': op.get('lifecyclestage')})
            contact_objs.append({'name': nm, 'email': op.get('email'),
                                 'title': op.get('jobtitle'), 'refs': [oref]})
        n_contacts += len(contact_objs)

        # notes
        note_objs = []
        for oid in links.get('notes', []):
            op, ofetched = objects['notes'].get(oid, (None, None))
            if op is None:
                continue
            body = op.get('hs_note_body') or ''
            nref = f'hubspot:notes:{oid}'
            add_evidence(nref, oid, 'HubSpot', ofetched, f'HubSpot note {oid}',
                         (body[:200] + '…') if len(body) > 200 else (body or '(empty note body)'),
                         {'date': op.get('hs_timestamp')})
            note_objs.append({'id': 'note-' + oid, 'date': iso_date(op.get('hs_timestamp')),
                              'text': body, 'owner': owner_label(op.get('hubspot_owner_id')),
                              'refs': [nref]})
        n_notes += len(note_objs)
        note_objs.sort(key=lambda n: n['date'] or '', reverse=True)

        # tasks
        task_objs = []
        for oid in links.get('tasks', []):
            op, ofetched = objects['tasks'].get(oid, (None, None))
            if op is None:
                continue
            tref = f'hubspot:tasks:{oid}'
            add_evidence(tref, oid, 'HubSpot', ofetched, f'HubSpot task {oid}',
                         f"{op.get('hs_task_subject') or 'Untitled task'} — status {op.get('hs_task_status') or 'not set'}",
                         {'status': op.get('hs_task_status'), 'date': op.get('hs_timestamp')})
            task_objs.append({'id': 'task-' + oid, 'subject': op.get('hs_task_subject'),
                              'status': op.get('hs_task_status'), 'date': iso_date(op.get('hs_timestamp')),
                              'owner': owner_label(op.get('hubspot_owner_id')), 'refs': [tref]})
        task_objs.sort(key=lambda t: t['date'] or '', reverse=True)

        # calls
        call_objs = []
        for oid in links.get('calls', []):
            op, ofetched = objects['calls'].get(oid, (None, None))
            if op is None:
                continue
            dur = num(op.get('hs_call_duration'))
            clref = f'hubspot:calls:{oid}'
            add_evidence(clref, oid, 'HubSpot', ofetched, f'HubSpot call {oid}',
                         f"{op.get('hs_call_title') or 'Call'} — {iso_date(op.get('hs_timestamp')) or 'date not recorded'}"
                         + (f" · {int(dur/60000)} min" if dur else ''),
                         {'date': op.get('hs_timestamp'),
                          'durationMin': int(dur/60000) if dur else None})
            call_objs.append({'id': 'call-' + oid, 'title': op.get('hs_call_title'),
                              'date': iso_date(op.get('hs_timestamp')),
                              'minutes': int(dur/60000) if dur else None,
                              'owner': owner_label(op.get('hubspot_owner_id')), 'refs': [clref]})
        call_objs.sort(key=lambda x: x['date'] or '', reverse=True)

        # hubspot meetings
        mtg_objs = []
        for oid in links.get('meetings', []):
            op, ofetched = objects['meetings'].get(oid, (None, None))
            if op is None:
                continue
            mref = f'hubspot:meetings:{oid}'
            add_evidence(mref, oid, 'HubSpot', ofetched, f'HubSpot meeting {oid}',
                         f"{op.get('hs_meeting_title') or 'Meeting'} — "
                         f"{iso_date(op.get('hs_meeting_start_time')) or 'date not recorded'} · outcome {op.get('hs_meeting_outcome') or 'not recorded'}",
                         {'start': op.get('hs_meeting_start_time'),
                          'outcome': op.get('hs_meeting_outcome')})
            mtg_objs.append({'id': 'meeting-' + oid, 'title': op.get('hs_meeting_title'),
                             'start': op.get('hs_meeting_start_time'),
                             'outcome': op.get('hs_meeting_outcome'), 'refs': [mref]})
        mtg_objs.sort(key=lambda m: m['start'] or '', reverse=True)

        # emails (cap 20, newest first)
        email_rows = []
        for oid in links.get('emails', []):
            op, ofetched = objects['emails'].get(oid, (None, None))
            if op is None:
                continue
            email_rows.append((oid, op, ofetched))
        email_rows.sort(key=lambda e: e[1].get('hs_createdate') or '', reverse=True)
        email_items = []
        for oid, op, ofetched in email_rows[:20]:
            eref = f'hubspot:emails:{oid}'
            add_evidence(eref, oid, 'HubSpot', ofetched, f'HubSpot email {oid}',
                         f"Subject: {op.get('hs_email_subject') or '(no subject)'} — from {op.get('hs_email_from_email') or 'unknown'} · {iso_date(op.get('hs_createdate')) or 'date not recorded'}",
                         {'subject': op.get('hs_email_subject'),
                          'from': op.get('hs_email_from_email'),
                          'date': op.get('hs_createdate'),
                          'direction': op.get('hs_email_direction')})
            email_items.append({'id': 'email-' + oid, 'subject': op.get('hs_email_subject'),
                                'date': iso_date(op.get('hs_createdate')),
                                'from': op.get('hs_email_from_email'), 'refs': [eref]})

        # completed interactions + last contact
        interactions = []
        for m in mtg_objs:
            if m['start']:
                interactions.append((m['start'][:10], 'HubSpot meeting', m['refs']))
        for cl in call_objs:
            if cl['date']:
                interactions.append((cl['date'], 'HubSpot call', cl['refs']))
        for n in note_objs:
            if n['date']:
                interactions.append((n['date'], 'HubSpot note', n['refs']))
        for e in email_items:
            if e['date']:
                interactions.append((e['date'], 'HubSpot email', e['refs']))
        interactions.sort(key=lambda x: x[0], reverse=True)
        completed = [{'date': d, 'source': s, 'refs': r} for d, s, r in interactions[:5]]
        last_contact = interactions[0][0] if interactions else None

        companies.append({
            'id': cid, 'name': cname, 'owner': owner, 'domain': p.get('domain'),
            'industry': p.get('industry'), 'description': p.get('description') or '',
            'employees': num(p.get('numberofemployees')),
            'city': p.get('city'), 'country': p.get('country'),
            'lifecycle': p.get('lifecyclestage'), 'created': p.get('createdate'),
            'deals': deal_objs, 'contacts': contact_objs, 'notes': note_objs,
            'meetings': mtg_objs, 'tasks': task_objs, 'calls': call_objs,
            'emails': {'count': len(email_rows), 'items': email_items},
            'recordings': [], 'related': [], 'refs': refs,
            'completedInteractions': completed, 'lastContact': last_contact,
            '_domain': domain,
        })
    companies.sort(key=lambda c: c['name'].lower())
    print(f'companies built: {len(companies)}', flush=True)

    # ---------- Fathom recordings ----------
    fathom = q(cur, """select recording_id, title, meeting_type, created_at, scheduled_start_time,
                              scheduled_end_time, recording_start_time, recording_end_time,
                              recorded_by_name, recorded_by_email, invitees_json, summary_markdown,
                              action_items_json, fetched_at from meetings order by recording_start_time""")
    transcripts = {str(r[0]): r[1] for r in q(cur, 'select recording_id, turns_json from transcripts')}
    domain_to_cid = {}
    for c in companies:
        if c['_domain']:
            domain_to_cid.setdefault(c['_domain'], c['id'])
    by_id = {c['id']: c for c in companies}

    def clean_name(n):
        n = (n or '').lower()
        n = re.sub(r'\b(inc|llc|ltd|co|corp|corporation|company|group|technologies|technology|systems)\b\.?', '', n)
        return re.sub(r'[^a-z0-9]+', ' ', n).strip()

    unmatched = []
    n_transcripts = 0
    for (rid, title, mtype, created_at, sched_start, sched_end, rec_start, rec_end,
         rec_by_name, rec_by_email, invitees_json, summary_md, actions_json, fetched) in fathom:
        rid_s = str(rid)
        try:
            invitees = json.loads(invitees_json) if invitees_json else []
        except Exception:
            invitees = []
        # match by external invitee domain, else fuzzy name
        matched_cid = None
        for inv in invitees:
            if isinstance(inv, dict) and inv.get('is_external') and inv.get('email_domain'):
                d = clean_domain(inv['email_domain'])
                if d and d in domain_to_cid:
                    matched_cid = domain_to_cid[d]
                    break
        if not matched_cid:
            t = clean_name(title)
            for c in companies:
                cn = clean_name(c['name'])
                if len(cn) >= 4 and (cn in t or t in cn):
                    matched_cid = c['id']
                    break
        mins = None
        try:
            if rec_start and rec_end:
                mins = int((datetime.fromisoformat(rec_end.replace('Z', '+00:00')) -
                            datetime.fromisoformat(rec_start.replace('Z', '+00:00'))).total_seconds() // 60)
        except Exception:
            pass
        try:
            actions = [a.get('description') for a in json.loads(actions_json or '[]') if isinstance(a, dict) and a.get('description')]
        except Exception:
            actions = []
        summary_blocks = []
        for para in (summary_md or '').split('\n\n'):
            para = para.strip()
            if not para:
                continue
            for line in para.split('\n'):
                line = line.strip()
                if not line:
                    continue
                if line.startswith('### '):
                    summary_blocks.append({'t': 'h3', 'x': line[4:].strip()})
                elif line.startswith('## '):
                    summary_blocks.append({'t': 'h2', 'x': line[3:].strip()})
                elif line.startswith('- '):
                    summary_blocks.append({'t': 'li', 'x': line[2:].strip()})
                else:
                    summary_blocks.append({'t': 'p', 'x': line})
            if len(summary_blocks) >= 8:
                break
        summary_blocks = summary_blocks[:8]
        turns_raw = transcripts.get(rid_s)
        has_transcript = bool(turns_raw)
        n_turns = 0
        if has_transcript:
            try:
                turns = json.loads(turns_raw)
            except Exception:
                turns = []
            n_turns = len(turns)
            out_turns = []
            for t in turns[:400]:
                sp = t.get('speaker') or {}
                out_turns.append({'speaker': sp.get('display_name') or 'Unknown',
                                  'timestamp': t.get('timestamp') or '',
                                  'text': t.get('text') or ''})
            with open(os.path.join(OUT, 'transcripts', f'recording-{rid_s}.json'), 'w') as f:
                json.dump(out_turns, f)
            n_transcripts += 1
        fref = f'fathom:{rid_s}'
        add_evidence(fref, rid_s, 'Fathom', fetched, f'Fathom recording {rid_s}',
                     (summary_md or '')[:800] or (title or 'Recording'),
                     {'title': title, 'date': rec_start, 'minutes': mins,
                      'recordedBy': rec_by_name})
        rec = {'id': f'recording-{rid_s}', 'nativeId': rid_s, 'title': title,
               'date': rec_start, 'minutes': mins,
               'recordedBy': rec_by_name or rec_by_email,
               'invitees': [{'name': (i.get('name') if isinstance(i, dict) else None),
                             'email': (i.get('email') if isinstance(i, dict) else None)}
                            for i in invitees if isinstance(i, dict)],
               'summary': summary_blocks, 'actions': actions,
               'hasTranscript': has_transcript, 'transcriptLines': n_turns,
               'refs': [fref]}
        if matched_cid and matched_cid in by_id:
            by_id[matched_cid]['recordings'].append(rec)
            by_id[matched_cid]['refs'].append(fref)
        else:
            unmatched.append(rec)
    print(f'recordings: {len(fathom)}, matched: {len(fathom)-len(unmatched)}, transcripts written: {n_transcripts}', flush=True)

    # ---------- evidence backfill: open deals with no company association ----------
    for did in open_deal_ids:
        dref = f'hubspot:deals:{did}'
        if dref in evidence:
            continue
        dp, dfetched = deals.get(did, ({}, None))
        raw_stage = dp.get('dealstage')
        dlabel = stage_label(did, raw_stage)
        prob = num(dp.get('hs_deal_stage_probability'))
        add_evidence(dref, did, 'HubSpot', dfetched, f'HubSpot deal {did}',
                     f"{dp.get('dealname') or 'Untitled deal'} — stage {dlabel}, "
                     f"amount {dp.get('amount') or 'not entered'}, close {iso_date(dp.get('closedate')) or 'not set'} "
                     f"(no company association in the extract)",
                     {'dealname': dp.get('dealname'), 'stage': dlabel,
                      'amount': dp.get('amount'),
                      'probability': int(prob) if prob is not None else None,
                      'close': iso_date(dp.get('closedate')),
                      'owner': owner_label(dp.get('hubspot_owner_id'))})

    # ---------- findings ----------
    finding_rows = q(cur, 'select id, kind, claim, confidence, evidence_refs, status, created_at from findings')
    for fid, kind, claim, conf, erefs, status, created in finding_rows:
        fref = f'finding:{fid}'
        add_evidence(fref, str(fid), 'Findings', created, f'Finding {fid}',
                     (claim or '')[:800], {'kind': kind, 'confidence': conf, 'status': status})
        cl = (claim or '').lower()
        for c in companies:
            if c['_domain'] and c['_domain'] in cl and fref not in c['refs']:
                c['refs'].append(fref)
    print(f'findings: {len(finding_rows)}', flush=True)

    for c in companies:
        del c['_domain']

    # ---------- opportunities (one per OPEN deal) ----------
    opportunities = []
    for did in sorted(open_deal_ids):
        dp, _ = deals.get(did, ({}, None))
        cid = deal_company.get(did)
        cname = None
        if cid:
            cp, _ = objects['companies'].get(cid, ({}, None))
            cname = cp.get('name')
        if not cname:
            cname = (dp.get('dealname') or 'Untitled deal')
        cname = clean_company_name(cname)
        prob = probability_fraction(num(dp.get('hs_deal_stage_probability')))
        label = stage_label(did, dp.get('dealstage'))
        candidate = {
            'id': 'deal-' + did,
            'companyId': 'company:' + cid if cid else 'company:unknown',
            'name': cname,
            'dealName': dp.get('dealname') or '',
            'owner': owner_label(dp.get('hubspot_owner_id')),
            'stage': label,
            'amount': num(dp.get('amount')),
            'probability': prob,
            'close': date_only(dp.get('closedate')),
            'days': sheet_days.get(did),
            'note': '',
            'refs': [f'hubspot:deals:{did}'],
            'closed': False,
        }
        if is_open_pipeline(candidate, phoenix_today()):
            candidate['stage'] = stage_display(label)
            opportunities.append(candidate)
    print(f'opportunities: {len(opportunities)}', flush=True)

    # ---------- leads ----------
    LEAD_STAGES = {'lead', 'subscriber', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity'}
    lead_rows = q(cur, """select hs_id, properties_json from hubspot_objects where object_type='contacts'
                          and json_extract(properties_json, '$.lifecyclestage') in ('lead','subscriber','marketingqualifiedlead','salesqualifiedlead','opportunity')""")
    lead_list = []
    mql_total = sql_total = 0
    for hs_id, pj in lead_rows:
        p = props_of((pj,))
        st = p.get('lifecyclestage')
        if st == 'marketingqualifiedlead':
            mql_total += 1
        if st == 'salesqualifiedlead':
            sql_total += 1
        nm = ' '.join(x for x in [p.get('firstname'), p.get('lastname')] if x).strip() or p.get('email') or 'Unknown'
        lead_list.append({'id': 'lead-' + str(hs_id), 'name': nm, 'source': lead_channel(p),
                          'owner': owner_label(p.get('hubspot_owner_id')),
                          'lead': iso_date(p.get('createdate')),
                          '_created': p.get('createdate') or '',
                          'mql': None, 'sql': None, 'note': st})
    lead_list.sort(key=lambda l: l['_created'], reverse=True)
    leads = []
    for l in lead_list[:500]:
        l = dict(l)
        del l['_created']
        leads.append(l)
    print(f'leads: {len(lead_list)} total ({len(leads)} in file), mql={mql_total}, sql={sql_total}', flush=True)

    # ---------- upcoming meetings ----------
    mtg_all = q(cur, """select hs_id, properties_json from hubspot_objects where object_type='meetings'
                        and json_extract(properties_json, '$.hs_meeting_start_time') is not null""")
    mtg_company = {}
    for r in q(cur, """select from_id, to_id from hubspot_associations
                       where ((from_type='meetings' and to_type='companies') or (from_type='companies' and to_type='meetings'))"""):
        a, b = str(r[0]), str(r[1])
        mtg_company.setdefault(a, b)
        mtg_company.setdefault(b, a)
    upcoming_cands = []
    for hs_id, pj in mtg_all:
        p = props_of((pj,))
        start = p.get('hs_meeting_start_time') or ''
        cid = mtg_company.get(str(hs_id))
        if cid not in scoped_company_ids:
            continue
        upcoming_cands.append((start, {'date': iso_date(start),
                                       'title': p.get('hs_meeting_title') or 'Meeting',
                                       'prep': '',
                                       'target': {'kind': 'account', 'id': 'company:' + cid}}))
    future = sorted([u for u in upcoming_cands if u[0] >= TODAY], key=lambda x: x[0])
    past = sorted([u for u in upcoming_cands if u[0] < TODAY], key=lambda x: x[0], reverse=True)
    upcoming = [u[1] for u in (future + past)[:8]]
    print(f'upcoming: {len(upcoming)}', flush=True)

    # ---------- report ----------
    weighted = 0.0
    stages = {}
    for opp in opportunities:
        amt = opp.get('amount') or 0
        frac = opp.get('probability')
        if frac is not None:
            weighted += amt * frac
        sl = opp.get('stage') or 'No stage'
        s = stages.setdefault(sl, {'stage': sl, 'count': 0, 'amount': 0})
        s['count'] += 1
        s['amount'] += amt
    mtg_outcomes = {}
    starts = []
    for hs_id, pj in q(cur, "select hs_id, properties_json from hubspot_objects where object_type='meetings'"):
        p = props_of((pj,))
        oc = p.get('hs_meeting_outcome')
        mtg_outcomes[oc] = mtg_outcomes.get(oc, 0) + 1
        if p.get('hs_meeting_start_time'):
            starts.append(p['hs_meeting_start_time'][:10])

    # spend from Channels_Marketing Budget / Actuals
    months, channels, channel_months = [], [], []
    try:
        rows = {rn: json.loads(rj) for rn, rj in
                q(cur, "select row_num, row_json from sheets_data where spreadsheet_title='Channels_Marketing Budget' and tab='Actuals' order by row_num")}
        header = rows.get(6, [])
        # header like ["Account","Vendor","Channel","1/31/2026",...]
        month_idx = []
        for i, h in enumerate(header):
            m = re.match(r'(\d{1,2})/\d{1,2}/(\d{4})', str(h))
            if m:
                month_idx.append((i, f"{m.group(2)}-{int(m.group(1)):02d}"))
        planned = rows.get(2, [])
        actual = rows.get(3, [])
        for i, mlabel in month_idx:
            pv = num(planned[i]) if i < len(planned) else None
            av = num(actual[i]) if i < len(actual) else None
            months.append({'month': mlabel,
                           'planned': round(pv) if pv is not None else None,
                           'actual': round(av) if av is not None else None})
        chan_totals = {}
        # Per vendor, a blank month stays blank. Summing it as zero would invent spend.
        chan_months = {}
        for rn, row in rows.items():
            if rn < 7 or not isinstance(row, list) or len(row) < 4:
                continue
            cname = str(row[2]).strip() if row[2] else ''
            if not cname:
                continue
            tot = 0
            seen = False
            bucket = chan_months.setdefault(cname, {})
            for i, mlabel in month_idx:
                v = num(row[i]) if i < len(row) else None
                prev = bucket.get(mlabel, 0)
                if v is None or prev is None:
                    bucket[mlabel] = None
                else:
                    bucket[mlabel] = prev + v
                    tot += v
                    seen = True
            if seen:
                chan_totals[cname] = chan_totals.get(cname, 0) + tot
        channels = [{'name': k, 'amount': round(v)} for k, v in sorted(chan_totals.items(), key=lambda x: -x[1])]
        channel_months = [{'channel': name, 'months': [{'month': m, 'actual': None if amt is None else round(amt)} for m, amt in sorted(months.items())]} for name, months in sorted(chan_months.items())]
    except Exception as e:
        print(f'spend parse warning: {e}', flush=True)

    campaigns = []
    for cid_, name, status, raw in q(cur, 'select campaign_id, name, status, raw_json from lemlist_campaigns'):
        campaigns.append({'name': name, 'sent': None, 'replies': None, 'bounces': None})

    web = {'start': None, 'end': None, 'sessions': None, 'engaged': None,
           'engagedSessions': None, 'pageViews': None, 'aiCited': None,
           'aiMentioned': None, 'aiCount': None, 'aiEnd': None,
           'visits': [], 'channels': [], 'pages': []}
    ga = q(cur, 'select result_json, fetched_at from ga4_reports limit 1')
    if ga:
        try:
            res = json.loads(ga[0][0])
            vals = {h['name']: v['value'] for h, v in
                    zip(res.get('metricHeaders', []), res.get('rows', [{}])[0].get('metricValues', []))}
            web['sessions'] = int(vals.get('sessions')) if vals.get('sessions') else None
            web['pageViews'] = int(vals.get('screenPageViews')) if vals.get('screenPageViews') else None
            if ga[0][1]:
                try:
                    from datetime import timedelta
                    end = datetime.fromisoformat(str(ga[0][1]).replace('Z', '+00:00'))
                    web['end'] = end.date().isoformat()
                    web['start'] = (end - timedelta(days=30)).date().isoformat()
                except Exception:
                    pass
        except Exception as e:
            print(f'ga4 parse warning: {e}', flush=True)

    report = {
        'meetings': {'start': min(starts) if starts else None,
                     'end': max(starts) if starts else None,
                     'completed': mtg_outcomes.get('COMPLETED', 0),
                     'recorded': len(fathom)},
        'pipeline': {'weighted': {'value': round(weighted, 2)},
                     'open': {'value': round(sum((o.get('amount') or 0) for o in opportunities), 2)},
                     'stages': sorted(stages.values(), key=lambda s: -s['amount']),
                     'scorecard': [{'label': 'Active deals', 'value': len(opportunities)},
                                   {'label': 'Discovery calls', 'value': len(fathom)}]},
        'spend': {'months': months, 'channels': channels, 'channelMonths': channel_months,
                  'campaigns': campaigns, 'advertising': []},
        'web': web,
    }

    # ---------- verified ----------
    verified = {
        'snapshotId': SNAPSHOT,
        'meta': {'owners': []},
        'opportunities': opportunities,
        'leads': leads,
        'drafts': [],
        'draftVersions': {},
        'evidenceKeys': {},
        'presentation': {
            'priorities': [],
            'priorityReview': {'id': 'brain-review', 'asOf': TODAY,
                               'scope': 'Real records from the company brain (HubSpot, Fathom, Sheets).'},
            'suggestedDrafts': [],
            'upcoming': upcoming,
        },
        # Lifecycle-stage totals are not the headline. The workspace counts
        # leads by lead date, MQL as meetings booked, and SQL as meetings held.
        'quick': {'leads': None, 'mql': None, 'sql': None,
                  'note': 'Computed in the workspace. MQL is a meeting booked; SQL is a meeting held.'},
        'report': report,
        # Top-level web keeps the frontend contract stable: data-bindings.js
        # reads verified.web (GA4 extract). Missing fields stay null.
        'web': web,
    }

    records = {
        'verifiedSnapshotId': SNAPSHOT,
        'generatedAt': NOW_ISO,
        'companies': companies,
        'unmatchedRecordings': unmatched,
        'coverage': {'foldedRelated': 0, 'contacts': n_contacts, 'notes': n_notes,
                    'fathomTotal': len(fathom), 'transcripts': n_transcripts},
    }

    bootstrap = {
        'user': {'id': 'workspace-user', 'name': 'Workspace user', 'email': '', 'owner': True},
        'preferences': {'mode': 'cs', 'ratings': {}, 'draftModes': {}, 'priorityContext': {}},
        'preferencesRevision': 0,
        'drafts': [],
        'comments': [],
        'connections': {'google': {'connected': True, 'configured': True},
                        'slack': {'connected': False, 'configured': False}},
        'imported': True,
        'sends': [],
        'campaignSenders': [],
    }

    for name, value in [('verified', verified), ('records', records),
                        ('evidence', evidence), ('draft-seeds', []),
                        ('evidence-sheet-labels', {}), ('bootstrap', bootstrap)]:
        path = os.path.join(OUT, name + '.json')
        with open(path, 'w') as f:
            json.dump(value, f, indent=2)
        print(f'wrote {name}.json ({os.path.getsize(path)/1e6:.1f} MB)', flush=True)

    print('evidence records:', len(evidence), flush=True)
    print('DONE', flush=True)

if __name__ == '__main__':
    sys.exit(main())
