"""strategy.json (docs/workspace-strategy.md), built by scripts/workspace-data.py from a synthetic brain.db:
contact lifecycle and conversion fields, meeting-link bookings, contact -> deal ids and dealstage entry times, leads
by first form fill month, scheduling pages. Also: workspace.json keeps only a pointer to it and is otherwise the same
with or without it, the file is written next to --out, the over-budget fallbacks, the privacy rules, and the
lifecycle date properties hubspot_sync.py asks for.
Every company, person, id and figure is invented.

    timeout 300 python3 -m unittest scripts/tests/test_workspace_strategy.py
"""
import contextlib
import importlib.util
import io
import json
import logging
import os
import shutil
import sqlite3
import sys
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
INTERNAL = wd.REPORTING['contacts']['internalDomains'][0]
CAREERS = wd.REPORTING['contacts']['excludedFormNamePrefixes'][0]
DEMO_SLUG = 'synthetic-rep/website-book-a-demo'


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
                recent_conversion_event_name='Meetings Link: ' + DEMO_SLUG, recent_conversion_date='2026-01-04T00:00:00.000Z',
                num_conversion_events='2')
        link('deals', '901', 'contacts', '101')
        contact('102', 'b102@alpha.example')                                   # on deal 902 via the extras only
        contact('103', 'c103@gmail.com', first_conversion_event_name='Contact form: %s page' % PAT,
                num_conversion_events='1')                                     # converted, free mail
        contact('104', 'd104@alpha.example')                                   # nothing past a lead date: left out
        contact('105', 'e105@alpha.example', 'marketingqualifiedlead',         # stage past lead only; HubSpot's v2
                hs_v2_date_entered_lead='2026-01-02T00:00:00.000Z',            # dates win over the older ones
                hs_v2_date_entered_marketingqualifiedlead='2026-01-07T00:00:00.000Z',
                hs_v2_date_entered_opportunity='2026-02-01T00:00:00.000Z')
        contact('106', 'f106@alpha.example')                                   # booked twice on another page
        # Form fills only (left out of the core rows), counted by the month (UTC-7) of the first fill, or out.
        fill = lambda i, email, event, at, life='lead': contact(i, email, life, first_conversion_event_name=event,
                                                                  first_conversion_date=at, num_conversion_events='1')
        fill('107', 'g107@beta.example', 'Pricing | Beta: Contact form', '2026-02-10T08:00:00.000Z')
        fill('108', 'h108@beta.example', 'Home | Beta: Hero email', '2026-03-01T03:00:00.000Z')  # Feb 28 in UTC-7
        fill('109', 'i109@beta.example', 'Pricing | Beta: Contact form', '2026-02-11T00:00:00.000Z', 'customer')
        fill('110', 'j110@' + INTERNAL, 'Pricing | Beta: Contact form', '2026-02-12T00:00:00.000Z')
        fill('111', 'k111@beta.example', 'Synthetic Engineer | Beta: %s' % CAREERS, '2026-02-13T00:00:00.000Z')
        fill('112', 'l112@beta.example', 'Meetings Link: ' + DEMO_SLUG, '2026-02-14T00:00:00.000Z')
        contact('113', 'm113@beta.example', num_conversion_events='0')       # no conversion: not a lead
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
        meeting('7006', '2026-02-14T00:00:00.000Z', PUBLIC, DEMO_PAGE, '112')
        con.commit()
        con.close()
        return db

    def build(self, files=False):
        """workspace.json; with files=True (workspace.json, strategy.json)."""
        path = os.path.join(self.dir, 'lead-sources.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'sheet': {'tab': 'Lead Tracker (Synthetic Sheet)'}, 'ads': {'platforms': ['Google Ads']}}, f)
        args = wd.argparse.Namespace(db=self.brain(), inputs_dir=self.dir, lead_sources=None, lost_reasons=None, insights=None,
                                     lead_insights=None, prior=None, current_page=None, portal_id=None, as_of='2026-10-13T16:00:00Z',
                                     call_classification=None, review_list=None, paid_export=None, scrub_patterns_file=None,
                                     source_overrides=None, out=None, quiet=True)
        with mock.patch.dict(os.environ, {'WORKSPACE_SCRUB_PATTERNS': PAT}):
            return (wd.build_files if files else wd.build)(args, warn=self.warnings.append)

    def strategy(self):
        return self.build(files=True)[1]

    def rows(self, s):
        fields = s['contacts']['fields']
        return {r[0]: dict(zip(fields, r)) for r in s['contacts']['rows']}

    @staticmethod
    def size(doc):
        return len(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))

    def test_contacts_deals_and_stage_history(self):
        out, s = self.build(files=True)
        self.assertEqual(list(out)[-1], 'strategy')
        self.assertEqual((s['available'], s['version'], s['contactsScope']), (True, 1, 'all'))
        rows = self.rows(s)
        # 104: nothing past a lead date; 113: no conversion
        self.assertEqual(sorted(rows), ['101', '102', '103', '105', '106', '107', '108', '109', '110', '111', '112'])
        ev = s['conversionEvents']
        a = rows['101']
        self.assertEqual({k: a[k] for k in ('lifecyclestage', 'leadAt', 'mqlAt', 'sqlAt', 'opportunityAt', 'customerAt')},
                         {'lifecyclestage': 'opportunity', 'leadAt': '2026-01-01T00:00:00Z', 'mqlAt': '2026-01-05T12:30:00Z',
                          'sqlAt': '2026-01-10T00:00:00Z', 'opportunityAt': None, 'customerAt': None})
        self.assertEqual((ev[a['firstConversion']], a['firstConversionAt'], ev[a['recentConversion']], a['recentConversionAt'],
                          a['conversions']), ('Demo form: Pricing page', '2026-01-03T00:00:00Z', 'Meetings Link: ' + DEMO_SLUG,
                                              '2026-01-04T00:00:00Z', 2))
        self.assertEqual({k: a[k] for k in ('firstMeetingSource', 'bookings', 'firstBookingAt', 'firstBookingPage', 'bookADemo',
                                            'dealIds', 'scope')},
                         {'firstMeetingSource': 'CRM_UI', 'bookings': 1, 'firstBookingAt': '2026-01-04T00:00:00Z',
                          'firstBookingPage': DEMO_PAGE, 'bookADemo': True, 'dealIds': ['901'], 'scope': None})
        self.assertEqual((rows['102']['dealIds'], rows['102']['bookings'], rows['102']['firstConversion']), (['902'], 0, None))
        self.assertEqual((rows['103']['scope'], rows['103']['conversions'], rows['103']['dealIds']), ('freeMail', 1, []))
        e = rows['105']
        self.assertEqual({k: e[k] for k in ('lifecyclestage', 'leadAt', 'mqlAt', 'sqlAt', 'opportunityAt', 'customerAt')},
                         {'lifecyclestage': 'marketingqualifiedlead', 'leadAt': '2026-01-02T00:00:00Z',
                          'mqlAt': '2026-01-07T00:00:00Z', 'sqlAt': None, 'opportunityAt': '2026-02-01T00:00:00Z',
                          'customerAt': None})
        f = rows['106']
        self.assertEqual((f['bookings'], f['firstBookingAt'], f['firstBookingPage'], f['bookADemo'], f['firstMeetingSource']),
                         (2, '2026-03-01T00:00:00Z', '777', False, PUBLIC))
        # Deals: oldest first, a re-save in the same stage is no new entry; no history synced -> null.
        h = s['dealStageHistory']
        self.assertEqual(h['901'], {'pipeline': SALES, 'stageId': 's2', 'created': '2026-01-01T00:00:00Z',
                                    'entered': [['s1', '2026-01-01T00:00:00Z'], ['s2', '2026-02-01T10:00:00Z']],
                                    'contactIds': ['101']})
        # 902's contact comes from the extras' re-read only: still on the deal's side.
        self.assertEqual((h['902']['entered'], h['902']['contactIds']), (None, ['102']))
        self.assertEqual([(x['id'], x['label']) for x in s['stages']], [('s1', 'SQL'), ('s2', 'Demo meeting')])
        self.assertEqual(s['counts'], {'contacts': 11, 'withDeals': 2, 'contactDealPairs': 2, 'withConversions': 8, 'bookers': 3,
                                       'bookADemo': 2, 'byLifecycle': {'customer': 1, 'lead': 8, 'marketingqualifiedlead': 1,
                                                                       'opportunity': 1},
                                       'byScope': {'customer': 1, 'freeMail': 1, 'in': 8, 'internal': 1}, 'deals': 2,
                                       'dealsWithHistory': 1, 'dealsWithContacts': 2})
        self.assertEqual(s['synced']['lifecycleDates'], ['leadAt', 'mqlAt', 'sqlAt', 'opportunityAt'])
        self.assertTrue(s['synced']['dealContactsReread'] and s['synced']['stageHistory'] and s['synced']['schedulingPage'])

    def test_check_strategy_fields(self):
        s = self.strategy()
        spec = importlib.util.spec_from_file_location('check_strategy_fields', os.path.join(HERE, '..', 'check_strategy_fields.py'))
        chk = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(chk)
        con = sqlite3.connect(os.path.join(self.dir, 'brain.db'))
        lines, bad = chk.check(con, s)
        self.assertEqual(bad, [])
        self.assertFalse([x for x in lines if any(i in x for i in ('101', '102', '901', '902'))])  # counts only
        # A file without the deal side (the previous contract) fails the check; so does a dropped association.
        old = json.loads(json.dumps(s))
        for h in old['dealStageHistory'].values():
            del h['contactIds']
        self.assertEqual(chk.check(con, old)[1], ['1 deals with contactIds (deal side)'])
        dropped = json.loads(json.dumps(s))
        f = dropped['contacts']['fields']
        for r in dropped['contacts']['rows']:
            r[f.index('dealIds')] = [d for d in r[f.index('dealIds')] if d != '902']
        self.assertIn('1 contact->deal pairs on contact rows', chk.check(con, dropped)[1])
        con.close()

    def test_lead_first_fills_by_month(self):
        s = self.strategy()
        # 101 (Jan 3), 107 (Feb 10) and 108 (Mar 1 03:00 UTC = Feb 28 in UTC-7) count; the rest are out by reason.
        self.assertEqual(s['leadFirstFillsByMonth'], {'2026-01': 1, '2026-02': 2})
        self.assertEqual(s['leadFirstFillsOut'], {'careers': 1, 'customer': 1, 'freeMail': 1, 'internal': 1, 'meetingLink': 1})

    def test_booking_pages(self):
        s = self.strategy()
        self.assertEqual(s['bookingPages'], {
            '777': {'bookings': 2, 'contacts': 1, 'slug': None, 'slugContacts': 0, 'bookADemo': False},
            DEMO_PAGE: {'bookings': 2, 'contacts': 2, 'slug': DEMO_SLUG, 'slugContacts': 2, 'bookADemo': True}})

    def test_ids_only_and_scrubbed(self):
        s = json.dumps(self.strategy(), ensure_ascii=False)
        for leak in ('@', 'Synthia', 'Example', '555-0100', 'Synthetic title', 'Alpha Synthetic', 'Synthetic meeting', PAT):
            self.assertNotIn(leak, s)
        self.assertIn('Contact form: %s page' % wd.UNASSIGNED, s)

    def test_workspace_json_keeps_a_pointer(self):
        out, s = self.build(files=True)
        self.assertEqual(out['strategy'], {'version': 1, 'contract': 'docs/workspace-strategy.md', 'available': True,
                                           'file': 'strategy.json', 'bytes': self.size(s), 'counts': s['counts']})
        self.assertEqual(wd.audit_lines(out)[-1], 'strategy (strategy.json, %d KB): 11 contacts (2 with deals, 3 bookers), '
                                                  '2 deals (1 with stage history)' % (self.size(s) // 1024))

    def test_large_strategy_goes_to_its_own_file(self):
        # workspace.json's budget is smaller than the rest of it plus the section: the section stays whole in
        # strategy.json, workspace.json keeps the pointer and is within its budget, nothing else is left out.
        out, s = self.build(files=True)
        self.assertGreater(self.size(dict(out, strategy=s)), self.size(out) + 1000)  # inline, it would be over
        with mock.patch.object(wd, 'MAX_BYTES', self.size(out)):
            small, big = self.build(files=True)
        self.assertLessEqual(self.size(small), self.size(out))
        self.assertEqual((big['available'], big['contactsScope'], big['counts']['contacts']), (True, 'all', 11))
        self.assertEqual(small['strategy'], out['strategy'])
        self.assertEqual(small['fresh'], out['fresh'])
        self.assertFalse({'contacts', 'dealStageHistory', 'leadFirstFillsByMonth', 'bookingPages'} & set(small['strategy']))

    def test_main_writes_strategy_json_next_to_out(self):
        db, ws = self.brain(), os.path.join(self.dir, 'run', 'workspace.json')
        with open(os.path.join(self.dir, 'lead-sources.json'), 'w', encoding='utf-8') as f:
            json.dump({'sheet': {'tab': 'Lead Tracker (Synthetic Sheet)'}}, f)
        argv = ['--db', db, '--inputs-dir', self.dir, '--as-of', '2026-10-13T16:00:00Z', '--out', ws, '--quiet']
        with mock.patch.dict(os.environ, {'WORKSPACE_SCRUB_PATTERNS': PAT}):
            wd.main(argv)
        path = os.path.join(self.dir, 'run', 'strategy.json')
        with open(ws, encoding='utf-8') as f:
            pointer = json.load(f)['strategy']
        with open(path, encoding='utf-8') as f:
            s = json.load(f)
        self.assertEqual((pointer['available'], pointer['file'], pointer['bytes']), (True, 'strategy.json', os.path.getsize(path)))
        self.assertEqual(s['counts'], pointer['counts'])
        self.assertEqual(len(s['contacts']['rows']), 11)
        # strategy.json cannot be written (a directory is in the way): workspace.json is still written, and says so.
        os.remove(path)
        os.makedirs(path)
        with mock.patch.dict(os.environ, {'WORKSPACE_SCRUB_PATTERNS': PAT}), contextlib.redirect_stderr(io.StringIO()):
            wd.main(argv)
        with open(ws, encoding='utf-8') as f:
            pointer = json.load(f)['strategy']
        self.assertEqual((pointer['available'], pointer['file'], pointer['bytes']), (False, None, None))
        self.assertIn('writing strategy.json failed', pointer['reason'])

    def test_rest_of_the_file_is_the_same_without_it(self):
        out = self.build()
        with mock.patch.object(wd, 'build_strategy', side_effect=RuntimeError('boom')):
            without, doc = self.build(files=True)
        self.assertEqual(doc, {'version': 1, 'contract': 'docs/workspace-strategy.md', 'available': False,
                               'reason': 'left out: building it failed (RuntimeError)'})
        self.assertEqual(without['strategy'], {'version': 1, 'contract': 'docs/workspace-strategy.md', 'available': False,
                                               'file': 'strategy.json', 'bytes': self.size(doc),
                                               'reason': 'left out: building it failed (RuntimeError)'})
        strip = lambda d: {k: v for k, v in d.items() if k != 'strategy'}
        for d in (out, without):
            d['meta'].pop('generatedAt')
        self.assertEqual(strip(out), strip(without))
        self.assertTrue(any('strategy left out' in w for w in self.warnings))

    def test_over_budget_core_contacts_then_left_out(self):
        # Over strategy.json's own budget (STRATEGY_MAX_BYTES); workspace.json's budget plays no part.
        full, fs = self.build(files=True)
        with mock.patch.object(wd, 'STRATEGY_MAX_BYTES', self.size(fs) - 1):
            out, s = self.build(files=True)
        self.assertTrue(s['available'])
        self.assertEqual(s['contactsScope'], wd.STRATEGY_CORE)
        self.assertEqual(sorted(self.rows(s)), ['101', '102', '105', '106', '109', '112'])  # 103, 107, 108, 110, 111 only converted
        self.assertEqual(s['conversionEvents'], ['Demo form: Pricing page', 'Meetings Link: ' + DEMO_SLUG,
                                                 'Pricing | Beta: Contact form'])
        self.assertEqual(s['dealStageHistory'], fs['dealStageHistory'])
        self.assertLess(self.size(s), self.size(fs))
        self.assertEqual((out['strategy']['bytes'], out['strategy']['counts']), (self.size(s), s['counts']))
        # The lead totals are over every contact, whatever the rows keep.
        for k in ('leadFirstFillsByMonth', 'leadFirstFillsOut', 'bookingPages'):
            self.assertEqual(s[k], fs[k])
        # Core still over: customers without a deal (109) go too.
        with mock.patch.object(wd, 'STRATEGY_MAX_BYTES', self.size(s) - 1):
            lean = self.strategy()
        self.assertEqual(lean['contactsScope'], wd.STRATEGY_CORE + '; customers without a deal left out')
        self.assertEqual(sorted(self.rows(lean)), ['101', '102', '105', '106', '112'])
        self.assertEqual(lean['leadFirstFillsByMonth'], fs['leadFirstFillsByMonth'])
        with mock.patch.object(wd, 'STRATEGY_MAX_BYTES', 100):
            out, s = self.build(files=True)
        self.assertEqual((s['available'], out['strategy']['available'], out['fresh'] == full['fresh']), (False, False, True))
        self.assertIn('strategy.json would be over its', s['reason'])
        self.assertEqual(out['strategy']['reason'], s['reason'])


class SyncLifecycleDates(unittest.TestCase):
    """hubspot_sync.py asks HubSpot for every lifecycle stage's entry date, and lists custom stages' ones."""

    @classmethod
    def setUpClass(cls):
        sync_dir = os.path.join(HERE, '..', '..', 'refresh', 'brain-sync')
        sys.path.insert(0, sync_dir)
        try:
            s = importlib.util.spec_from_file_location('hubspot_sync_strategy', os.path.join(sync_dir, 'hubspot_sync.py'))
            cls.hs = importlib.util.module_from_spec(s)
            s.loader.exec_module(cls.hs)
        finally:
            sys.path.remove(sync_dir)

    def test_contact_properties(self):
        props = self.hs.OBJECT_TYPES['contacts'][1]
        for stage in ('subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer',
                      'evangelist', 'other'):
            self.assertIn('hs_v2_date_entered_' + stage, props)
            self.assertIn('hs_lifecyclestage_%s_date' % stage, props)
        for _key, (v2, old) in wd.LIFECYCLE_DATES:  # every date workspace-data.py reads is requested
            self.assertEqual((v2 in props, old in props), (True, True))

    def test_custom_stage_dates_discovered(self):
        listed = [{'name': n} for n in ('hs_v2_date_entered_1234567', 'hs_v2_date_exited_1234567', 'utm_source',
                                        'favorite_color', 'hs_v2_date_entered_lead')]
        client = mock.Mock(api_base='https://api.example', request=mock.Mock(return_value=(200, {'results': listed})))
        with mock.patch.object(self.hs.pace, 'min_interval', 0):
            got = self.hs.discover_contact_props(client, logging.getLogger('test'))
        self.assertEqual(got, ['hs_v2_date_entered_1234567', 'hs_v2_date_entered_lead', 'utm_source'])
        self.assertEqual(client.request.call_args.args, ('GET', 'https://api.example/crm/v3/properties/contacts'))


if __name__ == '__main__':
    unittest.main()
