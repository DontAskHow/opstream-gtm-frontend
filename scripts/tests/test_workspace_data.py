"""Rules in scripts/workspace-data.py: the call rule, the hidden-owner scrub, time parsing,
auto-replies and lead-insight cleaning. Synthetic values only."""
import importlib.util
import json
import os
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('workspace_data', os.path.join(HERE, '..', 'workspace-data.py'))
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)
PAT = 'quill'  # synthetic; real scrub patterns never enter the repo


def company(**kw):
    c = {'id': '1', 'name': 'Example Co', 'domain': 'example.com', 'lifecycle': 'opportunity', 'owner': 'A',
         'deals': [], 'firstWon': None, 'csDeal': False, 'salesDeal': True}
    c.update(kw)
    return c


class CallRule(unittest.TestCase):
    won = datetime(2026, 3, 1, tzinfo=timezone.utc)

    def test_before_first_win_is_prospect(self):
        self.assertFalse(wd.customer_at(company(firstWon=self.won), datetime(2026, 2, 1, tzinfo=timezone.utc)))

    def test_after_first_win_is_customer(self):
        self.assertTrue(wd.customer_at(company(firstWon=self.won), datetime(2026, 3, 2, tzinfo=timezone.utc)))

    def test_renewal_or_cs_deal_is_customer(self):
        self.assertTrue(wd.customer_at(company(csDeal=True), datetime(2020, 1, 1, tzinfo=timezone.utc)))

    def test_lifecycle_customer_without_won_date(self):
        self.assertTrue(wd.customer_at(company(lifecycle='customer'), datetime(2026, 1, 1, tzinfo=timezone.utc)))
        self.assertFalse(wd.customer_at(company(lifecycle='customer', firstWon=self.won), datetime(2026, 1, 1, tzinfo=timezone.utc)))

    def test_plain_prospect(self):
        self.assertFalse(wd.customer_at(company(), datetime(2026, 1, 1, tzinfo=timezone.utc)))


class Scrub(unittest.TestCase):
    def setUp(self):
        name = PAT.capitalize() + ' Kay'
        self.s = wd.Scrubber([PAT, 'ozzy'], [name, PAT + '@example.com'])
        self.name = name

    def test_text_and_person(self):
        self.assertEqual(self.s.text('Booked by %s.' % self.name), 'Booked by Unassigned.')
        self.assertEqual(self.s.text('mail %s@example.com now' % PAT), 'mail Unassigned now')
        self.assertEqual(self.s.person(PAT.upper()), 'Unassigned')
        self.assertEqual(self.s.person('not assigned'), 'Unassigned')
        self.assertEqual(self.s.person('Alex'), 'Alex')

    def test_several_patterns(self):
        self.assertEqual(self.s.text('ozzy and alex'), 'Unassigned and alex')
        self.assertEqual(self.s.person('Ozzy Q'), 'Unassigned')

    def test_patterns_from_env_or_file(self):
        import tempfile
        self.assertEqual(wd.load_scrub_patterns(env={'WORKSPACE_SCRUB_PATTERNS': ' Quill, ozzy ,'}), ['ozzy', 'quill'])
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
            f.write('# comment\nquill\nOzzy,extra\n')
        try:
            self.assertEqual(wd.load_scrub_patterns(env={'WORKSPACE_SCRUB_PATTERNS_FILE': f.name}), ['extra', 'ozzy', 'quill'])
            self.assertEqual(wd.load_scrub_patterns(path=f.name, env={}), ['extra', 'ozzy', 'quill'])
        finally:
            os.unlink(f.name)
        self.assertEqual(wd.load_scrub_patterns(env={}), [])

    def test_deep(self):
        out = self.s.deep({'a': [self.name, {'k': PAT + 'ary'}], PAT: 1})
        self.assertNotIn(PAT, json.dumps(out).lower())


class Parsing(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(wd.ymd(wd.parse_time('10/2/2026')), '2026-10-02')
        self.assertEqual(wd.ymd(wd.parse_time('2026-10-02')), '2026-10-02')
        self.assertEqual(wd.iso(wd.parse_time('2026-10-13T15:59:55Z')), '2026-10-13T15:59:55Z')
        self.assertEqual(wd.parse_time('1760371195000').year, 2025)
        self.assertIsNone(wd.parse_time('soon'))
        self.assertEqual(wd.num('  1,234 '), 1234.0)
        self.assertIsNone(wd.num(' - '))
        self.assertEqual(wd.num('(5)'), -5.0)

    def test_phoenix_without_tz_database(self):
        fixed = wd.timezone(wd.timedelta(hours=-7))
        for iso in ('2026-01-15T19:00:00Z', '2026-07-15T19:00:00Z'):
            t = wd.parse_time(iso)
            self.assertEqual(t.astimezone(wd.TZ).strftime('%H:%M'), t.astimezone(fixed).strftime('%H:%M'))

    def test_auto_reply(self):
        self.assertTrue(wd.is_auto_reply(json.dumps({'replyText': 'Automatic reply: away'})))
        self.assertTrue(wd.is_auto_reply(json.dumps({'isAutoReply': True})))
        self.assertFalse(wd.is_auto_reply(json.dumps({'replyText': 'Yes, let us talk Tuesday'})))

    def test_lead_insights_drop_url_fragments(self):
        out = wd.load_lead_insights({'leads': {'9': {'themes': {'pains': ['//fathom.video/share/x)', 'Slow approvals']},
                                                     'next_step': '//fathom.video/share/y)', 'risk': []}}})
        self.assertEqual(out['9']['pains'], ['Slow approvals'])
        self.assertIsNone(out['9']['nextStep'])
        self.assertEqual(wd.load_lead_insights(None), {})


class LeadRules(unittest.TestCase):
    platforms = wd.ad_platforms({'ads': {'platforms': ['Google Ads', 'LinkedIn Ads', 'Reddit Ads', 'OpenAI (ChatGPT) Ads']}})

    def test_campaign_tags_from_config(self):
        self.assertEqual(wd.campaign_tags('sales_outbound (separate sub-source recommended)', 'Example -> New Company (Bad ICP)'),
                         (['job_changer', 'sales'], ['Bad ICP']))
        self.assertEqual(wd.campaign_tags('sales_outbound (intent-triggered)', 'Visitors')[0], ['website_intent', 'sales'])
        self.assertEqual(wd.campaign_tags('exclude', 'Draft')[0], ['excluded'])
        self.assertEqual(wd.campaign_tags(None, 'Unknown')[0], ['unmapped'])

    def test_pipeline_check_names_platform(self):
        ls = wd.LeadSources({'ads': {'platforms': ['LinkedIn Ads', 'OpenAI (ChatGPT) Ads'],
                                     'checks_x': {'acme': 'Paid LinkedIn, confirmed: lead gen form.', 'reddit': '0 traceable leads'}}})
        self.assertEqual(ls.check_for('Acme Corp')['platform'], 'LinkedIn Ads')
        self.assertIsNone(ls.check_for('Acmeworks'))
        self.assertIsNone(ls.check_for('Reddit Fans'), 'a check that does not say Paid <platform> names no lead')
        self.assertEqual(ls.platform_check('reddit'), '0 traceable leads')

    def test_contact_paid_needs_a_paid_signal(self):
        c = lambda **p: {'props': p}
        self.assertIsNone(wd.contact_paid(c(utm_source='chatgpt.com', utm_medium='referral'), self.platforms), 'organic AI referral is not paid')
        r = wd.contact_paid(c(utm_source='chatgpt', utm_medium='cpc'), self.platforms)
        self.assertEqual((r['rule'], r['platform']), ('HubSpot UTM / click id', 'OpenAI (ChatGPT) Ads'))
        self.assertEqual(wd.contact_paid(c(hs_google_click_id='x'), self.platforms)['platform'], 'Google Ads')
        self.assertTrue(wd.contact_paid(c(utm_source='google', utm_medium='cpc', utm_term='brand term'), self.platforms)['branded'])
        self.assertEqual(wd.contact_paid(c(hs_analytics_source='PAID_SOCIAL'), self.platforms)['rule'], 'HubSpot original source')

    def test_review_status_labels(self):
        self.assertEqual(wd.hold_label({'status': 'on_hold_pending_some_one'}), 'On hold, pending Some One')
        self.assertEqual(wd.hold_label({'status': 'on_hold'}), 'On hold')

    def test_check_verdict(self):
        ls = wd.LeadSources({'ads': {'platforms': ['Google Ads', 'Reddit Ads'],
                                     'checks_x': {'acme': 'Not Reddit. Verdict: paid Google branded search.'}}})
        c = ls.check_for('Acme')
        self.assertEqual((c['platform'], c['branded']), ('Google Ads', True))

    def test_call_classification_missing_falls_back(self):
        out, why = wd.load_call_classification('/nonexistent/records.jsonl', lambda *a: None)
        self.assertIsNone(out)
        self.assertIn('not found', why)
        self.assertEqual(wd.load_call_classification(None, lambda *a: None), (None, 'no CALL_CLASSIFICATION path given'))


if __name__ == '__main__':
    unittest.main()


class MqlFunnel(unittest.TestCase):
    """lead_to_mql_rate (config/lead-rules.json "mql"): book-a-demo bookers / lead-form fillers plus bookers."""
    AS_OF = datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc)
    PAGE = wd.RULES['mql']['bookingLinkIds'][0]

    def make(self, meetings, subs):
        import sqlite3
        import tempfile
        path = os.path.join(tempfile.mkdtemp(), 'b.db')
        con = sqlite3.connect(path)
        con.execute('CREATE TABLE hubspot_objects (object_type TEXT, hs_id TEXT, properties_json TEXT, fetched_at TEXT)')
        con.execute('CREATE TABLE hubspot_associations (from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT)')
        for mid, props, contacts in meetings:
            con.execute('INSERT INTO hubspot_objects VALUES (?,?,?,?)', ('meetings', mid, json.dumps(props), ''))
            for c in contacts:
                con.execute('INSERT INTO hubspot_associations VALUES (?,?,?,?)', ('meetings', mid, 'contacts', c))
        con.commit()
        con.close()
        brain = wd.Brain(path)
        contacts = {cid: {'id': cid, 'email': email} for cid, email in
                    [('1', 'a@buyer.example'), ('2', 'b@buyer.example'), ('3', 'me@ours.example'), ('4', 'c@gmail.com'), ('5', 'job@seeker.example')]}
        ls = wd.LeadSources({'forms': [{'id': 'f-demo', 'bucket': 'demo_request'}, {'id': 'f-jobs', 'bucket': 'not_a_lead_source'}]})
        submissions = {}
        for email, form, at in subs:
            submissions.setdefault(email, []).append({'formId': form, 'at': at})
        ctx = {'assoc': wd.Assoc(brain), 'contacts': contacts, 'contact_by_email': {c['email']: c for c in contacts.values()},
               'submissions': submissions, 'internal_domains': {'ours.example', 'gmail.com'}, 'ls': ls}
        return brain, ctx

    def booking(self, page, created='2026-10-01T15:00:00Z', source='MEETINGS_PUBLIC'):
        return {'hs_meeting_source': source, 'hs_created_by_scheduling_page': page, 'hs_createdate': created}

    def run_with(self, show, meetings, subs):
        brain, ctx = self.make(meetings, subs)
        old = wd.RULES['mql'].get('show')
        wd.RULES['mql']['show'] = show
        try:
            return wd.mql_funnel(brain, ctx, self.AS_OF)
        finally:
            wd.RULES['mql']['show'] = old

    def meetings(self):
        return [('m1', self.booking(self.PAGE), ['1']),                              # external booker via book-a-demo
                ('m2', self.booking(self.PAGE), ['3']),                              # internal tester: excluded
                ('m3', self.booking('999'), ['2']),                                  # another scheduling page: not book-a-demo
                ('m4', self.booking(self.PAGE, created='2026-06-01T15:00:00Z'), ['4']),  # outside 90 days
                ('m5', {'hs_meeting_source': 'CRM_UI', 'hs_created_by_scheduling_page': '', 'hs_createdate': '2026-10-02T00:00:00Z'}, [])]

    SUBS = [('b@buyer.example', 'f-demo', '2026-09-01T00:00:00Z'),    # lead form: in the denominator
            ('job@seeker.example', 'f-jobs', '2026-09-01T00:00:00Z'),  # careers: not a lead
            ('me@ours.example', 'f-demo', '2026-09-01T00:00:00Z'),     # internal
            ('c@gmail.com', 'f-demo', '2026-09-02T00:00:00Z')]         # free-mail is never internal

    def test_definition(self):
        f = self.run_with(True, self.meetings(), self.SUBS)
        self.assertTrue(f['available'])
        # bookers {1}; fillers {2, 4}; denominator = fillers + bookers.
        self.assertEqual((f['numerator'], f['denominator'], f['formFillers'], f['bookersWithoutForm']), (1, 3, 2, 1))
        self.assertAlmostEqual(f['rate'], 1 / 3)
        self.assertEqual(f['schedulingPageBookings'], 3)

    def test_hidden_by_config_keeps_the_computed_figures(self):
        f = self.run_with(False, self.meetings(), self.SUBS)
        self.assertFalse(f['available'])
        self.assertEqual(f['reason'], wd.RULES['mql']['hiddenBecause'])
        self.assertEqual((f['computed']['numerator'], f['computed']['denominator']), (1, 3))

    def test_page_ids_that_match_nothing_hide_it_instead_of_showing_zero(self):
        ms = [(m, dict(p, hs_created_by_scheduling_page='999') if p.get('hs_created_by_scheduling_page') == self.PAGE else p, c)
              for m, p, c in self.meetings()]
        f = self.run_with(True, ms, self.SUBS)
        self.assertFalse(f['available'])
        self.assertIn('match none', f['reason'])

    def test_missing_inputs(self):
        ms = [('m1', {'hs_meeting_source': 'MEETINGS_PUBLIC', 'hs_createdate': '2026-10-01T15:00:00Z'}, ['1'])]
        f = self.run_with(True, ms, self.SUBS)
        self.assertFalse(f['available'])
        self.assertIn('hs_created_by_scheduling_page', f['reason'])

    def test_meetings_without_source_are_counted(self):
        ms = self.meetings() + [('m6', {'hs_createdate': '2026-10-05T00:00:00Z'}, ['2'])]
        self.assertEqual(self.run_with(True, ms, self.SUBS)['meetingsWithoutSource'], 1)
