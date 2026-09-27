#!/usr/bin/env python3
"""Incremental Fathom sync into the company brain.

Lists meetings recorded after the watermark, fetches details + transcript +
summary + action items for new ones, and stores them in meetings, transcripts,
and transcript_fts.

Read-only against the Fathom API. Gentle pacing (2 req/s max).
Watermark format in sync_state (source='fathom'): ISO-8601 timestamp of the
latest recording_start_time seen (legacy 'start..end' ranges are parsed).

Auth: Secrets Manager opstream-gtm/fathom-token, sent only to api.fathom.ai.
A missing or rejected token exits 3 and does not move watermarks.
"""

import json
import sys
import urllib.parse

from common import (
    RateLimiter,
    authed_request,
    db_connect,
    get_sync_state,
    run_main,
    set_sync_state,
    truncate_value,
    now_iso,
)

SOURCE = "fathom"
BASE = "https://api.fathom.ai"
ALLOWED_HOSTS = ["api.fathom.ai"]
CONNECTORS = ["custom.fathom", "fathom"]
pace = RateLimiter(0.5)


def _get(path: str, params: dict | None = None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    pace.wait()
    status, payload = authed_request("GET", url, CONNECTORS, ALLOWED_HOSTS)
    if status != 200:
        raise RuntimeError(f"Fathom GET {path} returned HTTP {status}: {str(payload)[:300]}")
    return payload


def parse_watermark(raw: str | None) -> str:
    if not raw:
        return "2020-01-01T00:00:00+00:00"
    raw = raw.strip()
    if ".." in raw:  # legacy 'start..end' range
        return raw.split("..")[-1].strip() or "2020-01-01T00:00:00+00:00"
    return raw


def list_meetings(since_iso: str):
    """Yield meeting summary dicts recorded after since_iso, paginated."""
    cursor = None
    while True:
        params = {"recorded_after": since_iso, "limit": "100"}
        if cursor:
            params["cursor"] = cursor
        payload = _get("/external/v1/meetings", params)
        items = payload.get("meetings", payload.get("items", [])) if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            items = []
        for m in items:
            yield m
        cursor = (payload.get("pagination") or {}).get("next_cursor") if isinstance(payload, dict) else None
        if not cursor:
            break


def store_meeting(con, m: dict, log) -> bool:
    """Fetch full detail for one meeting and store it. Returns True if new."""
    rid = m.get("recording_id") or m.get("id")
    if rid is None:
        return False
    rid = int(rid)
    cur = con.cursor()
    if cur.execute("SELECT 1 FROM meetings WHERE recording_id=?", (rid,)).fetchone():
        return False  # already have it; idempotent

    detail = _get(f"/external/v1/meetings/{rid}")
    if not isinstance(detail, dict):
        detail = {}

    def first(*names, default=None):
        for n in names:
            if detail.get(n) is not None:
                return detail.get(n)
        return default

    recorded_by = first("recorded_by", default={}) or {}
    title = first("title", default="")
    invitees = first("invitees", "calendar_invitees", default=[]) or []

    # Summary / action items / highlights: prefer dedicated endpoints,
    # fall back to fields on the detail payload.
    summary_md = first("summary_markdown", "summary")
    action_items = first("action_items", "action_items_json")
    highlights = first("highlights", "highlights_json")
    try:
        s = _get(f"/external/v1/meetings/{rid}/summary")
        summary_md = (s.get("summary") if isinstance(s, dict) else s) or summary_md
    except Exception as e:
        log.info("meeting %s: summary endpoint unavailable (%s)", rid, e)
    try:
        a = _get(f"/external/v1/meetings/{rid}/action_items")
        action_items = (a.get("action_items") if isinstance(a, dict) else a) or action_items
    except Exception as e:
        log.info("meeting %s: action_items endpoint unavailable (%s)", rid, e)
    try:
        h = _get(f"/external/v1/meetings/{rid}/highlights")
        highlights = (h.get("highlights") if isinstance(h, dict) else h) or highlights
    except Exception as e:
        log.info("meeting %s: highlights endpoint unavailable (%s)", rid, e)

    fetched_at = now_iso()
    cur.execute(
        """INSERT INTO meetings(recording_id, title, meeting_type, url, share_url,
           created_at, scheduled_start_time, scheduled_end_time,
           recording_start_time, recording_end_time, transcript_language,
           recorded_by_name, recorded_by_email, invitees_json, summary_markdown,
           action_items_json, highlights_json, fetched_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            rid, truncate_value(str(title or "")),
            truncate_value(str(first("meeting_type", default="") or "")),
            first("url"), first("share_url"),
            first("created_at"), first("scheduled_start_time"),
            first("scheduled_end_time"), first("recording_start_time"),
            first("recording_end_time"), first("transcript_language"),
            (recorded_by.get("name") if isinstance(recorded_by, dict) else None),
            (recorded_by.get("email") if isinstance(recorded_by, dict) else None),
            json.dumps(invitees, ensure_ascii=False),
            truncate_value(str(summary_md or "")) if summary_md else None,
            json.dumps(action_items, ensure_ascii=False) if action_items else None,
            json.dumps(highlights, ensure_ascii=False) if highlights else None,
            fetched_at,
        ),
    )

    # Transcript
    try:
        t = _get(f"/external/v1/meetings/{rid}/transcript")
    except Exception as e:
        log.warning("meeting %s: transcript unavailable (%s); storing meeting without transcript", rid, e)
        t = None
    turns = []
    if isinstance(t, dict):
        turns = t.get("transcript") or t.get("turns") or []
    elif isinstance(t, list):
        turns = t
    norm_turns = []
    for turn in turns:
        sp = turn.get("speaker", {}) or {}
        if isinstance(sp, str):
            sp = {"display_name": sp}
        norm_turns.append({
            "speaker": {
                "display_name": sp.get("display_name") or sp.get("name") or "",
                "matched_calendar_invitee_email": sp.get("matched_calendar_invitee_email"),
            },
            "text": turn.get("text", ""),
            "timestamp": turn.get("timestamp", ""),
        })
    turns_json = json.dumps(norm_turns, ensure_ascii=False)
    n_chars = sum(len(x.get("text", "")) for x in norm_turns)
    cur.execute(
        "INSERT INTO transcripts(recording_id, turns_json, n_turns, n_chars) VALUES(?,?,?,?)",
        (rid, turns_json, len(norm_turns), n_chars),
    )
    cur.execute("DELETE FROM transcript_fts WHERE recording_id=?", (rid,))
    for turn in norm_turns:
        cur.execute(
            "INSERT INTO transcript_fts(recording_id, speaker, text, timestamp) VALUES(?,?,?,?)",
            (rid, turn["speaker"]["display_name"], turn["text"], turn["timestamp"]),
        )
    log.info("meeting %s stored: %s (%d turns)", rid, title, len(norm_turns))
    return True


def main_sync(log):
    watermark_raw, _last_run, _note = get_sync_state(SOURCE)
    since_iso = parse_watermark(watermark_raw)
    log.info("watermark: %s", since_iso)

    con = db_connect()
    added = 0
    max_start = since_iso
    try:
        for m in list_meetings(since_iso):
            start = m.get("recording_start_time") or m.get("created_at") or ""
            try:
                if store_meeting(con, m, log):
                    added += 1
                    con.commit()
            except Exception:
                con.rollback()
                log.exception("failed to store meeting %s; continuing", m.get("recording_id") or m.get("id"))
            if start and start > max_start:
                max_start = start
    finally:
        con.close()

    note = f"{added} new meetings stored (read-only review, incremental sync)"
    set_sync_state(SOURCE, max_start, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
