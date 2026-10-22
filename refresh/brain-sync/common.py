"""Shared helpers for company-brain incremental sync scripts.

The sync logic matches the canonical scripts. Authentication does not.
Those scripts called a vault (`dynamic_credentials`, `hsurr:*` tokens).
This copy reads Secrets Manager `opstream-gtm/<name>`, or the
`GTM_SECRET_<NAME>` variable the refresh job sets when that secret exists.
Raw values are sent only to the provider host the script names. They are
not written to logs.

Exit codes:
  0  success (watermarks updated)
  1  runtime error (watermarks NOT updated)
  3  needs connection: the secret is missing or rejected
     (watermarks NOT updated)
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NEEDS_CONNECTION = 3

BRAIN_DB = Path(os.environ.get("BRAIN_DB") or (Path.home() / "workspace" / "brain" / "brain.db"))
SYNC_DIR = Path(__file__).resolve().parent
LOG_DIR = SYNC_DIR / "logs"
LONG_TEXT_LIMIT = 8000

# Vault connector names the canonical scripts pass, mapped to secret names.
CONNECTOR_TO_SECRET = {
    "custom.hubspot": "hubspot-oauth",
    "hubspot": "hubspot-oauth",
    "custom.fathom": "fathom-token",
    "fathom": "fathom-token",
    "custom.otterly": "otterly-token",
    "otterly": "otterly-token",
    "custom.google-analytics": "google-sheets-refresh-token",
    "google.analytics": "google-sheets-refresh-token",
    "custom.google": "google-sheets-refresh-token",
    "custom.lemlist": "lemlist-token",
    "lemlist": "lemlist-token",
    "google_sheets": "google-sheets-refresh-token",
    "google-sheets": "google-sheets-refresh-token",
    "google-sheets-refresh-token": "google-sheets-refresh-token",
}

# Scopes granted by /admin/connect-sheets. Refreshing with this same set
# keeps Google from rejecting the token as invalid_scope.
GOOGLE_USER_SCOPES = (
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/analytics.readonly",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
)

HOST_SCOPES = {
    "sheets.googleapis.com": "https://www.googleapis.com/auth/spreadsheets.readonly",
    "analyticsdata.googleapis.com": "https://www.googleapis.com/auth/analytics.readonly",
}

_TOKEN_CACHE = {}


class NeedsConnection(Exception):
    """No usable credential for this source in the current environment."""


class SourceRefused(NeedsConnection):
    """The API answered 401 or 403: this key cannot read the route."""

    def __init__(self, host, route, status, detail=""):
        self.host, self.route, self.status = host, route, status
        super().__init__("%s %s answered HTTP %s%s" % (host, route, status, (": " + detail) if detail else ""))


class SourceError(Exception):
    """The API answered with an unexpected status for a route."""

    def __init__(self, host, route, status, detail=""):
        self.host, self.route, self.status = host, route, status
        super().__init__("%s %s answered HTTP %s%s" % (host, route, status, (": " + detail) if detail else ""))


class SourceSkipped(Exception):
    """The sync chose not to call the API (for example, a quota rule)."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def setup_logger(source: str) -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{source}-{datetime.now(timezone.utc):%Y%m%d}.log"
    logger = logging.getLogger(f"sync.{source}")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        fh = logging.FileHandler(log_path)
        fh.setFormatter(fmt)
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        logger.addHandler(fh)
        logger.addHandler(sh)
    return logger


def _env_key(name: str) -> str:
    return "GTM_SECRET_" + str(name).upper().replace("-", "_").replace(".", "_")


def _read_secret_string(name: str) -> str:
    mapped = CONNECTOR_TO_SECRET.get(name, name)
    for candidate in (mapped, name):
        val = os.environ.get(_env_key(candidate))
        if val and val.strip():
            return val.strip()
    secret_id = "opstream-gtm/" + mapped
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-2"
    try:
        import boto3
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_id)
        raw = (resp.get("SecretString") or "").strip()
    except Exception as exc:
        raise NeedsConnection(
            "secret %s is not present (%s)" % (secret_id, type(exc).__name__)
        )
    if not raw:
        raise NeedsConnection("secret %s is empty" % secret_id)
    return raw


def get_surrogate(*candidate_names: str) -> str:
    """Return the secret for the first connector that is provisioned."""
    tried = []
    last_err = None
    for name in candidate_names:
        tried.append(name)
        try:
            return _read_secret_string(name)
        except NeedsConnection as exc:
            last_err = exc
            continue
    raise NeedsConnection(
        "no secret among %s (last: %s). Not touching watermarks." % (tried, last_err)
    )


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _post_form(url: str, form: dict) -> dict:
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        raise NeedsConnection("Google token endpoint returned HTTP %s" % exc.code)


def _service_account_token(info: dict, scope: str) -> str:
    email = info.get("client_email") or ""
    key = info.get("private_key") or ""
    if not email or "BEGIN" not in key:
        raise NeedsConnection("service-account JSON is missing client_email or a PEM private_key")
    cache_key = (email, scope)
    cached = _TOKEN_CACHE.get(cache_key)
    if cached and cached[0] > time.time() + 60:
        return cached[1]
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = {
        "iss": email,
        "scope": scope,
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    body = _b64url(json.dumps(claims).encode())
    signing_input = (header + "." + body).encode()
    fd, path = tempfile.mkstemp(prefix="gtm-sa-", suffix=".pem")
    try:
        os.write(fd, key.encode())
        os.close(fd)
        os.chmod(path, 0o600)
        proc = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", path],
            input=signing_input, capture_output=True, timeout=20,
        )
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise NeedsConnection("could not sign a Google token with the service-account key")
    assertion = header + "." + body + "." + _b64url(proc.stdout)
    tok = _post_form("https://oauth2.googleapis.com/token", {
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    })
    access = tok.get("access_token")
    if not access:
        raise NeedsConnection("Google token endpoint did not return an access_token")
    _TOKEN_CACHE[cache_key] = (time.time() + int(tok.get("expires_in") or 3600), access)
    return access


def _refresh_token(info: dict, scope: str | None) -> str:
    cache_key = ("refresh", info.get("client_id"), scope or "")
    cached = _TOKEN_CACHE.get(cache_key)
    if cached and cached[0] > time.time() + 60:
        return cached[1]
    form = {
        "client_id": info.get("client_id") or "",
        "client_secret": info.get("client_secret") or "",
        "refresh_token": info.get("refresh_token") or "",
        "grant_type": "refresh_token",
    }
    if scope:
        form["scope"] = scope
    tok = _post_form("https://oauth2.googleapis.com/token", form)
    access = tok.get("access_token")
    if not access:
        raise NeedsConnection("Google refresh did not return an access_token")
    _TOKEN_CACHE[cache_key] = (time.time() + int(tok.get("expires_in") or 3600), access)
    return access


def materialize_token(raw: str, scope: str | None) -> str:
    """Turn a secret string into the value that goes on the wire.

    A plain token is returned as-is. A Google service-account or refresh-token
    JSON is exchanged for a short-lived access token and is never sent itself.
    """
    text = (raw or "").strip()
    if not text:
        raise NeedsConnection("secret is empty")
    try:
        parsed = json.loads(text)
    except Exception:
        return text
    if isinstance(parsed, str):
        return parsed.strip()
    if not isinstance(parsed, dict):
        raise NeedsConnection("secret JSON is not an object or a token string")
    if parsed.get("type") == "service_account" or parsed.get("private_key"):
        if not scope:
            raise NeedsConnection("service-account JSON needs a Google API scope")
        return _service_account_token(parsed, scope)
    endpoint = str(parsed.get("token_endpoint") or "")
    if "hubapi.com" in endpoint or parsed.get("portal_id"):
        raise NeedsConnection("HubSpot OAuth JSON cannot be used as a bearer token")
    if parsed.get("refresh_token") and parsed.get("client_id"):
        return _refresh_token(parsed, scope)
    for key in ("token", "access_token", "api_key", "apiKey", "value"):
        if isinstance(parsed.get(key), str) and parsed[key].strip():
            return parsed[key].strip()
    raise NeedsConnection("secret JSON has no token field")


def access_token_for(connector_names, scope: str | None = None) -> str:
    return materialize_token(get_surrogate(*connector_names), scope)


class _HttpResult:
    def __init__(self, status: int, data: bytes):
        self.status = status
        self.data = data if isinstance(data, bytes) else bytes(data or b"")


class _StdlibRequest:
    """google-auth transport that uses urllib. No token is logged."""

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        data = body.encode("utf-8") if isinstance(body, str) else body
        req = urllib.request.Request(url, data=data, headers=dict(headers or {}), method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout or 30) as resp:
                return _HttpResult(resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            return _HttpResult(exc.code, exc.read())


def google_access_token(scopes=None, credentials_cls=None, request=None) -> str:
    """Access token for the owner's Google account.

    Reads opstream-gtm/google-sheets-refresh-token plus the OAuth client id
    and secret. There is no service account. A missing secret or a rejected
    refresh raises NeedsConnection without the token or the provider error.
    """
    scope_list = tuple(scopes or GOOGLE_USER_SCOPES)
    cache_key = ("google-user", " ".join(scope_list))
    cached = _TOKEN_CACHE.get(cache_key)
    if cached and cached[0] > time.time() + 60:
        return cached[1]
    refresh = _read_secret_string("google-sheets-refresh-token")
    client_id = _read_secret_string("google-oauth-client-id")
    client_secret = _read_secret_string("google-oauth-client-secret")
    try:
        if credentials_cls is None:
            from google.oauth2.credentials import Credentials as credentials_cls
        creds = credentials_cls(
            token=None,
            refresh_token=refresh,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
            scopes=list(scope_list),
        )
        creds.refresh(request if request is not None else _StdlibRequest())
    except NeedsConnection:
        raise
    except Exception:
        raise NeedsConnection("Google refresh token was rejected. Not touching watermarks.")
    access = getattr(creds, "token", None)
    if not access:
        raise NeedsConnection("Google refresh did not return an access token")
    expires = time.time() + 3300
    expiry = getattr(creds, "expiry", None)
    if expiry is not None and hasattr(expiry, "timestamp"):
        expires = expiry.timestamp()
    _TOKEN_CACHE[cache_key] = (expires, access)
    return access


def authed_request(
    method: str,
    url: str,
    connector_names: list[str],
    allowed_hosts: list[str],
    body: dict | None = None,
    extra_headers: dict | None = None,
    timeout: float = 60.0,
    auth: str = "bearer",
) -> tuple[int, dict | list | str]:
    """Authenticated request, only to an allowed host.

    auth="bearer" sends Authorization: Bearer; auth="x-api-key" sends X-Api-Key
    and no Authorization header. 401/403 raise SourceRefused with the route.
    """
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if allowed_hosts and host not in allowed_hosts:
        raise NeedsConnection("refusing to send a credential to %s" % host)
    scope = None
    for allowed in allowed_hosts or []:
        if allowed in HOST_SCOPES:
            scope = HOST_SCOPES[allowed]
    token = access_token_for(connector_names, scope)
    data = None
    if auth == "x-api-key":
        headers = {"Accept": "application/json", "X-Api-Key": token}
    elif auth == "bearer":
        headers = {"Accept": "application/json", "Authorization": "Bearer " + token}
    else:
        raise ValueError("unknown auth style " + auth)
    if extra_headers:
        headers.update(extra_headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        status = exc.code
        if status in (401, 403):
            raise SourceRefused(host, "%s %s" % (method.upper(), parsed.path), status, "credential rejected")
    try:
        return status, json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return status, raw


def url_with_access_token(url: str, connector_names, allowed_hosts) -> str:
    """Append access_token= for APIs that authenticate on the query string.

    The token is not logged by this function. Callers must not log the URL.
    """
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    if allowed_hosts and host not in allowed_hosts:
        raise NeedsConnection("refusing to send a credential to %s" % host)
    token = access_token_for(connector_names, None)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("access_token", token))
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


class RateLimiter:
    """Simple minimum-interval pacing between API calls."""

    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self):
        dt = time.monotonic() - self._last
        if dt < self.min_interval:
            time.sleep(self.min_interval - dt)
        self._last = time.monotonic()


def db_connect() -> sqlite3.Connection:
    con = sqlite3.connect(str(BRAIN_DB))
    con.execute("PRAGMA journal_mode=WAL")
    return con


def get_sync_state(source: str) -> tuple[str | None, str | None, str | None]:
    con = db_connect()
    try:
        row = con.execute(
            "SELECT watermark, last_run, note FROM sync_state WHERE source=?", (source,)
        ).fetchone()
    finally:
        con.close()
    return row if row else (None, None, None)


def set_sync_state(source: str, watermark: str, note: str) -> None:
    con = db_connect()
    try:
        con.execute(
            "INSERT INTO sync_state(source, watermark, last_run, note) "
            "VALUES(?,?,?,?) "
            "ON CONFLICT(source) DO UPDATE SET watermark=excluded.watermark, "
            "last_run=excluded.last_run, note=excluded.note",
            (source, watermark, now_iso(), note),
        )
        con.commit()
    finally:
        con.close()


def truncate_value(v, limit: int = LONG_TEXT_LIMIT):
    if isinstance(v, str) and len(v) > limit:
        return v[:limit]
    return v


def truncate_props(props: dict, limit: int = LONG_TEXT_LIMIT) -> dict:
    return {k: truncate_value(v, limit) for k, v in props.items()}


_SECRETISH = re.compile(r"(access_token=|api_key=|key=)[^&\s]+", re.I)


def record_outcome(source: str, ok: bool, route: str | None = None, http: int | None = None, detail: str = "") -> None:
    """Last outcome per source, shown on the page. last_ok_at keeps the last good run."""
    text = _SECRETISH.sub(r"\1<redacted>", str(detail or ""))[:400]
    try:
        con = db_connect()
    except Exception:
        return
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS sync_outcomes(
            source TEXT PRIMARY KEY, at TEXT, ok INTEGER, route TEXT, http INTEGER, detail TEXT, last_ok_at TEXT)""")
        at = now_iso()
        con.execute(
            "INSERT INTO sync_outcomes(source, at, ok, route, http, detail, last_ok_at) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(source) DO UPDATE SET at=excluded.at, ok=excluded.ok, route=excluded.route, "
            "http=excluded.http, detail=excluded.detail, "
            "last_ok_at=CASE WHEN excluded.ok=1 THEN excluded.at ELSE sync_outcomes.last_ok_at END",
            (source, at, 1 if ok else 0, route, http, text, at if ok else None),
        )
        con.commit()
    except sqlite3.Error:
        pass
    finally:
        con.close()


def run_main(source: str, fn) -> None:
    """Entrypoint: logging, exit codes, and a recorded outcome. Watermarks move only on success."""
    log = setup_logger(source)
    log.info("starting %s incremental sync", source)
    try:
        summary = fn(log)
    except SourceSkipped as e:
        log.warning("SKIPPED: %s", e)
        record_outcome(source, False, None, None, "skipped: %s" % e)
        sys.exit(EXIT_OK)
    except NeedsConnection as e:
        log.error("NEEDS CONNECTION: %s", e)
        record_outcome(source, False, getattr(e, "route", None), getattr(e, "status", None), str(e))
        sys.exit(EXIT_NEEDS_CONNECTION)
    except Exception as e:
        log.exception("sync failed with an unexpected error; watermarks untouched")
        record_outcome(source, False, getattr(e, "route", None), getattr(e, "status", None),
                       "%s: %s" % (type(e).__name__, str(e)[:200]))
        sys.exit(EXIT_ERROR)
    log.info("sync complete: %s", summary)
    record_outcome(source, True, None, None, str(summary))
    sys.exit(EXIT_OK)


HUBSPOT_SECRET_ID = "opstream-gtm/hubspot-oauth"
HUBSPOT_PORTAL_ID = "21303277"
HUBSPOT_REGION = "us-east-2"
_HUBSPOT_SEARCH = re.compile(r"^/crm/v3/objects/[^/]+/search$")
_HUBSPOT_FIELDS = (
    "portal_id", "client_id", "client_secret", "refresh_token", "token_endpoint", "api_base",
)


class SecretVersionChanged(Exception):
    """AWSCURRENT moved between the read and the write."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def assert_hubspot_read(method, url):
    """Allow GET, and POST only for CRM search. Every other call fails."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "") != "api.hubapi.com":
        raise NeedsConnection("refusing to send a HubSpot credential to this host")
    path = parsed.path or "/"
    if len(path) > 1:
        path = path.rstrip("/")
    verb = (method or "").upper()
    if verb == "GET":
        return
    if verb == "POST" and _HUBSPOT_SEARCH.match(path):
        return
    raise RuntimeError(
        "refusing HubSpot %s %s; only GET and CRM search are allowed" % (verb, path)
    )


def _default_http(method, url, headers, body):
    req = urllib.request.Request(url, data=body, headers=dict(headers or {}), method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, raw


class SecretsManagerHubSpotStore:
    """Read and rotate opstream-gtm/hubspot-oauth. Values are not logged."""

    def __init__(self, secret_id=HUBSPOT_SECRET_ID, region=HUBSPOT_REGION, client=None):
        self.secret_id = secret_id
        self.region = region
        self._client = client

    def _sm(self):
        if self._client is None:
            import boto3
            self._client = boto3.client("secretsmanager", region_name=self.region)
        return self._client

    def get_current(self):
        try:
            resp = self._sm().get_secret_value(SecretId=self.secret_id, VersionStage="AWSCURRENT")
        except Exception as exc:
            raise NeedsConnection(
                "secret %s is not present (%s)" % (self.secret_id, type(exc).__name__)
            )
        raw = resp.get("SecretString") or ""
        if not raw.strip():
            raise NeedsConnection("secret %s is empty" % self.secret_id)
        try:
            doc = json.loads(raw)
        except Exception:
            raise NeedsConnection("secret %s is not JSON" % self.secret_id)
        if not isinstance(doc, dict):
            raise NeedsConnection("secret %s is not a JSON object" % self.secret_id)
        return doc, str(resp.get("VersionId") or "")

    def current_version(self):
        try:
            resp = self._sm().describe_secret(SecretId=self.secret_id)
        except Exception as exc:
            raise NeedsConnection(
                "secret %s could not be described (%s)" % (self.secret_id, type(exc).__name__)
            )
        stages = resp.get("VersionIdsToStages") or {}
        for version_id, labels in stages.items():
            if labels and "AWSCURRENT" in labels:
                return str(version_id)
        raise NeedsConnection("secret %s has no AWSCURRENT version" % self.secret_id)

    def put_current(self, document, expected_version_id):
        version = self.current_version()
        if version != expected_version_id:
            raise SecretVersionChanged()
        token = document.get("refresh_token") if isinstance(document, dict) else None
        if not isinstance(token, str) or not token.strip():
            raise NeedsConnection("refusing to store an empty HubSpot refresh token")
        try:
            self._sm().put_secret_value(
                SecretId=self.secret_id,
                SecretString=json.dumps(document),
            )
        except Exception as exc:
            raise NeedsConnection(
                "HubSpot refresh token rotation could not be saved (%s)" % type(exc).__name__
            )


class HubSpotClient:
    """OAuth refresh for the existing Marketing Dashboard app.

    The access token stays in memory and is refreshed two minutes before
    expires_in. A new refresh token is written back to Secrets Manager
    immediately. CRM calls are GET, plus POST /crm/v3/objects/{type}/search.
    """

    def __init__(self, store=None, http=None, clock=None, log=None, portal_id=HUBSPOT_PORTAL_ID):
        self.store = store or SecretsManagerHubSpotStore()
        self.http = http or _default_http
        self.clock = clock or time.monotonic
        self.log = log
        self.portal_id = str(portal_id)
        self.api_base = "https://api.hubapi.com"
        self._doc = None
        self._access = None
        self._refresh_after = 0.0
        self._portal_checked = False

    def prepare(self):
        self.access_token()

    def access_token(self):
        if self._access and self.clock() < self._refresh_after:
            return self._access
        return self._refresh()

    def _validate_doc(self, doc):
        for key in _HUBSPOT_FIELDS:
            value = doc.get(key)
            if not isinstance(value, str) or not value.strip():
                raise NeedsConnection("HubSpot OAuth secret is missing %s" % key)
        if str(doc["portal_id"]) != self.portal_id:
            raise NeedsConnection(
                "HubSpot secret portal_id is not %s; aborting HubSpot sync" % self.portal_id
            )
        token_url = urllib.parse.urlparse(doc["token_endpoint"])
        api_url = urllib.parse.urlparse(doc["api_base"])
        if token_url.scheme != "https" or token_url.hostname != "api.hubapi.com":
            raise NeedsConnection("HubSpot token endpoint host is not allowed")
        if not (token_url.path or "").startswith("/oauth/"):
            raise NeedsConnection("HubSpot token endpoint path is not allowed")
        if api_url.scheme != "https" or api_url.hostname != "api.hubapi.com":
            raise NeedsConnection("HubSpot API host is not allowed")
        self.api_base = doc["api_base"].rstrip("/")

    def _persist_rotation(self, original_version, new_refresh):
        if not isinstance(new_refresh, str) or not new_refresh.strip():
            return False
        if new_refresh == (self._doc or {}).get("refresh_token"):
            return False
        latest_version = self.store.current_version()
        if latest_version != original_version:
            self._doc, _version = self.store.get_current()
            return False
        updated = dict(self._doc)
        updated["refresh_token"] = new_refresh
        try:
            self.store.put_current(updated, latest_version)
        except SecretVersionChanged:
            self._doc, _version = self.store.get_current()
            return False
        self._doc = updated
        return True

    def _check_portal(self, payload):
        if "hub_id" in payload and str(payload.get("hub_id")) != self.portal_id:
            raise NeedsConnection(
                "HubSpot hub_id is not %s; aborting HubSpot sync" % self.portal_id
            )
        if self._portal_checked:
            return
        url = self.api_base + "/account-info/v3/details"
        assert_hubspot_read("GET", url)
        status, raw = self.http(
            "GET", url,
            {"Authorization": "Bearer " + self._access, "Accept": "application/json"},
            None,
        )
        if status != 200:
            raise NeedsConnection(
                "HubSpot account-info returned HTTP %s; aborting HubSpot sync" % status
            )
        try:
            info = json.loads(raw.decode("utf-8"))
        except Exception:
            raise NeedsConnection("HubSpot account-info was not JSON; aborting HubSpot sync")
        if str(info.get("portalId")) != self.portal_id:
            raise NeedsConnection(
                "HubSpot portalId is not %s; aborting HubSpot sync" % self.portal_id
            )
        self._portal_checked = True

    def _refresh(self):
        doc, version = self.store.get_current()
        self._doc = doc
        self._validate_doc(doc)
        form = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "client_id": doc["client_id"],
            "client_secret": doc["client_secret"],
            "refresh_token": doc["refresh_token"],
        }).encode()
        status, raw = self.http(
            "POST",
            doc["token_endpoint"],
            {"Content-Type": "application/x-www-form-urlencoded"},
            form,
        )
        if status != 200:
            raise NeedsConnection("HubSpot token endpoint returned HTTP %s" % status)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            raise NeedsConnection("HubSpot token endpoint returned a non-JSON body")
        access = payload.get("access_token")
        if not isinstance(access, str) or not access:
            raise NeedsConnection("HubSpot token endpoint did not return an access token")
        try:
            expires_in = int(payload["expires_in"])
        except (KeyError, TypeError, ValueError):
            raise NeedsConnection("HubSpot token endpoint did not return expires_in")
        self._access = access
        self._refresh_after = self.clock() + max(0, expires_in - 120)
        rotated = self._persist_rotation(version, payload.get("refresh_token"))
        if self.log is not None:
            self.log.info(
                "refresh ok, expires_in %s, rotated %s",
                expires_in, "yes" if rotated else "no",
            )
        self._check_portal(payload)
        return access

    def request(self, method, url, body=None):
        assert_hubspot_read(method, url)
        token = self.access_token()
        headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        status, raw = self.http(method.upper(), url, headers, data)
        text = raw.decode("utf-8", errors="replace") if raw else ""
        if status in (401, 403):
            raise NeedsConnection("HubSpot returned %s. Not touching watermarks." % status)
        try:
            parsed = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            parsed = text
        return status, parsed
