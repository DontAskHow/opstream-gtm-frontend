#!/usr/bin/env python3
"""Coverage of the fields Strategy's lead -> MQL / deal analysis needs, in a built strategy.json, reconciled to the
brain.db HubSpot tables it was built from. Prints counts only, never ids. Exit 1 when a field has no coverage or a
count does not match its table.

    python3 scripts/check_strategy_fields.py --db brain.db --strategy out/strategy.json

Fields, in Strategy's priority order (docs/workspace-strategy.md):
  1. contact <-> deal associations: contacts.rows dealIds and dealStageHistory.<deal>.contactIds, against
     hubspot_associations (deals <-> contacts) plus hubspot_deal_extras.contact_ids
  2. contact lifecycle stage: contacts.rows lifecyclestage, against the contacts' lifecyclestage property
  3. dealstage history with entered-at: dealStageHistory.<deal>.entered, against hubspot_deal_extras.stage_history
  4. form / booking source: firstConversion, firstMeetingSource, bookings, against the contacts' conversion property
     and their meetings' hs_meeting_source
"""
import argparse
import importlib.util
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('workspace_data', os.path.join(HERE, 'workspace-data.py'))
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)


def db_pairs(con, cols):
    """(deal, contact) pairs the build reads: both association directions plus the deal extras' re-read."""
    pairs = {(str(d), str(c)) for d, c in con.execute(
        "SELECT from_id, to_id FROM hubspot_associations WHERE from_type='deals' AND to_type='contacts' "
        "UNION SELECT to_id, from_id FROM hubspot_associations WHERE from_type='contacts' AND to_type='deals'")}
    if 'contact_ids' in cols:
        for did, raw in con.execute('SELECT deal_id, contact_ids FROM hubspot_deal_extras WHERE contact_ids IS NOT NULL'):
            try:
                pairs |= {(str(did), str(c)) for c in json.loads(raw) or []}
            except (TypeError, ValueError):
                pass
    return pairs


def db_entered(con, cols):
    """Deals whose stored dealstage history has at least one stage with a time."""
    out = set()
    if 'stage_history' not in cols:
        return out
    for did, raw in con.execute('SELECT deal_id, stage_history FROM hubspot_deal_extras WHERE stage_history IS NOT NULL'):
        try:
            if any(isinstance(h, dict) and h.get('value') and wd.parse_time(h.get('timestamp')) for h in json.loads(raw)):
                out.add(str(did))
        except (TypeError, ValueError):
            pass
    return out


def check(con, s):
    """[(name, value, expected or None, ok)] and the lines to print."""
    lines, bad = [], []

    def line(name, got, want=None, need_nonzero=True):
        ok = (want is None or got == want) and (not need_nonzero or got)
        lines.append('%-4s %-58s %s' % ('ok' if ok else 'FAIL', name, got if want is None else '%s (tables: %s)' % (got, want)))
        if not ok:
            bad.append(name)

    if not s.get('available'):
        return ['FAIL strategy.json available=false: %s' % s.get('reason')], ['available']
    cols = [r[1] for r in con.execute('PRAGMA table_info(hubspot_deal_extras)')]
    f = s['contacts']['fields']
    rows = [dict(zip(f, r)) for r in s['contacts']['rows']]
    ids = {r['id'] for r in rows}
    hist = s['dealStageHistory']
    lines.append('contacts.rows %d (%s); deals %d' % (len(rows), s.get('contactsScope'), len(hist)))

    # 1. associations
    deals = {str(r[0]) for r in con.execute("SELECT hs_id FROM hubspot_objects WHERE object_type='deals'")}
    pairs = {(d, c) for d, c in db_pairs(con, cols) if d in deals}
    row_pairs = {(d, r['id']) for r in rows for d in r.get('dealIds') or []}
    line('1 contact->deal pairs on contact rows', len(row_pairs), len({(d, c) for d, c in pairs if c in ids}))
    line('1 contacts with a deal', sum(1 for r in rows if r.get('dealIds')), len({c for d, c in pairs if c in ids}))
    with_hist = {d for d, h in hist.items() if h.get('entered')}
    linked = {d for d, _c in row_pairs}
    line('1 deals with stage history linked back to a contact row', len(with_hist & linked),
         len(with_hist & {d for d, c in pairs if c in ids}))
    lines.append('     share: %d of %d deals with stage history' % (len(with_hist & linked), len(with_hist)))
    if any('contactIds' not in h for h in hist.values()):
        line('1 deals with contactIds (deal side)', 0, len({d for d, _c in pairs}))
    else:
        side = {(d, c) for d, h in hist.items() for c in h['contactIds']}
        line('1 deal->contact pairs on deals (deal side)', len(side), len(pairs))
        line('1 deals with contactIds (deal side)', sum(1 for h in hist.values() if h['contactIds']), len({d for d, _c in pairs}))
        # Contacts on a deal with stage history whose deal names them back (both sides agree).
        staged = {r['id'] for r in rows if with_hist & set(r.get('dealIds') or [])}
        back = {r['id'] for r in rows if r['id'] in staged
                and all(r['id'] in hist[d]['contactIds'] for d in r['dealIds'] if d in with_hist)}
        line('1 contacts on a staged deal whose deal links back', len(back), len(staged))
        lines.append('     share: %d of %d contacts with dealstage history' % (len(back), len(staged)))
        lines.append('     deals with no contact in the tables: %d' % (len(hist) - len({d for d, _c in pairs})))

    # 2. lifecycle stage
    props = {}
    for cid, life, conv in con.execute("SELECT hs_id, json_extract(properties_json, '$.lifecyclestage'), "
                                       "json_extract(properties_json, '$.first_conversion_event_name') "
                                       "FROM hubspot_objects WHERE object_type='contacts'"):
        if str(cid) in ids:
            props[str(cid)] = (life, conv)
    line('2 contact rows with a lifecycle stage', sum(1 for r in rows if r.get('lifecyclestage')),
         sum(1 for life, _c in props.values() if life))

    # 3. dealstage history, entered-at per stage
    line('3 deals with dealstage entered-at', len(with_hist), len(db_entered(con, cols) & set(hist)))
    line('3 stage entries (stage, entered-at)', sum(len(h.get('entered') or []) for h in hist.values()), None)

    # 4. form / booking source
    line('4 contact rows with a first conversion (form/booking)', sum(1 for r in rows if r.get('firstConversion') is not None),
         sum(1 for _l, conv in props.values() if conv))
    mcfg = wd.REPORTING['meetings']
    src = {str(m): str(v) for m, v in con.execute(
        "SELECT hs_id, json_extract(properties_json, '$.%s') FROM hubspot_objects WHERE object_type='meetings'"
        % mcfg['sourceProperty']) if v}
    met, booked = set(), set()
    for mid, cid in con.execute("SELECT from_id, to_id FROM hubspot_associations WHERE from_type='meetings' AND to_type='contacts'"):
        if str(mid) in src and str(cid) in ids:
            met.add(str(cid))
            if src[str(mid)].upper() == mcfg['sourceValue']:
                booked.add(str(cid))
    line('4 contact rows with a first meeting source', sum(1 for r in rows if r.get('firstMeetingSource')), len(met))
    line('4 contact rows with a meeting-link booking', sum(1 for r in rows if r.get('bookings')), len(booked))
    return lines, bad


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--db', required=True, help='the brain.db the file was built from')
    ap.add_argument('--strategy', required=True, help='strategy.json')
    args = ap.parse_args(argv)
    con = sqlite3.connect('file:%s?mode=ro' % os.path.abspath(args.db), uri=True)
    with open(args.strategy, encoding='utf-8') as fh:
        lines, bad = check(con, json.load(fh))
    print('\n'.join(lines))
    print('PASS' if not bad else 'FAIL: %d check(s)' % len(bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
