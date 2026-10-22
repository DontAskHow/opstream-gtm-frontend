"""Shared GTM headline metrics.

The browser copy lives in workspace-model.cjs. Keep the rules aligned:
open-pipeline exclusions, Phoenix calendar dates, quiet days, unworked leads,
and commit-versus-forecast wording. Callers describe these numbers; they do
not compute a second one.
"""
import math
import re
from datetime import date, datetime, timedelta, timezone


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


PHOENIX = timezone(timedelta(hours=-7))


def phoenix_when(value, today=None):
    """'Mon Sep 28, 9:00 AM (tomorrow)' in America/Phoenix for an ISO timestamp; the date alone for a date."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        if len(raw) == 10:
            d = date.fromisoformat(raw)
            stamp = None
        else:
            stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            stamp = stamp.astimezone(PHOENIX)
            d = stamp.date()
    except ValueError:
        return raw
    text = "%s %s %d" % (("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[d.weekday()],
                         ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")[d.month - 1], d.day)
    if stamp is not None:
        text += ", " + stamp.strftime("%I:%M %p").lstrip("0")
    if today:
        gap = (d - date.fromisoformat(today)).days
        text += {0: " (today)", 1: " (tomorrow)", -1: " (yesterday)"}.get(gap, "")
    return text


ISO_STAMP = re.compile(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?")


def phoenix_prose(text, today=None):
    """Model prose with any raw ISO timestamp rewritten as a Phoenix time."""
    return ISO_STAMP.sub(lambda m: phoenix_when(m.group(0), today), str(text or ""))


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
    return "system verification test" in blob.lower()


def apply_sheet_owner_names(owner_names, votes):
    """A unanimous sheet Deal Owner replaces the HubSpot catalog name.

    A split vote does not. The catalog name stays when the sheet has no
    single name for that id.
    """
    applied = 0
    for oid, nameset in (votes or {}).items():
        if len(nameset) != 1:
            continue
        owner_names[str(oid)] = next(iter(nameset))
        applied += 1
    return applied


# Customer-success pipelines. New business is every other pipeline.
# 855205465 is the renewal-agreement pipeline. 686463412 is the legacy
# renewal pipeline (titles are often just "Renewal"). Title text is only a
# fallback for a deal whose pipeline id was not stored.
RENEWAL_PIPELINE_IDS = frozenset({"855205465", "686463412"})


def is_placeholder_name(value):
    """A company titled only Renewal or Current agreement is not a company name."""
    return re.fullmatch(r"renewal|current agreement", str(value or "").strip(), flags=re.I) is not None


def pipeline_id(deal):
    return str((deal or {}).get("pipeline") or (deal or {}).get("pipelineId") or "").strip()


def is_renewal_pipeline(deal):
    return pipeline_id(deal) in RENEWAL_PIPELINE_IDS


def _stage_blob(deal):
    stage = str((deal or {}).get("stage") or (deal or {}).get("stageLabel") or "")
    deal_name = str((deal or {}).get("dealName") or "")
    return (stage + " " + deal_name).lower()


def _title_is_renewal(deal):
    """Fallback when the pipeline id is missing. A renewal pipeline does not need this."""
    blob = _stage_blob(deal)
    if "current agreement" in blob:
        return True
    return re.search(r"\brenewal\b", blob) is not None


SHEET_ACTIVE_STAGES = frozenset({
    "discovery/rfp received",
    "sql",
    "demo meeting",
    "decision",
    "wider stakeholders",
    "legal & compliance",
})


def sheet_class_name(stage):
    """How the master sheet classifies a row. Active stages are the open book."""
    s = re.sub(r"\s*\(deal\)\s*", "", str(stage or "").lower()).strip()
    if not s:
        return ""
    if s in SHEET_ACTIVE_STAGES:
        return "active"
    if s == "on hold":
        return "on hold"
    if "disqual" in s:
        return "disqualified"
    if "closed" in s:
        return "closed"
    return "other"


def sheet_class(deal):
    explicit = str((deal or {}).get("sheetClass") or "")
    if explicit:
        return explicit
    if (deal or {}).get("onSheet"):
        return sheet_class_name((deal or {}).get("stage"))
    return ""


def is_renewal_record(deal):
    if sheet_class(deal) == "active":
        return False
    return is_renewal_pipeline(deal) or _title_is_renewal(deal)


def close_date_passed(deal, today):
    close = date_only((deal or {}).get("close"))
    return bool(close and today and close < today)


def _company_key(deal):
    cid = str((deal or {}).get("companyId") or "").strip()
    if cid in ("", "company:", "company:unknown"):
        return ""
    return cid


def _is_legacy_placeholder(deal):
    if pipeline_id(deal) != "686463412":
        return False
    return re.fullmatch(r"renewal", str((deal or {}).get("dealName") or "").strip(), flags=re.I) is not None


def _is_renewal_agreement(deal):
    if pipeline_id(deal) != "855205465":
        return False
    return re.search(r"renewal agreement", str((deal or {}).get("dealName") or ""), flags=re.I) is not None


def _closed_blob(blob):
    return re.search(r"closed\s*won|closed\s*lost|closedwon|closedlost", blob) is not None


def _renewal_current(deal, today):
    """A renewal that is still in play: not closed, not past its close date."""
    if not deal or deal.get("closed") is True or is_test_record(deal):
        return False
    blob = _stage_blob(deal)
    if _closed_blob(blob) or "disqualif" in blob or re.search(r"\bon hold\b", blob):
        return False
    close = date_only(deal.get("close"))
    if close and today and close < today:
        return False
    return True


def renewal_book(deals, today):
    """Current renewal/CS deals.

    A legacy deal titled only Renewal in pipeline 686463412 is not added when
    that company already has a current Renewal Agreement in pipeline 855205465.
    The placeholder stays in `duplicates` so it is not dropped silently.
    """
    rows = [d for d in (deals or []) if is_renewal_record(d)]
    current = [d for d in rows if _renewal_current(d, today)]
    agreement_companies = {_company_key(d) for d in current if _is_renewal_agreement(d) and _company_key(d)}
    counted = []
    duplicates = []
    for deal in current:
        key = _company_key(deal)
        if _is_legacy_placeholder(deal) and key and key in agreement_companies:
            duplicates.append(deal)
        else:
            counted.append(deal)
    amount = 0.0
    for deal in counted:
        try:
            amt = float(deal.get("amount"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(amt):
            amount += amt
    past_close = 0
    for deal in rows:
        if deal.get("closed") is True or is_test_record(deal):
            continue
        blob = _stage_blob(deal)
        if _closed_blob(blob) or "disqualif" in blob or re.search(r"\bon hold\b", blob):
            continue
        close = date_only(deal.get("close"))
        if close and today and close < today:
            past_close += 1
    return {
        "count": len(counted),
        "amount": amount,
        "deals": counted,
        "duplicates": duplicates,
        "pastClose": past_close,
    }


def hubspot_looks_open(deal, today):
    """HubSpot-shaped open check. The sheet, not this function, defines the book."""
    if not deal or deal.get("closed") is True:
        return False
    if is_test_record(deal):
        return False
    blob = _stage_blob(deal)
    if _closed_blob(blob):
        return False
    if "disqualif" in blob:
        return False
    if re.search(r"\bon hold\b", blob):
        return False
    if is_renewal_pipeline(deal):
        return False
    if "current agreement" in blob:
        return False
    if re.search(r"\brenewal\b", blob):
        return False
    if close_date_passed(deal, today):
        return False
    return True


def is_open_pipeline(deal, today):
    """The open book is the master sheet's active new-business rows.

    A past close date stays in the book. A renewal pipeline does not override
    the sheet. A deal that is not on the sheet is not in the total.
    """
    return sheet_class(deal) == "active"


def is_hubspot_only_open(deal, today):
    """A non-renewal HubSpot deal that looks open and is not on the sheet."""
    if sheet_class(deal):
        return False
    if is_renewal_record(deal):
        return False
    return hubspot_looks_open(deal, today)


def _money_sum(deals):
    total = 0.0
    for deal in deals or []:
        try:
            amt = float(deal.get("amount"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(amt):
            total += amt
    return total


def on_hold_book(deals):
    rows = [d for d in (deals or []) if sheet_class(d) == "on hold"]
    return {"count": len(rows), "amount": _money_sum(rows), "deals": rows}


def hubspot_only_book(deals, today):
    rows = [d for d in (deals or []) if is_hubspot_only_open(d, today)]
    return {"count": len(rows), "amount": _money_sum(rows), "deals": rows}


def exclusion_reason(deal, today):
    """Why a deal is outside the open book. None when it is in the book."""
    if is_open_pipeline(deal, today):
        return None
    kind = sheet_class(deal)
    if kind == "on hold":
        return "On Hold"
    if kind == "disqualified":
        return "Disqualified"
    if kind == "closed":
        return "closed"
    if is_hubspot_only_open(deal, today):
        return "In HubSpot, not on the Sheet"
    if (deal or {}).get("closed") is True:
        return "closed"
    if is_test_record(deal):
        return "verification fixture"
    blob = _stage_blob(deal)
    if _closed_blob(blob):
        return "closed won or lost"
    if "disqualif" in blob:
        return "Disqualified"
    if re.search(r"\bon hold\b", blob):
        return "On Hold"
    if is_renewal_pipeline(deal) or re.search(r"\brenewal\b", blob):
        return "renewal"
    if "current agreement" in blob:
        return "current agreement"
    if close_date_passed(deal, today):
        return "past close date"
    return "excluded"


def stage_display(stage):
    s = str(stage or "").strip()
    if s.endswith(" (Deal)"):
        s = s[: -len(" (Deal)")].strip()
    return s or "No stage"


def source_label(source):
    s = str(source or "").strip()
    if not s or re.match(r"^(hubspot|crm|integration|unknown|unknown source)$", s, flags=re.I):
        return "Unknown source"
    return s


def tracker_rows(sheet_review=None, contacts=None):
    """Lead Tracker rows when the sheet is in the collection, otherwise HubSpot contacts.

    Newsletter subscribers and rows with no company name are not leads.
    """
    rows = (sheet_review or {}).get("leads") or []
    out = []
    for r in (rows if rows else (contacts or [])):
        note = str(r.get("note") or "").strip().lower()
        name = str(r.get("company") or r.get("name") or "").strip()
        if note == "subscriber" or "newsletter" in note or not name or "@" in name:
            continue
        out.append({
            "name": r.get("displayName") or name,
            "trackerName": name,
            "source": source_label(r.get("source")),
            "owner": lead_owner(r.get("owner")),
            "lead": date_only(r.get("lead") or r.get("leadDate")),
            "mql": date_only(r.get("mql")),
            "sql": date_only(r.get("sql")),
            "note": r.get("note"),
            "contact": r.get("contact"),
            "sheetRow": r.get("sheetRow"),
            "flags": r.get("flags") or lead_flags(r.get("note")),
        })
    return out


def lead_owner(value):
    """An owner name, or '' when the tracker says nobody owns the lead."""
    raw = str(value or "").strip()
    if raw.lower() in ("", "not assigned", "unassigned", "customer", "none", "-"):
        return ""
    return raw[:1].upper() + raw[1:].lower() if raw.isalpha() else raw


def lead_stage(row):
    """no-mql, mql-no-sql or sql: the Lead Tracker stage a row has reached."""
    if not row.get("mql"):
        return "no-mql"
    return "mql-no-sql" if not row.get("sql") else "sql"


def first_touch(row):
    days = [d for d in (row.get("lead"), row.get("mql"), row.get("sql")) if d]
    return min(days) if days else None


def lead_counts(rows, start, end):
    """Lead Tracker definitions: a lead counts on its first stage date; MQL and SQL on their own dates."""
    by = {}

    def slot(name):
        return by.setdefault(name, {"channel": name, "leads": 0, "mql": 0, "sql": 0})

    for r in rows or []:
        ft = first_touch(r)
        if ft and start <= ft <= end:
            slot(r["source"])["leads"] += 1
        if r.get("mql") and start <= r["mql"] <= end:
            slot(r["source"])["mql"] += 1
        if r.get("sql") and start <= r["sql"] <= end:
            slot(r["source"])["sql"] += 1
    sources = sorted(by.values(), key=lambda c: (-c["leads"], -c["mql"], -c["sql"], c["channel"]))
    return {
        "leads": sum(c["leads"] for c in sources),
        "mql": sum(c["mql"] for c in sources),
        "sql": sum(c["sql"] for c in sources),
        "sources": sources,
    }


def unworked_rows(rows):
    return [r for r in rows or [] if not r.get("mql")]


def unworked_count(leads, sheet_review=None):
    return len(unworked_rows(tracker_rows(sheet_review, leads)))


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
    """'Applied Materials,' and 'Mozilla Firefox 3.6' (a browser string's version number) read as names."""
    name = re.sub(r"[,;]+$", "", str(value or "").strip()).strip()
    return re.sub(r"\s+\d+(?:\.\d+)+$", "", name).strip()


def owner_info(value, catalog=None):
    """A person's name, or Unassigned. A raw HubSpot id is never a name."""
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
    book = catalog or {}
    hit = book.get(stripped) or book.get(s) or book.get(stripped.lower())
    if isinstance(hit, str) and hit.strip():
        return {"label": hit.strip(), "title": "", "key": stripped, "named": True}
    if re.fullmatch(r"\d+", stripped) or re.fullmatch(r"[a-f0-9-]{8,}", stripped, flags=re.I):
        return {"label": "Unassigned", "title": "This HubSpot owner has no name in the owners list", "key": "Unassigned", "named": False}
    return {"label": stripped, "title": "", "key": stripped, "named": True}


def resolve_owners(values):
    return {("" if v is None else str(v)): owner_info(v) for v in (values or [])}


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


def snapshot_metrics(verified, records, today=None, sheet_review=None):
    """Headline numbers the page computes. Jobs repeat this object; they do not recompute it.

    `today` defaults to the Phoenix date of the collection, not the viewer's clock.
    Sheet amount and close date replace HubSpot when sheet_review records a difference.
    """
    verified = verified or {}
    records = records or {}
    today = today or date_only((records or {}).get("generatedAt")) or phoenix_today()
    annotated = deals_with_sheet(
        annotate_opportunities(verified.get("opportunities") or [], records),
        sheet_review,
    )
    pipe = pipeline_totals(annotated, today)
    renewals = renewal_book(annotated, today)
    held = on_hold_book(annotated)
    unlisted = hubspot_only_book(annotated, today)
    start, end = quarter_bounds(today)
    counts = lead_counts(tracker_rows(sheet_review, verified.get("leads")), start, end)
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

    def info_for(raw):
        key = "" if raw is None else str(raw)
        return resolved[key] if key in resolved else owner_info(raw)

    deals = []
    for opp, company in zip(annotated, companies_for):
        reason = exclusion_reason(opp, today)
        raw_owner = opp.get("owner") or (company or {}).get("owner") or ""
        quiet = days_quiet(company, today) if company else None
        deals.append({
            "id": opp.get("id"),
            "name": opp.get("name"),
            "companyName": account_name((company or {}).get("name"), opp.get("dealName") or opp.get("name")) or company_name((company or {}).get("name") or opp.get("name")),
            "dealName": opp.get("dealName") or "",
            "pipeline": opp.get("pipeline") or "",
            "sheetClass": opp.get("sheetClass") or "",
            "onSheet": opp.get("onSheet") is True,
            "amount": opp.get("amount"),
            "stage": stage_display(opp.get("stage")),
            "closePassed": close_date_passed(opp, today),
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
        "definition": "Open pipeline is the master sheet's active new-business rows. A past close date stays in the book and is flagged. On Hold is a separate line. HubSpot deals that are not on the sheet are not in the total.",
        "openCount": pipe["count"],
        "openAmount": round_half_up(pipe["openAmount"]),
        "weighted": weighted,
        "renewalCount": renewals["count"],
        "renewalAmount": round_half_up(renewals["amount"]),
        "renewalDuplicates": len(renewals["duplicates"]),
        "renewalPastClose": renewals["pastClose"],
        "onHoldCount": held["count"],
        "onHoldAmount": round_half_up(held["amount"]),
        "hubspotOnlyCount": unlisted["count"],
        "largest": largest_out,
        "leads": counts["leads"],
        "mql": counts["mql"],
        "sql": counts["sql"],
        "collectedAt": (records or {}).get("generatedAt"),
        "openDeals": open_deals,
        "deals": deals,
    }


def money_k(value):
    """$ with K or M, as the beta showed workbook amounts: $429K, $32.7K, $1.05M."""
    if value is None:
        return "—"
    n = float(value)
    sign = "-" if n < 0 else ""
    n = abs(n)
    if n >= 1_000_000:
        text = ("%.2f" % (n / 1_000_000)).rstrip("0").rstrip(".") + "M"
    elif n >= 100_000:
        text = "%dK" % round(n / 1000)
    elif n >= 1000:
        text = ("%.1f" % (n / 1000)).rstrip("0").rstrip(".") + "K"
    else:
        text = "%d" % round(n)
    return sign + "$" + text


def parse_money(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    raw = re.sub(r"[^0-9.\-]", "", str(value))
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def sheet_overrides(review):
    """Sheet amount, close date, stage, and owner win where the review recorded them."""
    out = {}
    for deal in (review or {}).get("deals") or []:
        did = str(deal.get("id") or "").replace("deal-", "")
        if not did:
            continue
        slot = out.setdefault(did, {})
        if deal.get("amount") is not None:
            slot["amount"] = float(deal["amount"])
        if deal.get("close"):
            slot["close"] = date_only(deal.get("close"))
        if deal.get("stage"):
            slot["stage"] = str(deal["stage"]).split(" (")[0].strip()
        if deal.get("owner"):
            slot["owner"] = str(deal["owner"]).strip()
        if deal.get("company"):
            slot["company"] = str(deal["company"]).strip()
        if deal.get("probability") not in (None, ""):
            slot["probability"] = float(deal["probability"])
    for row in (review or {}).get("mismatches") or []:
        did = str(row.get("dealId") or "").replace("deal-", "")
        if not did:
            continue
        slot = out.setdefault(did, {})
        field = str(row.get("field") or "").lower()
        if field == "amount":
            amount = parse_money(row.get("sheet"))
            if amount is not None:
                slot["amount"] = amount
                slot["hubspotAmount"] = parse_money(row.get("hubspot"))
        elif "close" in field:
            slot["close"] = date_only(row.get("sheet")) or row.get("sheet")
            slot["hubspotClose"] = row.get("hubspot")
        elif field == "stage":
            sheet = str(row.get("sheet") or "")
            slot["stage"] = sheet.split(" (")[0].strip()
            slot["hubspotStage"] = row.get("hubspot")
    return out


def apply_sheet_deal(deal, overrides):
    if not deal:
        return deal
    did = str(deal.get("id") or "").replace("deal-", "")
    ov = (overrides or {}).get(did)
    if not ov:
        return deal
    nxt = dict(deal)
    diffs = []
    nxt["onSheet"] = True
    if ov.get("amount") is not None and nxt.get("amount") != ov["amount"]:
        nxt["hubspotAmount"] = nxt.get("amount")
        nxt["amount"] = ov["amount"]
        diffs.append("amount")
    sheet_close = date_only(ov.get("close")) if ov.get("close") else None
    hub_close = date_only(nxt.get("close"))
    if sheet_close and hub_close != sheet_close:
        nxt["hubspotClose"] = nxt.get("close")
        nxt["close"] = sheet_close
        # The sheet export sits a day or two off HubSpot; only a real slip is a difference.
        gap = days_between(sheet_close, hub_close) if hub_close else None
        if gap is None or abs(gap) > 2:
            diffs.append("close")
    if ov.get("stage"):
        current = str(nxt.get("stageLabel") or nxt.get("stage") or "")
        if ov["stage"].lower() not in current.lower():
            nxt["hubspotStage"] = current or ov.get("hubspotStage")
            diffs.append("stage")
        nxt["stage"] = ov["stage"]
        nxt["stageLabel"] = ov["stage"]
    if ov.get("owner") and nxt.get("owner") != ov["owner"]:
        nxt["hubspotOwner"] = nxt.get("owner")
        nxt["owner"] = ov["owner"]
        diffs.append("owner")
    if ov.get("probability") is not None:
        sheet_p = probability_fraction(ov["probability"])
        if probability_fraction(nxt.get("probability")) != sheet_p:
            nxt["hubspotProbability"] = nxt.get("probability")
            diffs.append("probability")
        nxt["probability"] = sheet_p
    sheet_company = ov.get("company")
    if sheet_company and nxt.get("name") != sheet_company:
        nxt["name"] = sheet_company
    nxt["sheetClass"] = sheet_class_name(ov.get("stage") or nxt.get("stage"))
    if diffs:
        nxt["hubspotDiffers"] = diffs
    # The line people read carries the master Sheet's values, and says so.
    bits = [nxt.get("stageLabel") or nxt.get("stage") or "No stage"]
    if nxt.get("amount") is not None:
        bits.append("$%s" % f"{float(nxt['amount']):,.0f}")
    if nxt.get("close"):
        bits.append("close %s" % date_only(nxt["close"]))
    nxt["displayLine"] = " · ".join(bits) + " (master Sheet)"
    return nxt


def deals_with_sheet(opportunities, review):
    """Sheet rows win. A sheet deal with no HubSpot match is still included."""
    overrides = sheet_overrides(review)
    seen = set()
    out = []
    for opp in opportunities or []:
        nxt = apply_sheet_deal(opp, overrides)
        out.append(nxt)
        seen.add(str(nxt.get("id") or "").replace("deal-", ""))
    for deal in (review or {}).get("deals") or []:
        did = str(deal.get("id") or "").replace("deal-", "")
        if not did or did in seen:
            continue
        stage = str(deal.get("stage") or "").split(" (")[0].strip()
        out.append({
            "id": "deal-" + did,
            "companyId": "company:unknown",
            "name": deal.get("company") or deal.get("name") or "",
            "dealName": deal.get("name") or "",
            "owner": deal.get("owner") or "Unassigned",
            "stage": stage,
            "stageLabel": stage,
            "amount": deal.get("amount"),
            "probability": None,
            "close": date_only(deal.get("close")),
            "pipeline": "",
            "closed": False,
            "onSheet": True,
            "sheetOnly": True,
            "sheetClass": sheet_class_name(stage),
        })
    return out


def is_commit_stage(label):
    lab = str(label or "").lower()
    return "decision" in lab or "legal" in lab


def commit_for_close_month(deals, month, today):
    """Commit-stage deals whose close date is in `month` and has not passed."""
    rows = []
    for deal in deals or []:
        stage = deal.get("stageLabel") or deal.get("stage") or ""
        if not is_commit_stage(stage):
            continue
        shaped = {
            "stage": stage,
            "dealName": deal.get("dealName") or deal.get("name") or "",
            "close": deal.get("close"),
            "closed": deal.get("closed") is True,
            "name": deal.get("companyName") or deal.get("name") or "",
            "pipeline": deal.get("pipeline") or "",
            "sheetClass": deal.get("sheetClass") or "",
            "onSheet": deal.get("onSheet") is True,
        }
        if not is_open_pipeline(shaped, today):
            continue
        close = date_only(deal.get("close"))
        if not close or close[:7] != month or close < today:
            continue
        rows.append(deal)
    amount = sum(float(d.get("amount") or 0) for d in rows)
    return {"month": month, "amount": amount, "count": len(rows), "deals": rows}


def snapshot_age_hours(generated_at, now=None):
    if not generated_at:
        return None
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    raw = str(generated_at).strip()
    try:
        if raw.endswith("Z"):
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None
    return (now - dt).total_seconds() / 3600.0


def is_junk_name(value):
    return "system verification test" in str(value or "").lower()


def account_name(company_name_value, deal_name=None):
    name = company_name(company_name_value)
    deal = company_name(deal_name)
    if is_junk_name(name) or is_junk_name(deal):
        return None
    if re.fullmatch(r"renewal|current agreement", name or "", flags=re.I):
        return None
    if re.search(r"\bkidde\b", deal or "", flags=re.I) and re.search(r"\bcarrier\b", name or "", flags=re.I):
        return "Kidde Global Solutions"
    return name or None


def person_name(raw):
    s = str(raw or "").strip()
    if not s:
        return "", ""
    if "@" in s and " " not in s:
        local = s.split("@")[0]
        parts = [p for p in re.split(r"[._]+", local) if p]
        full = " ".join(p.capitalize() for p in parts)
        return (parts[0].capitalize() if parts else "", full)
    if "," in s:
        last, first = [p.strip() for p in s.split(",", 1)]
        first_tok = first.split()[0] if first else ""
        return first_tok, (first + " " + last).strip()
    parts = s.split()
    return (parts[0].strip(",.;:") if parts else "", s)


def customer_facing_action(text):
    low = str(text or "").lower()
    if not low.strip():
        return False
    blocked = ("building maintenance", "pest control", "office cleanliness",
               "report intake", "validation bug", "to engineers", "internal only")
    return not any(b in low for b in blocked)


def is_internal_meeting(company_name_value, title, invitees):
    if re.search(r"\bopstream\b", str(company_name_value or ""), flags=re.I):
        return True
    if re.search(r"\bopstream\b", str(title or ""), flags=re.I):
        return True
    emails = [str((i or {}).get("email") or "").lower() for i in (invitees or []) if (i or {}).get("email")]
    return bool(emails) and all(e.endswith("@opstream.ai") for e in emails)


def run_id_now(now=None):
    """run-YYYY-MM-DD-HHMMSS, date and time both UTC, so ids sort in run order."""
    from datetime import datetime as _dt, timezone as _tz
    return (now or _dt.now(_tz.utc)).astimezone(_tz.utc).strftime("run-%Y-%m-%d-%H%M%S")


DEAD_NOTE = re.compile(r"\bno[- ]show\b|\bcancel+ed\b|different direction|\bdq'?d\b|disqualif|not a fit|not interested|"
                       r"went with (?:another|a competitor)|\bunsubscrib|do not contact", re.I)
HOT_NOTE = re.compile(r"granted (?:the )?(?:funding|budget)|funding and budget|budget (?:approved|allocated)|seriously looking|"
                      r"actively (?:looking|evaluating)|evaluating (?:vendors|solutions)|interested in a (?:convo|conversation|demo|call)|"
                      r"asked (?:for|to) (?:a )?(?:demo|meeting|call)|wants? (?:a )?(?:demo|meeting)", re.I)


def lead_flags(note):
    """hot: the note shows buying intent; dead: the note says the lead is disqualified or gone."""
    text = str(note or "")
    dead = bool(DEAD_NOTE.search(text))
    return {"hot": bool(HOT_NOTE.search(text)) and not dead, "dead": dead}
