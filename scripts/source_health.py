"""Per-source refresh outcomes, as Pulse insights the page already renders.

Each sync records its last outcome in the brain's sync_outcomes table
(source, route, HTTP status, detail, last good run). A source that was not
refreshed keeps its last good data; the insight says so in plain words.
"""
from datetime import datetime, timedelta, timezone

LABELS = {
    "sheets": "Google Sheets", "hubspot": "HubSpot", "fathom": "Fathom",
    "ga4": "GA4", "lemlist": "LemList", "otterly": "Otterly",
}


def phoenix(iso):
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return ""
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    t = t.astimezone(timezone(timedelta(hours=-7)))
    return "%s %d, %d:%02d %s Phoenix" % (t.strftime("%b"), t.day, t.hour % 12 or 12, t.minute, "AM" if t.hour < 12 else "PM")


def read(con):
    try:
        rows = con.execute(
            "SELECT source, at, ok, route, http, detail, last_ok_at FROM sync_outcomes ORDER BY source").fetchall()
    except Exception:
        return []
    return [{"source": r[0], "label": LABELS.get(r[0], r[0]), "at": r[1], "ok": bool(r[2]), "route": r[3],
             "http": r[4], "detail": r[5] or "", "lastOkAt": r[6]} for r in rows]


def insights(sources):
    out = []
    for s in sources or []:
        if s.get("ok"):
            continue
        if s.get("http"):
            what = "%s answered HTTP %s" % (s.get("route") or "the API", s["http"])
        else:
            what = s.get("detail") or "the refresh did not record a reason"
        kept = ("Showing the last good data from " + phoenix(s["lastOkAt"]) + ".") if s.get("lastOkAt") else \
            "Showing the data from an earlier collection."
        out.append({
            "title": s["label"] + " was not refreshed",
            "detail": "%s at %s. %s" % (what[:1].upper() + what[1:], phoenix(s.get("at")) or "the last run", kept),
            "priority": "high" if s.get("http") in (401, 403) else "medium",
            "kind": "health",
        })
    fresh = [s["label"] for s in sources or [] if s.get("ok")]
    if fresh:
        out.append({"title": "Refreshed this run", "detail": ", ".join(fresh) + ".", "priority": "low", "kind": "health"})
    return out
