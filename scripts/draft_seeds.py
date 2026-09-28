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


def _company_contacts(records, company_name):
    key = re.sub(r"[^a-z0-9]", "", str(company_name or "").lower())
    if not key:
        return []
    for c in (records or {}).get("companies") or []:
        if re.sub(r"[^a-z0-9]", "", str(c.get("name") or "").lower()) == key:
            return c.get("contacts") or []
    return []


def _contact_email(records, company_name):
    return next((str(p.get("email")).strip() for p in _company_contacts(records, company_name)
                 if "@" in str(p.get("email") or "")), "")


def recipients_for(records, company_name, names=""):
    """Email addresses for a To line: addresses kept, names resolved through the account's contacts, no repeats."""
    people = _company_contacts(records, company_name)
    by_name = {str(p.get("name") or "").strip().lower(): str(p.get("email") or "").strip() for p in people}
    out = []
    for part in re.split(r"[,;]", str(names or "")):
        part = part.strip()
        email = part if "@" in part else by_name.get(part.lower(), "")
        if "@" in email and email.lower() not in [e.lower() for e in out]:
            out.append(email)
    if not out:
        email = _contact_email(records, company_name)
        if email:
            out.append(email)
    return ", ".join(out)


def owner_signature(owner, notes):
    """The owner's full name when a note spells it out ("Doug Daniels- please reply"), else the first name."""
    first = str(owner or "").strip()
    if not first:
        return "The Opstream team"
    for note in notes:
        m = re.search(r"\b%s ([A-Z][a-z]+)\b" % re.escape(first), str(note or ""))
        if m:
            return "%s %s" % (first, m.group(1))
    return first


def _day(iso):
    d = date.fromisoformat(iso)
    return "%s %s %d" % (("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[d.weekday()], MONTHS[d.month - 1][:3], d.day)


def meeting_request(show, row, notes):
    first = (row.get("contact") or "").split(" ")[0] if row.get("contact") else ""
    days = [show.get("start"), show.get("end")] if show.get("end") and show.get("end") != show.get("start") else [show.get("start")]
    slots = " or ".join("%s at [time]" % _day(d) for d in days if d)
    booth = show.get("booth") or "[booth number]"
    signer = owner_signature(row.get("owner"), notes)
    return "\n".join([
        "Hi %s," % first if first else "Hi,",
        "",
        "Thanks for letting us know you would like to meet at %s (%s%s). We are at booth %s." % (
            show["name"], show.get("dateLabel") or "", (", " + show["location"]) if show.get("location") else "", booth),
        "",
        "Would %s work for you? If neither suits, send me a time that does." % slots,
        "",
        "Looking forward to meeting you,",
        signer,
        "Opstream",
    ])


def linkedin_text(show):
    where = (" in " + show["location"]) if show.get("location") else ""
    tag = "#" + re.sub(r"[^A-Za-z0-9]", "", show["name"])
    if show.get("phase") == "past":
        return "\n".join([
            "Thank you to everyone we met at %s%s." % (show["name"], where),
            "We are following up with the people we met.",
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
        notes = [r.get("note") for r in (s.get("leadRows") or []) + (s.get("requestRows") or [])]
        for row in [r for r in s.get("requestRows") or [] if not r.get("mql")]:
            company = row["company"]
            email = row.get("email") or _contact_email(records, company)
            who = ("%s (%s)" % (row["contact"], row["title"]) if row.get("title") else row["contact"]) if row.get("contact") else None
            why = ["%s asked to meet at %s (Lead Tracker note). No meeting is booked yet." % (company, s["name"])]
            why.append(("To: %s, the HubSpot contact for %s." % (who, company)) if who and email else
                       "No contact email for %s in the Lead Tracker or HubSpot%s." % (
                           company, "; the note says to reply on LinkedIn" if "linkedin" in str(row.get("note")).lower() else ""))
            why.append("Signed as the lead owner, %s. Fill in the booth number and times before sending." % owner_signature(row.get("owner"), notes))
            out.append(seed(
                "meet:%s:%s" % (s["id"], _slug(company)), "event",
                "%s · meeting at %s" % (company, s["name"]), "Meeting at %s: %s" % (s["name"], company),
                meeting_request(s, row, notes), " ".join(why),
                company=company, recipients=email, extra={"showId": s["id"], "leadOwner": row.get("owner") or ""}))
    cutoff = (date.fromisoformat(today) - timedelta(days=120)).isoformat()
    fresh = (date.fromisoformat(today) - timedelta(days=14)).isoformat()
    for s in shows:
        led = s.get("leads") or {}
        if s.get("phase") != "past" or (s.get("end") or "") < cutoff or not led.get("count"):
            continue
        where = (" in " + s["location"]) if s.get("location") else ""
        month = MONTHS[int(s["start"][5:7]) - 1] if s.get("start") else ""
        stale = (s.get("end") or "") < fresh
        rows = s.get("leadRows") or []
        emails = [r for r in rows if r.get("email")]
        owners = sorted({r["owner"] for r in rows if r.get("owner")})
        why = "%d Lead Tracker rows tie to %s; %d reached MQL, %d have a contact email. Lead owners: %s." % (
            led["count"], s["name"], led.get("mql") or 0, len(emails), ", ".join(owners) or "none")
        if stale:
            body = ("Hi {{firstName}},\n\nWe met at %s%s back in %s. A lot has changed in procurement since then, "
                    "and I wanted to check in: is {{companyName}} still looking at how AI fits into sourcing and "
                    "supplier work this year?\n\nIf it is useful, I can show you what teams like yours have set up "
                    "since the show. Would a 20-minute call in the next two weeks work?\n\nBest," % (s["name"], where, month))
            subject = "Since %s: a quick check-in" % s["name"]
        else:
            body = ("Hi {{firstName}},\n\nThank you for stopping by at %s%s. What are you working on in procurement "
                    "this quarter, and would a short call be useful?\n\nBest," % (s["name"], where))
            subject = "Good to meet you at " + s["name"]
        out.append(seed(
            "followup:" + s["id"], "campaign", "LemList follow-up · " + s["name"], subject, body,
            why + " Built for a LemList campaign: download the show's leads as CSV and import them; "
            "{{firstName}} and {{companyName}} are LemList merge tags. Nothing is sent from here.",
            extra={"showId": s["id"], "leadCount": led["count"]}))
        if not stale:
            out.append(seed(
                "linkedin:" + s["id"], "linkedin", "LinkedIn post · " + s["name"], "LinkedIn post · " + s["name"],
                linkedin_text(s), "Drafted from the show calendar row.",
                extra={"showId": s["id"], "citations": ["Dashboard: %s on the show calendar (budget workbook)" % s["name"]]}))
    recording = (marketing or {}).get("webinarRecording")
    for p in (hollie or {}).get("marketingPriorities") or []:
        if p.get("kind") == "webinar":
            out.append(seed(
                "campaign:webinar-registrants", "campaign", "Webinar registrant follow-up", "The recording from our webinar",
                "Hi {{firstName}},\n\nThanks for registering for our webinar. Here is the recording in case you missed it: "
                "%s\n\nIf you are looking at how to bring AI into your procurement process, I would be glad to show you what "
                "teams like yours are doing. Would a 20-minute call next week work?\n\nBest," % (
                    recording["url"] if recording else "[recording link]"),
                p["why"] + " Copy it into a LemList sequence; nothing is sent from here. " + (
                    "Recording: %s." % recording["name"] if recording else
                    "The collection has no webinar recording, so paste its link where it says [recording link].")))
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
            recipients=recipients_for(records, q.get("company"), ds.get("to") or ds.get("recipients") or ""), mode="cs",
            extra={"accountIds": ["company:" + str(q["companyId"])] if q.get("companyId") else []}))
    order = {"event": 0, "campaign": 1, "linkedin": 2, "email": 3, "internal-note": 4}
    out.sort(key=lambda d: order.get(d["purpose"], 9))
    seen, unique = set(), []
    for d in out:
        if d["id"] in seen:
            continue
        seen.add(d["id"])
        unique.append(d)
    return unique
