#!/usr/bin/env python3
"""Incremental Otterly sync into the company brain.

Quota policy (hard rule): check API usage FIRST. If more than 50% of the
monthly quota is consumed, skip the refresh entirely. If quota cannot be
determined, skip as well (fail closed) rather than risk burning quota.

Otherwise re-fetches the brand reports already in otterly_reports and upserts
stats/competitors. Read-only against the Otterly API.

NOTE: Otterly's public API surface is small and has changed before. Endpoint
candidates are tried in order; if none match, the script logs clearly and
exits non-zero WITHOUT touching watermarks so a human can review.

Auth: Secrets Manager opstream-gtm/otterly-token. A missing or rejected token
exits 3 and does not move watermarks.
"""

import json

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

SOURCE = "otterly"
ALLOWED_HOSTS = ["api.otterly.ai"]
CONNECTORS = ["custom.otterly", "otterly"]
QUOTA_THRESHOLD = 0.50
pace = RateLimiter(1.0)

QUOTA_ENDPOINTS = [
    "https://api.otterly.ai/api/v1/account/usage",
    "https://api.otterly.ai/v1/account/usage",
    "https://api.otterly.ai/api/v1/account",
]
REPORT_ENDPOINTS = [
    "https://api.otterly.ai/api/v1/brand-reports/{rid}",
    "https://api.otterly.ai/v1/brand-reports/{rid}",
    "https://api.otterly.ai/api/v1/reports/{rid}",
]


def _try(url: str):
    pace.wait()
    return authed_request("GET", url, CONNECTORS, ALLOWED_HOSTS)


def parse_quota(payload) -> tuple[float, float] | None:
    """Return (used, limit) or None if the shape is unrecognized."""
    if not isinstance(payload, dict):
        return None
    for used_k, limit_k in [
        ("used", "limit"),
        ("apiCallsUsed", "apiCallsLimit"),
        ("callsUsed", "callsLimit"),
        ("current", "total"),
    ]:
        if used_k in payload and limit_k in payload:
            try:
                return float(payload[used_k]), float(payload[limit_k])
            except (TypeError, ValueError):
                return None
    # Nested shapes: {"usage": {"used":..,"limit":..}} or {"quota": {...}}
    for nest in ("usage", "quota", "plan"):
        sub = payload.get(nest)
        if isinstance(sub, dict):
            r = parse_quota(sub)
            if r:
                return r
    return None


def main_sync(log):
    quota = None
    quota_src = None
    for url in QUOTA_ENDPOINTS:
        try:
            status, payload = _try(url)
        except NeedsConnection:
            raise
        except Exception as e:
            log.info("quota endpoint %s failed: %s", url, e)
            continue
        if status == 200:
            quota = parse_quota(payload)
            quota_src = url
            if quota:
                break
            log.info("quota endpoint %s returned unrecognized shape: %s", url, str(payload)[:200])
        else:
            log.info("quota endpoint %s HTTP %s", url, status)

    if not quota:
        log.error("could not determine Otterly quota from %s; failing closed (no refresh), watermarks untouched",
                  QUOTA_ENDPOINTS)
        raise RuntimeError("Otterly quota unavailable; failing closed per policy")
    used, limit = quota
    log.info("Otterly quota: %s/%s used (%.1f%%) [source %s]", used, limit,
             (used / limit * 100) if limit else 0, quota_src)
    if limit and used / limit > QUOTA_THRESHOLD:
        msg = (f"SKIPPED: Otterly quota {used}/{limit} ({used/limit:.0%}) exceeds "
               f"{QUOTA_THRESHOLD:.0%} threshold; no refresh, watermarks untouched")
        log.warning(msg)
        return msg  # exit 0, but run_main only marks success; we do NOT update sync_state here

    con = db_connect()
    try:
        reports = con.execute("SELECT report_id, brand, domain FROM otterly_reports").fetchall()
    finally:
        con.close()
    if not reports:
        raise RuntimeError("otterly_reports is empty; nothing to refresh")

    fetched_at = now_iso()
    refreshed = 0
    con = db_connect()
    try:
        for rid, brand, domain in reports:
            data = None
            for tmpl in REPORT_ENDPOINTS:
                url = tmpl.format(rid=rid)
                try:
                    status, payload = _try(url)
                except Exception as e:
                    log.info("report endpoint %s failed: %s", url, e)
                    continue
                if status == 200 and isinstance(payload, dict):
                    data = payload
                    break
                log.info("report endpoint %s HTTP %s", url, status)
            if data is None:
                raise RuntimeError(
                    f"no recognized report endpoint for {rid}; tried {REPORT_ENDPOINTS}. "
                    "Otterly API shape may have changed; manual review needed. Watermarks untouched.")
            stats = data.get("stats") or data
            competitors = data.get("competitors") or data.get("detectedBrands") or []
            con.execute(
                "UPDATE otterly_reports SET competitors_json=?, stats_json=?, fetched_at=? WHERE report_id=?",
                (json.dumps(competitors, ensure_ascii=False),
                 json.dumps(stats, ensure_ascii=False), fetched_at, rid),
            )
            refreshed += 1
            log.info("report %s (%s) refreshed", rid, brand)
        con.commit()
    finally:
        con.close()

    note = (f"{refreshed} brand reports refreshed; quota at refresh {used}/{limit} "
            f"({used/limit:.0%}) < {QUOTA_THRESHOLD:.0%} threshold")
    set_sync_state(SOURCE, fetched_at, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
