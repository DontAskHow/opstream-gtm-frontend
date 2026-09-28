#!/usr/bin/env python3
"""One run id for the brief, pulse, queue, fixes, and proposals.

Reads the collection already in OUT_DATA. Does not call HubSpot or Sheets.
Does not invent a second set of figures: every sentence quotes gtm_metrics.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_health
from draft_seeds import build as build_draft_seeds
from gtm_metrics import (run_id_now, commit_for_close_month, commit_versus_target, date_only,
                         is_junk_name, snapshot_age_hours, snapshot_metrics)

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("OUT_DATA") or (ROOT / "out" / "data"))


def load(name, default):
    try:
        return json.loads((DATA / name).read_text(encoding="utf-8"))
    except Exception:
        return default


def phoenix_stamp(iso):
    return date_only(iso) or ""


def phoenix_clock(iso):
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return ""
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    t = t.astimezone(timezone(timedelta(hours=-7)))
    hour = t.hour % 12 or 12
    return "%s %d, %d · %d:%02d %s Phoenix" % (t.strftime("%b"), t.day, t.year, hour, t.minute, "AM" if t.hour < 12 else "PM")


def money(n):
    try:
        return "$%s" % f"{round(float(n)):,}"
    except (TypeError, ValueError):
        return "not available"


def write(name, value):
    (DATA / name).write_text(json.dumps(value, indent=1), encoding="utf-8")


MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTHS_LONG = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")


def long_day(iso):
    """'2026-09-28' -> 'Sep 28, 2026'."""
    try:
        y, m, d = (int(x) for x in str(iso)[:10].split("-"))
        return "%s %d, %d" % (MONTHS[m - 1], d, y)
    except ValueError:
        return str(iso or "")


def month_name(key):
    """'2026-09' -> 'September 2026'."""
    try:
        y, m = (int(x) for x in str(key)[:7].split("-"))
        return "%s %d" % (MONTHS_LONG[m - 1], y)
    except ValueError:
        return str(key or "")


def main():
    records_path = DATA / "records.json"
    verified_path = DATA / "verified.json"
    if not records_path.is_file() or not verified_path.is_file():
        print("collection is missing. Refusing to invent data.", file=sys.stderr)
        return 1
    records = load("records.json", {})
    verified = load("verified.json", {})
    if "synthetic" in str(verified.get("snapshotId") or "").lower():
        print("refusing to stamp a synthetic snapshot", file=sys.stderr)
        return 1
    review = load("sheet-review.json", {})
    day = phoenix_stamp(records.get("generatedAt"))
    if not day:
        print("collection has no generatedAt", file=sys.stderr)
        return 1
    new_id = "brain-" + day
    for path, key in ((verified_path, "snapshotId"), (records_path, "verifiedSnapshotId")):
        text = path.read_text(encoding="utf-8")
        old = verified.get("snapshotId") if key == "snapshotId" else records.get("verifiedSnapshotId")
        if old and old != new_id and old in text:
            path.write_text(text.replace(old, new_id), encoding="utf-8")
    verified = load("verified.json", {})
    records = load("records.json", {})
    boot = load("bootstrap.json", {})
    boot["user"] = {"id": "team", "name": "Opstream team", "email": "", "owner": True}
    if "connections" not in boot:
        boot["connections"] = {"google": {"connected": False, "configured": False},
                               "slack": {"connected": False, "configured": False}}
    write("bootstrap.json", boot)

    now_iso = datetime.now(timezone.utc).isoformat()
    run_id = os.environ.get("GTM_RUN_ID") or run_id_now()
    env = os.environ.copy()
    env["OUT_DATA"] = str(DATA)
    env["GTM_RUN_ID"] = run_id
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "marketing-data.py")], env=env)
    if proc.returncode != 0:
        return proc.returncode
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "hollie-operator.py")], env=env)
    if proc.returncode != 0:
        return proc.returncode
    hollie = load("hollie.json", {})
    run_id = hollie.get("runId") or run_id
    marketing = load("marketing.json", {})
    verified = load("verified.json", {})
    verified.setdefault("presentation", {})["priorities"] = hollie.get("marketingPriorities") or []
    verified.setdefault("meta", {})["owners"] = marketing.get("team") or []
    write("verified.json", verified)
    write("draft-seeds.json", build_draft_seeds(marketing, hollie, records, day))

    book = snapshot_metrics(verified, records, today=day, sheet_review=review)
    month = day[:7]
    commit = commit_for_close_month(book.get("deals") or [], month, day)
    target = (((review.get("forecast") or {}).get("buckets") or {}).get("commit") or {}).get("targets") or {}
    target_n = target.get(month) or 0
    versus = commit_versus_target(commit["amount"], target_n)
    names = ", ".join(
        "%s %s (close %s)" % (d.get("companyName") or d.get("name") or "Deal",
                              money(d.get("amount")), long_day(d.get("close")) if d.get("close") else "not available")
        for d in commit["deals"]) or "none"
    largest = book.get("largest") or {}
    age = snapshot_age_hours(records.get("generatedAt"))
    age_h = None if age is None else round(age, 1)
    collected = records.get("generatedAt")
    open_line = "%s open deals: %s in the open pipeline, %s weighted, as of %s." % (
        book["openCount"], money(book["openAmount"]), money(book["weighted"]), long_day(day))
    funnel_line = "%s leads, %s MQLs and %s SQLs this quarter (%s – %s)." % (
        book["leads"], book["mql"], book["sql"], long_day(book["quarterStart"]), long_day(book["quarterEnd"]))
    largest_line = "Largest open deal: %s, %s." % (
        largest.get("company") or "not available",
        money(largest.get("amount")) if largest.get("amount") is not None else "amount not available")
    commit_line = (versus.get("text") or "Commit is not available") + ". Deals closing in %s: %s." % (month_name(month), names)
    meetings = ((hollie.get("brief") or {}).get("meetings") or {}).get("items") or []
    meeting_bits = []
    for m in meetings[:6]:
        start = str(m.get("start") or "")
        meeting_bits.append("%s (%s)" % (m.get("title") or "Meeting", phoenix_stamp(start) or start[:16]))
    meeting_line = "Meetings on the collection calendar for the snapshot day and the next day: " + (
        "; ".join(meeting_bits) if meeting_bits else "none in the extract.")

    brief = {
        "generatedAt": now_iso,
        "runId": run_id,
        "model": "facts",
        "greeting": "Figures below are the collection of %s (America/Phoenix)." % long_day(day),
        "paragraphs": [open_line, largest_line, funnel_line, commit_line, meeting_line],
        "whatsNew": [],
        "watchOuts": [
            "Sheet amount and close date are the figures in the open pipeline. A HubSpot difference is flagged on the account, not restated here.",
            "Sales qualified counts a recording or a CRM meeting marked held. Meetings completed counts CRM outcome completed only.",
        ],
        "topActions": [],
        "facts": {
            "openCount": book["openCount"],
            "openAmount": book["openAmount"],
            "weighted": book["weighted"],
            "leads": book["leads"],
            "mql": book["mql"],
            "sql": book["sql"],
            "commit": commit["amount"],
            "commitMonth": month,
            "asOf": day,
        },
    }
    heartbeat = {
        "generatedAt": now_iso,
        "runId": run_id,
        "model": "facts",
        "summary": "Collection health only. Pipeline figures are in the morning brief.",
        "health": {"snapshotAgeHours": age_h, "asOf": day, "collectedAt": collected},
        "insights": source_health.insights(marketing.get("sources")) + [{
            "title": "Snapshot age",
            "detail": ("Collected %s. The age is worked out when the page opens."
                       % (phoenix_clock(collected) or "at an unrecorded time")),
        }],
        "state": {},
    }
    fixes = {"generatedAt": now_iso, "runId": run_id, "model": "facts", "fixes": []}
    # Mismatches stay in the queue. Do not copy them into Needs your decision.
    proposals = []
    for row in load("crm-proposals.json", []):
        if not isinstance(row, dict):
            continue
        blob = " ".join(str(row.get(k) or "") for k in ("company", "deal", "rationale", "title"))
        if is_junk_name(blob):
            continue
        if str(row.get("field") or "").lower() in ("stage", "amount", "close date", "close"):
            continue
        row = dict(row)
        row["runId"] = run_id
        proposals.append(row)
    write("agent-brief.json", brief)
    write("heartbeat.json", heartbeat)
    write("heartbeat-fixes.json", fixes)
    write("crm-proposals.json", proposals)
    facts_path = DATA / "run-facts.json"
    facts_path.write_text(json.dumps({
        "runId": run_id,
        "asOf": day,
        "openCount": book["openCount"],
        "openAmount": book["openAmount"],
        "weighted": book["weighted"],
        "leads": book["leads"],
        "mql": book["mql"],
        "sql": book["sql"],
        "commitAmount": commit["amount"],
        "commitDeals": [d.get("companyName") or d.get("name") for d in commit["deals"]],
        "collectedAt": collected,
    }, indent=1), encoding="utf-8")
    stamp_run_id(DATA, run_id)
    print("align-run %s open %s %s" % (run_id, book["openCount"], book["openAmount"]))
    return 0


def stamp_run_id(data_dir, run_id):
    """Every JSON object in the snapshot carries this run. Arrays stay arrays."""
    for path in sorted(Path(data_dir).glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict):
            if data.get("runId") == run_id:
                continue
            data["runId"] = run_id
            path.write_text(json.dumps(data, indent=1), encoding="utf-8")
        elif isinstance(data, list):
            changed = False
            for row in data:
                if isinstance(row, dict) and row.get("runId") != run_id:
                    row["runId"] = run_id
                    changed = True
            if changed:
                path.write_text(json.dumps(data, indent=1), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
