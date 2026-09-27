#!/usr/bin/env python3
"""Incremental Lemlist sync into the company brain.

Refreshes lemlist_campaigns (campaign list + per-campaign stats where the API
exposes them). Read-only against the Lemlist API (api.lemlist.com).

Auth: the campaign list accepts the API key as ?access_token=. The v2 stats
route documents Basic auth with an empty login and the key as the password,
so stats use that header first. The key is the secret opstream-gtm/lemlist-token
and is sent only to api.lemlist.com. A stats refusal is recorded per campaign
(route and HTTP status only) and does not stop the campaign refresh.
A missing secret exits 3 and does not move the watermark.
"""

import base64
import json
import urllib.error
import urllib.request
from urllib.parse import quote
from datetime import datetime, timezone

from common import (
    NeedsConnection,
    RateLimiter,
    access_token_for,
    db_connect,
    run_main,
    set_sync_state,
    truncate_value,
    url_with_access_token,
    now_iso,
)

SOURCE = "lemlist"
HOST = "api.lemlist.com"
pace = RateLimiter(0.5)


def _authed_url(path: str) -> str:
    """Return the URL with the API key as ?access_token=. Do not log it."""
    return url_with_access_token(
        f"https://{HOST}{path}",
        ("custom.lemlist", "lemlist"),
        [HOST],
    )


def _fetch(req):
    pace.wait()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def _get(path: str):
    status, payload = _fetch(urllib.request.Request(_authed_url(path), headers={"Accept": "application/json"}))
    if status in (401, 403):
        raise NeedsConnection("Lemlist rejected the credential (HTTP %s); not touching watermarks" % status)
    return status, payload


def _get_basic(path: str):
    """Basic auth, empty login, API key as the password. Do not log the header."""
    token = access_token_for(("custom.lemlist", "lemlist"), None)
    auth = base64.b64encode((":" + token).encode("utf-8")).decode("ascii")
    return _fetch(urllib.request.Request(f"https://{HOST}{path}",
                                         headers={"Accept": "application/json", "Authorization": "Basic " + auth}))


def _stats(cid, start, end):
    """(stats dict or None, attempts). Attempts hold the route template and HTTP status only."""
    route = "/api/v2/campaigns/{campaignId}/stats"
    path = f"/api/v2/campaigns/{cid}/stats?startDate={quote(start)}&endDate={quote(end)}"
    attempts = []
    for how, call in (("basic", lambda: _get_basic(path)), ("query", lambda: _fetch(
            urllib.request.Request(_authed_url(path), headers={"Accept": "application/json"})))):
        try:
            status, payload = call()
        except NeedsConnection:
            raise
        except Exception as e:
            attempts.append({"route": route, "auth": how, "error": type(e).__name__})
            continue
        attempts.append({"route": route, "auth": how, "http": status})
        if status == 200 and isinstance(payload, dict):
            return payload, attempts
    return None, attempts


def main_sync(log):
    status, payload = _get("/api/campaigns")
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"Lemlist /api/campaigns returned HTTP {status}: {str(payload)[:300]}")

    con = db_connect()
    fetched_at = now_iso()
    end = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    stats_filled = 0
    try:
        for c in payload:
            cid = c.get("_id") or c.get("id")
            if not cid:
                continue
            raw = dict(c)
            # Per-campaign stats: cheap, one call each; tolerate absence.
            start = str(c.get("createdAt") or "2024-01-01T00:00:00.000Z")
            stats, attempts = _stats(cid, start, end)
            raw["statsAttempts"] = attempts
            if stats is not None:
                raw["stats"] = stats
                stats_filled += 1
            else:
                log.info("campaign %s: stats unavailable %s", cid,
                         ", ".join("%s %s" % (a["auth"], a.get("http", a.get("error"))) for a in attempts))
            con.execute(
                "INSERT INTO lemlist_campaigns(campaign_id, name, status, raw_json, fetched_at)"
                " VALUES(?,?,?,?,?)"
                " ON CONFLICT(campaign_id) DO UPDATE SET name=excluded.name, status=excluded.status,"
                " raw_json=excluded.raw_json, fetched_at=excluded.fetched_at",
                (str(cid), truncate_value(str(c.get("name", ""))),
                 truncate_value(str(c.get("status", ""))),
                 json.dumps(raw, ensure_ascii=False), fetched_at),
            )
        con.commit()
    finally:
        con.close()

    note = (f"{len(payload)} campaigns refreshed; stats filled for {stats_filled} "
            f"(null where the API does not expose them)")
    set_sync_state(SOURCE, fetched_at, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
