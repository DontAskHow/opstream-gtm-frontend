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
PAT = wd.SCOPE['hiddenOwner']['pattern']


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
        self.s = wd.Scrubber(PAT, [name, PAT + '@example.com'])
        self.name = name

    def test_text_and_person(self):
        self.assertEqual(self.s.text('Booked by %s.' % self.name), 'Booked by Unassigned.')
        self.assertEqual(self.s.text('mail %s@example.com now' % PAT), 'mail Unassigned now')
        self.assertEqual(self.s.person(PAT.upper()), 'Unassigned')
        self.assertEqual(self.s.person('not assigned'), 'Unassigned')
        self.assertEqual(self.s.person('Alex'), 'Alex')

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


if __name__ == '__main__':
    unittest.main()
