#!/usr/bin/env python3
"""Incremental Lemlist sync into the company brain.

Refreshes lemlist_campaigns (campaign list + per-campaign stats where the API
exposes them). Read-only against the Lemlist API (api.lemlist.com).

Auth: Lemlist accepts the API key as the ?access_token= query parameter
(documented at developer.lemlist.com). The key is the secret
opstream-gtm/lemlist-api-key and is sent only to api.lemlist.com.
"""

import json
import urllib.error
import urllib.request

from common import (
    NeedsConnection,
    RateLimiter,
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


def _get(path: str):
    url = _authed_url(path)
    pace.wait()
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code in (401, 403):
            raise NeedsConnection("Lemlist rejected the credential (HTTP %s); not touching watermarks" % e.code)
        return e.code, body


def main_sync(log):
    status, payload = _get("/api/campaigns")
    if status != 200 or not isinstance(payload, list):
        raise RuntimeError(f"Lemlist /api/campaigns returned HTTP {status}: {str(payload)[:300]}")

    con = db_connect()
    fetched_at = now_iso()
    stats_filled = 0
    try:
        for c in payload:
            cid = c.get("_id") or c.get("id")
            if not cid:
                continue
            raw = dict(c)
            # Per-campaign stats: cheap, one call each; tolerate absence.
            try:
                s_status, s_payload = _get(f"/api/campaigns/{cid}/stats")
                if s_status == 200 and isinstance(s_payload, dict):
                    raw["stats"] = s_payload
                    stats_filled += 1
            except Exception as e:
                log.info("campaign %s: stats unavailable (%s)", cid, type(e).__name__)
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
