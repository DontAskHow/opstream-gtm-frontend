#!/usr/bin/env python3
"""Incremental Sheets sync into the company brain.

Re-pulls the spreadsheets already tracked in sheets_data (all tabs) and
replaces their rows. Read-only against the Google Sheets API
(spreadsheets.get, then one values.batchGet per spreadsheet).

Auth is the owner's Google account: opstream-gtm/google-sheets-refresh-token
plus opstream-gtm/google-oauth-client-id and opstream-gtm/google-oauth-client-secret.
There is no service account. A missing secret exits 3 and does not move the
watermark. The refresh job also skips this script when the refresh token
secret is not present.
"""

import json
import urllib.error
import urllib.parse
import urllib.request

from common import (
    NeedsConnection,
    RateLimiter,
    db_connect,
    google_access_token,
    run_main,
    set_sync_state,
    now_iso,
)

SOURCE = "sheets"
pace = RateLimiter(1.0)


def _sheets_get(url: str):
    pace.wait()
    token = google_access_token()
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Authorization": "Bearer " + token,
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise NeedsConnection(
                "Google Sheets returned %s. Not touching watermarks." % exc.code
            )
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError("Google Sheets HTTP %s: %s" % (exc.code, detail))


def gws(*args: str):
    """Read-only stand-in for the old Workspace CLI.

    Accepts the same argument shape the canonical script used
    (`sheets spreadsheets get|values batchGet --params {...}`) and calls
    the Sheets REST API. Write methods are refused.
    """
    method = []
    params = {}
    i = 0
    while i < len(args):
        if args[i] == "--params":
            params = json.loads(args[i + 1])
            break
        method.append(args[i])
        i += 1
    ss_id = params.get("spreadsheetId")
    if not ss_id:
        raise RuntimeError("sheets call is missing spreadsheetId")
    quoted = urllib.parse.quote(str(ss_id), safe="")
    if method == ["sheets", "spreadsheets", "get"]:
        url = "https://sheets.googleapis.com/v4/spreadsheets/" + quoted
        if params.get("fields"):
            url += "?fields=" + urllib.parse.quote(str(params["fields"]), safe="")
        return _sheets_get(url)
    if method == ["sheets", "spreadsheets", "values", "batchGet"]:
        ranges = [("ranges", r) for r in (params.get("ranges") or [])]
        url = ("https://sheets.googleapis.com/v4/spreadsheets/" + quoted
               + "/values:batchGet?" + urllib.parse.urlencode(ranges, doseq=True))
        return _sheets_get(url)
    raise RuntimeError("sheets sync only reads spreadsheets.get and values.batchGet")


def quote_tab(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def _tab_from_range(rng: str) -> str:
    """Extract the tab title from a batchGet range echo like 'Tab'!A1:Z."""
    if rng.startswith("'"):
        end = rng.find("'!")
        if end != -1:
            return rng[1:end].replace("''", "'")
    return rng.split("!", 1)[0].strip("'")


def main_sync(log):
    google_access_token()
    con = db_connect()
    try:
        sheets = con.execute(
            "SELECT DISTINCT spreadsheet_id, spreadsheet_title FROM sheets_data"
        ).fetchall()
    finally:
        con.close()
    if not sheets:
        raise RuntimeError("sheets_data has no tracked spreadsheets; nothing to re-pull")

    total_rows = 0
    total_tabs = 0
    fetched_at = now_iso()
    con = db_connect()
    try:
        for ss_id, ss_title in sheets:
            log.info("re-pulling %s (%s)", ss_title, ss_id)
            meta = gws("sheets", "spreadsheets", "get", "--params",
                       json.dumps({"spreadsheetId": ss_id, "fields": "sheets.properties.title,sheets.properties.sheetId"}))
            tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
            gids = [(ss_id, s["properties"]["title"], s["properties"].get("sheetId"))
                    for s in meta.get("sheets", []) if s["properties"].get("sheetId") is not None]
            batch = gws("sheets", "spreadsheets", "values", "batchGet", "--params",
                        json.dumps({"spreadsheetId": ss_id,
                                    "ranges": [quote_tab(t) for t in tabs]}))
            rows_to_write = []
            for vr in batch.get("valueRanges", []):
                tab = _tab_from_range(vr.get("range", "")) or "?"
                values = vr.get("values", []) or []
                for i, row in enumerate(values, start=1):
                    rows_to_write.append((ss_id, ss_title, tab, i,
                                          json.dumps(row, ensure_ascii=False)))
                total_tabs += 1
            cur = con.cursor()
            # The tab gid makes a link open the right tab and row.
            cur.execute("CREATE TABLE IF NOT EXISTS sheets_tabs(spreadsheet_id TEXT, tab TEXT, gid INTEGER, "
                        "PRIMARY KEY(spreadsheet_id, tab))")
            cur.execute("DELETE FROM sheets_tabs WHERE spreadsheet_id=?", (ss_id,))
            cur.executemany("INSERT INTO sheets_tabs(spreadsheet_id, tab, gid) VALUES(?,?,?)", gids)
            cur.execute("DELETE FROM sheets_data WHERE spreadsheet_id=?", (ss_id,))
            cur.executemany(
                "INSERT INTO sheets_data(spreadsheet_id, spreadsheet_title, tab, row_num, row_json)"
                " VALUES(?,?,?,?,?)",
                rows_to_write,
            )
            con.commit()
            total_rows += len(rows_to_write)
            log.info("%s: %d tabs, %d rows", ss_title, len(tabs), len(rows_to_write))
    finally:
        con.close()

    note = f"{len(sheets)} spreadsheets, {total_tabs} tabs, {total_rows} rows re-pulled (batchGet, read-only)"
    set_sync_state(SOURCE, fetched_at, note)
    return note


if __name__ == "__main__":
    run_main(SOURCE, main_sync)
