"""Where to focus, for the marketing lead.

Every card cites a collected source. A source that is not collected produces
no card; the section that would show it says it is not connected yet.
"""
from collections import Counter
from datetime import date, timedelta

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]
RESPONSIBLE = "Hollie (marketing)"


def num(n):
    return f"{round(float(n)):,}"


def short_day(iso):
    if not iso:
        return ""
    d = date.fromisoformat(iso[:10])
    return "%s %d" % (MONTHS[d.month - 1][:3], d.day)


def join(names):
    names = [n for n in names if n]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def owner_of(value):
    raw = str(value or "").strip()
    if not raw or raw.lower() in ("not assigned", "unassigned", "customer"):
        return ""
    return raw[:1].upper() + raw[1:].lower() if raw.isalpha() else raw


def subscriber(lead):
    note = str(lead.get("note") or "").lower()
    return note == "subscriber" or "newsletter" in note


def lead_day(lead):
    return lead.get("lead") or lead.get("leadDate") or None


def card(pid, title, why, nxt, caveat, owner, last, last_label, primary, secondary=None, kind="marketing"):
    return {
        "id": pid, "kind": kind, "audience": "marketing",
        "title": title, "why": why, "next": nxt, "caveat": caveat,
        "owner": owner, "lastInteraction": last, "lastInteractionLabel": last_label,
        "primary": primary, "secondary": secondary,
        "accountIds": [], "refs": [],
    }


def shows_this_week(marketing, collected):
    shows = [s for s in ((marketing.get("shows") or {}).get("items") or []) if s.get("phase") == "this-week"]
    if not shows:
        return None
    bits, steps, owners, newest = [], [], set(), ""
    for s in shows:
        where = s.get("location") or "location not set"
        part = "%s (%s, %s)" % (s["name"], where, s.get("dateLabel"))
        money = []
        if s.get("planned") is not None:
            money.append("%s planned" % num(s["planned"]))
        if (s.get("recorded") or {}).get("amount") is not None:
            money.append("%s recorded" % num(s["recorded"]["amount"]))
        if money:
            part += ": " + ", ".join(money)
        if not s.get("attendees"):
            part += "; nobody from Opstream is listed on the show calendar yet"
        else:
            part += "; staffed by " + join(s["attendees"])
        running = [c["name"] for c in s.get("campaigns") or [] if c.get("status") == "running"]
        if running:
            part += "; the LemList campaign “%s” is running" % running[0]
        bits.append(part)
        req = s.get("meetingRequests") or {}
        if req.get("count"):
            owners.update(req.get("owners") or [])
            newest = max(newest, req.get("newest") or "")
            open_n = req["count"] - (req.get("mql") or 0)
            if open_n:
                steps.append("book the %d prospects who asked to meet at %s (%s)" % (
                    open_n, s["name"], ", ".join(req.get("companies")[:4])))
        if not s.get("attendees"):
            steps.append("confirm who is at the %s booth" % s["name"])
    names = [s["name"] for s in shows]
    if len(shows) == 1:
        title = "%s starts %s" % (names[0], short_day(shows[0].get("start")))
    else:
        title = "%s this week: %s" % ("Two shows" if len(shows) == 2 else "%d shows" % len(shows), join(names))
    why = ". ".join(bits) + "."
    nxt = (steps[0][:1].upper() + steps[0][1:] + (", then " + ", then ".join(steps[1:]) if steps[1:] else "") + ".") if steps \
        else "Prepare the booth follow-up list so show leads get an owner the day after."
    who = RESPONSIBLE + (" · meetings: " + join(sorted(owners)) if owners else "")
    return card(
        "mkt:shows-this-week:" + "+".join(s["id"] for s in shows), title, why, nxt,
        "Dates, packages and attendees are from the budget workbook's show calendar. Meeting requests are Lead Tracker notes, collected %s." % collected,
        who, newest or None, "newest meeting request" if newest else "No meeting requests recorded",
        {"label": "Open Events & shows", "target": {"kind": "section", "id": "events-shows"}},
        {"label": "Draft LinkedIn post", "target": {"kind": "linkedin", "id": shows[0]["id"]}},
        kind="shows",
    )


def webinar_unowned(leads, collected):
    rows = [l for l in leads if str(l.get("source") or "").lower() == "webinar" and not subscriber(l)]
    unowned = [l for l in rows if not owner_of(l.get("owner"))]
    if not unowned:
        return None
    no_mql = sum(1 for l in unowned if not l.get("mql"))
    notes = Counter(str(l.get("note") or "").strip() for l in unowned)
    top_note, top_n = notes.most_common(1)[0]
    newest = max((lead_day(l) or "" for l in unowned), default="") or None
    why = "%d of the %d webinar leads on the Lead Tracker have no owner, and %s has an MQL date." % (
        len(unowned), len(rows), "none" if no_mql == len(unowned) else "%d have no" % no_mql)
    if top_note and top_n > 1:
        why += " %d are marked “%s”." % (top_n, top_note)
    return card(
        "mkt:webinar-unowned", "%d webinar registrants are sitting in the tracker with no owner" % len(unowned),
        why,
        "Review the registrants by role and timing, and assign an owner to the few with an active project before the next webinar push.",
        "Registration is not attendance or intent. Lead Tracker, collected %s." % collected,
        RESPONSIBLE + " · leads unassigned", newest, "newest registrant",
        {"label": "Open the registrants", "target": {"kind": "view", "view": "accounts", "tab": "leads", "search": "webinar"}},
        {"label": "See lead sources", "target": {"kind": "section", "id": "marketing-numbers"}},
        kind="webinar",
    )


def spend_not_entered(marketing):
    spend = marketing.get("spend") or {}
    if not spend.get("connected") or not spend.get("missingMonths"):
        return None
    months = {m["month"]: m for m in spend.get("months") or []}
    missing = [months[k] for k in spend["missingMonths"] if k in months]
    last = spend.get("lastEnteredMonth")
    last_name = MONTHS[int(last[5:7]) - 1] if last else None
    last_rows = [v for v in spend.get("vendors") or [] if any(m["month"] == last for m in v.get("months") or [])]
    events = next((c["amount"] for c in spend.get("channels") or [] if c["name"] == "Events"), None)
    why = ""
    if last_name:
        why = "Actuals stop at %s" % last_name
        if len(last_rows) == 1:
            amt = next(m["amount"] for m in last_rows[0]["months"] if m["month"] == last)
            why += ", one line: %s at %s" % (last_rows[0]["vendor"], num(amt))
        why += ". "
    why += join(["%s (%s planned)" % (MONTHS[int(m["month"][5:7]) - 1], num(m["planned"])) for m in missing])
    why += " %s no actuals. " % ("has" if len(missing) == 1 else "have")
    why += "Recorded spend this year is %s against a %s plan" % (num(spend.get("actualTotal") or 0), num(spend.get("plannedTotal") or 0))
    why += ("; events are %s of it." % num(events)) if events else "."
    return card(
        "mkt:spend-not-entered", "Marketing spend has not been entered since %s" % (last_name or "the start of the year"),
        why,
        "Enter %s vendor actuals, including show costs, before the next spend review." % join(
            [MONTHS[int(m["month"][5:7]) - 1] for m in missing]),
        "Blank months are missing, not zero. Currency is not stated in the workbook.",
        RESPONSIBLE, None,
        ("%s was the last month entered" % last_name) if last_name else "No month has actuals",
        {"label": "See spend", "target": {"kind": "view", "view": "pipeline", "tab": "spend"}},
        None, kind="spend",
    )


def show_followups(marketing, today):
    past = [s for s in ((marketing.get("shows") or {}).get("items") or []) if s.get("phase") == "past"]
    cutoff = (date.fromisoformat(today) - timedelta(days=120)).isoformat()
    stuck = [s for s in past if (s.get("end") or "") >= cutoff and (s.get("leads") or {}).get("count")
             and not (s["leads"].get("mql"))]
    if not stuck:
        return None
    total = sum(s["leads"]["count"] for s in stuck)
    owners = sorted({o for s in stuck for o in s["leads"].get("owners") or []})
    parts = ["%s (%s): %d leads, none at MQL%s" % (
        s["name"], s["dateLabel"], s["leads"]["count"],
        ", %d without an owner" % s["leads"]["unowned"] if s["leads"].get("unowned") else "") for s in stuck]
    newest = max((s["leads"].get("newest") or "" for s in stuck), default="") or None
    return card(
        "mkt:show-followups:" + "+".join(s["id"] for s in stuck),
        "%d show leads from the last four months have not moved" % total,
        "; ".join(parts) + ".",
        "Ask %s which of these leads are worth a follow-up, and prepare one event follow-up draft for the rest." % (
            join(owners) or "the lead owners"),
        "Show leads are Lead Tracker rows with the Events source dated during the show, or whose note names the show.",
        RESPONSIBLE + (" · leads: " + join(owners) if owners else ""), newest, "newest show lead",
        {"label": "Open Events & shows", "target": {"kind": "section", "id": "events-shows"}},
        {"label": "Open the leads", "target": {"kind": "view", "view": "accounts", "tab": "leads", "search": ""}},
        kind="show-followup",
    )


def mql_without_sql(leads, collected):
    rows = [l for l in leads if l.get("mql") and not l.get("sql")]
    if not rows:
        return None
    rows.sort(key=lambda l: l.get("mql") or "", reverse=True)
    owners = sorted({owner_of(l.get("owner")) for l in rows if owner_of(l.get("owner"))})
    recent = ", ".join("%s (%s, %s)" % (l.get("company") or l.get("name"), l.get("source") or "no source", short_day(l["mql"]))
                       for l in rows[:3])
    return card(
        "mkt:mql-no-sql", "%d marketing-qualified leads have not become sales-qualified" % len(rows),
        "They have an MQL date and no SQL date on the Lead Tracker. The most recent are %s." % recent,
        "Check with %s whether the meeting happened, and update the SQL date if it did." % (join(owners) or "the owners"),
        "MQL and SQL dates are owner-entered on the Lead Tracker, collected %s." % collected,
        RESPONSIBLE + (" · leads: " + join(owners) if owners else ""), rows[0].get("mql"), "newest MQL",
        {"label": "Open the leads", "target": {"kind": "view", "view": "accounts", "tab": "leads", "search": ""}},
        None, kind="handoff",
    )


def unworked_by_source(leads, collected):
    rows = [l for l in leads if not l.get("mql") and not subscriber(l)]
    if not rows:
        return None
    by = Counter(str(l.get("source") or "No source") for l in rows)
    order = ", ".join("%s %d" % (k, n) for k, n in by.most_common())
    newest = max((lead_day(l) or "" for l in rows), default="") or None
    return card(
        "mkt:unworked-by-source", "%d leads have no MQL date yet" % len(rows),
        "By source: %s. Newsletter subscribers are not counted." % order,
        "Start with the sources that usually convert, and ask owners to mark the ones that are not a fit.",
        "Lead Tracker, collected %s. A lead without an MQL date may still be in conversation." % collected,
        RESPONSIBLE, newest, "newest lead",
        {"label": "Open the leads", "target": {"kind": "view", "view": "accounts", "tab": "leads", "search": ""}},
        None, kind="unworked",
    )


def build(marketing, review, today, collected_label):
    leads = (review or {}).get("leads") or []
    marketing = marketing or {}
    items = [
        shows_this_week(marketing, collected_label),
        webinar_unowned(leads, collected_label),
        spend_not_entered(marketing),
        show_followups(marketing, today),
        mql_without_sql(leads, collected_label),
        unworked_by_source(leads, collected_label),
    ]
    return [it for it in items if it]
