"""Synthetic brain.db fixture for the refresh-script tests.

Every company, person, amount and id here is invented. The shape follows the
tables brain-data.py reads; only the columns it selects are created.
"""
import json
import sqlite3

# Pipelines: one new-business, one renewal, one customer-success, one partnership.
# Stage ids are deliberately not HubSpot's built-in ids, so closed status can
# only come from the isClosed metadata.
PIPELINES = [
    # pipeline_id, pipeline_label, stage_id, stage_label, isClosed
    ("p-sales", "Sales Pipeline", "s-sql", "SQL", False),
    ("p-sales", "Sales Pipeline", "s-demo", "Demo meeting", False),
    ("p-sales", "Sales Pipeline", "s-hold", "On Hold", False),
    ("p-sales", "Sales Pipeline", "s-won", "Closed won", True),
    ("p-sales", "Sales Pipeline", "s-lost", "Closed lost", True),
    ("p-sales", "Sales Pipeline", "s-dq", "Disqualified", True),
    ("p-renew", "Renewal Pipeline", "r-talks", "Negotiations", False),
    ("p-renew", "Renewal Pipeline", "r-churn", "Churn", True),
    ("p-cs", "Customer Success Pipeline", "c-neg", "Negotiations", False),
    ("p-partner", "Partnerships Pipeline", "x-explore", "Exploration", False),
    ("p-partner", "Partnerships Pipeline", "x-active", "Active Partnership", True),
]

# deal id -> (name, pipeline, stage, amount, HubSpot probability 0-1 or None, close)
DEALS = {
    "101": ("Acme Widgets - New Deal", "p-sales", "s-sql", "100000", "0.05", "2026-12-31"),
    "102": ("Globex - New Deal", "p-sales", "s-demo", "50000", "0.25", "2026-09-30"),   # past close
    "103": ("Initech - New Deal", "p-sales", "s-lost", "80000", "0", "2026-08-01"),    # HubSpot closed lost
    "104": ("Umbrella - New Deal", "p-sales", "s-hold", "30000", "0.1", "2027-01-31"),  # On Hold, not on Sheet
    "105": ("Hooli - New Deal", "p-sales", "s-sql", "40000", None, "2026-11-30"),      # no probability
    "106": ("Acme Widgets - Renewal", "p-renew", "r-talks", "20000", "0.9", "2026-11-01"),
    "107": ("Globex - Expansion", "p-cs", "c-neg", "15000", "0.8", "2026-12-01"),
    "108": ("Initech - Partnership", "p-partner", "x-explore", None, "0.4", "2026-12-15"),
    "109": ("Vandelay - New Deal", "p-sales", "s-dq", "70000", "0", "2026-07-01"),     # custom closed stage
}

COMPANIES = {
    "c1": ("Acme Widgets", "acme.example"),
    "c2": ("Globex", "globex.example"),
    "c3": ("Initech", "initech.example"),
    "c4": ("Umbrella", "umbrella.example"),
    "c5": ("Hooli", "hooli.example"),
    "c6": ("Vandelay", "vandelay.example"),
}

DEAL_COMPANY = {"101": "c1", "102": "c2", "103": "c3", "104": "c4", "105": "c5",
                "106": "c1", "107": "c2", "108": "c3", "109": "c6"}

# Master Sheet (HS_Data tab): id, name, company, owner, stage, amount, close,
# ..., probability (percent) at column 9.
SHEET_ROWS = [
    ["Deal ID", "Deal", "Company", "Deal Owner", "Stage", "Amount", "Close", "", "", "Probability"],
    ["101", "Acme Widgets - New Deal", "Acme Widgets", "Pat Example", "SQL", 100000, "12/31/2026", "", "", 5],
    ["102", "Globex - New Deal", "Globex", "Pat Example", "Demo meeting", 50000, "9/30/2026", "", "", 25],
    ["103", "Initech - New Deal", "Initech", "Sam Sample", "Demo meeting", 80000, "8/1/2026", "", "", 25],
]


def sheet_review():
    """sheet-review.json for the same Sheet rows (probability in percent)."""
    return {
        "deals": [
            {"id": r[0], "name": r[1], "company": r[2], "owner": r[3], "stage": r[4],
             "amount": float(r[5]), "close": None, "probability": float(r[9])}
            for r in SHEET_ROWS[1:]
        ],
        "mismatches": [],
    }


def build_db(path, *, with_metadata=True, pipeline_ids_on_deals=True):
    con = sqlite3.connect(path)
    cur = con.cursor()
    cur.executescript("""
        create table hubspot_objects (object_type text, hs_id text, properties_json text, fetched_at text);
        create table hubspot_associations (from_type text, from_id text, to_type text, to_id text);
        create table hubspot_pipelines (pipeline_id text, stage_id text, stage_label text, pipeline_label text, metadata_json text);
        create table sheets_data (spreadsheet_title text, tab text, row_num integer, row_json text);
        create table meetings (recording_id text, title text, meeting_type text, created_at text,
            scheduled_start_time text, scheduled_end_time text, recording_start_time text, recording_end_time text,
            recorded_by_name text, recorded_by_email text, invitees_json text, summary_markdown text,
            action_items_json text, fetched_at text, share_url text);
        create table transcripts (recording_id text, turns_json text);
        create table findings (id text, kind text, claim text, confidence text, evidence_refs text, status text, created_at text);
        create table lemlist_campaigns (campaign_id text, name text, status text, raw_json text);
        create table ga4_reports (report_key text, result_json text, fetched_at text);
    """)
    fetched = "2026-10-01T00:00:00Z"
    for pid, plabel, sid, slabel, closed in PIPELINES:
        meta = json.dumps({"isClosed": "true" if closed else "false"}) if with_metadata else None
        cur.execute("insert into hubspot_pipelines values (?,?,?,?,?)", (pid, sid, slabel, plabel, meta))
    closed_stages = {sid for _p, _pl, sid, _sl, closed in PIPELINES if closed}
    for did, (name, pipe, stage, amount, prob, close) in DEALS.items():
        props = {"dealname": name, "dealstage": stage, "amount": amount,
                 "hs_deal_stage_probability": prob, "closedate": close + "T00:00:00Z",
                 "createdate": "2026-06-01T00:00:00Z", "hubspot_owner_id": "9001",
                 "hs_is_closed": "true" if stage in closed_stages else "false"}
        if pipeline_ids_on_deals:
            props["pipeline"] = pipe
        cur.execute("insert into hubspot_objects values ('deals',?,?,?)", (did, json.dumps(props), fetched))
        cur.execute("insert into hubspot_associations values ('deals',?,'companies',?)", (did, DEAL_COMPANY[did]))
    for cid, (name, domain) in COMPANIES.items():
        cur.execute("insert into hubspot_objects values ('companies',?,?,?)",
                    (cid, json.dumps({"name": name, "domain": domain, "lifecyclestage": "opportunity"}), fetched))
    cur.execute("insert into hubspot_objects values ('owners','9001',?,?)",
                (json.dumps({"firstName": "Pat", "lastName": "Example", "email": "pat@example.com"}), fetched))
    for i, row in enumerate(SHEET_ROWS, start=1):
        cur.execute("insert into sheets_data values ('pipeline_meeting1_v2','HS_Data',?,?)", (i, json.dumps(row)))
    con.commit()
    con.close()
