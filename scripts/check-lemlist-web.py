#!/usr/bin/env python3
"""End to end: LemList sync -> brain -> marketing.json, and GA4 landing paths.

LemList is mocked at the HTTP boundary (urlopen). Two runs: the stats route
refuses the key, then it answers with the documented fields.
"""
import io
import json
import logging
import os
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "refresh" / "brain-sync"))
import lemlist_sync  # noqa: E402

KEY = "lemlist-key-unit-fixture"
failures = []


def check(name, ok, detail=""):
    if ok:
        print("ok " + name)
    else:
        failures.append(name + (": " + str(detail) if detail else ""))


class Resp(io.BytesIO):
    def __init__(self, status, payload):
        super().__init__(json.dumps(payload).encode("utf-8"))
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def make_brain(path):
    con = sqlite3.connect(path)
    con.executescript("""
      create table lemlist_campaigns(campaign_id text primary key, name text, status text, raw_json text, fetched_at text);
      create table sync_state(source text primary key, watermark text, last_run text, note text);
      create table ga4_reports(report_key text primary key, property_id text, params_json text, result_json text, fetched_at text);
      create table sheets_data(spreadsheet_id text, spreadsheet_title text, tab text, row_num int, row_json text);
      create table otterly_reports(report_id text, brand text, domain text, competitors_json text, stats_json text, fetched_at text);
      create table meetings(recorded_by_name text, recorded_by_email text);
      create table hubspot_objects(object_type text, hs_id text, properties_json text, fetched_at text);
    """)
    landing = {"metricHeaders": [{"name": "sessions"}, {"name": "engagedSessions"}, {"name": "keyEvents"}],
               "rows": [{"dimensionValues": [{"value": "/book-a-meeting/&lt;/a&gt;&lt;/p&gt"}],
                         "metricValues": [{"value": "486"}, {"value": "18"}, {"value": "0"}]}]}
    con.execute("insert into ga4_reports values(?,?,?,?,?)", ("landing_90d", "304508954", "{}", json.dumps(landing), "2026-09-27T22:00:00Z"))
    con.commit()
    con.close()


def run_sync(brain, stats_status, stats_payload):
    seen = []

    def urlopen(req, timeout=None):
        url = req.full_url
        auth = req.get_header("Authorization") or ""
        seen.append((url, auth))
        if url.startswith("https://api.lemlist.com/api/campaigns"):
            return Resp(200, [{"_id": "cam_1", "name": "ProcureCon East", "status": "running", "createdAt": "2026-09-01T00:00:00.000Z"},
                              {"_id": "cam_2", "name": "Multiple ERPs (sales)", "status": "running", "createdAt": "2026-06-01T00:00:00.000Z"}])
        if "/api/v2/campaigns/" in url:
            if stats_status != 200:
                raise urllib.error.HTTPError(url, stats_status, "refused", {}, io.BytesIO(b'{"error":"forbidden"}'))
            return Resp(200, stats_payload[url.split("/api/v2/campaigns/")[1].split("/")[0]])
        raise AssertionError("unexpected url " + url)

    lemlist_sync.urllib.request.urlopen = urlopen
    lemlist_sync.access_token_for = lambda names, scope=None: KEY
    lemlist_sync.url_with_access_token = lambda url, names, hosts: url + ("&" if "?" in url else "?") + "access_token=" + KEY
    lemlist_sync.db_connect = lambda: sqlite3.connect(brain)
    lemlist_sync.set_sync_state = lambda *a: None
    lemlist_sync.pace.wait = lambda: None
    stream = io.StringIO()
    log = logging.getLogger("lemlist-check")
    log.handlers = [logging.StreamHandler(stream)]
    log.setLevel(logging.INFO)
    note = lemlist_sync.main_sync(log)
    return note, seen, stream.getvalue()


def marketing(brain, out):
    out.mkdir(parents=True, exist_ok=True)
    (out / "sheet-review.json").write_text(json.dumps({"leads": []}))
    (out / "records.json").write_text(json.dumps({"generatedAt": "2026-09-27T20:00:00+00:00", "companies": []}))
    env = dict(os.environ, OUT_DATA=str(out), BRAIN_DB=str(brain))
    subprocess.run([sys.executable, str(ROOT / "scripts" / "marketing-data.py")], env=env, check=True, capture_output=True)
    return json.loads((out / "marketing.json").read_text())


tmp = Path(tempfile.mkdtemp())
brain = tmp / "brain.db"
make_brain(brain)

note, seen, logged = run_sync(brain, 403, None)
stats_calls = [s for s in seen if "/api/v2/campaigns/" in s[0]]
check("refused stats do not stop the sync", "2 campaigns refreshed" in note, note)
check("stats use Basic auth first", stats_calls and stats_calls[0][1].startswith("Basic ") and "access_token" not in stats_calls[0][0])
check("the key is not logged", KEY not in logged and "Basic " not in logged)
m = marketing(brain, tmp / "a")
out = m["outbound"]
check("refusal is named on the page data", out.get("statsBlocked") is True and "not available on this API key" in out.get("reason", "")
      and "/api/v2/campaigns/{campaignId}/stats" in out.get("reason", "") and "403" in out.get("reason", ""), out.get("reason"))
check("campaign names still refresh", out.get("campaigns") == 2 and "ProcureCon East" in out.get("names", []))

payload = {"cam_1": {"messagesSent": 120, "delivered": 115, "opened": 60, "replied": 4, "messagesBounced": 5, "meetingBooked": 1},
           "cam_2": {"messagesSent": 591, "delivered": 555, "opened": 210, "replied": 0, "messagesBounced": 36}}
note, seen, logged = run_sync(brain, 200, payload)
m = marketing(brain, tmp / "b")
out = m["outbound"]
rows = {c["name"]: c for c in out.get("campaignStats", [])}
check("stats reach marketing.json", out.get("connected") is True and rows.get("ProcureCon East", {}).get("sent") == 120
      and rows["ProcureCon East"].get("opened") == 60 and rows["ProcureCon East"].get("replied") == 4, rows)
sys.path.insert(0, str(ROOT / "scripts"))
from marketing_priorities import silent_sequences  # noqa: E402
card = silent_sequences(m, "Sep 27")
check("silent sequence priority", card and "Multiple ERPs (sales) (591 sent, 36 bounced)" in card["why"], card and card["why"])

pages = m["web"]["pages"]
check("landing path is readable", pages and pages[0]["display"] == "/book-a-meeting/" and pages[0]["strayHtml"] == "</a></p>", pages)

print(json.dumps({"ok": not failures, "failures": failures}, indent=2))
sys.exit(1 if failures else 0)
