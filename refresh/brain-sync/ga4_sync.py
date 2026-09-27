#!/usr/bin/env python3
"""Incremental GA4 sync into the company brain.

Re-runs the stored 30-day sessions/users/pageviews report for property
304508954 (opstream.ai) and upserts it into ga4_reports.

Read-only against the Google Analytics Data API v1beta. The Bearer token
comes from the vault (custom.google-analytics, google.analytics, or
custom.google) and is sent ONLY to analyticsdata.googleapis.com.
"""

from common import (
    NeedsConnection,
    RateLimiter,
    authed_request,
    db_connect,
    get_sync_state,
    run_main,
    set_sync_state,
    now_iso,
)

SOURCE = "ga4"
PROPERTY_ID = "304508954"
REPORT_KEY = "sessions_30d"
ALLOWED_HOSTS = ["analyticsdata.googleapis.com"]
CONNECTORS = ["custom.google-analytics", "google.analytics", "custom.google"]
pace = RateLimiter(1.0)

PARAMS = {
    "dateRanges": [{"startDate": "30daysAgo", "endDate": "today"}],
    "metrics": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "screenPageViews"}],
}


def main_sync(log):
    import json

    watermark_raw, _last_run, _note = get_sync_state(SOURCE)
    log.info("previous watermark: %s", watermark_raw)

    pace.wait()
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{PROPERTY_ID}:runReport"
    status, payload = authed_request("POST", url, CONNECTORS, ALLOWED_HOSTS, body=PARAMS)
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
