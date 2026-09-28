#!/usr/bin/env python3
"""Hollie operator: the invisible background operator for Hollie's GTM workflow.

Reads the generated workspace data (out/data/*.json, real company-brain records)
and writes out/data/hollie.json with:
  - brief: morning-brief structure (meetings, quiet deals, follow-ups owed, new leads)
  - queue: ranked action items Hollie can work through
  - prep:  per-meeting prep briefs for the next 7 days (auto-generated, never queued)
  - autonomy: echo of scripts/hollie-autonomy.json tiers the operator obeyed

Durable anti-nag memory lives in var/hollie-operator-state.json (NOT served:
the static server only serves out/). An item is not re-surfaced within 7 days
unless its underlying data changed. Dismissals/done marks are read from
out/data/hollie-feedback.json when present (written by POST /api/hollie/feedback).

NEVER invents records, names, dates, or amounts. Missing fields stay null.
Empty sections carry an honest note instead of fabricated items.
"""
import hashlib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gtm_metrics import (QUIET_DAYS as SHARED_QUIET_DAYS, account_name,
                         apply_sheet_deal, commit_for_close_month, commit_versus_target,
                         customer_facing_action, date_only, days_quiet, is_internal_meeting,
                         deals_with_sheet, is_junk_name, is_open_pipeline, last_engagement,
                         person_name, run_id_now, sheet_overrides, unworked_count)
from marketing_priorities import build as build_marketing_priorities

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("OUT_DATA") or (ROOT / "out" / "data"))
VAR = Path(os.environ.get("HOLLIE_STATE_DIR") or (ROOT / "var"))
STATE_FILE = VAR / "hollie-operator-state.json"
FEEDBACK_FILE = DATA / "hollie-feedback.json"
AUTONOMY_FILE = ROOT / "scripts" / "hollie-autonomy.json"
REVIEW_FILE = DATA / "sheet-review.json"
OUT_FILE = DATA / "hollie.json"

QUIET_DAYS = SHARED_QUIET_DAYS  # single threshold shared with the workspace
RECENT_CALL_DAYS = 90    # only recent Fathom calls seed follow-up drafts
PREP_WINDOW_DAYS = 7
RESURFACE_DAYS = 7
PINS_FILE = ROOT / "scripts" / "priority-pins.json"


def load_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return default


def day(s):
    """First 10 chars of an ISO-ish date, or None."""
    if not s:
        return None
    s = str(s).strip()
    return s[:10] if len(s) >= 10 and s[4:5] == "-" else None


def days_ago(d, today):
    try:
        return (today - date.fromisoformat(d)).days
    except Exception:
        return None


def short_hash(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(str(p if p is not None else "").encode("utf-8"))
        h.update(b"|")
    return h.hexdigest()[:16]


def call_actions(recording):
    """The customer-facing action items of one call. brain-data already filters them."""
    out = []
    for raw in (recording or {}).get("actions") or []:
        text = " ".join(clean_md(str(raw)).split())
        if text and customer_facing_action(text) and text not in out:
            out.append(text)
    return out


def mostly_english(text):
    """False for a paragraph written mostly in another script (a Hebrew summary pasted into an English email)."""
    letters = [ch for ch in str(text) if ch.isalpha()]
    if not letters:
        return True
    latin = sum(1 for ch in letters if ch.isascii())
    return latin / len(letters) >= 0.8


MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def readable_company(company, deal_name=None):
    """'tapi.com' is a domain; the deal name ('TAPI (Teva)') says who the company is."""
    name = str(company or "").strip()
    if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", name, re.I) and deal_name:
        return re.sub(r"\s*[-–—]\s*new deal\b.*$", "", str(deal_name), flags=re.I).strip().rstrip(",;") or name
    return name


def readable_value(value):
    """ISO dates in a sentence read as 'Sep 29, 2026'."""
    text = str(value if value is not None else "")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}(T.*)?", text):
        d = date.fromisoformat(text[:10])
        return "%s %d, %d" % (MONTH_ABBR[d.month - 1], d.day, d.year)
    return text


def natural_day(iso):
    """'2026-09-28' -> 'Sep 28'."""
    try:
        d = date.fromisoformat(str(iso)[:10])
    except ValueError:
        return str(iso or "")
    return "%s %d" % (MONTH_ABBR[d.month - 1], d.day)


def person_label(value):
    """'maya graff' and 'Maya Graff' are one person."""
    raw = " ".join(str(value or "").split())
    if raw and raw == raw.lower() and "@" not in raw:
        raw = " ".join(w[:1].upper() + w[1:] for w in raw.split())
    return raw


PEOPLE_BY_EMAIL = {}


def call_owner(recording):
    """Whoever ran the call signs its follow-up. Fathom sometimes stores only the host's email."""
    who = person_label((recording or {}).get("recordedBy"))
    if "@" not in who:
        return who
    email = who.lower()
    for inv in (recording or {}).get("invitees") or []:
        if str(inv.get("email") or "").lower() == email and inv.get("name") and "@" not in inv["name"]:
            return person_label(inv["name"])
    return PEOPLE_BY_EMAIL.get(email, "")


def internal_todo(action, team_first):
    """An item for our own team ('Send missing Drive doc to Maya', 'Ping Martin re: code change')."""
    text = str(action or "")
    if re.search(r"\binternal(?:ly)?\b|\bslack\b|\bjira\b|\bticket\b", text, re.I):
        return True
    for first in team_first:
        if re.search(r"\b(?:to|with|ping|ask|tell|remind|loop in|sync with|cc|for)\s+%s\b" % re.escape(first), text, re.I):
            return True
    return False


def customer_copy(action, invitees):
    """An action item written to the customer: second person, no markdown escapes.

    'Email Christine Sparbeck demo recording' -> 'Demo recording'; 'Juella to share the list' -> "You'll share the list".
    """
    text = re.sub(r"\\([~*_`#\[\]()\-])", r"\1", str(action).strip())
    for inv in invitees or []:
        name = str(inv.get("name") or "").strip()
        if not name:
            continue
        first = name.split()[0]
        text = re.sub(r"^(?:email|send|follow up with|share with|reply to)\s+" + re.escape(name) + r"\b[:,]?\s*(?:the\s+|a\s+)?",
                      "", text, flags=re.I)
        text = re.sub(r"^(?:%s|%s)\s+(?:to|will)\s+" % (re.escape(name), re.escape(first)), "You'll ", text, flags=re.I)
        # Written to them, so they are "you", not their name.
        text = re.sub(r"\b(?:%s|%s)\b" % (re.escape(name), re.escape(first)), "you", text)
        text = re.sub(r"\b(?:she|he)'ll\b", "you'll", text, flags=re.I)
    text = re.sub(r"^(?:opstream|we)\s+(?:to|will)\s+", "We'll ", text, flags=re.I)
    if re.match(r"(?:email|send|fix|backfill|update|share|schedule|set up|book|prepare|draft|follow up|confirm|provide|review)\b", text, re.I):
        text = "We'll " + text[:1].lower() + text[1:]
    return text[:1].upper() + text[1:] if text else str(action)


def clean_md(s):
    """Strip markdown links, images, and emphasis to plain text."""
    import re
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s or "")
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"[*_]{1,3}", "", s)
    s = re.sub(r"(?m)^#+\s*", "", s)
    return s


def first_name(raw):
    first, _full = person_name(raw)
    return first


def newest_key(iso):
    """String key that sorts newest dates first when compared ascending."""
    raw = iso or "0000-00-00"
    return "".join(str(9 - int(ch)) if ch.isdigit() else ch for ch in raw)


def collected_label(iso):
    d = date_only(iso)
    if not d:
        return "on an unrecorded date"
    parsed = date.fromisoformat(d)
    return "%s %d" % (parsed.strftime("%b"), parsed.day)


def real_owner_name(owner):
    lab = str(owner or "").strip()
    if not lab or re.match(r"^(unassigned|owner)(\s|#|$)", lab, flags=re.I):
        return ""
    _first, full = person_name(lab)
    return full if full and not re.match(r"^owner\b", full, flags=re.I) else ""


def subscriber_lead(lead):
    note = str((lead or {}).get("note") or "").lower()
    name = str((lead or {}).get("name") or (lead or {}).get("company") or "")
    if note == "subscriber" or "newsletter" in note:
        return True
    if "@" in name:
        return True
    return False


def drawer_key(ref, company_id):
    """Map an evidence ref to the frontend evidence-drawer key. None if unmapped."""
    if not ref or not isinstance(ref, str):
        return None
    if ref.startswith("hubspot:deals:"):
        return "deal:deal-" + ref.split(":")[-1]
    if ref.startswith("hubspot:meetings:") and company_id:
        return "crm-meeting:%s:meeting-%s" % (company_id, ref.split(":")[-1])
    if ref.startswith("hubspot:notes:") and company_id:
        return "note:%s:note-%s" % (company_id, ref.split(":")[-1])
    if ref.startswith("hubspot:calls:") and company_id:
        return "call:%s:call-%s" % (company_id, ref.split(":")[-1])
    if ref.startswith("hubspot:companies:") and company_id:
        return "company:" + str(company_id)
    if ref.startswith("fathom:"):
        return "recording:recording-" + ref.split(":")[-1]
    return None


def main():
    now_iso = datetime.now(timezone.utc).isoformat()
    run_id = os.environ.get("GTM_RUN_ID") or run_id_now()

    records = load_json(DATA / "records.json", {})
    verified = load_json(DATA / "verified.json", {})
    evidence = load_json(DATA / "evidence.json", {})
    autonomy = load_json(AUTONOMY_FILE, {})
    feedback = load_json(FEEDBACK_FILE, [])
    state = load_json(STATE_FILE, {})
    state.setdefault("items", {})
    state.setdefault("dismissed", {})
    state.setdefault("done", {})

    companies = records.get("companies") or []
    ev_keys = set(evidence.keys()) if isinstance(evidence, dict) else set()
    snap = date_only(records.get("generatedAt"))
    today = date.fromisoformat(snap) if snap else date.fromisoformat(date_only(now_iso) or "1970-01-01")

    def ok_refs(refs):
        out = []
        for r in refs or []:
            if isinstance(r, str) and r in ev_keys and r not in out:
                out.append(r)
        return out

    def drawer_keys(refs, company_id):
        """Map refs to evidence-drawer keys, deduped. Keys can collide when
        refs are concatenated from independently-deduped lists."""
        seen, out = set(), []
        for r in ok_refs(refs):
            k = drawer_key(r, company_id)
            if k and k not in seen:
                seen.add(k)
                out.append(k)
        return out

    # ---------- engagement index per company ----------
    co_eng = {}  # company id -> {"last": date-str|None, "ref": evidence ref|None}
    for c in companies:
        cid = c.get("id")
        best, best_ref = None, None
        today_s = today.isoformat()

        def consider(d, ref):
            nonlocal best, best_ref
            # "Last engagement" must be in the past — ignore future scheduled items.
            if d and d <= today_s and (best is None or d > best):
                best, best_ref = d, ref

        for it in c.get("completedInteractions") or []:
            rs = ok_refs(it.get("refs"))
            consider(day(it.get("date")), rs[0] if rs else None)
        for n in c.get("notes") or []:
            rs = ok_refs(n.get("refs"))
            consider(day(n.get("date")), rs[0] if rs else None)
        for cl in c.get("calls") or []:
            rs = ok_refs(cl.get("refs"))
            consider(day(cl.get("date")), rs[0] if rs else None)
        for m in c.get("meetings") or []:
            rs = ok_refs(m.get("refs"))
            consider(day(m.get("start")), rs[0] if rs else None)
        for r_ in c.get("recordings") or []:
            rs = ok_refs(r_.get("refs"))
            consider(day(r_.get("date")), rs[0] if rs else None)
        for em in (c.get("emails") or {}).get("items", []):
            rs = ok_refs(em.get("refs"))
            consider(day(em.get("date")), rs[0] if rs else None)
        lc = day(c.get("lastContact"))
        if lc and lc <= today_s and (best is None or lc > best):
            best, best_ref = lc, None
        # The date itself comes from the shared metric so every surface
        # (queue, brief, heartbeat, briefing) quotes one quiet-day count.
        co_eng[cid] = {"last": last_engagement(c, today_s), "ref": best_ref}

    co_by_id = {c.get("id"): c for c in companies}

    # ---------- sheet review data (manual pipeline sheet vs HubSpot) ----------
    # pipeline_meeting1_v2 is the team's working CRM: HS_Data holds the
    # hand-maintained stages, Forecast holds the commit/best-case/pipeline
    # buckets and monthly targets. sheet-review.py (run by build.cjs before
    # this operator) diffs it against the HubSpot extract.
    review = load_json(REVIEW_FILE, {})
    fcast = review.get("forecast") or {}
    buckets = fcast.get("buckets") or {}
    overrides = sheet_overrides(review)

    def with_sheet(deal):
        return apply_sheet_deal(dict(deal or {}), overrides)

    # First names of our own team: HubSpot owners, call hosts and @opstream.ai invitees.
    team_first_names = set()
    for name in list((records.get("owners") or {}).values()):
        team_first_names.add(str(name).split()[0].lower() if str(name).split() else "")
    for c_ in companies:
        for r_ in c_.get("recordings") or []:
            host = person_label(r_.get("recordedBy"))
            if host and "@" not in host:
                team_first_names.add(host.split()[0].lower())
            for inv in r_.get("invitees") or []:
                if str(inv.get("email") or "").lower().endswith("@opstream.ai") and inv.get("name"):
                    team_first_names.add(str(inv["name"]).split()[0].lower())
    team_first_names = {n for n in team_first_names if len(n) >= 3}
    # Host emails to names: any invitee row that names the address, else a HubSpot owner with that first name.
    owner_names = [str(n) for n in (records.get("owners") or {}).values() if str(n).strip()]
    for c_ in companies:
        for r_ in c_.get("recordings") or []:
            for inv in r_.get("invitees") or []:
                e = str(inv.get("email") or "").lower()
                if e.endswith("@opstream.ai") and inv.get("name") and "@" not in inv["name"]:
                    PEOPLE_BY_EMAIL.setdefault(e, person_label(inv["name"]))
    for c_ in companies:
        for r_ in c_.get("recordings") or []:
            e = str(r_.get("recordedBy") or "").lower()
            if "@" in e and e not in PEOPLE_BY_EMAIL:
                local = e.split("@")[0].split(".")[0]
                match = [n for n in owner_names if n.split()[0].lower() == local]
                PEOPLE_BY_EMAIL[e] = person_label(match[0] if len(match) == 1 else local)

    def signer_for(company):
        for deal in (company or {}).get("deals") or []:
            owner = real_owner_name(with_sheet(deal).get("owner") or deal.get("owner"))
            if owner:
                return owner
        return real_owner_name((company or {}).get("owner"))

    def bucket_of(label):
        lab = (label or "").lower()
        for key, b in buckets.items():
            for s in (b.get("stages") or []):
                if s and s in lab:
                    return key
        # fallback keywords when the forecast tab cannot be parsed
        if any(w in lab for w in ("decision", "legal")):
            return "commit"
        if "wider stakeholder" in lab:
            return "bestcase"
        if any(w in lab for w in ("sql", "discovery", "demo")):
            return "pipeline"
        return None

    # ---------- candidate queue items ----------
    candidates = []

    # 1) followup_draft from recent Fathom calls with customer-facing action items.
    # Newest call per company. Skip internal meetings. Skip a call when a later
    # interaction is already on file — do not claim "nothing since".
    if autonomy.get("draft_followups") in ("queue", "auto", "propose"):
        follow_rows = []
        for c in companies:
            if is_junk_name(c.get("name")) or is_internal_meeting(c.get("name"), "", None):
                continue
            shown = account_name(c.get("name")) or c.get("name")
            if not shown or is_junk_name(shown):
                continue
            for r_ in c.get("recordings") or []:
                invitees = r_.get("invitees") or []
                if is_internal_meeting(c.get("name"), r_.get("title"), invitees):
                    continue
                actions = [a for a in call_actions(r_) if not internal_todo(a, team_first_names)]
                if not actions:
                    continue
                d = day(r_.get("date"))
                if not d or days_ago(d, today) is None or days_ago(d, today) > RECENT_CALL_DAYS:
                    continue
                last = co_eng.get(c.get("id"), {}).get("last")
                if last and last > d:
                    continue
                rid = r_.get("id") or ("recording-" + str(r_.get("nativeId") or ""))
                item_id = "q:followup_draft:" + str(rid).replace("recording-", "")
                refs = ok_refs(r_.get("refs")) + ok_refs(c.get("refs"))
                ext = [i for i in invitees if i.get("email") and not str(i.get("email")).lower().endswith("@opstream.ai")]
                first = first_name(ext[0].get("name") or ext[0].get("email")) if ext else ""
                greeting = ("Hi %s," % first) if first else "Hi,"
                said = natural_day(d)
                body_lines = [greeting, "",
                              "Thanks for your time on %s. Here is what we agreed to follow up on:" % said, ""]
                body_lines += ["- " + customer_copy(a, ext) for a in actions]
                if r_.get("shareUrl") and any("record" in a.lower() for a in actions):
                    body_lines += ["", "The recording of our call: %s" % r_["shareUrl"]]
                body_lines += ["", "Happy to find a time to go through these together."]
                signed = call_owner(r_) or signer_for(c)
                body_lines += ["", "Best,", (signed + "\nOpstream") if signed else "Opstream"]
                draft_seed = {
                    "subject": "%s – next steps from our %s call" % (shown, said),
                    "body": "\n".join(body_lines),
                    "recipients": ", ".join(dict.fromkeys(str(i["email"]).strip().lower() for i in ext[:3])),
                }
                item_hash = short_hash("followup", rid, "|".join(actions), r_.get("title"))
                follow_rows.append({
                    "id": item_id, "kind": "followup_draft", "audience": "sales",
                    "title": "Draft follow-up: %s (%s), %d action item%s" % (
                        r_.get("title") or shown, said, len(actions), "" if len(actions) == 1 else "s"),
                    "owner": call_owner(r_) or signer_for(c) or "",
                    "recordingId": r_.get("id"), "callTitle": r_.get("title"), "callDate": d,
                    "actionCount": len(actions), "actions": actions,
                    "company": shown, "companyId": c.get("id"),
                    "why": ("%d customer-facing action item%s from the %s call %s still open on the recording."
                            % (len(actions), "" if len(actions) == 1 else "s", said, "is" if len(actions) == 1 else "are")),
                    "confidence": "high",
                    "confidenceNote": "Action items are Fathom's own. Resolution is not tracked.",
                    "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
                    "draftSeed": draft_seed,
                    "needsDecision": autonomy.get("draft_followups") == "propose",
                    "_hash": item_hash, "_sort": newest_key(d), "_company_key": shown.lower(),
                })
        follow_rows.sort(key=lambda it: it["_sort"])
        seen_co = set()
        for it in follow_rows:
            key = it.get("_company_key") or ""
            if key in seen_co:
                continue
            seen_co.add(key)
            candidates.append(it)

    # 2) stale_deal: open deals with no engagement in QUIET_DAYS+
    open_deals = []
    for c in companies:
        eng = co_eng.get(c.get("id"), {})
        last = eng.get("last")
        dq = days_ago(last, today) if last else None
        for raw_deal in c.get("deals") or []:
            if raw_deal.get("closed"):
                continue
            d_ = with_sheet(raw_deal)
            if d_.get("sheetClass") != "active" and (is_junk_name(c.get("name")) or is_junk_name(d_.get("name"))):
                continue
            if not is_open_pipeline(d_, today.isoformat()):
                continue
            open_deals.append((c, d_, last, dq))
    quiet = [(c, d_, last, dq) for (c, d_, last, dq) in open_deals
             if dq is None or dq >= QUIET_DAYS]
    # Rank stale deals by forecast bucket first (a quiet commit deal outranks a
    # quiet early-stage one), then by days quiet. Deals quiet 365+ days with no
    # sheet presence are almost certainly dead, so they sink to the bottom.
    def _stale_rank(t):
        c, d_, last, dq = t
        b = bucket_of(d_.get("stageLabel"))
        brank = {"commit": 0, "bestcase": 1, "pipeline": 2}.get(b, 3)
        ancient = 1 if (dq or 0) > 365 else 0
        return (brank, ancient, dq is None, -(dq or 0))
    quiet.sort(key=_stale_rank)
    for (c, d_, last, dq) in quiet:
        did = d_.get("id") or ("deal-" + str(d_.get("nativeId") or ""))
        item_id = "q:stale_deal:" + str(did).replace("deal-", "")
        refs = ok_refs(d_.get("refs")) + ok_refs(c.get("refs"))
        if co_eng.get(c.get("id"), {}).get("ref"):
            refs = [co_eng[c.get("id")]["ref"]] + refs
        refs = ok_refs(refs)
        shown = account_name(c.get("name"), d_.get("name")) or c.get("name")
        if not shown or is_junk_name(shown):
            continue
        if dq is None:
            detail = d_.get("displayLine") or d_.get("name")
            why = (("No dated engagement is on file for %s, yet the %s deal is still open. "
                   "Worth checking whether it is real or should be closed.") % (
                       shown, detail))
            conf, conf_note = "low", "No engagement records found at all; the deal may simply be untracked."
        else:
            detail = d_.get("displayLine") or d_.get("name")
            why = (("No recorded engagement with %s in %d days. The %s deal has gone quiet.") % (
                shown, dq, detail))
            conf, conf_note = "medium", "Based on HubSpot engagements; other channels are not visible."
        candidates.append({
            "id": item_id, "kind": "stale_deal",
            "title": "Nudge %s — quiet %s" % (shown, ("%d days" % dq) if dq is not None else "with no engagement on file"),
            "company": shown, "companyId": c.get("id"),
            "deal": d_.get("name"), "dealId": did,
            "stage": d_.get("stageLabel"), "amount": d_.get("amount"),
            "daysQuiet": dq, "lastEngagement": last, "close": day(d_.get("close")),
            "why": why, "confidence": conf, "confidenceNote": conf_note,
            "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
            "_hash": short_hash("stale", did, d_.get("stage"), last),
            "_sort": str(9999 - (dq or 9999)),
        })

    # 4) crm_update proposals (aggregate hygiene items)
    if autonomy.get("crm_updates") == "propose":
        no_amt = [(c, d_) for (c, d_, _, _) in open_deals if d_.get("amount") is None]
        if no_amt:
            refs, keys = [], []
            for (c, d_) in no_amt[:5]:
                for rf in ok_refs(d_.get("refs")):
                    if rf not in refs:
                        refs.append(rf)
                        k = drawer_key(rf, c.get("id"))
                        if k and k not in keys:
                            keys.append(k)
            candidates.append({
                "id": "q:crm_update:missing-amounts", "kind": "crm_update",
                "title": "%d open deals have no amount — the pipeline total can't be trusted" % len(no_amt),
                "company": None, "companyId": None,
                "why": ("%d open deals have no amount on record, so every pipeline and "
                        "forecast total understates reality. Filling these in is what makes "
                        "the commit number believable." % len(no_amt)),
                "confidence": "high",
                "confidenceNote": "Counted directly from the deal records.",
                "evidence": refs, "drawerKeys": keys,
                "needsDecision": True,
                "_hash": short_hash("crm", "missing-amounts", len(no_amt)),
                "_sort": "",
            })

    # ---------- sheet review: reconcile the manual pipeline sheet vs HubSpot ----------
    # pipeline_meeting1_v2 is the team's working CRM. sheet-review.py diffs its
    # HS_Data tab against the HubSpot extract; each real disagreement becomes a
    # review item under the "forecast" goal (keep the forecast honest).
    # (review / buckets / bucket_of are loaded above, before the candidates.)
    deal_company = {}
    for c in companies:
        for d_ in c.get("deals") or []:
            did = str(d_.get("id") or "").replace("deal-", "")
            if did:
                deal_company[did] = c

    if autonomy.get("crm_updates") == "propose":
        by_deal = {}
        for m in review.get("mismatches") or []:
            by_deal.setdefault(str(m.get("dealId") or ""), []).append(m)
        for did, ms in by_deal.items():
            m0 = ms[0]
            if is_junk_name(m0.get("name")) or is_junk_name(m0.get("company")):
                continue
            c = deal_company.get(did)
            lines = []
            def _hs_value(m):
                raw = str(m.get("hubspot") or "").strip()
                if m.get("field") == "stage" and (not raw or raw.isdigit()):
                    return "not available"
                return raw or "not available"
            for m in ms:
                if m.get("field") == "stage":
                    lines.append("stage: sheet has it %s, HubSpot has %s" % (
                        str(m.get("sheet") or "").split(" (")[0], _hs_value(m)))
                else:
                    lines.append("%s: the Sheet says %s, HubSpot says %s" % (
                        m.get("field"), readable_value(m.get("sheet")), readable_value(_hs_value(m))))
            refs = ok_refs(["hubspot:deals:" + did] + (c.get("refs") if c else []))
            candidates.append({
                "id": "q:sheet_review:" + did, "kind": "sheet_review",
                "title": "Which is right for %s?" % (m0.get("name") or "this deal"),
                "company": readable_company(m0.get("company") or (c.get("name") if c else None), m0.get("name")),
                "companyId": c.get("id") if c else None,
                "why": ("The pipeline sheet and HubSpot disagree on %s: %s. "
                        "The sheet is the team's working copy, so one of the two "
                        "is stale — worth 30 seconds to pick the true value." % (
                            m0.get("name") or "this deal", "; ".join(lines))),
                "confidence": "high",
                "confidenceNote": "Both values are on record; the sheet is authoritative for stages.",
                "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id") if c else None),
                "needsDecision": True,
                "_hash": short_hash("sheetrev", did,
                                    "|".join("%s=%s/%s" % (m.get("field"), m.get("sheet"), m.get("hubspot")) for m in ms)),
                "_sort": "",
            })
        for s in (review.get("sheetOnly") or []):
            did = str(s.get("dealId") or "")
            candidates.append({
                "id": "q:sheet_review:only-" + did, "kind": "sheet_review",
                "title": "%s is on the sheet but not in HubSpot" % (s.get("name") or "A deal"),
                "company": s.get("company"), "companyId": None,
                "why": ("The pipeline sheet tracks %s%s as open, but there is no "
                        "matching deal in the HubSpot extract — it may never have been "
                        "created there, or the extract missed it." % (
                            s.get("name") or "this deal",
                            (" (%s)" % s.get("stage")) if s.get("stage") else "")),
                "confidence": "medium",
                "confidenceNote": "Matched by HubSpot deal id; the extract may lag the sheet.",
                "evidence": [], "drawerKeys": [],
                "_hash": short_hash("sheetonly", did, s.get("name")),
                "_sort": "",
            })

    # ---------- goal assignment: every queue item rolls up to a Hollie-level goal ----------
    # Goals come from the team's own Forecast tab: land the commit, turn best
    # case into commit, keep the pipeline fed, keep the forecast honest.
    co_bucket = {}
    for c in companies:
        best = None
        for d_ in c.get("deals") or []:
            if d_.get("closed"):
                continue
            b = bucket_of(d_.get("stageLabel"))
            rank = {"commit": 0, "bestcase": 1, "pipeline": 2}.get(b, 3)
            if best is None or rank < best[0]:
                best = (rank, b)
        co_bucket[c.get("id")] = best[1] if best else None

    this_month = today.strftime("%Y-%m")
    sheet_by_id = {str(d.get("id")): d for d in review.get("deals") or []}

    def commit_goal(stage, close):
        """The commit is deals in a commit stage whose Sheet close date is still ahead this month."""
        close = day(close)
        if close and close < today.isoformat():
            return "forecast"
        if bucket_of(stage) == "commit":
            return "commit" if close and close[:7] == this_month else "pipeline"
        return bucket_of(stage) or "pipeline"

    for it in candidates:
        k = it["kind"]
        if k == "sheet_review":
            sd = sheet_by_id.get(str(it.get("id") or "").split(":")[-1].replace("only-", "")) or {}
            it["goal"] = "commit" if commit_goal(sd.get("stage"), sd.get("close")) == "commit" else "forecast"
        elif k == "crm_update":
            it["goal"] = "forecast"
        elif k == "stale_deal":
            it["goal"] = commit_goal(it.get("stage"), it.get("close"))
        elif k in ("followup_draft", "meeting_prep"):
            it["goal"] = co_bucket.get(it.get("companyId")) or "pipeline"
        else:
            it["goal"] = "pipeline"
        it.setdefault("audience", "sales")

    # meeting_prep is "auto": prep briefs are generated silently, not queued.
    # (If autonomy ever sets it to "queue", prep meetings become queue items too.)
    prep_meetings = []
    for c in companies:
        for m in c.get("meetings") or []:
            d = day(m.get("start"))
            if not d:
                continue
            delta = days_ago(d, today)
            if delta is None or delta > 0 or delta < -PREP_WINDOW_DAYS:
                continue
            # A call earlier today has already happened; prep is for what is ahead.
            if str(m.get("start") or "") and str(m.get("start"))[:19] < now_iso[:19] and "T" in str(m.get("start")):
                continue
            if is_internal_meeting(c.get("name"), m.get("title"), m.get("invitees") or []):
                continue
            if is_junk_name(c.get("name")) or is_junk_name(m.get("title")):
                continue
            prep_meetings.append((c, m, d))
    prep_meetings.sort(key=lambda t: t[2])
    # Dedupe by canonical meeting id: one HubSpot meeting can be linked to
    # several companies. Prefer the company with an open deal for attribution.
    deal_cids = {c.get("id") for (c, d_, _, _) in open_deals}
    ranked = sorted(prep_meetings, key=lambda t: (0 if t[0].get("id") in deal_cids else 1, t[2]))
    seen_mid, deduped = set(), []
    for (c, m, d) in ranked:
        mid = m.get("id") or ""
        if mid and mid in seen_mid:
            continue
        if mid:
            seen_mid.add(mid)
        deduped.append((c, m, d))
    prep_meetings = sorted(deduped, key=lambda t: t[2])
    if autonomy.get("meeting_prep") == "queue":
        for (c, m, d) in prep_meetings:
            mid = m.get("id") or ""
            item_id = "q:meeting_prep:" + str(mid).replace("meeting-", "")
            refs = ok_refs(m.get("refs")) + ok_refs(c.get("refs"))
            candidates.append({
                "id": item_id, "kind": "meeting_prep",
                "title": "Prep for %s (%s)" % (m.get("title") or "meeting", d),
                "company": c.get("name"), "companyId": c.get("id"),
                "why": "Meeting is coming up; a prep brief is ready below.",
                "confidence": "high", "confidenceNote": "Calendar entry from HubSpot.",
                "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
                "_hash": short_hash("mtgprep", mid, m.get("start")),
                "_sort": d,
            })

    month_key = today.strftime("%Y-%m")
    commit_preview = commit_for_close_month([
        {
            "stage": d_.get("stageLabel") or d_.get("stage"),
            "stageLabel": d_.get("stageLabel") or d_.get("stage"),
            "dealName": d_.get("name") or "",
            "name": d_.get("name") or "",
            "companyName": account_name(c.get("name"), d_.get("name")) or c.get("name"),
            "close": d_.get("close"),
            "closed": False,
            "amount": d_.get("amount"),
        }
        for (c, d_, _last, _dq) in open_deals
    ], month_key, today.isoformat())
    if commit_preview["deals"]:
        listed = ", ".join(
            "%s $%s (close %s)" % (
                d.get("companyName") or "Deal",
                f"{float(d.get('amount') or 0):,.0f}",
                date_only(d.get("close")) or "not available")
            for d in commit_preview["deals"])
        candidates.append({
            "id": "q:crm_update:commit-month",
            "kind": "crm_update",
            "audience": "sales",
            "title": "Commit closing in %s" % month_key,
            "company": None,
            "companyId": None,
            "why": "%s. Deals: %s." % (
                commit_versus_target(
                    commit_preview["amount"],
                    (((buckets.get("commit") or {}).get("targets") or {}).get(month_key) or 0),
                ).get("text") or "Commit for this close month",
                listed),
            "confidence": "high",
            "confidenceNote": "Sheet close date and commit stage. Past close dates are excluded.",
            "evidence": [],
            "drawerKeys": [],
            "goal": "commit",
            "_hash": short_hash("commit", month_key, listed),
            "_sort": "0",
        })

    # ---------- anti-nag: dismissals + 7-day re-surface rule ----------
    # The queue is persistent (Hollie works through it), but an item is only
    # "surfaced" (flagged new / re-alerted) when it is new, its underlying data
    # changed, or 7+ days passed since it was first surfaced. Dismissed/done
    # items stay suppressed until their data changes.
    dismissed, done = {}, {}
    if isinstance(feedback, list):
        for f in feedback:
            if not isinstance(f, dict):
                continue
            iid = str(f.get("itemId") or "")
            act = f.get("action")
            if iid and act in ("dismiss", "done"):
                (dismissed if act == "dismiss" else done)[iid] = {
                    "at": f.get("at"), "hash": state.get("dismissed", {}).get(iid, {}).get("hash")
                              or state.get("done", {}).get(iid, {}).get("hash")}

    queue = []
    for it in candidates:
        iid, h = it["id"], it["_hash"]
        # A dismissal/done with no recorded hash targets the item as it exists now.
        dh = dismissed.get(iid, {}).get("hash")
        if iid in dismissed and (dh is None or dh == h):
            continue
        dn = done.get(iid, {}).get("hash")
        if iid in done and (dn is None or dn == h):
            continue
        prev = state["items"].get(iid)
        first = (prev or {}).get("firstSurfaced") or today.isoformat()
        changed = not prev or prev.get("hash") != h
        try:
            stale = (today - date.fromisoformat(first)).days >= RESURFACE_DAYS
        except Exception:
            stale = True
        it["firstSurfaced"] = first
        it["isNew"] = bool(changed or stale)
        state["items"][iid] = {"firstSurfaced": first, "lastSurfaced": today.isoformat(), "hash": h}
        it.pop("_hash", None)
        queue.append(it)
    # persist dismissal hashes for items we just surfaced (so a later dismiss matches)
    for it in queue:
        for reg, src in (("dismissed", dismissed), ("done", done)):
            if it["id"] in src and not src[it["id"]].get("hash"):
                state[reg][it["id"]] = {"at": src[it["id"]]["at"],
                                        "hash": state["items"][it["id"]]["hash"]}

    # rank: new/changed items first within each kind, then followups, stale deals, leads, crm updates
    kind_rank = {"followup_draft": 0, "meeting_prep": 1, "stale_deal": 2,
                 "sheet_review": 3, "crm_update": 5}
    queue.sort(key=lambda it: (kind_rank.get(it["kind"], 9), not it["isNew"], it.pop("_sort", "")))
    # One customer action per company. Follow-ups sort ahead of quiet nudges.
    # Sheet mismatches are a different decision and stay even when the company
    # already has a nudge. Items with no company stay.
    action_kinds = {"followup_draft", "stale_deal"}
    deduped_q, seen_co = [], {}
    for it in queue:
        it.pop("_company_key", None)
        if it.get("kind") not in action_kinds:
            deduped_q.append(it)
            continue
        key = str(it.get("company") or "").strip().lower()
        if not key:
            deduped_q.append(it)
            continue
        prev = seen_co.get(key)
        if prev is None:
            seen_co[key] = it
            deduped_q.append(it)
            continue
        # Higher-priority kinds already sorted first (follow-up before a stale
        # nudge). Only two quiet-deal rows for the same name compete, and the
        # more recent engagement wins.
        if it.get("kind") == "stale_deal" and prev.get("kind") == "stale_deal":
            if (it.get("daysQuiet") if it.get("daysQuiet") is not None else 10**9) < (
                    prev.get("daysQuiet") if prev.get("daysQuiet") is not None else 10**9):
                deduped_q[deduped_q.index(prev)] = it
                seen_co[key] = it
    queue = deduped_q
    pins = (load_json(PINS_FILE, {}) or {}).get("pins") or []
    pinned_needles = set()
    for pin in pins:
        needles = [str(pin.get("match") or "")] + list(pin.get("also") or [])
        needles = [n.lower() for n in needles if n]
        try:
            rank = int(pin.get("rank") or 1)
        except (TypeError, ValueError):
            rank = 1
        idx = None
        for i, it in enumerate(queue):
            blob = " ".join(str(it.get(k) or "") for k in ("company", "title", "deal")).lower()
            if any(n in blob for n in needles):
                idx = i
                break
        if idx is None:
            needle = (pin.get("match") or "").lower()
            company = next((c for c in companies if needle and needle in str(c.get("name") or "").lower() and not is_junk_name(c.get("name"))), None)
            if company is None:
                continue
            shown = account_name(company.get("name")) or company.get("name")
            item = {
                "id": "q:pinned:" + re.sub(r"[^A-Za-z0-9_-]", "", needle)[:40],
                "kind": "stale_deal",
                "audience": "sales",
                "goal": "pipeline",
                "title": "Priority: %s" % shown,
                "company": shown,
                "companyId": company.get("id"),
                "why": "Pinned by hand. %s." % (pin.get("note") or "No note on the pin."),
                "confidence": "high",
                "confidenceNote": "Pinned by the team.",
                "evidence": ok_refs(company.get("refs")),
                "drawerKeys": drawer_keys(ok_refs(company.get("refs")), company.get("id")),
                "pinned": pin.get("note") or True,
                "isNew": True,
            }
            queue.insert(max(0, rank - 1), item)
            pinned_needles.add(needle)
            continue
        item = queue.pop(idx)
        item["pinned"] = pin.get("note") or True
        queue.insert(max(0, rank - 1), item)
        pinned_needles.add((pin.get("match") or "").lower())
    for i, it in enumerate(queue, 1):
        it["n"] = i

    # ---------- brief ----------
    # meetings today/tomorrow
    soon = []
    for (c, m, d) in prep_meetings:
        delta = -days_ago(d, today)
        if delta <= 1:
            refs = ok_refs(m.get("refs"))
            soon.append({
                "meetingId": m.get("id"), "title": m.get("title"), "start": m.get("start"),
                "outcome": m.get("outcome"), "company": c.get("name"), "companyId": c.get("id"),
                "prepReady": True,
                "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
            })
    brief_meetings = {"items": soon,
                      "note": None if soon else "No meetings on the calendar for today or tomorrow."}

    brief_quiet = {"items": [{
        "dealId": d_.get("id"), "deal": d_.get("name"), "company": c.get("name"),
        "companyId": c.get("id"), "stage": d_.get("stageLabel"), "amount": d_.get("amount"),
        "daysQuiet": dq, "lastEngagement": last,
        "evidence": ok_refs(d_.get("refs")),
        "drawerKeys": drawer_keys(ok_refs(d_.get("refs")), c.get("id")),
    } for (c, d_, last, dq) in quiet[:10]],
        "total": len(quiet),
        "note": None if quiet else "Every open deal has recorded engagement in the last %d days." % QUIET_DAYS}

    rec_by_date = []
    for c in companies:
        for r_ in c.get("recordings") or []:
            if is_internal_meeting(c.get("name"), r_.get("title"), r_.get("invitees") or []):
                continue
            acts = [a for a in call_actions(r_) if not internal_todo(a, team_first_names)]
            if not acts:
                continue
            d = day(r_.get("date"))
            if not d or (days_ago(d, today) or 9999) > RECENT_CALL_DAYS:
                continue
            last = co_eng.get(c.get("id"), {}).get("last")
            if last and last > d:
                continue
            rec_by_date.append((d, c, r_, acts))
    rec_by_date.sort(key=lambda t: t[0], reverse=True)
    # Follow-ups owed are exactly the follow-up drafts in the queue: one per call.
    owed = []
    for q in queue:
        if q.get("kind") != "followup_draft":
            continue
        owed.append({
            "recordingId": q.get("recordingId"), "title": q.get("callTitle") or q.get("title"), "date": q.get("callDate"),
            "company": q.get("company"), "companyId": q.get("companyId"),
            "actionCount": q.get("actionCount"), "actions": (q.get("actions") or [])[:3],
            "queueId": q.get("id"), "evidence": q.get("evidence") or [], "drawerKeys": q.get("drawerKeys") or [],
        })
    brief_followups = {"items": owed,
                       "note": None if owed else "No unresolved Fathom action items in the last %d days." % RECENT_CALL_DAYS}

    unworked_total = unworked_count(verified.get("leads") or [], review)
    if review.get("leads"):
        new_leads = [l for l in review.get("leads") or [] if not l.get("mql") and not subscriber_lead(l)]
    else:
        new_leads = [l for l in (verified.get("leads") or []) if not l.get("mql") and not subscriber_lead(l)]
    new_leads.sort(key=lambda l: l.get("lead") or l.get("leadDate") or "", reverse=True)
    lead_items = [{"leadId": l.get("id"), "name": l.get("company") or l.get("name"), "source": l.get("source"),
                   "leadDate": l.get("lead") or l.get("leadDate"), "owner": l.get("owner"), "note": l.get("note")}
                  for l in new_leads[:8] if (l.get("company") or l.get("name")) and "@" not in str(l.get("company") or l.get("name"))]
    brief_leads = {"items": lead_items, "total": unworked_total,
                   "note": None if unworked_total else "No unworked leads found."}

    # ---------- prep briefs (auto, next 7 days) ----------
    prep = []
    for (c, m, d) in prep_meetings:
        cid = c.get("id")
        eng = co_eng.get(cid, {})
        open_d = [{"name": dd.get("name"), "stage": dd.get("stageLabel"),
                   "displayLine": dd.get("displayLine"),
                   "amount": dd.get("amount"), "close": day(dd.get("close")),
                   "probability": dd.get("probability")}
                  for dd in c.get("deals") or [] if not dd.get("closed")
                  and not re.search(r"closed|current agreement", str(dd.get("stageLabel") or dd.get("stage") or "") + " " + str(dd.get("name") or ""), re.I)][:5]
        recs = sorted((r_ for r_ in c.get("recordings") or [] if day(r_.get("date"))),
                      key=lambda r_: day(r_.get("date")), reverse=True)
        last_call = None
        if recs:
            r0 = recs[0]
            # Invitees: who was actually on the last call (more accurate than
            # the generic company contact list for "who you're meeting").
            invitees = []
            for inv in (r0.get("invitees") or [])[:6]:
                nm = (inv.get("name") or "").strip()
                em = (inv.get("email") or "").strip()
                # Skip internal Opstream addresses — Hollie knows her own team.
                if em and "@opstream.ai" in em.lower():
                    continue
                display = nm if nm and "@" not in nm else None
                if not display and em and "@" in em:
                    # Derive a readable name from the email: kaylak@ → "Kayla K"
                    local = em.split("@")[0]
                    parts = [p for p in local.replace(".", " ").replace("_", " ").split() if p]
                    display = " ".join(p.capitalize() for p in parts) if parts else em
                if display:
                    invitees.append({"name": display, "email": em or None})
            # Structured summary: pull Meeting Purpose and Key Takeaways sections.
            summary_raw = r0.get("summary") or []
            purpose, takeaways = None, []
            current_section = None
            for p in summary_raw:
                x = p.get("x") if isinstance(p, dict) else p
                t = p.get("t") if isinstance(p, dict) else None
                txt = " ".join(str(x).split())
                if t == "h2":
                    current_section = txt.lower()
                    continue
                if not txt or txt.startswith("["):
                    continue
                if current_section and "purpose" in current_section and not purpose:
                    purpose = txt[:200]
                elif current_section and "takeaway" in current_section and len(takeaways) < 3:
                    takeaways.append(txt[:200])
            last_call = {
                "recordingId": r0.get("id"), "title": r0.get("title"),
                "date": day(r0.get("date")),
                "summary": [" ".join(str(p.get("x") if isinstance(p, dict) else p).split())
                             for p in (r0.get("summary") or [])[:3]],
                "purpose": purpose,
                "takeaways": takeaways,
                "invitees": invitees,
                "actions": [a for a in call_actions(r0) if not internal_todo(a, team_first_names)],
            }
        # The agenda carries the last call's action items: the same list and
        # count as its follow-up draft and queue card.
        unresolved = []
        if recs and last_call and (days_ago(last_call.get("date"), today) or 9999) <= RECENT_CALL_DAYS:
            unresolved = [{"action": a, "from": last_call.get("title"), "date": last_call.get("date")}
                          for a in last_call.get("actions") or []]
        agenda = []
        if unresolved:
            lc = last_call or {}
            agenda.append("Open actions from %s (%s): %d item%s" % (
                lc.get("title") or "the last call", natural_day(lc.get("date")) if lc.get("date") else "recent",
                len(unresolved), "" if len(unresolved) == 1 else "s"))
        for dd in open_d[:3]:
            # displayLine is reconciled in brain-data: stage label when known,
            # otherwise deal type from the name + real amount/close.
            detail = dd.get("displayLine") or dd.get("name")
            # Don't repeat the name if displayLine starts with it.
            if detail.startswith(dd["name"]):
                agenda.append(detail)
            else:
                agenda.append("%s — %s" % (dd["name"], detail))
        if eng.get("last"):
            dq = days_ago(eng["last"], today)
            agenda.append("Last engagement %s" % eng["last"])
        if not agenda:
            agenda.append("No recent context on file — use the first minutes to re-establish where things stand.")
        refs = ok_refs(m.get("refs")) + ok_refs(c.get("refs"))
        # Attendees: company contacts with titles (who is she talking to?)
        def _dom_score(email, company_name):
            dom = str(email or "").lower().split("@")[-1].split(".")[0]
            blob = re.sub(r"[^a-z0-9]", "", str(company_name or "").lower())
            return 2 if dom and len(dom) > 2 and dom in blob else 0
        attendees, seen_att = [], {}
        # The meeting's own invitees come first; account contacts only fill in when HubSpot lists none.
        titles = {str(p.get("email") or "").lower(): p.get("title") for p in c.get("contacts") or []}
        invited = [{"name": i.get("name") or i.get("email"), "title": titles.get(str(i.get("email") or "").lower()), "email": i.get("email")}
                   for i in m.get("invitees") or [] if not str(i.get("email") or "").lower().endswith("@opstream.ai")]
        for p in (invited or c.get("contacts") or []):
            nm = (p.get("name") or "").strip()
            if not nm:
                continue
            key = re.sub(r"\s+", " ", nm).strip().lower()
            row = {"name": nm, "title": p.get("title"), "email": p.get("email")}
            prev_i = seen_att.get(key)
            if prev_i is not None:
                prev = attendees[prev_i]
                if _dom_score(row.get("email"), c.get("name")) > _dom_score(prev.get("email"), c.get("name")):
                    attendees[prev_i] = row
                continue
            if len(attendees) >= 5:
                continue
            seen_att[key] = len(attendees)
            attendees.append(row)
        # Call goal: based on the most advanced open deal stage. Do not use a
        # deal title such as "Renewal" as the sentence subject.
        call_goal = None
        if open_d:
            top_deal = open_d[0]
            stage = (top_deal.get("stage") or "").lower()
            subject = account_name(c.get("name"), top_deal.get("name")) or c.get("name")
            if "discovery" in stage or "rpf" in stage or "rfp" in stage:
                call_goal = "Understand their pain points and confirm there's a real fit — don't pitch yet."
            elif "demo" in stage:
                call_goal = "Show them the product solving their specific problem. Get a technical win."
            elif "decision" in stage or "legal" in stage or "compliance" in stage:
                call_goal = "Get to a clear yes or no. Surface any remaining blockers and agree on next steps."
            elif "stakeholder" in stage:
                call_goal = "Expand to the wider buying group. Identify the economic buyer."
            else:
                call_goal = "Agree on concrete next steps with %s." % (subject or "this account")
        prep.append({
            "meetingId": m.get("id"), "title": m.get("title"), "start": m.get("start"),
            "outcome": m.get("outcome"), "company": account_name(c.get("name"), (open_d[0].get("name") if open_d else None)) or c.get("name"), "companyId": cid,
            "attendees": attendees,
            "callGoal": call_goal,
            "accountHistory": {
                "openDeals": open_d,
                "lastContact": eng.get("last"),
                "counts": {"notes": len(c.get("notes") or []),
                           "calls": len(c.get("calls") or []),
                           "emails": (c.get("emails") or {}).get("count", 0),
                           "tasks": len(c.get("tasks") or [])},
            },
            "lastCall": last_call,
            "unresolvedActions": unresolved[:8],
            "suggestedAgenda": agenda,
            "evidence": refs,
            "drawerKeys": drawer_keys(refs, cid),
        })

    collapsed, seen_prep = [], set()
    for pr in prep:
        if pr.get("lastCall"):
            pr["lastCall"]["summary"] = [line for line in (clean_md(s) for s in (pr["lastCall"].get("summary") or [])) if line]
            purpose = clean_md(pr["lastCall"].get("purpose") or "")
            pr["lastCall"]["purpose"] = purpose or None
        key = (str(pr.get("company") or "").lower(), str(pr.get("callGoal") or "").lower())
        if key in seen_prep:
            continue
        seen_prep.add(key)
        collapsed.append(pr)
    prep = collapsed

    # ---------- goals: the queue, organized around Hollie's actual job ----------
    # Commit is deals in a commit stage whose Sheet close date is this month
    # and has not passed. Best case and pipeline stay stage buckets.
    bucket_value = {"commit": 0.0, "bestcase": 0.0, "pipeline": 0.0}
    shaped_deals = []
    seen_sheet = set()
    for c in companies:
        for raw_deal in c.get("deals") or []:
            if raw_deal.get("closed"):
                continue
            d_ = with_sheet(raw_deal)
            seen_sheet.add(str(d_.get("id") or "").replace("deal-", ""))
            shaped_deals.append({
                "stage": d_.get("stageLabel") or d_.get("stage"),
                "stageLabel": d_.get("stageLabel") or d_.get("stage"),
                "dealName": d_.get("name") or "",
                "name": d_.get("name") or "",
                "companyName": account_name(c.get("name"), d_.get("name")) or c.get("name"),
                "close": d_.get("close"),
                "closed": False,
                "amount": d_.get("amount"),
                "pipeline": d_.get("pipeline") or "",
                "sheetClass": d_.get("sheetClass") or "",
                "onSheet": d_.get("onSheet") is True,
            })
            if not is_open_pipeline(d_, today.isoformat()):
                continue
            b = bucket_of(d_.get("stageLabel") or d_.get("stage"))
            if b in ("bestcase", "pipeline") and d_.get("amount"):
                bucket_value[b] += d_["amount"]
    # A sheet row with no HubSpot company still counts. The sheet is the book.
    for stub in deals_with_sheet([], review):
        did = str(stub.get("id") or "").replace("deal-", "")
        if not did or did in seen_sheet:
            continue
        shaped_deals.append({
            "stage": stub.get("stageLabel") or stub.get("stage"),
            "stageLabel": stub.get("stageLabel") or stub.get("stage"),
            "dealName": stub.get("dealName") or stub.get("name") or "",
            "name": stub.get("name") or "",
            "companyName": stub.get("name") or "",
            "close": stub.get("close"),
            "closed": False,
            "amount": stub.get("amount"),
            "pipeline": stub.get("pipeline") or "",
            "sheetClass": stub.get("sheetClass") or "",
            "onSheet": True,
        })
        if not is_open_pipeline(stub, today.isoformat()):
            continue
        b = bucket_of(stub.get("stageLabel") or stub.get("stage"))
        if b in ("bestcase", "pipeline") and stub.get("amount"):
            bucket_value[b] += stub["amount"]
    month = today.strftime("%Y-%m")
    month_name = today.strftime("%B")
    commit_rows = commit_for_close_month(shaped_deals, month, today.isoformat())
    bucket_value["commit"] = commit_rows["amount"]
    targets = {k: (b.get("targets") or {}).get(month) or 0
               for k, b in buckets.items()}
    lt = (review.get("leadTracker") or {})
    n_mismatch = sum(1 for it in queue if it.get("kind") == "sheet_review")
    n_no_amount = sum(1 for (_c, d_, _last, _dq) in open_deals if d_.get("amount") is None)

    def usd0(x):
        return "$%s" % f"{x:,.0f}"

    commit_names = ", ".join(
        "%s %s" % (d.get("companyName") or d.get("name") or "Deal", usd0(float(d.get("amount") or 0)))
        for d in commit_rows["deals"]) or "no deals"
    commit_text = commit_versus_target(bucket_value["commit"], targets.get("commit")).get("text") or (
        "%s closing in %s" % (usd0(bucket_value["commit"]), month_name))
    goal_defs = [
        ("commit", "Land the %s commit" % month_name,
         commit_text + ". Deals: " + commit_names + "."),
        ("bestcase", "Turn best case into commit",
         "%s sitting in %s" % (usd0(bucket_value["bestcase"]),
                                (buckets.get("bestcase") or {}).get("label") or "best-case stages")),
        ("pipeline", "Keep the pipeline fed",
         "%s of the open pipeline is in early stages (%s) · %d leads with no MQL date" % (
             usd0(bucket_value["pipeline"]),
             ", ".join((buckets.get("pipeline") or {}).get("stages") or ["SQL, discovery, demo"]).replace("sql", "SQL"),
             unworked_total)),
        ("forecast", "Keep the forecast honest",
         "%d Sheet check%s (the Sheet and HubSpot disagree) · %d open deal%s missing an amount" % (
             n_mismatch, "" if n_mismatch == 1 else "s", n_no_amount, "" if n_no_amount == 1 else "s")),
    ]
    goals = [{"id": gid, "title": title, "status": status}
             for gid, title, status in goal_defs
             if any(it.get("goal") == gid for it in queue)]

    brief = {"generatedFor": today.isoformat(),
             "meetings": brief_meetings, "quietDeals": brief_quiet,
             "followupsOwed": brief_followups, "newLeads": brief_leads}

    marketing = load_json(DATA / "marketing.json", {})
    marketing_priorities = build_marketing_priorities(
        marketing, review, today.isoformat(), collected_label(records.get("generatedAt")))

    out = {
        "generatedAt": now_iso,
        "runId": run_id,
        "marketingPriorities": marketing_priorities,
        "snapshotId": records.get("verifiedSnapshotId") or verified.get("snapshotId"),
        "autonomy": autonomy,
        "autonomyText": {
            "meeting_prep": "Automatic — prep briefs are generated for you; nothing to approve.",
            "draft_followups": ("Queued for your review — nothing is sent until you say so."
                                 if autonomy.get("draft_followups") == "queue"
                                 else "Proposed — each needs your decision."),
            "crm_updates": "Proposed — suggestions wait for your explicit decision.",
            "send_anything": "Never — the assistant cannot send anything, ever.",
            "external_messages": "Never — no external messages, no exceptions.",
        },
        "brief": brief,
        "queue": queue,
        "goals": goals,
        "prep": prep,
        "prepNote": None if prep else "No meetings in the next %d days." % PREP_WINDOW_DAYS,
        "stats": {
            "queueByKind": {k: sum(1 for it in queue if it["kind"] == k)
                            for k in ("followup_draft", "meeting_prep", "stale_deal",
                                      "sheet_review", "crm_update")},
            "queueByGoal": {g["id"]: sum(1 for it in queue if it.get("goal") == g["id"])
                            for g in goals},
            "briefCounts": {"meetingsToday": len(soon), "quietDeals": brief_quiet["total"],
                            "followupsOwed": len(owed), "newLeads": unworked_total},
            "prepBriefs": len(prep),
        },
    }

    # final evidence validation: drop refs that do not resolve
    dropped = 0
    def scrub(items):
        nonlocal dropped
        for it in items:
            ev = [r for r in (it.get("evidence") or []) if r in ev_keys]
            dropped += len(it.get("evidence") or []) - len(ev)
            it["evidence"] = ev
    scrub(queue)
    scrub(prep)
    scrub(brief["meetings"]["items"])
    scrub(brief["quietDeals"]["items"])
    scrub(brief["followupsOwed"]["items"])

    VAR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=1), encoding="utf-8")
    OUT_FILE.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("hollie.json: %d queue items across %d goals, %d prep briefs, %d refs dropped (unresolvable)" % (
        len(queue), len(goals), len(prep), dropped))


if __name__ == "__main__":
    main()
