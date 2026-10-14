"""End to end for workspace.json "fresh" (docs/workspace-fresh.md): the form fills, meeting-link bookings,
closed-won deals and per-deal call activity the fresh frontend read from its one-time extract, now synced.

The synthetic portal of test_rules_e2e.py, plus closed-won deals (one owned by customer success, one in the
Renewal pipeline, one owned by a former owner the rest of workspace.json never names), a booking linked to a
company only, Fathom recordings and Strategy's records.jsonl. The real hubspot_sync.py writes brain.db, the real
scripts/workspace-data.py reads it, the real onepage/build.mjs renders the page. Asserted: the shapes and figures,
that fresh agrees with the sections it is derived from, that it adds no person names or emails, that the page is
the same with or without it, and that an over-budget file leaves it out instead of failing the refresh.

Every company, person, id and figure is invented.

    python3 -m unittest refresh.tests.test_fresh_e2e   (or discover -s refresh/tests)
"""

import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fakes  # noqa: E402
import test_rules_e2e as rules  # noqa: E402

ROOT = rules.ROOT
_spec = importlib.util.spec_from_file_location("workspace_data_fresh", ROOT / "scripts" / "workspace-data.py")
wd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wd)
SALES = "default"
AS_OF = "2026-10-13T16:00:00Z"
VOLATILE = {"generatedAt", "runId", "collectedAt", "publishedAt", "carriedFrom", "at", "lastOkAt", "fetchedAt",
            "channelsFetchedAt", "capturedAt"}

# Fathom recordings (the sync's `meetings` table) and Strategy's classification of them (records.jsonl).
RECORDINGS = [  # recording id, start, guest email
    (5001, "2026-10-08T17:00:00Z", "ana@acme.example"),   # in the calls window: on the calls list
    (5002, "2026-03-10T17:00:00Z", "ivy@acme.example"),   # outside the window
]
RECORDS = [
    # deal 901: two prospect calls on Oct 8 (one day), one in March; the latest next step is on the listed call.
    {"call_id": 5001, "audience": "prospect", "datetime_pt": "2026-10-08 10:00 PT", "deal": {"id": "901"},
     "next_steps": ["Send the pilot plan"]},
    {"call_id": 5003, "audience": "prospect", "datetime_pt": "2026-10-08 15:00 PT", "deal": {"id": "901"},
     "next_steps": ["//fathom.video/share/x"]},  # a link fragment is not a next step
    {"call_id": 5004, "audience": "prospect", "datetime_pt": "2026-03-02 09:00 PT", "deal": {"id": "901"},
     "next_steps": ["Book the demo"]},
    {"call_id": 5005, "audience": "customer", "datetime_pt": "2026-10-09 09:00 PT", "deal": {"id": "901"}},
    # deal 902: one old call; its next step is not on the calls list, so it is not carried.
    {"call_id": 5002, "audience": "prospect", "datetime_pt": "2026-03-10 10:00 PT", "deal": {"id": "902"},
     "next_steps": ["Call back in Q3"]},
    {"call_id": 5006, "audience": "prospect", "datetime_pt": "2026-04-01 10:00 PT", "deal": {"id": "904"}},  # Renewal
    {"call_id": 5007, "audience": "prospect", "datetime_pt": "2026-04-02 10:00 PT", "deal": {"id": "999"}},  # unknown
]


def portal(hub, now):
    rules.portal(hub, now)
    mod = fakes.iso(now)

    def won(i, owner, pipeline=SALES, stage="closedwon", close="2025-12-15T18:00:00.000Z", company=804):
        hub.objects["deals"][i] = {"hs_object_id": str(i), "dealname": "Test won %d" % i, "pipeline": pipeline,
                                   "dealstage": stage, "amount": "10000", "hs_deal_stage_probability": "1.0",
                                   "hubspot_owner_id": owner, "createdate": "2025-06-01T00:00:00.000Z",
                                   "hs_lastmodifieddate": mod, "closedate": close}
        hub.history[str(i)] = {"dealstage": [{"value": stage, "timestamp": "2025-06-01T00:00:00.000Z", "sourceType": "CRM_UI"}]}
        hub.link("deals", i, "companies", company)
    won(907, rules.CS_OWNER)                    # owned by customer success: not new business
    won(908, "1", pipeline=rules.RENEWAL, stage="r1")  # Renewal pipeline
    won(909, "3")                               # a former owner, named nowhere else in workspace.json
    hub.meetings[7114] = {"hs_object_id": "7114", "hs_meeting_title": "Test booking 7114", "hs_lastmodifieddate": mod,
                          "hs_createdate": "2026-09-01T17:00:00.000Z", "hs_meeting_start_time": "2026-09-08T17:00:00.000Z",
                          "hs_timestamp": "2026-09-08T17:00:00.000Z", "hs_meeting_source": "MEETINGS_PUBLIC",
                          "hubspot_owner_id": "3"}
    hub.link("meetings", 7114, "companies", 804)  # company only: its Sales deal (905) by company
    # A booking whose title names its attendee, at a company the rest of workspace.json does not list.
    hub.objects["companies"][805] = {"name": "Vandelay Industries", "domain": "vandelay.example", "lifecyclestage": "lead",
                                     "hubspot_owner_id": "1", "hs_object_id": "805", "hs_lastmodifieddate": mod}
    hub.contacts[216] = {"hs_object_id": "216", "email": "pat@vandelay.example", "firstname": "Pat", "lastname": "Sample",
                         "lifecyclestage": "lead", "hubspot_owner_id": "1", "lastmodifieddate": mod,
                         "createdate": "2026-01-02T00:00:00.000Z"}
    hub.link("contacts", 216, "companies", 805)
    hub.meetings[7115] = {"hs_object_id": "7115", "hs_meeting_title": "Pat Sample and Test Owner", "hs_lastmodifieddate": mod,
                          "hs_createdate": "2026-02-02T17:00:00.000Z", "hs_meeting_start_time": "2026-02-03T17:00:00.000Z",
                          "hs_timestamp": "2026-02-03T17:00:00.000Z", "hs_meeting_source": "MEETINGS_PUBLIC",
                          "hubspot_owner_id": "1"}
    hub.link("meetings", 7115, "contacts", 216)
    hub.link("meetings", 7115, "companies", 805)


def add_fathom_and_owner(db):
    con = sqlite3.connect(str(db))
    con.execute("CREATE TABLE IF NOT EXISTS meetings(recording_id INTEGER PRIMARY KEY, title TEXT, scheduled_start_time TEXT, "
                "recording_start_time TEXT, created_at TEXT, recorded_by_name TEXT, recorded_by_email TEXT, "
                "invitees_json TEXT, summary_markdown TEXT)")
    for rid, start, guest in RECORDINGS:
        con.execute("INSERT INTO meetings VALUES (?,?,?,?,?,?,?,?,?)",
                    (rid, "Test call %d" % rid, start, start, start, "Test Owner", "owner@example.com",
                     json.dumps([{"email": guest, "name": "Guest %d" % rid, "is_external": True}]), "A summary."))
    # The former owner: in the owners table (HubSpot keeps archived owners), not on any open deal, loss or listed meeting.
    cols = [r[1] for r in con.execute("PRAGMA table_info(hubspot_owners)")]
    row = {"id": "3", "first_name": "Former", "last_name": "Rep", "email": "former@example.com"}
    con.execute("INSERT INTO hubspot_owners(%s) VALUES (%s)" % (", ".join(c for c in row if c in cols), ", ".join("?" for c in row if c in cols)),
                [v for c, v in row.items() if c in cols])
    con.commit()
    con.close()


def strip(v):
    if isinstance(v, dict):
        return {k: strip(x) for k, x in v.items() if k not in VOLATILE}
    if isinstance(v, list):
        return [strip(x) for x in v]
    return v


class FreshE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="fresh-e2e-"))
        cls.world = fakes.FakeWorld(cls.tmp).start()
        portal(cls.world.hubspot, cls.world.now)
        sync_dir = cls.tmp / "brain-sync"
        shutil.copytree(rules.SYNC_SRC, sync_dir, ignore=shutil.ignore_patterns("logs", "__pycache__"))
        cls.db = cls.tmp / "brain.db"
        rules.seed(cls.db, cls.world.now)
        cls.sync = subprocess.run([sys.executable, str(sync_dir / "hubspot_sync.py")], env=cls.world.env(os.environ, cls.db),
                                  cwd=str(cls.tmp), capture_output=True, text=True, timeout=600)
        add_fathom_and_owner(cls.db)
        cls.inputs = cls.tmp / "inputs"
        cls.inputs.mkdir()
        (cls.inputs / "lead-sources.json").write_text(json.dumps(rules.LEAD_SOURCES))
        (cls.inputs / "records.jsonl").write_text("".join(json.dumps(r) + "\n" for r in RECORDS))
        (cls.inputs / "scrub-patterns.txt").write_text(rules.SCRUB + "\n")
        cls.env = {**os.environ, "CALL_CLASSIFICATION": "", "LEAD_SOURCE_REVIEW": "", "PAID_EXPORT": ""}
        cls.env.pop("WORKSPACE_SCRUB_PATTERNS", None)
        out = cls.tmp / "workspace.json"
        cls.data_step = subprocess.run([sys.executable, str(ROOT / "scripts" / "workspace-data.py"), "--db", str(cls.db),
                                        "--inputs-dir", str(cls.inputs), "--as-of", AS_OF, "--out", str(out)],
                                       env=cls.env, capture_output=True, text=True, timeout=300)
        cls.text = out.read_text() if out.exists() else ""
        cls.data = json.loads(cls.text) if cls.text else None
        cls.fresh = (cls.data or {}).get("fresh")
        # The page from this file, and from the same file without "fresh".
        bare = cls.tmp / "bare.json"
        bare.write_text(json.dumps({k: v for k, v in (cls.data or {}).items() if k != "fresh"}))
        cls.pages = [subprocess.run(["node", str(ROOT / "onepage" / "build.mjs"), "--data", str(src), "--out", str(cls.tmp / name)],
                                    env={**cls.env, "WORKSPACE_SCRUB_PATTERNS": rules.SCRUB}, capture_output=True, text=True, timeout=120)
                     for src, name in ((out, "page"), (bare, "page-bare"))]

    @classmethod
    def tearDownClass(cls):
        cls.world.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_0_steps_ran(self):
        self.assertEqual(self.sync.returncode, 0, self.sync.stdout[-3000:] + self.sync.stderr[-3000:])
        self.assertEqual(self.data_step.returncode, 0, self.data_step.stderr[-3000:])
        for p in self.pages:
            self.assertEqual(p.returncode, 0, p.stderr[-3000:])
        self.assertEqual((self.fresh["version"], self.fresh["contract"]), (1, "docs/workspace-fresh.md"))
        self.assertTrue((ROOT / self.fresh["contract"]).is_file())
        self.assertEqual(list(self.data)[-1], "fresh")

    def test_page_is_the_same_without_fresh(self):
        # The built page embeds its view, a copy of the data (every key), in one JSON script block; the markup it
        # renders is the same with or without fresh, and the view never reads it.
        html = [(self.tmp / name / "index.html").read_text() for name in ("page", "page-bare")]
        block = re.compile(r'<script type="application/json" id="gtm-data">.*?</script>', re.S)
        self.assertEqual(block.sub("", html[0]), block.sub("", html[1]))
        self.assertIn('"fresh":{"version":1', html[0])
        self.assertNotIn('"fresh"', html[1])
        page_code = (ROOT / "onepage" / "view.cjs").read_text() + (ROOT / "onepage" / "page.cjs").read_text()
        self.assertIsNone(re.search(r"\.fresh\b|\[['\"]fresh['\"]\]", page_code))

    def test_each_section_has_time_and_provenance(self):
        for k in ("submissions", "meetings", "won", "calls"):
            s = self.fresh[k]
            self.assertTrue(s["available"], k)
            self.assertTrue(s["fetchedAt"], k)  # a volatile key: the sync's content hash ignores it
            self.assertIn("ReportingScope", s["provenance"]["rules"])
            self.assertTrue(s["provenance"]["source"] and s["provenance"]["stage"], k)
        fresh_rows = {f["source"]: f["lastOkAt"] for f in self.data["freshness"]}
        self.assertEqual(self.fresh["submissions"]["fetchedAt"], fresh_rows["hubspot_forms"])
        self.assertEqual(self.fresh["meetings"]["fetchedAt"], fresh_rows["hubspot"])

    def test_submissions(self):
        s, forms = self.fresh["submissions"], self.data["forms"]
        # The counted stage of the form waterfall, one row each: ana twice and a walk-in (demo), ivy (pricing,
        # bucket contact), mo and the readers (content). Customers, careers, free mail and internal are out.
        self.assertEqual(s["count"], forms["total"])
        self.assertEqual(len(s["items"]), rules.PAGE_SUBS + 5)
        by_form = {}
        for x in s["items"]:
            self.assertEqual(set(x), {"formId", "submittedAt", "contactId"})
            by_form.setdefault(x["formId"], []).append(x["contactId"])
        self.assertEqual(sorted(by_form["f-demo"], key=str), ["201", "201", None])
        self.assertEqual(by_form["f-pricing"], ["209"])
        self.assertNotIn("f-careers", by_form)
        self.assertNotIn("f-contact", by_form)  # ben a customer, fay free mail
        self.assertEqual(s["items"], sorted(s["items"], key=lambda x: (x["submittedAt"], x["formId"], x["contactId"] or "")))
        self.assertEqual(s["forms"]["f-demo"], {"name": "Demo Request", "bucket": "demo_request", "counts_as_lead_source": True})
        self.assertNotIn("f-careers", s["forms"])
        # oct13: customers and careers / non-lead forms out, free mail and internal kept (gtm-static.json oct13.forms).
        self.assertEqual(s["oct13"], {"contact": 2, "content_download": rules.PAGE_SUBS + 2, "demo_request": 3})
        self.assertEqual(sum(s["byYear"].values()), s["count"])

    def test_meetings(self):
        m, b = self.fresh["meetings"], self.data["meetings"]["bookings"]
        ids = [x["id"] for x in m["items"]]
        # The counted bookings: no deal, SQL then, On Hold then, nothing linked, Renewal deal, deal created later,
        # the listed one, and the company-only one. Customer, free-mail, internal, past-Discovery and CRM_UI are out.
        self.assertEqual(sorted(ids), ["7101", "7105", "7106", "7108", "7110", "7111", "7113", "7114", "7115"])
        self.assertEqual((m["count"], b["counted"]), (len(ids), len(ids)))
        self.assertEqual(m["byYear"], {y: c["counted"] for y, c in b["byYear"].items()})
        self.assertEqual(m["oct13"], {"overall": b["afterRules"], "y2026": b["byYear"]["2026"]["afterRules"],
                                      "customerExcluded": b["customer"], "pastDiscovery": b["opportunity"],
                                      "publicBookings": b["total"]})
        by = {x["id"]: x for x in m["items"]}
        self.assertEqual(by["7105"]["deals"], ["902"])
        self.assertEqual(by["7105"]["contacts"], ["211"])
        self.assertEqual(by["7105"]["hs_createdate"], "2026-03-01T17:00:00.000Z")
        self.assertEqual(by["7105"]["hubspot_owner_id"], "1")
        # Titles name people: only a meeting the meetings list already shows keeps its title.
        listed = {x["id"] for x in self.data["meetings"]["items"]}
        for x in m["items"]:
            self.assertEqual("hs_meeting_title" in x, x["id"] in listed, x["id"])
        self.assertEqual(by["7113"]["hs_meeting_title"], "Test booking 7113")
        # The Sales deal each booking belongs to, and its stage when booked.
        self.assertEqual(by["7105"]["salesDeal"], {"id": "902", "stageId": "15879262", "stageAtBooking": "943743501", "matchedBy": "meeting"})
        self.assertEqual(by["7106"]["salesDeal"]["stageAtBooking"], "207126699")    # On Hold then
        self.assertEqual(by["7111"]["salesDeal"]["stageAtBooking"], None)          # the deal did not exist yet
        self.assertEqual(by["7114"]["salesDeal"]["id"], "905")                     # the newest of 905, 907, 909 at the company
        self.assertEqual(by["7114"]["salesDeal"]["matchedBy"], "company")
        self.assertIsNone(by["7110"]["salesDeal"])                                 # a Renewal deal is no Sales deal
        self.assertEqual(self.fresh["stages"]["943743501"], "SQL")
        self.assertEqual(self.fresh["companies"]["804"], "Hooli")
        self.assertEqual(by["7115"]["companies"], ["805"])
        self.assertEqual(self.fresh["companies"]["805"], "Vandelay Industries")  # company names as HubSpot has them

    def test_won(self):
        w = self.fresh["won"]
        by = {x["id"]: x for x in w["items"]}
        # Sales Pipeline, closed won; customer success's win and the Renewal deal are out.
        self.assertEqual(sorted(by), ["905", "909"])
        self.assertEqual(by["905"], {"id": "905", "name": "Test deal 905", "amount": 40000, "close": "2026-12-31T00:00:00.000Z",
                                     "owner": "Test Owner", "company": "Hooli"})
        self.assertIs(type(by["905"]["amount"]), int)  # a whole amount stays an int, as in the extract
        self.assertEqual(by["909"]["close"], "2025-12-15T18:00:00.000Z")
        self.assertIsNone(by["909"]["owner"])  # named nowhere else in workspace.json: left out
        self.assertEqual(w["byYear"], {"2025": 1, "2026": 1})
        self.assertEqual(self.data["closed"]["won"]["count"], 3)  # the existing total keeps its meaning (CS win included)

    def test_calls(self):
        c = self.fresh["calls"]
        act = c["dealActivity"]
        self.assertEqual(c["callsThrough"], "2026-10-08")
        self.assertNotIn("904", act)  # Renewal
        self.assertNotIn("999", act)  # not a HubSpot deal
        self.assertEqual(act["901"]["calls"], 2)  # Oct 8 (twice) and Mar 2; the customer call does not count
        self.assertEqual(act["901"]["lastCall"], "2026-10-08")
        self.assertEqual((act["901"]["nextStep"], act["901"]["nextStepCallId"]), ("Send the pilot plan", "R5001"))
        self.assertIn("R5001", {x["id"] for x in self.data["calls"]["items"]})
        self.assertEqual((act["902"]["calls"], act["902"]["nextStep"]), (1, None))  # its call is not on the calls list
        self.assertNotIn("nextStepCallId", act["902"])
        # Meetings on the deal or at its companies, any source.
        self.assertEqual(act["901"]["meetings"], ["2026-02-10T17:00:00.000Z"])
        self.assertEqual(act["905"]["meetings"], ["2026-05-15T17:00:00.000Z", "2026-09-08T17:00:00.000Z"])
        self.assertEqual(act["905"]["calls"], 0)
        self.assertEqual(c["count"], len(act))

    def test_no_person_names_or_emails(self):
        text = json.dumps(self.fresh)
        self.assertNotIn("@", text)
        for name in ["Test%d" % i for i in range(201, 216)] + ["Former", "Guest 500", "Test booking 710", "Pat Sample", "Sample"]:
            self.assertNotIn(name, text)
        self.assertEqual(self.fresh["owners"], {"1": "Test Owner"})  # the former owner is not named
        self.assertNotIn(rules.SCRUB, text.lower())

    def test_fresh_alone_changes_nothing_else(self):
        # The same build without the fresh step: every other key is identical (fresh is added, never changes a field).
        out = self.tmp / "no-fresh.json"
        no_env = {"CALL_CLASSIFICATION": "", "LEAD_SOURCE_REVIEW": "", "PAID_EXPORT": "", "WORKSPACE_SCRUB_PATTERNS": ""}
        with mock.patch.object(wd, "build_fresh", lambda *a, **k: None), mock.patch.dict(os.environ, no_env):
            wd.main(["--db", str(self.db), "--inputs-dir", str(self.inputs), "--as-of", AS_OF, "--out", str(out), "--quiet"])
        other = json.loads(out.read_text())
        self.assertIsNone(other.pop("fresh"))
        self.assertEqual(strip(other), strip({k: v for k, v in self.data.items() if k != "fresh"}))

    def test_a_fresh_failure_leaves_fresh_out(self):
        # fresh is add-only: an error building it must not cost the page its workspace.json.
        warnings = []
        args = wd.argparse.Namespace(db=str(self.db), inputs_dir=str(self.inputs), lead_sources=None, lost_reasons=None,
                                     insights=None, lead_insights=None, prior=None, current_page=None, portal_id=None,
                                     as_of=AS_OF, call_classification=None, review_list=None, paid_export=None,
                                     scrub_patterns_file=None)
        no_env = {"CALL_CLASSIFICATION": "", "LEAD_SOURCE_REVIEW": "", "PAID_EXPORT": "", "WORKSPACE_SCRUB_PATTERNS": ""}
        with mock.patch.object(wd, "fresh_meetings", mock.Mock(side_effect=KeyError("x"))), mock.patch.dict(os.environ, no_env):
            doc = wd.build(args, warn=warnings.append)
        self.assertEqual(doc["fresh"], {"version": 1, "contract": "docs/workspace-fresh.md", "available": False,
                                        "reason": "left out: building it failed (KeyError)"})
        self.assertTrue(any("fresh left out: KeyError" in w for w in warnings))
        self.assertEqual(strip({k: v for k, v in doc.items() if k != "fresh"}),
                         strip({k: v for k, v in self.data.items() if k != "fresh"}))

    def test_over_budget_leaves_fresh_out(self):
        without = len(json.dumps({k: v for k, v in self.data.items() if k != "fresh"}, ensure_ascii=False,
                                 separators=(",", ":")).encode())
        budget = without + 2000  # room for the rest, not for fresh
        warnings = []
        args = wd.argparse.Namespace(db=str(self.db), inputs_dir=str(self.inputs), lead_sources=None, lost_reasons=None,
                                     insights=None, lead_insights=None, prior=None, current_page=None, portal_id=None,
                                     as_of=AS_OF, call_classification=None, review_list=None, paid_export=None,
                                     scrub_patterns_file=None)
        with mock.patch.object(wd, "MAX_BYTES", budget):
            doc = wd.build(args, warn=warnings.append)
        self.assertEqual((doc["fresh"]["available"], doc["fresh"]["version"]), (False, 1))
        self.assertIn("budget", doc["fresh"]["reason"])
        self.assertTrue(any("fresh left out" in w for w in warnings))
        self.assertLessEqual(len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()), budget)


if __name__ == "__main__":
    unittest.main()
