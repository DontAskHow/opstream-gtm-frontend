#!/usr/bin/env python3
"""google_access_token: missing secret, rejected refresh, no token in the error."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "refresh" / "brain-sync"))

REFRESH = "refresh-token-unit-fixture"
ACCESS = "access-token-unit-fixture"

for key in list(os.environ):
    if key.startswith("GTM_SECRET_"):
        del os.environ[key]

import common

failures = []


def check(name, ok):
    if ok:
        print("ok", name)
    else:
        failures.append(name)
        print("FAIL", name)


try:
    common.google_access_token()
    check("missing secret", False)
except common.NeedsConnection as exc:
    text = str(exc)
    check("missing secret", "google-sheets-refresh-token" in text and REFRESH not in text)

os.environ["GTM_SECRET_GOOGLE_SHEETS_REFRESH_TOKEN"] = REFRESH
os.environ["GTM_SECRET_GOOGLE_OAUTH_CLIENT_ID"] = "client-id"
os.environ["GTM_SECRET_GOOGLE_OAUTH_CLIENT_SECRET"] = "client-secret"
common._TOKEN_CACHE.clear()


class Boom:
    def __init__(self, **kwargs):
        self.token = None

    def refresh(self, request):
        raise RuntimeError(REFRESH)


try:
    common.google_access_token(credentials_cls=Boom)
    check("rejected hides token", False)
except common.NeedsConnection as exc:
    text = str(exc)
    check("rejected hides token", REFRESH not in text and "rejected" in text)

common._TOKEN_CACHE.clear()


class Ok:
    def __init__(self, **kwargs):
        if kwargs.get("refresh_token") != REFRESH:
            raise AssertionError("refresh token was not passed to Credentials")
        scopes = " ".join(kwargs.get("scopes") or [])
        if "spreadsheets.readonly" not in scopes or "analytics.readonly" not in scopes:
            raise AssertionError("scopes")
        self.token = ACCESS
        self.expiry = None

    def refresh(self, request):
        if request is None:
            raise AssertionError("request")


check("fake access", common.google_access_token(credentials_cls=Ok) == ACCESS)

common._TOKEN_CACHE.clear()
from google.oauth2.credentials import Credentials


class FakeRequest:
    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        if "oauth2.googleapis.com/token" not in str(url):
            raise AssertionError("token uri")
        blob = body.decode() if isinstance(body, bytes) else str(body or "")
        if REFRESH not in blob:
            raise AssertionError("refresh token was not sent to the token endpoint")
        raw = json.dumps({
            "access_token": ACCESS,
            "expires_in": 3600,
            "token_type": "Bearer",
        }).encode()
        return common._HttpResult(200, raw)


check(
    "google-auth exchange",
    common.google_access_token(credentials_cls=Credentials, request=FakeRequest()) == ACCESS,
)

if failures:
    sys.exit(1)
