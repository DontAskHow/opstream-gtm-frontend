"""Suggested drafts so Drafts is never empty when the collection has something to say.

Every draft is text for a person to review. Nothing here sends, posts or
schedules. Recipients are filled only from collected contact emails.
"""
import re
from datetime import date, timedelta


MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")[:60]


def _contact_email(records, company_name):
    key = re.sub(r"[^a-z0-9]", "", str(company_name or "").lower())
    if not key:
        return ""
    for c in (records or {}).get("companies") or []:
        if re.sub(r"[^a-z0-9]", "", str(c.get("name") or "").lower()) != key:
            continue
        for person in c.get("contacts") or []:
            email = str(person.get("email") or "").strip()
            if "@" in email:
                return email
    return ""


def linkedin_text(show):
    where = (" in " + show["location"]) if show.get("location") else ""
    tag = "#" + re.sub(r"[^A-Za-z0-9]", "", show["name"])
    if show.get("phase") == "past":
        leads = (show.get("leads") or {}).get("count")
        return "\n".join([
            "Thank you to everyone we met at %s%s." % (show["name"], where),
            ("%d people shared their details with the Opstream team, and we are following up with each of them." % leads)
            if leads else "We are following up with the people we met.",
            "If we did not get to talk and you want to compare notes on how procurement teams are using AI, send me a message.",
            "", tag + " #procurement",
        ])
    booth = "booth" in str(show.get("package") or "").lower()
    return "\n".join([
        "Opstream will be at %s%s, %s." % (show["name"], where, show.get("dateLabel") or ""),
        "Come and find us at our booth." if booth else "Let us know if you will be there too.",
        "If you are thinking about how procurement teams work with AI, we would like to hear what you are working on. Send me a message to set up a time.",
        "", tag + " #procurement",
    ])


def seed(sid, purpose, title, subject, text, rationale, company="No company linked", recipients="", mode="marketing",
         extra=None):
    out = {"id": "seed:" + sid, "purpose": purpose, "title": title, "subject": subject, "text": text,
           "rationale": rationale, "company": company, "recipients": recipients, "version": 0,
           "status": "Draft", "contentMode": mode, "citations": [], "accountIds": []}
    out.update(extra or {})
    return out


def build(marketing, hollie, records, today):
    out = []
    shows = ((marketing or {}).get("shows") or {}).get("items") or []
    horizon = (date.fromisoformat(today) + timedelta(days=42)).isoformat()
    for s in shows:
        if s.get("phase") not in ("soon", "upcoming") or not s.get("approved") or (s.get("start") or "9999") > horizon:
            continue
        out.append(seed(
            "linkedin:" + s["id"], "linkedin", "LinkedIn post · " + s["name"], "LinkedIn post · " + s["name"],
            linkedin_text(s),
            "Drafted from the show calendar row. Use Draft LinkedIn post on the show to add your mail, calendar and documents.",
            extra={"showId": s["id"], "citations": ["Dashboard: %s on the show calendar (budget workbook)" % s["name"]]}))
        req = s.get("meetingRequests") or {}
        for company in (req.get("companies") or [])[:6]:
            out.append(seed(
                "meet:%s:%s" % (s["id"], _slug(company)), "event",
                "%s · meeting at %s" % (company, s["name"]), "Meeting at %s" % s["name"],
                "Hi,\n\nThanks for letting us know you would like to meet at %s (%s%s). "
                "Which time works for you? I can hold a slot at %s.\n\nLooking forward to it."
                % (s["name"], s.get("dateLabel") or "", (", " + s["location"]) if s.get("location") else "",
                   "our booth" if "booth" in str(s.get("package") or "").lower() else "the show"),
                "%s asked to meet at %s (Lead Tracker note). No meeting is booked yet." % (company, s["name"]),
                company=company, recipients=_contact_email(records, company), extra={"showId": s["id"]}))
    cutoff = (date.fromisoformat(today) - timedelta(days=120)).isoformat()
    for s in shows:
        led = s.get("leads") or {}
        if s.get("phase") != "past" or (s.get("end") or "") < cutoff or not led.get("count"):
            continue
        out.append(seed(
            "followup:" + s["id"], "event", "Event follow-up · " + s["name"], "Good to meet you at " + s["name"],
            "Hi,\n\nThank you for stopping by at %s%s. I wanted to follow up while it is fresh: "
            "what are you working on in procurement this quarter, and would a short call be useful?\n\nBest,"
            % (s["name"], (" in " + s["location"]) if s.get("location") else ""),
            "%d Lead Tracker rows tie to %s; %d reached MQL. Use this as the template for each lead." % (
                led["count"], s["name"], led.get("mql") or 0),
            extra={"showId": s["id"]}))
        out.append(seed(
            "linkedin:" + s["id"], "linkedin", "LinkedIn post · " + s["name"], "LinkedIn post · " + s["name"],
            linkedin_text(s), "Drafted from the show calendar row and its Lead Tracker leads.",
            extra={"showId": s["id"], "citations": ["Dashboard: %s on the show calendar (budget workbook)" % s["name"]]}))
    for p in (hollie or {}).get("marketingPriorities") or []:
        if p.get("kind") == "webinar":
            out.append(seed(
                "campaign:webinar-registrants", "campaign", "Webinar registrant follow-up", "The recording from our webinar",
                "Hi {{firstName}},\n\nThanks for registering for our webinar. Here is the recording in case you missed it.\n\n"
                "If you are looking at how to bring AI into your procurement process, I would be glad to show you what "
                "teams like yours are doing. Would a 20-minute call next week work?\n\nBest,",
                p["why"] + " Copy it into a LemList sequence; nothing is sent from here."))
        if p.get("kind") == "spend":
            missing = [m for m in ((marketing or {}).get("spend") or {}).get("missingMonths") or []]
            names = [MONTHS[int(m[5:7]) - 1] for m in missing]
            out.append(seed(
                "note:spend-actuals", "internal-note", "Enter %s actuals" % " and ".join(names),
                "Enter %s actuals" % " and ".join(names),
                p["why"] + "\n\nTo do: enter each vendor's actuals in the Actuals tab, including show costs.",
                "From the budget workbook's Actuals tab.", mode="marketing"))
    for q in (hollie or {}).get("queue") or []:
        ds = q.get("draftSeed") or {}
        if q.get("kind") != "followup_draft" or not ds.get("body"):
            continue
        out.append(seed(
            "queue:" + q["id"], "email", ds.get("subject") or q["title"], ds.get("subject") or q["title"],
            ds["body"], q.get("why") or "", company=q.get("company") or "No company linked",
            recipients=_contact_email(records, q.get("company")) or "", mode="cs",
            extra={"accountIds": ["company:" + str(q["companyId"])] if q.get("companyId") else []}))
    order = {"event": 0, "linkedin": 1, "campaign": 2, "email": 3, "internal-note": 4}
    out.sort(key=lambda d: order.get(d["purpose"], 9))
    seen, unique = set(), []
    for d in out:
        if d["id"] in seen:
            continue
        seen.add(d["id"])
        unique.append(d)
    return unique
