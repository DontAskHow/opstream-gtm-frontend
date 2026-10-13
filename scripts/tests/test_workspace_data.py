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
        contacts = {cid: {'id': cid, 'email': email, 'lifecycle': life, 'companies': []} for cid, email, life in
                    [('1', 'a@buyer.example', 'lead'), ('2', 'b@buyer.example', 'opportunity'), ('3', 'me@ours.example', ''),
                     ('4', 'c@gmail.com', 'lead'), ('5', 'job@seeker.example', ''), ('6', 'd@client.example', 'customer')]}
        ls = wd.LeadSources({'forms': [{'id': 'f-demo', 'bucket': 'demo_request'}, {'id': 'f-jobs', 'bucket': 'not_a_lead_source'}]})
        submissions = {}
        for email, form, at in subs:
            submissions.setdefault(email, []).append({'formId': form, 'at': at})
        ctx = {'assoc': wd.Assoc(brain), 'contacts': contacts, 'contact_by_email': {c['email']: c for c in contacts.values()},
               'submissions': submissions, 'internal_domains': {'ours.example', 'gmail.com'}, 'ls': ls,
               'scope': wd.ReportingScope(contacts, {}, [])}
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
            ('c@gmail.com', 'f-demo', '2026-09-02T00:00:00Z'),         # free-mail is never internal (out after the reporting rules)
            ('d@client.example', 'f-demo', '2026-09-03T00:00:00Z')]    # a customer (out after the reporting rules)

    def test_definition(self):
        f = self.run_with(True, self.meetings(), self.SUBS)
        self.assertTrue(f['available'])
        # bookers {1}; fillers {2, 4, 6}; denominator = fillers + bookers.
        self.assertEqual((f['numerator'], f['denominator'], f['formFillers'], f['bookersWithoutForm']), (1, 4, 3, 1))
        self.assertAlmostEqual(f['rate'], 1 / 4)
        self.assertEqual(f['schedulingPageBookings'], 3)
        # The Oct 13 reporting rules, as a separate figure: the free-mail (4) and customer (6) fillers are out.
        r = f['afterReportingRules']
        self.assertEqual((r['numerator'], r['denominator'], r['formFillers'], r['bookersWithoutForm']), (1, 2, 1, 1))
        self.assertAlmostEqual(r['rate'], 1 / 2)

    def test_hidden_by_config_keeps_the_computed_figures(self):
        f = self.run_with(False, self.meetings(), self.SUBS)
        self.assertFalse(f['available'])
        self.assertEqual(f['reason'], wd.RULES['mql']['hiddenBecause'])
        self.assertEqual((f['computed']['numerator'], f['computed']['denominator']), (1, 4))
        self.assertEqual((f['computed']['afterReportingRules']['numerator'], f['computed']['afterReportingRules']['denominator']), (1, 2))

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


class ReportingRules(unittest.TestCase):
    """The Oct 13 2026 reporting rules (config/lead-rules.json "reporting"), one helper at a time."""
    LS = {'forms': [{'id': 'f1', 'name': 'Guide', 'bucket': 'content_download'},
                    {'id': 'f2', 'name': 'Download: Guide', 'bucket': 'demo_request'},
                    {'id': 'f3', 'name': 'Open Position - Engineer ', 'bucket': 'not_a_lead_source'},
                    {'id': 'f4', 'name': 'Contact Us', 'bucket': 'contact'}],
          'ads': {'platforms': ['Google Ads', 'LinkedIn Ads', 'Reddit Ads', 'OpenAI (ChatGPT) Ads']}}

    def contact(self, cid, email, lifecycle='lead', owner='1', companies=(), **props):
        return {'id': cid, 'email': email, 'lifecycle': lifecycle, 'ownerId': owner, 'companies': list(companies), 'props': props}

    def test_rules_mirror_the_scope_file(self):
        cu = wd.REPORTING['customers']
        self.assertEqual(set(cu['ownerIds']), set(wd.SCOPE['csOwnerIds']))
        self.assertEqual(set(cu['dealPipelines']), {k for k in wd.SCOPE['excludedPipelines'] if k != 'about'})
        self.assertNotIn(wd.REPORTING['meetings']['notPastStages'][0], wd.REPORTING['meetings']['pastDiscoveryStages'])

    def test_event_names_map_by_suffix_longest_first(self):
        ls = wd.LeadSources(self.LS)
        self.assertEqual(ls.form_for_event('Resources | Example: Download: Guide')['id'], 'f2')
        self.assertEqual(ls.form_for_event('Blog | Example: guide')['id'], 'f1')  # case-insensitive
        self.assertEqual(ls.form_for_event('Jobs | Example: Open Position - Engineer ')['id'], 'f3')  # trailing spaces
        self.assertEqual(ls.form_for_event('Contact Us')['id'], 'f4')
        self.assertIsNone(ls.form_for_event('Meetings Link: example/demo'))
        self.assertIsNone(ls.form_for_event('Example: Not Contact Us'))  # a suffix, but not after ': '
        self.assertIsNone(ls.form_for_event(None))

    def test_stage_at(self):
        h = [{'value': '15879262', 'timestamp': '2026-02-01T00:00:00Z'}, {'value': '943743501', 'timestamp': '2026-01-05T00:00:00Z'}]
        at = lambda s: wd.parse_time(s)
        self.assertEqual(wd.stage_at(h, at('2026-01-20T00:00:00Z')), '943743501')
        self.assertEqual(wd.stage_at(h, at('2026-02-01T00:00:00Z')), '15879262')
        self.assertIsNone(wd.stage_at(h, at('2026-01-01T00:00:00Z')))  # the deal did not exist yet
        self.assertIsNone(wd.stage_at([], at('2026-01-01T00:00:00Z')))

    def test_scope_reasons(self):
        cs = wd.REPORTING['customers']['ownerIds'][0]
        comps = {'c1': {'lifecycle': 'customer', 'ownerId': '1'}, 'c2': {'lifecycle': 'lead', 'ownerId': cs},
                 'c3': {'lifecycle': 'opportunity', 'ownerId': '1'}}
        contacts = {c['id']: c for c in [
            self.contact('1', 'a@buyer.example', lifecycle='customer'), self.contact('2', 'b@buyer.example', owner=cs),
            self.contact('3', 'c@buyer.example', companies=['c1']), self.contact('4', 'd@buyer.example', companies=['c2']),
            self.contact('5', 'e@gmail.com'), self.contact('6', 'f@' + wd.REPORTING['contacts']['internalDomains'][0]),
            self.contact('7', 'g@buyer.example', lifecycle='opportunity', companies=['c3'])]}
        deals = [{'id': 'd1', 'pipeline': wd.REPORTING['customers']['dealPipelines'][0]}, {'id': 'd2', 'pipeline': 'default'}]
        sc = wd.ReportingScope(contacts, comps, deals)
        self.assertEqual([(sc.contact(i) or ('in',))[0] for i in '1234567'],
                         ['customer', 'customer', 'customer', 'customer', 'freeMail', 'internal', 'in'])
        self.assertIn('customer success', sc.customer('4'))
        self.assertEqual(sc.dropped_deals, {'d1'})
        self.assertTrue(sc.form_excluded({'name': 'Open Position - Designer'}))
        self.assertFalse(sc.form_excluded({'name': 'Contact Us'}))
        self.assertTrue(sc.careers_event('Careers | Example: Open Position - Designer'))

    def test_ad_touch(self):
        ls = wd.LeadSources(self.LS)
        t = lambda **p: wd.ad_touch(self.contact('9', 'x@buyer.example', **p), ls.platforms)
        url = 'https://www.example.com/p?'
        self.assertEqual(t(hs_analytics_first_url=url + 'utm_source=chatgpt&utm_medium=cpc')[:2], ('paid', 'OpenAI (ChatGPT) Ads'))
        self.assertEqual(t(hs_analytics_first_url=url + 'utm_source=chatgpt.com')[:2], ('ai', None))  # no paid signal: organic
        self.assertEqual(t(hs_analytics_source='AI_REFERRALS')[:2], ('ai', None))
        self.assertEqual(t(hs_analytics_first_referrer='https://chatgpt.com/')[:2], ('ai', None))
        self.assertEqual(t(hs_analytics_first_url=url + 'hsa_net=adwords&kw=example')[:2], ('paid', 'Google Ads'))
        self.assertEqual(t(hs_analytics_first_url=url + 'gclid=x')[:2], ('paid', 'Google Ads'))
        self.assertEqual(t(utm_sourse='linkedin', utm_medium='paid_social')[:2], ('paid', 'LinkedIn Ads'))  # the misspelt field
        self.assertEqual(t(hs_analytics_source='PAID_SOCIAL', hs_analytics_source_data_1='LinkedIn')[:2], ('paid', 'LinkedIn Ads'))
        self.assertEqual(t(hs_analytics_source='PAID_SEARCH', hs_analytics_source_data_1='12345')[:2], ('paid', None))
        self.assertIsNone(t(hs_analytics_first_url=url + 'utm_source=newsletter&utm_medium=email'))
        self.assertIsNone(t(hs_google_click_id='x'))  # not first touch

    def test_conversion_status_never_uses_recent_alone(self):
        ls = wd.LeadSources(self.LS)
        contacts = {}
        ctx = {'ls': ls, 'submissions': {'sub@buyer.example': [{'formId': 'f4'}], 'job@buyer.example': [{'formId': 'f3'}]},
               'booked': {'5'}}
        ctx['scope'] = wd.ReportingScope(contacts, {}, [])
        st = lambda c: wd.conversion_status(c, ctx)
        self.assertEqual(st(self.contact('1', 'sub@buyer.example')), 'lead')
        self.assertEqual(st(self.contact('2', 'job@buyer.example')), 'careers')
        self.assertEqual(st(self.contact('3', 'r@buyer.example', recent_conversion_event_name='Example: Contact Us')), 'noConversion')
        self.assertEqual(st(self.contact('4', 'f@buyer.example', first_conversion_event_name='Example: Open Position - Engineer',
                                         recent_conversion_event_name='Example: Contact Us')), 'lead')
        self.assertEqual(st(self.contact('5', 'b@buyer.example')), 'lead')  # booked through a meetings link
        self.assertEqual(st(self.contact('6', 'n@buyer.example', first_conversion_event_name='Jobs: Open Position - QA')), 'careers')

    def test_blended_stage_probability(self):
        stages = {('default', 's1'): {'pipeline': 'Sales', 'label': 'Demo meeting', 'order': 0, 'closed': False, 'prob': 0.25},
                  ('default', 's2'): {'pipeline': 'Sales', 'label': 'SQL', 'order': 1, 'closed': False, 'prob': 0.05},
                  ('default', 's3'): {'pipeline': 'Sales', 'label': 'Decision', 'order': 2, 'closed': False, 'prob': 0.7}}
        d = lambda i, sid, amount, prob: {'id': i, 'stageId': sid, 'amount': amount, 'probability': prob, 'open': True, 'onHold': False}
        rows = {r['id']: r for r in wd.headline([d('1', 's1', 100000, 0.25), d('2', 's1', 300000, 0.5), d('3', 's2', 20000, 0.05),
                                                 d('4', 's2', None, 0.05)], stages)['stages']}
        self.assertAlmostEqual(rows['s1']['blendedProbability'], 175000 / 400000)
        self.assertTrue(rows['s1']['probabilityMixed'])
        self.assertAlmostEqual(rows['s2']['blendedProbability'], 0.05)
        self.assertFalse(rows['s2']['probabilityMixed'])
        self.assertIsNone(rows['s3']['blendedProbability'])  # no amount
        self.assertFalse(rows['s3']['probabilityMixed'])


class ReportingNotYetSynced(unittest.TestCase):
    """Before the new sync and the first-touch backfill: the flags stay false and the opportunity rule is unchecked."""
    URL = 'https://www.example.com/p?utm_source=chatgpt&utm_medium=cpc'

    def brain(self, contacts=(), backfill=None, meetings=(), assoc=()):
        import sqlite3
        import tempfile
        path = os.path.join(tempfile.mkdtemp(), 'b.db')
        con = sqlite3.connect(path)
        con.execute('CREATE TABLE hubspot_objects (object_type TEXT, hs_id TEXT, properties_json TEXT, fetched_at TEXT)')
        con.execute('CREATE TABLE hubspot_associations (from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT)')
        con.execute('CREATE TABLE sync_state (source TEXT PRIMARY KEY, watermark TEXT, last_run TEXT, note TEXT)')
        for kind, rows in (('contacts', contacts), ('meetings', meetings)):
            for i, props in rows:
                con.execute('INSERT INTO hubspot_objects VALUES (?,?,?,?)', (kind, i, json.dumps(props), ''))
        for row in assoc:
            con.execute('INSERT INTO hubspot_associations VALUES (?,?,?,?)', row)
        if backfill is not None:
            con.execute("INSERT INTO sync_state VALUES ('hubspot_contact_backfill', ?, '', '')", (json.dumps(backfill),))
        con.commit()
        con.close()
        brain = wd.Brain(path)
        self.addCleanup(brain.con.close)
        return brain

    def synced(self, brain):
        present = [p for p in wd.REPORTING_CONTACT_PROPS if p != 'hs_analytics_first_referrer']
        return wd.reporting_fields_synced(brain, present)

    def test_first_url_partial_coverage_is_not_synced(self):
        added = wd.REPORTING['adLeads']['contactFields']['addedAt']['hs_analytics_first_url']
        before = '2026-10-13T18:00:00+00:00'
        self.assertLess(wd.parse_time(before), wd.parse_time(added))
        # One incremental run wrote the new key (JSON null when unset) onto 3 of 10 contacts; the older fields are on all.
        contacts = [(str(i), {'num_conversion_events': '1', 'recent_conversion_event_name': None, 'recent_conversion_date': None,
                              **({'hs_analytics_first_url': self.URL if i == 0 else None} if i < 3 else {})}) for i in range(10)]
        cases = [
            (None, False),                                                     # no backfill
            ({'done': True, 'startedAt': before}, False),                      # the backfill before the field existed
            ({'afterId': '5', 'startedAt': '2026-10-14T01:00:00+00:00'}, False),  # the first-touch backfill, still running
            ({'done': True, 'startedAt': '2026-10-14T01:00:00+00:00'}, True),  # ... finished
        ]
        for backfill, want in cases:
            synced, coverage = self.synced(self.brain(contacts, backfill))
            self.assertIs(synced['hs_analytics_first_url'], want, backfill)
            self.assertEqual(coverage['hs_analytics_first_url'], 0.3)
            self.assertTrue(synced['num_conversion_events'])  # full coverage
            self.assertFalse(synced['hs_analytics_first_referrer'])  # never stored
        # Coverage alone: every contact carries the key (most of them as null).
        full = [(i, dict(p, hs_analytics_first_url=p.get('hs_analytics_first_url'))) for i, p in contacts]
        synced, coverage = self.synced(self.brain(full, {'done': True, 'startedAt': before}))
        self.assertTrue(synced['hs_analytics_first_url'])
        self.assertEqual(coverage['hs_analytics_first_url'], 1.0)
        # 98 of 100 is below minCoverage (0.99).
        many = [(str(i), {'hs_analytics_first_url': None} if i < 98 else {}) for i in range(100)]
        synced, coverage = wd.reporting_fields_synced(self.brain(many), ['hs_analytics_first_url'])
        self.assertEqual((synced['hs_analytics_first_url'], coverage['hs_analytics_first_url']), (False, 0.98))

    def test_ad_leads_flag_follows_the_synced_check(self):
        ls = wd.LeadSources(ReportingRules.LS)
        c = {'id': '1', 'email': 'x@buyer.example', 'lifecycle': 'lead', 'ownerId': '', 'companies': [],
             'props': {'hs_analytics_first_url': self.URL}}
        ctx = {'ls': ls, 'contacts': {'1': c}, 'submissions': {}, 'booked': {'1'}, 'scope': wd.ReportingScope({'1': c}, {}, []),
               'reporting_synced': {'hs_analytics_first_url': False}, 'reporting_coverage': {'hs_analytics_first_url': 0.3}}
        ad = wd.ad_leads(ctx)
        self.assertFalse(ad['firstUrlSynced'])
        self.assertEqual(ad['firstUrlCoverage'], 0.3)
        self.assertEqual(next(p['leads'] for p in ad['platforms'] if p['key'] == 'openai'), 1)  # counted, flagged partial

    def booking(self, created='2026-10-01T15:00:00Z'):
        return {'hs_meeting_source': 'MEETINGS_PUBLIC', 'hs_createdate': created}

    def bookings(self, deals):
        meetings = [(m, self.booking()) for m in ('m1', 'm2', 'm3', 'm4')]
        assoc = [('meetings', m, 'contacts', '1') for m, _ in meetings] + [('meetings', m, 'deals', d) for m, d in
                                                                             [('m1', 'd1'), ('m2', 'd2'), ('m3', 'd3')]]
        brain = self.brain(meetings=meetings, assoc=assoc)
        c = {'id': '1', 'email': 'a@buyer.example', 'lifecycle': 'lead', 'ownerId': '', 'companies': []}
        ctx = {'assoc': wd.Assoc(brain), 'deal_by_id': {d['id']: d for d in deals}, 'scope': wd.ReportingScope({'1': c}, {}, deals)}
        return wd.booking_counts(brain, ctx)

    def test_bookings_before_stage_history_and_customer_deals(self):
        cu, mt = wd.REPORTING['customers'], wd.REPORTING['meetings']
        sales = mt['dealPipeline']
        deals = [{'id': 'd1', 'pipeline': sales, 'ownerId': cu['ownerIds'][0], 'stageHistory': None},  # customer-success owned
                 {'id': 'd2', 'pipeline': cu['dealPipelines'][0], 'ownerId': '7', 'stageHistory': None},  # a customer pipeline: counted
                 {'id': 'd3', 'pipeline': sales, 'ownerId': '7', 'stageHistory': None}]                 # sales, history not synced
        b = self.bookings(deals)
        self.assertEqual((b['total'], b['customer'], b['opportunity'], b['afterRules']), (4, 1, 0, 3))
        self.assertFalse(b['stageHistorySynced'])
        self.assertEqual(b['opportunityUnchecked'], 1)
        # Once synced, a past-Discovery stage at booking time takes the booking out.
        deals[2]['stageHistory'] = [{'value': mt['pastDiscoveryStages'][0], 'timestamp': '2026-09-01T00:00:00Z'}]
        b = self.bookings(deals)
        self.assertEqual((b['customer'], b['opportunity'], b['afterRules'], b['opportunityUnchecked']), (1, 1, 2, 0))
        self.assertTrue(b['stageHistorySynced'])

    def test_scope_marks_customer_deals(self):
        cu = wd.REPORTING['customers']
        sc = wd.ReportingScope({}, {}, [{'id': 'd1', 'pipeline': 'default', 'ownerId': cu['ownerIds'][1]},
                                        {'id': 'd2', 'pipeline': cu['dealPipelines'][2], 'ownerId': ''},
                                        {'id': 'd3', 'pipeline': 'default', 'ownerId': '7'}])
        self.assertIn('customer success', sc.customer_deal('d1'))
        self.assertIsNone(sc.customer_deal('d2'))  # an excluded pipeline only drops the deal
        self.assertIsNone(sc.customer_deal('d3'))
        self.assertIsNone(sc.customer_deal('nope'))
        self.assertEqual(sc.dropped_deals, {'d2'})


if __name__ == '__main__':
    unittest.main()
