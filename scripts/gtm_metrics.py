"""Shared GTM headline metrics.

The browser copy lives in workspace-model.cjs. Keep the rules aligned:
open-pipeline exclusions, Phoenix calendar dates, quiet days, unworked leads,
and commit-versus-forecast wording. Callers describe these numbers; they do
not compute a second one.
"""
import math
import re
from datetime import date, datetime, timezone


QUIET_DAYS = 14
PHOENIX = "America/Phoenix"


def date_only(value):
    """YYYY-MM-DD. Date-only strings are kept. Timestamps use Phoenix."""
    if value is None or value == "":
        return None
    raw = str(value).strip()
    if len(raw) >= 10 and raw[4:5] == "-" and raw[7:8] == "-" and (len(raw) == 10 or raw[10] not in "T "):
        # date-only
        try:
            date.fromisoformat(raw[:10])
            if len(raw) == 10:
                return raw[:10]
        except ValueError:
            return None
    if len(raw) == 10:
        try:
            date.fromisoformat(raw)
            return raw
        except ValueError:
            return None
    # Timestamp: convert to Phoenix (MST, UTC-7, no DST).
    try:
        if raw.endswith("Z"):
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        elif len(raw) == 16:
            dt = datetime.fromisoformat(raw + ":00+00:00")
        else:
            dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        phx = dt.astimezone(timezone.utc).timestamp() - 7 * 3600
        return datetime.fromtimestamp(phx, timezone.utc).date().isoformat()
    except Exception:
        return raw[:10] if len(raw) >= 10 and raw[4:5] == "-" else None


def phoenix_today(now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    phx = now.timestamp() - 7 * 3600
    return datetime.fromtimestamp(phx, timezone.utc).date().isoformat()


def days_between(start, end):
    try:
        return (date.fromisoformat(end) - date.fromisoformat(start)).days
    except Exception:
        return None


def _push(dates, value, today):
    d = date_only(value)
    if d and d <= today:
        dates.append(d)


def last_engagement(company, today=None):
    if not company:
        return None
    today = today or phoenix_today()
    dates = []
    for it in company.get("completedInteractions") or []:
        _push(dates, it.get("date"), today)
    for n in company.get("notes") or []:
        _push(dates, n.get("date"), today)
    for c in company.get("calls") or []:
        _push(dates, c.get("date"), today)
    for m in company.get("meetings") or []:
        _push(dates, m.get("start"), today)
    for r in company.get("recordings") or []:
        _push(dates, r.get("date"), today)
    emails = company.get("emails") or {}
    for e in emails.get("items") or []:
        _push(dates, e.get("date"), today)
    _push(dates, company.get("lastContact"), today)
    return max(dates) if dates else None


def days_quiet(company, today=None):
    today = today or phoenix_today()
    if isinstance(company, str):
        last = date_only(company)
    else:
        last = last_engagement(company, today)
    if not last or last > today:
        return None
    return days_between(last, today)


def probability_fraction(value):
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n < 0:
        return None
    return min(n, 100) / 100 if n > 1 else n


def is_test_record(deal):
    blob = " ".join(str((deal or {}).get(k) or "") for k in ("name", "dealName", "company", "title", "rationale"))
    low = blob.lower()
    return "mozilla firefox" in low or "system verification test" in low


def _stage_blob(deal):
    stage = str((deal or {}).get("stage") or (deal or {}).get("stageLabel") or "")
    deal_name = str((deal or {}).get("dealName") or "")
    return (stage + " " + deal_name).lower()


def is_open_pipeline(deal, today):
    """Same exclusions as workspace-model.cjs isOpenPipeline."""
    if not deal or deal.get("closed") is True:
        return False
    if is_test_record(deal):
        return False
    blob = _stage_blob(deal)
    if re.search(r"closed\s*won|closed\s*lost|closedwon|closedlost", blob):
        return False
    if "disqualif" in blob:
        return False
    if re.search(r"\bon hold\b", blob):
        return False
    if "current agreement" in blob:
        return False
    if re.search(r"\brenewal\b", blob):
        return False
    close = date_only(deal.get("close"))
    if close and today and close < today:
        return False
    return True


def exclusion_reason(deal, today):
    """Why a deal is outside the open book. None when it is in the book."""
    if is_open_pipeline(deal, today):
        return None
    if (deal or {}).get("closed") is True:
        return "closed"
    if is_test_record(deal):
        return "verification fixture"
    blob = _stage_blob(deal)
    if re.search(r"closed\s*won|closed\s*lost|closedwon|closedlost", blob):
        return "closed won or lost"
    if "disqualif" in blob:
        return "Disqualified"
    if re.search(r"\bon hold\b", blob):
        return "On Hold"
    if "current agreement" in blob:
        return "current agreement"
    if re.search(r"\brenewal\b", blob):
        return "renewal"
    close = date_only(deal.get("close"))
    if close and today and close < today:
        return "past close date"
    return "excluded"


def stage_display(stage):
    s = str(stage or "").strip()
    if s.endswith(" (Deal)"):
        s = s[: -len(" (Deal)")].strip()
    return s or "No stage"


def unworked_count(leads, sheet_review=None):
    lt = (sheet_review or {}).get("leadTracker") or {}
    if isinstance(lt.get("unworked"), (int, float)) and isinstance(lt.get("total"), (int, float)) and lt.get("total", 0) > 0:
        return int(lt["unworked"])
    return sum(1 for l in (leads or []) if not date_only(l.get("mql")))


def commit_versus_target(commit, target):
    try:
        c = float(commit)
    except (TypeError, ValueError):
        return {"relation": "unknown", "text": None}

    def money(n):
        return "$%s" % f"{round(n):,}"

    try:
        t = float(target)
    except (TypeError, ValueError):
        t = 0
    if t <= 0:
        return {"relation": "unknown", "text": "%s commit · no forecast target connected" % money(c)}
    if c > t:
        return {"relation": "ahead", "gap": c - t,
                "text": "%s commit is ahead of the %s forecast by %s" % (money(c), money(t), money(c - t))}
    if c == t:
        return {"relation": "met", "gap": 0,
                "text": "%s commit meets the %s forecast" % (money(c), money(t))}
    return {"relation": "short", "gap": t - c,
            "text": "%s commit is short of the %s forecast by %s" % (money(c), money(t), money(t - c))}


def greeting(now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    hour = datetime.fromtimestamp(now.timestamp() - 7 * 3600, timezone.utc).hour
    if hour < 12:
        return "Good morning"
    if hour < 17:
        return "Good afternoon"
    return "Good evening"


def round_half_up(value):
    return int(math.floor(float(value) + 0.5))


def company_name(value):
    return re.sub(r"[,;]+$", "", str(value or "").strip()).strip()


def owner_info(value, tail=4):
    digits_wanted = max(4, int(tail or 4))
    s = str(value or "").strip()
    if not s or re.fullmatch(r"unassigned", s, flags=re.I):
        return {"label": "Unassigned", "title": "", "key": "Unassigned", "named": True}
    stripped = re.sub(r"^(?:owner\s+)+", "", s, count=1, flags=re.I).strip()
    # JS strips a repeated "owner " prefix. Repeat until it is gone.
    while True:
        nxt = re.sub(r"^(?:owner\s+)+", "", stripped, count=1, flags=re.I).strip()
        if nxt == stripped:
            break
        stripped = nxt
    if not stripped:
        return {"label": "Unassigned", "title": "", "key": "Unassigned", "named": True}
    if re.fullmatch(r"owner name not connected", stripped, flags=re.I):
        return {"label": "Owner name not connected", "title": "Owner name isn't connected", "key": "Owner name not connected", "named": False}
    if re.fullmatch(r"\d+", stripped) or re.fullmatch(r"[a-f0-9-]{8,}", stripped, flags=re.I):
        digits = re.sub(r"\D", "", stripped) or stripped
        n = min(digits_wanted, len(digits))
        return {"label": "Owner #\u2026" + digits[-n:], "title": "Owner name isn't connected", "key": stripped, "named": False}
    return {"label": stripped, "title": "", "key": stripped, "named": True}


def resolve_owners(values):
    raws = list(dict.fromkeys("" if v is None else str(v) for v in (values or [])))
    tail = 4

    def build(n):
        return {v: owner_info(v, n) for v in raws}

    mapping = build(tail)
    while tail < 32:
        seen = {}
        clash = False
        for info in mapping.values():
            if info["named"]:
                continue
            prev = seen.get(info["label"])
            if prev and prev != info["key"]:
                clash = True
                break
            seen[info["label"]] = info["key"]
        if not clash:
            return mapping
        tail += 2
        mapping = build(tail)
    return mapping


def display_owner(value, resolved=None):
    key = "" if value is None else str(value)
    if resolved and key in resolved:
        return resolved[key]["label"]
    return owner_info(value)["label"]


def company_for_opportunity(opportunity, records):
    if not opportunity:
        return None
    companies = (records or {}).get("companies") or []
    oid = opportunity.get("id")
    holders = [c for c in companies if any(d and d.get("id") == oid for d in (c.get("deals") or []))]
    named = next((c for c in holders if c.get("name") == opportunity.get("name")), None)
    if named:
        return named
    if len(holders) == 1:
        return holders[0]
    cid = str(opportunity.get("companyId") or "")
    if cid.startswith("company:"):
        cid = cid[len("company:"):]
    found = next((c for c in companies if c.get("id") == cid), None)
    if found:
        return found
    if holders:
        return holders[0]
    return next((c for c in companies if c.get("name") == opportunity.get("name")), None)


def annotate_opportunities(opportunities, records):
    by_id = {}
    for company in (records or {}).get("companies") or []:
        for deal in company.get("deals") or []:
            if deal and deal.get("id"):
                by_id[deal["id"]] = deal
    positive = []
    for opp in opportunities or []:
        try:
            n = float(opp.get("probability"))
        except (TypeError, ValueError):
            continue
        if n > 0:
            positive.append(n)
    undo = bool(positive) and max(positive) <= 0.02
    out = []
    for opp in opportunities or []:
        nxt = dict(opp)
        deal = by_id.get(opp.get("id"))
        if deal and not opp.get("dealName"):
            nxt["dealName"] = deal.get("name") or ""
        if undo and opp.get("probability") not in (None, ""):
            try:
                nxt["probability"] = float(opp.get("probability")) * 100
            except (TypeError, ValueError):
                pass
        out.append(nxt)
    return out


def weighted_amount(row):
    fraction = probability_fraction((row or {}).get("probability"))
    amount = (row or {}).get("amount")
    if amount is None or fraction is None:
        return None
    try:
        return float(amount) * fraction
    except (TypeError, ValueError):
        return None


def quarter_bounds(today):
    year, month, _day = str(today).split("-")
    qm = (int(month) - 1) // 3 * 3 + 1
    return "%s-%02d-01" % (year, qm), today


def in_range(value, start, end):
    day = date_only(value)
    return bool(day) and start <= day <= end


def activity_from_records(records):
    meetings, recordings = [], []
    seen_meetings, seen_recordings = set(), set()

    def cid(company_id):
        return "null" if company_id is None else str(company_id)

    def add_meeting(meeting, company_id):
        mid = meeting.get("id") or "%s|%s|%s" % (cid(company_id), meeting.get("start") or "", meeting.get("title") or "")
        if mid in seen_meetings:
            return
        seen_meetings.add(mid)
        meetings.append({
            "start": meeting.get("start"),
            "booked": meeting.get("booked") or meeting.get("created") or meeting.get("start"),
            "outcome": meeting.get("outcome") or "",
            "companyId": company_id,
        })

    def add_recording(recording, company_id):
        rid = recording.get("id") or "%s|%s" % (cid(company_id), recording.get("date") or "")
        if rid in seen_recordings:
            return
        seen_recordings.add(rid)
        recordings.append({"date": recording.get("date"), "companyId": company_id})

    for company in (records or {}).get("companies") or []:
        for meeting in company.get("meetings") or []:
            add_meeting(meeting, company.get("id"))
        for recording in company.get("recordings") or []:
            add_recording(recording, company.get("id"))
    for recording in (records or {}).get("unmatchedRecordings") or []:
        add_recording(recording, None)
    return meetings, recordings


def funnel(leads, records, start, end):
    lead_count = sum(1 for lead in (leads or []) if in_range(lead.get("lead"), start, end))
    meetings, recordings = activity_from_records(records)
    booked = [m for m in meetings if in_range(m.get("booked") or m.get("start"), start, end)]
    held = set()
    for recording in recordings:
        day = date_only(recording.get("date"))
        if day and in_range(day, start, end):
            held.add("%s|%s" % (recording.get("companyId") or "", day))
    for meeting in meetings:
        day = date_only(meeting.get("start"))
        if not day or not in_range(day, start, end):
            continue
        if re.search(r"complete|held|completed", meeting.get("outcome") or "", flags=re.I):
            held.add("%s|%s|crm" % (meeting.get("companyId") or "", day))
    sql_keys = set()
    for key in held:
        company, day = key.split("|", 2)[:2]
        sql_keys.add("%s|%s" % (company, day))
    return {"leads": lead_count, "mql": len(booked), "sql": len(sql_keys)}


def pipeline_totals(opportunities, today):
    deals = [o for o in (opportunities or []) if is_open_pipeline(o, today)]
    open_amount = 0.0
    weighted_sum = 0.0
    weighted_known = False
    for opp in deals:
        try:
            amt = float(opp.get("amount"))
        except (TypeError, ValueError):
            amt = None
        if amt is not None and math.isfinite(amt):
            open_amount += amt
        weighted = weighted_amount(opp)
        if weighted is not None:
            weighted_sum += weighted
            weighted_known = True
    return {
        "deals": deals,
        "count": len(deals),
        "openAmount": open_amount,
        "weighted": weighted_sum if weighted_known else None,
    }


def largest_deal(deals):
    def sort_key(deal):
        try:
            amount = float(deal.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0.0
        if not math.isfinite(amount):
            amount = 0.0
        return (-amount, str(deal.get("name") or ""))

    rows = list(deals or [])
    if not rows:
        return None
    return sorted(rows, key=sort_key)[0]


def _list_status_excluded(deal, today):
    """True when the deal is neither open nor excluded only for a past close date."""
    if is_open_pipeline(deal, today):
        return False
    # A close date in the future removes the past-close exclusion, matching listStatus.
    from datetime import timedelta
    probe = dict(deal)
    probe["close"] = (date.fromisoformat(today) + timedelta(days=30)).isoformat()
    return not is_open_pipeline(probe, today)


def snapshot_metrics(verified, records, today=None):
    """Headline numbers the page computes. Jobs repeat this object; they do not recompute it."""
    today = today or phoenix_today()
    verified = verified or {}
    records = records or {}
    annotated = annotate_opportunities(verified.get("opportunities") or [], records)
    pipe = pipeline_totals(annotated, today)
    start, end = quarter_bounds(today)
    counts = funnel(verified.get("leads") or [], records, start, end)
    prelim_owners = []
    companies_for = []
    for opp in annotated:
        company = company_for_opportunity(opp, records)
        companies_for.append(company)
        if not _list_status_excluded(opp, today):
            prelim_owners.append(opp.get("owner") or (company or {}).get("owner") or "")
    for lead in verified.get("leads") or []:
        prelim_owners.append(lead.get("owner"))
    resolved = resolve_owners(prelim_owners)
    tail = 4
    prefix = "Owner #\u2026"
    for info in resolved.values():
        if not info["named"] and str(info["label"]).startswith(prefix):
            tail = max(tail, len(info["label"]) - len(prefix))

    def info_for(raw):
        key = "" if raw is None else str(raw)
        return resolved[key] if key in resolved else owner_info(raw, tail)

    deals = []
    for opp, company in zip(annotated, companies_for):
        reason = exclusion_reason(opp, today)
        raw_owner = opp.get("owner") or (company or {}).get("owner") or ""
        quiet = days_quiet(company, today) if company else None
        deals.append({
            "id": opp.get("id"),
            "name": opp.get("name"),
            "companyName": company_name((company or {}).get("name") or opp.get("name")),
            "dealName": opp.get("dealName") or "",
            "amount": opp.get("amount"),
            "stage": stage_display(opp.get("stage")),
            "close": date_only(opp.get("close")),
            "ownerLabel": info_for(raw_owner)["label"],
            "daysQuiet": quiet,
            "inOpenBook": reason is None,
            "reason": reason or "open",
            "note": opp.get("note") or "",
            "days": opp.get("days"),
        })
    open_deals = [d for d in deals if d["inOpenBook"]]
    largest = largest_deal(open_deals)
    largest_out = None
    if largest:
        try:
            amount = float(largest.get("amount"))
        except (TypeError, ValueError):
            amount = None
        largest_out = {
            "company": largest.get("companyName") or company_name(largest.get("name")),
            "dealName": largest.get("dealName") or "",
            "amount": None if amount is None else round_half_up(amount),
            "stage": largest.get("stage"),
            "owner": largest.get("ownerLabel"),
            "id": largest.get("id"),
            "inOpenBook": True,
        }
    weighted = None if pipe["weighted"] is None else round_half_up(pipe["weighted"])
    return {
        "today": today,
        "quarterStart": start,
        "quarterEnd": end,
        "definition": "Open pipeline excludes past close dates, renewals, current agreements, Disqualified, and On Hold.",
        "openCount": pipe["count"],
        "openAmount": round_half_up(pipe["openAmount"]),
        "weighted": weighted,
        "largest": largest_out,
        "leads": counts["leads"],
        "mql": counts["mql"],
        "sql": counts["sql"],
        "collectedAt": (records or {}).get("generatedAt"),
        "openDeals": open_deals,
        "deals": deals,
    }
