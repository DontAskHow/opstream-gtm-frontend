#!/usr/bin/env python3
"""Incremental Fathom sync into the company brain.

Reads https://api.fathom.ai/external/v1/meetings (documented at
developers.fathom.ai) with include_summary, include_transcript,
include_action_items and include_highlights, paginated by next_cursor, and
stores new recordings in meetings, transcripts and transcript_fts.

Auth: the API key from Secrets Manager opstream-gtm/fathom-token goes in the
X-Api-Key header only, and only to api.fathom.ai. Bearer is refused by this key.
Read-only. Summary and transcript requests are "heavy" (30 per minute), so pages
are paced and a 429 is retried after a pause.

Watermark (sync_state source='fathom'): the newest created_at seen. The next
run asks for created_after = watermark - FATHOM_OVERLAP_HOURS (default 48),
so summaries and transcripts that land late are picked up. A stored recording
whose summary or transcript was empty is filled in when the API has it now.
Paging follows the top-level next_cursor until it is empty.

FATHOM_BACKFILL=1 lists every recording from the start (no created_after) and
stores the ones brain.db lacks. It is a one-off; the watermark never moves back.
"""

import json
import os
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

from common import (
    RateLimiter,
    SourceError,
    authed_request,
    db_connect,
    get_sync_state,
    run_main,
    set_sync_state,
    truncate_value,
    now_iso,
)

SOURCE = "fathom"
HOST = "api.fathom.ai"
BASE = "https://api.fathom.ai/external/v1"
ALLOWED_HOSTS = [HOST]
CONNECTORS = ["custom.fathom", "fathom"]
LIST_ROUTE = "GET /external/v1/meetings"
# Requests that include summaries and transcripts count as heavy: 30 a minute.
pace = RateLimiter(float(os.environ.get("FATHOM_PACE_SECONDS") or 2.5))
OVERLAP_HOURS = float(os.environ.get("FATHOM_OVERLAP_HOURS") or 48)
BACKFILL = os.environ.get("FATHOM_BACKFILL") == "1"
MAX_RETRIES = 3
RETRY_SECONDS = 20


def _get(path: str, params: dict):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    for attempt in range(MAX_RETRIES + 1):
        pace.wait()
        status, payload = authed_request("GET", url, CONNECTORS, ALLOWED_HOSTS, auth="x-api-key")
        if status == 429:
            time.sleep(RETRY_SECONDS * (attempt + 1))
            continue
        if status != 200:
            raise SourceError(HOST, LIST_ROUTE, status, str(payload)[:200])
        return payload
    raise SourceError(HOST, LIST_ROUTE, 429, "rate limited after %d retries" % MAX_RETRIES)


def created_after(watermark: str | None) -> str:
    """The stored watermark as an ISO timestamp. Older brains stored 'start..end' dates."""
    raw = (watermark or "").strip()
    if ".." in raw:
        raw = raw.split("..")[-1].strip()
    if not raw:
        return "2020-01-01T00:00:00Z"
    if len(raw) == 10:
        return raw + "T00:00:00Z"
    return raw


def with_overlap(since: str) -> str:
    try:
        t = datetime.fromisoformat(since.replace("Z", "+00:00")) - timedelta(hours=OVERLAP_HOURS)
    except ValueError:
        return since
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def list_meetings(since: str | None, log=None):
    """Every meeting created after since (all of them when since is None), following next_cursor."""
    cursor = None
    pages = 0
    while True:
        params = {
            "include_summary": "true",
            "include_transcript": "true",
            "include_action_items": "true",
            "include_highlights": "true",
        }
        if since:
            params["created_after"] = since
        if cursor:
            params["cursor"] = cursor
        payload = _get("/meetings", params)
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise SourceError(HOST, LIST_ROUTE, 200, "response has no items list")
        pages += 1
        if log and pages % 20 == 0:
            log.info("page %d", pages)
        for m in payload["items"]:
            yield m
        cursor = payload.get("next_cursor")
        if not cursor:
            break


def store_meeting(con, m: dict, log) -> bool:
    rid = m.get("recording_id")
    if rid is None:
        return False
    rid = int(rid)
    cur = con.cursor()
    recorded_by = m.get("recorded_by") or {}
    summary = (m.get("default_summary") or {}).get("markdown_formatted")
    have = cur.execute(
        "SELECT m.summary_markdown, t.n_turns FROM meetings m LEFT JOIN transcripts t USING(recording_id) "
        "WHERE m.recording_id=?", (rid,)).fetchone()
    if have:
        late_summary = summary and not have[0]
        late_transcript = (m.get("transcript") or []) and not have[1]
        if not (late_summary or late_transcript):
            return False
        if late_summary:
            cur.execute("UPDATE meetings SET summary_markdown=?, action_items_json=?, highlights_json=?, fetched_at=? "
                        "WHERE recording_id=?",
                        (truncate_value(summary),
                         json.dumps(m.get("action_items"), ensure_ascii=False) if m.get("action_items") else None,
                         json.dumps(m.get("highlights"), ensure_ascii=False) if m.get("highlights") else None,
                         now_iso(), rid))
        if late_transcript:
            store_transcript(cur, rid, m)
        log.info("meeting %s updated (late %s)", rid, "summary and transcript" if late_summary and late_transcript
                 else "summary" if late_summary else "transcript")
        return True
    cur.execute(
        """INSERT INTO meetings(recording_id, title, meeting_type, url, share_url,
           created_at, scheduled_start_time, scheduled_end_time,
           recording_start_time, recording_end_time, transcript_language,
           recorded_by_name, recorded_by_email, invitees_json, summary_markdown,
           action_items_json, highlights_json, fetched_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            rid, truncate_value(str(m.get("title") or m.get("meeting_title") or "")),
            truncate_value(str(m.get("meeting_type") or "")),
            m.get("url"), m.get("share_url"), m.get("created_at"),
            m.get("scheduled_start_time"), m.get("scheduled_end_time"),
            m.get("recording_start_time"), m.get("recording_end_time"), m.get("transcript_language"),
            recorded_by.get("name"), recorded_by.get("email"),
            json.dumps(m.get("calendar_invitees") or [], ensure_ascii=False),
            truncate_value(summary) if summary else None,
            json.dumps(m.get("action_items"), ensure_ascii=False) if m.get("action_items") else None,
            json.dumps(m.get("highlights"), ensure_ascii=False) if m.get("highlights") else None,
            now_iso(),
        ),
    )
    n = store_transcript(cur, rid, m)
    log.info("meeting %s stored (%d transcript turns)", rid, n)
    return True


def store_transcript(cur, rid, m):
    turns = []
    for turn in m.get("transcript") or []:
        speaker = turn.get("speaker") or {}
        turns.append({
            "speaker": {
                "display_name": speaker.get("display_name") or "",
                "matched_calendar_invitee_email": speaker.get("matched_calendar_invitee_email"),
            },
            "text": turn.get("text") or "",
            "timestamp": turn.get("timestamp") or "",
        })
    cur.execute("DELETE FROM transcripts WHERE recording_id=?", (rid,))
    cur.execute(
        "INSERT INTO transcripts(recording_id, turns_json, n_turns, n_chars) VALUES(?,?,?,?)",
        (rid, json.dumps(turns, ensure_ascii=False), len(turns), sum(len(t["text"]) for t in turns)),
    )
    cur.execute("DELETE FROM transcript_fts WHERE recording_id=?", (rid,))
    for t in turns:
        cur.execute(
            "INSERT INTO transcript_fts(recording_id, speaker, text, timestamp) VALUES(?,?,?,?)",
            (rid, t["speaker"]["display_name"], t["text"], t["timestamp"]),
        )
    return len(turns)


def main_sync(log):
    watermark, _last_run, _note = get_sync_state(SOURCE)
    newest = created_after(watermark)
    since = None if BACKFILL else with_overlap(newest)
    log.info("created_after: %s%s", since or "(none: backfill)", "" if BACKFILL else " (watermark %s)" % newest)
    con = db_connect()
    changed = seen = 0
    try:
        for m in list_meetings(since, log):
            seen += 1
            if store_meeting(con, m, log):
                changed += 1
                con.commit()
            created = str(m.get("created_at") or "")
            if created > newest:
                newest = created
        total = con.execute("SELECT COUNT(*) FROM meetings").fetchone()[0]
    finally:
        con.close()
    note = "%d meetings listed, %d new or updated stored%s" % (seen, changed, "; %d in brain" % total if BACKFILL else "")
    set_sync_state(SOURCE, newest, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
