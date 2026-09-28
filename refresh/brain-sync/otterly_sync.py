#!/usr/bin/env python3
"""Incremental Otterly sync into the company brain.

Otterly's public data API is https://data.otterly.ai/v1 (docs.otterly.ai,
spec at data.otterly.ai/v1/openapi.json). Bearer auth. Read-only.

  GET /v1/accounts/info                      API requests used / allowed
  GET /v1/workspaces                         workspaces the key can read
  GET /v1/reports/brand                      brand reports (cursor paging)
  GET /v1/reports/brand/{id}/stats           last 30 days, report's first country
  GET /v1/reports/brand/{id}/prompts         prompt count per report

Quota rule: check API usage first. Over 50% of the period's requests used, or
usage unknown, skips the refresh (recorded, not an error).

Auth: Secrets Manager opstream-gtm/otterly-token, sent only to data.otterly.ai.
"""

import json
import urllib.parse
from datetime import datetime, timedelta, timezone

from common import (
    RateLimiter,
    SourceError,
    SourceSkipped,
    authed_request,
    db_connect,
    run_main,
    set_sync_state,
    now_iso,
)

SOURCE = "otterly"
HOST = "data.otterly.ai"
BASE = "https://data.otterly.ai/v1"
ALLOWED_HOSTS = [HOST]
CONNECTORS = ["custom.otterly", "otterly"]
QUOTA_THRESHOLD = 0.50
STATS_DAYS = 30
MAX_PAGES = 20
pace = RateLimiter(1.0)


def _get(path: str, params: dict | None = None, route: str | None = None):
    url = BASE + path + (("?" + urllib.parse.urlencode(params, doseq=True)) if params else "")
    pace.wait()
    status, payload = authed_request("GET", url, CONNECTORS, ALLOWED_HOSTS, auth="bearer")
    if status != 200 or not isinstance(payload, dict):
        raise SourceError(HOST, "GET /v1" + (route or path), status, str(payload)[:200])
    return payload


def _all(path: str, route: str, params: dict | None = None):
    items, cursor = [], None
    for _page in range(MAX_PAGES):
        query = dict(params or {})
        if cursor:
            query["cursor"] = cursor
        payload = _get(path, query or None, route)
        items.extend(payload.get("items") or [])
        paging = payload.get("paging") or {}
        cursor = paging.get("nextCursor")
        if not paging.get("hasMore") or not cursor:
            break
    return items


def main_sync(log):
    info = _get("/accounts/info")
    used, limit = info.get("apiRequestsUsedCount"), info.get("apiRequestsMaxCount")
    if not isinstance(used, (int, float)) or not isinstance(limit, (int, float)) or limit <= 0:
        raise SourceSkipped("API request usage is not reported by /v1/accounts/info; not spending quota")
    log.info("Otterly API requests: %s/%s used (%.0f%%), plan %s", used, limit, used / limit * 100,
             info.get("subscriptionPlan"))
    if used / limit > QUOTA_THRESHOLD:
        raise SourceSkipped("API requests %d/%d used (%.0f%%), over the %.0f%% limit"
                            % (used, limit, used / limit * 100, QUOTA_THRESHOLD * 100))

    workspaces = {w.get("id"): w.get("name") for w in _all("/workspaces", "/workspaces")}
    reports = _all("/reports/brand", "/reports/brand")
    if not reports:
        raise SourceError(HOST, "GET /v1/reports/brand", 200, "no brand reports readable with this key")
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=STATS_DAYS - 1)
    fetched_at = now_iso()
    stored = []
    con = db_connect()
    try:
        for r in reports:
            rid = r.get("id")
            if not rid:
                continue
            country = ((r.get("countries") or ["us"])[0] or "us").lower()
            stats = _get(f"/reports/brand/{rid}/stats",
                         {"startDate": start.isoformat(), "endDate": end.isoformat(), "country": country},
                         "/reports/brand/{reportId}/stats")
            prompts = _all(f"/reports/brand/{rid}/prompts", "/reports/brand/{reportId}/prompts")
            kept = {
                "id": stats.get("id") or rid,
                "status": stats.get("status"),
                "totalPrompts": stats.get("totalPrompts"),
                "brand": stats.get("brand") or {"brand": r.get("brand"), "brandDomain": r.get("brandDomain")},
                "summary": stats.get("summary") or {},
                "detectedBrands": (stats.get("detectedBrands") or [])[:30],
                "country": country,
                "window": {"startDate": start.isoformat(), "endDate": end.isoformat()},
                "promptCount": len(prompts),
                "workspace": workspaces.get(r.get("workspaceId")),
                "reportTitle": r.get("reportTitle"),
            }
            con.execute("DELETE FROM otterly_reports WHERE report_id=?", (rid,))
            con.execute(
                "INSERT INTO otterly_reports(report_id, brand, domain, competitors_json, stats_json, fetched_at)"
                " VALUES(?,?,?,?,?,?)",
                (rid, r.get("brand"), r.get("brandDomain"),
                 json.dumps(r.get("competitors") or [], ensure_ascii=False),
                 json.dumps(kept, ensure_ascii=False), fetched_at),
            )
            stored.append(rid)
            log.info("report %s (%s) stored: %s prompts", rid, r.get("brand"), len(prompts))
        con.commit()
    finally:
        con.close()
    note = "%d brand reports from %d workspaces; API requests %d/%d before this run" % (
        len(stored), len(workspaces), used, limit)
    set_sync_state(SOURCE, fetched_at, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
