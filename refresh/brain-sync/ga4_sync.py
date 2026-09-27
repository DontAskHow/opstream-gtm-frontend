#!/usr/bin/env python3
"""Incremental GA4 sync into the company brain.

Re-runs the 30-day sessions/users/pageviews report for property 304508954
(opstream.ai), plus 90-day channel and landing-page reports for
www.opstream.ai only, and upserts each into ga4_reports.

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
pace = RateLimiter(1.0)

WWW_ONLY = {"filter": {"fieldName": "hostName", "stringFilter": {"matchType": "EXACT", "value": "www.opstream.ai"}}}
ENGAGEMENT = [{"name": "sessions"}, {"name": "engagedSessions"}, {"name": "keyEvents"}]
REPORTS = {
    "sessions_30d": {
        "dateRanges": [{"startDate": "30daysAgo", "endDate": "today"}],
        "metrics": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "screenPageViews"}],
    },
    "channels_90d": {
        "dateRanges": [{"startDate": "90daysAgo", "endDate": "today"}],
        "dimensions": [{"name": "sessionDefaultChannelGroup"}],
        "metrics": ENGAGEMENT,
        "dimensionFilter": WWW_ONLY,
        "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}],
        "limit": 25,
    },
    "landing_90d": {
        "dateRanges": [{"startDate": "90daysAgo", "endDate": "today"}],
        "dimensions": [{"name": "landingPage"}],
        "metrics": ENGAGEMENT,
        "dimensionFilter": WWW_ONLY,
        "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}],
        "limit": 10,
    },
}


def _run_report(params):
    pace.wait()
    token = google_access_token()
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{PROPERTY_ID}:runReport"
    req = urllib.request.Request(
        url,
        data=json.dumps(params).encode("utf-8"),
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

    fetched_at = now_iso()
    done = []
    for key, params in REPORTS.items():
        status, payload = _run_report(params)
        if status != 200:
            if key == "sessions_30d":
                raise RuntimeError(f"GA4 runReport returned HTTP {status}: {str(payload)[:400]}")
            log.info("report %s returned HTTP %s; kept the previous copy", key, status)
            continue
        con = db_connect()
        try:
            con.execute(
                "INSERT INTO ga4_reports(report_key, property_id, params_json, result_json, fetched_at)"
                " VALUES(?,?,?,?,?)"
                " ON CONFLICT(report_key) DO UPDATE SET params_json=excluded.params_json,"
                " result_json=excluded.result_json, fetched_at=excluded.fetched_at",
                (key, PROPERTY_ID, json.dumps(params), json.dumps(payload), fetched_at),
            )
            con.commit()
        finally:
            con.close()
        rows = payload.get("rows", []) if isinstance(payload, dict) else []
        done.append("%s %d rows" % (key, len(rows)))

    note = f"property {PROPERTY_ID}: " + ", ".join(done)
    set_sync_state(SOURCE, fetched_at, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
