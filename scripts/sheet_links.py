"""Links into the Google Sheets the refresh reads.

A tab's gid comes from sheets_tabs, which the Sheets sync fills. Without it the
link opens the spreadsheet's first tab; the row is still named in `label`.
"""
import sqlite3


def spreadsheet_id(con, title):
    try:
        row = con.execute("SELECT spreadsheet_id FROM sheets_data WHERE spreadsheet_title=? LIMIT 1", (title,)).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row else None


def tab_gid(con, sheet_id, tab):
    try:
        row = con.execute("SELECT gid FROM sheets_tabs WHERE spreadsheet_id=? AND tab=?", (sheet_id, tab)).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row else None


def link(con, title, tab, row=None, last_col=None):
    """{url, label, gidKnown} for a tab, or a row in it (A{row}, or A{row}:{last_col}{row})."""
    sid = spreadsheet_id(con, title)
    if not sid:
        return None
    gid = tab_gid(con, sid, tab)
    frag = []
    if gid is not None:
        frag.append("gid=%s" % gid)
        if row:
            frag.append("range=A%d%s" % (row, (":%s%d" % (last_col, row)) if last_col else ""))
    url = "https://docs.google.com/spreadsheets/d/%s/edit" % sid + (("#" + "&".join(frag)) if frag else "")
    label = "%s › %s%s" % (title, tab, (" row %d" % row) if row else "")
    return {"url": url, "label": label, "spreadsheetId": sid, "tab": tab, "row": row, "gidKnown": gid is not None}
