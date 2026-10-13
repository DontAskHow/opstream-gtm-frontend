#!/usr/bin/env python3
"""Incremental HubSpot sync into the company brain.

Pulls objects whose modified date is newer than the per-object-type watermark,
upserts them into hubspot_objects, and refreshes associations for changed
objects. Tickets are excluded (outside registered scope).

Read-only against HubSpot. Paced under both HubSpot limits: 110 requests
per 10 s per installing account for public OAuth apps, and 5 requests per
second for the CRM search API (a separate SECONDLY limit, the cause of the
search 429s). A 429 is retried after a back-off instead of failing the run.
Long text fields truncated at 8000 chars (backfill convention).

Watermark format in sync_state (source='hubspot'): JSON object mapping
object_type -> ISO-8601 modified-date watermark.

Auth: Secrets Manager opstream-gtm/hubspot-oauth, the existing privately
distributed Opstream Marketing Dashboard app (portal 21303277). The JSON
holds portal_id, client_id, client_secret, refresh_token, token_endpoint,
and api_base. This script refreshes that grant. It does not start a consent
flow. Calls are GET, plus CRM search POST. A missing secret, a rejected
token, or a portal other than 21303277 exits 3 and does not move watermarks.
"""

import json
import os
import re
import time
from datetime import datetime, timezone

from common import (
    HubSpotClient,
    NeedsConnection,
    RateLimiter,
    db_connect,
    get_sync_state,
    run_main,
    set_sync_state,
    truncate_props,
)

SOURCE = "hubspot"
# HubSpot API: 110 requests per 10 seconds -> 0.15 s is about 67, which
# leaves room for the dashboard's own HubSpot calls.
pace = RateLimiter(0.15)
# CRM search: 5 requests per second, shared across object types.
search_pace = RateLimiter(0.25)
RETRY_429 = (1, 2, 4, 8, 10)


def hs_request(client, method, url, body=None, search=False):
    """client.request with pacing and a back-off on 429. Other statuses pass through."""
    for delay in RETRY_429 + (None,):
        (search_pace if search else pace).wait()
        status, payload = client.request(method, url, body=body)
        if status != 429 or delay is None:
            return status, payload
        time.sleep(delay)

# object_type -> (modified-date property, [properties to fetch])
OBJECT_TYPES = {
    "contacts": ("lastmodifieddate", ["city", "company", "country", "createdate", "email",
        "firstname", "hs_lead_status", "hs_object_id", "hubspot_owner_id", "jobtitle",
        "lastmodifieddate", "lastname", "lifecyclestage", "phone", "state"]),
    "companies": ("hs_lastmodifieddate", ["annualrevenue", "city", "country", "createdate",
        "domain", "hs_lastmodifieddate", "hs_object_id", "hubspot_owner_id", "industry",
        "lifecyclestage", "name", "numberofemployees", "phone", "state"]),
    "deals": ("hs_lastmodifieddate", ["amount", "closedate", "createdate", "dealname",
        "closed_lost_reason", "dealstage", "dealtype", "hs_deal_stage_probability", "hs_forecast_probability",
        "hs_is_closed", "hs_is_closed_won", "hs_lastmodifieddate",
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

# Deal properties added after the backfill. Rows fetched before then get them
# once from backfill_deal_props().
LATER_DEAL_PROPS = ("hs_forecast_probability", "hs_is_closed", "hs_is_closed_won", "closed_lost_reason")
# Deal extras (companies primary first, owner history) are refreshed for
# changed deals every run and for all deals this often, because an association
# edit does not always move a deal's modified date.
EXTRAS_FULL_HOURS = float(os.environ.get("HUBSPOT_EXTRAS_FULL_HOURS") or 6)
PRIMARY_COMPANY_TYPE_ID = 5  # HUBSPOT_DEFINED deal -> company "Primary"

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


def search_objects(client, otype: str, modfield: str, props: list[str], since_ms: int):
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
        status, payload = hs_request(
            client, "POST", f"{client.api_base}/crm/v3/objects/{otype}/search", body=body, search=True,
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


def refresh_associations(client, con, otype: str, hs_id: str, log) -> int:
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
            url = f"{client.api_base}/crm/v4/objects/{frm}/{hs_id}/associations/{to}?limit=500"
            try:
                status, payload = hs_request(client, "GET", url)
            except NeedsConnection:
                raise
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


def _query_value(value):
    return "".join(ch if ch.isalnum() or ch in "-._~" else "%%%02X" % ord(ch) for ch in str(value))


def sync_owners(client, log):
    """Read the owners catalog. Active rows win over archived rows with the same id."""
    collected = {}
    for archived in (False, True):
        after = None
        seen_after = set()
        for _page in range(50):
            params = ["limit=100"]
            if archived:
                params.append("archived=true")
            if after:
                params.append("after=" + _query_value(after))
            url = client.api_base + "/crm/v3/owners?" + "&".join(params)
            status, payload = hs_request(client, "GET", url)
            if status != 200 or not isinstance(payload, dict):
                raise RuntimeError("HubSpot owners returned HTTP %s" % status)
            for row in payload.get("results") or []:
                oid = str(row.get("id") or "").strip()
                if not oid or (archived and oid in collected):
                    continue
                collected[oid] = (
                    oid,
                    str(row.get("firstName") or "").strip(),
                    str(row.get("lastName") or "").strip(),
                    str(row.get("email") or "").strip(),
                    int(bool(row.get("archived", archived))),
                )
            after = ((payload.get("paging") or {}).get("next") or {}).get("after")
            if not after or after in seen_after:
                break
            seen_after.add(after)
    con = db_connect()
    try:
        con.execute(
            "CREATE TABLE IF NOT EXISTS hubspot_owners ("
            "id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT)"
        )
        # Older code inserts without this column and leaves it NULL.
        if "archived" not in {r[1] for r in con.execute("PRAGMA table_info(hubspot_owners)")}:
            con.execute("ALTER TABLE hubspot_owners ADD COLUMN archived INTEGER")
        try:
            con.execute("BEGIN")
            con.execute("DELETE FROM hubspot_owners")
            con.executemany(
                "INSERT INTO hubspot_owners(id, first_name, last_name, email, archived) VALUES(?,?,?,?,?)",
                list(collected.values()),
            )
            con.commit()
        except Exception:
            con.rollback()
            raise
    finally:
        con.close()
    log.info("owners: %d catalog rows", len(collected))
    return len(collected)


def sync_pipelines(client, log):
    """Read deal pipeline and stage names. Classification does not guess from the label."""
    url = client.api_base + "/crm/v3/pipelines/deals"
    status, payload = hs_request(client, "GET", url)
    if status != 200 or not isinstance(payload, dict):
        raise RuntimeError("HubSpot pipelines returned HTTP %s" % status)
    rows = []
    labels = {}
    for pipe in payload.get("results") or []:
        pid = str(pipe.get("id") or "").strip()
        plabel = str(pipe.get("label") or "").strip()
        if not pid:
            continue
        labels[pid] = plabel
        for stage in pipe.get("stages") or []:
            sid = str(stage.get("id") or "").strip()
            if not sid:
                continue
            order = stage.get("displayOrder")
            try:
                order = int(order)
            except (TypeError, ValueError):
                order = None
            meta = stage.get("metadata") or {}
            closed = meta.get("isClosed")
            closed = None if closed is None else int(closed is True or str(closed).lower() == "true")
            prob = meta.get("probability")
            prob = None if prob in (None, "") else str(prob)
            rows.append((pid, plabel, sid, str(stage.get("label") or "").strip(), order, closed, prob))
    for pid in ("686463412", "855205465"):
        label = labels.get(pid)
        if label and not re.search(r"renew|customer|success", label, flags=re.I):
            log.warning(
                "pipeline %s is labeled %r, which is not a renewal/CS name. "
                "Deals in that pipeline stay out of new business because the pipeline id is the renewal list. "
                "The label was not used to guess a different class.",
                pid, label,
            )
    con = db_connect()
    try:
        con.execute(
            "CREATE TABLE IF NOT EXISTS hubspot_pipelines ("
            "pipeline_id TEXT, pipeline_label TEXT, stage_id TEXT, stage_label TEXT, "
            "display_order INTEGER, PRIMARY KEY (pipeline_id, stage_id))"
        )
        # Stage metadata for the deal export. Older code inserts without these
        # columns and leaves them NULL until this sync runs again.
        have = {r[1] for r in con.execute("PRAGMA table_info(hubspot_pipelines)")}
        for col, kind in (("is_closed", "INTEGER"), ("probability", "TEXT")):
            if col not in have:
                con.execute("ALTER TABLE hubspot_pipelines ADD COLUMN %s %s" % (col, kind))
        try:
            con.execute("BEGIN")
            con.execute("DELETE FROM hubspot_pipelines")
            con.executemany(
                "INSERT INTO hubspot_pipelines(pipeline_id, pipeline_label, stage_id, stage_label, display_order, "
                "is_closed, probability) VALUES(?,?,?,?,?,?,?)",
                rows,
            )
            con.commit()
        except Exception:
            con.rollback()
            raise
    finally:
        con.close()
    log.info("pipelines: %d stages across %d pipelines", len(rows), len(labels))
    return len(rows), labels


def backfill_deal_props(client, con, log):
    """Fill LATER_DEAL_PROPS on deals stored before they were fetched.

    One paged search over all deals (about 6 calls for 600 deals) that returns only
    those properties. It touches no associations and no watermark, and it runs only
    while a stored deal still lacks them. A deal the search does not return gets
    nulls so it is not asked for again.
    """
    rows = con.execute("SELECT hs_id, properties_json FROM hubspot_objects WHERE object_type='deals'").fetchall()
    stored = {}
    for hs_id, raw in rows:
        try:
            props = json.loads(raw or "{}")
        except ValueError:
            props = {}
        if any(k not in props for k in LATER_DEAL_PROPS):
            stored[str(hs_id)] = props
    if not stored:
        return 0
    seen = 0
    for obj in search_objects(client, "deals", "hs_lastmodifieddate", ["hs_object_id", *LATER_DEAL_PROPS], 0):
        hs_id = str(obj.get("id", ""))
        if hs_id not in stored:
            continue
        got = obj.get("properties") or {}
        stored[hs_id].update({k: got.get(k) for k in LATER_DEAL_PROPS})
        seen += 1
    for hs_id, props in stored.items():
        for k in LATER_DEAL_PROPS:
            props.setdefault(k, None)
        con.execute("UPDATE hubspot_objects SET properties_json=? WHERE object_type='deals' AND hs_id=?",
                    (json.dumps(props, ensure_ascii=False), hs_id))
    con.commit()
    log.info("deals: backfilled %s for %d deals (%d not returned by HubSpot search)",
             ", ".join(LATER_DEAL_PROPS), seen, len(stored) - seen)
    return seen


def _chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def sync_deal_extras(client, con, changed_deal_ids, log):
    """Store per-deal companyIds (primary first) and hubspot_owner_id history.

    Two read-only batch endpoints: v4 deal->company associations (100 ids a call;
    the association labels say which company is primary) and v3 deals batch read
    with propertiesWithHistory (50 ids a call; search cannot return history).
    Changed deals and deals without extras are read every run; all deals once
    every EXTRAS_FULL_HOURS. A full pass over 600 deals is about 18 calls.
    """
    con.execute("CREATE TABLE IF NOT EXISTS hubspot_deal_extras ("
                "deal_id TEXT PRIMARY KEY, company_ids TEXT, owner_history TEXT, refreshed_at TEXT)")
    all_ids = [r[0] for r in con.execute("SELECT hs_id FROM hubspot_objects WHERE object_type='deals'")]
    have = {r[0] for r in con.execute("SELECT deal_id FROM hubspot_deal_extras")}
    last_full, _run, _note = get_sync_state("hubspot_extras")
    full = True
    try:
        age_h = (datetime.now(timezone.utc) - datetime.fromisoformat(last_full)).total_seconds() / 3600.0
        full = age_h >= EXTRAS_FULL_HOURS
    except (TypeError, ValueError):
        pass
    wanted = all_ids if full else sorted({str(i) for i in changed_deal_ids} | (set(all_ids) - have))
    if not wanted:
        log.info("deal extras: nothing to refresh")
        return 0
    companies = {}
    for part in _chunks(wanted, 100):
        status, payload = hs_request(client, "POST", client.api_base + "/crm/v4/associations/deals/companies/batch/read",
                                     body={"inputs": [{"id": i} for i in part]})
        if status not in (200, 207) or not isinstance(payload, dict):
            raise RuntimeError("HubSpot deal->company associations returned HTTP %s" % status)
        for row in payload.get("results") or []:
            tos = row.get("to") or []
            prim = [t for t in tos if any(x.get("typeId") == PRIMARY_COMPANY_TYPE_ID for x in t.get("associationTypes") or [])]
            order = prim + [t for t in tos if t not in prim]
            companies[str((row.get("from") or {}).get("id"))] = [str(t.get("toObjectId")) for t in order]
    history = {}
    for part in _chunks(wanted, 50):
        status, payload = hs_request(client, "POST", client.api_base + "/crm/v3/objects/deals/batch/read",
                                     body={"inputs": [{"id": i} for i in part], "properties": ["hubspot_owner_id"],
                                           "propertiesWithHistory": ["hubspot_owner_id"]})
        if status not in (200, 207) or not isinstance(payload, dict):
            raise RuntimeError("HubSpot deals batch read returned HTTP %s" % status)
        for row in payload.get("results") or []:
            hist = (row.get("propertiesWithHistory") or {}).get("hubspot_owner_id") or []
            entries = [{"value": h.get("value"), "timestamp": h.get("timestamp"), "sourceType": h.get("sourceType")}
                       for h in hist]
            entries.sort(key=lambda h: str(h.get("timestamp") or ""), reverse=True)
            history[str(row.get("id"))] = entries
    now = datetime.now(timezone.utc).isoformat()
    for deal_id in wanted:
        con.execute(
            "INSERT INTO hubspot_deal_extras(deal_id, company_ids, owner_history, refreshed_at) VALUES(?,?,?,?) "
            "ON CONFLICT(deal_id) DO UPDATE SET company_ids=excluded.company_ids, "
            "owner_history=excluded.owner_history, refreshed_at=excluded.refreshed_at",
            (deal_id, json.dumps(companies.get(deal_id, [])), json.dumps(history.get(deal_id, [])), now))
    con.commit()
    if full:
        set_sync_state("hubspot_extras", now, "full refresh of %d deals" % len(wanted))
    log.info("deal extras: %s refresh of %d deals (%d with a company, %d with owner history)",
             "full" if full else "incremental", len(wanted),
             sum(1 for i in wanted if companies.get(i)), sum(1 for i in wanted if history.get(i)))
    return len(wanted)


def main_sync(log):
    client = HubSpotClient(log=log)
    client.prepare()
    owner_rows = sync_owners(client, log)
    pipeline_rows, _pipeline_labels = sync_pipelines(client, log)
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
    changed_deals = []
    try:
        for otype, (modfield, props) in OBJECT_TYPES.items():
            since_iso = watermarks.get(otype, "2020-01-01T00:00:00+00:00")
            since_ms = _to_ms(since_iso)
            changed_ids = []
            max_seen = since_iso
            count = 0
            for obj in search_objects(client, otype, modfield, props, since_ms):
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
            if otype == "deals":
                changed_deals = list(changed_ids)
            # Refresh associations for changed objects only.
            assoc_written = 0
            for hs_id in changed_ids:
                assoc_written += refresh_associations(client, con, otype, hs_id, log)
            con.commit()
            watermarks[otype] = max_seen
            total_upserted += count
            total_assoc += assoc_written
            log.info("%s: %d changed objects, %d association rows rewritten, watermark -> %s",
                     otype, count, assoc_written, max_seen)
        backfill_deal_props(client, con, log)
        sync_deal_extras(client, con, changed_deals, log)
    finally:
        con.close()

    note = (f"{total_upserted} objects upserted, {total_assoc} association rows refreshed, "
            f"{owner_rows} owners, {pipeline_rows} pipeline stages; tickets excluded (outside registered scope); "
            f"long text truncated at 8000 chars")
    set_sync_state(SOURCE, json.dumps(watermarks), note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
