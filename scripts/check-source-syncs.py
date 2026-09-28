#!/usr/bin/env python3
"""End to end: refresh/run.py with Fathom, Otterly, LemList and OpenAI mocked at urlopen.

The mocks behave like the live APIs: Fathom refuses Bearer (401) and accepts
X-Api-Key; api.otterly.ai refuses every key (401) and data.otterly.ai accepts
Bearer. OpenAI returns an empty reply cut off by length until the budget is
large enough. A second run revokes the Fathom key and breaks Otterly: the
refresh still publishes, keeps the last good data, and names source, route
and status on the page.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEYS = {"fathom-token": "fathom-key-fixture", "otterly-token": "otterly-key-fixture",
        "lemlist-token": "lemlist-key-fixture", "openai-api-key": "openai-key-fixture"}
failures = []


def check(name, ok, detail=""):
    if ok:
        print("ok " + name)
    else:
        failures.append(name + (": " + str(detail)[:300] if detail else ""))


MOCK = r'''
import base64, io, json, os, urllib.error, urllib.parse, urllib.request
SCENARIO = os.environ["MOCK_SCENARIO"]
LOG = os.environ["MOCK_LOG"]
KEYS = json.loads(os.environ["MOCK_KEYS"])

class Resp(io.BytesIO):
    def __init__(self, status, payload):
        super().__init__(json.dumps(payload).encode("utf-8")); self.status = status
    def __enter__(self): return self
    def __exit__(self, *a): return False

def err(url, code, payload):
    return urllib.error.HTTPError(url, code, "mock", {}, io.BytesIO(json.dumps(payload).encode("utf-8")))

def meeting(rid, created):
    return {"title": "Call %d" % rid, "meeting_title": "Call %d" % rid, "meeting_type": None, "recording_id": rid,
            "url": "https://fathom.video/calls/%d" % rid, "share_url": "https://fathom.video/share/%d" % rid,
            "created_at": created, "scheduled_start_time": created, "scheduled_end_time": created,
            "recording_start_time": created, "recording_end_time": created, "transcript_language": "en",
            "calendar_invitees_domains_type": "one_or_more_external", "shared_with": "all_teams",
            "recorded_by": {"name": "Hollie Farrahi", "email": "hollie.farrahi@opstream.ai", "email_domain": "opstream.ai", "team": None},
            "calendar_invitees": [{"name": "Buyer", "email": "buyer@acme.example", "email_domain": "acme.example", "is_external": True}],
            "default_summary": {"template_name": "general", "markdown_formatted": "## Summary\nBudget review for %d." % rid},
            "transcript": [{"speaker": {"display_name": "Buyer", "matched_calendar_invitee_email": "buyer@acme.example"}, "text": "We need approvals in one place.", "timestamp": "00:01:02"}],
            "action_items": [{"description": "Send the security pack", "user_generated": False, "completed": False,
                              "recording_timestamp": "00:10:00", "recording_playback_url": "https://fathom.video/calls/%d?timestamp=600" % rid,
                              "assignee": {"name": "Hollie Farrahi", "email": "hollie.farrahi@opstream.ai", "team": None}}],
            "highlights": []}

def fathom(req, url, q):
    if req.get_header("Authorization"):
        raise err(url, 401, {"error": "invalid Authorization header"})
    if req.get_header("X-api-key") != KEYS["fathom-token"] or SCENARIO == "refused":
        raise err(url, 401, {"error": "invalid api key"})
    if not url.split("?")[0].endswith("/external/v1/meetings"):
        raise err(url, 404, {"error": "not found"})
    for flag in ("include_summary", "include_transcript", "include_action_items"):
        if q.get(flag) != ["true"]:
            raise err(url, 400, {"error": "missing " + flag})
    if "recorded_after" in q or "limit" in q:
        raise err(url, 400, {"error": "unknown parameter"})
    if q.get("cursor") == ["c2"]:
        return Resp(200, {"limit": 10, "next_cursor": None, "items": [meeting(9003, "2026-09-27T16:00:00Z")]})
    return Resp(200, {"limit": 10, "next_cursor": "c2", "items": [meeting(9001, "2026-09-26T15:00:00Z"), meeting(9002, "2026-09-27T09:00:00Z")]})

def otterly(req, url, q, path):
    if urllib.parse.urlparse(url).hostname == "api.otterly.ai":
        raise err(url, 401, {"message": "Unauthorized"})
    if req.get_header("Authorization") != "Bearer " + KEYS["otterly-token"]:
        raise err(url, 401, {"message": "Unauthorized"})
    if path == "/v1/accounts/info":
        return Resp(200, {"subscriptionPlan": "standard", "apiRequestsUsedCount": 38, "apiRequestsMaxCount": 1500})
    if path == "/v1/workspaces":
        return Resp(200, {"items": [{"id": "ws1", "name": "Opstream"}], "paging": {"nextCursor": None, "hasMore": False}})
    if path == "/v1/reports/brand":
        if SCENARIO == "refused":
            raise err(url, 500, {"message": "internal error"})
        return Resp(200, {"items": [{"id": "rep1", "workspaceId": "ws1", "brand": "Opstream", "brandDomain": "opstream.ai",
                                     "countries": ["us"], "competitors": [{"brand": "Zip"}]}],
                          "paging": {"nextCursor": None, "hasMore": False}})
    if path == "/v1/reports/brand/rep1/stats":
        if not all(q.get(k) for k in ("startDate", "endDate", "country")):
            raise err(url, 400, {"message": "startDate, endDate and country are required"})
        return Resp(200, {"id": "rep1", "status": "finished", "totalPrompts": 39,
                          "brand": {"brand": "Opstream", "brandDomain": "opstream.ai"},
                          "summary": {"averageRank": 2.0, "averagePosition": 2.0, "totalMentions": 900, "totalSources": 39,
                                      "shareOfVoice": 12, "brandCoverage": 48, "domainCoverage": 12.5},
                          "detectedBrands": [{"name": "Zip", "mentions": 30}]})
    if path == "/v1/reports/brand/rep1/prompts":
        return Resp(200, {"items": [{"id": "p%d" % i} for i in range(39)], "paging": {"nextCursor": None, "hasMore": False}})
    raise err(url, 404, {"message": "not found"})

def lemlist(req, url, path):
    if path == "/api/campaigns":
        return Resp(200, [{"_id": "cam1", "name": "ProcureCon East", "status": "running", "createdAt": "2026-09-01T00:00:00.000Z"}])
    if path.startswith("/api/v2/campaigns/"):
        if req.get_header("Authorization") != "Basic " + base64.b64encode((":" + KEYS["lemlist-token"]).encode()).decode():
            raise err(url, 401, {"error": "use basic auth"})
        return Resp(200, {"messagesSent": 120, "opened": 60, "replied": 4, "messagesBounced": 2})
    raise err(url, 404, {})

def openai(req, url):
    body = json.loads(req.data.decode("utf-8"))
    user = body["messages"][-1]["content"]
    if body.get("max_completion_tokens", 0) < 10000:
        return Resp(200, {"model": body["model"], "choices": [{"message": {"content": ""}, "finish_reason": "length"}],
                          "usage": {"completion_tokens": body.get("max_completion_tokens"), "completion_tokens_details": {"reasoning_tokens": body.get("max_completion_tokens")}}})
    if "Prepare fixes" in user:
        content = {"fixes": []}
    elif "morning briefing" in user:
        content = {"greeting": "Good morning.", "paragraphs": ["The open book is 0 deals, $0."], "whatsNew": ["Quiet day."], "watchOuts": [], "topActions": []}
    else:
        content = {"insights": [{"title": "Quiet pipeline", "detail": "Nothing changed.", "priority": "low", "kind": "info"}], "summary": "Quiet."}
    return Resp(200, {"model": body["model"], "choices": [{"message": {"content": json.dumps(content)}, "finish_reason": "stop"}]})

real = urllib.request.urlopen
def urlopen(req, *a, **k):
    if isinstance(req, str):
        req = urllib.request.Request(req)
    url = req.full_url
    parsed = urllib.parse.urlparse(url)
    host, path, q = parsed.hostname, parsed.path, urllib.parse.parse_qs(parsed.query)
    headers = {k.lower(): v for k, v in req.header_items()}
    sent = [name for name, value in KEYS.items() if value in json.dumps(headers) or value in url]
    with open(LOG, "a") as f:
        f.write(json.dumps({"host": host, "path": path, "auth": sorted(h for h in headers if h in ("authorization", "x-api-key")), "keys": sent}) + "\n")
    if host == "api.fathom.ai": return fathom(req, url, q)
    if host in ("api.otterly.ai", "data.otterly.ai"): return otterly(req, url, q, path)
    if host == "api.lemlist.com": return lemlist(req, url, path)
    if host == "api.openai.com": return openai(req, url)
    raise err(url, 599, {"error": "network blocked in the test: " + str(host)})
urllib.request.urlopen = urlopen
'''

SCHEMA = """
create table hubspot_objects (hs_id text, object_type text, properties_json text, fetched_at text);
create table hubspot_associations (from_type text, from_id text, to_type text, to_id text);
create table hubspot_owners (id text, first_name text, last_name text, email text);
create table sheets_data (spreadsheet_id text, spreadsheet_title text, tab text, row_num int, row_json text);
create table meetings (recording_id integer, title text, meeting_type text, url text, share_url text, created_at text,
  scheduled_start_time text, scheduled_end_time text, recording_start_time text, recording_end_time text,
  transcript_language text, recorded_by_name text, recorded_by_email text, invitees_json text, summary_markdown text,
  action_items_json text, highlights_json text, fetched_at text);
create table transcripts (recording_id integer, turns_json text, n_turns integer, n_chars integer);
create table transcript_fts (recording_id integer, speaker text, text text, timestamp text);
create table lemlist_campaigns (campaign_id text primary key, name text, status text, raw_json text, fetched_at text);
create table otterly_reports (report_id text, brand text, domain text, competitors_json text, stats_json text, fetched_at text);
create table ga4_reports (report_key text primary key, property_id text, params_json text, result_json text, fetched_at text);
create table sync_state (source text primary key, watermark text, last_run text, note text);
create table findings (id text, kind text, claim text, confidence text, evidence_refs text, status text, created_at text);
"""

tmp = Path(tempfile.mkdtemp(prefix="gtm-syncs-"))
fs_root, mock_dir = tmp / "fs", tmp / "mock"
(fs_root / "data" / "brain").mkdir(parents=True)
(fs_root / "secrets").mkdir()
mock_dir.mkdir()
(mock_dir / "sitecustomize.py").write_text(MOCK)
brain = fs_root / "data" / "brain" / "brain.db"
con = sqlite3.connect(brain)
con.executescript(SCHEMA)
con.execute("insert into sync_state values('fathom', '2026-08-25..2026-09-24', null, 'older brain')")
con.commit()
con.close()
for name, value in KEYS.items():
    (fs_root / "secrets" / name).write_text(value)


def refresh(scenario):
    log = tmp / ("calls-%s.jsonl" % scenario)
    env = dict(os.environ, REFRESH_MODE="fs", REFRESH_FS_ROOT=str(fs_root), REFRESH_WORK=str(tmp / ("work-" + scenario)),
               REFRESH_CONFIG=str(ROOT / "refresh-config.json"), AWS_EC2_METADATA_DISABLED="true",
               PYTHONPATH=str(mock_dir), MOCK_SCENARIO=scenario, MOCK_LOG=str(log), MOCK_KEYS=json.dumps(KEYS))
    env.pop("GTM_FACTS_ONLY", None)
    proc = subprocess.run([sys.executable, "refresh/run.py"], cwd=ROOT, env=env, capture_output=True, text=True)
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    latest = json.loads((fs_root / "published" / "LATEST.json").read_text()) if (fs_root / "published" / "LATEST.json").exists() else {}
    return proc, calls, latest


def published(latest, name):
    return json.loads((fs_root / latest["prefix"] / name).read_text())


def rows(sql):
    c = sqlite3.connect(brain)
    try:
        return c.execute(sql).fetchall()
    finally:
        c.close()


proc, calls, latest = refresh("good")
out = proc.stdout + proc.stderr
check("refresh publishes", proc.returncode == 0 and latest.get("prefix"), out[-600:])
fathom_calls = [c for c in calls if c["host"] == "api.fathom.ai"]
check("fathom sends X-Api-Key only", fathom_calls and all(c["auth"] == ["x-api-key"] for c in fathom_calls), fathom_calls[:2])
check("fathom follows next_cursor", len(fathom_calls) == 2, len(fathom_calls))
check("fathom stores meetings, summaries and transcripts",
      rows("select count(*) from meetings where summary_markdown like '## Summary%'")[0][0] == 3
      and rows("select sum(n_turns) from transcripts")[0][0] == 3
      and rows("select count(*) from meetings where action_items_json like '%security pack%'")[0][0] == 3)
check("fathom watermark is the newest created_at", rows("select watermark from sync_state where source='fathom'")[0][0] == "2026-09-27T16:00:00Z")
otterly_calls = [c for c in calls if c["host"] in ("api.otterly.ai", "data.otterly.ai")]
check("otterly only calls data.otterly.ai", otterly_calls and all(c["host"] == "data.otterly.ai" for c in otterly_calls))
check("otterly reads the documented routes", {c["path"] for c in otterly_calls} == {
    "/v1/accounts/info", "/v1/workspaces", "/v1/reports/brand", "/v1/reports/brand/rep1/stats", "/v1/reports/brand/rep1/prompts"},
    sorted({c["path"] for c in otterly_calls}))
found = rows("select stats_json from otterly_reports where report_id='rep1'")
stats = json.loads(found[0][0]) if found else {}
check("otterly stores parseable stats", (stats.get("summary") or {}).get("brandCoverage") == 48 and stats.get("promptCount") == 39, stats)
mk = published(latest, "marketing.json")
check("AI mentions reach the page data", (mk.get("ai") or {}).get("connected") and mk["ai"].get("brandCoverage") == 48, mk["ai"])
check("LemList stats reach the page data", mk["outbound"].get("connected") and (mk["outbound"].get("campaignStats") or [{}])[0].get("sent") == 120)
ok_sources = {s["source"] for s in mk["sources"] if s["ok"]}
check("fathom, otterly and lemlist refreshed", {"fathom", "otterly", "lemlist"} <= ok_sources, mk["sources"])
check("missing secrets are recorded", any(s["source"] == "hubspot" and "not in Secrets Manager" in s["detail"] for s in mk["sources"]))
brief = published(latest, "agent-brief.json")
check("agent brief survives an empty length reply", brief.get("model") != "facts" and "returned no text: finish_reason length" in out, out[-400:])
heartbeat = published(latest, "heartbeat.json")
titles = [i["title"] for i in heartbeat.get("insights", [])]
check("pulse lists refreshed sources", any(t == "Refreshed this run" for t in titles) and "Quiet pipeline" in titles, titles)
check("each key only goes to its own host", all(
    set(c["keys"]) <= {"api.fathom.ai": {"fathom-token"}, "data.otterly.ai": {"otterly-token"},
                       "api.lemlist.com": {"lemlist-token"}, "api.openai.com": {"openai-api-key"}}.get(c["host"], set())
    for c in calls))
check("no key in the logs", not any(v in out for v in KEYS.values()))
first_prefix = latest["prefix"]

proc, calls, latest = refresh("refused")
out = proc.stdout + proc.stderr
check("a refused source does not halt the refresh", proc.returncode == 0 and latest.get("prefix") and latest["prefix"] != first_prefix, out[-600:])
check("run log names the failures", "fathom_sync.py because it needs a connection" in out and "otterly_sync.py failed" in out, out[-600:])
check("last good Fathom data stays", rows("select count(*) from meetings")[0][0] == 3 and rows("select sum(n_turns) from transcripts")[0][0] == 3)
kept = rows("select stats_json from otterly_reports")
check("last good Otterly data stays", bool(kept) and (json.loads(kept[0][0]).get("summary") or {}).get("brandCoverage") == 48)
mk = published(latest, "marketing.json")
check("AI mentions still on the page", mk["ai"].get("brandCoverage") == 48)
by = {s["source"]: s for s in mk["sources"]}
by.setdefault("fathom", {}); by.setdefault("otterly", {})
check("fathom refusal recorded", by["fathom"].get("ok") is False and by["fathom"].get("http") == 401 and by["fathom"].get("route") == "GET /external/v1/meetings" and by["fathom"].get("lastOkAt"), by.get("fathom"))
check("otterly error recorded", by["otterly"].get("ok") is False and by["otterly"].get("http") == 500 and by["otterly"].get("route") == "GET /v1/reports/brand", by.get("otterly"))
details = {i["title"]: i["detail"] for i in published(latest, "heartbeat.json")["insights"]}
check("pulse names source, route and status",
      "GET /external/v1/meetings answered HTTP 401" in details.get("Fathom was not refreshed", "")
      and "GET /v1/reports/brand answered HTTP 500" in details.get("Otterly was not refreshed", "")
      and "last good data" in details.get("Fathom was not refreshed", ""), details)
check("no key in the logs after refusals", not any(v in out for v in KEYS.values()))

print(json.dumps({"ok": not failures, "failures": failures}, indent=2))
sys.exit(1 if failures else 0)
