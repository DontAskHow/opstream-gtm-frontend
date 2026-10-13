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
flow. Calls are GET, plus the CRM search, lists search, and batch read POSTs.
A missing secret, a rejected token, or a portal other than 21303277 exits 3
and does not move watermarks.

Meetings also carry their source (hs_meeting_source*, activity type) and any
property naming the booking link that GET /crm/v3/properties/meetings lists;
when that call fails they go without. Location and external URL are never
stored (they can hold conference passcodes).

After the objects, up to five extra pulls run. Each records its own sync_outcomes
row and a failure in one (a missing scope, say) does not fail the sync or
stop the others:
  hubspot_forms             forms (archived too) and their submissions; first
                            pulls share FORM_SUBMISSION_MAX_CALLS pages a run
                            (default 200) and resume next run. A form whose
                            submissions HubSpot cannot export (HTTP 400, form
                            type) is marked submissions_exportable=0, skipped,
                            and re-checked every NOT_EXPORTABLE_RECHECK_DAYS (7)
  hubspot_lists             list catalog; each contact list's memberships at
                            most every LIST_MIN_INTERVAL_MIN minutes (default
                            360), LIST_MEMBERSHIP_MAX_CALLS pages a run
                            (default 400), resumed next run
  hubspot_imports           the import log
  hubspot_contact_backfill  only with HUBSPOT_CONTACT_BACKFILL=1 (or restart,
                            which starts over once per value): re-reads
                            every contact's properties once
  hubspot_meeting_backfill  the same for meetings, with HUBSPOT_MEETING_BACKFILL;
                            each backfill reads at most HUBSPOT_BACKFILL_MAX_PAGES
                            (default 150) pages a run and resumes next run
A failed extra pull also logs `EXTRA_PULL_FAILED <name> <route> <status>` to
stdout; the exit code does not change.
"""

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone

from common import (
    HubSpotClient,
    NeedsConnection,
    RateLimiter,
    SourceError,
    SourceRefused,
    db_connect,
    get_sync_state,
    run_main,
    run_part,
    set_sync_state,
    truncate_props,
    truncate_value,
)

SOURCE = "hubspot"
HOST = "api.hubapi.com"
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
        "lastmodifieddate", "lastname", "lifecyclestage", "phone", "state",
        # Source attribution, conversions, and lifecycle dates. Contacts stored
        # before these were added get them from HUBSPOT_CONTACT_BACKFILL=1.
        "hs_analytics_source", "hs_analytics_source_data_1", "hs_analytics_source_data_2",
        "hs_latest_source", "hs_latest_source_data_1", "hs_latest_source_data_2",
        "first_conversion_event_name", "first_conversion_date",
        "recent_conversion_event_name", "recent_conversion_date", "num_conversion_events",
        "hs_object_source", "hs_object_source_label", "hs_object_source_detail_1",
        "hs_google_click_id", "hs_lifecyclestage_lead_date",
        "hs_lifecyclestage_marketingqualifiedlead_date",
        "hs_lifecyclestage_salesqualifiedlead_date", "hs_lifecyclestage_customer_date"]),
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
        "hubspot_owner_id",
        # Where the meeting came from (booked through a meetings link, a calendar
        # sync, ...). Meetings stored before these were added get them from
        # HUBSPOT_MEETING_BACKFILL=1. Location and external URL are not fetched:
        # they can hold conference links with passcodes (MEETING_PROPS_DROPPED).
        "hs_meeting_source", "hs_meeting_source_id", "hs_activity_type"]),
    "products": ("hs_lastmodifieddate", ["createdate", "description", "hs_createdate",
        "hs_lastmodifieddate", "hs_object_id", "hs_sku", "name", "price"]),
    "line_items": ("hs_lastmodifieddate", ["amount", "createdate", "hs_createdate",
        "hs_lastmodifieddate", "hs_object_id", "hs_product_id", "name", "price", "quantity"]),
}
# NOTE: tickets deliberately excluded (outside registered scope).
# Portal-defined contact properties fetched when the portal has them.
CUSTOM_CONTACT_PROP = re.compile(r"^(paid_touch_campaign|utm_\w+)$", re.I)
# Meeting properties naming the booking (meetings) link, by name or label,
# fetched when GET /crm/v3/properties/meetings lists them.
MEETING_LINK_NAME = re.compile(r"booking|meetings?_link|scheduling_page", re.I)
MEETING_LINK_LABEL = re.compile(r"booking|meetings? link|scheduling page", re.I)
# Never stored, and removed from stored meetings by the meeting backfill:
# conference links and locations can carry passcodes.
MEETING_PROPS_DROPPED = {"hs_meeting_location", "hs_meeting_external_url"}
# Not wanted, whatever the pattern says: internal notes are free text, and
# hs_scheduled_tasks is HubSpot's internal task/reminder bookkeeping.
MEETING_PROPS_SKIPPED = {"hs_internal_meeting_notes", "hs_scheduled_tasks"} | MEETING_PROPS_DROPPED

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


# ---------------------------------------------------------------- extra pulls
# Each one records its own sync_outcomes row (run_part) and fails alone.

FORMS_ROUTE = "GET /marketing/v3/forms"
SUBMISSIONS_ROUTE = "GET /form-integrations/v1/submissions/forms/{formGuid}"
LISTS_ROUTE = "POST /crm/v3/lists/search"
MEMBERSHIPS_ROUTE = "GET /crm/v3/lists/{listId}/memberships"
IMPORTS_ROUTE = "GET /crm/v3/imports"
# object type -> backfill name: HUBSPOT_<NAME>_BACKFILL, sync_state and outcome hubspot_<name>_backfill.
BACKFILLS = {"contacts": "contact", "meetings": "meeting"}
CONTACT_LIST_TYPE = "0-1"
LIST_MIN_INTERVAL_MIN = float(os.environ.get("LIST_MIN_INTERVAL_MIN") or 360)
# Per-run page caps, so a first pull fits the 15-minute cadence; both resume next run.
LIST_MEMBERSHIP_MAX_CALLS = int(os.environ.get("LIST_MEMBERSHIP_MAX_CALLS") or 400)
FORM_SUBMISSION_MAX_CALLS = int(os.environ.get("FORM_SUBMISSION_MAX_CALLS") or 200)
# HubSpot answers 400 for forms whose type has no exportable submissions:
# {"message": "Submissions can't be exported for this form.", "errorType": "FORM_TYPE_..."}.
NOT_EXPORTABLE_MESSAGE = re.compile(r"\bcan(?:'|\u2019)?t be exported|\bcannot be exported", re.I)
NOT_EXPORTABLE_RECHECK_DAYS = 7
BACKFILL_PAGE = 200  # CRM search maximum
# Searches per backfill per run; the backfill resumes next run.
BACKFILL_MAX_PAGES = int(os.environ.get("HUBSPOT_BACKFILL_MAX_PAGES") or 150)


# Created before the first call, so readers find the tables even when a pull fails.
EXTRA_TABLES = (
    "CREATE TABLE IF NOT EXISTS hubspot_forms(form_id TEXT PRIMARY KEY, name TEXT, form_type TEXT, "
    "created_at TEXT, updated_at TEXT, archived INTEGER, raw_json TEXT, fetched_at TEXT, "
    "submissions_exportable INTEGER)",
    "CREATE TABLE IF NOT EXISTS hubspot_form_submissions(form_id TEXT, conversion_id TEXT, submitted_at TEXT, "
    "contact_email TEXT, page_url TEXT, page_title TEXT, values_json TEXT, fetched_at TEXT, "
    "PRIMARY KEY(form_id, conversion_id))",
    "CREATE TABLE IF NOT EXISTS hubspot_lists(list_id TEXT PRIMARY KEY, name TEXT, processing_type TEXT, "
    "object_type TEXT, size INTEGER, created_at TEXT, updated_at TEXT, raw_json TEXT, fetched_at TEXT)",
    "CREATE TABLE IF NOT EXISTS hubspot_list_memberships(list_id TEXT, record_id TEXT, added_at TEXT, "
    "PRIMARY KEY(list_id, record_id))",
    # Pages of a list whose read is not finished yet; moved into hubspot_list_memberships when it is.
    "CREATE TABLE IF NOT EXISTS hubspot_list_memberships_pending(list_id TEXT, record_id TEXT, added_at TEXT, "
    "PRIMARY KEY(list_id, record_id))",
    "CREATE TABLE IF NOT EXISTS hubspot_imports(import_id TEXT PRIMARY KEY, name TEXT, state TEXT, "
    "created_at TEXT, raw_json TEXT, fetched_at TEXT)",
)


def hs_call(client, method, url, route, body=None, search=False):
    """hs_request that raises SourceError/SourceRefused with a route template, not ids."""
    try:
        status, payload = hs_request(client, method, url, body=body, search=search)
    except SourceRefused as e:
        raise SourceRefused(HOST, route, e.status, "missing scope or credential rejected") from None
    if status != 200 or not isinstance(payload, dict):
        err = SourceError(HOST, route, status, str(payload)[:200])
        err.payload = payload
        raise err
    return payload


def hs_pages(client, url_for, route, max_pages=500):
    """Yield GET pages, following paging.next.after."""
    after = None
    seen = set()
    for _page in range(max_pages):
        payload = hs_call(client, "GET", url_for(after), route)
        yield payload
        after = ((payload.get("paging") or {}).get("next") or {}).get("after")
        if not after or after in seen:
            return
        seen.add(after)


def _ms(value):
    """An epoch-ms value as int, or None when it is missing or not a number."""
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError, OverflowError):
            return None


def _iso_ms(value):
    try:
        return datetime.fromtimestamp(_ms(value) / 1000.0, timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _next_after(payload):
    return ((payload.get("paging") or {}).get("next") or {}).get("after")


def _json_state(source):
    """A sync_state watermark holding a JSON object, or {}."""
    raw, _run, _note = get_sync_state(source)
    try:
        state = json.loads(raw) if raw else {}
    except ValueError:
        state = {}
    return state if isinstance(state, dict) else {}


def discover_props(client, otype, wanted, what, log):
    """Names of otype properties for which wanted(property) is true, or [] when they cannot be listed."""
    try:
        payload = hs_call(client, "GET", client.api_base + "/crm/v3/properties/" + otype,
                          "GET /crm/v3/properties/" + otype)
    except Exception as e:
        log.warning("%s properties not listed (%s); %s skipped", otype[:-1], e, what)
        return []
    names = sorted({str(p.get("name") or "") for p in payload.get("results") or []
                    if isinstance(p, dict) and p.get("name") and wanted(p)})
    log.info("%s properties: %s %s", otype[:-1], what, ", ".join(names) or "none")
    return names


def discover_contact_props(client, log):
    """Custom paid_touch_campaign / utm_* contact properties, when the portal has them."""
    return discover_props(client, "contacts", lambda p: CUSTOM_CONTACT_PROP.match(str(p["name"])),
                          "custom attribution properties", log)


def discover_meeting_props(client, log):
    """Meeting properties naming the booking link, when the portal has them."""
    return discover_props(client, "meetings", lambda p: str(p["name"]) not in MEETING_PROPS_SKIPPED and (
        MEETING_LINK_NAME.search(str(p["name"])) or MEETING_LINK_LABEL.search(str(p.get("label") or ""))),
        "booking link properties", log)


def submissions_not_exportable(err):
    """True for HubSpot's 400 on a form type whose submissions cannot be exported."""
    body = getattr(err, "payload", None)
    if err.status != 400 or not isinstance(body, dict):
        return False
    return (str(body.get("errorType") or "").upper().startswith("FORM_TYPE")
            or bool(NOT_EXPORTABLE_MESSAGE.search(str(body.get("message") or ""))))


def _days_since(iso):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(iso)).total_seconds() / 86400.0
    except (TypeError, ValueError):
        return None


def sync_forms(client, log):
    """Forms (active and archived) and their submissions.

    Submissions come newest first. A form with a watermark (newest submittedAt
    seen, in ms) is read until a page reaches older submissions. A form without
    one is read in full; those first pulls share FORM_SUBMISSION_MAX_CALLS
    pages a run, and one cut short resumes from its saved paging cursor. An
    archived form is read once more after it is archived, then no longer. A
    failing form keeps its watermark and is counted; the others go on.

    A form whose submissions HubSpot will not export (submissions_not_exportable)
    is not a failure: hubspot_forms.submissions_exportable is set to 0 and the
    form is skipped until NOT_EXPORTABLE_RECHECK_DAYS have passed. A form read
    without that error gets 1; NULL means not asked yet.
    """
    forms = {}
    for archived in (False, True):
        def url_for(after, archived=archived):
            q = ["limit=100", "formTypes=all"]
            if archived:
                q.append("archived=true")
            if after:
                q.append("after=" + _query_value(after))
            return client.api_base + "/marketing/v3/forms?" + "&".join(q)
        for page in hs_pages(client, url_for, FORMS_ROUTE):
            for f in page.get("results") or []:
                fid = str((f or {}).get("id") or "").strip()
                if fid and not (archived and fid in forms):
                    forms[fid] = dict(f, archived=bool(f.get("archived", archived)))
    fetched_at = datetime.now(timezone.utc).isoformat()
    marks = _json_state("hubspot_forms")
    # cursors: first pulls cut short by FORM_SUBMISSION_MAX_CALLS, {formId: {after, newest}}.
    # archivedRead: archived forms read since they were archived.
    # notExportable: {formId: when HubSpot last said its submissions can't be exported}.
    progress = _json_state("hubspot_forms_progress")
    cursors = progress.get("cursors") if isinstance(progress.get("cursors"), dict) else {}
    archived_read = {str(x) for x in progress.get("archivedRead") or [] if x}
    not_exportable = progress.get("notExportable") if isinstance(progress.get("notExportable"), dict) else {}

    def save_progress():
        set_sync_state("hubspot_forms_progress", json.dumps(
            {"cursors": cursors, "archivedRead": sorted(archived_read), "notExportable": not_exportable},
            sort_keys=True),
            "first-pull paging cursors; archived forms read since archiving; forms whose submissions "
            "can't be exported, with when that was last checked")

    con = db_connect()
    new_total = 0
    first_calls = 0
    failed = []
    try:
        for fid, f in forms.items():
            con.execute(
                "INSERT INTO hubspot_forms(form_id, name, form_type, created_at, updated_at, archived, raw_json, "
                "fetched_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(form_id) DO UPDATE SET name=excluded.name, "
                "form_type=excluded.form_type, created_at=excluded.created_at, updated_at=excluded.updated_at, "
                "archived=excluded.archived, raw_json=excluded.raw_json, fetched_at=excluded.fetched_at",
                (fid, truncate_value(str(f.get("name") or "")), f.get("formType"), f.get("createdAt"),
                 f.get("updatedAt"), int(f["archived"]), json.dumps(f, ensure_ascii=False), fetched_at))
        con.commit()
        # Forms with a watermark first: their reads are short and not capped.
        for fid in sorted(forms, key=lambda x: _ms(marks.get(x)) is None):
            f = forms[fid]
            if f["archived"] and fid in archived_read:
                continue
            age = _days_since(not_exportable.get(fid))
            if age is not None and 0 <= age < NOT_EXPORTABLE_RECHECK_DAYS:
                continue
            mark = _ms(marks.get(fid))
            cur = cursors.get(fid) if mark is None and isinstance(cursors.get(fid), dict) else None
            after = (cur or {}).get("after") or None
            newest = max(mark or 0, _ms((cur or {}).get("newest")) or 0)
            new = 0
            done = False

            def url_for(after, fid=fid):
                url = client.api_base + "/form-integrations/v1/submissions/forms/%s?limit=50" % _query_value(fid)
                return url + ("&after=" + _query_value(after) if after else "")
            try:
                seen = set()
                for _page in range(2000):
                    if mark is None and first_calls >= FORM_SUBMISSION_MAX_CALLS:
                        break
                    page = hs_call(client, "GET", url_for(after), SUBMISSIONS_ROUTE)
                    if mark is None:
                        first_calls += 1
                    reached = False
                    for sub in page.get("results") or []:
                        if not isinstance(sub, dict):
                            continue
                        ms = _ms(sub.get("submittedAt"))
                        if mark is not None and ms is not None and ms < mark:
                            reached = True
                            break
                        raw_values = sub.get("values") or []
                        values = [{k: truncate_value(v) for k, v in x.items()} if isinstance(x, dict)
                                  else truncate_value(x) for x in raw_values]
                        email = next((v.get("value") for v in values
                                      if isinstance(v, dict) and str(v.get("name") or "").lower() == "email"), None)
                        key = str(sub.get("conversionId") or "") or "sha1:" + hashlib.sha1(json.dumps(
                            [sub.get("submittedAt"), sub.get("pageUrl"), raw_values], sort_keys=True,
                            default=str).encode()).hexdigest()
                        cur_row = con.execute(
                            "INSERT INTO hubspot_form_submissions(form_id, conversion_id, submitted_at, contact_email, "
                            "page_url, page_title, values_json, fetched_at) VALUES(?,?,?,?,?,?,?,?) "
                            "ON CONFLICT(form_id, conversion_id) DO NOTHING",
                            (fid, key, _iso_ms(sub.get("submittedAt")), email, truncate_value(sub.get("pageUrl")),
                             truncate_value(sub.get("pageTitle")), json.dumps(values, ensure_ascii=False), fetched_at))
                        new += cur_row.rowcount
                        if ms is not None:
                            newest = max(newest, ms)
                    nxt = _next_after(page)
                    if reached or not nxt or nxt in seen:
                        done = True
                        break
                    seen.add(nxt)
                    after = nxt
                else:
                    done = True
            except SourceRefused:
                raise  # the forms scope is missing: every form would answer the same
            except SourceError as e:
                con.rollback()
                if submissions_not_exportable(e):
                    con.execute("UPDATE hubspot_forms SET submissions_exportable=0 WHERE form_id=?", (fid,))
                    con.commit()
                    not_exportable[fid] = fetched_at
                    cursors.pop(fid, None)
                    if f["archived"]:
                        archived_read.add(fid)
                    save_progress()
                    log.info("form %s (%s): submissions can't be exported; skipped, re-checked in %d days",
                             fid, f.get("formType"), NOT_EXPORTABLE_RECHECK_DAYS)
                    continue
                if f["archived"] and e.status == 404:
                    marks[fid] = 0
                    set_sync_state("hubspot_forms", json.dumps(marks, sort_keys=True),
                                   "per-form newest submittedAt (ms)")
                    archived_read.add(fid)
                    cursors.pop(fid, None)
                    save_progress()
                    continue
                if cursors.pop(fid, None) is not None:
                    save_progress()  # the saved cursor may be what failed: start this form over
                log.warning("form %s submissions: %s", fid, e)
                failed.append(e)
                continue
            con.execute("UPDATE hubspot_forms SET submissions_exportable=1 WHERE form_id=?", (fid,))
            con.commit()
            new_total += new
            if not_exportable.pop(fid, None) is not None:
                save_progress()
            if not done:
                if after:
                    cursors[fid] = {"after": after, "newest": newest}
                    save_progress()
                continue
            marks[fid] = newest
            set_sync_state("hubspot_forms", json.dumps(marks, sort_keys=True), "per-form newest submittedAt (ms)")
            changed = cursors.pop(fid, None) is not None
            if f["archived"]:
                archived_read.add(fid)
                changed = True
            if changed:
                save_progress()
    finally:
        con.close()
    pending = sum(1 for fid in forms if _ms(marks.get(fid)) is None and fid not in not_exportable)
    detail = "%d forms (%d archived), %d new submissions" % (
        len(forms), sum(1 for f in forms.values() if f["archived"]), new_total)
    skipped = sum(1 for fid in forms if fid in not_exportable)
    if skipped:
        detail += "; %d forms' submissions can't be exported (skipped)" % skipped
    if first_calls >= FORM_SUBMISSION_MAX_CALLS and pending:
        detail += "; FORM_SUBMISSION_MAX_CALLS reached, %d forms resume next run" % pending
    if failed:
        raise SourceError(HOST, SUBMISSIONS_ROUTE, failed[-1].status,
                          "%s; submissions failed for %d forms" % (detail, len(failed)))
    return detail


def sync_lists(client, log):
    """List catalog every run; each contact list's memberships at most every LIST_MIN_INTERVAL_MIN.

    The catalog is mirrored (a deleted list goes, with its memberships), but
    only from a complete, well-formed answer: a page without a lists array,
    or no lists at all while some are stored, fails the pull and changes
    nothing. Membership pages share LIST_MEMBERSHIP_MAX_CALLS a run. A list
    cut short is staged in hubspot_list_memberships_pending and resumes from
    its paging cursor next run; its stored rows are replaced only once its
    read is complete. Each list is marked refreshed only when its own read
    completed, so a list that failed is retried next run.
    """
    lists = []
    offset = 0
    payload = {}
    for _page in range(100):
        payload = hs_call(client, "POST", client.api_base + "/crm/v3/lists/search", LISTS_ROUTE, body={
            "offset": offset, "count": 500, "query": "", "listIds": [],
            "processingTypes": ["MANUAL", "DYNAMIC", "SNAPSHOT"], "additionalProperties": ["hs_list_size"]})
        if not isinstance(payload.get("lists"), list):
            raise SourceError(HOST, LISTS_ROUTE, 200, "answer has no lists array; stored lists left as they were")
        lists.extend(x for x in payload["lists"] if isinstance(x, dict) and x.get("listId") is not None)
        if not payload.get("hasMore"):
            break
        nxt = payload.get("offset")
        if not isinstance(nxt, int) or nxt <= offset:
            raise SourceError(HOST, LISTS_ROUTE, 200, "hasMore without a later offset; stored lists left as they were")
        offset = nxt
    else:
        raise SourceError(HOST, LISTS_ROUTE, 200, "over 100 pages of lists; stored lists left as they were")
    fetched_at = datetime.now(timezone.utc).isoformat()
    rows = []
    for x in lists:
        size = (x.get("additionalProperties") or {}).get("hs_list_size", x.get("size"))
        try:
            size = int(size)
        except (TypeError, ValueError):
            size = None
        rows.append((str(x["listId"]), truncate_value(str(x.get("name") or "")), x.get("processingType"),
                     x.get("objectTypeId"), size, x.get("createdAt"), x.get("updatedAt"),
                     json.dumps(x, ensure_ascii=False), fetched_at))
    contact_ids = [r[0] for r in rows if r[3] == CONTACT_LIST_TYPE]
    con = db_connect()
    try:
        if not rows:
            stored = con.execute("SELECT COUNT(*) FROM hubspot_lists").fetchone()[0]
            total = payload.get("total")
            if stored or (isinstance(total, int) and total > 0):
                raise SourceError(HOST, LISTS_ROUTE, 200, "no lists in the answer (total %s, %d stored); "
                                  "stored lists left as they were" % (total, stored))
        # The table mirrors HubSpot: a deleted list goes, with its memberships.
        con.execute("DELETE FROM hubspot_lists")
        con.executemany("INSERT INTO hubspot_lists(list_id, name, processing_type, object_type, size, created_at, "
                        "updated_at, raw_json, fetched_at) VALUES(?,?,?,?,?,?,?,?,?)", rows)
        marks = ",".join("?" * len(contact_ids))
        con.execute("DELETE FROM hubspot_list_memberships WHERE list_id NOT IN (%s)" % marks, contact_ids)
        con.execute("DELETE FROM hubspot_list_memberships_pending WHERE list_id NOT IN (%s)" % marks, contact_ids)
        con.commit()
    finally:
        con.close()
    detail = "%d lists (%d contact lists)" % (len(rows), len(contact_ids))

    # sync_state 'hubspot_lists': {"refreshed": {listId: time of its last complete read},
    #                              "resume": {"listId", "after"} for a read cut short}.
    state = _json_state("hubspot_lists")
    refreshed = {k: v for k, v in (state.get("refreshed") or {}).items() if k in contact_ids} \
        if isinstance(state.get("refreshed"), dict) else {}
    resume = state.get("resume") if isinstance(state.get("resume"), dict) else None
    if not (resume and resume.get("listId") in contact_ids and resume.get("after")):
        resume = None
    now = datetime.now(timezone.utc)

    def due(list_id):
        try:
            age_min = (now - datetime.fromisoformat(refreshed[list_id])).total_seconds() / 60.0
        except (KeyError, TypeError, ValueError):
            return True
        return age_min >= LIST_MIN_INTERVAL_MIN

    def save_state():
        set_sync_state("hubspot_lists", json.dumps({"refreshed": refreshed, "resume": resume}, sort_keys=True),
                       "per-list time of the last complete membership read; a read cut short")

    todo = [lid for lid in contact_ids if due(lid) or (resume and resume["listId"] == lid)]
    if resume:
        todo.sort(key=lambda lid: lid != resume["listId"])
    if not todo:
        return detail + "; memberships: none due (LIST_MIN_INTERVAL_MIN=%.0f)" % LIST_MIN_INTERVAL_MIN
    members = done = calls = 0
    out_of_calls = False
    failed = []
    con = db_connect()
    try:
        for list_id in todo:
            after = resume["after"] if resume and resume["listId"] == list_id else None
            if after is None:
                con.execute("DELETE FROM hubspot_list_memberships_pending WHERE list_id=?", (list_id,))
                con.commit()
            finished = False
            seen = set()
            try:
                while True:
                    if calls >= LIST_MEMBERSHIP_MAX_CALLS:
                        out_of_calls = True
                        break
                    url = client.api_base + "/crm/v3/lists/%s/memberships?limit=250" % _query_value(list_id)
                    page = hs_call(client, "GET", url + ("&after=" + _query_value(after) if after else ""),
                                   MEMBERSHIPS_ROUTE)
                    calls += 1
                    got = []
                    for m in page.get("results") or []:
                        if isinstance(m, dict):
                            got.append((list_id, str(m.get("recordId")), m.get("membershipTimestamp")))
                        elif m is not None:
                            got.append((list_id, str(m), None))
                    con.executemany("INSERT OR REPLACE INTO hubspot_list_memberships_pending(list_id, record_id, "
                                    "added_at) VALUES(?,?,?)", got)
                    con.commit()
                    nxt = _next_after(page)
                    if not nxt or nxt in seen:
                        finished = True
                        break
                    seen.add(nxt)
                    after = nxt
            except SourceRefused:
                raise
            except SourceError as e:
                con.rollback()
                # Start this list over next run: the saved cursor may be what failed.
                con.execute("DELETE FROM hubspot_list_memberships_pending WHERE list_id=?", (list_id,))
                con.commit()
                if resume and resume["listId"] == list_id:
                    resume = None
                    save_state()
                log.warning("list %s memberships: %s", list_id, e)
                failed.append(e)
                continue
            if not finished:
                if after:
                    resume = {"listId": list_id, "after": after}
                    save_state()
                break
            con.execute("DELETE FROM hubspot_list_memberships WHERE list_id=?", (list_id,))
            n = con.execute("INSERT INTO hubspot_list_memberships(list_id, record_id, added_at) SELECT list_id, "
                            "record_id, added_at FROM hubspot_list_memberships_pending WHERE list_id=?",
                            (list_id,)).rowcount
            con.execute("DELETE FROM hubspot_list_memberships_pending WHERE list_id=?", (list_id,))
            con.commit()
            members += n
            done += 1
            refreshed[list_id] = datetime.now(timezone.utc).isoformat()
            if resume and resume["listId"] == list_id:
                resume = None
            save_state()
    finally:
        con.close()
    detail += "; memberships refreshed for %d lists: %d rows" % (done, members)
    if out_of_calls:
        detail += "; LIST_MEMBERSHIP_MAX_CALLS reached, %d lists resume next run" % (len(todo) - done - len(failed))
    if failed:
        raise SourceError(HOST, MEMBERSHIPS_ROUTE, failed[-1].status,
                          "%s; memberships failed for %d lists (retried next run)" % (detail, len(failed)))
    return detail


def sync_imports(client, log):
    def url_for(after):
        return client.api_base + "/crm/v3/imports?limit=100" + ("&after=" + _query_value(after) if after else "")
    rows = []
    fetched_at = datetime.now(timezone.utc).isoformat()
    for page in hs_pages(client, url_for, IMPORTS_ROUTE, max_pages=100):
        for imp in page.get("results") or []:
            if isinstance(imp, dict) and imp.get("id") is not None:
                rows.append((str(imp["id"]), truncate_value(str(imp.get("importName") or "")), imp.get("state"),
                             imp.get("createdAt"), json.dumps(imp, ensure_ascii=False), fetched_at))
    con = db_connect()
    try:
        con.executemany(
            "INSERT INTO hubspot_imports(import_id, name, state, created_at, raw_json, fetched_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(import_id) DO UPDATE SET name=excluded.name, state=excluded.state, "
            "created_at=excluded.created_at, raw_json=excluded.raw_json, fetched_at=excluded.fetched_at", rows)
        con.commit()
    finally:
        con.close()
    return "%d imports" % len(rows)


def backfill_objects(client, otype, props, log):
    """Re-read every object's properties once (HUBSPOT_CONTACT_BACKFILL=1, HUBSPOT_MEETING_BACKFILL=1).

    Keyset paging: each search asks for hs_object_id > the last id stored, so
    the 10,000-result cap of one search does not apply. sync_state
    'hubspot_<type>_backfill' holds that id after every page, so a run that
    stops resumes there. A run reads at most HUBSPOT_BACKFILL_MAX_PAGES pages
    (default 150) and the next run carries on. When done it says so and later
    runs skip it.
    =restart starts over once: the value is recorded as restartKey, so
    leaving it set resumes instead of restarting every run. Another value
    starting with "restart" (restart:2, say) starts over again. Properties
    are merged into the stored ones; associations and the watermark are
    untouched.
    """
    kind = BACKFILLS[otype]
    source, env = "hubspot_%s_backfill" % kind, "HUBSPOT_%s_BACKFILL" % kind.upper()
    route = "POST /crm/v3/objects/%s/search" % otype
    state = _json_state(source)
    mode = os.environ.get(env, "").strip().lower()
    if mode.startswith("restart") and state.get("restartKey") != mode:
        log.info("%s backfill: starting over (%s=%s)", kind, env, mode)
        state = {"restartKey": mode}
    if state.get("done"):
        return "already complete (%s %s, %s); a new %s=restart value runs it again" % (
            state.get("count"), otype, state.get("finishedAt"), env)
    after_id = int(state.get("afterId") or 0)
    count = int(state.get("count") or 0)
    state.setdefault("startedAt", datetime.now(timezone.utc).isoformat())
    con = db_connect()
    pages = 0
    try:
        while True:
            pages += 1
            payload = hs_call(client, "POST", client.api_base + "/crm/v3/objects/%s/search" % otype,
                              route, search=True, body={
                                  "filterGroups": [{"filters": [{"propertyName": "hs_object_id", "operator": "GT",
                                                                 "value": str(after_id)}]}],
                                  "sorts": [{"propertyName": "hs_object_id", "direction": "ASCENDING"}],
                                  "properties": props, "limit": BACKFILL_PAGE})
            results = payload.get("results") or []
            fetched_at = datetime.now(timezone.utc).isoformat()
            last_id = after_id
            for obj in results:
                try:
                    hs_id = int(obj.get("id"))
                except (TypeError, ValueError):
                    continue
                last_id = max(last_id, hs_id)
                row = con.execute("SELECT properties_json FROM hubspot_objects WHERE object_type=? AND hs_id=?",
                                  (otype, str(hs_id))).fetchone()
                try:
                    merged = json.loads(row[0]) if row and row[0] else {}
                except ValueError:
                    merged = {}
                merged.update(truncate_props(obj.get("properties") or {}))
                if otype == "meetings":
                    for k in MEETING_PROPS_DROPPED:
                        merged.pop(k, None)
                con.execute(
                    "INSERT INTO hubspot_objects(object_type, hs_id, properties_json, fetched_at) VALUES(?,?,?,?) "
                    "ON CONFLICT(object_type, hs_id) DO UPDATE SET properties_json=excluded.properties_json, "
                    "fetched_at=excluded.fetched_at",
                    (otype, str(hs_id), json.dumps(merged, ensure_ascii=False), fetched_at))
            con.commit()
            count += len(results)
            more = bool(_next_after(payload)) and last_id > after_id
            after_id = last_id
            state.update(afterId=str(after_id), count=count)
            if not more:
                state.update(done=True, finishedAt=fetched_at)
            set_sync_state(source, json.dumps(state, sort_keys=True), "done" if not more else "in progress")
            if not more:
                break
            if pages >= BACKFILL_MAX_PAGES:
                return "%d %s re-read so far with %d properties; HUBSPOT_BACKFILL_MAX_PAGES reached, " \
                       "resuming next run" % (count, otype, len(props))
            if pages % 25 == 0:
                log.info("%s backfill: %d %s so far", kind, count, otype)
    finally:
        con.close()
    return "%d %s re-read with %d properties" % (count, otype, len(props))


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
    try:
        for ddl in EXTRA_TABLES:
            con.execute(ddl)
        # hubspot_forms written before this column existed.
        if "submissions_exportable" not in {r[1] for r in con.execute("PRAGMA table_info(hubspot_forms)")}:
            con.execute("ALTER TABLE hubspot_forms ADD COLUMN submissions_exportable INTEGER")
        con.commit()
    finally:
        con.close()
    props_by_type = {otype: props for otype, (_modfield, props) in OBJECT_TYPES.items()}
    for otype, discover in (("contacts", discover_contact_props), ("meetings", discover_meeting_props)):
        props_by_type[otype] = props_by_type[otype] + [
            p for p in discover(client, log) if p not in props_by_type[otype]]

    con = db_connect()
    fetched_at = datetime.now(timezone.utc).isoformat()
    total_upserted = 0
    total_assoc = 0
    changed_deals = []
    try:
        for otype, (modfield, _props) in OBJECT_TYPES.items():
            props = props_by_type[otype]
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

    parts = [
        ("hubspot_forms", lambda: sync_forms(client, log)),
        ("hubspot_lists", lambda: sync_lists(client, log)),
        ("hubspot_imports", lambda: sync_imports(client, log)),
    ]
    for otype, kind in BACKFILLS.items():
        backfill = os.environ.get("HUBSPOT_%s_BACKFILL" % kind.upper(), "").strip().lower()
        if backfill in ("1", "true", "yes") or backfill.startswith("restart"):
            parts.append(("hubspot_%s_backfill" % kind,
                          lambda otype=otype: backfill_objects(client, otype, props_by_type[otype], log)))
    failed = [name for name, fn in parts if not run_part(name, fn, log)]
    return note + ("; failed: " + ", ".join(failed) if failed else "")


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
