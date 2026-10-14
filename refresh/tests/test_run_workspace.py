"""End-to-end test of the sync-only publish path's workspace.json step.

Runs run.main_sync_only against a filesystem store (FsStore) seeded with a
published run, a synthetic brain.db and state/gtm-inputs/. The real
scripts/workspace-data.py runs as a subprocess; build_workspace, the content
hash, publish_tree and the LATEST.json pointer are the real code. Only the
build steps that are not in this repo (brain-data.py, sheet-review.py,
align-run.py, term_scrub.py, the renderer) are stubbed: they write the few
files the publish path reads. No source sync runs. All data is synthetic.

    python3 -m unittest discover -s refresh/tests -v
"""

import contextlib
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402

PREVIOUS_RUN = "20261013T000000Z-test-snap"
FETCHED = "2026-10-13T10:00:00+00:00"
LATER = "2026-10-13T10:15:00+00:00"
DEAL_9001 = {"hs_object_id": "9001", "dealname": "Test deal 9001", "pipeline": "default", "dealstage": "s1",
             "amount": "1000", "createdate": "2026-09-01T00:00:00Z", "hs_lastmodifieddate": FETCHED}


def seed_brain(path):
    con = sqlite3.connect(str(path))
    con.executescript("""
        CREATE TABLE sync_state(source TEXT PRIMARY KEY, watermark TEXT, last_run TEXT, note TEXT);
        CREATE TABLE hubspot_objects(object_type TEXT, hs_id TEXT, properties_json TEXT, fetched_at TEXT,
                                     PRIMARY KEY(object_type, hs_id));
        CREATE TABLE hubspot_pipelines(pipeline_id TEXT, pipeline_label TEXT, stage_id TEXT, stage_label TEXT,
                                       display_order INTEGER, is_closed INTEGER, probability TEXT,
                                       PRIMARY KEY(pipeline_id, stage_id));
        CREATE TABLE hubspot_associations(from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT,
                                          PRIMARY KEY(from_type, from_id, to_type, to_id));
        CREATE TABLE hubspot_owners(id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT,
                                    archived INTEGER);
        CREATE TABLE sync_outcomes(source TEXT PRIMARY KEY, at TEXT, ok INTEGER, route TEXT, http INTEGER,
                                   detail TEXT, last_ok_at TEXT);
    """)
    con.execute("INSERT INTO hubspot_owners VALUES('1', 'Test', 'Owner', 'owner@example.com', 0)")
    con.execute("INSERT INTO sync_outcomes VALUES('hubspot', ?, 1, NULL, 200, 'test', ?)", (FETCHED, FETCHED))
    con.executemany("INSERT INTO hubspot_pipelines VALUES(?,?,?,?,?,?,?)", [
        ("default", "Sales Pipeline", "s1", "Discovery", 0, 0, "0.2"),
        ("default", "Sales Pipeline", "s2", "Closed won", 1, 1, "1.0")])
    for props in (DEAL_9001, dict(DEAL_9001, hs_object_id="9002", dealname="Test deal 9002", dealstage="s2",
                                  amount="500")):
        con.execute("INSERT INTO hubspot_objects VALUES('deals', ?, ?, ?)",
                    (props["hs_object_id"], json.dumps(props), FETCHED))
    con.commit()
    con.close()


def fake_run_step(cmd, env, cwd):
    """Stand-ins for the build steps that live outside this repo."""
    out = Path(env["OUT_DATA"]) if "OUT_DATA" in env else None
    script = Path(cmd[1]).name if len(cmd) > 1 else ""
    if script == "brain-data.py":
        (out / "verified.json").write_text(json.dumps({"snapshotId": "test-snap"}))
        (out / "records.json").write_text(json.dumps({"verifiedSnapshotId": "test-snap",
                                                      "generatedAt": "2026-10-13T12:00:00Z"}))
    elif script == "sheet-review.py":
        (out / "sheet-review.json").write_text(json.dumps({"leadTracker": {"rows": 1}}))
    elif script == "align-run.py":
        (out / "hollie.json").write_text(json.dumps({"runId": "test-run"}))
        if env.get("TEST_PARTIAL_WORKSPACE"):
            # Left over in out/ before the step runs; a failed step must not publish it.
            (out / run.WORKSPACE_JSON).write_text('{"partial":')


class WorkspaceStepE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="run-workspace-"))
        self.root = self.tmp / "store"
        self.store = run.FsStore(self.root)
        brain = self.tmp / "seed.db"
        seed_brain(brain)
        self.store.put_file("data/brain/brain.db", brain)
        prefix = "published/%s/" % PREVIOUS_RUN
        # The previous run's live_deals.json: no open deals yet, fetched before this run's data.
        previous = {"fetchedAt": "2026-10-12T10:00:00+00:00", "pipes": {"default": "Sales Pipeline"},
                    "stages": {"s1": {"label": "Discovery", "closed": False, "prob": 0.2}}, "deals": []}
        self.store.put_bytes(prefix + run.LIVE_DEALS, json.dumps(previous).encode())
        self.store.put_bytes(prefix + "verified.json", b'{"snapshotId": "test-snap"}')
        self.store.put_bytes("published/LATEST.json", json.dumps(
            {"runId": PREVIOUS_RUN, "prefix": prefix, "snapshotId": "test-snap"}).encode())
        self.put_input("scrub-patterns.txt", "synthetic-hidden-owner\n")
        self.put_input("lost-reasons.json", "{}")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("WORKSPACE_SCRUB_PATTERNS")}
        self.env.update({"REFRESH_WORK": str(self.tmp / "work"), "REFRESH_SYNC_DIR": str(self.tmp / "sync"),
                         "SYNC_ONLY_SOURCES": "", "SYNC_SKIP_WINDOWS": ""})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def put_input(self, name, text):
        self.store.put_bytes("state/gtm-inputs/" + name, text.encode("utf-8"))

    def publish(self, **env_extra):
        """main_sync_only once. Returns (exit code, log, published prefix or None)."""
        buf = io.StringIO()
        env = dict(self.env, **env_extra)
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(run, "run_step", fake_run_step), \
                contextlib.redirect_stdout(buf):
            code = run.main_sync_only({}, self.store)
        latest = json.loads(self.store.get_bytes("published/LATEST.json"))
        moved = latest["runId"] != PREVIOUS_RUN
        return code, buf.getvalue(), latest["prefix"] if moved else None

    def test_publishes_workspace_json(self):
        code, log, prefix = self.publish()
        self.assertEqual(code, 0, log)
        self.assertIsNotNone(prefix, "nothing was published\n" + log)
        self.assertEqual(json.loads(self.store.get_bytes(prefix + run.LIVE_DEALS))["openBook"]["salesOpen"]["count"], 1)
        ws = json.loads(self.store.get_bytes(prefix + run.WORKSPACE_JSON))
        self.assertEqual(ws["headline"]["open"]["count"], 1)
        self.assertEqual(ws["headline"]["open"]["amount"], 1000)
        self.assertEqual(ws["meta"]["portalId"], run.HUBSPOT_PORTAL_ID)
        # Inputs came from state/gtm-inputs/; the ones not uploaded are listed as missing.
        self.assertTrue(ws["meta"]["inputs"]["lost-reasons.json"])
        self.assertFalse(ws["meta"]["inputs"]["lead-sources.json"])
        self.assertIn("missing (that part of the page degrades): lead-sources.json", log)
        # --prior is the previous run's live_deals.json: the deal is new since then.
        change = ws["headline"]["change"]
        self.assertEqual((change["from"]["count"], change["to"]["count"]), (0, 1), change)
        self.assertEqual([d["kind"] for d in change["deals"]], ["new"])
        self.assertIn("workspace: wrote workspace.json", log)
        self.assertIn(run.WORKSPACE_JSON, self.store.get_bytes(prefix + "MANIFEST.txt").decode())
        # A HubSpot sync that changed nothing: the prior is now this run's export, so the
        # "what changed" note differs, but the content hash leaves it out. Nothing is published.
        self.edit_brain("UPDATE sync_outcomes SET at=?, last_ok_at=? WHERE source='hubspot'", LATER, LATER)
        code, log, again = self.publish()
        self.assertEqual(code, 0, log)
        self.assertIn("no change", log)
        self.assertEqual(again, prefix)
        self.assertNotIn("WARNING", log)
        # A real change publishes; the note compares with the last published run.
        props = dict(DEAL_9001, amount="1500")
        self.edit_brain("UPDATE hubspot_objects SET properties_json=? WHERE hs_id='9001'", json.dumps(props))
        code, log, third = self.publish()
        self.assertEqual(code, 0, log)
        self.assertIn("published " + third.split("/")[1], log)
        change = json.loads(self.store.get_bytes(third + run.WORKSPACE_JSON))["headline"]["change"]
        self.assertEqual([(d["kind"], d["fromAmount"], d["amount"]) for d in change["deals"]],
                         [("amount", 1000, 1500)])

    def backdate_latest(self, minutes):
        """LATEST.json as if it were published `minutes` ago (pointer otherwise unchanged)."""
        latest = json.loads(self.store.get_bytes("published/LATEST.json"))
        latest["publishedAt"] = (run.datetime.now(run.timezone.utc) - run.timedelta(minutes=minutes)).isoformat()
        self.store.put_bytes("published/LATEST.json", json.dumps(latest).encode())
        return latest

    def test_republishes_unchanged_content_once_latest_is_old(self):
        code, log, first = self.publish()
        self.assertEqual(code, 0, log)
        ws1 = json.loads(self.store.get_bytes(first + run.WORKSPACE_JSON))
        self.assertEqual(ws1["fresh"]["won"]["fetchedAt"], "2026-10-13T10:00:00Z")
        # A later sync that changed nothing but its fetch time. LATEST.json 10 minutes old: nothing published.
        self.edit_brain("UPDATE sync_outcomes SET at=?, last_ok_at=? WHERE source='hubspot'", LATER, LATER)
        self.backdate_latest(10)
        code, log, again = self.publish()
        self.assertEqual(code, 0, log)
        self.assertIn("no change", log)
        self.assertNotIn("republish", log)
        self.assertEqual(again, first)
        # Turned off (PUBLISH_MAX_AGE_MIN=0): an hour-old LATEST.json still publishes nothing.
        self.backdate_latest(60)
        code, log, again = self.publish(PUBLISH_MAX_AGE_MIN="0")
        self.assertIn("no change", log)
        self.assertEqual(again, first)
        # Past the default 25 minutes: the same content is published again, with the new times.
        old = self.backdate_latest(30)
        time.sleep(1.1)  # run ids have one-second resolution
        code, log, second = self.publish()
        self.assertEqual(code, 0, log)
        self.assertIn("republish: unchanged content, last publish 30 min old", log)
        self.assertNotIn("no change", log)
        self.assertNotEqual(second, first, log)
        self.assertIn("published " + second.split("/")[1], log)
        latest = json.loads(self.store.get_bytes("published/LATEST.json"))
        self.assertEqual((latest["mode"], latest["contentHash"]), ("sync-only", old["contentHash"]))
        self.assertLess(run.publish_age_min(latest), 1)
        ws2 = json.loads(self.store.get_bytes(second + run.WORKSPACE_JSON))
        self.assertEqual(ws2["fresh"]["won"]["fetchedAt"], "2026-10-13T10:15:00Z", "the fetch times move")
        self.assertEqual(ws2["headline"]["open"], ws1["headline"]["open"])
        self.assertTrue(self.store.exists(first + run.WORKSPACE_JSON), "the previous run is kept (prune unchanged)")
        # Straight after: a fresh LATEST.json, nothing to republish.
        code, log, third = self.publish()
        self.assertIn("no change", log)
        self.assertEqual(third, second)
        # A lower max age from the environment.
        self.backdate_latest(6)
        code, log, _ = self.publish(PUBLISH_MAX_AGE_MIN="5")
        self.assertIn("republish: unchanged content, last publish 6 min old", log)
        self.assertLess(run.publish_age_min(json.loads(self.store.get_bytes("published/LATEST.json"))), 1)

    def test_republish_age_parsing(self):
        now = run.datetime(2026, 10, 13, 12, 0, tzinfo=run.timezone.utc)
        self.assertEqual(run.publish_age_min({"publishedAt": "2026-10-13T11:30:00+00:00"}, now), 30)
        self.assertEqual(run.publish_age_min({"publishedAt": "2026-10-13T11:50:00Z"}, now), 10)
        self.assertIsNone(run.publish_age_min({}, now))
        self.assertIsNone(run.publish_age_min({"publishedAt": "yesterday"}, now))
        with mock.patch.dict(os.environ, {"PUBLISH_MAX_AGE_MIN": ""}):
            self.assertEqual(run.republish_due({"publishedAt": "2026-10-13T11:40:00Z"}, now), (False, 20))
            self.assertEqual(run.republish_due({"publishedAt": "2026-10-13T11:35:00Z"}, now), (True, 25))
            self.assertEqual(run.republish_due({}, now), (True, None), "no time on the pointer: publish")
        with mock.patch.dict(os.environ, {"PUBLISH_MAX_AGE_MIN": "soon"}):
            self.assertEqual(run.republish_due({"publishedAt": "2026-10-13T11:35:00Z"}, now), (True, 25), "unreadable: the default")

    def edit_brain(self, sql, *args):
        path = self.tmp / "edit.db"
        self.store.get_file("data/brain/brain.db", path)
        con = sqlite3.connect(str(path))
        con.execute(sql, args)
        con.commit()
        con.close()
        self.store.put_file("data/brain/brain.db", path)

    def test_failing_step_still_publishes(self):
        # No scrub patterns: workspace-data.py refuses to run. A partial file left in out/ is removed.
        self.store.delete("state/gtm-inputs/scrub-patterns.txt")
        code, log, prefix = self.publish(TEST_PARTIAL_WORKSPACE="1")
        self.assertEqual(code, 0, log)
        self.assertIsNotNone(prefix, "a failed workspace step blocked the publish\n" + log)
        self.assertIn("WARNING: workspace.json not built (RuntimeError: exit 1: no scrub patterns", log)
        self.assertFalse(self.store.exists(prefix + run.WORKSPACE_JSON))
        self.assertTrue(self.store.exists(prefix + run.LIVE_DEALS))
        self.assertNotIn(run.WORKSPACE_JSON, self.store.get_bytes(prefix + "MANIFEST.txt").decode())

    def test_timeout_still_publishes(self):
        with mock.patch.object(run, "WORKSPACE_TIMEOUT_S", 0.001):
            code, log, prefix = self.publish()
        self.assertEqual(code, 0, log)
        self.assertIsNotNone(prefix, log)
        self.assertIn("WARNING: workspace.json not built (TimeoutExpired: timed out after 0.001s)", log)
        self.assertFalse(self.store.exists(prefix + run.WORKSPACE_JSON))

    def test_store_error_still_publishes(self):
        # The inputs listing itself fails (for example a missing s3:ListBucket grant).
        def broken(prefix):
            raise PermissionError("AccessDenied on " + prefix)
        with mock.patch.object(self.store, "list_keys", side_effect=lambda p: broken(p) if "gtm-inputs" in p
                               else run.FsStore.list_keys(self.store, p)):
            code, log, prefix = self.publish()
        self.assertEqual(code, 0, log)
        self.assertIsNotNone(prefix, log)
        self.assertIn("WARNING: workspace.json not built (PermissionError", log)


if __name__ == "__main__":
    unittest.main()
