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

Two extra pulls follow the campaigns. Each records its own sync_outcomes row,
and a failure in one does not fail the sync or stop the other:
  lemlist_activities  GET /api/activities?version=v2 for ACTIVITY_TYPES, all
                      campaigns at once, in minDate/maxDate windows paged by
                      offset. sync_state 'lemlist_activities' holds the end of
                      the last complete window per type. A run stops after
                      LEMLIST_ACTIVITY_MAX_CALLS (default 300); a window it cut
                      short is kept in 'lemlist_activities_resume' with its
                      offset, and the next run carries on from there. Later
                      runs re-read the last hour.
  lemlist_leads       one row per lead per campaign from the v2 leads export
                      (JSON), or the paged campaign leads route when the export
                      is refused, at most every LEMLIST_LEADS_MIN_INTERVAL_MIN
                      (default 360) per campaign. contacted/opened/clicked/
                      replied/meeting times are the first matching activity and
                      are updated every run. raw_json keeps the export row;
                      reply activities keep their full raw_json so later code
                      can tell auto-replies.
"""

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import quote
from datetime import datetime, timedelta, timezone

from common import (
    NeedsConnection,
    RateLimiter,
    SourceError,
    SourceRefused,
    access_token_for,
    db_connect,
    get_sync_state,
    run_main,
    run_part,
    set_sync_state,
    truncate_value,
    url_with_access_token,
    now_iso,
)

SOURCE = "lemlist"
HOST = "api.lemlist.com"
# lemlist allows 20 requests per 2 seconds per key.
pace = RateLimiter(0.5)
RETRY_429 = (2, 4, 8, 16)
LEADS_ROUTE = "GET /api/v2/campaigns/{campaignId}/export/leads"
LEADS_PAGED_ROUTE = "GET /api/campaigns/{campaignId}/leads"
ACTIVITIES_ROUTE = "GET /api/activities"
# Replies and meetings first: when a first pull runs out of calls, they are
# the types the dashboard needs most.
REPLY_TYPES = ("emailsReplied", "linkedinReplied")
ACTIVITY_TYPES = REPLY_TYPES + ("meetingBooked", "emailsSent", "emailsClicked", "emailsOpened")
ACTIVITY_PAGE = 100  # API maximum
ACTIVITY_WINDOW = timedelta(days=30)
ACTIVITY_OVERLAP = timedelta(hours=1)
ACTIVITY_MAX_CALLS = int(os.environ.get("LEMLIST_ACTIVITY_MAX_CALLS") or 300)
# A campaign's leads are exported again at most this often (0: every run).
LEADS_MIN_INTERVAL_MIN = float(os.environ.get("LEMLIST_LEADS_MIN_INTERVAL_MIN") or 360)
LEAD_TIMES = (("contacted_at", ("emailsSent",)), ("opened_at", ("emailsOpened",)),
              ("clicked_at", ("emailsClicked",)), ("replied_at", REPLY_TYPES),
              ("meeting_booked_at", ("meetingBooked",)))


def _authed_url(path: str) -> str:
    """Return the URL with the API key as ?access_token=. Do not log it."""
    return url_with_access_token(
        f"https://{HOST}{path}",
        ("custom.lemlist", "lemlist"),
        [HOST],
    )


def _fetch(req):
    """(status, parsed JSON or text). A 429 is retried after Retry-After or a back-off."""
    for delay in RETRY_429 + (None,):
        pace.wait()
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                status, text = resp.status, resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 429 and delay is not None:
                after = str(e.headers.get("Retry-After") or "")
                time.sleep(min(int(after), 30) if after.isdigit() else delay)
                continue
            return e.code, e.read().decode("utf-8", errors="replace")
        try:
            return status, json.loads(text or "{}")
        except ValueError:
            return status, text


def _get(path: str):
    status, payload = _fetch(urllib.request.Request(_authed_url(path), headers={"Accept": "application/json"}))
    if status in (401, 403):
        raise SourceRefused(HOST, "GET " + urllib.parse.urlparse("https://" + HOST + path).path, status,
                            "credential rejected")
    return status, payload


def _get_basic(path: str):
    """Basic auth, empty login, API key as the password. Do not log the header."""
    token = access_token_for(("custom.lemlist", "lemlist"), None)
    auth = base64.b64encode((":" + token).encode("utf-8")).decode("ascii")
    return _fetch(urllib.request.Request(f"https://{HOST}{path}",
                                         headers={"Accept": "application/json", "Authorization": "Basic " + auth}))


# Auth style tried first by _get_any_auth; the one that works moves to the front.
_AUTH_ORDER = ["basic", "query"]


def _get_any_auth(path, route, want=dict):
    """GET with Basic auth, then ?access_token= (or the reverse once that worked).

    Returns (status, payload, attempts). Attempts hold the route template and
    HTTP status only.
    """
    attempts = []
    status, payload = None, None
    for how in list(_AUTH_ORDER):
        try:
            if how == "basic":
                status, payload = _get_basic(path)
            else:
                status, payload = _fetch(urllib.request.Request(_authed_url(path), headers={"Accept": "application/json"}))
        except NeedsConnection:
            raise
        except Exception as e:
            attempts.append({"route": route, "auth": how, "error": type(e).__name__})
            continue
        attempts.append({"route": route, "auth": how, "http": status})
        if status == 200 and isinstance(payload, want):
            if _AUTH_ORDER[0] != how:
                _AUTH_ORDER.reverse()
            return status, payload, attempts
        if status not in (401, 403):
            break  # the other auth style will not change a 404 or a 500
    return status, payload, attempts


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


def _items(payload):
    """Rows from a list response, or from a {data|leads|activities: [...]} wrapper."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "leads", "activities", "results"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return None


def _raise_for(route, status, payload):
    if status in (401, 403):
        raise SourceRefused(HOST, route, status, "credential rejected")
    raise SourceError(HOST, route, status, str(payload)[:200])


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _parse(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _load_state(source):
    raw, _run, _note = get_sync_state(source)
    try:
        state = json.loads(raw) if raw else {}
    except ValueError:
        state = {}
    return state if isinstance(state, dict) else {}


def sync_activities(campaigns, log):
    """Activities of ACTIVITY_TYPES across all campaigns, windowed by date (see module doc)."""
    state = _load_state("lemlist_activities")
    # A window cut short by the call budget: {type: {start, end, offset}}. The
    # next run re-reads that same window from the offset, so a window holding
    # more rows than one run's budget still advances.
    resume = _load_state("lemlist_activities_resume")
    now = datetime.now(timezone.utc)
    starts = [t for t in (_parse(c.get("createdAt")) for c in campaigns) if t]
    earliest = min(starts) if starts else now - timedelta(days=365)
    calls = stored = 0
    out_of_calls = False
    con = db_connect()
    try:
        con.execute("CREATE TABLE IF NOT EXISTS lemlist_activities(activity_id TEXT PRIMARY KEY, campaign_id TEXT, "
                    "lead_id TEXT, lead_email TEXT, type TEXT, created_at TEXT, is_first INTEGER, bot INTEGER, "
                    "raw_json TEXT, fetched_at TEXT)")
        con.execute("CREATE INDEX IF NOT EXISTS lemlist_activities_lead ON lemlist_activities"
                    "(campaign_id, lead_id, type, created_at)")
        for typ in ACTIVITY_TYPES:
            if out_of_calls:
                break
            mark = _parse(state.get(typ))
            start = mark - ACTIVITY_OVERLAP if mark else earliest
            part = resume.get(typ) if isinstance(resume.get(typ), dict) else {}
            part_start, part_end = _parse(part.get("start")), _parse(part.get("end"))
            if not (part_start and part_end and part_start < part_end <= now and isinstance(part.get("offset"), int)):
                part = {}
            if part:
                start = part_start
            while start < now and not out_of_calls:
                end = part_end if part else min(start + ACTIVITY_WINDOW, now)
                offset = part.get("offset", 0) if part else 0
                part = {}
                fetched_at = now_iso()
                while True:
                    if calls >= ACTIVITY_MAX_CALLS:
                        out_of_calls = True
                        break
                    q = urllib.parse.urlencode({"version": "v2", "type": typ, "minDate": _iso(start),
                                                "maxDate": _iso(end), "limit": ACTIVITY_PAGE, "offset": offset})
                    status, payload, attempts = _get_any_auth("/api/activities?" + q, ACTIVITIES_ROUTE, want=(list, dict))
                    calls += len(attempts)
                    rows = _items(payload) if status == 200 else None
                    if rows is None:
                        _raise_for(ACTIVITIES_ROUTE, status, payload)
                    for a in rows:
                        aid = (a.get("_id") or a.get("id")) if isinstance(a, dict) else None
                        if not aid:
                            continue
                        raw = {k: truncate_value(v) for k, v in a.items()
                               if typ in REPLY_TYPES or k != "lead"}  # the lead is in lemlist_leads
                        con.execute(
                            "INSERT INTO lemlist_activities(activity_id, campaign_id, lead_id, lead_email, type, "
                            "created_at, is_first, bot, raw_json, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?) "
                            "ON CONFLICT(activity_id) DO UPDATE SET raw_json=excluded.raw_json, "
                            "fetched_at=excluded.fetched_at",
                            (str(aid), a.get("campaignId"), a.get("leadId"), a.get("leadEmail"), a.get("type") or typ,
                             a.get("createdAt"), None if a.get("isFirst") is None else int(bool(a.get("isFirst"))),
                             None if a.get("bot") is None else int(bool(a.get("bot"))),
                             json.dumps(raw, ensure_ascii=False), fetched_at))
                        stored += 1
                    if len(rows) < ACTIVITY_PAGE:
                        break
                    offset += len(rows)
                con.commit()
                if out_of_calls:
                    if offset:
                        resume[typ] = {"start": _iso(start), "end": _iso(end), "offset": offset}
                        set_sync_state("lemlist_activities_resume", json.dumps(resume, sort_keys=True),
                                       "per-type window cut short by LEMLIST_ACTIVITY_MAX_CALLS, and its offset")
                    break
                state[typ] = _iso(end)
                set_sync_state("lemlist_activities", json.dumps(state, sort_keys=True), "per-type end of last window")
                if resume.pop(typ, None) is not None:
                    set_sync_state("lemlist_activities_resume", json.dumps(resume, sort_keys=True),
                                   "per-type window cut short by LEMLIST_ACTIVITY_MAX_CALLS, and its offset")
                start = end
    finally:
        con.close()
    pending = [t for t in ACTIVITY_TYPES if t in resume or not _parse(state.get(t))
               or _parse(state[t]) < now - ACTIVITY_WINDOW]
    detail = "%d activities stored in %d calls" % (stored, calls)
    if out_of_calls:
        detail += "; LEMLIST_ACTIVITY_MAX_CALLS reached, resuming next run"
        if pending:
            detail += " (%s behind)" % ", ".join(pending)
    return detail


def _campaign_leads(cid):
    """Leads of one campaign: the v2 JSON export, else the paged leads route."""
    status, payload, _attempts = _get_any_auth(
        f"/api/v2/campaigns/{quote(str(cid))}/export/leads?state=all&format=json", LEADS_ROUTE, want=list)
    if status == 200 and isinstance(payload, list):
        return payload
    leads = []
    offset, cursor = 0, None
    for _page in range(500):
        q = {"state": "all", "limit": 100, "offset": offset}
        if cursor:
            q = {"state": "all", "limit": 100, "cursor": cursor}
        status, payload, _attempts = _get_any_auth(
            f"/api/campaigns/{quote(str(cid))}/leads/?" + urllib.parse.urlencode(q), LEADS_PAGED_ROUTE, want=(list, dict))
        rows = _items(payload) if status == 200 else None
        if rows is None:
            _raise_for(LEADS_PAGED_ROUTE, status, payload)
        leads.extend(rows)
        nxt = (payload.get("next") or payload.get("nextCursor")) if isinstance(payload, dict) else None
        if nxt and nxt != cursor:
            cursor = nxt
        elif isinstance(payload, list) and len(rows) == 100:
            offset += len(rows)
        else:
            break
    return leads


def sync_leads(campaigns, log):
    """Replace each due campaign's leads, then set the first-activity times (see module doc)."""
    fetched_at = now_iso()
    now = datetime.now(timezone.utc)
    # Per campaign, when its leads were last replaced in full.
    refreshed = _load_state("lemlist_leads")
    total = 0
    done = fresh = 0
    failed = []
    con = db_connect()
    try:
        con.execute("CREATE TABLE IF NOT EXISTS lemlist_leads(campaign_id TEXT, lead_id TEXT, email TEXT, "
                    "company_domain TEXT, state TEXT, status TEXT, email_status TEXT, contacted_at TEXT, "
                    "replied_at TEXT, opened_at TEXT, clicked_at TEXT, meeting_booked_at TEXT, raw_json TEXT, "
                    "fetched_at TEXT, PRIMARY KEY(campaign_id, lead_id))")
        for c in campaigns:
            cid = str(c.get("_id") or c.get("id") or "")
            if not cid:
                continue
            last = _parse(refreshed.get(cid))
            if last and (now - last).total_seconds() < LEADS_MIN_INTERVAL_MIN * 60:
                fresh += 1
                continue
            try:
                leads = _campaign_leads(cid)
            except NeedsConnection:
                raise
            except SourceError as e:
                log.warning("campaign %s leads: %s", cid, e)
                failed.append(e)
                continue
            rows = {}
            for lead in leads:
                if not isinstance(lead, dict):
                    continue
                email = lead.get("email")
                lead_id = lead.get("_id") or lead.get("leadId") or lead.get("id") or (
                    "email:" + str(email).lower() if email else None)
                if not lead_id:
                    continue
                rows[str(lead_id)] = (cid, str(lead_id), email, lead.get("companyDomain"),
                                      lead.get("lastState") or lead.get("state"), lead.get("status"),
                                      lead.get("emailStatus"),
                                      json.dumps({k: truncate_value(v) for k, v in lead.items()}, ensure_ascii=False),
                                      fetched_at)
            con.execute("DELETE FROM lemlist_leads WHERE campaign_id=?", (cid,))
            con.executemany("INSERT INTO lemlist_leads(campaign_id, lead_id, email, company_domain, state, status, "
                            "email_status, raw_json, fetched_at) VALUES(?,?,?,?,?,?,?,?,?)", list(rows.values()))
            con.commit()
            total += len(rows)
            done += 1
            refreshed[cid] = _iso(now)
            set_sync_state("lemlist_leads", json.dumps(refreshed, sort_keys=True),
                           "per-campaign time of the last full leads refresh")
        have = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "lemlist_activities" in have:
            sets = ", ".join(
                "%s=(SELECT MIN(a.created_at) FROM lemlist_activities a WHERE a.campaign_id=lemlist_leads.campaign_id "
                "AND a.lead_id=lemlist_leads.lead_id AND a.type IN (%s))" % (col, ",".join("'%s'" % t for t in types))
                for col, types in LEAD_TIMES)
            con.execute("UPDATE lemlist_leads SET " + sets)
            con.commit()
    finally:
        con.close()
    detail = "%d leads across %d campaigns" % (total, done)
    if fresh:
        detail += "; %d campaigns skipped, refreshed within LEMLIST_LEADS_MIN_INTERVAL_MIN (%.0f min)" % (
            fresh, LEADS_MIN_INTERVAL_MIN)
    if failed:
        raise SourceError(HOST, failed[-1].route, failed[-1].status,
                          "%s; leads failed for %d campaigns" % (detail, len(failed)))
    return detail


def main_sync(log):
    status, payload = _get("/api/campaigns")
    if status != 200 or not isinstance(payload, list):
        raise SourceError(HOST, "GET /api/campaigns", status, str(payload)[:200])

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

    campaigns = [c for c in payload if isinstance(c, dict)]
    # Activities first, so the lead times below include this run's activities.
    failed = [name for name, fn in (("lemlist_activities", lambda: sync_activities(campaigns, log)),
                                    ("lemlist_leads", lambda: sync_leads(campaigns, log)))
              if not run_part(name, fn, log)]
    return note + ("; failed: " + ", ".join(failed) if failed else "")


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
