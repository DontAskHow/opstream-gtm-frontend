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
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gtm_metrics import (QUIET_DAYS as SHARED_QUIET_DAYS, commit_versus_target,
                         days_quiet, is_open_pipeline, last_engagement, phoenix_today,
                         unworked_count)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "out" / "data"
VAR = ROOT / "var"
STATE_FILE = VAR / "hollie-operator-state.json"
FEEDBACK_FILE = DATA / "hollie-feedback.json"
AUTONOMY_FILE = ROOT / "scripts" / "hollie-autonomy.json"
REVIEW_FILE = DATA / "sheet-review.json"
OUT_FILE = DATA / "hollie.json"

QUIET_DAYS = SHARED_QUIET_DAYS  # single threshold shared with the workspace
RECENT_CALL_DAYS = 90    # only recent Fathom calls seed follow-up drafts
PREP_WINDOW_DAYS = 7
RESURFACE_DAYS = 7
CAPS = {"followup_draft": 8, "stale_deal": 8, "unworked_lead": 6,
        "crm_update": 2, "sheet_review": 5}


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


def clean_md(s):
    """Strip markdown links/images to plain text for draft bodies."""
    import re
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s or "")
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    return s


def first_name(raw):
    n = str(raw or "").split(" ")[0].strip().strip(",.;:")
    return n


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
    today = date.fromisoformat(phoenix_today())
    now_iso = datetime.now(timezone.utc).isoformat()

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

    # 1) followup_draft from recent Fathom calls with action items
    if autonomy.get("draft_followups") in ("queue", "auto", "propose"):
        for c in companies:
            for r_ in c.get("recordings") or []:
                actions = [a for a in (r_.get("actions") or []) if a]
                if not actions:
                    continue
                d = day(r_.get("date"))
                if not d or days_ago(d, today) is None or days_ago(d, today) > RECENT_CALL_DAYS:
                    continue
                rid = r_.get("id") or ("recording-" + str(r_.get("nativeId") or ""))
                item_id = "q:followup_draft:" + str(rid).replace("recording-", "")
                refs = ok_refs(r_.get("refs")) + ok_refs(c.get("refs"))
                invitees = r_.get("invitees") or []
                ext = [i for i in invitees if i.get("email") and "opstream" not in str(i.get("email")).lower()]
                first = first_name(ext[0].get("name") or ext[0].get("email")) if ext else ""
                greeting = ("Hi %s," % first) if first else "Hi there,"
                summ = " ".join(clean_md(p.get("x") or p) if isinstance(p, dict) else clean_md(str(p))
                                for p in (r_.get("summary") or [])[:2])
                summ = " ".join(summ.split())[:420]
                body_lines = [greeting, "",
                              "Following our call on %s, here are the action items we captured:" % d,
                              ""]
                body_lines += ["- " + " ".join(clean_md(str(a)).split()) for a in actions[:8]]
                if summ:
                    body_lines += ["", summ]
                body_lines += ["", "Happy to pick a time to go through these together.", "", "Hollie"]
                draft_seed = {
                    "subject": "Following up — %s" % (c.get("name") or "our call"),
                    "body": "\n".join(body_lines),
                    "recipients": ", ".join((i.get("name") or i.get("email") or "")
                                            for i in ext[:3] if (i.get("name") or i.get("email"))),
                }
                item_hash = short_hash("followup", rid, "|".join(actions), r_.get("title"))
                candidates.append({
                    "id": item_id, "kind": "followup_draft",
                    "title": "Draft follow-up: %s%s" % (
                        r_.get("title") or c.get("name") or "call",
                        "%s%s" % (" (%s)" % d if d else "",
                                  ", %d action item%s" % (len(actions), "" if len(actions) == 1 else "s"))),
                    "company": c.get("name"), "companyId": c.get("id"),
                    "why": ("%d action item%s from the %s call \u2014 nothing since "
                            "suggests they were closed out." % (len(actions), "" if len(actions) == 1 else "s", d)),
                    "confidence": "high",
                    "confidenceNote": "Action items are Fathom's own; resolution is not tracked, so treat as owed until Hollie says otherwise.",
                    "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
                    "draftSeed": draft_seed,
                    "needsDecision": autonomy.get("draft_followups") == "propose",
                    "_hash": item_hash, "_sort": d or "",
                })

    # 2) stale_deal: open deals with no engagement in QUIET_DAYS+
    open_deals = []
    for c in companies:
        eng = co_eng.get(c.get("id"), {})
        last = eng.get("last")
        dq = days_ago(last, today) if last else None
        for d_ in c.get("deals") or []:
            if d_.get("closed"):
                continue
            if not is_open_pipeline({
                "stage": d_.get("stageLabel") or d_.get("stage"),
                "dealName": d_.get("name") or "",
                "close": d_.get("close"),
                "closed": False,
            }, today.isoformat()):
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
    for (c, d_, last, dq) in quiet[:CAPS["stale_deal"]]:
        did = d_.get("id") or ("deal-" + str(d_.get("nativeId") or ""))
        item_id = "q:stale_deal:" + str(did).replace("deal-", "")
        refs = ok_refs(d_.get("refs")) + ok_refs(c.get("refs"))
        if co_eng.get(c.get("id"), {}).get("ref"):
            refs = [co_eng[c.get("id")]["ref"]] + refs
        refs = ok_refs(refs)
        if dq is None:
            detail = d_.get("displayLine") or d_.get("name")
            why = (("No dated engagement is on file for %s, yet the %s deal is still open. "
                   "Worth checking whether it is real or should be closed.") % (
                       c.get("name"), detail))
            conf, conf_note = "low", "No engagement records found at all; the deal may simply be untracked."
        else:
            detail = d_.get("displayLine") or d_.get("name")
            why = (("No recorded engagement with %s in %d days. The %s deal has gone quiet.") % (
                c.get("name"), dq, detail))
            conf, conf_note = "medium", "Based on HubSpot engagements; other channels are not visible."
        candidates.append({
            "id": item_id, "kind": "stale_deal",
            "title": "Nudge %s — quiet %s" % (c.get("name"), ("%d days" % dq) if dq is not None else "with no engagement on file"),
            "company": c.get("name"), "companyId": c.get("id"),
            "deal": d_.get("name"), "dealId": did,
            "stage": d_.get("stageLabel"), "amount": d_.get("amount"),
            "daysQuiet": dq, "lastEngagement": last,
            "why": why, "confidence": conf, "confidenceNote": conf_note,
            "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
            "_hash": short_hash("stale", did, d_.get("stage"), last),
            "_sort": str(9999 - (dq or 9999)),
        })

    # 3) unworked_lead
    if autonomy.get("draft_followups") in ("queue", "auto", "propose"):
        leads = [l for l in (verified.get("leads") or []) if not l.get("mql")]
        leads.sort(key=lambda l: l.get("lead") or "", reverse=True)
        for l in leads[:CAPS["unworked_lead"]]:
            lid = l.get("id") or ("lead-" + str(l.get("name") or ""))
            item_id = "q:unworked_lead:" + str(lid).replace("lead-", "")
            candidates.append({
                "id": item_id, "kind": "unworked_lead",
                "title": "Qualify lead: %s" % (l.get("name") or "Unnamed"),
                "company": None, "companyId": None,
                "why": ("Lead from %s on %s has no MQL date — nobody has decided whether it is "
                        "worth a meeting yet." % (l.get("source") or "unknown source", l.get("lead") or "unknown date")),
                "confidence": "high",
                "confidenceNote": "Straight from the lead tracker.",
                "evidence": [], "drawerKeys": [],
                "lead": {"name": l.get("name"), "source": l.get("source"),
                         "leadDate": l.get("lead"), "owner": l.get("owner"), "note": l.get("note")},
                "_hash": short_hash("lead", lid, l.get("mql")),
                "_sort": l.get("lead") or "",
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
        for did, ms in list(by_deal.items())[:CAPS["sheet_review"]]:
            m0 = ms[0]
            c = deal_company.get(did)
            lines = []
            for m in ms:
                if m.get("field") == "stage":
                    lines.append("stage: sheet has it %s, HubSpot implies %s" % (
                        m.get("sheet"), m.get("hubspot")))
                else:
                    lines.append("%s: sheet says %s, HubSpot says %s" % (
                        m.get("field"), m.get("sheet"), m.get("hubspot")))
            refs = ok_refs(["hubspot:deals:" + did] + (c.get("refs") if c else []))
            candidates.append({
                "id": "q:sheet_review:" + did, "kind": "sheet_review",
                "title": "Which is right for %s?" % (m0.get("name") or "this deal"),
                "company": m0.get("company") or (c.get("name") if c else None),
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
        for s in (review.get("sheetOnly") or [])[:2]:
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

    for it in candidates:
        k = it["kind"]
        if k in ("sheet_review", "crm_update"):
            it["goal"] = "forecast"
        elif k == "unworked_lead":
            it["goal"] = "pipeline"
        elif k == "stale_deal":
            it["goal"] = bucket_of(it.get("stage")) or "pipeline"
        elif k in ("followup_draft", "meeting_prep"):
            it["goal"] = co_bucket.get(it.get("companyId")) or "pipeline"
        else:
            it["goal"] = "pipeline"

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
                "confidence": "high", "confidenceNote": "Calendar entry from the CRM extract.",
                "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
                "_hash": short_hash("mtgprep", mid, m.get("start")),
                "_sort": d,
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
                 "sheet_review": 3, "unworked_lead": 4, "crm_update": 5}
    queue.sort(key=lambda it: (kind_rank.get(it["kind"], 9), not it["isNew"], it.pop("_sort", "")))
    # stable numbering after sort
    for i, it in enumerate(queue, 1):
        it["n"] = i
    # per-kind caps (applied in rank order)
    seen = {}
    capped = []
    for it in queue:
        k = it["kind"]
        seen[k] = seen.get(k, 0) + 1
        if seen[k] <= CAPS.get(k, 8):
            capped.append(it)
    queue = capped
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
            acts = [a for a in (r_.get("actions") or []) if a]
            if not acts:
                continue
            d = day(r_.get("date"))
            if not d or (days_ago(d, today) or 9999) > RECENT_CALL_DAYS:
                continue
            rec_by_date.append((d, c, r_, acts))
    rec_by_date.sort(key=lambda t: t[0], reverse=True)
    owed = []
    for (d, c, r_, acts) in rec_by_date[:10]:
        refs = ok_refs(r_.get("refs"))
        owed.append({
            "recordingId": r_.get("id"), "title": r_.get("title"), "date": d,
            "company": c.get("name"), "companyId": c.get("id"),
            "actionCount": len(acts), "actions": [" ".join(str(a).split()) for a in acts[:3]],
            "queueId": "q:followup_draft:" + str(r_.get("id") or "").replace("recording-", ""),
            "evidence": refs, "drawerKeys": drawer_keys(refs, c.get("id")),
        })
    brief_followups = {"items": owed,
                       "note": None if owed else "No unresolved Fathom action items in the last %d days." % RECENT_CALL_DAYS}

    unworked_total = unworked_count(verified.get("leads") or [], review)
    new_leads = [l for l in (verified.get("leads") or []) if not l.get("mql")]
    new_leads.sort(key=lambda l: l.get("lead") or "", reverse=True)
    lead_items = [{"leadId": l.get("id"), "name": l.get("name"), "source": l.get("source"),
                   "leadDate": l.get("lead"), "owner": l.get("owner"), "note": l.get("note")}
                  for l in new_leads[:8]]
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
                  for dd in c.get("deals") or [] if not dd.get("closed")][:5]
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
                "actions": [" ".join(str(a).split()) for a in (r0.get("actions") or [])[:8]],
            }
        unresolved = []
        for r_ in recs:
            rd = day(r_.get("date"))
            if rd and (days_ago(rd, today) or 9999) <= RECENT_CALL_DAYS:
                for a in (r_.get("actions") or [])[:8]:
                    unresolved.append({"action": " ".join(str(a).split()),
                                       "from": r_.get("title"), "date": rd})
            if len(unresolved) >= 8:
                break
        agenda = []
        if unresolved:
            lc = last_call or {}
            agenda.append("Open actions from %s (%s): %d item%s" % (
                lc.get("title") or "the last call", lc.get("date") or "recent",
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
            if dq is not None and dq < 0:
                # Defensive: should not happen after the future-date filter above.
                agenda.append("Last engagement %s (date is in the future — check the record)" % eng["last"])
            else:
                agenda.append("Last engagement %s (%s ago)" % (
                    eng["last"], ("%d days" % dq) if dq is not None else "date unknown"))
        if not agenda:
            agenda.append("No recent context on file — use the first minutes to re-establish where things stand.")
        refs = ok_refs(m.get("refs")) + ok_refs(c.get("refs"))
        # Attendees: company contacts with titles (who is she talking to?)
        attendees = [{"name": p.get("name"), "title": p.get("title"), "email": p.get("email")}
                     for p in (c.get("contacts") or [])[:5] if p.get("name")]
        # Call goal: based on the most advanced open deal stage
        call_goal = None
        if open_d:
            top_deal = open_d[0]
            stage = (top_deal.get("stage") or "").lower()
            if "discovery" in stage or "rpf" in stage or "rfp" in stage:
                call_goal = "Understand their pain points and confirm there's a real fit — don't pitch yet."
            elif "demo" in stage:
                call_goal = "Show them the product solving their specific problem. Get a technical win."
            elif "decision" in stage or "legal" in stage or "compliance" in stage:
                call_goal = "Get to a clear yes or no. Surface any remaining blockers and agree on next steps."
            elif "stakeholder" in stage:
                call_goal = "Expand to the wider buying group. Identify the economic buyer."
            else:
                call_goal = "Move the %s deal forward — agree on concrete next steps." % top_deal.get("name")
        prep.append({
            "meetingId": m.get("id"), "title": m.get("title"), "start": m.get("start"),
            "outcome": m.get("outcome"), "company": c.get("name"), "companyId": cid,
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

    # ---------- goals: the queue, organized around Hollie's actual job ----------
    # Bucket open-deal value from the sheet-authoritative stage labels.
    bucket_value = {"commit": 0.0, "bestcase": 0.0, "pipeline": 0.0}
    for c in companies:
        for d_ in c.get("deals") or []:
            if d_.get("closed"):
                continue
            if not is_open_pipeline({
                "stage": d_.get("stageLabel") or d_.get("stage"),
                "dealName": d_.get("name") or "",
                "close": d_.get("close"),
                "closed": False,
            }, today.isoformat()):
                continue
            b = bucket_of(d_.get("stageLabel"))
            if b in bucket_value and d_.get("amount"):
                bucket_value[b] += d_["amount"]
    month = today.strftime("%Y-%m")
    month_name = today.strftime("%B")
    targets = {k: (b.get("targets") or {}).get(month) or 0
               for k, b in buckets.items()}
    lt = (review.get("leadTracker") or {})
    n_mismatch = len(review.get("mismatches") or [])
    n_no_amount = sum(1 for c in companies for d_ in (c.get("deals") or [])
                      if not d_.get("closed") and d_.get("amount") is None)

    def usd0(x):
        return "$%s" % f"{x:,.0f}"

    goal_defs = [
        ("commit", "Land the %s commit" % month_name,
         commit_versus_target(bucket_value["commit"], targets.get("commit")).get("text")
         or ("%s in commit stages" % usd0(bucket_value["commit"]))),
        ("bestcase", "Turn best case into commit",
         "%s sitting in %s" % (usd0(bucket_value["bestcase"]),
                                (buckets.get("bestcase") or {}).get("label") or "best-case stages")),
        ("pipeline", "Keep the pipeline fed",
         "%s early pipeline · %d unworked leads" % (
             usd0(bucket_value["pipeline"]), unworked_total)),
        ("forecast", "Keep the forecast honest",
         "%d sheet-vs-HubSpot mismatches · %d open deals missing amounts" % (
             n_mismatch, n_no_amount)),
    ]
    goals = [{"id": gid, "title": title, "status": status}
             for gid, title, status in goal_defs
             if any(it.get("goal") == gid for it in queue)]

    brief = {"generatedFor": today.isoformat(),
             "meetings": brief_meetings, "quietDeals": brief_quiet,
             "followupsOwed": brief_followups, "newLeads": brief_leads}

    out = {
        "generatedAt": now_iso,
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
                                      "sheet_review", "unworked_lead", "crm_update")},
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
