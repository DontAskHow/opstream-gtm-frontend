#!/usr/bin/env python3
"""Incremental Otterly sync into the company brain.

Otterly's public data API is https://data.otterly.ai/v1 (docs.otterly.ai,
spec at data.otterly.ai/v1/openapi.json). Bearer auth. Read-only.

  GET /v1/accounts/info                      API requests used / allowed
  GET /v1/workspaces                         workspaces the key can read
  GET /v1/reports/brand                      brand reports (cursor paging)
  GET /v1/reports/brand/{id}/stats           last 30 days, report's first country
  GET /v1/reports/brand/{id}/prompts         prompts in the same window and country;
                                             startDate, endDate and country are required,
                                             paged by offset (a multiple of limit)

The prompts list is optional: when it fails, the report's stats still publish
and the failure is kept on the report and in the sync note.

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
PROMPT_PAGE = 50
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


def _prompts(rid: str, window: dict):
    items, offset, limit = [], 0, PROMPT_PAGE
    for _page in range(MAX_PAGES):
        payload = _get(f"/reports/brand/{rid}/prompts", dict(window, offset=offset, limit=limit),
                       "/reports/brand/{reportId}/prompts")
        batch = payload.get("items") or []
        items.extend(batch)
        paging = payload.get("paging") or {}
        if not paging.get("hasMore") or not batch:
            break
        # The server may cap limit; the next offset must be a multiple of the limit it used.
        limit = int(paging.get("limit") or limit)
        offset = int(paging.get("offset") or offset) + limit
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
    stored, prompt_failures = [], []
    con = db_connect()
    try:
        for r in reports:
            rid = r.get("id")
            if not rid:
                continue
            country = ((r.get("countries") or ["us"])[0] or "us").lower()
            window = {"startDate": start.isoformat(), "endDate": end.isoformat(), "country": country}
            stats = _get(f"/reports/brand/{rid}/stats", window, "/reports/brand/{reportId}/stats")
            try:
                prompts, prompts_error = _prompts(rid, window), None
            except SourceError as exc:
                prompts, prompts_error = None, str(exc)
                prompt_failures.append(rid)
                log.warning("report %s: prompts not read (%s); publishing its stats without them", rid, exc)
            kept = {
                "id": stats.get("id") or rid,
                "status": stats.get("status"),
                "totalPrompts": stats.get("totalPrompts"),
                "brand": stats.get("brand") or {"brand": r.get("brand"), "brandDomain": r.get("brandDomain")},
                "summary": stats.get("summary") or {},
                "detectedBrands": (stats.get("detectedBrands") or [])[:30],
                "country": country,
                "window": {"startDate": start.isoformat(), "endDate": end.isoformat()},
                "promptCount": len(prompts) if prompts is not None else None,
                "promptsError": prompts_error,
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
            log.info("report %s (%s) stored: %s prompts", rid, r.get("brand"),
                     len(prompts) if prompts is not None else "no")
        con.commit()
    finally:
        con.close()
    note = "%d brand reports from %d workspaces; API requests %d/%d before this run" % (
        len(stored), len(workspaces), used, limit)
    if prompt_failures:
        note += "; prompts not read for %d report(s), stats published" % len(prompt_failures)
    set_sync_state(SOURCE, fetched_at, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
