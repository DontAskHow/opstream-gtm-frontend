"""End-to-end: the GTM headline and workspace.json count the same open book.

The headline is the HubSpot Sales Pipeline's open deals, On Hold apart. A deal
counts with no company and with no master Sheet row. run.main_sync_only runs
against a filesystem store and one synthetic brain.db. The real
scripts/brain-data.py and scripts/workspace-data.py run. align-run.py is not in
this repo; its headline is gtm_metrics.snapshot_metrics(verified, records,
today, sheet_review), which the stand-in calls on brain-data.py's output.
sheet-review.py is stood in by a fixed sheet-review.json. All data is synthetic.

The same run also checks what the one-page workspace shows from that
workspace.json: internal sync steps (backfills) get no freshness chip of their
own while they are ok, and lead -> MQL stays hidden while config/lead-rules.json
says mql.show is false, though its inputs are there and it is computed.

    python3 -m unittest discover -s refresh/tests -v
"""

import contextlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
sys.path.insert(0, str(TESTS.parent))
sys.path.insert(0, str(TESTS.parents[1] / "scripts"))
import run  # noqa: E402
import gtm_metrics  # noqa: E402
from test_run_workspace import FETCHED, seed_brain  # noqa: E402

PREVIOUS_RUN = "20261013T000000Z-test-snap"
RENEWAL_PIPELINE = "686463412"


def deal(hs_id, stage, amount, pipeline="default", prob="0.2"):
    return {"hs_object_id": hs_id, "dealname": "Test deal " + hs_id, "pipeline": pipeline, "dealstage": stage,
            "amount": amount, "hs_deal_stage_probability": prob, "hubspot_owner_id": "1",
            "closedate": "2027-01-15T00:00:00Z", "createdate": "2026-09-01T00:00:00Z",
            "hs_lastmodifieddate": FETCHED}


# 9001: Sheet row and a company. 9003: a company, no Sheet row (the HubSpot-only
# deal). 9004: no company and no Sheet row. All three are open and count.
# 9002 closed won, 9005 Disqualified (closed by the stage's isClosed, not its
# name), 9006 On Hold in HubSpot though the Sheet says SQL, 9007 renewal pipeline:
# none of these count.
DEALS = [deal("9001", "s1", "1000"), deal("9002", "s2", "500", prob="1"), deal("9003", "s1", "2500"),
         deal("9004", "s3", "4000", prob="0.4"), deal("9005", "dq", "800", prob="0"),
         deal("9006", "hold", "700", prob="0.1"), deal("9007", "r1", "9000", pipeline=RENEWAL_PIPELINE)]
COMPANIES = {"7001": ("9001",), "7002": ("9003",)}
SHEET_REVIEW = {
    "leadTracker": {"rows": 1},
    "deals": [
        {"id": "deal-9001", "company": "Test company 7001", "stage": "Discovery/RFP received (Deal)", "amount": 1000},
        {"id": "deal-9006", "company": "Test company 9006", "stage": "SQL", "amount": 700},
        # A Sheet row with no HubSpot deal is not in the HubSpot book.
        {"id": "deal-9999", "company": "Test company 9999", "stage": "SQL", "amount": 50000},
    ],
}


ROOT = TESTS.parents[1]
LEAD_RULES = json.loads((ROOT / "config" / "lead-rules.json").read_text())
# Sync steps that run under a user-facing source. ok, so none of them is a chip.
INTERNAL_OK = ("hubspot_contact_backfill", "hubspot_meeting_backfill", "hubspot_forms", "fathom_backfill",
               "unlisted_backfill")


def seed_page_inputs(path):
    """Sync outcomes with internal rows, and what lead -> MQL needs: a book-a-demo booking and a form fill."""
    con = sqlite3.connect(str(path))
    for source in ("fathom",) + INTERNAL_OK:
        con.execute("INSERT INTO sync_outcomes VALUES(?, ?, 1, NULL, 200, 'test', ?)", (source, FETCHED, FETCHED))
    recent = (datetime.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    mql = LEAD_RULES["mql"]
    contacts = {"8001": "booker@buyer.example", "8002": "filler@buyer.example"}
    for cid, email in contacts.items():
        con.execute("INSERT INTO hubspot_objects VALUES('contacts', ?, ?, ?)",
                    (cid, json.dumps({"hs_object_id": cid, "email": email, "createdate": recent}), FETCHED))
    con.execute("INSERT INTO hubspot_objects VALUES('meetings', '8101', ?, ?)", (json.dumps({
        "hs_object_id": "8101", mql["meetingSourceProperty"]: mql["meetingSourceValue"],
        mql["bookingLinkProperty"]: str(mql["bookingLinkIds"][0]), "hs_createdate": recent,
        "hs_meeting_start_time": recent}), FETCHED))
    con.execute("INSERT INTO hubspot_associations VALUES('meetings', '8101', 'contacts', '8001')")
    con.execute("CREATE TABLE hubspot_form_submissions(form_id TEXT, submitted_at TEXT, contact_email TEXT, "
                "page_url TEXT, page_title TEXT, values_json TEXT)")
    con.execute("INSERT INTO hubspot_form_submissions VALUES('f-test', ?, ?, '', '', '{}')", (recent, contacts["8002"]))
    con.commit()
    con.close()


# The page's freshness chips and lead -> MQL tile, from workspace.json, by the deployed view code.
PAGE_JS = r"""
const fs = require('fs');
const { buildView } = require('./onepage/view.cjs');
const page = require('./onepage/page.cjs');
const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const v = buildView(d, null);
const header = page.header(v, { now: Date.parse(d.meta.generatedAt) });
const main = page.renderPage(v, {}).main;
console.log(JSON.stringify({ chips: v.freshness.map((c) => [c.source, c.label, c.level]), header, main }));
"""


def seed(path):
    seed_brain(path)
    con = sqlite3.connect(str(path))
    con.executescript("""
        DELETE FROM hubspot_objects;
        CREATE TABLE sheets_data(spreadsheet_title TEXT, tab TEXT, row_num INTEGER, row_json TEXT);
        CREATE TABLE meetings(recording_id TEXT PRIMARY KEY, title TEXT, meeting_type TEXT, created_at TEXT,
                              scheduled_start_time TEXT, scheduled_end_time TEXT, recording_start_time TEXT,
                              recording_end_time TEXT, recorded_by_name TEXT, recorded_by_email TEXT,
                              invitees_json TEXT, summary_markdown TEXT, action_items_json TEXT, fetched_at TEXT);
        CREATE TABLE transcripts(recording_id TEXT PRIMARY KEY, turns_json TEXT, n_turns INTEGER);
        CREATE TABLE findings(id TEXT PRIMARY KEY, kind TEXT, claim TEXT, confidence REAL, evidence_refs TEXT,
                              status TEXT, created_at TEXT);
        CREATE TABLE lemlist_campaigns(campaign_id TEXT PRIMARY KEY, name TEXT, status TEXT, raw_json TEXT,
                                       fetched_at TEXT);
        CREATE TABLE ga4_reports(report_key TEXT PRIMARY KEY, result_json TEXT, fetched_at TEXT);
    """)
    con.executemany("INSERT INTO hubspot_pipelines VALUES(?,?,?,?,?,?,?)", [
        ("default", "Sales Pipeline", "s3", "SQL", 2, 0, "0.4"),
        ("default", "Sales Pipeline", "dq", "Disqualified", 3, 1, "0"),
        ("default", "Sales Pipeline", "hold", "On Hold", 4, 0, "0.1"),
        (RENEWAL_PIPELINE, "Renewal Pipeline", "r1", "Renewal due", 0, 0, "0.2")])
    for props in DEALS:
        con.execute("INSERT INTO hubspot_objects VALUES('deals', ?, ?, ?)",
                    (props["hs_object_id"], json.dumps(props), FETCHED))
    for cid, deal_ids in COMPANIES.items():
        con.execute("INSERT INTO hubspot_objects VALUES('companies', ?, ?, ?)",
                    (cid, json.dumps({"hs_object_id": cid, "name": "Test company " + cid}), FETCHED))
        for did in deal_ids:
            con.execute("INSERT INTO hubspot_associations VALUES('deals', ?, 'companies', ?)", (did, cid))
    con.commit()
    con.close()


class HeadlineE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="headline-e2e-"))
        self.store = run.FsStore(self.tmp / "store")
        brain = self.tmp / "seed.db"
        seed(brain)
        seed_page_inputs(brain)
        self.store.put_file("data/brain/brain.db", brain)
        prefix = "published/%s/" % PREVIOUS_RUN
        self.store.put_bytes(prefix + "verified.json", b'{"snapshotId": "test-snap"}')
        self.store.put_bytes("published/LATEST.json", json.dumps(
            {"runId": PREVIOUS_RUN, "prefix": prefix, "snapshotId": "test-snap"}).encode())
        self.store.put_bytes("state/gtm-inputs/scrub-patterns.txt", b"synthetic-hidden-owner\n")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("WORKSPACE_SCRUB_PATTERNS")}
        self.env.update({"REFRESH_WORK": str(self.tmp / "work"), "REFRESH_SYNC_DIR": str(self.tmp / "sync"),
                         "SYNC_ONLY_SOURCES": "", "SYNC_SKIP_WINDOWS": ""})
        self.book = None

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_step(self, cmd, env, cwd):
        out = Path(env["OUT_DATA"])
        script = Path(cmd[1]).name if len(cmd) > 1 else ""
        if script == "brain-data.py":
            run.subprocess.run(cmd, env=env, cwd=str(cwd), check=True, stdout=run.subprocess.DEVNULL)
        elif script == "sheet-review.py":
            (out / "sheet-review.json").write_text(json.dumps(SHEET_REVIEW))
        elif script == "align-run.py":
            # align-run.py's headline: snapshot_metrics over brain-data.py's files.
            records = json.loads((out / "records.json").read_text())
            self.book = gtm_metrics.snapshot_metrics(
                json.loads((out / "verified.json").read_text()), records,
                today=gtm_metrics.date_only(records["generatedAt"]), sheet_review=SHEET_REVIEW)
            (out / "hollie.json").write_text(json.dumps({"runId": "test-run"}))

    def publish(self):
        buf = io.StringIO()
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(run, "run_step", self.run_step), \
                contextlib.redirect_stdout(buf):
            code = run.main_sync_only({}, self.store)
        log = buf.getvalue()
        self.assertEqual(code, 0, log)
        prefix = json.loads(self.store.get_bytes("published/LATEST.json"))["prefix"]
        self.assertNotIn(PREVIOUS_RUN, prefix, "nothing was published\n" + log)
        return prefix

    def test_hubspot_only_and_companyless_deals_count_in_both(self):
        prefix = self.publish()
        verified = json.loads(self.store.get_bytes(prefix + "verified.json"))
        self.assertEqual({o["id"]: o["companyId"] for o in verified["opportunities"]}["deal-9004"], "company:unknown")

        ws = json.loads(self.store.get_bytes(prefix + run.WORKSPACE_JSON))["headline"]
        book = self.book
        want = ["9001", "9003", "9004"]
        self.assertEqual(sorted(d["id"].replace("deal-", "") for d in book["openDeals"]), want)
        self.assertEqual((book["openCount"], book["openAmount"], book["weighted"]), (3, 7500, 2300))
        self.assertEqual((ws["open"]["count"], ws["open"]["amount"], ws["open"]["weighted"]), (3, 7500, 2300))
        self.assertEqual((book["onHoldCount"], book["onHoldAmount"]), (1, 700))
        self.assertEqual((ws["onHold"]["count"], ws["onHold"]["amount"]), (1, 700))
        # In the book though not on the Sheet: the HubSpot-only and company-less deals.
        self.assertEqual(book["hubspotOnlyCount"], 2)
        reasons = {d["id"]: d["reason"] for d in book["deals"]}
        self.assertEqual(reasons["deal-9005"], "Disqualified")
        self.assertEqual(reasons["deal-9006"], "On Hold")
        self.assertEqual(reasons["deal-9007"], "renewal")
        self.assertEqual(reasons["deal-9999"], "On the Sheet, not in HubSpot")

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_page_backfill_rows_are_not_chips_and_mql_stays_hidden(self):
        prefix = self.publish()
        target = self.tmp / "workspace.json"
        target.write_bytes(self.store.get_bytes(prefix + run.WORKSPACE_JSON))
        doc = json.loads(target.read_text())

        # workspace.json keeps every sync row; the page rolls the internal ones up into their parent.
        rows = {f["source"]: f for f in doc["freshness"]}
        for source in INTERNAL_OK:
            self.assertTrue(rows[source]["ok"], source)
        proc = subprocess.run(["node", "-e", PAGE_JS, str(target)], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual([c[0] for c in out["chips"]], ["hubspot", "fathom"])
        self.assertTrue(all(level == "ok" for _source, _label, level in out["chips"]), out["chips"])
        self.assertNotRegex(out["header"], r"(?i)backfill|hubspot_forms|unlisted")

        # lead -> MQL: computed (one booker via the book-a-demo page, one form filler), not shown.
        self.assertIs(LEAD_RULES["mql"]["show"], False)
        funnel = doc["mqlFunnel"]
        self.assertFalse(funnel["available"])
        self.assertEqual(funnel["reason"], LEAD_RULES["mql"]["hiddenBecause"])
        self.assertEqual((funnel["computed"]["numerator"], funnel["computed"]["denominator"]), (1, 2))
        self.assertNotIn("lead-mql-90", out["main"])
        self.assertNotIn(LEAD_RULES["mql"]["label"], out["main"] + out["header"])


if __name__ == "__main__":
    unittest.main()
