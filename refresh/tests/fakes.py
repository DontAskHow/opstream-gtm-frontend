"""Local fakes for the end-to-end sync tests.

One threaded HTTP server plays three parts:

* An HTTPS proxy. The sync scripts run with HTTPS_PROXY pointing here and
  SSL_CERT_FILE pointing at a CA made for the test run, so they talk to
  https://api.hubapi.com and https://api.lemlist.com unmodified. The proxy
  answers CONNECT only for those two hosts and serves them itself; nothing
  leaves the machine.
* AWS Secrets Manager (plain HTTP, via AWS_ENDPOINT_URL_SECRETS_MANAGER) for
  the HubSpot OAuth secret.
* HubSpot and Lemlist, with paging, archived forms, 429s and injected failures.

Every request is logged so tests can assert which methods and routes were used.
All data is synthetic.
"""

import json
import socketserver
import ssl
import subprocess
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORTAL_ID = 21303277
HUBSPOT_HOST = "api.hubapi.com"
LEMLIST_HOST = "api.lemlist.com"
ACCESS_TOKEN = "test-hubspot-access"
REFRESH_TOKEN = "test-hubspot-refresh"
LEMLIST_KEY = "test-lemlist-key"


def make_ca(tmp: Path):
    """Write ca.pem and a leaf cert/key for the two API hosts. Returns (ca, cert, key) paths."""
    ca_key, ca_pem = tmp / "ca.key", tmp / "ca.pem"
    key, csr, cert, ext = tmp / "leaf.key", tmp / "leaf.csr", tmp / "leaf.pem", tmp / "leaf.ext"
    run = lambda *a: subprocess.run(a, check=True, capture_output=True)  # noqa: E731
    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=sync-test-ca",
        "-keyout", str(ca_key), "-out", str(ca_pem),
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + HUBSPOT_HOST,
        "-keyout", str(key), "-out", str(csr))
    ext.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                   "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s,DNS:%s\n"
                   "authorityKeyIdentifier=keyid\nsubjectKeyIdentifier=hash\n" % (HUBSPOT_HOST, LEMLIST_HOST))
    run("openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca_pem), "-CAkey", str(ca_key), "-CAcreateserial",
        "-days", "2", "-extfile", str(ext), "-out", str(cert))
    return ca_pem, cert, key


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def ms(dt):
    return int(dt.timestamp() * 1000)


def parse_iso(s):
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


class Request:
    def __init__(self, host, method, path, query, headers, body):
        self.host, self.method, self.path, self.query, self.headers, self.body = host, method, path, query, headers, body

    def json(self):
        return json.loads(self.body.decode("utf-8")) if self.body else None

    def __repr__(self):
        return "%s %s %s" % (self.method, self.host, self.path)


# ---------------------------------------------------------------- Secrets Manager

class SecretsManagerFake:
    def __init__(self):
        self.secrets = {"opstream-gtm/hubspot-oauth": {"version": "v1", "value": json.dumps({
            "portal_id": str(PORTAL_ID), "client_id": "test-client", "client_secret": "test-client-secret",
            "refresh_token": REFRESH_TOKEN, "token_endpoint": "https://api.hubapi.com/oauth/v1/token",
            "api_base": "https://api.hubapi.com"})}}

    def handle(self, req):
        target = req.headers.get("X-Amz-Target", "")
        doc = req.json() or {}
        sec = self.secrets.get(doc.get("SecretId"))
        if sec is None:
            return 400, {"__type": "ResourceNotFoundException", "message": "not found"}
        if target.endswith(".GetSecretValue"):
            return 200, {"ARN": "arn:aws:secretsmanager:us-east-2:000000000000:secret:test", "Name": doc["SecretId"],
                         "SecretString": sec["value"], "VersionId": sec["version"], "VersionStages": ["AWSCURRENT"]}
        if target.endswith(".DescribeSecret"):
            return 200, {"Name": doc["SecretId"], "VersionIdsToStages": {sec["version"]: ["AWSCURRENT"]}}
        if target.endswith(".PutSecretValue"):
            sec["value"] = doc["SecretString"]
            sec["version"] = sec["version"] + "x"
            return 200, {"Name": doc["SecretId"], "VersionId": sec["version"]}
        return 400, {"__type": "InvalidRequestException", "message": target}


# ---------------------------------------------------------------- HubSpot

class HubSpotFake:
    """Synthetic portal: contacts, meetings, forms (one archived), lists, imports."""

    FORMS_PAGE = 2   # forms list pages are small to exercise paging
    LISTS_PAGE = 2

    def __init__(self, now):
        self.now = now
        self.contacts = {}
        for i in range(101, 551):  # 450 contacts
            recent = i in (101, 102)
            self.contacts[i] = {
                "hs_object_id": str(i), "email": "contact%d@example.com" % i, "firstname": "Test%d" % i,
                "lastmodifieddate": iso(now - (timedelta(hours=1) if recent else timedelta(days=30))),
                "lifecyclestage": "lead", "hs_analytics_source": "PAID_SEARCH",
                "hs_analytics_source_data_1": "test-campaign", "hs_latest_source": "ORGANIC_SEARCH",
                "first_conversion_event_name": "Demo request", "num_conversion_events": "2",
                "hs_object_source": "FORM", "hs_object_source_label": "FORM",
                "hs_lifecyclestage_lead_date": iso(now - timedelta(days=60)),
                "utm_source": "newsletter", "utm_campaign": "q4-test", "paid_touch_campaign": "pt-test",
            }
        self.properties = ["email", "firstname", "lastmodifieddate", "hs_object_id", "hs_analytics_source",
                           "hs_analytics_source_data_1", "hs_latest_source", "utm_source", "utm_campaign",
                           "paid_touch_campaign", "favorite_color"]
        # 250 meetings; 7001 and 7002 changed in the last hour.
        self.meetings = {}
        for i in range(7001, 7251):
            recent = i in (7001, 7002)
            self.meetings[i] = {
                "hs_object_id": str(i), "hs_meeting_title": "Test meeting %d" % i,
                "hs_lastmodifieddate": iso(now - (timedelta(hours=1) if recent else timedelta(days=30))),
                "hs_meeting_start_time": iso(now - timedelta(days=5)),
                "hs_meeting_source": "MEETINGS_PUBLIC", "hs_meeting_source_id": "src-%d" % i,
                "hs_meeting_external_url": "https://example.com/meet/%d" % i, "hs_meeting_location": "Online",
                "hs_activity_type": "Discovery", "test_booking_page_url": "https://example.com/book/test",
                "hs_internal_meeting_notes": "Test internal note", "hs_scheduled_tasks": "{}",
            }
        # name, label: one property matches by name, one by label only; the others must not be requested.
        self.meeting_properties = [
            ("hs_meeting_title", "Meeting name"), ("hs_meeting_source", "Meeting source"),
            ("test_booking_page_url", "Test page URL"), ("test_link_used", "Meetings link used"),
            ("hs_internal_meeting_notes", "Internal meeting notes"), ("favorite_room", "Favorite room"),
            ("hs_scheduled_tasks", "Scheduled tasks"), ("hs_meeting_location", "Location"),
            ("hs_meeting_external_url", "External URL")]
        self.meeting_properties_status = 200
        self.forms = []
        self.submissions = {}
        for n, (archived, count) in enumerate([(False, 120), (False, 3), (False, 0), (True, 5)], start=1):
            fid = "f0000000-0000-4000-8000-00000000000%d" % n
            self.forms.append({"id": fid, "name": "Test form %d" % n, "formType": "hubspot",
                               "createdAt": iso(now - timedelta(days=90)), "updatedAt": iso(now - timedelta(days=9)),
                               "archived": archived, "fieldGroups": []})
            self.submissions[fid] = [self._submission(fid, k, now - timedelta(hours=2 + k)) for k in range(count)]
        self.lists = [
            {"listId": "11", "name": "Test contact list A", "processingType": "MANUAL", "objectTypeId": "0-1"},
            {"listId": "12", "name": "Test contact list B", "processingType": "DYNAMIC", "objectTypeId": "0-1"},
            {"listId": "13", "name": "Test company list", "processingType": "DYNAMIC", "objectTypeId": "0-2"},
        ]
        self.members = {"11": list(range(101, 401)), "12": [101, 102, 103], "13": [9001, 9002]}
        self.imports = [{"id": "501", "importName": "Test import 1", "state": "DONE",
                         "createdAt": iso(now - timedelta(days=20))},
                        {"id": "502", "importName": "Test import 2", "state": "DONE",
                         "createdAt": iso(now - timedelta(days=2))}]
        # Fault injection, set by the tests.
        self.imports_status = 200
        self.forms_status = 200           # the forms list answers this status
        self.lists_shape = None           # "no-lists": no lists array; "empty": an empty catalog
        self.members_status = {}          # listId -> status its memberships answer
        self.fail_backfill_after = None   # contacts keyset search with this GT value answers 500
        self.fail_meeting_backfill_after = None
        self.once_429 = set()             # route keys that answer 429 once

    def _submission(self, fid, k, when):
        return {"conversionId": "%s-c%d" % (fid[-1], k), "submittedAt": ms(when), "pageUrl": "https://example.com/p",
                "pageTitle": "Test page", "values": [{"name": "email", "value": "sub%d@example.com" % k,
                                                     "objectTypeId": "0-1"},
                                                    {"name": "firstname", "value": "Sub%d" % k,
                                                     "objectTypeId": "0-1"}]}

    def add_submissions(self, fid, n):
        newest = max((s["submittedAt"] for s in self.submissions[fid] if isinstance(s["submittedAt"], int)),
                     default=ms(self.now))
        for k in range(n):
            sub = self._submission(fid, 1000 + k, datetime.fromtimestamp(newest / 1000 + 60 * (k + 1), timezone.utc))
            self.submissions[fid].insert(0, sub)

    def _maybe_429(self, key):
        if key in self.once_429:
            self.once_429.discard(key)
            return 429, {"status": "error", "message": "rate limited", "policyName": "SECONDLY"}
        return None

    def handle(self, req):
        if req.method == "POST" and req.path == "/oauth/v1/token":
            form = dict(urllib.parse.parse_qsl(req.body.decode()))
            if form.get("refresh_token") != REFRESH_TOKEN or form.get("grant_type") != "refresh_token":
                return 400, {"status": "BAD_REFRESH_TOKEN"}
            return 200, {"access_token": ACCESS_TOKEN, "refresh_token": REFRESH_TOKEN, "expires_in": 1800,
                         "token_type": "bearer"}
        if req.headers.get("Authorization") != "Bearer " + ACCESS_TOKEN:
            return 401, {"status": "error", "category": "INVALID_AUTHENTICATION"}
        p, q = req.path, req.query
        if req.method == "GET" and p == "/account-info/v3/details":
            return 200, {"portalId": PORTAL_ID, "timeZone": "US/Arizona"}
        if req.method == "GET" and p == "/crm/v3/owners":
            if q.get("archived") == "true":
                return 200, {"results": []}
            return 200, {"results": [{"id": "1", "firstName": "Test", "lastName": "Owner",
                                      "email": "owner@example.com", "archived": False}]}
        if req.method == "GET" and p == "/crm/v3/pipelines/deals":
            return 200, {"results": [{"id": "default", "label": "Sales", "stages": [
                {"id": "s1", "label": "Open", "displayOrder": 0, "metadata": {"isClosed": "false", "probability": "0.2"}},
                {"id": "s2", "label": "Won", "displayOrder": 1, "metadata": {"isClosed": "true", "probability": "1.0"}},
            ]}]}
        if req.method == "GET" and p == "/crm/v3/properties/contacts":
            return 200, {"results": [{"name": n, "label": n, "type": "string"} for n in self.properties]}
        if req.method == "GET" and p == "/crm/v3/properties/meetings":
            if self.meeting_properties_status != 200:
                return self.meeting_properties_status, {"status": "error", "category": "MISSING_SCOPES"}
            return 200, {"results": [{"name": n, "label": label, "type": "string"}
                                     for n, label in self.meeting_properties]}
        if req.method == "POST" and p.startswith("/crm/v3/objects/") and p.endswith("/search"):
            return self._search(p.split("/")[4], req.json())
        if req.method == "GET" and p.startswith("/crm/v4/objects/"):
            return 200, {"results": []}
        if req.method == "POST" and p.endswith("/batch/read"):
            return 200, {"status": "COMPLETE", "results": []}
        if req.method == "GET" and p == "/marketing/v3/forms":
            hit = self._maybe_429("forms")
            if hit:
                return hit
            if self.forms_status != 200:
                return self.forms_status, {"status": "error", "category": "MISSING_SCOPES"}
            forms = [f for f in self.forms if f["archived"] == (q.get("archived") == "true")]
            return self._paged(forms, q.get("after"), self.FORMS_PAGE)
        if req.method == "GET" and p.startswith("/form-integrations/v1/submissions/forms/"):
            fid = p.rsplit("/", 1)[1]
            hit = self._maybe_429("submissions:" + fid)
            if hit:
                return hit
            if fid not in self.submissions:
                return 404, {"status": "error", "message": "form not found"}
            return self._paged(self.submissions[fid], q.get("after"), min(int(q.get("limit") or 20), 50))
        if req.method == "POST" and p == "/crm/v3/lists/search":
            if self.lists_shape == "no-lists":
                return 200, {"results": [], "total": len(self.lists)}
            if self.lists_shape == "empty":
                return 200, {"lists": [], "hasMore": False, "offset": 0, "total": 0}
            body = req.json() or {}
            off = int(body.get("offset") or 0)
            page = self.lists[off:off + self.LISTS_PAGE]
            out = [dict(x, createdAt=iso(self.now - timedelta(days=40)), updatedAt=iso(self.now - timedelta(days=1)),
                        additionalProperties={"hs_list_size": str(len(self.members[x["listId"]]))}) for x in page]
            more = off + len(page) < len(self.lists)
            return 200, {"lists": out, "hasMore": more, "offset": off + len(page), "total": len(self.lists)}
        if req.method == "GET" and p.startswith("/crm/v3/lists/") and p.endswith("/memberships"):
            lid = p.split("/")[4]
            if self.members_status.get(lid, 200) != 200:
                return self.members_status[lid], {"status": "error", "message": "internal error"}
            rows = [{"recordId": str(r), "membershipTimestamp": iso(self.now - timedelta(days=3))}
                    for r in self.members.get(lid, [])]
            return self._paged(rows, q.get("after"), min(int(q.get("limit") or 100), 250))
        if req.method == "GET" and p == "/crm/v3/imports":
            if self.imports_status != 200:
                return self.imports_status, {"status": "error", "category": "MISSING_SCOPES"}
            return 200, {"results": self.imports}
        return 404, {"status": "error", "message": "fake has no route %s %s" % (req.method, p)}

    @staticmethod
    def _paged(rows, after, size):
        start = int(after or 0)
        page = rows[start:start + size]
        out = {"results": page}
        if start + size < len(rows):
            out["paging"] = {"next": {"after": str(start + size), "link": "?after=%d" % (start + size)}}
        return 200, out

    def _search(self, otype, body):
        if otype == "contacts":
            objs, modfield, fail = self.contacts, "lastmodifieddate", self.fail_backfill_after
            known = self.properties
        elif otype == "meetings":
            objs, modfield, fail = self.meetings, "hs_lastmodifieddate", self.fail_meeting_backfill_after
            known = [n for n, _label in self.meeting_properties]
        else:
            return 200, {"total": 0, "results": []}
        flt = body["filterGroups"][0]["filters"][0]
        limit = int(body.get("limit") or 10)
        wanted = body.get("properties") or []
        if flt["propertyName"] == "hs_object_id" and flt["operator"] == "GT":
            if fail is not None and str(flt["value"]) == str(fail):
                return 500, {"status": "error", "message": "internal error"}
            ids = sorted(i for i in objs if i > int(flt["value"]))
            start = 0
        elif flt["propertyName"] == modfield and flt["operator"] == "GTE":
            since = int(flt["value"])
            ids = sorted((i for i in objs if ms(parse_iso(objs[i][modfield])) >= since),
                         key=lambda i: objs[i][modfield])
            start = int(body.get("after") or 0)
        else:
            return 400, {"status": "error", "message": "fake does not support this filter"}
        page = ids[start:start + limit]
        out = {"total": len(ids), "results": [
            {"id": str(i), "properties": {k: objs[i].get(k) for k in wanted if k in known or k in objs[i]},
             "createdAt": iso(self.now - timedelta(days=90)), "updatedAt": objs[i][modfield],
             "archived": False} for i in page]}
        if start + limit < len(ids):
            out["paging"] = {"next": {"after": str(start + limit)}}
        return 200, out


# ---------------------------------------------------------------- Lemlist

class LemlistFake:
    def __init__(self, now):
        self.now = now
        self.campaigns = [
            {"_id": "cam_test1", "name": "Test campaign 1", "status": "running",
             "createdAt": iso(now - timedelta(days=50))},
            {"_id": "cam_test2", "name": "Test campaign 2", "status": "paused",
             "createdAt": iso(now - timedelta(days=20))},
        ]
        self.export = {"cam_test1": [
            {"_id": "lea_t1_%d" % k, "email": "lead%d@example.com" % k, "companyDomain": "example.com",
             "firstName": "Lead%d" % k, "lastState": "emailsReplied" if k == 1 else "emailsOpened",
             "status": "done", "emailStatus": "deliverable"} for k in (1, 2, 3)]}
        self.export_status = {"cam_test2": 500}
        # The paged leads route: 150 leads, so two pages of 100.
        self.paged_leads = {"cam_test2": [{"_id": "lea_t2_%d" % k, "contactId": "ctc_t2_%d" % k,
                                           "state": "contacted"} for k in range(150)]}
        a = []

        def act(aid, typ, cid, lid, when, **extra):
            a.append(dict({"_id": aid, "type": typ, "campaignId": cid, "leadId": lid, "createdAt": iso(when),
                           "leadEmail": "lead@example.com", "bot": False, "isFirst": True,
                           "lead": {"_id": lid, "email": "lead@example.com"}}, **extra))
        d = lambda n: now - timedelta(days=n)  # noqa: E731
        act("act_s1", "emailsSent", "cam_test1", "lea_t1_1", d(40))
        act("act_o1", "emailsOpened", "cam_test1", "lea_t1_1", d(39))
        act("act_o1b", "emailsOpened", "cam_test1", "lea_t1_1", d(35))
        act("act_c1", "emailsClicked", "cam_test1", "lea_t1_1", d(39) + timedelta(hours=1))
        act("act_r1", "emailsReplied", "cam_test1", "lea_t1_1", d(38),
            messagePreview="I am out of the office until Monday", text="Auto-reply: out of office")
        act("act_r1b", "emailsReplied", "cam_test1", "lea_t1_1", d(33), messagePreview="Sounds good, let us talk")
        act("act_m1", "meetingBooked", "cam_test1", "lea_t1_1", d(30))
        act("act_s2", "emailsSent", "cam_test1", "lea_t1_2", d(40))
        act("act_l3", "linkedinReplied", "cam_test1", "lea_t1_3", d(25), text="Thanks!")
        for k in range(150):
            act("act_t2_s%d" % k, "emailsSent", "cam_test2", "lea_t2_%d" % k, d(10) + timedelta(minutes=k))
        self.activities = a
        self.activities_status = 200
        self.once_429 = set()

    def add_reply(self, aid, lead_id, when):
        self.activities.append({"_id": aid, "type": "emailsReplied", "campaignId": "cam_test1", "leadId": lead_id,
                                "createdAt": iso(when), "leadEmail": "lead@example.com", "bot": False,
                                "isFirst": False, "messagePreview": "Following up"})

    def _authed(self, req):
        if req.query.get("access_token") == LEMLIST_KEY:
            return True
        import base64
        return req.headers.get("Authorization") == "Basic " + base64.b64encode((":" + LEMLIST_KEY).encode()).decode()

    def handle(self, req):
        if req.method != "GET":
            return 405, {"error": "fake lemlist is read-only"}
        if not self._authed(req):
            return 401, {"error": "Unauthorized"}
        p, q = req.path.rstrip("/"), req.query
        if p == "/api/campaigns":
            return 200, self.campaigns
        parts = p.split("/")
        if p.startswith("/api/v2/campaigns/") and p.endswith("/stats"):
            return 200, {"messagesSent": 10, "opened": 5, "replied": 1}
        if p.startswith("/api/v2/campaigns/") and p.endswith("/export/leads"):
            cid = parts[4]
            status = self.export_status.get(cid, 200)
            if status != 200:
                return status, {"error": "export failed"}
            if q.get("format") != "json":
                return 400, {"error": "fake only serves JSON"}
            return 200, self.export.get(cid, [])
        if p.startswith("/api/campaigns/") and p.endswith("/leads"):
            rows = self.paged_leads.get(parts[3], [])
            off, lim = int(q.get("offset") or 0), min(int(q.get("limit") or 100), 100)
            return 200, rows[off:off + lim]
        if p == "/api/activities":
            if "activities" in self.once_429:
                self.once_429.discard("activities")
                return 429, {"error": "Too many requests"}
            if self.activities_status != 200:
                return self.activities_status, {"error": "activities failed"}
            if q.get("version") != "v2":
                return 400, {"error": "version=v2 is required"}
            rows = [x for x in self.activities if x["type"] == q.get("type")
                    and (not q.get("campaignId") or x["campaignId"] == q["campaignId"])
                    and (not q.get("minDate") or parse_iso(x["createdAt"]) >= parse_iso(q["minDate"]))
                    and (not q.get("maxDate") or parse_iso(x["createdAt"]) <= parse_iso(q["maxDate"]))]
            rows.sort(key=lambda x: x["createdAt"], reverse=True)
            off, lim = int(q.get("offset") or 0), min(int(q.get("limit") or 100), 100)
            return 200, rows[off:off + lim]
        return 404, {"error": "fake has no route " + p}


# ---------------------------------------------------------------- server

class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    tunnel_host = None

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        host = self.path.rsplit(":", 1)[0]
        world = self.server.world
        if host not in world.apis:
            world.refused_connects.append(host)
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            self.close_connection = True
            return
        self.send_response(200, "Connection established")
        self.end_headers()
        tls = world.tls.wrap_socket(self.connection, server_side=True)
        self.connection = tls
        self.rfile = tls.makefile("rb", -1)
        self.wfile = socketserver._SocketWriter(tls)
        self.tunnel_host = host
        self.close_connection = False

    def _any(self):
        world = self.server.world
        parsed = urllib.parse.urlsplit(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        host = self.tunnel_host or "secretsmanager"
        req = Request(host, self.command, parsed.path, dict(urllib.parse.parse_qsl(parsed.query)),
                      self.headers, body)
        with world.lock:
            world.requests.append(req)
            if self.tunnel_host:
                status, payload = world.apis[host].handle(req)
            elif self.headers.get("X-Amz-Target", "").startswith("secretsmanager."):
                status, payload = world.secrets.handle(req)
            else:
                status, payload = 502, {"error": "plain HTTP to the fake proxy"}
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/x-amz-json-1.1" if host == "secretsmanager"
                         else "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _any

    def finish(self):
        try:
            super().finish()
        finally:
            if self.tunnel_host:
                try:
                    self.connection.close()
                except OSError:
                    pass


class FakeWorld:
    """Start with FakeWorld(tmpdir).start(); env() gives the variables for a sync subprocess."""

    def __init__(self, tmp: Path):
        self.tmp = Path(tmp)
        self.now = datetime.now(timezone.utc)
        self.hubspot = HubSpotFake(self.now)
        self.lemlist = LemlistFake(self.now)
        self.secrets = SecretsManagerFake()
        self.apis = {HUBSPOT_HOST: self.hubspot, LEMLIST_HOST: self.lemlist}
        self.requests = []
        self.refused_connects = []
        self.lock = threading.Lock()
        self.ca, cert, key = make_ca(self.tmp)
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(str(cert), str(key))

    def start(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.daemon_threads = True
        self.server.world = self
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def env(self, base_env, brain_db):
        url = "http://127.0.0.1:%d" % self.server.server_address[1]
        env = {k: v for k, v in base_env.items()
               if not k.startswith(("GTM_SECRET_", "AWS_", "HUBSPOT_", "LEMLIST_", "LIST_"))
               and k.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
        env.update({
            "BRAIN_DB": str(brain_db),
            "HTTPS_PROXY": url, "https_proxy": url, "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
            "SSL_CERT_FILE": str(self.ca),
            "AWS_ENDPOINT_URL": url, "AWS_ENDPOINT_URL_SECRETS_MANAGER": url,
            "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing", "AWS_REGION": "us-east-2",
            "AWS_CONFIG_FILE": str(self.tmp / "no-aws-config"),
            "AWS_SHARED_CREDENTIALS_FILE": str(self.tmp / "no-aws-credentials"),
            "AWS_EC2_METADATA_DISABLED": "true",
            "GTM_SECRET_LEMLIST_TOKEN": LEMLIST_KEY,
        })
        return env

    def take_requests(self):
        with self.lock:
            out, self.requests = self.requests, []
        return out
