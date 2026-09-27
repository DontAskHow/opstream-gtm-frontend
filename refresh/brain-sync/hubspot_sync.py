#!/usr/bin/env python3
"""Incremental HubSpot sync into the company brain.

Pulls objects whose modified date is newer than the per-object-type watermark,
upserts them into hubspot_objects, and refreshes associations for changed
objects. Tickets are excluded (outside registered scope).

Read-only against HubSpot. Respects the 100 req / 10 s rate limit via pacing.
Long text fields truncated at 8000 chars (backfill convention).

Watermark format in sync_state (source='hubspot'): JSON object mapping
object_type -> ISO-8601 modified-date watermark.

Auth: Secrets Manager opstream-gtm/hubspot-token (private app, read-only CRM,
portal 21303277). A missing or rejected token exits 3 and does not move
watermarks.
"""

import json
import sys
import time
from datetime import datetime, timezone

from common import (
    EXIT_ERROR,
    NeedsConnection,
    RateLimiter,
    authed_request,
    db_connect,
    get_sync_state,
    run_main,
    set_sync_state,
    truncate_props,
)

SOURCE = "hubspot"
BASE = "https://api.hubapi.com"
ALLOWED_HOSTS = ["api.hubapi.com"]
CONNECTORS = ["custom.hubspot", "hubspot"]
# HubSpot API: max 100 requests per 10 seconds -> stay well under it.
pace = RateLimiter(0.12)

# object_type -> (modified-date property, [properties to fetch])
OBJECT_TYPES = {
    "contacts": ("lastmodifieddate", ["city", "company", "country", "createdate", "email",
        "firstname", "hs_lead_status", "hs_object_id", "hubspot_owner_id", "jobtitle",
        "lastmodifieddate", "lastname", "lifecyclestage", "phone", "state"]),
    "companies": ("hs_lastmodifieddate", ["annualrevenue", "city", "country", "createdate",
        "domain", "hs_lastmodifieddate", "hs_object_id", "hubspot_owner_id", "industry",
        "lifecyclestage", "name", "numberofemployees", "phone", "state"]),
    "deals": ("hs_lastmodifieddate", ["amount", "closedate", "createdate", "dealname",
        "dealstage", "dealtype", "hs_deal_stage_probability", "hs_lastmodifieddate",
        "hs_object_id", "hubspot_owner_id", "pipeline"]),
    "emails": ("hs_lastmodifieddate", ["hs_createdate", "hs_email_direction",
        "hs_email_from_email", "hs_email_subject", "hs_email_text", "hs_email_to_email",
        "hs_lastmodifieddate", "hs_object_id", "hs_timestamp", "hubspot_owner_id"]),
    "notes": ("hs_lastmodifieddate", ["hs_createdate", "hs_lastmodifieddate", "hs_note_body",
        "hs_object_id", "hs_timestamp", "hubspot_owner_id"]),
    "tasks": ("hs_lastmodifieddate", ["hs_createdate", "hs_lastmodifieddate", "hs_object_id",
        "hs_task_body", "hs_task_priority", "hs_task_status", "hs_task_subject",
        "hs_timestamp", "hubspot_owner_id"]),
    "calls": ("hs_lastmodifieddate", ["hs_call_body", "hs_call_direction", "hs_call_duration",
        "hs_call_from_number", "hs_call_title", "hs_call_to_number", "hs_createdate",
        "hs_lastmodifieddate", "hs_object_id", "hs_timestamp", "hubspot_owner_id"]),
    "meetings": ("hs_lastmodifieddate", ["hs_createdate", "hs_lastmodifieddate",
        "hs_meeting_body", "hs_meeting_end_time", "hs_meeting_outcome",
        "hs_meeting_start_time", "hs_meeting_title", "hs_object_id", "hs_timestamp",
        "hubspot_owner_id"]),
    "products": ("hs_lastmodifieddate", ["createdate", "description", "hs_createdate",
        "hs_lastmodifieddate", "hs_object_id", "hs_sku", "name", "price"]),
    "line_items": ("hs_lastmodifieddate", ["amount", "createdate", "hs_createdate",
        "hs_lastmodifieddate", "hs_object_id", "hs_product_id", "name", "price", "quantity"]),
}
# NOTE: tickets deliberately excluded (outside registered scope).

# Association pairs observed in the backfill; used to enumerate which
# to-types to query per changed object. Stored bidirectionally in DB.
ASSOC_PAIRS = [
    ("contacts", "companies"), ("emails", "contacts"), ("emails", "companies"),
    ("emails", "deals"), ("meetings", "contacts"), ("meetings", "companies"),
    ("meetings", "deals"), ("contacts", "tasks"), ("companies", "tasks"),
    ("companies", "notes"), ("contacts", "deals"), ("calls", "companies"),
    ("companies", "deals"), ("deals", "tasks"), ("calls", "contacts"),
    ("contacts", "notes"), ("deals", "notes"), ("calls", "deals"),
]


def _to_ms(iso: str) -> int:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def search_objects(otype: str, modfield: str, props: list[str], since_ms: int):
    """Yield result dicts from the CRM search API, paginated."""
    after = None
    while True:
        body = {
            "filterGroups": [{
                "filters": [{
                    "propertyName": modfield,
                    "operator": "GTE",
                    "value": since_ms,
                }]
            }],
            "sorts": [{"propertyName": modfield, "direction": "ASCENDING"}],
            "properties": props,
            "limit": 100,
        }
        if after:
            body["after"] = after
        pace.wait()
        status, payload = authed_request(
            "POST", f"{BASE}/crm/v3/objects/{otype}/search",
            CONNECTORS, ALLOWED_HOSTS, body=body,
        )
        if status != 200:
            raise RuntimeError(f"HubSpot search {otype} returned HTTP {status}: {str(payload)[:300]}")
        results = payload.get("results", []) if isinstance(payload, dict) else []
        for r in results:
            yield r
        nxt = (payload.get("paging") or {}).get("next", {}) if isinstance(payload, dict) else {}
        after = nxt.get("after")
        if not after:
            break


def refresh_associations(con, otype: str, hs_id: str, log) -> int:
    """Re-pull all associations for one object; returns rows written."""
    cur = con.cursor()
    cur.execute(
        "DELETE FROM hubspot_associations WHERE (from_type=? AND from_id=?) "
        "OR (to_type=? AND to_id=?)",
        (otype, hs_id, otype, hs_id),
    )
    to_types = sorted({b for (a, b) in ASSOC_PAIRS if a == otype}
                      | {a for (a, b) in ASSOC_PAIRS if b == otype})
    written = 0
    for to_type in to_types:
        # Query both directions explicitly via the v4 associations endpoint.
        for frm, to in ((otype, to_type), (to_type, otype)):
            if frm == to:
                continue
            url = f"{BASE}/crm/v4/objects/{frm}/{hs_id}/associations/{to}?limit=500"
            pace.wait()
            try:
                status, payload = authed_request("GET", url, CONNECTORS, ALLOWED_HOSTS)
            except Exception as e:
                log.warning("assoc fetch %s/%s -> %s failed: %s", frm, to, hs_id, e)
                continue
            if status != 200 or not isinstance(payload, dict):
                log.warning("assoc fetch %s/%s -> %s HTTP %s", frm, to, hs_id, status)
                continue
            for assoc in payload.get("results", []):
                to_id = str(assoc.get("toObjectId", ""))
                if not to_id:
                    continue
                cur.execute(
                    "INSERT OR IGNORE INTO hubspot_associations(from_type, from_id, to_type, to_id) "
                    "VALUES(?,?,?,?)",
                    (frm, str(hs_id), to, to_id),
                )
                # Mirror row to keep the bidirectional convention used by the backfill.
                cur.execute(
                    "INSERT OR IGNORE INTO hubspot_associations(from_type, from_id, to_type, to_id) "
                    "VALUES(?,?,?,?)",
                    (to, to_id, frm, str(hs_id)),
                )
                written += 2
    return written


def main_sync(log):
    watermark_raw, last_run, _note = get_sync_state(SOURCE)
    try:
        watermarks = json.loads(watermark_raw) if watermark_raw else {}
        if not isinstance(watermarks, dict):
            raise ValueError("not a dict")
    except (ValueError, TypeError):
        # Legacy watermark ("all registered objects"): seed every type from
        # the last full backfill time so we only pull newer changes.
        seed = last_run or "2026-09-25T07:30:00+00:00"
        watermarks = {t: seed for t in OBJECT_TYPES}
        log.info("legacy watermark %r; seeding per-type watermarks at %s", watermark_raw, seed)

    con = db_connect()
    fetched_at = datetime.now(timezone.utc).isoformat()
    total_upserted = 0
    total_assoc = 0
    try:
        for otype, (modfield, props) in OBJECT_TYPES.items():
            since_iso = watermarks.get(otype, "2020-01-01T00:00:00+00:00")
            since_ms = _to_ms(since_iso)
            changed_ids = []
            max_seen = since_iso
            count = 0
            for obj in search_objects(otype, modfield, props, since_ms):
                hs_id = str(obj.get("id", ""))
                properties = truncate_props(obj.get("properties", {}) or {})
                if not hs_id:
                    continue
                con.execute(
                    "INSERT INTO hubspot_objects(object_type, hs_id, properties_json, fetched_at) "
                    "VALUES(?,?,?,?) "
                    "ON CONFLICT(object_type, hs_id) DO UPDATE SET "
                    "properties_json=excluded.properties_json, fetched_at=excluded.fetched_at",
                    (otype, hs_id, json.dumps(properties, ensure_ascii=False), fetched_at),
                )
                changed_ids.append(hs_id)
                count += 1
                mod = properties.get(modfield)
                if mod and mod > max_seen:
                    max_seen = mod
            # Refresh associations for changed objects only.
            assoc_written = 0
            for hs_id in changed_ids:
                assoc_written += refresh_associations(con, otype, hs_id, log)
            con.commit()
            watermarks[otype] = max_seen
            total_upserted += count
            total_assoc += assoc_written
            log.info("%s: %d changed objects, %d association rows rewritten, watermark -> %s",
                     otype, count, assoc_written, max_seen)
    finally:
        con.close()

    note = (f"{total_upserted} objects upserted, {total_assoc} association rows refreshed; "
            f"tickets excluded (outside registered scope); long text truncated at 8000 chars")
    set_sync_state(SOURCE, json.dumps(watermarks), note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
