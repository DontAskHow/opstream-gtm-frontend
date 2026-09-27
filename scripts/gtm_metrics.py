"""Shared GTM headline metrics.

The browser copy lives in workspace-model.cjs. Keep the rules aligned:
open-pipeline exclusions, Phoenix calendar dates, quiet days, unworked leads,
and commit-versus-forecast wording. Callers describe these numbers; they do
not compute a second one.
"""
from datetime import date, datetime, timezone


QUIET_DAYS = 14
PHOENIX = "America/Phoenix"


def date_only(value):
    """YYYY-MM-DD. Date-only strings are kept. Timestamps use Phoenix."""
    if value is None or value == "":
        return None
    raw = str(value).strip()
    if len(raw) >= 10 and raw[4:5] == "-" and raw[7:8] == "-" and (len(raw) == 10 or raw[10] not in "T "):
        # date-only
        try:
            date.fromisoformat(raw[:10])
            if len(raw) == 10:
                return raw[:10]
        except ValueError:
            return None
    if len(raw) == 10:
        try:
            date.fromisoformat(raw)
            return raw
        except ValueError:
            return None
    # Timestamp: convert to Phoenix (MST, UTC-7, no DST).
    try:
        if raw.endswith("Z"):
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        elif len(raw) == 16:
            dt = datetime.fromisoformat(raw + ":00+00:00")
        else:
            dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        phx = dt.astimezone(timezone.utc).timestamp() - 7 * 3600
        return datetime.fromtimestamp(phx, timezone.utc).date().isoformat()
    except Exception:
        return raw[:10] if len(raw) >= 10 and raw[4:5] == "-" else None


def phoenix_today(now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    phx = now.timestamp() - 7 * 3600
    return datetime.fromtimestamp(phx, timezone.utc).date().isoformat()


def days_between(start, end):
    try:
        return (date.fromisoformat(end) - date.fromisoformat(start)).days
    except Exception:
        return None


def _push(dates, value, today):
    d = date_only(value)
    if d and d <= today:
        dates.append(d)


def last_engagement(company, today=None):
    if not company:
        return None
    today = today or phoenix_today()
    dates = []
    for it in company.get("completedInteractions") or []:
        _push(dates, it.get("date"), today)
    for n in company.get("notes") or []:
        _push(dates, n.get("date"), today)
    for c in company.get("calls") or []:
        _push(dates, c.get("date"), today)
    for m in company.get("meetings") or []:
        _push(dates, m.get("start"), today)
    for r in company.get("recordings") or []:
        _push(dates, r.get("date"), today)
    emails = company.get("emails") or {}
    for e in emails.get("items") or []:
        _push(dates, e.get("date"), today)
    _push(dates, company.get("lastContact"), today)
    return max(dates) if dates else None


def days_quiet(company, today=None):
    today = today or phoenix_today()
    if isinstance(company, str):
        last = date_only(company)
    else:
        last = last_engagement(company, today)
    if not last or last > today:
        return None
    return days_between(last, today)


def probability_fraction(value):
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n < 0:
        return None
    return min(n, 100) / 100 if n > 1 else n


def is_open_pipeline(deal, today):
    if not deal or deal.get("closed") is True:
        return False
    stage = str(deal.get("stage") or deal.get("stageLabel") or "")
    deal_name = str(deal.get("dealName") or "")
    blob = (stage + " " + deal_name).lower()
    if any(w in blob for w in ("closed won", "closed lost", "closedwon", "closedlost")):
        return False
    if "disqualif" in blob or "on hold" in blob:
        return False
    if "current agreement" in blob or "renewal" in blob:
        return False
    close = date_only(deal.get("close"))
    if close and today and close < today:
        return False
    return True


def stage_display(stage):
    s = str(stage or "").strip()
    if s.endswith(" (Deal)"):
        s = s[: -len(" (Deal)")].strip()
    return s or "No stage"


def unworked_count(leads, sheet_review=None):
    lt = (sheet_review or {}).get("leadTracker") or {}
    if isinstance(lt.get("unworked"), (int, float)) and isinstance(lt.get("total"), (int, float)) and lt.get("total", 0) > 0:
        return int(lt["unworked"])
    return sum(1 for l in (leads or []) if not date_only(l.get("mql")))


def commit_versus_target(commit, target):
    try:
        c = float(commit)
    except (TypeError, ValueError):
        return {"relation": "unknown", "text": None}

    def money(n):
        return "$%s" % f"{round(n):,}"

    try:
        t = float(target)
    except (TypeError, ValueError):
        t = 0
    if t <= 0:
        return {"relation": "unknown", "text": "%s commit · no forecast target connected" % money(c)}
    if c > t:
        return {"relation": "ahead", "gap": c - t,
                "text": "%s commit is ahead of the %s forecast by %s" % (money(c), money(t), money(c - t))}
    if c == t:
        return {"relation": "met", "gap": 0,
                "text": "%s commit meets the %s forecast" % (money(c), money(t))}
    return {"relation": "short", "gap": t - c,
            "text": "%s commit is short of the %s forecast by %s" % (money(c), money(t), money(t - c))}


def greeting(now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    hour = datetime.fromtimestamp(now.timestamp() - 7 * 3600, timezone.utc).hour
    if hour < 12:
        return "Good morning"
    if hour < 17:
        return "Good afternoon"
    return "Good evening"
