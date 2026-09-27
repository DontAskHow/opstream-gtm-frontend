#!/usr/bin/env python3
"""Hollie's marketing collection: shows, budget, outbound, AI mentions, team.

Reads the brain (read-only) and the Lead Tracker rows sheet-review.py already
wrote. Writes OUT_DATA/marketing.json. A source that is not in the brain stays
{"connected": false} with the reason; nothing is estimated.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gtm_metrics import date_only, first_touch, phoenix_today, tracker_rows

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("OUT_DATA") or (ROOT / "out" / "data"))
BRAIN = Path(os.environ.get("BRAIN_DB") or (Path.home() / "workspace" / "brain" / "brain.db"))

BUDGET = "Channels_Marketing Budget"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def load(name, default):
    try:
        return json.loads((DATA / name).read_text(encoding="utf-8"))
    except Exception:
        return default


def cell(row, i):
    return str(row[i]).strip() if isinstance(row, list) and len(row) > i and row[i] is not None else ""


def money(value):
    raw = str(value or "").strip()
    if not raw or raw in ("-", "—") or not re.search(r"\d", raw):
        return None
    neg = raw.startswith("(") and raw.endswith(")")
    try:
        n = float(re.sub(r"[^0-9.]", "", raw))
    except ValueError:
        return None
    return -n if neg else n


def tab_rows(db, title, tab):
    if db is None:
        return []
    try:
        cur = db.execute(
            "select row_json from sheets_data where spreadsheet_title=? and tab=? order by row_num", (title, tab))
    except sqlite3.Error:
        return []
    out = []
    for (raw,) in cur:
        try:
            out.append(json.loads(raw))
        except Exception:
            out.append([])
    return out


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def parse_show_dates(label, year):
    """'9/ 28-30' -> (2026-09-28, 2026-09-30). 'Nov'/TBD' -> (None, None)."""
    raw = re.sub(r"\s+", "", str(label or ""))
    m = re.match(r"^(\d{1,2})/(\d{1,2})(?:-(?:(\d{1,2})/)?(\d{1,2}))?$", raw)
    if not m:
        return None, None
    try:
        start = date(year, int(m.group(1)), int(m.group(2)))
        if m.group(4):
            end = date(year, int(m.group(3) or m.group(1)), int(m.group(4)))
        else:
            end = start
    except ValueError:
        return None, None
    return start.isoformat(), end.isoformat()


def date_label(start, end):
    if not start:
        return ""
    a = date.fromisoformat(start)
    b = date.fromisoformat(end or start)
    if a == b:
        return "%s %d" % (MONTHS[a.month - 1], a.day)
    if a.month == b.month:
        return "%s %d–%d" % (MONTHS[a.month - 1], a.day, b.day)
    return "%s %d – %s %d" % (MONTHS[a.month - 1], a.day, MONTHS[b.month - 1], b.day)


def budget(db, year):
    rows = tab_rows(db, BUDGET, "Actuals")
    if not rows:
        return {"connected": False, "reason": "The marketing budget workbook is not in this collection."}
    planned_row = next((r for r in rows if cell(r, 1).lower() == "planned"), [])
    actual_row = next((r for r in rows if cell(r, 1).lower() == "actual"), [])
    months = []
    for i in range(12):
        months.append({
            "month": "%d-%02d" % (year, i + 1),
            "label": MONTHS[i],
            "planned": money(cell(planned_row, 3 + i)),
            "actual": money(cell(actual_row, 3 + i)),
        })
    entered = [m for m in months if m["actual"] is not None]
    last_entered = entered[-1]["month"] if entered else None
    vendors, section = [], ""
    for r in rows:
        if cell(r, 0) and not cell(r, 1) and re.match(r"^\d{4}\s", cell(r, 0)):
            section = cell(r, 0).split(":")[-1].strip()
            continue
        vendor = cell(r, 1)
        if not vendor or vendor.lower() in ("planned", "actual", "vendor"):
            continue
        amounts = [money(cell(r, 3 + i)) for i in range(12)]
        if not any(a for a in amounts):
            continue
        vendors.append({
            "vendor": vendor, "channel": cell(r, 2) or None, "section": section,
            "months": [{"month": "%d-%02d" % (year, i + 1), "amount": a} for i, a in enumerate(amounts) if a],
            "total": round(sum(a for a in amounts if a), 2),
        })
    channels = {}
    for v in vendors:
        key = v["channel"] or "Unassigned"
        channels[key] = round(channels.get(key, 0) + v["total"], 2)
    today = phoenix_today()
    missing = [m for m in months if m["actual"] is None and m["planned"] and m["month"] <= today[:7]]
    return {
        "connected": True,
        "source": "Channels_Marketing Budget · Actuals tab",
        "currency": None,
        "months": months,
        "plannedTotal": money(cell(planned_row, 15)) or round(sum(m["planned"] or 0 for m in months), 2),
        "actualTotal": money(cell(actual_row, 15)) or round(sum(m["actual"] or 0 for m in months), 2),
        "lastEnteredMonth": last_entered,
        "missingMonths": [m["month"] for m in missing],
        "channels": [{"name": k, "amount": v} for k, v in sorted(channels.items(), key=lambda kv: -kv[1])],
        "vendors": vendors,
    }


def match_vendor(vendor, show):
    """'DPW (Amst.)' names DPW Amsterdam. An organizer name alone does not pick a show."""
    base = norm(re.sub(r"\(.*?\)", "", vendor))
    hint = norm(" ".join(re.findall(r"\((.*?)\)", vendor)))
    name = norm(show["name"])
    where = norm(show.get("location"))
    if not base or base not in name:
        return False
    if not hint:
        return name == base
    first = hint.split()[0]
    return any(word.startswith(first) for word in (name + " " + where).split())


def shows(db, spend, leads, today, year):
    rows = tab_rows(db, BUDGET, "Final Annual Show calendar")
    if not rows:
        return {"connected": False, "reason": "The show calendar tab is not in this collection.", "items": []}
    header = [norm(c) for c in rows[0]] if rows else []

    def col(r, *names):
        for n in names:
            for i, h in enumerate(header):
                if h.startswith(n):
                    return cell(r, i)
        return ""

    event_rows = [v for v in (spend.get("vendors") or []) if (v.get("channel") or "").lower() == "events"]
    campaigns = []
    if db is not None:
        try:
            campaigns = [(str(n or ""), str(st or "")) for n, st in db.execute("select name, status from lemlist_campaigns")]
        except sqlite3.Error:
            campaigns = []
    items = []
    for r in rows[1:]:
        name = cell(r, 0)
        if not name:
            continue
        start, end = parse_show_dates(col(r, "date"), year)
        price = money(col(r, "package price"))
        attendees = [a.strip() for a in re.split(r",| and ", col(r, "opstream attendees")) if a.strip()]
        show = {
            "id": "show:" + norm(name).replace(" ", "-"),
            "name": name.strip(),
            "dateLabel": date_label(start, end) or (col(r, "date") or "Date not set"),
            "start": start, "end": end,
            "location": col(r, "location") or None,
            "quarter": cell(r, 3) or None,
            "status": col(r, "status") or None,
            "approved": (col(r, "status") or "").strip().lower() in ("signed", "approved", "confirmed"),
            "package": col(r, "details", "sponsorship") or None,
            "attendees": attendees,
            "organizer": col(r, "organizer") or None,
            "planned": price,
            "notes": col(r, "notes") or None,
            "checklistNote": col(r, "preparedness") or None,
        }
        show["campaigns"] = [{"name": n, "status": st} for n, st in campaigns if norm(n) == norm(show["name"])]
        items.append(show)
    names = [norm(s["name"]) for s in items]
    for show in items:
        start, end = show["start"], show["end"]
        recorded = [v for v in event_rows if match_vendor(v["vendor"], show)]
        show["recorded"] = {
            "amount": round(sum(v["total"] for v in recorded), 2) if recorded else None,
            "rows": [{"vendor": v["vendor"], "months": v["months"]} for v in recorded],
        }
        org = norm(show["organizer"])
        show["organizerPayments"] = [
            {"vendor": v["vendor"], "amount": v["total"]}
            for v in event_rows
            if not any(match_vendor(v["vendor"], other) for other in items)
            and org and org != "n a" and org.split()[0] in norm(v["vendor"])]
        name_key = norm(show["name"])
        from_show, requests = [], []
        for l in leads:
            note = norm(l.get("note"))
            lead_day = first_touch(l)
            named = [n for n in names if n and n in note]
            mentions = name_key in named
            in_window = False
            if not named and start and lead_day and (l.get("source") or "").lower() == "events":
                lo = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
                hi = (date.fromisoformat(end) + timedelta(days=3)).isoformat()
                in_window = lo <= lead_day <= hi
            if mentions and start and (lead_day or "") < start:
                requests.append(l)
            elif mentions or in_window:
                from_show.append(l)
        show["leads"] = summarize_leads(from_show)
        show["meetingRequests"] = summarize_leads(requests)
        if start and end:
            if end < today:
                show["phase"] = "past"
            elif start <= (date.fromisoformat(today) + timedelta(days=7)).isoformat():
                show["phase"] = "soon"
            else:
                show["phase"] = "upcoming"
        else:
            show["phase"] = "undated"
        show["checklist"] = checklist(show)
    order = {"soon": 0, "upcoming": 1, "undated": 2}
    ahead = sorted((s for s in items if s["phase"] != "past"),
                   key=lambda s: (order[s["phase"]], s["start"] or "9999", s["name"]))
    past = sorted((s for s in items if s["phase"] == "past"), key=lambda s: s["end"], reverse=True)
    unattributed = [{"vendor": v["vendor"], "amount": v["total"], "months": v["months"]}
                    for v in event_rows if not any(match_vendor(v["vendor"], s) for s in items)]
    return {"connected": True, "source": "Channels_Marketing Budget · Final Annual Show calendar",
            "items": ahead + past, "unattributed": unattributed}


def summarize_leads(rows):
    return {
        "count": len(rows),
        "mql": sum(1 for l in rows if l.get("mql")),
        "sql": sum(1 for l in rows if l.get("sql")),
        "unowned": sum(1 for l in rows if not real_owner(l.get("owner"))),
        "companies": [l.get("name") for l in rows if l.get("name")][:8],
        "newest": max((first_touch(l) or "" for l in rows), default="") or None,
        "owners": sorted({real_owner(l.get("owner")) for l in rows if real_owner(l.get("owner"))}),
    }


def real_owner(value):
    raw = str(value or "").strip()
    if not raw or raw.lower() in ("not assigned", "unassigned", "customer", "none", "-"):
        return ""
    return raw[:1].upper() + raw[1:].lower() if raw.isalpha() else raw


def checklist(show):
    items = []
    before = show["phase"] in ("soon", "upcoming", "undated")
    items.append({"stage": "prep", "label": "Sponsorship signed",
                  "done": (show["status"] or "").lower() == "signed",
                  "detail": show["status"] or "No status on the show calendar"})
    items.append({"stage": "prep", "label": "Opstream attendees named",
                  "done": bool(show["attendees"]),
                  "detail": ", ".join(show["attendees"]) if show["attendees"] else "The show calendar lists nobody yet"})
    items.append({"stage": "prep", "label": "Spend recorded in Actuals",
                  "done": show["recorded"]["amount"] is not None,
                  "detail": ("Recorded under " + ", ".join(r["vendor"] for r in show["recorded"]["rows"]))
                  if show["recorded"]["rows"] else "No Actuals row names this show"})
    req = show["meetingRequests"]
    if req["count"]:
        items.append({"stage": "prep", "label": "Meetings booked with prospects who asked",
                      "done": req["mql"] >= req["count"],
                      "detail": "%d asked to meet at the show; %d booked" % (req["count"], req["mql"])})
    if show["checklistNote"]:
        items.append({"stage": "prep", "label": show["checklistNote"], "done": False,
                      "detail": "From the show calendar's checklist column"})
    if not before:
        led = show["leads"]
        items.append({"stage": "follow-up", "label": "Show leads in the Lead Tracker",
                      "done": led["count"] > 0,
                      "detail": "%d leads" % led["count"] if led["count"] else "No Lead Tracker rows tie to this show"})
        if led["count"]:
            items.append({"stage": "follow-up", "label": "Every show lead has an owner",
                          "done": led["unowned"] == 0,
                          "detail": "%d without an owner" % led["unowned"] if led["unowned"] else "All owned"})
            items.append({"stage": "follow-up", "label": "Show leads reached MQL",
                          "done": led["mql"] > 0,
                          "detail": "%d of %d" % (led["mql"], led["count"])})
    return items


def outbound(db):
    if db is None:
        return {"connected": False, "reason": "LemList is not in this collection."}
    try:
        rows = [json.loads(r[0]) for r in db.execute("select raw_json from lemlist_campaigns")]
    except sqlite3.Error:
        rows = []
    if not rows:
        return {"connected": False, "reason": "LemList is not in this collection."}
    def stat(r, *keys):
        src = r.get("stats") if isinstance(r.get("stats"), dict) else {}
        for k in keys:
            v = src.get(k)
            if isinstance(v, (int, float)):
                return int(v)
        return None

    with_stats = []
    for r in rows:
        sent = stat(r, "messagesSent", "emailsSent", "sent", "nbMessagesSent")
        replied = stat(r, "messagesReplied", "replied", "emailsReplied", "nbReplied")
        bounced = stat(r, "messagesBounced", "bounced", "emailsBounced", "nbBounced")
        if sent is None and replied is None:
            continue
        with_stats.append({"name": str(r.get("name") or ""), "status": r.get("status"),
                           "sent": sent, "replied": replied, "bounced": bounced})
    has_stats = bool(with_stats)
    status = {}
    for r in rows:
        key = str(r.get("status") or "unknown")
        status[key] = status.get(key, 0) + 1
    out = {
        "campaigns": len(rows),
        "byStatus": status,
        "names": sorted(str(r.get("name") or "") for r in rows if r.get("status") == "running"),
        "statsConnected": has_stats,
        "connected": has_stats,
        "campaignStats": sorted(with_stats, key=lambda c: -(c["sent"] or 0)),
    }
    if not has_stats:
        out["reason"] = ("LemList campaign names and status are collected. Sent and reply counts are not "
                         "collected yet, so no sequence is judged here.")
    return out


def ai_mentions(db):
    if db is None:
        return {"connected": False, "reason": "Otterly is not in this collection."}
    try:
        rows = list(db.execute("select brand, domain, stats_json, fetched_at from otterly_reports"))
    except sqlite3.Error:
        rows = []
    reports = []
    for brand, domain, stats, fetched in rows:
        try:
            s = json.loads(stats or "{}")
        except Exception:
            # The stored report is cut at 30,000 characters; the summary block comes first.
            head = str(stats or "")
            found = re.search(r'"summary":\s*(\{[^{}]*\})', head)
            prompts = re.search(r'"totalPrompts":\s*(\d+)', head)
            try:
                s = {"summary": json.loads(found.group(1)) if found else {},
                     "totalPrompts": int(prompts.group(1)) if prompts else None}
            except Exception:
                continue
        summary = s.get("summary") or {}
        if not summary:
            continue
        reports.append({"brand": brand, "domain": domain, "prompts": s.get("totalPrompts"),
                        "brandCoverage": summary.get("brandCoverage"),
                        "domainCoverage": summary.get("domainCoverage"),
                        "shareOfVoice": summary.get("shareOfVoice"),
                        "fetchedAt": fetched})
    if not reports:
        return {"connected": False, "reason": "No Otterly report is in this collection."}
    main = max(reports, key=lambda r: r.get("prompts") or 0)
    return {"connected": True, "source": "Otterly", **main}


def _grand_total(rows):
    header = next((r for r in rows if r and cell(r, 0).lower().startswith("day of week")), None)
    total = next((r for r in rows if r and cell(r, 0).lower().startswith(("grand total", "total"))), None)
    if not header or not total:
        return None
    return {norm(h): cell(total, i) for i, h in enumerate(header)}


def ads(db):
    out = []
    sources = [
        ("Google Ads", "Google - Day-of-Week & Hour-of-Day - Opstream.AI", "Summary - Day Of Week", "Report"),
        ("Reddit Ads", "Reddit - Account Performance - Opstream", "Summary - Day Of Week", "Report"),
        ("OpenAI ads", "OpenAI - Day-of-Week & Hour-of-Day - Opstream", "Day Of Week", None),
    ]
    for label, title, tab, report_tab in sources:
        rows = tab_rows(db, title, tab)
        total = _grand_total(rows)
        if not total:
            continue
        window = ""
        for r in rows[:3]:
            m = re.search(r"Window:\s*(\d{4}-\d\d-\d\d) to (\d{4}-\d\d-\d\d)", " ".join(str(c) for c in r))
            if m:
                window = m.group(1) + " to " + m.group(2)
        if not window and report_tab:
            days = sorted(cell(r, 0) for r in tab_rows(db, title, report_tab) if re.match(r"^\d{4}-\d\d-\d\d$", cell(r, 0)))
            if days:
                window = days[0] + " to " + days[-1]
        out.append({
            "name": label, "source": title,
            "spend": money(total.get("spend")),
            "impressions": money(total.get("impressions")),
            "clicks": money(total.get("clicks")),
            "conversions": money(total.get("conversions")),
            "window": window or None,
        })
    return out


def web(db):
    if db is None:
        return {"connected": False}
    try:
        rows = {k: (json.loads(v or "{}"), f) for k, v, f in db.execute("select report_key, result_json, fetched_at from ga4_reports")}
    except sqlite3.Error:
        return {"connected": False}

    def table(key, dim):
        payload = (rows.get(key) or ({}, None))[0]
        heads = [h.get("name") for h in payload.get("metricHeaders") or []] if isinstance(payload, dict) else []
        out = []
        for r in (payload.get("rows") or []) if isinstance(payload, dict) else []:
            vals = {heads[i]: money((m or {}).get("value")) for i, m in enumerate(r.get("metricValues") or []) if i < len(heads)}
            name = ((r.get("dimensionValues") or [{}])[0] or {}).get("value")
            out.append({dim: name, "sessions": vals.get("sessions"), "engagedSessions": vals.get("engagedSessions"),
                        "keyEvents": vals.get("keyEvents")})
        return out

    channels = table("channels_90d", "name")
    pages = table("landing_90d", "name")
    fetched = max((f for _p, f in rows.values() if f), default=None)
    return {"connected": bool(channels or pages), "channels": channels, "pages": pages[:10], "fetchedAt": fetched,
            "reason": None if (channels or pages) else
            "GA4 channel and landing-page reports have not been collected yet. They are added on the next refresh."}


def team(db):
    """People who can be @mentioned. Names come from HubSpot owners, then Fathom recorders."""
    people = {}
    if db is None:
        return []
    try:
        for (raw,) in db.execute("select properties_json from hubspot_objects where object_type='owners'"):
            p = json.loads(raw or "{}")
            email = str(p.get("email") or "").lower()
            name = " ".join(x for x in (p.get("firstName"), p.get("lastName")) if x).strip()
            if email.endswith("@opstream.ai") and name:
                people[email] = name
    except sqlite3.Error:
        pass
    try:
        for name, email in db.execute("select recorded_by_name, recorded_by_email from meetings"):
            email = str(email or "").lower()
            if not email.endswith("@opstream.ai") or email in people:
                continue
            label = str(name or "").strip() or " ".join(
                w[:1].upper() + w[1:] for w in re.split(r"[._-]+", email.split("@")[0]) if w)
            people[email] = label
    except sqlite3.Error:
        pass
    return [{"id": "person:" + e, "name": n, "email": e} for e, n in sorted(people.items(), key=lambda kv: kv[1])]


def main():
    review = load("sheet-review.json", {})
    records = load("records.json", {})
    today = date_only(records.get("generatedAt")) or phoenix_today()
    year = int(today[:4])
    db = None
    if BRAIN.is_file():
        try:
            db = sqlite3.connect("file:%s?mode=ro" % BRAIN, uri=True)
        except sqlite3.Error:
            db = None
    leads = tracker_rows(review)
    spend = budget(db, year)
    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "asOf": today,
        "spend": spend,
        "shows": shows(db, spend, leads, today, year),
        "outbound": outbound(db),
        "ai": ai_mentions(db),
        "ads": ads(db),
        "web": web(db),
        "team": team(db),
    }
    (DATA / "marketing.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    items = result["shows"].get("items") or []
    print("marketing: %d shows, spend %s, outbound %s, ai %s" % (
        len(items), "connected" if spend.get("connected") else "not connected",
        "connected" if result["outbound"].get("connected") else "not connected",
        "connected" if result["ai"].get("connected") else "not connected"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
