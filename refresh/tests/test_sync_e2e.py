"""End-to-end tests for the HubSpot and Lemlist syncs.

Each test copies refresh/brain-sync to a temp dir (as run.py does), seeds a
brain.db, and runs the real entrypoints (`python3 hubspot_sync.py`,
`python3 lemlist_sync.py`) as subprocesses against the fakes in fakes.py.
Assertions are on the resulting SQLite tables, watermarks and sync_outcomes,
and on the requests the fakes received.

Run from the repo root:

    python3 -m unittest discover -s refresh/tests -v

Needs python3 with boto3 (as the refresh image has) and the openssl CLI.
Takes about two minutes, mostly the scripts' own request pacing.
"""

import json
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fakes  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SYNC_SRC = ROOT / "refresh" / "brain-sync"

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

        # Run 1: imports scope missing (403); a 429 on the forms list and on one form's submissions.
        hub.imports_status = 403
        hub.once_429 = {"forms", "submissions:" + f2}
        reqs, _out = self.run_sync("hubspot_sync.py")
        self.assert_hubspot_read_only(reqs)
        self.assertEqual(self.outcome("hubspot")[0], 1)

        # Attribution and discovered custom properties are requested with the incremental contacts.
        body = next(r.json() for r in reqs if r.path == "/crm/v3/objects/contacts/search")
        for prop in ("hs_analytics_source", "hs_latest_source_data_2", "first_conversion_date", "hs_object_source",
                     "hs_google_click_id", "hs_lifecyclestage_customer_date", "utm_source", "utm_campaign",
                     "paid_touch_campaign"):
            self.assertIn(prop, body["properties"])
        self.assertNotIn("favorite_color", body["properties"])
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


if __name__ == "__main__":
    unittest.main()
