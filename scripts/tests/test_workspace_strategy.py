"""workspace.json 'strategy' (docs/workspace-strategy.md), built by scripts/workspace-data.py from a synthetic brain.db:
contact lifecycle and conversion fields, meeting-link bookings, contact -> deal ids and dealstage entry times. Also:
the rest of workspace.json is the same with or without it, the over-budget fallbacks, and the privacy rules.
Every company, person, id and figure is invented.

    timeout 300 python3 -m unittest scripts/tests/test_workspace_strategy.py
"""
import importlib.util
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('workspace_data_strategy', os.path.join(HERE, '..', 'workspace-data.py'))
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)
PAT = 'quill'  # synthetic; real scrub patterns never enter the repo
SALES = wd.SCOPE['salesPipelineId']
DEMO_PAGE = wd.RULES['mql']['bookingLinkIds'][0]
PUBLIC = wd.REPORTING['meetings']['sourceValue']


class Strategy(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.warnings = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def brain(self):
        db = os.path.join(self.dir, 'brain.db')
        if os.path.exists(db):  # a second build in one test starts over
            os.unlink(db)
        con = sqlite3.connect(db)
        con.executescript("""
            CREATE TABLE hubspot_objects (object_type TEXT, hs_id TEXT, properties_json TEXT, fetched_at TEXT);
            CREATE TABLE hubspot_associations (from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT);
            CREATE TABLE hubspot_pipelines (pipeline_id TEXT, stage_id TEXT, stage_label TEXT, pipeline_label TEXT,
                                            display_order INTEGER, is_closed INTEGER, probability TEXT);
            CREATE TABLE hubspot_deal_extras (deal_id TEXT PRIMARY KEY, company_ids TEXT, owner_history TEXT,
                                              refreshed_at TEXT, stage_history TEXT, contact_ids TEXT);
            CREATE TABLE sheets_data (spreadsheet_title TEXT, tab TEXT, row_num INTEGER, row_json TEXT);
            CREATE TABLE lemlist_campaigns (campaign_id TEXT, name TEXT, status TEXT, raw_json TEXT);""")
        for n, (sid, label) in enumerate([('s1', 'SQL'), ('s2', 'Demo meeting')]):
            con.execute('INSERT INTO hubspot_pipelines VALUES (?,?,?,?,?,?,?)', (SALES, sid, label, 'Sales Pipeline', n, 0, '0.1'))
        obj = lambda kind, i, props: con.execute('INSERT INTO hubspot_objects VALUES (?,?,?,?)', (kind, i, json.dumps(props), ''))
        link = lambda a, i, b, j: con.execute('INSERT INTO hubspot_associations VALUES (?,?,?,?)', (a, i, b, j))
        obj('companies', '501', {'name': 'Alpha Synthetic', 'domain': 'alpha.example', 'lifecyclestage': 'opportunity'})
        for did, stage in (('901', 's2'), ('902', 's1')):
            obj('deals', did, {'dealname': 'Alpha Synthetic - New', 'pipeline': SALES, 'dealstage': stage, 'amount': '1000',
                               'createdate': '2026-01-01T00:00:00.000Z'})
            link('deals', did, 'companies', '501')
        # 901: entered s1, re-saved in s1 (no new entry), entered s2. Newest first, as hubspot_sync.py stores it.
        hist = [{'value': 's2', 'timestamp': '2026-02-01T10:00:00.000Z', 'sourceType': 'CRM_UI'},
                {'value': 's1', 'timestamp': '2026-01-02T00:00:00.000Z', 'sourceType': 'CRM_UI'},
                {'value': 's1', 'timestamp': '2026-01-01T00:00:00.000Z', 'sourceType': 'CRM_UI'}]
        con.execute("INSERT INTO hubspot_deal_extras VALUES ('901', '[\"501\"]', '[]', '', ?, '[]')", (json.dumps(hist),))
        # 902: no stage history yet; its contact 102 only through the extras' periodic re-read (no association row).
        con.execute("INSERT INTO hubspot_deal_extras VALUES ('902', '[\"501\"]', '[]', '', NULL, '[\"102\"]')")

        def contact(i, email, life='lead', **props):
            obj('contacts', i, {'email': email, 'firstname': 'Synthia%s' % i, 'lastname': 'Example', 'phone': '555-0100',
                                'jobtitle': 'Synthetic title', 'lifecyclestage': life, 'createdate': '2026-01-01T00:00:00Z',
                                'hs_lifecyclestage_lead_date': '2026-01-01T00:00:00.000Z', **props})
        contact('101', 'a101@alpha.example', 'opportunity',
                hs_lifecyclestage_marketingqualifiedlead_date='2026-01-05T12:30:00.123Z',
                hs_lifecyclestage_salesqualifiedlead_date='2026-01-10T00:00:00.000Z',
                first_conversion_event_name='Demo form: Pricing page', first_conversion_date='2026-01-03T00:00:00.000Z',
                recent_conversion_event_name='Meetings Link: book-a-demo', recent_conversion_date='2026-01-04T00:00:00.000Z',
                num_conversion_events='2')
        link('deals', '901', 'contacts', '101')
        contact('102', 'b102@alpha.example')                                   # on deal 902 via the extras only
        contact('103', 'c103@gmail.com', first_conversion_event_name='Contact form: %s page' % PAT,
                num_conversion_events='1')                                     # converted, free mail
        contact('104', 'd104@alpha.example')                                   # nothing past a lead date: left out
        contact('105', 'e105@alpha.example', 'marketingqualifiedlead')         # stage past lead only
        contact('106', 'f106@alpha.example')                                   # booked twice on another page
        # Meetings: 101 had a sales meeting before booking through the book-a-demo page.
        meeting = lambda i, created, source, page=None, *cids: (obj('meetings', i, {
            'hs_createdate': created, 'hs_meeting_start_time': created, 'hs_meeting_source': source,
            'hs_created_by_scheduling_page': page, 'hs_meeting_title': 'Synthetic meeting'}),
            [link('meetings', i, 'contacts', c) for c in cids])
        meeting('7001', '2025-12-20T00:00:00.000Z', 'CRM_UI', None, '101')
        meeting('7002', '2026-01-04T00:00:00.000Z', PUBLIC, DEMO_PAGE, '101')
        meeting('7003', '2026-03-02T00:00:00.000Z', PUBLIC, '777', '106')
        meeting('7004', '2026-03-01T00:00:00.000Z', PUBLIC, '777', '106')
        meeting('7005', '2026-03-03T00:00:00.000Z', None, None, '104')          # no source: not a booking
        con.commit()
        con.close()
        return db

    def build(self):
        path = os.path.join(self.dir, 'lead-sources.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'sheet': {'tab': 'Lead Tracker (Synthetic Sheet)'}, 'ads': {'platforms': ['Google Ads']}}, f)
        args = wd.argparse.Namespace(db=self.brain(), inputs_dir=self.dir, lead_sources=None, lost_reasons=None, insights=None,
                                     lead_insights=None, prior=None, current_page=None, portal_id=None, as_of='2026-10-13T16:00:00Z',
                                     call_classification=None, review_list=None, paid_export=None, scrub_patterns_file=None,
                                     source_overrides=None, out=None, quiet=True)
        with mock.patch.dict(os.environ, {'WORKSPACE_SCRUB_PATTERNS': PAT}):
            return wd.build(args, warn=self.warnings.append)

    def rows(self, s):
        fields = s['contacts']['fields']
        return {r[0]: dict(zip(fields, r)) for r in s['contacts']['rows']}

    @staticmethod
    def size(doc):
        return len(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))

    def test_contacts_deals_and_stage_history(self):
        out = self.build()
        self.assertEqual(list(out)[-1], 'strategy')
        s = out['strategy']
        self.assertEqual((s['available'], s['version'], s['contactsScope']), (True, 1, 'all'))
        rows = self.rows(s)
        self.assertEqual(sorted(rows), ['101', '102', '103', '105', '106'])  # 104: nothing past a lead date
        ev = s['conversionEvents']
        a = rows['101']
        self.assertEqual({k: a[k] for k in ('lifecyclestage', 'leadAt', 'mqlAt', 'sqlAt', 'customerAt')},
                         {'lifecyclestage': 'opportunity', 'leadAt': '2026-01-01T00:00:00Z', 'mqlAt': '2026-01-05T12:30:00Z',
                          'sqlAt': '2026-01-10T00:00:00Z', 'customerAt': None})
        self.assertEqual((ev[a['firstConversion']], a['firstConversionAt'], ev[a['recentConversion']], a['recentConversionAt'],
                          a['conversions']), ('Demo form: Pricing page', '2026-01-03T00:00:00Z', 'Meetings Link: book-a-demo',
                                              '2026-01-04T00:00:00Z', 2))
        self.assertEqual({k: a[k] for k in ('firstMeetingSource', 'bookings', 'firstBookingAt', 'firstBookingPage', 'bookADemo',
                                            'dealIds', 'scope')},
                         {'firstMeetingSource': 'CRM_UI', 'bookings': 1, 'firstBookingAt': '2026-01-04T00:00:00Z',
                          'firstBookingPage': DEMO_PAGE, 'bookADemo': True, 'dealIds': ['901'], 'scope': None})
        self.assertEqual((rows['102']['dealIds'], rows['102']['bookings'], rows['102']['firstConversion']), (['902'], 0, None))
        self.assertEqual((rows['103']['scope'], rows['103']['conversions'], rows['103']['dealIds']), ('freeMail', 1, []))
        self.assertEqual((rows['105']['lifecyclestage'], rows['105']['mqlAt']), ('marketingqualifiedlead', None))
        f = rows['106']
        self.assertEqual((f['bookings'], f['firstBookingAt'], f['firstBookingPage'], f['bookADemo'], f['firstMeetingSource']),
                         (2, '2026-03-01T00:00:00Z', '777', False, PUBLIC))
        # Deals: oldest first, a re-save in the same stage is no new entry; no history synced -> null.
        h = s['dealStageHistory']
        self.assertEqual(h['901'], {'pipeline': SALES, 'stageId': 's2', 'created': '2026-01-01T00:00:00Z',
                                    'entered': [['s1', '2026-01-01T00:00:00Z'], ['s2', '2026-02-01T10:00:00Z']]})
        self.assertIsNone(h['902']['entered'])
        self.assertEqual([(x['id'], x['label']) for x in s['stages']], [('s1', 'SQL'), ('s2', 'Demo meeting')])
        self.assertEqual(s['counts'], {'contacts': 5, 'withDeals': 2, 'contactDealPairs': 2, 'withConversions': 2, 'bookers': 2,
                                       'bookADemo': 1, 'byLifecycle': {'lead': 3, 'marketingqualifiedlead': 1, 'opportunity': 1},
                                       'byScope': {'freeMail': 1, 'in': 4}, 'deals': 2, 'dealsWithHistory': 1})
        self.assertEqual(s['synced']['lifecycleDates'], ['leadAt', 'mqlAt', 'sqlAt'])
        self.assertTrue(s['synced']['dealContactsReread'] and s['synced']['stageHistory'] and s['synced']['schedulingPage'])

    def test_ids_only_and_scrubbed(self):
        s = json.dumps(self.build()['strategy'], ensure_ascii=False)
        for leak in ('@', 'Synthia', 'Example', '555-0100', 'Synthetic title', 'Alpha Synthetic', 'Synthetic meeting', PAT):
            self.assertNotIn(leak, s)
        self.assertIn('Contact form: %s page' % wd.UNASSIGNED, s)

    def test_rest_of_the_file_is_the_same_without_it(self):
        out = self.build()
        with mock.patch.object(wd, 'build_strategy', side_effect=RuntimeError('boom')):
            without = self.build()
        self.assertEqual(without['strategy'], {'version': 1, 'contract': 'docs/workspace-strategy.md', 'available': False,
                                               'reason': 'left out: building it failed (RuntimeError)'})
        strip = lambda d: {k: v for k, v in d.items() if k != 'strategy'}
        for d in (out, without):
            d['meta'].pop('generatedAt')
        self.assertEqual(strip(out), strip(without))
        self.assertTrue(any('strategy left out' in w for w in self.warnings))

    def test_over_budget_core_contacts_then_left_out(self):
        full = self.build()
        rest = self.size({k: v for k, v in full.items() if k != 'strategy'})
        with mock.patch.object(wd, 'MAX_BYTES', self.size(full) - 1):
            out = self.build()
        s = out['strategy']
        self.assertTrue(s['available'])
        self.assertTrue(s['contactsScope'].startswith('core:'))
        self.assertEqual(sorted(self.rows(s)), ['101', '102', '105', '106'])  # 103 only converted
        self.assertEqual(s['conversionEvents'], ['Demo form: Pricing page', 'Meetings Link: book-a-demo'])
        self.assertEqual(s['dealStageHistory'], full['strategy']['dealStageHistory'])
        self.assertLess(self.size(out), self.size(full))
        with mock.patch.object(wd, 'MAX_BYTES', rest + 100):
            out = self.build()
        self.assertEqual((out['strategy']['available'], out['fresh'] == full['fresh']), (False, True))
        self.assertIn('budget', out['strategy']['reason'])


if __name__ == '__main__':
    unittest.main()
