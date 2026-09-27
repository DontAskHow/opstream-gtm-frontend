#!/usr/bin/env python3
"""Dashboard heartbeat — the agent periodically tends the GTM workspace.

Runs when build.cjs calls it, after agent-brief.py. This repository does not
start it on a timer.
It does three things:

1. HEALTH CHECK — verifies the product is alive and complete: data freshness
   (snapshot age), build completeness (every expected out/data file present and
   parseable), queue/mismatch volumes vs. last beat.

2. PROACTIVE INSIGHTS — diffs the current operator queue, sheet mismatches,
   and deal state against the previous heartbeat, then asks OpenAI (via the
   vault-backed ~/workspace/skills/openai/bin/chat.py CLI) to surface 3-5
   sharp, specific, actionable observations: new risks, new opportunities,
   resolved items worth noting, data-health flags.

3. FIXES — turns what's off into prepared fixes, not just findings. Mismatch
   resolutions become CRM proposals (queued in out/data/crm-proposals.json for
   human approve/decline; nothing is ever written to HubSpot). Quiet-big-deal
   follow-ups become complete draft emails and open questions go to
   out/data/heartbeat-fixes.json, rendered in the dashboard Pulse section with
   one-tap actions.

Writes out/data/heartbeat.json, rendered by the dashboard as the "Pulse"
section of the Briefing view. FAIL-SOFT: any error (no key, API failure, bad
output) leaves the previous heartbeat untouched and exits 0 — the build must
never break because the heartbeat couldn't beat.

The raw API key never appears here; auth goes through the skill CLI's
vault-backed surrogate credential.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gtm_metrics import greeting, phoenix_today, snapshot_metrics

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("OUT_DATA") or os.path.join(REPO, "out", "data")
HEARTBEAT_JSON = os.path.join(DATA, "heartbeat.json")
CHAT_CLI = os.path.expanduser("~/workspace/skills/openai/bin/chat.py")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-6-luna")

EXPECTED_FILES = [
    "verified.json", "records.json", "evidence.json", "hollie.json",
    "sheet-review.json", "agent-brief.json", "bootstrap.json",
]


def log(msg):
    print(f"[heartbeat] {msg}", file=sys.stderr)


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def call_openai(payload):
    key = os.environ.get("OPENAI_API_KEY") or ""
    if key and not os.path.exists(CHAT_CLI):
        from openai_direct import chat_completion
        return chat_completion(payload, key)
    proc = subprocess.Popen(
        ["python3", CHAT_CLI],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    out, err = proc.communicate(json.dumps(payload).encode("utf-8"), timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"chat CLI failed: {err.decode('utf-8', 'replace')[-500:]}")
    return json.loads(out.decode("utf-8"))


def health_check():
    """Deterministic product health: freshness + completeness."""
    notes = []
    status = "ok"
    now = datetime.now(timezone.utc)

    missing, unparseable = [], []
    for name in EXPECTED_FILES:
        d = load_json(os.path.join(DATA, name))
        if d is None:
            # distinguish missing file from unparseable content
            if not os.path.exists(os.path.join(DATA, name)):
                missing.append(name)
            else:
                unparseable.append(name)
    if missing:
        status = "warning"
        notes.append("Missing data files: " + ", ".join(missing))
    if unparseable:
        status = "warning"
        notes.append("Unparseable data files: " + ", ".join(unparseable))

    # Freshness of the company-brain snapshot.
    rec = load_json(os.path.join(DATA, "records.json")) or {}
    gen = rec.get("generatedAt")
    age_h = None
    if gen:
        try:
            age_h = (now - datetime.fromisoformat(gen)).total_seconds() / 3600
            if age_h > 30:
                status = "warning"
                notes.append(f"Company data is {age_h:.0f}h old — refresh may be stuck.")
        except Exception:
            notes.append("Could not parse records.json generatedAt.")
    else:
        status = "warning"
        notes.append("records.json has no generatedAt timestamp.")

    ver = load_json(os.path.join(DATA, "verified.json")) or {}
    if ver.get("snapshotId") != rec.get("verifiedSnapshotId"):
        status = "warning"
        notes.append("Snapshot mismatch: verified.json and records.json disagree on snapshotId.")

    hop = load_json(os.path.join(DATA, "hollie.json")) or {}
    q = hop.get("queue") or []
    if not q:
        status = "warning" if status == "ok" else status
        notes.append("Operator queue is empty — nothing ranked for Hollie.")
    sr = load_json(os.path.join(DATA, "sheet-review.json")) or {}
    mm = sr.get("mismatches") or []
    lt = sr.get("leadTracker") or {}
    if not notes:
        notes.append("All expected data files present and parseable.")

    return {
        "status": status,
        "notes": notes[:6],
        "snapshotAgeHours": round(age_h, 1) if age_h is not None else None,
        "queueSize": len(q),
        "mismatchCount": len(mm),
        "unworkedLeads": lt.get("unworked"),
    }


def append_heartbeat_proposals(proposals):
    """Mismatches stay in the operator queue only. Nothing is written to HubSpot."""
    return 0
    """Queue mismatch resolutions as CRM proposals (human approves; nothing
    touches HubSpot). Dedupes against already-proposed items. Returns count added."""
    path = os.path.join(DATA, "crm-proposals.json")
    existing = load_json(path)
    if not isinstance(existing, list):
        existing = []

    def key(p):
        return (str(p.get("company") or ""), str(p.get("deal") or ""),
                str(p.get("field") or ""), str(p.get("proposedValue") or ""))

    seen = set(key(p) for p in existing if isinstance(p, dict) and p.get("status") == "proposed")
    now = datetime.now(timezone.utc).isoformat()
    added = 0
    for pr in proposals:
        if not isinstance(pr, dict) or not pr.get("field") or not pr.get("proposedValue"):
            continue
        k = key(pr)
        if k in seen:
            continue
        seen.add(k)
        existing.append({
            "company": str(pr.get("company") or ""),
            "deal": str(pr.get("deal") or ""),
            "field": str(pr.get("field") or ""),
            "currentValue": str(pr.get("currentValue") or "unknown"),
            "proposedValue": str(pr.get("proposedValue") or ""),
            "rationale": str(pr.get("rationale") or "")[:400],
            "status": "proposed",
            "at": now,
            "by": "heartbeat",
        })
        added += 1
        if added >= 10:
            break
    if added:
        # keep the file bounded; heartbeat proposals are the oldest to age out
        existing = existing[-500:]
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(existing, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    return added


def mismatch_proposals(mismatches):
    """Deterministic fix for sheet-vs-HubSpot mismatches: the sheet is
    authoritative, so each mismatch becomes a proposal carrying the sheet
    value. No LLM needed — the rule is mechanical."""
    out = []
    for m in (mismatches or [])[:10]:
        if not isinstance(m, dict):
            continue
        field, sheet, hub = m.get("field"), m.get("sheet"), m.get("hubspot")
        if not field or not sheet:
            continue
        company = str(m.get("company") or m.get("name") or "")
        out.append({
            "type": "proposal",
            "title": f"{company} · {field} fix ready" if company else f"{field} fix ready",
            "detail": "Sheet and HubSpot disagree — the sheet value is queued for your approval.",
            "company": company[:120],
            "deal": str(m.get("name") or "")[:160],
            "field": str(field)[:80],
            "currentValue": str(hub or "")[:200],
            "proposedValue": str(sheet)[:200],
            "rationale": (f"Sheet shows '{sheet}' vs HubSpot '{hub}'. "
                          "Per the working rule the sheet is authoritative over HubSpot.")[:400],
            "draftSubject": "", "draftText": "", "question": "",
        })
    return out


def build_fixes(missing_amount_deals, quiet_deals):
    """Turn problems into prepared fixes (drafts + open questions). Fail-soft: any error returns []."""
    fix_dump = {
        "dealsMissingAmounts": [
            {"name": o.get("name"), "stage": o.get("stage"), "close": o.get("close")}
            for o in (missing_amount_deals or [])[:12]
        ],
        "quietBigDeals": [
            {"name": o.get("companyName") or o.get("name"), "dealName": o.get("dealName") or "",
             "stage": o.get("stage"), "amount": o.get("amount"),
             "owner": o.get("ownerLabel"),
             "days": o.get("days"), "daysQuiet": o.get("daysQuiet"), "close": o.get("close"),
             "note": (o.get("note") or "")[:200]}
            for o in (quiet_deals or [])[:4]
        ],
    }
    if not any(fix_dump.values()):
        return []

    system = (
        "You turn GTM workspace problems into concrete, ready-to-use fixes. "
        "Standing rules: never invent amounts, dates, contacts, or email addresses.\n\n"
        "For each problem, produce exactly one fix:\n"
        "- quiet big deal: type 'draft'. Write the actual follow-up email — draftSubject "
        "and draftText (under 180 words), grounded in the deal's stage and daysQuiet. "
        "daysQuiet is already computed; repeat it. These deals are in the open book. "
        "Maximum 3 drafts; pick the biggest amounts.\n"
        "- deals missing amounts: a SINGLE type 'ask' fix listing the deals by name, "
        "asking who owns backfilling them. Never guess an amount.\n"
        "Reply with strict JSON only: {\"fixes\": [{\"type\": \"draft|ask\", "
        "\"title\": \"...\", \"detail\": \"...\", \"company\": \"...\", \"deal\": \"...\", "
        "\"draftSubject\": \"...\", \"draftText\": \"...\", "
        "\"question\": \"...\"}]}. Maximum 4 fixes. Omit fields that do not apply."
    )
    user = (
        "Prepare fixes for these workspace problems:\n\n"
        + json.dumps(fix_dump, ensure_ascii=False)[:12000]
    )
    try:
        resp = call_openai({
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_completion_tokens": 2500,
            "response_format": {"type": "json_object"},
        })
        content = (resp.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1] if "\n" in content else ""
            content = content.rsplit("```", 1)[0]
        parsed = json.loads(content)
    except Exception as e:
        log(f"fixes pass failed, skipping: {e}")
        return []

    out = []
    for fx in (parsed.get("fixes") or [])[:6]:
        if not isinstance(fx, dict) or not fx.get("title"):
            continue
        t = str(fx.get("type", "")).lower()
        if t not in ("draft", "ask"):
            continue
        if t == "draft" and not fx.get("draftText"):
            continue
        out.append({
            "type": t,
            "title": str(fx["title"])[:160],
            "detail": str(fx.get("detail") or "")[:400],
            "company": str(fx.get("company") or "")[:120],
            "deal": str(fx.get("deal") or "")[:160],
            "field": str(fx.get("field") or "")[:80],
            "currentValue": str(fx.get("currentValue") or "")[:200],
            "proposedValue": str(fx.get("proposedValue") or "")[:200],
            "rationale": str(fx.get("rationale") or "")[:400],
            "draftSubject": str(fx.get("draftSubject") or "")[:160],
            "draftText": str(fx.get("draftText") or "")[:2000],
            "question": str(fx.get("question") or "")[:500],
        })
    return out


def main():
    if os.environ.get("GTM_FACTS_ONLY") == "1":
        log("facts pulse already written for this run")
        return 0
    ver = load_json(os.path.join(DATA, "verified.json"))
    hop = load_json(os.path.join(DATA, "hollie.json"))
    sr = load_json(os.path.join(DATA, "sheet-review.json"))
    if not ver or not hop:
        log("verified.json or hollie.json missing — skipping (fail-soft).")
        return 0

    health = health_check()

    prev = load_json(HEARTBEAT_JSON) or {}
    prev_state = prev.get("state") or {}
    prev_qids = set(prev_state.get("queueIds") or [])
    prev_mmkeys = set(prev_state.get("mismatchKeys") or [])

    queue = hop.get("queue") or []
    qids = [q.get("id") for q in queue if q.get("id")]
    new_items = [q for q in queue if q.get("id") in (set(qids) - prev_qids)][:8]
    resolved_items = [i for i in (prev_state.get("queueIds") or []) if i not in set(qids)][:8]

    def qline(q):
        return {
            "id": q.get("id"), "kind": q.get("kind"), "goal": q.get("goal"),
            "title": q.get("title"), "why": (q.get("why") or "")[:240],
        }

    mismatches = sr.get("mismatches") or [] if sr else []
    def mmkey(m):
        return f"{m.get('dealId')}|{m.get('field')}"
    mmkeys = [mmkey(m) for m in mismatches]
    new_mm = [m for m in mismatches if mmkey(m) not in prev_mmkeys][:6]

    today = phoenix_today()
    rec = load_json(os.path.join(DATA, "records.json")) or {}
    book = snapshot_metrics(ver, rec, today)
    open_deals = book.get("openDeals") or []

    def opline(o):
        return {
            "name": o.get("companyName") or o.get("name"),
            "dealName": o.get("dealName") or "",
            "company": o.get("companyName") or o.get("name"),
            "stage": o.get("stage"), "amount": o.get("amount"),
            "owner": o.get("ownerLabel"),
            "daysQuiet": o.get("daysQuiet"), "close": o.get("close"),
            "inOpenBook": True,
        }
    # Quiet days and the open book come from the shared computation, not days-in-stage.
    # No recorded engagement counts as quiet, matching the page.
    quiet_commit = sorted(
        [o for o in open_deals if o.get("daysQuiet") is None or (o.get("daysQuiet") or 0) >= 14],
        key=lambda o: (o.get("amount") or 0), reverse=True,
    )[:6]

    goals = hop.get("goals") or []
    data_dump = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "health": health,
        "goals": [{"title": g.get("title"), "status": g.get("status")} for g in goals],
        "queueSize": len(queue),
        "newQueueItems": [qline(q) for q in new_items],
        "resolvedQueueIds": resolved_items,
        "queueTop": [qline(q) for q in queue[:8]],
        "newMismatches": [
            {"deal": m.get("name"), "company": m.get("company"), "field": m.get("field"),
             "sheet": str(m.get("sheet"))[:80], "hubspot": str(m.get("hubspot"))[:80]}
            for m in new_mm
        ],
        "mismatchCount": len(mismatches),
        "quietBigDeals": [opline(o) for o in quiet_commit],
        "openBook": {
            "definition": book.get("definition"),
            "asOf": book.get("today"),
            "quarter": [book.get("quarterStart"), book.get("quarterEnd")],
            "openCount": book.get("openCount"),
            "openAmount": book.get("openAmount"),
            "weighted": book.get("weighted"),
            "largestOpenDeal": book.get("largest"),
            "leads": book.get("leads"),
            "mql": book.get("mql"),
            "sql": book.get("sql"),
            "collectedAt": book.get("collectedAt"),
        },
        "firstBeat": not bool(prev_state),
    }

    system = (
        "You are the proactive analyst tending the Opstream GTM dashboard — a live "
        "workspace where Hollie (marketing lead) works her pipeline. Every few hours you "
        "check the product's pulse and surface what genuinely deserves attention.\n\n"
        "RULES:\n"
        "- Ground EVERY claim in the data below. Never invent companies, people, dates, or amounts.\n"
        "- Quiet-day figures are already computed (daysQuiet). Repeat those numbers; do not calculate another.\n"
        "- openBook is the page's open pipeline. It excludes past close dates, renewals, current agreements, Disqualified, and On Hold. Repeat openBook counts, amounts, and largestOpenDeal. A renewal is not an open deal and is not the largest open deal.\n"
        "- collectedAt is when these files were generated. Repeat it. Do not present the figures as newer than that collection.\n"
        "- Owner labels are already resolved. A label like Owner #… means the name is not connected. Do not invent a person's name.\n"
        "- It is " + greeting() + " in America/Phoenix. Match that time of day if you greet anyone.\n"
        "- Be specific and actionable: name the deal/company, the number, the implication.\n"
        "- Prefer new/changed things (newQueueItems, newMismatches, resolved items) over restating the standing queue.\n"
        "- If the health check flags a warning, include it as an insight with kind 'health'.\n"
        "- If there is genuinely nothing new, say so plainly with 1-2 insights max — do not pad.\n"
        "- Each insight: one-line title + 1-2 sentence detail with a concrete next step where one exists.\n"
        "- priority: 'high' only for commit-goal risk or data-health problems; else 'medium'/'low'.\n"
        "- Reply with strict JSON only, matching the requested schema."
    )
    user = (
        "Check the pulse of this GTM workspace and surface what's worth knowing:\n\n"
        + json.dumps(data_dump, ensure_ascii=False)[:15000]
        + "\n\nRespond with strict JSON: {"
        '"insights": [{"title": "...", "detail": "...", "priority": "high|medium|low", "kind": "risk|opportunity|health|resolved|info"}] (3-5, fewer if quiet), '
        '"summary": "one sentence on the overall pulse"'
        "}"
    )

    try:
        resp = call_openai(
            {
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "max_completion_tokens": 1200,
                "response_format": {"type": "json_object"},
            }
        )
    except Exception as e:
        log(f"OpenAI call failed, keeping previous heartbeat: {e}")
        return 0
    try:
        content = (resp.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1] if "\n" in content else ""
            content = content.rsplit("```", 1)[0]
        parsed = json.loads(content)
    except Exception as e:
        log(f"Could not parse model output, keeping previous heartbeat: {e}")
        return 0

    def clean_insights(raw):
        out = []
        for ins in (raw or [])[:6]:
            if not isinstance(ins, dict) or not ins.get("title"):
                continue
            pr = str(ins.get("priority", "medium")).lower()
            if pr not in ("high", "medium", "low"):
                pr = "medium"
            kind = str(ins.get("kind", "info")).lower()
            if kind not in ("risk", "opportunity", "health", "resolved", "info"):
                kind = "info"
            out.append({
                "title": str(ins["title"])[:160],
                "detail": str(ins.get("detail") or "")[:500],
                "priority": pr,
                "kind": kind,
            })
        return out

    insights = clean_insights(parsed.get("insights"))
    if not insights:
        log("Model returned no insights — keeping previous heartbeat.")
        return 0

    # FIXES PASS — turn what's off into prepared fixes, not just findings.
    # Mismatch resolutions are deterministic (sheet is authoritative over HubSpot)
    # and go straight to the CRM proposal queue for human approve/decline —
    # nothing is ever written to HubSpot. Drafts and open questions go to
    # heartbeat-fixes.json for one-tap action in the dashboard.
    missing_amt = [o for o in open_deals if not o.get("amount")][:12]
    proposals = mismatch_proposals(mismatches)
    n_proposed = append_heartbeat_proposals(proposals) if proposals else 0
    fixes = build_fixes(missing_amt, quiet_commit)
    if fixes:
        fpath = os.path.join(DATA, "heartbeat-fixes.json")
        fout = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "model": MODEL,
            "fixes": fixes,
        }
        tmp = fpath + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(fout, f, ensure_ascii=False, indent=1)
        os.replace(tmp, fpath)

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "model": MODEL,
        "summary": str(parsed.get("summary") or "")[:300],
        "health": health,
        "insights": insights,
        "state": {"queueIds": qids, "mismatchKeys": mmkeys},
    }
    tmp = HEARTBEAT_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, HEARTBEAT_JSON)
    log(f"wrote {HEARTBEAT_JSON} ({len(insights)} insights, {len(fixes)} fixes, {n_proposed} proposals queued, health={health['status']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
