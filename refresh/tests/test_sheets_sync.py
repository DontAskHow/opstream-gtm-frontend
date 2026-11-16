"""sheets_sync against a fake Sheets API: unreadable spreadsheets versus a rejected credential.

Each test copies refresh/brain-sync to a temp dir, seeds a synthetic brain.db
and replaces urlopen and the token call. No network, no AWS.
"""
import io
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
RULES = json.loads((ROOT / "config" / "freshness-sources.json").read_text())


def google_error(code, status, message, reason=None):
    err = {"code": code, "message": message, "status": status}
    if reason:
        err["details"] = [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason,
                           "domain": "googleapis.com"}]
    return json.dumps({"error": err})


NOT_SHARED = (403, google_error(403, "PERMISSION_DENIED", "The caller does not have permission"))
NOT_FOUND = (404, google_error(404, "NOT_FOUND", "Requested entity was not found."))
SCOPE = (403, google_error(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.",
                           "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))


class SheetsSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="sheets-sync-"))
        cls.sync_dir = cls.tmp / "brain-sync"
        shutil.copytree(ROOT / "refresh" / "brain-sync", cls.sync_dir, ignore=shutil.ignore_patterns("logs"))
        cls.db = cls.tmp / "brain.db"
        os.environ["BRAIN_DB"] = str(cls.db)
        for name in ("common", "sheets_sync"):
            sys.modules.pop(name, None)
        sys.path.insert(0, str(cls.sync_dir))
        import common
        import sheets_sync
        cls.common, cls.mod = common, sheets_sync
        sheets_sync.pace.wait = lambda: None

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(cls.sync_dir))
        for name in ("common", "sheets_sync"):
            sys.modules.pop(name, None)
        os.environ.pop("BRAIN_DB", None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.db.unlink(missing_ok=True)
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE sheets_data(spreadsheet_id TEXT, spreadsheet_title TEXT, tab TEXT, row_num INTEGER, row_json TEXT)")
        con.execute("CREATE TABLE sync_state(source TEXT PRIMARY KEY, watermark TEXT, last_run TEXT, note TEXT)")
        for n in range(1, 5):
            con.execute("INSERT INTO sheets_data VALUES(?,?,?,1,?)", ("sheet-%d" % n, "Synthetic %d" % n, "Tab", '["old"]'))
        con.commit()
        con.close()

    def run_sync(self, failures=None, token=None):
        """Run the script's entrypoint. failures: {spreadsheet id: (http status, body)}."""
        failures = failures or {}

        def urlopen(req, timeout=None):
            path = urllib.parse.urlparse(req.full_url).path
            ss_id = path.split("/")[3].split(":")[0]
            if ss_id in failures:
                code, body = failures[ss_id]
                raise urllib.error.HTTPError(req.full_url, code, "error", {}, io.BytesIO(body.encode()))
            if path.endswith("values:batchGet"):
                body = {"valueRanges": [{"range": "'Tab'!A1:Z", "values": [["new", ss_id]]}]}
            else:
                body = {"sheets": [{"properties": {"title": "Tab", "sheetId": 7}}]}
            return io.BytesIO(json.dumps(body).encode())

        with mock.patch.object(self.mod.urllib.request, "urlopen", urlopen), \
                mock.patch.object(self.mod, "google_access_token", token or (lambda: "synthetic-token")), \
                mock.patch("sys.stdout", io.StringIO()), self.assertRaises(SystemExit) as done:
            self.common.run_main("sheets", self.mod.main_sync)
        con = sqlite3.connect(self.db)
        try:
            rows = dict(con.execute("SELECT spreadsheet_id, row_json FROM sheets_data"))
            ok, http, detail = con.execute("SELECT ok, http, detail FROM sync_outcomes WHERE source='sheets'").fetchone()
            marks = con.execute("SELECT count(*) FROM sync_state").fetchone()[0]
        finally:
            con.close()
        return {"exit": done.exception.code, "rows": rows, "ok": ok, "http": http, "detail": detail, "watermarks": marks}

    def assert_needs_connection(self, out):
        self.assertEqual(out["exit"], self.common.EXIT_NEEDS_CONNECTION)
        self.assertEqual(out["ok"], 0)
        self.assertEqual(out["watermarks"], 0)
        self.assertTrue(any(re.search(p, out["detail"], re.I) for p in RULES["auth"]["patterns"]), out["detail"])
        self.assertNotIn("unreadable", out["detail"])

    def test_unreadable_spreadsheets_are_skipped_and_the_run_fails_with_their_count(self):
        out = self.run_sync({"sheet-2": NOT_SHARED, "sheet-3": NOT_FOUND})
        self.assertEqual(out["rows"], {"sheet-1": '["new", "sheet-1"]', "sheet-2": '["old"]',
                                       "sheet-3": '["old"]', "sheet-4": '["new", "sheet-4"]'})
        self.assertEqual((out["exit"], out["ok"], out["http"], out["watermarks"]), (self.common.EXIT_ERROR, 0, None, 0))
        self.assertEqual(out["detail"], "SourceUnreadable: 2 of 4 spreadsheets unreadable "
                                        "(1 not found, 1 permission denied); 2 re-pulled. Not touching watermarks.")
        # The same rules the preview refresh reads: unreadable, and not a credential.
        self.assertTrue(any(re.search(p, out["detail"], re.I) for p in RULES["unreadable"]["patterns"]))
        self.assertFalse(any(re.search(p, out["detail"], re.I) for p in RULES["auth"]["patterns"]))

    def test_gone_is_unreadable_and_a_clean_run_still_succeeds(self):
        out = self.run_sync({"sheet-1": (410, "gone")})
        self.assertIn("1 of 4 spreadsheets unreadable (1 not found)", out["detail"])
        out = self.run_sync()
        self.assertEqual((out["exit"], out["ok"], out["watermarks"]), (0, 1, 1))

    def test_a_401_still_needs_connection(self):
        out = self.run_sync({"sheet-2": (401, google_error(401, "UNAUTHENTICATED", "Invalid Credentials"))})
        self.assert_needs_connection(out)
        self.assertEqual(out["rows"]["sheet-4"], '["old"]')

    def test_a_token_endpoint_error_still_needs_connection(self):
        def token():
            raise self.common.NeedsConnection("Google refresh token was rejected. Not touching watermarks.")
        self.assert_needs_connection(self.run_sync(token=token))

    def test_a_403_that_blames_the_token_or_cannot_be_read_still_needs_connection(self):
        bodies = {
            "scope": SCOPE[1],
            "scope, legacy shape": json.dumps({"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "Insufficient Permission",
                                                         "errors": [{"reason": "insufficientPermissions"}]}}),
            "scope, message only": google_error(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes."),
            "api disabled": google_error(403, "PERMISSION_DENIED", "API has not been used in this project", "SERVICE_DISABLED"),
            "not json": "<html>Forbidden</html>",
            "empty": "",
            "no status": json.dumps({"error": {"code": 403, "message": "The caller does not have permission"}}),
            "not an object": json.dumps({"error": "forbidden"}),
        }
        for name, body in bodies.items():
            with self.subTest(name):
                self.setUp()
                out = self.run_sync({"sheet-2": (403, body)})
                self.assert_needs_connection(out)
                self.assertEqual(out["detail"], "Google Sheets returned 403. Not touching watermarks.")
                self.assertEqual(out["rows"]["sheet-4"], '["old"]')


if __name__ == "__main__":
    unittest.main()
