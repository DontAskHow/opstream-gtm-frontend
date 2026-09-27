#!/usr/bin/env python3
"""Incremental GA4 sync into the company brain.

Re-runs the stored 30-day sessions/users/pageviews report for property
304508954 (opstream.ai) and upserts it into ga4_reports.

Read-only against the Google Analytics Data API v1beta. The Bearer token
is the same user refresh token as Sheets
(opstream-gtm/google-sheets-refresh-token, scope analytics.readonly) and is
sent only to analyticsdata.googleapis.com. A missing secret exits 3 and does
not move the watermark.
"""

import json
import urllib.error
import urllib.request

from common import (
    NeedsConnection,
    RateLimiter,
    db_connect,
    get_sync_state,
    google_access_token,
    run_main,
    set_sync_state,
    now_iso,
)

SOURCE = "ga4"
PROPERTY_ID = "304508954"
REPORT_KEY = "sessions_30d"
pace = RateLimiter(1.0)

PARAMS = {
    "dateRanges": [{"startDate": "30daysAgo", "endDate": "today"}],
    "metrics": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "screenPageViews"}],
}


def _run_report():
    pace.wait()
    token = google_access_token()
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{PROPERTY_ID}:runReport"
    req = urllib.request.Request(
        url,
        data=json.dumps(PARAMS).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read().decode("utf-8", errors="replace")
        if status in (401, 403):
            raise NeedsConnection(
                "analyticsdata.googleapis.com returned %s: credential rejected. Not touching watermarks."
                % status
            )
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = raw
    return status, payload


def main_sync(log):
    google_access_token()
    watermark_raw, _last_run, _note = get_sync_state(SOURCE)
    log.info("previous watermark: %s", watermark_raw)

    status, payload = _run_report()
    if status != 200:
        raise RuntimeError(f"GA4 runReport returned HTTP {status}: {str(payload)[:400]}")

    fetched_at = now_iso()
    con = db_connect()
    try:
        con.execute(
            "INSERT INTO ga4_reports(report_key, property_id, params_json, result_json, fetched_at)"
            " VALUES(?,?,?,?,?)"
            " ON CONFLICT(report_key) DO UPDATE SET params_json=excluded.params_json,"
            " result_json=excluded.result_json, fetched_at=excluded.fetched_at",
            (REPORT_KEY, PROPERTY_ID, json.dumps(PARAMS), json.dumps(payload), fetched_at),
        )
        con.commit()
    finally:
        con.close()

    rows = payload.get("rows", []) if isinstance(payload, dict) else []
    note = f"30d report refreshed for property {PROPERTY_ID} ({len(rows)} row groups returned)"
    set_sync_state(SOURCE, fetched_at, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
