"""End to end for the Oct 13 2026 reporting rules (config/lead-rules.json "reporting").

The real hubspot_sync.py runs as a subprocess against the HubSpot fake in
fakes.py, seeded with one synthetic portal built to hit every rule; then the
real scripts/workspace-data.py reads the brain.db it wrote, and the real
onepage/build.mjs renders the page. Assertions are on the requests the sync
sent, the tables it wrote and workspace.json; the rules add fields only, so the
existing ones (the meetings list, the page) are unchanged:

* customers out everywhere (contact or company lifecycle customer, a
  customer-success owner, either way), free-mail and internal addresses and
  careers forms out;
* meeting-link bookings: a Sales deal past Discovery at the booking time
  (dealstage history) drops the booking; SQL, On Hold, no deal, a deal created
  later, or a deal in another pipeline do not;
* form counts from the submissions API, per contact from
  first_conversion_event_name, never from recent_conversion_* alone;
* the blended stage probability;
* per ad platform, HubSpot-sourced leads from the first-touch URL, with
  organic ChatGPT referrals apart; platform figures labelled as events.

Every company, person, id and figure is invented.

    python3 -m unittest refresh.tests.test_rules_e2e   (or discover -s refresh/tests)
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fakes  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SYNC_SRC = ROOT / "refresh" / "brain-sync"
RULES = json.loads((ROOT / "config" / "lead-rules.json").read_text())["reporting"]
CS_OWNER = RULES["customers"]["ownerIds"][0]
INTERNAL = RULES["contacts"]["internalDomains"][0]
FREE = "gmail.com"
RENEWAL = RULES["customers"]["dealPipelines"][1]
SCRUB = "quill"  # synthetic; real scrub patterns never enter the repo
PAGE_SUBS = 51   # more than one page of 50: the sync must follow `after`

SALES_STAGES = [  # id, label, closed, probability: the Sales Pipeline's stage ids
    ("943743501", "SQL", False, "0.05"), ("decisionmakerboughtin", "Discovery/RFP received (Deal)", False, "0.1"),
    ("15879262", "Demo meeting", False, "0.25"), ("34538004", "Wider stakeholders", False, "0.4"),
    ("27052677", "Decision", False, "0.7"), ("contractsent", "Legal & Compliance", False, "0.9"),
    ("closedwon", "Closed won", True, "1.0"), ("207126699", "On Hold", False, "0.1"),
    ("closedlost", "Closed lost", True, "0.0"), ("1270127483", "Disqualified", True, "0.0")]

FORMS = {  # id: (name, lead-sources.json bucket)
    "f-demo": ("Demo Request", "demo_request"), "f-contact": ("Contact Us", "contact"),
    "f-pricing": ("Pricing form", "contact"), "f-content": ("Whitepaper Download", "content_download"),
    "f-careers": ("Open Position - Engineer", "not_a_lead_source")}


def seed(path, now):
    con = sqlite3.connect(str(path))
    con.executescript("""
        CREATE TABLE sync_state(source TEXT PRIMARY KEY, watermark TEXT, last_run TEXT, note TEXT);
        CREATE TABLE hubspot_objects(object_type TEXT, hs_id TEXT, properties_json TEXT, fetched_at TEXT,
                                     PRIMARY KEY(object_type, hs_id));
        CREATE TABLE hubspot_associations(from_type TEXT, from_id TEXT, to_type TEXT, to_id TEXT,
                                          PRIMARY KEY(from_type, from_id, to_type, to_id));
    """)
    since = fakes.iso(now - timedelta(days=1))
    marks = {t: since for t in ("contacts", "companies", "deals", "emails", "notes", "tasks", "calls",
                                "meetings", "products", "line_items")}
    con.execute("INSERT INTO sync_state VALUES('hubspot', ?, ?, 'seed')", (json.dumps(marks), since))
    # A one-row Lead Tracker, as the Sheets sync stores it: the page's Leads section (with the ad platforms) needs one.
    con.execute("CREATE TABLE sheets_data(spreadsheet_id TEXT, spreadsheet_title TEXT, tab TEXT, row_num INTEGER, row_json TEXT)")
    for n, row in enumerate([["Company", "Source", "Owner", "Lead Date", "MQL Date", "SQL Date", "Deal / Notes",
                              "First Touch (auto)", "HubSpot Company ID", "Company Domain"],
                             ["Acme Prospect", "Inbound", "Alex", "03/01/2026", "", "", "", "", "801", "acme.example"]], start=1):
        con.execute("INSERT INTO sheets_data VALUES('s1', 'Synthetic Sheet', 'Lead Tracker', ?, ?)", (n, json.dumps(row)))
    con.commit()
    con.close()


def portal(hub, now):
    """The synthetic portal. Comments say which rule each record exercises."""
    mod = fakes.iso(now - timedelta(hours=1))
    hub.pipelines = [
        {"id": "default", "label": "Sales Pipeline", "stages": [
            {"id": i, "label": l, "displayOrder": n, "metadata": {"isClosed": str(c).lower(), "probability": p}}
            for n, (i, l, c, p) in enumerate(SALES_STAGES)]},
        {"id": RENEWAL, "label": "Renewal Pipeline", "stages": [
            {"id": "r1", "label": "Negotiation", "displayOrder": 0, "metadata": {"isClosed": "false", "probability": "0.5"}}]}]
    hub.objects["companies"] = {
        801: {"name": "Acme Prospect", "domain": "acme.example", "lifecyclestage": "opportunity", "hubspot_owner_id": "1"},
        802: {"name": "Globex", "domain": "globex.example", "lifecyclestage": "customer", "hubspot_owner_id": "1"},
        803: {"name": "Initech", "domain": "initech.example", "lifecyclestage": "lead", "hubspot_owner_id": CS_OWNER},
        804: {"name": "Hooli", "domain": "hooli.example", "lifecyclestage": "lead", "hubspot_owner_id": "1"}}
    for i, c in hub.objects["companies"].items():
        c.update(hs_object_id=str(i), hs_lastmodifieddate=mod)

    def contact(i, email, company=None, life="lead", owner="1", **props):
        hub.contacts[i] = {"hs_object_id": str(i), "email": email, "firstname": "Test%d" % i, "lifecyclestage": life,
                           "hubspot_owner_id": owner, "lastmodifieddate": mod, "createdate": "2026-01-02T00:00:00.000Z", **props}
        if company:
            hub.link("contacts", i, "companies", company)
    hub.contacts = {}
    first = lambda form: "Example page: " + FORMS[form][0]
    # OpenAI paid lead (ChatGPT ad click, cpc), a demo form twice, a booking with no deal.
    contact(201, "ana@acme.example", 801, life="opportunity", hs_analytics_source="PAID_SEARCH",
            hs_analytics_first_url="https://www.example.com/pricing?utm_source=chatgpt&utm_medium=cpc&utm_campaign=ai_pricing",
            first_conversion_event_name=first("f-demo"), first_conversion_date="2026-03-01T00:00:00.000Z",
            recent_conversion_event_name="Meetings Link: acme/demo", num_conversion_events="3")
    # At a customer company: a customer. Google click id: excluded from Google's leads as a customer.
    contact(202, "ben@globex.example", 802, hs_analytics_first_url="https://www.example.com/?gclid=test-click",
            first_conversion_event_name=first("f-contact"))
    contact(203, "cara@initech.example", 803)                                  # company owned by customer success
    contact(204, "dev@hooli.example", 804, life="customer")                    # lifecycle customer
    contact(205, "eve@hooli.example", 804, owner=CS_OWNER)                     # owned by customer success
    contact(206, "fay@" + FREE, hs_analytics_source="AI_REFERRALS",            # free mail
            hs_analytics_first_referrer="https://chatgpt.com/")
    contact(207, "gus@" + INTERNAL)                                            # internal
    # Paid LinkedIn click, but careers is the only conversion.
    contact(208, "hal@hooli.example", 804, hs_analytics_source="PAID_SOCIAL",
            hs_analytics_first_url="https://www.example.com/jobs?utm_source=linkedin&utm_medium=paid_social",
            first_conversion_event_name=first("f-careers"))
    # Organic AI referral (ChatGPT referrer), converted on the pricing form.
    contact(209, "ivy@acme.example", 801, hs_analytics_source="AI_REFERRALS",
            hs_analytics_first_referrer="https://chatgpt.com/", first_conversion_event_name=first("f-pricing"))
    contact(210, "jon@acme.example", 801, first_conversion_event_name="Meetings Link: acme/demo")
    # Google paid lead (gclid + hsa_net in the first URL), converted by booking.
    contact(211, "kim@hooli.example", 804, hs_analytics_source="PAID_SEARCH",
            hs_analytics_first_url="https://www.example.com/?hsa_net=adwords&gclid=test-click-2")
    contact(212, "lee@hooli.example", 804, hs_analytics_source="PAID_SEARCH")  # paid, platform not named; booked
    # utm_source=chatgpt.com with no paid medium: organic AI referral; first conversion a content download.
    contact(213, "mo@acme.example", 801, hs_analytics_first_url="https://www.example.com/?utm_source=chatgpt.com",
            first_conversion_event_name=first("f-content"), recent_conversion_event_name="Meetings Link: acme/demo")
    # Paid Reddit click; recent_conversion_* only: never used alone, so no conversion.
    contact(214, "nia@acme.example", 801, hs_analytics_first_url="https://www.example.com/?utm_source=reddit&utm_medium=cpc",
            recent_conversion_event_name=first("f-demo"))
    contact(215, "oz@hooli.example", 804, hs_analytics_source="PAID_SOCIAL")   # paid, no conversion at all

    def deal(i, stage, amount, prob, history, pipeline="default", company=801):
        hub.objects["deals"][i] = {"hs_object_id": str(i), "dealname": "Test deal %d" % i, "pipeline": pipeline,
                                   "dealstage": stage, "amount": str(amount), "hs_deal_stage_probability": prob,
                                   "hubspot_owner_id": "1", "createdate": history[0][1], "hs_lastmodifieddate": mod,
                                   "closedate": "2026-12-31T00:00:00.000Z"}
        hub.history[str(i)] = {"dealstage": [{"value": v, "timestamp": t, "sourceType": "CRM_UI"} for v, t in reversed(history)],
                               "hubspot_owner_id": [{"value": "1", "timestamp": history[0][1], "sourceType": "CRM_UI"}]}
        hub.link("deals", i, "companies", company)
    hub.objects["deals"] = {}
    deal(901, "15879262", 100000, "0.25", [("943743501", "2026-01-05T00:00:00.000Z"), ("15879262", "2026-02-01T00:00:00.000Z")])
    # Probability 0.5 in a 25 % stage: Demo meeting blends to (25,000 + 150,000) / 400,000.
    deal(902, "15879262", 300000, "0.5", [("943743501", "2026-01-05T00:00:00.000Z"), ("15879262", "2026-04-01T00:00:00.000Z")])
    deal(903, "207126699", 50000, "0.1", [("decisionmakerboughtin", "2025-10-01T00:00:00.000Z"), ("207126699", "2025-10-20T00:00:00.000Z")])
    deal(904, "r1", 70000, "0.5", [("r1", "2025-01-01T00:00:00.000Z")], pipeline=RENEWAL, company=802)
    deal(905, "closedwon", 40000, "1.0", [("closedwon", "2026-06-01T00:00:00.000Z")], company=804)  # created after its booking
    deal(906, "943743501", 20000, "0.05", [("943743501", "2026-02-01T00:00:00.000Z")])

    hub.meetings = {}

    def booking(i, created, contacts=(), deals=(), source="MEETINGS_PUBLIC"):
        hub.meetings[i] = {"hs_object_id": str(i), "hs_meeting_title": "Test booking %d" % i, "hs_lastmodifieddate": mod,
                           "hs_createdate": created, "hs_meeting_start_time": created, "hs_timestamp": created,
                           "hs_meeting_source": source, "hubspot_owner_id": "1"}
        for c in contacts:
            hub.link("meetings", i, "contacts", c)
        for d in deals:
            hub.link("meetings", i, "deals", d)
    booking(7101, "2026-03-02T17:00:00.000Z", [201])                 # no deal: counted
    booking(7102, "2026-03-03T17:00:00.000Z", [202])                 # customer
    booking(7103, "2026-03-04T17:00:00.000Z", [206])                 # free mail only
    booking(7104, "2026-02-10T17:00:00.000Z", [210], [901])          # deal in Demo meeting since Feb 1: opportunity
    booking(7105, "2026-03-01T17:00:00.000Z", [211], [902])          # deal still SQL then: counted
    booking(7106, "2025-11-03T17:00:00.000Z", [211], [903])          # deal On Hold then: counted
    booking(7107, "2026-03-05T17:00:00.000Z", [207])                 # internal only
    booking(7108, "2026-05-01T17:00:00.000Z")                        # nothing linked: counted
    booking(7109, "2026-05-02T17:00:00.000Z", [201], source="CRM_UI")  # not a meeting-link booking
    booking(7110, "2026-05-03T17:00:00.000Z", [211], [904])          # Renewal deal: not the Sales Pipeline, counted
    booking(7111, "2026-05-15T17:00:00.000Z", [212], [905])          # deal created after the booking: counted
    booking(7112, "2026-10-10T17:00:00.000Z", [205])                 # a CS-owned contact: customer, off the meetings list
    booking(7113, "2026-10-11T17:00:00.000Z", [201])                 # counted, on the meetings list

    hub.forms, hub.submissions = [], {}
    for fid, (name, _bucket) in FORMS.items():
        hub.forms.append({"id": fid, "name": name, "formType": "hubspot", "createdAt": fakes.iso(now - timedelta(days=90)),
                          "updatedAt": fakes.iso(now - timedelta(days=9)), "archived": False, "fieldGroups": []})
    emails = {"f-demo": ["ana@acme.example", "ana@acme.example", "walkin@newco.example", "dev@hooli.example"],
              "f-contact": ["ben@globex.example", "fay@" + FREE], "f-pricing": ["ivy@acme.example"],
              "f-content": ["gus@" + INTERNAL, "mo@acme.example"] + ["reader%d@readers.example" % k for k in range(PAGE_SUBS)],
              "f-careers": ["hal@hooli.example", "eve@hooli.example"]}
    for fid, xs in emails.items():
        hub.submissions[fid] = [{"conversionId": "%s-%d" % (fid, k), "submittedAt": fakes.ms(now - timedelta(hours=2 + k)),
                                 "pageUrl": "https://www.example.com/p", "pageTitle": "Example page",
                                 "values": [{"name": "email", "value": e}]} for k, e in enumerate(xs)]
    hub.lists, hub.members, hub.imports = [], {}, []


LEAD_SOURCES = {
    "generated_at": "2026-10-13T09:00:00-07:00", "owner": "synthetic",
    "forms": [{"id": fid, "name": name, "bucket": bucket, "counts_as_lead_source": bucket != "not_a_lead_source",
               "uncertain": False} for fid, (name, bucket) in FORMS.items()],
    "ads": {"platforms": ["Google Ads", "LinkedIn Ads", "Reddit Ads", "OpenAI (ChatGPT) Ads"]},
    "customer_success": {"owners": {"CS owner": RULES["customers"]["ownerIds"]}},
    "sheet": {"tab": "Lead Tracker (Synthetic Sheet)"},
}


class RulesE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="rules-e2e-"))
        cls.world = fakes.FakeWorld(cls.tmp).start()
        portal(cls.world.hubspot, cls.world.now)
        sync_dir = cls.tmp / "brain-sync"
        shutil.copytree(SYNC_SRC, sync_dir, ignore=shutil.ignore_patterns("logs", "__pycache__"))
        cls.db = cls.tmp / "brain.db"
        seed(cls.db, cls.world.now)
        env = cls.world.env(os.environ, cls.db)
        proc = subprocess.run([sys.executable, str(sync_dir / "hubspot_sync.py")], env=env, cwd=str(cls.tmp),
                              capture_output=True, text=True, timeout=600)
        cls.sync = proc
        cls.reqs = cls.world.take_requests()
        inputs = cls.tmp / "inputs"
        inputs.mkdir()
        (inputs / "lead-sources.json").write_text(json.dumps(LEAD_SOURCES))
        out = cls.tmp / "workspace.json"
        env = {**os.environ, "WORKSPACE_SCRUB_PATTERNS": SCRUB, "CALL_CLASSIFICATION": "", "LEAD_SOURCE_REVIEW": "",
               "PAID_EXPORT": ""}
        cls.data_step = subprocess.run([sys.executable, str(ROOT / "scripts" / "workspace-data.py"), "--db", str(cls.db),
                                        "--inputs-dir", str(inputs), "--as-of", "2026-10-13T16:00:00Z", "--out", str(out)],
                                       env=env, capture_output=True, text=True, timeout=300)
        cls.data = json.loads(out.read_text()) if out.exists() else None
        cls.page = subprocess.run(["node", str(ROOT / "onepage" / "build.mjs"), "--data", str(out), "--out", str(cls.tmp / "page")],
                                  env=env, capture_output=True, text=True, timeout=120)
        page = cls.tmp / "page" / "index.html"
        cls.html = page.read_text() if page.exists() else ""

    @classmethod
    def tearDownClass(cls):
        cls.world.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def q(self, sql, *args):
        con = sqlite3.connect(str(self.db))
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def test_0_steps_ran(self):
        self.assertEqual(self.sync.returncode, 0, self.sync.stdout[-3000:] + self.sync.stderr[-3000:])
        self.assertEqual(self.world.refused_connects, [])
        for secret in (fakes.ACCESS_TOKEN, fakes.REFRESH_TOKEN, "test-client-secret"):
            self.assertNotIn(secret, self.sync.stdout + self.sync.stderr)
        self.assertEqual(self.data_step.returncode, 0, self.data_step.stderr[-3000:])
        self.assertEqual(self.page.returncode, 0, self.page.stderr[-3000:])

    def test_sync_requests_what_the_rules_need(self):
        search = lambda otype: next(r.json() for r in self.reqs if r.path == "/crm/v3/objects/%s/search" % otype)
        props = search("contacts")["properties"]
        for p in ("lifecyclestage", "hubspot_owner_id", "first_conversion_event_name", "first_conversion_date",
                  "recent_conversion_event_name", "recent_conversion_date", "num_conversion_events",
                  "hs_analytics_first_url", "hs_analytics_first_referrer", "hs_analytics_source"):
            self.assertIn(p, props)
        for p in ("lifecyclestage", "hubspot_owner_id"):
            self.assertIn(p, search("companies")["properties"])
        for p in ("pipeline", "hubspot_owner_id", "dealstage"):
            self.assertIn(p, search("deals")["properties"])
        for p in ("hs_createdate", "hs_meeting_source"):
            self.assertIn(p, search("meetings")["properties"])
        # Meeting -> deal and meeting -> contact associations, batch read for the changed meetings.
        for to in ("deals", "contacts"):
            self.assertTrue([r for r in self.reqs if r.path == "/crm/v4/associations/meetings/%s/batch/read" % to
                             and {"id": "7104"} in r.json()["inputs"]])
        # Deal stage history: the deals batch read asks for it.
        body = next(r.json() for r in self.reqs if r.path == "/crm/v3/objects/deals/batch/read")
        self.assertIn("dealstage", body["propertiesWithHistory"])
        # Submissions: limit 50, following `after` past the first page.
        subs = [r for r in self.reqs if r.path == "/form-integrations/v1/submissions/forms/f-content"]
        self.assertEqual([(r.query.get("limit"), r.query.get("after")) for r in subs], [("50", None), ("50", "50")])
        bad = [r for r in self.reqs if r.host == fakes.HUBSPOT_HOST and r.method != "GET"
               and not (r.path.endswith("/search") or r.path.endswith("/batch/read") or r.path == "/oauth/v1/token")]
        self.assertEqual(bad, [], "HubSpot calls other than reads")

    def test_sync_stores_stage_history_and_first_touch(self):
        hist = json.loads(self.q("SELECT stage_history FROM hubspot_deal_extras WHERE deal_id='901'")[0][0])
        self.assertEqual([h["value"] for h in hist], ["15879262", "943743501"])  # newest first
        props = json.loads(self.q("SELECT properties_json FROM hubspot_objects WHERE object_type='contacts' AND hs_id='201'")[0][0])
        self.assertIn("utm_source=chatgpt", props["hs_analytics_first_url"])
        self.assertEqual(self.q("SELECT COUNT(*) FROM hubspot_form_submissions WHERE form_id='f-content'")[0][0], PAGE_SUBS + 2)
        self.assertIn(("meetings", "7104", "deals", "901"), self.q("SELECT * FROM hubspot_associations"))

    def test_scope_excludes_customers_free_mail_internal(self):
        out = self.data["scope"]["reporting"]
        # Customers: 202 (customer company), 203 (CS-owned company), 204 (lifecycle), 205 (CS owner). 206 free mail, 207 internal.
        self.assertEqual(out["contactsOut"], {"customer": 4, "freeMail": 1, "internal": 1})
        self.assertEqual(out["droppedDeals"], 1)  # the Renewal deal

    def test_forms_waterfall_and_first_conversion(self):
        f = self.data["forms"]
        self.assertTrue(f["available"])
        self.assertEqual(f["waterfall"]["all"], {"contact": 3, "content_download": PAGE_SUBS + 2, "demo_request": 4,
                                                 "not_a_lead_source": 2})
        # Customers out: dev (demo), ben (contact), eve (careers).
        self.assertEqual(f["waterfall"]["afterCustomers"], {"contact": 2, "content_download": PAGE_SUBS + 2,
                                                            "demo_request": 3, "not_a_lead_source": 1})
        # Then careers, free mail (fay) and internal (gus) out. A submission with no contact counts (walk-in, readers).
        self.assertEqual(f["waterfall"]["counted"], {"contact": 1, "content_download": PAGE_SUBS + 1, "demo_request": 3})
        self.assertEqual(f["excluded"], {"careers": 1, "customer": 3, "freeMail": 1, "internal": 1})
        self.assertEqual(f["noContact"], PAGE_SUBS + 1)
        by = {b["bucket"]: b for b in f["buckets"]}
        self.assertEqual((by["demo_request"]["submissions"], by["demo_request"]["contacts"]), (3, 2))  # ana twice + walk-in
        # Per contact, first conversion: ana demo, ivy pricing (contact), mo content; hal careers; ben a customer;
        # jon's is a meeting link; nia has recent_conversion_* only, which is never used alone.
        self.assertEqual(f["firstConversion"]["counted"], {"contact": 1, "content_download": 1, "demo_request": 1})
        self.assertEqual(f["firstConversion"]["afterCustomers"], {"contact": 1, "content_download": 1, "demo_request": 1,
                                                                  "not_a_lead_source": 1})
        self.assertEqual(f["firstConversionNotAForm"], 1)
        self.assertEqual(f["formsNotRead"], [])

    def test_bookings(self):
        b = self.data["meetings"]["bookings"]
        self.assertTrue(b["available"] and b["stageHistorySynced"])
        got = {k: b[k] for k in ("total", "customer", "opportunity", "afterRules", "freeMail", "internal", "counted")}
        self.assertEqual(got, {"total": 12, "customer": 2, "opportunity": 1, "afterRules": 9, "freeMail": 1, "internal": 1,
                               "counted": 7})
        self.assertEqual((b["byYear"]["2025"]["counted"], b["byYear"]["2026"]["total"], b["byYear"]["2026"]["afterRules"]), (1, 11, 8))
        self.assertEqual((b["onHoldKept"], b["opportunityUnchecked"]), (1, 0))

    def test_meeting_list_keeps_its_meaning(self):
        # The existing meetings list is not filtered by the reporting rules; only meetings.bookings applies them.
        ids = {m["id"] for m in self.data["meetings"]["items"]}
        self.assertIn("7113", ids)
        self.assertIn("7112", ids)  # its company is no customer; its contact, owned by customer success, is
        self.assertGreaterEqual(self.data["meetings"]["scope"]["customer"], 1)

    def test_blended_probability(self):
        st = {s["id"]: s for s in self.data["headline"]["stages"]}
        demo = st["15879262"]
        self.assertEqual((demo["amount"], demo["weighted"], demo["probability"]), (400000, 175000, 0.25))
        self.assertAlmostEqual(demo["blendedProbability"], 0.4375)
        self.assertTrue(demo["probabilityMixed"])
        self.assertAlmostEqual(st["943743501"]["blendedProbability"], 0.05)
        self.assertFalse(st["943743501"]["probabilityMixed"])
        self.assertIsNone(st["34538004"]["blendedProbability"])  # no deals
        self.assertNotIn("blended; stage default", self.html)  # the page is unchanged

    def test_ad_platform_leads(self):
        a = self.data["adLeads"]
        self.assertTrue(a["firstUrlSynced"])  # every contact came from a search that asked for it
        self.assertEqual(a["firstUrlCoverage"], 1.0)
        self.assertIn("hs_analytics_first_url", self.data["meta"]["reportingContactFields"])
        by = {r["name"]: (r["leads"], r["contacts"], r["excluded"]) for r in a["platforms"]}
        self.assertEqual(by["OpenAI (ChatGPT) Ads"], (1, 1, {}))
        self.assertEqual(by["Google Ads"], (1, 2, {"customer": 1}))
        self.assertEqual(by["LinkedIn Ads"], (0, 1, {"careers": 1}))
        self.assertEqual(by["Reddit Ads"], (0, 1, {"noConversion": 1}))
        self.assertEqual((a["unnamed"]["leads"], a["unnamed"]["excluded"]), (1, {"noConversion": 1}))
        # Organic ChatGPT referrals are apart from paid: ivy (referrer) and mo (utm_source=chatgpt.com, no paid medium).
        self.assertEqual((a["aiReferral"]["leads"], a["aiReferral"]["ids"], a["aiReferral"]["excluded"]),
                         (2, ["209", "213"], {"freeMail": 1}))
        openai = next(x for x in self.data["ads"] if x["key"] == "openai")
        self.assertEqual((openai["hubspotLeads"]["leads"], openai["aiReferral"]["leads"]), (1, 2))
        self.assertEqual(openai["figureLabel"], "platform-reported events, not leads")
        self.assertNotIn("HubSpot leads:", self.html)  # the page is unchanged


class DealExtrasMigration(unittest.TestCase):
    """The live table predates stage_history and contact_ids: a 4-column hubspot_deal_extras with rows. An incremental
    run (no deal changed, extras refreshed recently) adds the columns and re-reads every old row once; a deal HubSpot no longer
    returns gets "[]" so it is not re-read forever; the next run reads nothing; an old-image upsert (a rollback)
    keeps the history."""
    OLD = ["901", "902", "903", "904", "905", "906", "999"]  # 999: stored, but HubSpot returns nothing for it

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="extras-migration-"))
        cls.world = fakes.FakeWorld(cls.tmp).start()
        portal(cls.world.hubspot, cls.world.now)
        cls.world.hubspot.link("deals", 901, "contacts", 201)
        sync_dir = cls.tmp / "brain-sync"
        shutil.copytree(SYNC_SRC, sync_dir, ignore=shutil.ignore_patterns("logs", "__pycache__"))
        cls.db = cls.tmp / "brain.db"
        seed(cls.db, cls.world.now)
        now = fakes.iso(cls.world.now)
        con = sqlite3.connect(str(cls.db))
        marks = json.loads(con.execute("SELECT watermark FROM sync_state WHERE source='hubspot'").fetchone()[0])
        marks["deals"] = now  # no deal changed since
        con.execute("UPDATE sync_state SET watermark=? WHERE source='hubspot'", (json.dumps(marks),))
        con.execute("INSERT INTO sync_state VALUES('hubspot_extras', ?, ?, 'full refresh')", (now, now))  # incremental
        deals = cls.world.hubspot.objects["deals"]
        for i in cls.OLD:
            props = deals.get(int(i)) or {"hs_object_id": i, "dealname": "Gone deal", "pipeline": "default"}
            con.execute("INSERT INTO hubspot_objects VALUES('deals', ?, ?, ?)", (i, json.dumps(props), now))
        con.execute("CREATE TABLE hubspot_deal_extras (deal_id TEXT PRIMARY KEY, company_ids TEXT, owner_history TEXT, "
                    "refreshed_at TEXT)")
        for i in cls.OLD:
            con.execute("INSERT INTO hubspot_deal_extras VALUES(?, '[\"801\"]', '[]', ?)", (i, now))
        con.commit()
        con.close()
        cls.env = cls.world.env(os.environ, cls.db)
        cls.runs = []
        for _ in range(2):
            proc = subprocess.run([sys.executable, str(sync_dir / "hubspot_sync.py")], env=cls.env, cwd=str(cls.tmp),
                                  capture_output=True, text=True, timeout=600)
            cls.runs.append((proc, cls.world.take_requests()))

    @classmethod
    def tearDownClass(cls):
        cls.world.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def q(self, sql, *args):
        con = sqlite3.connect(str(self.db))
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def batch_ids(self, reqs):
        return sorted(x["id"] for r in reqs if r.path == "/crm/v3/objects/deals/batch/read" for x in r.json()["inputs"])

    def test_migration(self):
        for proc, _ in self.runs:
            self.assertEqual(proc.returncode, 0, proc.stdout[-3000:] + proc.stderr[-3000:])
        cols = [r[1] for r in self.q("PRAGMA table_info(hubspot_deal_extras)")]
        self.assertEqual(cols, ["deal_id", "company_ids", "owner_history", "refreshed_at", "stage_history", "contact_ids"])
        # Run 1: no deal changed, so the batch read is exactly the rows stored before the column existed.
        first, second = (reqs for _, reqs in self.runs)
        self.assertEqual(self.batch_ids(first), sorted(self.OLD))
        rows = dict(self.q("SELECT deal_id, stage_history FROM hubspot_deal_extras"))
        self.assertEqual(sorted(rows), sorted(self.OLD))
        self.assertEqual([h["value"] for h in json.loads(rows["901"])], ["15879262", "943743501"])
        self.assertEqual(rows["999"], "[]")  # not returned: empty, not NULL
        self.assertNotIn(None, rows.values())
        assoc_ids = lambda reqs: sorted(x["id"] for r in reqs if r.path == "/crm/v4/associations/deals/contacts/batch/read"
                                        for x in r.json()["inputs"])
        self.assertEqual(assoc_ids(first), sorted(self.OLD))
        self.assertEqual(dict(self.q("SELECT deal_id, contact_ids FROM hubspot_deal_extras")),
                         {i: '["201"]' if i == "901" else "[]" for i in self.OLD})
        # Run 2: nothing to re-read.
        self.assertEqual((self.batch_ids(second), assoc_ids(second)), ([], []))
        self.assertIn("deal extras: nothing to refresh", self.runs[1][0].stdout + self.runs[1][0].stderr)

    def test_old_image_upsert_keeps_the_history(self):
        con = sqlite3.connect(str(self.db))
        try:  # the statement the previous image runs: it names four columns
            con.execute("INSERT INTO hubspot_deal_extras(deal_id, company_ids, owner_history, refreshed_at) VALUES(?,?,?,?) "
                        "ON CONFLICT(deal_id) DO UPDATE SET company_ids=excluded.company_ids, "
                        "owner_history=excluded.owner_history, refreshed_at=excluded.refreshed_at",
                        ("901", '["801"]', "[]", "later"))
            con.commit()
            hist = con.execute("SELECT stage_history FROM hubspot_deal_extras WHERE deal_id='901'").fetchone()[0]
        finally:
            con.close()
        self.assertEqual([h["value"] for h in json.loads(hist)], ["15879262", "943743501"])


if __name__ == "__main__":
    unittest.main()
