#!/usr/bin/env python3
"""HubSpot reconciliation export for workspace/build.mjs --recon (read-only).

Writes <out>/live_deals.json: pipes, stages (closed/prob metadata), deals[].properties,
and per deal: companyIds (all associated companies, primary first when HubSpot marks one),
ownerHistory (hubspot_owner_id history, newest first: value, timestamp, sourceType),
derived (stage id/label, pipeline, amount, probability, weighted, isClosed from stage metadata, onHold, owner name).
owners maps every owner id (archived included) to {name, email, archived}; openBook sums salesOpen / salesOnHold /
allPipelinesOpen (count, amount, weighted, noAmount).
companies maps every associated company id to {name, domain}.

Usage: python3 scripts/hubspot-recon-export.py --out DIR
Needs an `hs` module on PYTHONPATH exposing get(path, **params), all_rows(obj, groups, props),
http (requests session), API and auth (the Opstream box audit helper).
"""
import argparse, json, os, sys

PROPS = ['dealname', 'pipeline', 'dealstage', 'amount', 'hs_deal_stage_probability', 'hs_forecast_probability',
         'closedate', 'hubspot_owner_id', 'hs_is_closed', 'hs_is_closed_won', 'createdate', 'hs_lastmodifieddate',
         'closed_lost_reason']


def chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    import hs
    pipes, stages = {}, {}
    for p in hs.get('/crm/v3/pipelines/deals')['results']:
        pipes[p['id']] = p['label']
        for s in p['stages']:
            stages[s['id']] = dict(pipe=p['label'], label=s['label'], closed=s['metadata'].get('isClosed') == 'true',
                                   prob=s['metadata'].get('probability'))
    deals = hs.all_rows('deals', groups=[{'filters': [{'propertyName': 'createdate', 'operator': 'GT', 'value': '0'}]}],
                        props=PROPS)
    ids = [d['id'] for d in deals]
    # deal -> companies (v4 batch associations; labels say which one is primary)
    assoc = {}
    for part in chunks(ids, 100):
        r = hs.http.post(hs.API + '/crm/v4/associations/deals/companies/batch/read', auth=hs.auth,
                         json={'inputs': [{'id': i} for i in part]}).json()
        for row in r.get('results', []):
            tos = row.get('to', [])
            prim = [t for t in tos if any(x.get('typeId') == 5 for x in t.get('associationTypes', []))]
            order = prim + [t for t in tos if t not in prim]
            assoc[str(row['from']['id'])] = [str(t['toObjectId']) for t in order]
    # owner history (search can't return history; batch read can)
    hist = {}
    for part in chunks(ids, 50):
        r = hs.http.post(hs.API + '/crm/v3/objects/deals/batch/read', auth=hs.auth,
                         json={'inputs': [{'id': i} for i in part], 'properties': ['hubspot_owner_id'],
                               'propertiesWithHistory': ['hubspot_owner_id']}).json()
        for row in r.get('results', []):
            hist[row['id']] = [{'value': h.get('value'), 'timestamp': h.get('timestamp'), 'sourceType': h.get('sourceType')}
                               for h in (row.get('propertiesWithHistory') or {}).get('hubspot_owner_id', [])]
    cids = sorted({c for v in assoc.values() for c in v})
    companies = {}
    for part in chunks(cids, 100):
        r = hs.http.post(hs.API + '/crm/v3/objects/companies/batch/read', auth=hs.auth,
                         json={'inputs': [{'id': i} for i in part], 'properties': ['name', 'domain']}).json()
        for row in r.get('results', []):
            companies[row['id']] = {'name': row['properties'].get('name'), 'domain': row['properties'].get('domain')}
    # Every owner id, archived ones included, so old ids (e.g. owners at close) resolve to a name.
    owners = {}
    for archived in ('false', 'true'):
        after = None
        while True:
            params = {'limit': 500, 'archived': archived}
            if after:
                params['after'] = after
            r = hs.get('/crm/v3/owners', **params)
            for o in r.get('results', []):
                name = ' '.join(x for x in (o.get('firstName'), o.get('lastName')) if x).strip() or o.get('email') or o['id']
                owners.setdefault(str(o['id']), {'name': name, 'email': o.get('email'), 'archived': o.get('archived', archived == 'true')})
            after = ((r.get('paging') or {}).get('next') or {}).get('after')
            if not after:
                break

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    book = {k: {'count': 0, 'amount': 0.0, 'weighted': 0.0, 'noAmount': 0} for k in ('salesOpen', 'salesOnHold', 'allPipelinesOpen')}
    for d in deals:
        d['companyIds'] = assoc.get(d['id'], [])
        d['ownerHistory'] = hist.get(d['id'], [])
        p = d['properties']
        st = stages.get(p.get('dealstage')) or {}
        # isClosed comes from the pipeline stage metadata; hs_is_closed only when the stage is unknown.
        closed = st['closed'] if st else str(p.get('hs_is_closed')).lower() == 'true'
        amount, prob = num(p.get('amount')), num(p.get('hs_deal_stage_probability'))
        on_hold = (st.get('label') or '').strip().lower() == 'on hold'
        d['derived'] = {
            'stageId': p.get('dealstage'), 'stageLabel': (st.get('label') or '').strip() or None,
            'pipelineId': p.get('pipeline'), 'pipeline': pipes.get(p.get('pipeline')),
            'amount': amount, 'probability': prob,
            'weighted': amount * prob if amount is not None and prob is not None else None,
            'isClosed': closed, 'onHold': on_hold,
            'owner': (owners.get(str(p.get('hubspot_owner_id') or '')) or {}).get('name'),
        }
        if closed:
            continue
        keys = ['allPipelinesOpen']
        if p.get('pipeline') == 'default':
            keys.append('salesOnHold' if on_hold else 'salesOpen')
        for k in keys:
            b = book[k]
            b['count'] += 1
            b['amount'] += amount or 0
            b['weighted'] += d['derived']['weighted'] or 0
            b['noAmount'] += amount is None
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'live_deals.json'), 'w') as f:
        json.dump(dict(pipes=pipes, stages=stages, deals=deals, companies=companies, owners=owners, openBook={
            'definition': 'salesOpen = Sales Pipeline (default), stage not closed per pipeline metadata, not On Hold; '
                          'salesOnHold = Sales Pipeline On Hold; allPipelinesOpen = every pipeline, stage not closed. '
                          'weighted = amount x hs_deal_stage_probability.',
            **{k: {**v, 'amount': round(v['amount'], 2), 'weighted': round(v['weighted'], 2)} for k, v in book.items()}}), f)
    print(f"deals {len(deals)}, with company {sum(1 for d in deals if d['companyIds'])}, "
          f"with owner history {sum(1 for d in deals if d['ownerHistory'])}, companies {len(companies)}, owners {len(owners)}", file=sys.stderr)
    print(json.dumps(book), file=sys.stderr)


if __name__ == '__main__':
    main()
