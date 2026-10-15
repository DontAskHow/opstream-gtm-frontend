"""End-to-end tests for the HubSpot and Lemlist syncs.

Each test copies refresh/brain-sync to a temp dir (as run.py does), seeds a
brain.db, and runs the real entrypoints (`python3 hubspot_sync.py`,
`python3 lemlist_sync.py`) as subprocesses against the fakes in fakes.py.
Assertions are on the resulting SQLite tables, watermarks and sync_outcomes,
and on the requests the fakes received.

Run from the repo root:

    python3 -m unittest discover -s refresh/tests -v

Needs python3 with boto3 (as the refresh image has) and the openssl CLI.
Takes about three to four minutes, mostly the scripts' own request pacing.
"""

import contextlib
import copy
import io
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fakes  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SYNC_SRC = ROOT / "refresh" / "brain-sync"

MEETING_PROPS = ("hs_meeting_source", "hs_meeting_source_id", "hs_activity_type")
# Never requested or stored: free text, internal bookkeeping, conference links that can carry passcodes.
MEETING_PROPS_NEVER = ("hs_internal_meeting_notes", "hs_scheduled_tasks", "hs_meeting_location",
                       "hs_meeting_external_url")

# Read-only POSTs the HubSpot sync may send; everything else must be GET.
HUBSPOT_POSTS = re.compile(r"^(/oauth/v1/token|/crm/v3/objects/[^/]+/search|/crm/v3/lists/search"
                           r"|/crm/v3/objects/[^/]+/batch/read|/crm/v4/associations/[^/]+/[^/]+/batch/read)$")


def seed_db(path, now):
    con = sqlite3.connect(str(path))
    con.executescript("""
        CREATE TABLE sync_state(source TEXT PRIMARY KEY, watermark TEXT, last_run TEXT, note TEXT);
        CREATE TABLE hubspot_objects(object_type TEXT, hs_id TEXT, properties_json TEXT, fetched_at TEXT,
                                     PRIMARY KEY(object_type, hs_id));
        CREATE TABLE hubspot_associations(from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT,
                                          PRIMARY KEY(from_type, from_id, to_type, to_id));
        CREATE TABLE lemlist_campaigns(campaign_id TEXT PRIMARY KEY, name TEXT, status TEXT, raw_json TEXT,
                                       fetched_at TEXT);
    """)
    # Contacts stored before the attribution properties existed.
    for i in range(101, 151):
        con.execute("INSERT INTO hubspot_objects VALUES('contacts', ?, ?, '2026-01-01T00:00:00+00:00')",
                    (str(i), json.dumps({"hs_object_id": str(i), "email": "contact%d@example.com" % i,
                                         "jobtitle": "Stored title"})))
    since = fakes.iso(now - timedelta(days=1))
    marks = {t: since for t in ("contacts", "companies", "deals", "emails", "notes", "tasks", "calls",
                                "meetings", "products", "line_items")}
    con.execute("INSERT INTO sync_state VALUES('hubspot', ?, ?, 'seed')", (json.dumps(marks), since))
    con.commit()
    con.close()


class SyncE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="sync-e2e-"))
        cls.world = fakes.FakeWorld(cls.tmp).start()
        cls.sync_dir = cls.tmp / "brain-sync"
        shutil.copytree(SYNC_SRC, cls.sync_dir, ignore=shutil.ignore_patterns("logs", "__pycache__"))
        cls.db = cls.tmp / "brain.db"
        seed_db(cls.db, cls.world.now)

    @classmethod
    def tearDownClass(cls):
        cls.world.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_sync(self, script, **env_extra):
        self.world.take_requests()
        env = self.world.env(os.environ, self.db)
        env.update({k: str(v) for k, v in env_extra.items()})
        proc = subprocess.run([sys.executable, str(self.sync_dir / script)], env=env, cwd=str(self.tmp),
                              capture_output=True, text=True, timeout=600)
        reqs = self.world.take_requests()
        self.assertEqual(proc.returncode, 0, "%s exited %s\n%s\n%s" % (script, proc.returncode,
                                                                      proc.stdout[-4000:], proc.stderr[-4000:]))
        self.assertEqual(self.world.refused_connects, [], "a sync tried to reach a host other than the fakes")
        for secret in (fakes.ACCESS_TOKEN, fakes.REFRESH_TOKEN, fakes.LEMLIST_KEY, "test-client-secret"):
            self.assertNotIn(secret, proc.stdout + proc.stderr, "a credential reached the log")
        return reqs, proc.stdout

    def q(self, sql, *args):
        con = sqlite3.connect(str(self.db))
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def outcome(self, source):
        rows = self.q("SELECT ok, route, http, detail FROM sync_outcomes WHERE source=?", source)
        self.assertEqual(len(rows), 1, "no sync_outcomes row for " + source)
        return rows[0]

    def state(self, source):
        rows = self.q("SELECT watermark FROM sync_state WHERE source=?", source)
        return rows[0][0] if rows else None

    @contextlib.contextmanager
    def fresh_db(self, name):
        """Point the syncs at a new seeded brain.db, and put the fakes back afterwards."""
        db = self.tmp / name
        seed_db(db, self.world.now)
        hub, lem = self.world.hubspot, self.world.lemlist
        saved = (self.db, copy.deepcopy(hub.forms), copy.deepcopy(hub.submissions), copy.deepcopy(hub.members),
                 list(lem.activities))
        self.db = db
        try:
            yield db
        finally:
            self.db, hub.forms, hub.submissions, hub.members, lem.activities = saved
            hub.forms_status, hub.lists_shape, hub.members_status = 200, None, {}
            hub.submissions_error = {}
            hub.meeting_properties_status, hub.fail_meeting_backfill_after = 200, None
            hub.archived_meetings = []

    def assert_hubspot_read_only(self, reqs):
        hs = [r for r in reqs if r.host == fakes.HUBSPOT_HOST]
        self.assertTrue(hs)
        bad = [r for r in hs if not (r.method == "GET" or (r.method == "POST" and HUBSPOT_POSTS.match(r.path)))]
        self.assertEqual(bad, [], "HubSpot calls other than GET and read-only POSTs")
        self.assertTrue(all(r.method == "POST" for r in reqs if r.host == "secretsmanager"))

    # ------------------------------------------------------------ HubSpot

    def test_hubspot(self):
        hub = self.world.hubspot
        forms = [f["id"] for f in hub.forms]          # 120, 3, 0 submissions; the last is archived (5)
        f1, f2, archived = forms[0], forms[1], forms[3]

        # Run 1: imports scope missing (403); a 429 on the forms list and on one form's submissions;
        # the contact backfill, due on its own (props key), turned off.
        hub.imports_status = 403
        hub.once_429 = {"forms", "submissions:" + f2}
        reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0)
        self.assert_hubspot_read_only(reqs)
        self.assertEqual(self.outcome("hubspot")[0], 1)

        # Attribution and discovered custom properties are requested with the incremental contacts.
        body = next(r.json() for r in reqs if r.path == "/crm/v3/objects/contacts/search")
        for prop in ("hs_analytics_source", "hs_latest_source_data_2", "first_conversion_date", "hs_object_source",
                     "hs_google_click_id", "hs_lifecyclestage_customer_date", "utm_source", "utm_campaign",
                     "paid_touch_campaign", "num_conversion_events", "recent_conversion_event_name",
                     "recent_conversion_date"):
            self.assertIn(prop, body["properties"])
        self.assertNotIn("favorite_color", body["properties"])

        # Meetings: source fields, plus the booking link properties the portal lists (one matched by
        # name, one by label). Internal notes and unrelated properties are not requested.
        body = next(r.json() for r in reqs if r.path == "/crm/v3/objects/meetings/search")
        for prop in MEETING_PROPS + ("test_booking_page_url", "test_link_used"):
            self.assertIn(prop, body["properties"])
        for prop in MEETING_PROPS_NEVER + ("favorite_room",):
            self.assertNotIn(prop, body["properties"])
        props = json.loads(self.q("SELECT properties_json FROM hubspot_objects WHERE object_type='meetings' "
                                  "AND hs_id='7001'")[0][0])
        self.assertEqual((props["hs_meeting_source"], props["test_booking_page_url"]),
                         ("MEETINGS_PUBLIC", "https://example.com/book/test"))
        for prop in MEETING_PROPS_NEVER:
            self.assertNotIn(prop, props)
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_objects WHERE object_type='meetings'")[0][0], 2)
        props = json.loads(self.q("SELECT properties_json FROM hubspot_objects WHERE object_type='contacts' "
                                  "AND hs_id='101'")[0][0])
        self.assertEqual(props["hs_analytics_source"], "PAID_SEARCH")
        self.assertEqual(props["utm_source"], "newsletter")

        # Forms: three active over two pages, one archived; every submission once.
        self.assertEqual(self.q("SELECT COUNT(*), SUM(archived) FROM hubspot_forms")[0], (4, 1))
        self.assertEqual(self.q("SELECT archived FROM hubspot_forms WHERE form_id=?", archived)[0][0], 1)
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions")[0][0], 128)
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id=?", f1)[0][0], 120)
        row = self.q("SELECT contact_email, page_url, page_title, submitted_at, values_json FROM "
                     "hubspot_form_submissions WHERE form_id=? AND conversion_id=?", f1, "1-c0")[0]
        self.assertEqual(row[:3], ("sub0@example.com", "https://example.com/p", "Test page"))
        self.assertTrue(row[3].endswith("+00:00"))
        self.assertEqual(json.loads(row[4])[0]["name"], "email")
        marks = json.loads(self.state("hubspot_forms"))
        self.assertEqual(sorted(marks), sorted(forms))
        self.assertEqual(marks[f1], hub.submissions[f1][0]["submittedAt"])
        self.assertEqual(sum(1 for r in reqs if r.path.endswith(f1)), 3)    # 120 at 50 a page
        self.assertEqual(sum(1 for r in reqs if r.path.endswith(f2)), 2)    # 429, then the retry
        self.assertEqual(sum(1 for r in reqs if r.path == "/marketing/v3/forms"), 4)  # 429 + 2 pages + archived
        self.assertEqual(self.outcome("hubspot_forms")[0], 1)

        # Lists: all three stored, memberships for the two contact lists only.
        self.assertEqual(self.q("SELECT list_id, object_type, size FROM hubspot_lists ORDER BY list_id"),
                         [("11", "0-1", 300), ("12", "0-1", 3), ("13", "0-2", 2)])
        self.assertEqual(self.q("SELECT list_id, COUNT(*) FROM hubspot_list_memberships GROUP BY list_id"),
                         [("11", 300), ("12", 3)])
        self.assertIsNotNone(self.q("SELECT added_at FROM hubspot_list_memberships LIMIT 1")[0][0])
        self.assertFalse([r for r in reqs if r.path == "/crm/v3/lists/13/memberships"])
        self.assertEqual(sum(1 for r in reqs if r.path == "/crm/v3/lists/search"), 2)
        self.assertIsNotNone(self.state("hubspot_lists"))
        self.assertEqual(self.outcome("hubspot_lists")[0], 1)

        # Imports failed alone: recorded, nothing else affected.
        ok, route, http, _detail = self.outcome("hubspot_imports")
        self.assertEqual((ok, route, http), (0, "GET /crm/v3/imports", 403))
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_imports")[0][0], 0)
        self.assertFalse(self.q("SELECT 1 FROM sync_outcomes WHERE source='hubspot_contact_backfill'"))
        self.assertFalse([r for r in reqs if r.path == "/crm/v3/objects/contacts/search"
                          and r.json()["filterGroups"][0]["filters"][0]["propertyName"] == "hs_object_id"])

        # Run 2: two new submissions; imports allowed; backfill starts and its second page fails.
        hub.add_submissions(f1, 2)
        hub.imports_status = 200
        hub.fail_backfill_after = 300
        reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=1)
        self.assert_hubspot_read_only(reqs)
        self.assertEqual(self.outcome("hubspot")[0], 1)
        self.assertEqual(sum(1 for r in reqs if r.path.endswith(f1)), 1)   # stops at the watermark
        self.assertFalse([r for r in reqs if r.path.endswith(archived)])   # archived forms are read once
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions")[0][0], 130)
        self.assertEqual(json.loads(self.state("hubspot_forms"))[f1], hub.submissions[f1][0]["submittedAt"])
        self.assertFalse([r for r in reqs if r.path.endswith("/memberships")])  # within LIST_MIN_INTERVAL_MIN
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_imports")[0][0], 2)
        self.assertEqual(self.outcome("hubspot_imports")[0], 1)
        ok, route, http, _detail = self.outcome("hubspot_contact_backfill")
        self.assertEqual((ok, route, http), (0, "POST /crm/v3/objects/contacts/search", 500))
        bf = json.loads(self.state("hubspot_contact_backfill"))
        self.assertEqual((bf["afterId"], bf["count"], bf.get("done")), ("300", 200, None))
        stored = json.loads(self.q("SELECT properties_json FROM hubspot_objects WHERE object_type='contacts' "
                                   "AND hs_id='120'")[0][0])
        self.assertEqual((stored["jobtitle"], stored["hs_lifecyclestage_lead_date"] is not None),
                         ("Stored title", True))  # merged, not replaced

        # Run 3: the backfill resumes after id 300 and finishes; memberships are due again.
        hub.fail_backfill_after = None
        hub.members["12"] = [101, 103]
        reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=1, LIST_MIN_INTERVAL_MIN=0)
        self.assert_hubspot_read_only(reqs)
        keyset = [r.json() for r in reqs if r.path == "/crm/v3/objects/contacts/search"
                  and r.json()["filterGroups"][0]["filters"][0]["propertyName"] == "hs_object_id"]
        self.assertEqual([b["filterGroups"][0]["filters"][0]["value"] for b in keyset], ["300", "500"])
        self.assertIn("utm_campaign", keyset[0]["properties"])
        bf = json.loads(self.state("hubspot_contact_backfill"))
        self.assertEqual((bf["afterId"], bf["count"], bf["done"]), ("550", 450, True))
        self.assertEqual(self.outcome("hubspot_contact_backfill")[0], 1)
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_objects WHERE object_type='contacts'")[0][0], 450)
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_objects WHERE object_type='contacts' AND "
                                "json_extract(properties_json, '$.paid_touch_campaign')='pt-test'")[0][0], 450)
        self.assertEqual(self.q("SELECT record_id FROM hubspot_list_memberships WHERE list_id='12' "
                                "ORDER BY record_id"), [("101",), ("103",)])

        # Run 4: a finished backfill is not repeated.
        reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=1)
        self.assertFalse([r for r in reqs if r.path == "/crm/v3/objects/contacts/search"
                          and r.json()["filterGroups"][0]["filters"][0]["propertyName"] == "hs_object_id"])
        self.assertIn("already complete", self.outcome("hubspot_contact_backfill")[3])
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions")[0][0], 130)

    def test_hubspot_caps_resume(self):
        """First submission pulls and membership reads stop at their per-run caps and resume."""
        hub = self.world.hubspot
        with self.fresh_db("caps.db"):
            forms = [f["id"] for f in hub.forms]
            f1 = forms[0]
            n1 = len(hub.submissions[f1])                      # over 100: three pages of 50
            self.assertGreater(n1, 100)
            caps = {"FORM_SUBMISSION_MAX_CALLS": 2, "LIST_MEMBERSHIP_MAX_CALLS": 1}

            # Run 1: two pages of the first form, one page of list 11. Nothing marked done.
            reqs, _out = self.run_sync("hubspot_sync.py", **caps)
            self.assert_hubspot_read_only(reqs)
            self.assertEqual(sum(1 for r in reqs if r.path.startswith("/form-integrations/")), 2)
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id=?", f1)[0][0], 100)
            self.assertEqual(json.loads(self.state("hubspot_forms") or "{}"), {})
            self.assertEqual(json.loads(self.state("hubspot_forms_progress"))["cursors"][f1]["after"], "100")
            ok, _route, _http, detail = self.outcome("hubspot_forms")
            self.assertEqual(ok, 1)
            self.assertIn("FORM_SUBMISSION_MAX_CALLS reached", detail)
            self.assertEqual(sum(1 for r in reqs if r.path.endswith("/memberships")), 1)
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_list_memberships")[0][0], 0)
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_list_memberships_pending "
                                    "WHERE list_id='11'")[0][0], 250)
            self.assertEqual(json.loads(self.state("hubspot_lists"))["resume"], {"listId": "11", "after": "250"})
            self.assertIn("LIST_MEMBERSHIP_MAX_CALLS reached", self.outcome("hubspot_lists")[3])

            # Run 2: both resume from their cursors and finish; the next form and list wait.
            reqs, _out = self.run_sync("hubspot_sync.py", **caps)
            subs = [r for r in reqs if r.path.startswith("/form-integrations/")]
            self.assertEqual((subs[0].path.endswith(f1), subs[0].query.get("after")), (True, "100"))
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id=?", f1)[0][0], n1)
            self.assertEqual(json.loads(self.state("hubspot_forms"))[f1], hub.submissions[f1][0]["submittedAt"])
            self.assertNotIn(f1, json.loads(self.state("hubspot_forms_progress"))["cursors"])
            members = [r for r in reqs if r.path.endswith("/memberships")]
            self.assertEqual([(r.path, r.query.get("after")) for r in members],
                             [("/crm/v3/lists/11/memberships", "250")])
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_list_memberships WHERE list_id='11'")[0][0],
                             len(hub.members["11"]))

            # Runs 3 and 4: the rest. Run 5, uncapped: incremental only, memberships not due.
            for _ in range(2):
                self.run_sync("hubspot_sync.py", **caps)
            self.assertEqual(sorted(json.loads(self.state("hubspot_forms"))), sorted(forms))
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions")[0][0],
                             sum(len(v) for v in hub.submissions.values()))
            self.assertEqual(self.q("SELECT list_id, COUNT(*) FROM hubspot_list_memberships GROUP BY list_id"),
                             [("11", len(hub.members["11"])), ("12", len(hub.members["12"]))])
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_list_memberships_pending")[0][0], 0)
            self.assertIsNone(json.loads(self.state("hubspot_lists"))["resume"])
            reqs, _out = self.run_sync("hubspot_sync.py")
            self.assertEqual(sum(1 for r in reqs if r.path.startswith("/form-integrations/")), 3)  # active forms
            self.assertFalse([r for r in reqs if r.path.endswith("/memberships")])

    def test_hubspot_odd_answers(self):
        """A 403 on forms, odd list answers, a failing list, an archived form, bad submittedAt, restart."""
        hub = self.world.hubspot
        with self.fresh_db("odd.db") as db:
            now = self.world.now
            forms = [f["id"] for f in hub.forms]
            f2 = forms[1]
            # Newest submission of f2: no usable submittedAt, and fields over the 8000-char limit.
            hub.submissions[f2].insert(0, {"conversionId": "bad-ts", "submittedAt": "not-a-number",
                                           "pageUrl": "https://example.com/p?q=" + "x" * 9000, "pageTitle": "Test",
                                           "values": [{"name": "message", "value": "y" * 9000}]})
            reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL="restart")
            self.assertEqual(self.outcome("hubspot_forms")[0], 1)
            row = self.q("SELECT submitted_at, page_url, values_json FROM hubspot_form_submissions "
                         "WHERE conversion_id='bad-ts'")[0]
            self.assertIsNone(row[0])
            self.assertEqual(len(row[1]), 8000)
            self.assertEqual(len(json.loads(row[2])[0]["value"]), 8000)
            self.assertEqual(json.loads(self.state("hubspot_forms"))[f2],
                             max(s["submittedAt"] for s in hub.submissions[f2][1:]))
            lists = self.q("SELECT * FROM hubspot_lists ORDER BY list_id")
            members = self.q("SELECT * FROM hubspot_list_memberships ORDER BY list_id, record_id")
            self.assertEqual(len(lists), 3)
            self.assertTrue(members)
            self.assertTrue(json.loads(self.state("hubspot_contact_backfill"))["done"])

            # Run 2: forms 403, lists without a lists array. Both fail alone and say so on stdout;
            # stored lists and memberships stay. restart is not repeated.
            hub.forms_status = 403
            hub.lists_shape = "no-lists"
            reqs, out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL="restart")
            self.assertEqual(self.outcome("hubspot")[0], 1)
            self.assertEqual(self.outcome("hubspot_forms")[:3], (0, "GET /marketing/v3/forms", 403))
            self.assertEqual(self.outcome("hubspot_lists")[:3], (0, "POST /crm/v3/lists/search", 200))
            self.assertEqual(self.outcome("hubspot_imports")[0], 1)
            self.assertIn("EXTRA_PULL_FAILED hubspot_forms GET /marketing/v3/forms 403", out)
            self.assertIn("EXTRA_PULL_FAILED hubspot_lists POST /crm/v3/lists/search 200", out)
            self.assertNotIn("EXTRA_PULL_FAILED hubspot_imports", out)
            self.assertFalse([r for r in reqs if r.path.startswith("/form-integrations/")])
            self.assertEqual(self.q("SELECT * FROM hubspot_lists ORDER BY list_id"), lists)
            self.assertEqual(self.q("SELECT * FROM hubspot_list_memberships ORDER BY list_id, record_id"), members)
            self.assertFalse([r for r in reqs if r.path == "/crm/v3/objects/contacts/search"
                              and r.json()["filterGroups"][0]["filters"][0]["propertyName"] == "hs_object_id"])
            self.assertIn("already complete", self.outcome("hubspot_contact_backfill")[3])

            # Run 3: an empty catalog is not mirrored either. f2, archived after its watermark,
            # is read once more and its new submission lands.
            hub.forms_status = 200
            hub.lists_shape = "empty"
            hub.forms[1]["archived"] = True
            hub.add_submissions(f2, 1)
            reqs, out = self.run_sync("hubspot_sync.py")
            self.assertEqual(self.outcome("hubspot_lists")[:3], (0, "POST /crm/v3/lists/search", 200))
            self.assertIn("EXTRA_PULL_FAILED hubspot_lists", out)
            self.assertEqual(self.q("SELECT * FROM hubspot_lists ORDER BY list_id"), lists)
            self.assertEqual(self.q("SELECT * FROM hubspot_list_memberships ORDER BY list_id, record_id"), members)
            self.assertEqual(self.outcome("hubspot_forms")[0], 1)
            self.assertEqual(sum(1 for r in reqs if r.path.endswith(f2)), 1)
            self.assertEqual(self.q("SELECT archived FROM hubspot_forms WHERE form_id=?", f2)[0][0], 1)
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id=?", f2)[0][0],
                             len(hub.submissions[f2]))

            # Run 4: both lists were last read 7 hours ago, so both are due; list 12's memberships
            # fail. List 11 is refreshed and marked; 12 is not.
            hub.lists_shape = None
            hub.members_status = {"12": 500}
            old = fakes.iso(now - timedelta(hours=7)).replace(".000Z", "+00:00")
            state = dict(json.loads(self.state("hubspot_lists")), refreshed={"11": old, "12": old})
            con = sqlite3.connect(str(db))
            con.execute("UPDATE sync_state SET watermark=? WHERE source='hubspot_lists'", (json.dumps(state),))
            con.commit()
            con.close()
            before = state["refreshed"]
            reqs, out = self.run_sync("hubspot_sync.py")
            self.assertFalse([r for r in reqs if r.path.endswith(f2)])          # archived: read once more only
            self.assertEqual(self.outcome("hubspot_lists")[:3], (0, "GET /crm/v3/lists/{listId}/memberships", 500))
            self.assertIn("EXTRA_PULL_FAILED hubspot_lists GET /crm/v3/lists/{listId}/memberships 500", out)
            after = json.loads(self.state("hubspot_lists"))["refreshed"]
            self.assertEqual((after["11"] > before["11"], after["12"]), (True, before["12"]))
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_list_memberships WHERE list_id='12'")[0][0],
                             len(hub.members["12"]))                            # the old rows stay

            # Run 5: list 12 is retried at once; list 11, just read, is not due.
            hub.members_status = {}
            reqs, _out = self.run_sync("hubspot_sync.py")
            self.assertEqual([r.path for r in reqs if r.path.endswith("/memberships")],
                             ["/crm/v3/lists/12/memberships"])
            self.assertEqual(self.outcome("hubspot_lists")[0], 1)
            self.assertGreater(json.loads(self.state("hubspot_lists"))["refreshed"]["12"], before["12"])

    def test_hubspot_forms_not_exportable(self):
        """A form whose submissions can't be exported is skipped, not a failure; so are others of its
        formType and of HUBSPOT_FORMS_SKIP_TYPES, without a request. Re-checked weekly."""
        hub = self.world.hubspot
        route = "GET /form-integrations/v1/submissions/forms/{formGuid}"
        refusal = (400, {"status": "error", "message": "Submissions can't be exported for this form.",
                         "errorType": "FORM_TYPE_NOT_SUPPORTED", "correlationId": "test"})
        with self.fresh_db("not-exportable.db") as db:
            f1, f2, f3, archived = [f["id"] for f in hub.forms]
            # f2 and the extra f5 are of a type HubSpot won't export; the archived form's type is
            # listed in HUBSPOT_FORMS_SKIP_TYPES.
            f5 = "f0000000-0000-4000-8000-000000000005"
            hub.forms.append(dict(hub.forms[1], id=f5, name="Test form 5"))
            hub.submissions[f5] = [hub._submission(f5, k, self.world.now - timedelta(hours=3 + k)) for k in range(2)]
            hub.forms[1]["formType"] = hub.forms[4]["formType"] = "captured"
            hub.forms[3]["formType"] = "flow"
            env = {"HUBSPOT_FORMS_SKIP_TYPES": " flow, test-unused "}
            # hubspot_forms as older code created it, without submissions_exportable.
            con = sqlite3.connect(str(db))
            con.execute("CREATE TABLE hubspot_forms(form_id TEXT PRIMARY KEY, name TEXT, form_type TEXT, "
                        "created_at TEXT, updated_at TEXT, archived INTEGER, raw_json TEXT, fetched_at TEXT)")
            con.execute("INSERT INTO hubspot_forms(form_id, name) VALUES(?, 'Stored form')", (f1,))
            con.commit()
            con.close()

            def exportable():
                return dict(self.q("SELECT form_id, submissions_exportable FROM hubspot_forms"))

            def progress():
                return json.loads(self.state("hubspot_forms_progress"))

            def asked(reqs, fid):
                return sum(1 for r in reqs if r.path.endswith("/submissions/forms/" + fid))

            def outcome_row():
                return self.q("SELECT ok, route, http, detail, at, last_ok_at FROM sync_outcomes "
                              "WHERE source='hubspot_forms'")[0]

            def checked_days_ago(days):
                state = progress()
                when = fakes.iso(self.world.now - timedelta(days=days)).replace(".000Z", "+00:00")
                state["notExportable"][f2] = when
                state["notExportableTypes"]["captured"] = when
                con = sqlite3.connect(str(db))
                con.execute("UPDATE sync_state SET watermark=? WHERE source='hubspot_forms_progress'",
                            (json.dumps(state),))
                con.commit()
                con.close()

            # Run 1: f2 is refused; f5 (same type, later in the run) and the archived form (listed type)
            # are not asked. Only expected skips: the pull is ok, with last_ok_at set and the ids listed.
            hub.submissions_error = {f2: refusal}
            reqs, out = self.run_sync("hubspot_sync.py", **env)
            self.assertEqual((asked(reqs, f1), asked(reqs, f2), asked(reqs, f3), asked(reqs, f5),
                              asked(reqs, archived)), (3, 1, 1, 0, 0))
            ok, r_route, http, detail, at, last_ok = outcome_row()
            self.assertEqual((ok, r_route, http), (1, None, None), detail)
            self.assertEqual(last_ok, at)
            self.assertIn("submissions can't be exported, skipped 3: " + ", ".join(sorted([f2, f5, archived])),
                          detail)
            self.assertNotIn("EXTRA_PULL_FAILED hubspot_forms", out)
            self.assertEqual(exportable(), {f1: 1, f2: 0, f3: 1, archived: 0, f5: 0})
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id IN (?,?,?)",
                                    f2, f5, archived)[0][0], 0)
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id=?", f1)[0][0],
                             len(hub.submissions[f1]))
            self.assertEqual(list(progress()["notExportable"]), [f2])
            self.assertEqual(list(progress()["notExportableTypes"]), ["captured"])
            self.assertNotIn(f2, json.loads(self.state("hubspot_forms")))
            first_ok = last_ok

            # Run 2: none of the three is asked. Another 400 (not about the form type) still fails the
            # pull, and last_ok_at stays at run 1.
            hub.submissions_error = {f2: refusal, f3: (400, {"status": "error", "message": "Bad request"})}
            reqs, out = self.run_sync("hubspot_sync.py", **env)
            self.assertEqual((asked(reqs, f2), asked(reqs, f5), asked(reqs, archived), asked(reqs, f3)), (0, 0, 0, 1))
            ok, r_route, http, detail, at, last_ok = outcome_row()
            self.assertEqual((ok, r_route, http), (0, route, 400))
            self.assertEqual(last_ok, first_ok)
            self.assertIn("EXTRA_PULL_FAILED hubspot_forms %s 400" % route, out)
            self.assertEqual(exportable(), {f1: 1, f2: 0, f3: 1, archived: 0, f5: 0})

            # Run 3: a week later f2 is asked once more and still refused, which renews its type,
            # so f5 is still not asked.
            hub.submissions_error = {f2: refusal}
            checked_days_ago(8)
            reqs, out = self.run_sync("hubspot_sync.py", **env)
            self.assertEqual((asked(reqs, f2), asked(reqs, f5), asked(reqs, archived)), (1, 0, 0))
            ok, _r, _h, detail, at, last_ok = outcome_row()
            self.assertEqual((ok, last_ok), (1, at), detail)
            self.assertGreater(progress()["notExportableTypes"]["captured"],
                               fakes.iso(self.world.now - timedelta(days=1)))

            # Run 4: a week on, HubSpot exports f2. That clears its type, so f5 is read too.
            # The listed type is still skipped.
            hub.submissions_error = {}
            checked_days_ago(8)
            reqs, out = self.run_sync("hubspot_sync.py", **env)
            self.assertEqual((asked(reqs, f2), asked(reqs, f5), asked(reqs, archived)), (1, 1, 0))
            ok, _r, _h, detail, at, last_ok = outcome_row()
            self.assertEqual((ok, last_ok), (1, at), detail)
            self.assertIn("skipped 1: " + archived, detail)
            self.assertEqual(exportable(), {f1: 1, f2: 1, f3: 1, archived: 0, f5: 1})
            self.assertEqual((progress()["notExportable"], progress()["notExportableTypes"]), ({}, {}))
            for fid in (f2, f5):
                self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id=?", fid)[0][0],
                                 len(hub.submissions[fid]))
            self.assertEqual(json.loads(self.state("hubspot_forms"))[f2], hub.submissions[f2][0]["submittedAt"])

    def test_sync_only_path_pulls_forms(self):
        """The 15-minute sync-only run pulls forms with no backfill variable set.

        Uses run.py's own source selection (sync_only_scripts, SYNC_ONLY_SOURCES unset) and
        run_syncs, the calls _sync_only makes. Only the HubSpot secret is present, so the other
        sources are skipped.
        """
        sys.path.insert(0, str(ROOT / "refresh"))
        import run

        class Store(run.Store):
            def secret_exists(self, name):
                return name == "hubspot-oauth"

        hub = self.world.hubspot
        with self.fresh_db("sync-only.db") as db:
            env = self.world.env(os.environ, db)   # drops every HUBSPOT_* variable, backfills included
            env.pop("SYNC_ONLY_SOURCES", None)
            self.world.take_requests()
            with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(io.StringIO()):
                wanted, scripts = run.sync_only_scripts()
                ran, failed, _skipped = run.run_syncs(Store(), db, self.sync_dir, scripts)
            reqs = self.world.take_requests()
            self.assertIn("hubspot", wanted)
            self.assertEqual((ran, failed), (["hubspot_sync.py"], []))
            self.assertTrue([r for r in reqs if r.path == "/marketing/v3/forms"])
            self.assertTrue([r for r in reqs if r.path.startswith("/form-integrations/v1/submissions/forms/")])
            self.assertEqual(self.outcome("hubspot_forms")[0], 1)
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_forms")[0][0], len(hub.forms))
            # The contact backfill runs on its own until it is done for its props key; the meeting one does not.
            sources = {r[0] for r in self.q("SELECT source FROM sync_outcomes")}
            self.assertEqual({"hubspot_contact_backfill", "hubspot_meeting_backfill"} & sources,
                             {"hubspot_contact_backfill"})
            self.assertEqual(self.outcome("hubspot_contact_backfill")[0], 1)
            bf = json.loads(self.state("hubspot_contact_backfill"))
            self.assertEqual((bf["propsKey"], bf["done"]), ("restart:lifecycle-v2", True))

    def test_hubspot_meeting_backfill(self):
        """HUBSPOT_MEETING_BACKFILL=1 re-reads every meeting once: merged, page-capped, resumable."""
        hub = self.world.hubspot
        with self.fresh_db("meetings.db") as db:
            # Meetings stored before the source and booking link properties were fetched, with a
            # location stored by older code.
            con = sqlite3.connect(str(db))
            for i in hub.meetings:
                con.execute("INSERT INTO hubspot_objects VALUES('meetings', ?, ?, '2026-01-01T00:00:00+00:00')",
                            (str(i), json.dumps({"hs_object_id": str(i), "hs_meeting_title": "Stored title",
                                                 "seed_only": "kept", "hs_meeting_location": "Stored room"})))
            con.commit()
            con.close()

            def keyset(reqs):
                return [r.json() for r in reqs if r.path == "/crm/v3/objects/meetings/search"
                        and r.json()["filterGroups"][0]["filters"][0]["propertyName"] == "hs_object_id"]

            def stored(hs_id):
                return json.loads(self.q("SELECT properties_json FROM hubspot_objects WHERE object_type='meetings' "
                                         "AND hs_id=?", str(hs_id))[0][0])

            # Run 1: one page per run (HUBSPOT_BACKFILL_MAX_PAGES=1). The first 200 are merged, the
            # stored location is removed, and the outcome is ok with "resuming next run".
            reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0, HUBSPOT_MEETING_BACKFILL=1, HUBSPOT_BACKFILL_MAX_PAGES=1)
            self.assert_hubspot_read_only(reqs)
            self.assertEqual([b["filterGroups"][0]["filters"][0]["value"] for b in keyset(reqs)], ["0"])
            self.assertIn("test_booking_page_url", keyset(reqs)[0]["properties"])
            ok, _route, _http, detail = self.outcome("hubspot_meeting_backfill")
            self.assertEqual(ok, 1)
            self.assertIn("HUBSPOT_BACKFILL_MAX_PAGES reached, resuming next run", detail)
            bf = json.loads(self.state("hubspot_meeting_backfill"))
            self.assertEqual((bf["afterId"], bf["count"], bf.get("done")), ("7200", 200, None))
            m = stored(7100)
            self.assertEqual((m["seed_only"], m["hs_meeting_source"]), ("kept", "MEETINGS_PUBLIC"))  # merged
            for prop in MEETING_PROPS_NEVER:
                self.assertNotIn(prop, m)
            self.assertNotIn("hs_meeting_source", stored(7250))
            self.assertEqual(stored(7250)["hs_meeting_location"], "Stored room")   # not reached yet

            # Run 2: the next page fails; the failure is recorded alone and the position kept.
            hub.fail_meeting_backfill_after = 7200
            reqs, out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0, HUBSPOT_MEETING_BACKFILL=1)
            self.assertEqual(self.outcome("hubspot")[0], 1)
            self.assertEqual(self.outcome("hubspot_meeting_backfill")[:3],
                             (0, "POST /crm/v3/objects/meetings/search", 500))
            self.assertIn("EXTRA_PULL_FAILED hubspot_meeting_backfill POST /crm/v3/objects/meetings/search 500", out)
            self.assertFalse(self.q("SELECT 1 FROM sync_outcomes WHERE source='hubspot_contact_backfill'"))
            self.assertEqual([b["filterGroups"][0]["filters"][0]["value"] for b in keyset(reqs)], ["7200"])
            self.assertEqual(json.loads(self.state("hubspot_meeting_backfill"))["afterId"], "7200")

            # Run 3: meeting properties cannot be listed (403). The sync goes on with the fixed
            # properties, and the backfill resumes after 7200 and finishes.
            hub.fail_meeting_backfill_after = None
            hub.meeting_properties_status = 403
            reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0, HUBSPOT_MEETING_BACKFILL=1)
            self.assertEqual(self.outcome("hubspot")[0], 1)
            bodies = keyset(reqs)
            self.assertEqual([b["filterGroups"][0]["filters"][0]["value"] for b in bodies], ["7200"])
            for prop in MEETING_PROPS:
                self.assertIn(prop, bodies[0]["properties"])
            self.assertNotIn("test_booking_page_url", bodies[0]["properties"])
            bf = json.loads(self.state("hubspot_meeting_backfill"))
            self.assertEqual((bf["afterId"], bf["count"], bf["done"]), ("7250", 250, True))
            self.assertEqual(self.outcome("hubspot_meeting_backfill")[0], 1)
            self.assertEqual(stored(7250)["hs_meeting_source"], "MEETINGS_PUBLIC")
            self.assertNotIn("hs_meeting_location", stored(7250))
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_objects WHERE object_type='meetings' AND "
                                    "json_extract(properties_json, '$.hs_activity_type')='Discovery'")[0][0],
                             len(hub.meetings))

            # Run 4: a finished backfill is not repeated.
            hub.meeting_properties_status = 200
            reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0, HUBSPOT_MEETING_BACKFILL=1)
            self.assertFalse(keyset(reqs))
            self.assertIn("already complete", self.outcome("hubspot_meeting_backfill")[3])

    def test_hubspot_archived_meetings_removed(self):
        """Archived meetings already stored are removed with their associations; others are kept."""
        hub = self.world.hubspot
        with self.fresh_db("archived.db") as db:
            # 9101-9105 were stored before HubSpot archived them; the search no longer returns them.
            # 9106 is archived but was never stored.
            con = sqlite3.connect(str(db))
            for i in (7100, 9101, 9102, 9103, 9104, 9105):
                con.execute("INSERT INTO hubspot_objects VALUES('meetings', ?, ?, '2026-01-01T00:00:00+00:00')",
                            (str(i), json.dumps({"hs_object_id": str(i), "hs_meeting_title": "Stored"})))
                for a, b in ((("meetings", i), ("contacts", 200)), (("contacts", 200), ("meetings", i))):
                    con.execute("INSERT INTO hubspot_associations VALUES(?,?,?,?)", (a[0], str(a[1]), b[0], str(b[1])))
            con.execute("INSERT INTO hubspot_associations VALUES('contacts', '200', 'companies', '9101')")
            con.commit()
            con.close()
            hub.archived_meetings = [9101, 9102, 9103, 9104, 9105, 9106]

            def stored():
                return sorted(int(r[0]) for r in self.q("SELECT hs_id FROM hubspot_objects "
                                                        "WHERE object_type='meetings' AND hs_id IN "
                                                        "('7100','9101','9102','9103','9104','9105','9106')"))

            # Run 1: two pages a run (two meetings a page). 9101-9104 go; the cursor is kept.
            reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0, HUBSPOT_ARCHIVED_MAX_PAGES=2)
            self.assert_hubspot_read_only(reqs)
            lists = [r for r in reqs if r.path == "/crm/v3/objects/meetings"]
            self.assertEqual([(r.query.get("archived"), r.query.get("properties"), r.query.get("after"))
                              for r in lists], [("true", "hs_object_id", None), ("true", "hs_object_id", "2")])
            self.assertEqual(stored(), [7100, 9105])
            ok, _route, _http, detail = self.outcome("hubspot_meeting_archive")
            self.assertEqual(ok, 1)
            self.assertIn("4 archived meetings listed, 4 removed", detail)
            self.assertIn("resuming next run", detail)
            self.assertEqual(json.loads(self.state("hubspot_meeting_archive")), {"after": "4"})
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_associations WHERE "
                                    "(from_type='meetings' AND from_id IN ('9101','9102','9103','9104')) OR "
                                    "(to_type='meetings' AND to_id IN ('9101','9102','9103','9104'))")[0][0], 0)
            # Kept: the live meeting's links, and a row only sharing the id under another type.
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_associations WHERE from_id='7100' "
                                    "OR to_id='7100'")[0][0], 2)
            self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_associations WHERE to_type='companies' "
                                    "AND to_id='9101'")[0][0], 1)

            # Run 2: resumes at the cursor, removes 9105, ends the pass.
            reqs, _out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0, HUBSPOT_ARCHIVED_MAX_PAGES=2)
            self.assertEqual([r.query.get("after") for r in reqs if r.path == "/crm/v3/objects/meetings"], ["4"])
            self.assertEqual(stored(), [7100])
            self.assertIn("2 archived meetings listed, 1 removed", self.outcome("hubspot_meeting_archive")[3])
            self.assertEqual(json.loads(self.state("hubspot_meeting_archive")), {"after": None})

            # Run 3: the list fails; the sync itself still succeeds and the failure is recorded alone.
            hub.archived_meetings = None
            reqs, out = self.run_sync("hubspot_sync.py", HUBSPOT_CONTACT_BACKFILL=0)
            self.assertEqual(self.outcome("hubspot")[0], 1)
            self.assertEqual(self.outcome("hubspot_meeting_archive")[:3], (0, "GET /crm/v3/objects/meetings", 500))
            self.assertIn("EXTRA_PULL_FAILED hubspot_meeting_archive GET /crm/v3/objects/meetings 500", out)
            self.assertEqual(stored(), [7100])

    # ------------------------------------------------------------ Lemlist

    def test_lemlist(self):
        lem = self.world.lemlist

        # Run 1: first pull. One 429 on activities; campaign 2's export fails, so its leads come
        # from the paged leads route (150 leads, two pages).
        lem.once_429 = {"activities"}
        reqs, _out = self.run_sync("lemlist_sync.py")
        self.assertTrue(reqs)
        self.assertEqual([r for r in reqs if r.method != "GET"], [], "Lemlist calls other than GET")
        self.assertEqual(self.outcome("lemlist")[0], 1)
        self.assertEqual(self.outcome("lemlist_activities")[0], 1)
        self.assertEqual(self.outcome("lemlist_leads")[0], 1)

        self.assertEqual(self.q("SELECT COUNT(*) FROM lemlist_activities")[0][0], len(lem.activities))
        reply = json.loads(self.q("SELECT raw_json FROM lemlist_activities WHERE activity_id='act_r1'")[0][0])
        self.assertEqual(reply["text"], "Auto-reply: out of office")
        self.assertIn("lead", reply)                       # replies keep everything
        sent = json.loads(self.q("SELECT raw_json FROM lemlist_activities WHERE activity_id='act_s1'")[0][0])
        self.assertNotIn("lead", sent)
        marks = json.loads(self.state("lemlist_activities"))
        self.assertEqual(len(marks), 6)
        self.assertEqual(sum(1 for r in reqs if r.path == "/api/campaigns/cam_test2/leads/"), 2)

        self.assertEqual(self.q("SELECT campaign_id, COUNT(*) FROM lemlist_leads GROUP BY campaign_id"),
                         [("cam_test1", 3), ("cam_test2", 150)])
        lead = self.q("SELECT email, company_domain, state, status, contacted_at, opened_at, clicked_at, replied_at, "
                      "meeting_booked_at, raw_json FROM lemlist_leads WHERE lead_id='lea_t1_1'")[0]
        acts = {a["_id"]: a["createdAt"] for a in lem.activities}
        self.assertEqual(lead[:4], ("lead1@example.com", "example.com", "emailsReplied", "done"))
        self.assertEqual(lead[4:9], (acts["act_s1"], acts["act_o1"], acts["act_c1"], acts["act_r1"], acts["act_m1"]))
        self.assertEqual(json.loads(lead[9])["emailStatus"], "deliverable")
        self.assertEqual(self.q("SELECT replied_at FROM lemlist_leads WHERE lead_id='lea_t1_3'")[0][0], acts["act_l3"])
        self.assertEqual(self.q("SELECT COUNT(*) FROM lemlist_leads WHERE campaign_id='cam_test2' "
                                "AND contacted_at IS NOT NULL")[0][0], 150)

        # Run 2: activities answer 500. The failure is recorded; campaigns and leads still refresh.
        lem.activities_status = 500
        reqs, _out = self.run_sync("lemlist_sync.py")
        self.assertEqual(self.outcome("lemlist")[0], 1)
        ok, route, http, _detail = self.outcome("lemlist_activities")
        self.assertEqual((ok, route, http), (0, "GET /api/activities", 500))
        self.assertEqual(self.outcome("lemlist_leads")[0], 1)
        self.assertEqual(json.loads(self.state("lemlist_activities")), marks)
        self.assertEqual(self.q("SELECT COUNT(*) FROM lemlist_leads")[0][0], 153)

        # Run 3: incremental. One call per type from an hour before each watermark; the new reply lands.
        lem.activities_status = 200
        lem.add_reply("act_new", "lea_t1_2", self.world.now - timedelta(minutes=5))
        reqs, _out = self.run_sync("lemlist_sync.py")
        calls = [r for r in reqs if r.path == "/api/activities"]
        self.assertEqual(len(calls), 6)
        for r in calls:
            self.assertEqual(fakes.parse_iso(r.query["minDate"]),
                             fakes.parse_iso(marks[r.query["type"]]) - timedelta(hours=1))
        self.assertEqual(self.outcome("lemlist_activities")[0], 1)
        self.assertEqual(self.q("SELECT replied_at FROM lemlist_leads WHERE lead_id='lea_t1_2'")[0][0],
                         fakes.iso(self.world.now - timedelta(minutes=5)))
        self.assertEqual(self.q("SELECT replied_at FROM lemlist_leads WHERE lead_id='lea_t1_1'")[0][0], acts["act_r1"])

    def test_lemlist_call_budget_resumes(self):
        """A first pull that runs out of LEMLIST_ACTIVITY_MAX_CALLS keeps complete windows and resumes."""
        db = self.tmp / "budget.db"
        seed_db(db, self.world.now)
        saved, self.db = self.db, db
        try:
            reqs, _out = self.run_sync("lemlist_sync.py", LEMLIST_ACTIVITY_MAX_CALLS=3)
            self.assertEqual(sum(1 for r in reqs if r.path == "/api/activities"), 3)
            self.assertIn("resuming next run", self.outcome("lemlist_activities")[3])
            marks = json.loads(self.state("lemlist_activities"))
            self.assertEqual(sorted(marks), ["emailsReplied", "linkedinReplied"])  # replies go first
            reqs, _out = self.run_sync("lemlist_sync.py")
            self.assertEqual(len(json.loads(self.state("lemlist_activities"))), 6)
            first = [r for r in reqs if r.path == "/api/activities" and r.query["type"] == "linkedinReplied"]
            self.assertEqual(fakes.parse_iso(first[0].query["minDate"]),
                             fakes.parse_iso(marks["linkedinReplied"]) - timedelta(hours=1))
            self.assertEqual(self.q("SELECT COUNT(*) FROM lemlist_activities")[0][0],
                             len(self.world.lemlist.activities))
        finally:
            self.db = saved

    def test_lemlist_window_over_budget(self):
        """A window with more rows than one run's call budget still advances, run by run."""
        lem = self.world.lemlist
        with self.fresh_db("window.db") as db:
            now = self.world.now
            for k in range(450):
                lem.activities.append({"_id": "act_bulk_o%d" % k, "type": "emailsOpened", "campaignId": "cam_test1",
                                       "leadId": "lea_t1_2", "createdAt": fakes.iso(now - timedelta(minutes=10 + k)),
                                       "leadEmail": "lead@example.com", "bot": False, "isFirst": False})
            opens = sum(1 for a in lem.activities if a["type"] == "emailsOpened"
                        and fakes.parse_iso(a["createdAt"]) >= now - timedelta(days=20, hours=1))
            pages = math.ceil(opens / 100)                                  # 5
            # Every other type is up to date (one call each); opens are 20 days behind, in one window.
            marks = {t: fakes.iso(now) for t in ("emailsReplied", "linkedinReplied", "meetingBooked", "emailsSent",
                                                  "emailsClicked")}
            marks["emailsOpened"] = fakes.iso(now - timedelta(days=20))
            con = sqlite3.connect(str(db))
            con.execute("INSERT INTO sync_state VALUES('lemlist_activities', ?, NULL, 'seed')", (json.dumps(marks),))
            con.commit()
            con.close()

            def open_calls(reqs):
                return [r for r in reqs if r.path == "/api/activities" and r.query["type"] == "emailsOpened"]

            def stored():
                return self.q("SELECT COUNT(*) FROM lemlist_activities WHERE type='emailsOpened'")[0][0]

            def exports(reqs):
                return [r.path.split("/")[4] for r in reqs if r.path.endswith("/export/leads")]

            # Budget 7: five calls for the other types, two pages of opens per run. One leads export
            # a run (LEMLIST_LEADS_MAX_EXPORTS=1): the first campaign now, the second next run.
            reqs, _out = self.run_sync("lemlist_sync.py", LEMLIST_ACTIVITY_MAX_CALLS=7, LEMLIST_LEADS_MAX_EXPORTS=1)
            first = open_calls(reqs)
            self.assertEqual([r.query["offset"] for r in first], ["0", "100"])
            self.assertEqual(stored(), 200)
            self.assertEqual(json.loads(self.state("lemlist_activities"))["emailsOpened"], marks["emailsOpened"])
            self.assertEqual(json.loads(self.state("lemlist_activities_resume"))["emailsOpened"]["offset"], 200)
            ok, _route, _http, detail = self.outcome("lemlist_activities")
            self.assertEqual(ok, 1)
            self.assertIn("resuming next run (emailsOpened behind)", detail)
            self.assertEqual(exports(reqs), ["cam_test1"])
            self.assertIn("1 due campaigns wait for a later run", self.outcome("lemlist_leads")[3])
            self.assertEqual(self.q("SELECT DISTINCT campaign_id FROM lemlist_leads"), [("cam_test1",)])

            # Run 2: the same window, from offset 200. Only the campaign still due is exported.
            reqs, _out = self.run_sync("lemlist_sync.py", LEMLIST_ACTIVITY_MAX_CALLS=7, LEMLIST_LEADS_MAX_EXPORTS=1)
            calls = open_calls(reqs)
            self.assertEqual([r.query["offset"] for r in calls], ["200", "300"])
            for r in calls:
                self.assertEqual((r.query["minDate"], r.query["maxDate"]),
                                 (first[0].query["minDate"], first[0].query["maxDate"]))
            self.assertEqual(stored(), 400)
            self.assertEqual(exports(reqs), ["cam_test2"])
            self.assertIn("1 campaigns skipped", self.outcome("lemlist_leads")[3])
            refreshed = json.loads(self.state("lemlist_leads"))
            self.assertLess(refreshed["cam_test1"], refreshed["cam_test2"])           # spread over runs

            # Run 3: the window finishes and the watermark moves on; leads are due with the interval at 0.
            reqs, _out = self.run_sync("lemlist_sync.py", LEMLIST_ACTIVITY_MAX_CALLS=7,
                                       LEMLIST_LEADS_MIN_INTERVAL_MIN=0)
            self.assertEqual(open_calls(reqs)[0].query["offset"], str((pages - 1) * 100))
            self.assertEqual(stored(), opens)
            self.assertGreater(fakes.parse_iso(json.loads(self.state("lemlist_activities"))["emailsOpened"]), now)
            self.assertEqual(json.loads(self.state("lemlist_activities_resume")), {})
            self.assertNotIn("resuming", self.outcome("lemlist_activities")[3])
            self.assertEqual(exports(reqs), ["cam_test1", "cam_test2"])


if __name__ == "__main__":
    unittest.main()
