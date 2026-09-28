#!/usr/bin/env python3
"""Hollie's proactive morning brief — LLM-written, diff-aware, grounded.

Reads out/data/hollie.json (the invisible operator's queue + prep), diffs it
against the previous brief, and asks OpenAI (via the vault-backed
~/workspace/skills/openai/bin/chat.py CLI) to write a short, sharp narrative
briefing for Hollie: what changed, what to do first and why, what to watch.

Writes out/data/agent-brief.json. FAIL-SOFT: any error (no key, API failure,
bad output) leaves the previous brief file untouched and exits 0 — the build
must never break because the brief couldn't regenerate.

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
from gtm_metrics import date_only, greeting, phoenix_prose, phoenix_today, phoenix_when, snapshot_metrics
from openai_direct import chat_completion, complete_json

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("OUT_DATA") or os.path.join(REPO, "out", "data")
HOLLIE_JSON = os.path.join(DATA, "hollie.json")
BRIEF_JSON = os.path.join(DATA, "agent-brief.json")
CHAT_CLI = os.path.expanduser("~/workspace/skills/openai/bin/chat.py")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-6-luna")


def log(msg):
    print(f"[agent-brief] {msg}", file=sys.stderr)


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def call_openai(payload):
    key = os.environ.get("OPENAI_API_KEY") or ""
    if key and not os.path.exists(CHAT_CLI):
        return chat_completion(payload, key)
    # NOTE: do not use subprocess.run(input=...) here — in this environment
    # writing to stdin explicitly is the reliable pattern (see agent-server.mjs).
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


def main():
    if os.environ.get("GTM_FACTS_ONLY") == "1":
        log("facts brief already written for this run")
        return 0
    hop = load_json(HOLLIE_JSON)
    if not hop or not isinstance(hop.get("queue"), list):
        log("hollie.json missing or has no queue — skipping (fail-soft).")
        return 0

    prev = load_json(BRIEF_JSON) or {}
    prev_ids = set(prev.get("itemIds") or [])

    queue = hop["queue"][:18]
    cur_ids = [q.get("id") for q in queue if q.get("id")]
    new_items = [q for q in queue if q.get("id") in (set(cur_ids) - prev_ids)][:6]

    def qline(q):
        return {
            "id": q.get("id"),
            "kind": q.get("kind"),
            "goal": q.get("goal"),
            "title": q.get("title"),
            "why": q.get("why"),
            "isNew": bool(q.get("isNew") or q.get("id") in (set(cur_ids) - prev_ids)),
        }

    def items_of(section):
        # Operator brief sections are {"items": [...], "note": ...}; tolerate lists too.
        if isinstance(section, dict):
            return section.get("items") or []
        return section or []

    today_phx = phoenix_today()
    prep = (hop.get("prep") or [])[:6]
    preplines = [
        {
            "title": p.get("title"),
            "when": phoenix_when(p.get("start"), today_phx),
            "company": p.get("company"),
            "agenda": (p.get("suggestedAgenda") or [])[:4],
        }
        for p in prep
    ]
    brief = hop.get("brief") or {}
    stats = hop.get("stats") or {}

    verified = load_json(os.path.join(DATA, "verified.json"))
    records = load_json(os.path.join(DATA, "records.json"))
    review = load_json(os.path.join(DATA, "sheet-review.json"))
    today = date_only((records or {}).get("generatedAt")) if records else None
    book = snapshot_metrics(verified, records, today=today, sheet_review=review) if verified and records else None
    open_book = None
    if book:
        open_book = {
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
        }

    data_dump = {
        "now": phoenix_when(datetime.now(timezone.utc).isoformat(), today_phx) + " America/Phoenix",
        "openBook": open_book,
        "briefCounts": stats.get("briefCounts"),
        "goals": hop.get("goals") or [],
        "queue": [qline(q) for q in queue],
        "newItems": [qline(q) for q in new_items],
        "upcomingPrep": preplines,
        "briefMeetings": [
            {"title": m.get("title"), "when": phoenix_when(m.get("start"), today_phx)}
            for m in items_of(brief.get("meetings"))[:5]
            if not m.get("start") or str(m.get("start")) >= datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        ],
    }

    system = (
        "You write the marketing lead's morning briefing for the Opstream GTM workspace. "
        "Hollie runs marketing at Opstream. An automated operator ranked her action queue; "
        "you turn it into a short, sharp, human briefing she reads first thing.\n\n"
        "RULES:\n"
        "- Ground EVERY claim in the data below. Never invent companies, people, dates, amounts, or meetings.\n"
        "- Numbers in briefCounts, openBook, and goal status lines are already computed. Repeat them exactly. Do not call a larger commit 'short' of a smaller forecast.\n"
        "- openBook is the page's open pipeline: the master sheet's active new-business rows. A past close date stays in that book and is marked close date passed; it is left out of the monthly commit. Renewals, current agreements, Disqualified, and On Hold are not in it. A HubSpot deal that is not on the sheet is not in the total. Repeat the largest open deal and the open totals. A larger renewal or current agreement is not the largest open deal; if you mention one, say it is not in the open book.\n"
        "- collectedAt is when these files were generated. Repeat it. Do not present the figures as newer than that collection.\n"
        "- Owner labels in openBook are already resolved. Unassigned means no owner name is on file. Do not invent a person's name.\n"
        "- The greeting must start with \"" + greeting() + "\" because that is the time of day in America/Phoenix. Do not say a different time of day.\n"
        "- Every time is already written in America/Phoenix with (today) or (tomorrow) where it applies. Repeat those words; never write a UTC time or a raw timestamp. A meeting marked (tomorrow) is not today.\n"
        "- If something is unknown, say so or omit it — never fill gaps with guesses.\n"
        "- Be concrete: names, numbers, days. No corporate fluff, no hype.\n"
        "- Keep it skimmable: short paragraphs, tight bullets.\n"
        "- Frame the briefing around her goals (the 'goals' list): lead with the commit goal, then pipeline, then forecast honesty.\n"
        "- Items with isNew true are new. Mention them in whatsNew. Never print internal field names.\n"
        "- End with genuine uncertainty where it exists (e.g. ambiguous meeting ownership, missing stage labels).\n"
        "- Reply with strict JSON only, matching the requested schema."
    )
    user = (
        "Write Hollie's morning briefing from this operator output:\n\n"
        + json.dumps(data_dump, ensure_ascii=False)[:14000]
        + "\n\nRespond with strict JSON: {"
        '"greeting": "one warm, specific opening line referencing today\'s shape (not generic)", '
        '"paragraphs": ["2-4 short paragraphs: what changed, what matters most, why"], '
        '"whatsNew": ["up to 5 bullets, only things genuinely new or changed"], '
        '"watchOuts": ["up to 4 bullets: risks, stale deals, ambiguity, things that could slip"], '
        '"topActions": [{"title": "...", "why": "one-line reason"}] (max 3, mirror the queue ranking)'
        "}"
    )

    try:
        parsed = complete_json(call_openai, {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }, log)
    except Exception as e:
        log(f"No usable model output, keeping previous brief: {type(e).__name__}: {str(e)[:200]}")
        return 0
    if not isinstance(parsed, dict):
        log("Model output is not a JSON object, keeping previous brief.")
        return 0

    # Validate shape; drop anything malformed rather than shipping it.
    def strlist(v, n):
        return [phoenix_prose(str(x), today_phx)[:400] for x in (v or []) if isinstance(x, str)][:n]

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "runId": hop.get("runId"),
        "model": MODEL,
        "greeting": phoenix_prose(str(parsed.get("greeting") or ""), today_phx)[:300],
        "paragraphs": strlist(parsed.get("paragraphs"), 5),
        "whatsNew": strlist(parsed.get("whatsNew"), 6),
        "watchOuts": strlist(parsed.get("watchOuts"), 5),
        "topActions": [
            {"title": str(a.get("title", ""))[:140], "why": str(a.get("why", ""))[:240]}
            for a in (parsed.get("topActions") or [])
            if isinstance(a, dict) and a.get("title")
        ][:3],
        "itemIds": cur_ids,
        "queueSize": len(hop["queue"]),
    }
    if not out["paragraphs"] and not out["whatsNew"]:
        log("Model returned an empty brief — keeping previous file.")
        return 0
    if book and book.get("openAmount") is not None:
        label = "$%s" % f"{round(book['openAmount']):,}"
        blob = " ".join(out["paragraphs"] + [out["greeting"]])
        if label not in blob:
            log("model did not repeat the open-book amount %s — keeping the facts brief" % label)
            return 0

    tmp = BRIEF_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, BRIEF_JSON)
    log(f"wrote {BRIEF_JSON} ({len(out['paragraphs'])} paras, {len(out['whatsNew'])} new, {len(out['watchOuts'])} watch-outs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
