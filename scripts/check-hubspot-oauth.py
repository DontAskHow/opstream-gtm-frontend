#!/usr/bin/env python3
"""HubSpot OAuth refresh, portal check, and the read-only call guard."""
import ast
import json
import logging
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "refresh" / "brain-sync"))

import common
from common import HubSpotClient, NeedsConnection, SecretVersionChanged, assert_hubspot_read

REFRESH = "hubspot-refresh-fixture"
ACCESS = "hubspot-access-fixture"
NEW_REFRESH = "hubspot-refresh-rotated-fixture"
OTHER_REFRESH = "hubspot-refresh-other-writer-fixture"
CLIENT_SECRET = "hubspot-client-secret-fixture"

failures = []


def check(name, ok):
    if ok:
        print("ok", name)
    else:
        failures.append(name)
        print("FAIL", name)


def secret_doc(refresh=REFRESH):
    return {
        "portal_id": "21303277",
        "client_id": "hubspot-client-id",
        "client_secret": CLIENT_SECRET,
        "refresh_token": refresh,
        "token_endpoint": "https://api.hubapi.com/oauth/2026-03/token",
        "api_base": "https://api.hubapi.com",
        "note": "keep-me",
    }


class FakeStore:
    def __init__(self, doc, version="v1"):
        self.doc = dict(doc)
        self.version = version
        self.describe_version = version
        self.puts = []
        self.raise_on_put = False
        self.reread = None
        self.gets = 0

    def get_current(self):
        self.gets += 1
        if self.reread is not None and self.gets > 1:
            return dict(self.reread), self.describe_version
        return dict(self.doc), self.version

    def current_version(self):
        return self.describe_version

    def put_current(self, document, expected_version_id):
        if self.raise_on_put or self.describe_version != expected_version_id:
            raise SecretVersionChanged()
        if not isinstance(document.get("refresh_token"), str) or not document["refresh_token"].strip():
            raise AssertionError("empty refresh token was written")
        self.puts.append(json.loads(json.dumps(document)))
        self.doc = dict(document)
        self.version = "v-written"
        self.describe_version = "v-written"


class Http:
    def __init__(self, token_payload, account=None):
        self.token_payload = token_payload
        self.account = account or {"portalId": 21303277, "accountType": "STANDARD"}
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        if url.endswith("/oauth/2026-03/token"):
            return 200, json.dumps(self.token_payload).encode()
        if url.endswith("/account-info/v3/details"):
            return 200, json.dumps(self.account).encode()
        if url.endswith("/search"):
            return 200, json.dumps({"results": [{"id": "1"}]}).encode()
        return 200, b"{}"


def logger():
    log = logging.getLogger("hubspot-test")
    log.handlers.clear()
    log.setLevel(logging.INFO)
    buf = []

    class ListHandler(logging.Handler):
        def emit(self, record):
            buf.append(record.getMessage())

    log.addHandler(ListHandler())
    return log, buf


def form(body):
    return dict(urllib.parse.parse_qsl(body.decode()))


def test_refresh_cache_and_portal():
    store = FakeStore(secret_doc())
    http = Http({"access_token": ACCESS, "expires_in": 1800, "hub_id": 21303277})
    now = {"t": 0.0}
    log, buf = logger()
    client = HubSpotClient(store=store, http=http, clock=lambda: now["t"], log=log)
    client.prepare()
    now["t"] = 1679
    client.access_token()
    now["t"] = 1680
    client.access_token()
    token_posts = [c for c in http.calls if c[0] == "POST" and c[1].endswith("/token")]
    check("cached until two minutes before expiry", len(token_posts) == 2)
    posted = form(token_posts[0][3])
    check(
        "refresh form",
        posted.get("grant_type") == "refresh_token"
        and posted.get("client_id") == "hubspot-client-id"
        and posted.get("client_secret") == CLIENT_SECRET
        and posted.get("refresh_token") == REFRESH
        and token_posts[0][2].get("Content-Type") == "application/x-www-form-urlencoded",
    )
    check("portal get", any(c[0] == "GET" and c[1].endswith("/account-info/v3/details") for c in http.calls))
    check("no rotation write", store.puts == [])
    check(
        "refresh log",
        buf == [
            "refresh ok, expires_in 1800, rotated no",
            "refresh ok, expires_in 1800, rotated no",
        ],
    )
    text = "\n".join(buf)
    check("log hides tokens", REFRESH not in text and ACCESS not in text and CLIENT_SECRET not in text)


def test_rotation_preserves_fields():
    store = FakeStore(secret_doc())
    http = Http({
        "access_token": ACCESS,
        "expires_in": 1800,
        "refresh_token": NEW_REFRESH,
        "hub_id": "21303277",
    })
    log, buf = logger()
    client = HubSpotClient(store=store, http=http, clock=lambda: 0.0, log=log)
    client.prepare()
    check("rotated once", len(store.puts) == 1)
    written = store.puts[0]
    check(
        "rotation keeps the other fields",
        written["refresh_token"] == NEW_REFRESH
        and written["client_id"] == "hubspot-client-id"
        and written["client_secret"] == CLIENT_SECRET
        and written["portal_id"] == "21303277"
        and written["token_endpoint"] == "https://api.hubapi.com/oauth/2026-03/token"
        and written["api_base"] == "https://api.hubapi.com"
        and written["note"] == "keep-me",
    )
    check("rotated yes", buf == ["refresh ok, expires_in 1800, rotated yes"])
    check("rotation log hides tokens", NEW_REFRESH not in "\n".join(buf) and REFRESH not in "\n".join(buf))


def test_absent_refresh_is_not_written():
    store = FakeStore(secret_doc())
    http = Http({"access_token": ACCESS, "expires_in": 1800, "refresh_token": ""})
    log, buf = logger()
    HubSpotClient(store=store, http=http, clock=lambda: 0.0, log=log).prepare()
    check("empty refresh not written", store.puts == [] and buf == ["refresh ok, expires_in 1800, rotated no"])
    store2 = FakeStore(secret_doc())
    http2 = Http({"access_token": ACCESS, "expires_in": 1800, "hub_id": 21303277})
    HubSpotClient(store=store2, http=http2, clock=lambda: 0.0, log=logging.getLogger("silent")).prepare()
    check("missing refresh not written", store2.puts == [])


def test_version_change_does_not_clobber():
    store = FakeStore(secret_doc())
    store.describe_version = "v2"
    store.reread = secret_doc(OTHER_REFRESH)
    http = Http({
        "access_token": ACCESS,
        "expires_in": 1800,
        "refresh_token": NEW_REFRESH,
        "hub_id": 21303277,
    })
    log, buf = logger()
    client = HubSpotClient(store=store, http=http, clock=lambda: 0.0, log=log)
    client.prepare()
    check("newer version not overwritten", store.puts == [])
    check("version conflict rotated no", buf == ["refresh ok, expires_in 1800, rotated no"])
    now = {"t": 0.0}
    client.clock = lambda: now["t"]
    now["t"] = 1800
    client.access_token()
    posts = [c for c in http.calls if c[1].endswith("/token")]
    second = form(posts[-1][3])
    check("reread token is used next", second.get("refresh_token") == OTHER_REFRESH and NEW_REFRESH not in posts[-1][3].decode())

    store3 = FakeStore(secret_doc())
    store3.raise_on_put = True
    store3.reread = secret_doc(OTHER_REFRESH)
    store3.describe_version = "v1"
    http3 = Http({"access_token": ACCESS, "expires_in": 1800, "refresh_token": NEW_REFRESH, "hub_id": 21303277})
    HubSpotClient(store=store3, http=http3, clock=lambda: 0.0, log=logging.getLogger("race")).prepare()
    check("put race does not clobber", store3.puts == [])


def test_wrong_portal_aborts():
    store = FakeStore(secret_doc())
    http = Http({"access_token": ACCESS, "expires_in": 1800, "hub_id": 999})
    try:
        HubSpotClient(store=store, http=http, clock=lambda: 0.0, log=logging.getLogger("bad-hub")).prepare()
        check("bad hub_id aborts", False)
    except NeedsConnection as exc:
        check("bad hub_id aborts", "21303277" in str(exc) and ACCESS not in str(exc) and REFRESH not in str(exc))
    check("bad hub_id skips account-info", not any("account-info" in c[1] for c in http.calls))

    http2 = Http({"access_token": ACCESS, "expires_in": 1800}, account={"portalId": 1, "accountType": "STANDARD"})
    try:
        HubSpotClient(store=FakeStore(secret_doc()), http=http2, clock=lambda: 0.0, log=logging.getLogger("bad-portal")).prepare()
        check("bad portal aborts", False)
    except NeedsConnection as exc:
        check("bad portal aborts", "21303277" in str(exc) and ACCESS not in str(exc))
    search_calls = [c for c in http2.calls if c[1].endswith("/search")]
    check("bad portal makes no search", search_calls == [])


def test_guard():
    try:
        assert_hubspot_read("POST", "https://api.hubapi.com/crm/v3/objects/deals")
        check("non-search post refused", False)
    except RuntimeError:
        check("non-search post refused", True)
    try:
        assert_hubspot_read("DELETE", "https://api.hubapi.com/crm/v3/objects/deals/1")
        check("delete refused", False)
    except RuntimeError:
        check("delete refused", True)
    try:
        assert_hubspot_read("PUT", "https://api.hubapi.com/crm/v3/objects/deals/1")
        check("put refused", False)
    except RuntimeError:
        check("put refused", True)
    assert_hubspot_read("GET", "https://api.hubapi.com/account-info/v3/details")
    assert_hubspot_read("POST", "https://api.hubapi.com/crm/v3/objects/deals/search")
    check("get and search allowed", True)

    store = FakeStore(secret_doc())
    http = Http({"access_token": ACCESS, "expires_in": 1800, "hub_id": 21303277})
    client = HubSpotClient(store=store, http=http, clock=lambda: 0.0, log=logging.getLogger("guard"))
    client.prepare()
    before = len(http.calls)
    try:
        client.request("POST", "https://api.hubapi.com/crm/v3/objects/deals", body={"properties": {}})
        check("client blocks write", False)
    except RuntimeError:
        check("client blocks write", True)
    check("blocked write made no call", len(http.calls) == before)
    status, payload = client.request(
        "POST", client.api_base + "/crm/v3/objects/deals/search", body={"limit": 1},
    )
    check("search post allowed", status == 200 and payload.get("results"))

    src = (ROOT / "refresh" / "brain-sync" / "hubspot_sync.py").read_text()
    tree = ast.parse(src)
    methods = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value.upper() in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                methods.append(node.value.upper())
    check("source has no write verbs", "PUT" not in methods and "PATCH" not in methods and "DELETE" not in methods)
    check("source does not open urls itself", "urlopen" not in src and "authed_request" not in src and "urllib" not in src)
    lines = src.splitlines()
    posts = []
    for i, line in enumerate(lines):
        if "POST" not in line:
            continue
        window = "\n".join(lines[max(0, i - 2):i + 2])
        if "request" in window:
            posts.append(window)
    check("only search post in source", len(posts) == 1 and "/search" in posts[0] and "POST" in methods)


def test_json_is_not_a_bearer():
    raw = json.dumps(secret_doc())
    try:
        common.materialize_token(raw, None)
        check("oauth json is not a bearer", False)
    except NeedsConnection as exc:
        text = str(exc)
        check("oauth json is not a bearer", "HubSpot" in text and REFRESH not in text and CLIENT_SECRET not in text)


def main():
    test_refresh_cache_and_portal()
    test_rotation_preserves_fields()
    test_absent_refresh_is_not_written()
    test_version_change_does_not_clobber()
    test_wrong_portal_aborts()
    test_guard()
    test_json_is_not_a_bearer()
    if failures:
        print("failures", failures)
        sys.exit(1)


if __name__ == "__main__":
    main()
