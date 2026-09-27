#!/usr/bin/env python3
"""Sheet review: reconcile the manually-maintained pipeline sheet against HubSpot.

The Opstream team tracks pipeline stages by hand in the `pipeline_meeting1_v2`
Google Sheet (HS_Data tab) and their forecast in its Forecast tab. HubSpot is
updated too, but the sheet is where the humans actually work — so this review
treats the sheet as the reference and flags everywhere the two disagree.

Reads ~/workspace/brain/brain.db (kept current by the daily sheets sync),
writes out/data/sheet-review.json. Runs inside build.cjs after brain-data.py
and before hollie-operator.py, so every dashboard refresh re-reviews the sheet.

Output:
  forecast   - parsed buckets (commit / bestcase / pipeline) with stage keywords
               and monthly targets per owner
  mismatches - per-deal sheet-vs-HubSpot differences (stage bucket, amount,
               close date, owner) for open deals
  sheetOnly  - open deals on the sheet with no HubSpot deal in the extract
  leadTracker- manual lead tracker rollup (unworked / MQL-no-SQL counts)
  generatedAt
"""
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out" / "data" / "sheet-review.json"
DB = os.path.expanduser("~/workspace/brain/brain.db")
SHEET = "pipeline_meeting1_v2"

MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
          "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}


def q(cur, sql, args=()):
    cur.execute(sql, args)
    return cur.fetchall()


def sheet_rows(cur, tab):
    rows = []
    for rn, rj in q(cur,
            "select row_num, row_json from sheets_data "
            "where spreadsheet_title=? and tab=? order by row_num", (SHEET, tab)):
        try:
            row = json.loads(rj)
        except Exception:
            continue
        if isinstance(row, list):
            rows.append((rn, row))
    return rows


def num(x):
    if x is None or x == "":
        return None
    try:
        return float(str(x).replace("$", "").replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def parse_mdy(s):
    """'12/30/2026' -> '2026-12-30'. None if unparseable."""
    if not s:
        return None
    m = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{2,4})\s*$", str(s))
    if not m:
        return None
    mo, da, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if yr < 100:
        yr += 2000
    try:
        return "%04d-%02d-%02d" % (yr, mo, da)
    except Exception:
        return None


def month_key(cell):
    """\"Sep '26\" -> '2026-09'. None if unparseable."""
    m = re.match(r"\s*([A-Za-z]{3,9})\s*'?(\d{2,4})\s*$", str(cell or ""))
    if not m:
        return None
    mo = MONTHS.get(m.group(1)[:3].lower())
    if not mo:
        return None
    yr = int(m.group(2))
    if yr < 100:
        yr += 2000
    return "%04d-%02d" % (yr, mo)


def parse_forecast(rows):
    """Parse the Forecast tab into bucket definitions + monthly targets."""
    buckets = {
        "commit":   {"stages": ["decision", "legal & compliance", "legal and compliance"],
                     "targets": {}, "label": "Commit (70–90%)"},
        "bestcase": {"stages": ["wider stakeholders", "wider stakeholder"],
                     "targets": {}, "label": "Best Case (40%)"},
        "pipeline": {"stages": ["sql", "discovery", "demo"],
                     "targets": {}, "label": "Pipeline (<50%)"},
    }
    # The definition row looks like:
    # "Commit = Decision + Legal & Compliance (70–90%)     Best Case = Wider Stakeholders (40%)     Pipeline = SQL + Discovery + Demo (5–25%)"
    for _rn, row in rows:
        joined = " ".join(str(c) for c in row if c)
        if "Commit =" in joined and "Best Case" in joined:
            for key, name in (("commit", "Commit"), ("bestcase", "Best Case"),
                              ("pipeline", "Pipeline")):
                m = re.search(re.escape(name) + r"\s*=\s*([^=]+?)(?=\s{2,}|$)", joined)
                if not m:
                    continue
                seg = m.group(1)
                seg = re.sub(r"\([\d–\-–%,\s]+\)", "", seg)  # strip "(70–90%)"
                stages = [s.strip().lower() for s in re.split(r"\+", seg) if s.strip()]
                if stages:
                    buckets[key]["stages"] = stages
                lbl = re.search(r"\(([^)]+)\)", m.group(0))
                if lbl:
                    buckets[key]["label"] = name + " (" + lbl.group(1) + ")"
            break
    # Monthly target rows: first cell starts with "Commit"/"Best Case"/"Pipeline"
    # (owner breakdown rows are indented with "—" and skipped).
    header = None
    for _rn, row in rows:
        first = str(row[0]).strip().lower() if row else ""
        if first == "category":
            header = [month_key(c) for c in row[1:]]
            continue
        if header is None or not row or not str(row[0]).strip():
            continue
        name = str(row[0]).strip().lower()
        key = None
        for k in buckets:
            if name.startswith(k if k != "bestcase" else "best case"):
                key = k
                break
        if not key or "—" in str(row[0]) or "-" == str(row[0]).strip()[:1]:
            continue
        for mk, cell in zip(header, row[1:]):
            if mk:
                buckets[key]["targets"][mk] = num(cell) or 0.0
    return buckets


def bucket_of_stage(label, buckets):
    lab = (label or "").lower()
    for key, b in buckets.items():
        for s in b["stages"]:
            if s and s in lab:
                return key
    return None


def bucket_of_prob(prob):
    if prob is None:
        return None
    if prob >= 70:
        return "commit"
    if prob >= 30:
        return "bestcase"
    return "pipeline"


CLOSED_WORDS = ("closed", "lost", "won")


def main():
    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(DB)
    cur = con.cursor()

    buckets = parse_forecast(sheet_rows(cur, "Forecast"))

    # ---------- HS_Data: the manual deal table ----------
    sheet_deals = {}
    for _rn, row in sheet_rows(cur, "HS_Data"):
        if not row or not isinstance(row, list):
            continue
        if str(row[0]).strip().lower().startswith("deal"):
            continue  # header
        try:
            did = str(int(row[0])) if row[0] not in (None, "") else None
        except (ValueError, TypeError):
            continue
        if not did:
            continue
        stage = str(row[4]).strip() if len(row) > 4 and row[4] else ""
        sheet_deals[did] = {
            "id": did,
            "name": str(row[1]).strip() if len(row) > 1 and row[1] else "",
            "company": str(row[2]).strip() if len(row) > 2 and row[2] else "",
            "owner": str(row[3]).strip() if len(row) > 3 and row[3] else "",
            "stage": stage,
            "amount": num(row[5]) if len(row) > 5 else None,
            "close": parse_mdy(row[6]) if len(row) > 6 else None,
            "probability": num(row[9]) if len(row) > 9 else None,
            "daysInStage": num(row[15]) if len(row) > 15 else None,
        }

    # ---------- HubSpot deals ----------
    hs_deals = {}
    for hs_id, pj in q(cur,
            "select hs_id, properties_json from hubspot_objects where object_type='deals'"):
        try:
            p = json.loads(pj)
        except Exception:
            continue
        hs_deals[str(hs_id)] = {
            "name": p.get("dealname") or "",
            "stage": p.get("dealstage") or "",
            "amount": num(p.get("amount")),
            "close": (str(p.get("closedate"))[:10]
                      if p.get("closedate") else None),
            "probability": num(p.get("hs_deal_stage_probability")),
            "owner": p.get("hubspot_owner_id") or "",
        }

    # ---------- reconcile ----------
    mismatches, sheet_only = [], []
    for did, sd in sheet_deals.items():
        if any(w in sd["stage"].lower() for w in CLOSED_WORDS):
            continue  # closed on the sheet: nothing to chase
        hd = hs_deals.get(did)
        if not hd:
            sheet_only.append({"dealId": did, "name": sd["name"],
                               "company": sd["company"], "stage": sd["stage"],
                               "amount": sd["amount"]})
            continue
        sb = bucket_of_stage(sd["stage"], buckets)
        hb = bucket_of_prob(hd["probability"])
        if sb and hb and sb != hb:
            mismatches.append({
                "dealId": did, "name": sd["name"] or hd["name"],
                "company": sd["company"], "field": "stage",
                "sheet": "%s (%s)" % (sd["stage"], buckets[sb]["label"]),
                "hubspot": "probability %s%% (%s)" % (
                    int(hd["probability"]), buckets[hb]["label"]),
                "sheetBucket": sb, "hubspotBucket": hb,
            })
        if sd["amount"] is not None and hd["amount"] is not None:
            if abs(sd["amount"] - hd["amount"]) > max(1.0, 0.01 * abs(sd["amount"])):
                mismatches.append({
                    "dealId": did, "name": sd["name"] or hd["name"],
                    "company": sd["company"], "field": "amount",
                    "sheet": "$%s" % f"{sd['amount']:,.0f}",
                    "hubspot": "$%s" % f"{hd['amount']:,.0f}",
                })
        if sd["close"] and hd["close"] and sd["close"] != hd["close"]:
            # The sheet rounds to month-end; HubSpot keeps the exact day.
            # Only flag real slips, not 1–2 day rounding noise.
            try:
                from datetime import date as _date
                dd = abs((_date.fromisoformat(sd["close"])
                         - _date.fromisoformat(hd["close"])).days)
            except Exception:
                dd = 99
            if dd > 2:
                mismatches.append({
                    "dealId": did, "name": sd["name"] or hd["name"],
                    "company": sd["company"], "field": "close date",
                    "sheet": sd["close"], "hubspot": hd["close"],
                })

    # ---------- Lead Tracker ----------
    lt_total = lt_unworked = lt_mql_no_sql = lt_recent_unworked = 0
    lt_recent_mql = []
    cutoff = "2026-07-27"  # ~60 days before the Sep 25 run; recomputed below
    try:
        from datetime import date as _date, timedelta as _td
        cutoff = (_date.today() - _td(days=60)).isoformat()
    except Exception:
        pass
    for _rn, row in sheet_rows(cur, "Lead Tracker"):
        if not row or len(row) < 6:
            continue
        if str(row[0]).strip().lower() in ("company", ""):
            continue
        if "manual entry" in str(row[0]).lower():
            continue
        lt_total += 1
        lead_d = parse_mdy(row[3])
        mql = parse_mdy(row[4])
        sql = parse_mdy(row[5])
        if not mql:
            lt_unworked += 1
            if lead_d and lead_d >= cutoff:
                lt_recent_unworked += 1
        elif not sql:
            lt_mql_no_sql += 1
            if mql >= "2026-08-01":
                lt_recent_mql.append({
                    "company": str(row[0]).strip(),
                    "source": str(row[1]).strip() if len(row) > 1 else "",
                    "owner": str(row[2]).strip() if len(row) > 2 else "",
                    "mqlDate": mql,
                })

    out = {
        "generatedAt": now,
        "sheet": SHEET,
        "forecast": {
            "buckets": buckets,
            "month": datetime.now().strftime("%Y-%m"),
        },
        "mismatches": mismatches,
        "sheetOnly": sheet_only,
        "leadTracker": {
            "total": lt_total,
            "unworked": lt_unworked,
            "recentUnworked": lt_recent_unworked,
            "mqlNoSql": lt_mql_no_sql,
            "recentMqlNoSql": lt_recent_mql[:8],
        },
        "stats": {
            "sheetDeals": len(sheet_deals),
            "openSheetDeals": sum(1 for d in sheet_deals.values()
                                  if not any(w in d["stage"].lower() for w in CLOSED_WORDS)),
            "mismatches": len(mismatches),
            "sheetOnly": len(sheet_only),
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("sheet-review: %d sheet deals, %d mismatches, %d sheet-only, "
          "lead tracker %d total / %d unworked (%d recent) / %d MQL-no-SQL" % (
              len(sheet_deals), len(mismatches), len(sheet_only),
              lt_total, lt_unworked, lt_recent_unworked, lt_mql_no_sql))


if __name__ == "__main__":
    main()
