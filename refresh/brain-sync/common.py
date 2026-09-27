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
    "custom.hubspot": "hubspot-token",
    "hubspot": "hubspot-token",
    "custom.fathom": "fathom-token",
    "fathom": "fathom-token",
    "custom.otterly": "otterly-token",
    "otterly": "otterly-token",
    "custom.google-analytics": "ga4-credential",
    "google.analytics": "ga4-credential",
    "custom.google": "ga4-credential",
    "custom.lemlist": "lemlist-api-key",
    "lemlist": "lemlist-api-key",
    "google_sheets": "google-sheets-credential",
    "google-sheets": "google-sheets-credential",
    "google-sheets-credential": "google-sheets-credential",
}

HOST_SCOPES = {
    "sheets.googleapis.com": "https://www.googleapis.com/auth/spreadsheets.readonly",
    "analyticsdata.googleapis.com": "https://www.googleapis.com/auth/analytics.readonly",
}

_TOKEN_CACHE = {}


class NeedsConnection(Exception):
    """No usable credential for this source in the current environment."""


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
    if parsed.get("refresh_token") and parsed.get("client_id"):
        return _refresh_token(parsed, scope)
    for key in ("token", "access_token", "api_key", "apiKey", "value"):
        if isinstance(parsed.get(key), str) and parsed[key].strip():
            return parsed[key].strip()
    raise NeedsConnection("secret JSON has no token field")


def access_token_for(connector_names, scope: str | None = None) -> str:
    return materialize_token(get_surrogate(*connector_names), scope)


def authed_request(
    method: str,
    url: str,
    connector_names: list[str],
    allowed_hosts: list[str],
    body: dict | None = None,
    extra_headers: dict | None = None,
    timeout: float = 60.0,
) -> tuple[int, dict | list | str]:
    """Authenticated request. Bearer token, only to an allowed host."""
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
    headers = {"Accept": "application/json", "Authorization": "Bearer " + token}
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
            raise NeedsConnection(
                "%s returned %s: credential rejected. Not touching watermarks." % (host, status)
            )
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


def run_main(source: str, fn) -> None:
    """Standard entrypoint wrapper: logging + exit codes, watermarks only on success."""
    log = setup_logger(source)
    log.info("starting %s incremental sync", source)
    try:
        summary = fn(log)
    except NeedsConnection as e:
        log.error("NEEDS CONNECTION: %s", e)
        sys.exit(EXIT_NEEDS_CONNECTION)
    except Exception:
        log.exception("sync failed with an unexpected error; watermarks untouched")
        sys.exit(EXIT_ERROR)
    log.info("sync complete: %s", summary)
    sys.exit(EXIT_OK)
