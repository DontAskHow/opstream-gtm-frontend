#!/usr/bin/env python3
"""Incremental GA4 sync into the company brain.

Re-runs the 30-day sessions/users/pageviews report for property 304508954
(opstream.ai), plus 90-day channel and landing-page reports for
www.opstream.ai only, and the same three split by hostName (all hosts), and
upserts each into ga4_reports.

Read-only against the Google Analytics Data API v1beta. The Bearer token
is the same user refresh token as Sheets
(opstream-gtm/google-sheets-refresh-token, scope analytics.readonly) and is
sent only to analyticsdata.googleapis.com. A missing secret exits 3 and does
not move the watermark.

Quota: every request asks for returnPropertyQuota and logs the tokens it
used and the property's remaining hourly and daily tokens (numbers only).
GA4 data is daily-granular, so a pull within GA4_MIN_INTERVAL_MIN minutes
(default 60, 0 disables) of the last successful one is skipped before any
token is minted. A skip records nothing and leaves the watermark alone.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

from common import (
    NeedsConnection,
    RateLimiter,
    db_connect,
    get_sync_state,
    google_access_token,
    run_main,
    setup_logger,
    set_sync_state,
    now_iso,
)

SOURCE = "ga4"
PROPERTY_ID = "304508954"
pace = RateLimiter(1.0)
MIN_INTERVAL_MIN = float(os.environ.get("GA4_MIN_INTERVAL_MIN") or 60)

WWW_ONLY = {"filter": {"fieldName": "hostName", "stringFilter": {"matchType": "EXACT", "value": "www.opstream.ai"}}}
# Marketing site and product. GA4 also records staging, localhost, and per-PR
# preview hosts; those would push real rows past the limit.
SITE_HOSTS = ["www.opstream.ai", "app.opstream.ai"]
SITE_AND_APP = {"filter": {"fieldName": "hostName", "inListFilter": {"values": SITE_HOSTS}}}
ENGAGEMENT = [{"name": "sessions"}, {"name": "engagedSessions"}, {"name": "keyEvents"}]
REPORTS = {
    "sessions_30d": {
        "dateRanges": [{"startDate": "30daysAgo", "endDate": "today"}],
        "metrics": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "screenPageViews"}],
        "dimensionFilter": WWW_ONLY,
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
    # The same views split by hostName, so tables can be filtered to
    # www.opstream.ai or app.opstream.ai. Sessions lists every host; channels
    # and landing pages keep those two. The reports above stay www-only and
    # remain the default views.
    "sessions_by_host_30d": {
        "dateRanges": [{"startDate": "30daysAgo", "endDate": "today"}],
        "dimensions": [{"name": "hostName"}],
        "metrics": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "screenPageViews"}],
        "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}],
        "limit": 25,
    },
    "channels_by_host_90d": {
        "dateRanges": [{"startDate": "90daysAgo", "endDate": "today"}],
        "dimensions": [{"name": "sessionDefaultChannelGroup"}, {"name": "hostName"}],
        "metrics": ENGAGEMENT,
        "dimensionFilter": SITE_AND_APP,
        "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}],
        "limit": 100,
    },
    "landing_by_host_90d": {
        "dateRanges": [{"startDate": "90daysAgo", "endDate": "today"}],
        "dimensions": [{"name": "landingPage"}, {"name": "hostName"}],
        "metrics": ENGAGEMENT,
        "dimensionFilter": SITE_AND_APP,
        "orderBys": [{"metric": {"metricName": "sessions"}, "desc": True}],
        "limit": 50,
    },
}


def _run_report(params):
    pace.wait()
    token = google_access_token()
    url = f"https://analyticsdata.googleapis.com/v1beta/properties/{PROPERTY_ID}:runReport"
    req = urllib.request.Request(
        url,
        data=json.dumps(dict(params, returnPropertyQuota=True)).encode("utf-8"),
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


def _quota_line(key, quota):
    """Tokens consumed and remaining for one report. Numbers only."""
    def part(name):
        q = quota.get(name) or {}
        return "%s=%s/%s" % (name, q.get("consumed", "?"), q.get("remaining", "?"))
    return "quota %s: %s" % (key, " ".join(part(n) for n in (
        "tokensPerDay", "tokensPerHour", "tokensPerProjectPerHour", "concurrentRequests")))


def minutes_since_last_pull():
    """Minutes since the last successful pull (its watermark), or None."""
    try:
        watermark, _last_run, _note = get_sync_state(SOURCE)
        last = datetime.fromisoformat(str(watermark).replace("Z", "+00:00"))
    except Exception:
        return None
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - last).total_seconds() / 60.0


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
        quota = payload.pop("propertyQuota", None) if isinstance(payload, dict) else None
        if isinstance(quota, dict):
            log.info(_quota_line(key, quota))
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
    age = minutes_since_last_pull() if MIN_INTERVAL_MIN > 0 else None
    if age is not None and age < MIN_INTERVAL_MIN:
        setup_logger(SOURCE).info(
            "SKIPPED: last successful GA4 pull %.0f min ago, under GA4_MIN_INTERVAL_MIN=%.0f. "
            "No API call, nothing recorded.", age, MIN_INTERVAL_MIN)
        sys.exit(0)
    run_main(SOURCE, main_sync)
