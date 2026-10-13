#!/usr/bin/env python3
"""Refresh the GTM dashboard from S3 and publish one run.

Filesystem mode (tests, no AWS):
  REFRESH_MODE=fs REFRESH_FS_ROOT=/tmp/gtm-fs python3 refresh/run.py

Fails non-zero, and publishes nothing, when brain.db is missing or a step
would fall back to synthetic data.

SYNC_ONLY=1 runs the source syncs and the non-AI build steps, carries the
AI narrative forward from the run published/LATEST.json points at, and
publishes only when the content changed. See main_sync_only().
"""
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("REFRESH_CONFIG") or (ROOT / "refresh-config.json"))


def log(msg):
    print("[refresh] " + msg, flush=True)


def load_config():
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


class Store:
    def get_bytes(self, key):
        raise NotImplementedError

    def put_bytes(self, key, data, content_type="application/octet-stream"):
        raise NotImplementedError

    def put_file(self, key, path):
        self.put_bytes(key, Path(path).read_bytes())

    def exists(self, key):
        try:
            self.get_bytes(key)
            return True
        except FileNotFoundError:
            return False

    def list_keys(self, prefix):
        return []

    def delete(self, key):
        pass

    def secret_exists(self, name):
        return False

    def secret_value(self, name):
        raise FileNotFoundError(name)

    def list_secret_names(self, prefix):
        return []

    def get_file(self, key, path):
        """Write the object to path. Returns a version tag for put_file_if_match."""
        data = self.get_bytes(key)
        Path(path).write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    def get_with_tag(self, key):
        data = self.get_bytes(key)
        return data, hashlib.sha256(data).hexdigest()

    def put_file_if_match(self, key, path, tag):
        """Write only if the object still has tag. False when another writer got there first."""
        try:
            _, current = self.get_with_tag(key)
        except FileNotFoundError:
            current = None
        if current != tag:
            return False
        self.put_file(key, path)
        return True

    def put_bytes_if_match(self, key, data, tag, content_type="application/octet-stream"):
        try:
            _, current = self.get_with_tag(key)
        except FileNotFoundError:
            current = None
        if current != tag:
            return False
        self.put_bytes(key, data, content_type)
        return True

    def create_if_absent(self, key, data):
        if self.exists(key):
            return False
        self.put_bytes(key, data, "application/json")
        return True


class FsStore(Store):
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key):
        return self.root / key

    def get_bytes(self, key):
        path = self._path(key)
        if not path.is_file():
            raise FileNotFoundError(key)
        return path.read_bytes()

    def put_bytes(self, key, data, content_type="application/octet-stream"):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def put_file(self, key, path):
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        shutil.copyfile(path, tmp)
        os.replace(tmp, dest)

    def list_keys(self, prefix):
        base = self._path(prefix)
        if not base.exists():
            return []
        out = []
        for p in base.rglob("*"):
            if p.is_file():
                out.append(str(p.relative_to(self.root)).replace(os.sep, "/"))
        return out

    def delete(self, key):
        path = self._path(key)
        if path.is_file():
            path.unlink()

    def secret_exists(self, name):
        return (self.root / "secrets" / name).is_file()

    def secret_value(self, name):
        path = self.root / "secrets" / name
        if not path.is_file():
            raise FileNotFoundError(name)
        return path.read_text(encoding="utf-8")

    def list_secret_names(self, prefix):
        base = self.root / "secrets"
        if not base.exists():
            return []
        names = []
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(base).as_posix()
            if rel.startswith(prefix):
                names.append(rel)
        return names


class S3Store(Store):
    def __init__(self, bucket, region):
        import boto3
        self.bucket = bucket
        self.s3 = boto3.client("s3", region_name=region)
        self.sm = boto3.client("secretsmanager", region_name=region)
        self.prefix = "opstream-gtm/"

    def get_bytes(self, key):
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
        except self.s3.exceptions.NoSuchKey:
            raise FileNotFoundError(key)
        return obj["Body"].read()

    def put_bytes(self, key, data, content_type="application/octet-stream"):
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def put_file(self, key, path):
        self.s3.upload_file(str(path), self.bucket, key)

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False

    def list_keys(self, prefix):
        keys, token = [], None
        while True:
            kwargs = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            page = self.s3.list_objects_v2(**kwargs)
            for item in page.get("Contents") or []:
                keys.append(item["Key"])
            if not page.get("IsTruncated"):
                break
            token = page.get("NextContinuationToken")
        return keys

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    # S3 conditional writes (If-Match / If-None-Match) make these atomic.
    def get_file(self, key, path):
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
        except self.s3.exceptions.NoSuchKey:
            raise FileNotFoundError(key)
        with open(path, "wb") as fh:
            shutil.copyfileobj(obj["Body"], fh, 8 * 1024 * 1024)
        return obj["ETag"]

    def get_with_tag(self, key):
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
        except self.s3.exceptions.NoSuchKey:
            raise FileNotFoundError(key)
        return obj["Body"].read(), obj["ETag"]

    @staticmethod
    def _precondition_failed(exc):
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        return code in ("PreconditionFailed", "ConditionalRequestConflict", "412", "409")

    def put_file_if_match(self, key, path, tag):
        try:
            with open(path, "rb") as fh:
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=fh, IfMatch=tag)
            return True
        except Exception as exc:
            if self._precondition_failed(exc):
                return False
            raise

    def put_bytes_if_match(self, key, data, tag, content_type="application/octet-stream"):
        try:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, IfMatch=tag)
            return True
        except Exception as exc:
            if self._precondition_failed(exc):
                return False
            raise

    def create_if_absent(self, key, data):
        try:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=data,
                               ContentType="application/json", IfNoneMatch="*")
            return True
        except Exception as exc:
            if self._precondition_failed(exc):
                return False
            raise

    def secret_exists(self, name):
        try:
            self.sm.describe_secret(SecretId=self.prefix + name)
            return True
        except Exception:
            return False

    def secret_value(self, name):
        resp = self.sm.get_secret_value(SecretId=self.prefix + name)
        return resp.get("SecretString") or ""

    def list_secret_names(self, prefix):
        full = self.prefix + prefix
        names = []
        token = None
        while True:
            kwargs = {"Filters": [{"Key": "name", "Values": [full]}]}
            if token:
                kwargs["NextToken"] = token
            page = self.sm.list_secrets(**kwargs)
            for item in page.get("SecretList") or []:
                secret_name = str(item.get("Name") or "")
                if secret_name.startswith(self.prefix) and secret_name[len(self.prefix):].startswith(prefix):
                    names.append(secret_name[len(self.prefix):])
            token = page.get("NextToken")
            if not token:
                break
        return names


# Canonical scripts live in refresh/brain-sync. Sheets and GA4 share the
# owner's refresh token. The OAuth client id and secret are injected beside
# it and are not a substitute for that token.
SYNC_SCRIPTS = [
    ("sheets_sync.py", "google-sheets-refresh-token"),
    ("hubspot_sync.py", "hubspot-oauth"),
    ("fathom_sync.py", "fathom-token"),
    ("ga4_sync.py", "google-sheets-refresh-token"),
    ("lemlist_sync.py", "lemlist-token"),
    ("otterly_sync.py", "otterly-token"),
]
GOOGLE_CLIENT_SECRETS = ("google-oauth-client-id", "google-oauth-client-secret")
VENDORED_SYNC = ROOT / "refresh" / "brain-sync"


def record_outcome(db_path, source, detail, since=None):
    """A sync that never ran, or exited without recording why. Keeps last_ok_at."""
    con = sqlite3.connect(str(db_path))
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS sync_outcomes(
            source TEXT PRIMARY KEY, at TEXT, ok INTEGER, route TEXT, http INTEGER, detail TEXT, last_ok_at TEXT)""")
        row = con.execute("SELECT at FROM sync_outcomes WHERE source=?", (source,)).fetchone()
        if since and row and row[0] and row[0] >= since:
            return
        con.execute(
            "INSERT INTO sync_outcomes(source, at, ok, route, http, detail, last_ok_at) VALUES(?,?,0,NULL,NULL,?,NULL) "
            "ON CONFLICT(source) DO UPDATE SET at=excluded.at, ok=0, route=NULL, http=NULL, detail=excluded.detail",
            (source, datetime.now(timezone.utc).isoformat(), detail),
        )
        con.commit()
    finally:
        con.close()


def run_syncs(store, db_path, sync_dir, scripts):
    """Run each source sync against db_path. Returns (ran, failed, skipped)."""
    ran = []
    failed = []
    skipped = []
    for script, secret in scripts:
        path = Path(sync_dir) / script
        secret_id = "opstream-gtm/" + secret
        source = script.replace("_sync.py", "")
        if not path.is_file():
            log("WARNING: skipping %s because the vendored script is missing" % script)
            skipped.append("%s (script missing)" % script)
            record_outcome(db_path, source, "the refresh image has no %s" % script)
            continue
        if not store.secret_exists(secret):
            log("WARNING: skipping %s because secret %s is not present" % (script, secret_id))
            skipped.append("%s (%s missing)" % (script, secret_id))
            record_outcome(db_path, source, "secret %s is not in Secrets Manager" % secret_id)
            continue
        env = os.environ.copy()
        env["BRAIN_DB"] = str(db_path)
        # HubSpot reads opstream-gtm/hubspot-oauth itself so a rotated refresh
        # token can be written back with the AWSCURRENT version id. The value
        # is not copied into the environment.
        if secret != "hubspot-oauth":
            env["GTM_SECRET_" + secret.upper().replace("-", "_")] = store.secret_value(secret)
        if script in ("sheets_sync.py", "ga4_sync.py"):
            for extra in GOOGLE_CLIENT_SECRETS:
                if store.secret_exists(extra):
                    env["GTM_SECRET_" + extra.upper().replace("-", "_")] = store.secret_value(extra)
        started = datetime.now(timezone.utc).isoformat()
        try:
            run_step([sys.executable, str(path)], env, ROOT)
            ran.append(script)
        except SystemExit as exc:
            if exc.code == 3:
                log("WARNING: skipping %s because it needs a connection (exit 3). Watermarks untouched." % script)
                skipped.append("%s (needs connection)" % script)
            else:
                # One source failing keeps its last good data; the rest of the refresh continues.
                log("WARNING: %s failed (exit %s). Its last good data stays; the refresh continues." % (script, exc.code))
                failed.append(script)
            record_outcome(db_path, source, "exited %s without recording a reason" % exc.code, since=started)
    log("sync summary: ran " + (", ".join(ran) if ran else "none"))
    log("sync summary: failed " + (", ".join(failed) if failed else "none"))
    log("sync summary: skipped " + ("; ".join(skipped) if skipped else "none"))
    return ran, failed, skipped


def run_step(cmd, env, cwd):
    log("run " + " ".join(cmd))
    proc = subprocess.run(cmd, env=env, cwd=str(cwd))
    if proc.returncode != 0:
        raise SystemExit(proc.returncode)


def install_vendored_sync(dest):
    """Copy the repo scripts into the work dir so logs stay out of the repo.

    An S3 copy of code/brain-sync is not used. Those files still call the
    vault CLI. The vendored copies are the ones this job runs.
    """
    dest = Path(dest)
    if dest.exists():
        shutil.rmtree(dest)
    if not VENDORED_SYNC.is_dir():
        dest.mkdir(parents=True, exist_ok=True)
        return dest
    shutil.copytree(
        VENDORED_SYNC, dest,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "logs"),
    )
    return dest


def publish_tree(store, src, prefix):
    names = []
    for path in Path(src).rglob("*"):
        if not path.is_file():
            continue
        if path.suffix == ".pyc" or "__pycache__" in path.parts:
            continue
        rel = path.relative_to(src).as_posix()
        store.put_file(prefix + rel, path)
        names.append(rel)
    store.put_bytes(prefix + "MANIFEST.txt", ("\n".join(names) + "\n").encode("utf-8"), "text/plain")
    return names


def prune_runs(store, published_prefix, keep=10, protect=()):
    keys = store.list_keys(published_prefix.rstrip("/") + "/")
    runs = {}
    for key in keys:
        parts = key.split("/")
        # published/<run-id>/...
        if len(parts) < 3 or parts[0] != published_prefix.strip("/"):
            continue
        run = parts[1]
        if run == "LATEST.json":
            continue
        runs.setdefault(run, []).append(key)
    ordered = sorted(runs)
    for old in ordered[:-keep]:
        if old in protect:
            log("prune kept " + old + " (protected)")
            continue
        log("prune " + old)
        for key in runs[old]:
            store.delete(key)


def finish_build(env):
    """term_scrub and the renderer: the build steps after the narrative."""
    py = sys.executable
    node = os.environ.get("NODE_BIN") or "node"
    run_step([py, str(ROOT / "scripts" / "term_scrub.py"), env["OUT_DATA"]], env, ROOT)
    renderer = ROOT / "evidence-renderer.mjs"
    if renderer.is_file():
        run_step([node, "-e",
                  "const esbuild=require('esbuild');"
                  "esbuild.buildSync({entryPoints:['evidence-renderer.mjs'],bundle:true,format:'iife',"
                  "globalName:'OpstreamEvidence',platform:'browser',target:'es2022',"
                  "outfile:process.env.OUT_DATA.replace(/\\/data$/,'')+'/assets/evidence-renderer.js',minify:true});"],
                 env, ROOT)
    else:
        log("WARNING: evidence-renderer.mjs is not in the image. Skipping the renderer.")


def assert_real(out_dir):
    verified = json.loads((out_dir / "verified.json").read_text(encoding="utf-8"))
    records = json.loads((out_dir / "records.json").read_text(encoding="utf-8"))
    snap = str(verified.get("snapshotId") or "")
    if "synthetic" in snap.lower() or snap.startswith("demo"):
        raise SystemExit("refusing to publish synthetic snapshot " + snap)
    if verified.get("snapshotId") != records.get("verifiedSnapshotId"):
        raise SystemExit("snapshot ids disagree")
    if not records.get("generatedAt"):
        raise SystemExit("records.json has no generatedAt")
    return snap


def main():
    cfg = load_config()
    mode = os.environ.get("REFRESH_MODE") or "s3"
    bucket = cfg["dataBucket"]
    region = cfg.get("region") or "us-east-2"
    published = cfg.get("publishedPrefix") or "published"
    state_prefix = (cfg.get("statePrefix") or "state").strip("/") + "/"
    brain_key = cfg.get("brainKey") or "data/brain/brain.db"
    if mode == "fs":
        store = FsStore(os.environ["REFRESH_FS_ROOT"])
    else:
        store = S3Store(bucket, region)
    if os.environ.get("SYNC_ONLY") == "1":
        return main_sync_only(cfg, store)

    work = Path(os.environ.get("REFRESH_WORK") or "/tmp/gtm-refresh")
    if work.exists():
        shutil.rmtree(work)
    out = work / "out" / "data"
    out.mkdir(parents=True)
    db_path = work / "brain.db"
    try:
        db_bytes = store.get_bytes(brain_key)
    except FileNotFoundError:
        log("brain.db is missing at " + brain_key + ". Publishing nothing.")
        return 1
    if len(db_bytes) < 64:
        log("brain.db is empty. Publishing nothing.")
        return 1
    db_path.write_bytes(db_bytes)
    del db_bytes

    for name in ("hollie-feedback.json", "crm-proposals.json"):
        try:
            (out / name).write_bytes(store.get_bytes(state_prefix + name))
            log("restored state " + name)
        except FileNotFoundError:
            pass
    try:
        state_dir = work / "var"
        state_dir.mkdir(parents=True)
        (state_dir / "hollie-operator-state.json").write_bytes(
            store.get_bytes(state_prefix + "hollie-operator-state.json"))
    except FileNotFoundError:
        pass

    sync_dir = install_vendored_sync(os.environ.get("REFRESH_SYNC_DIR") or (work / "brain-sync"))
    ran, failed, skipped = run_syncs(store, db_path, sync_dir, SYNC_SCRIPTS)
    if ran or failed:
        store.put_file(brain_key, db_path)
        log("uploaded brain.db")
    else:
        log("no sync ran, brain.db left unchanged")

    env = os.environ.copy()
    env["BRAIN_DB"] = str(db_path)
    env["OUT_DATA"] = str(out)
    env["HOLLIE_STATE_DIR"] = str(work / "var")
    env["HOME"] = str(work)
    if store.secret_exists("openai-api-key"):
        env["OPENAI_API_KEY"] = store.secret_value("openai-api-key")
    else:
        log("WARNING: secret opstream-gtm/openai-api-key is missing. Narrative stays on computed facts.")
        env["GTM_FACTS_ONLY"] = "1"
    py = sys.executable
    try:
        run_step([py, str(ROOT / "scripts" / "brain-data.py")], env, ROOT)
        run_step([py, str(ROOT / "scripts" / "sheet-review.py")], env, ROOT)
        run_step([py, str(ROOT / "scripts" / "align-run.py")], env, ROOT)
        if env.get("OPENAI_API_KEY"):
            run_step([py, str(ROOT / "scripts" / "agent-brief.py")], env, ROOT)
            run_step([py, str(ROOT / "scripts" / "heartbeat.py")], env, ROOT)
        finish_build(env)
    except SystemExit as exc:
        log("step failed. Publishing nothing.")
        return int(exc.code or 1)
    state_file = work / "var" / "hollie-operator-state.json"
    if state_file.is_file():
        store.put_file(state_prefix + "hollie-operator-state.json", state_file)
    feedback = out / "hollie-feedback.json"
    if feedback.is_file():
        store.put_file(state_prefix + "hollie-feedback.json", feedback)
    proposals = out / "crm-proposals.json"
    if proposals.is_file():
        store.put_file(state_prefix + "crm-proposals.json", proposals)
    try:
        from user_briefs import refresh_user_briefs
        oauth_id = store.secret_value("google-oauth-client-id") if store.secret_exists("google-oauth-client-id") else ""
        oauth_secret = store.secret_value("google-oauth-client-secret") if store.secret_exists("google-oauth-client-secret") else ""
        refresh_user_briefs(store, state_prefix, out, log, oauth_id, oauth_secret)
    except Exception as exc:
        log("user briefs failed (" + type(exc).__name__ + ")")
    snap = assert_real(out)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + snap
    prefix = published.strip("/") + "/" + run_id + "/"
    publish_tree(store, out, prefix)
    pointer = json.dumps({"runId": run_id, "prefix": prefix, "snapshotId": snap,
                          "publishedAt": datetime.now(timezone.utc).isoformat()}).encode()
    store.put_bytes(published.strip("/") + "/LATEST.json", pointer, "application/json")
    prune_runs(store, published, keep=10)
    log("published " + run_id)
    return 0


# ---------------------------------------------------------------- sync-only
# The files agent-brief.py and heartbeat.py write. align-run.py writes
# facts-only stand-ins for the same three names first.
AI_OUTPUTS = ("agent-brief.json", "heartbeat.json", "heartbeat-fixes.json")
SYNC_ONLY_SOURCES = ("sheets", "hubspot", "fathom", "ga4", "lemlist")
# Fields that change on every build or sync of the same data: build stamps,
# run ids, fetch times, and the per-source "last checked" times in marketing.json.
VOLATILE_KEYS = frozenset(("generatedAt", "runId", "collectedAt", "publishedAt", "carriedFrom",
                           "at", "lastOkAt", "fetchedAt", "channelsFetchedAt", "capturedAt"))
LOCK_KEY = "locks/sync-only.json"
PHOENIX = timezone(timedelta(hours=-7))  # America/Phoenix has no DST.
EXIT_SYNC_FAILED = 4


def _strip_volatile(value):
    if isinstance(value, dict):
        # A successful sync outcome's detail is a per-run counter ("14 objects
        # upserted"). A failure's detail is kept: it is news.
        drop = VOLATILE_KEYS | ({"detail"} if value.get("ok") is True and "source" in value else set())
        return {k: _strip_volatile(v) for k, v in value.items() if k not in drop}
    if isinstance(value, list):
        return [_strip_volatile(v) for v in value]
    return value


def content_hash(files):
    """sha256 over {relpath: bytes}, ignoring build timestamps and run ids.

    Facts-only stand-ins for the AI files are left out: align-run derives them
    from the other files plus the clock, so they never signal a data change.
    """
    h = hashlib.sha256()
    for rel in sorted(files):
        if rel == "MANIFEST.txt":
            continue
        data = files[rel]
        if rel.endswith(".json"):
            try:
                doc = json.loads(data.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                doc = None
            if doc is not None:
                if rel in AI_OUTPUTS and isinstance(doc, dict) and doc.get("model") == "facts":
                    continue
                data = json.dumps(_strip_volatile(doc), sort_keys=True, separators=(",", ":")).encode("utf-8")
        h.update(rel.encode("utf-8") + b"\0" + hashlib.sha256(data).digest())
    return h.hexdigest()


def tree_files(root):
    root = Path(root)
    return {p.relative_to(root).as_posix(): p.read_bytes()
            for p in root.rglob("*") if p.is_file() and p.suffix != ".pyc" and "__pycache__" not in p.parts}


def published_files(store, prefix):
    return {key[len(prefix):]: store.get_bytes(key) for key in store.list_keys(prefix)}


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def in_skip_window(now=None):
    """SYNC_SKIP_WINDOWS="0,6,12,18:10-29" (Phoenix hours:minute range). Empty disables."""
    spec = os.environ.get("SYNC_SKIP_WINDOWS", "0,6,12,18:10-29").strip()
    now = (now or datetime.now(timezone.utc)).astimezone(PHOENIX)
    for part in filter(None, (x.strip() for x in spec.split(";"))):
        hours, _, minutes = part.partition(":")
        lo, _, hi = minutes.partition("-")
        if now.hour in {int(x) for x in hours.split(",")} and int(lo) <= now.minute <= int(hi or lo):
            return part
    return None


def acquire_lock(store, ttl_min):
    body = json.dumps({"startedAt": datetime.now(timezone.utc).isoformat(),
                       "task": os.environ.get("ECS_CONTAINER_METADATA_URI_V4", "").rsplit("/", 1)[-1]}).encode()
    for _ in range(2):
        if store.create_if_absent(LOCK_KEY, body):
            return True
        try:
            held = json.loads(store.get_bytes(LOCK_KEY).decode("utf-8"))
            since = datetime.fromisoformat(held["startedAt"])
            age = (datetime.now(timezone.utc) - since).total_seconds() / 60.0
        except FileNotFoundError:
            continue
        except Exception:
            age = ttl_min + 1
        if age < ttl_min:
            log("another sync-only run holds the lock (%.0f min old, ttl %d). Exiting." % (age, ttl_min))
            return False
        log("lock is %.0f min old, past ttl %d. Taking it over." % (age, ttl_min))
        store.delete(LOCK_KEY)
    return False


def carry_forward_ai(store, latest, out):
    """Copy the AI narrative from the published run into out, stamped with this build's run id.

    data-bindings.js hides the brief, heartbeat, and fixes when their runId differs
    from hollie.json, so the copies take the new runId. generatedAt and model stay
    as the AI run wrote them; carriedFrom names the run the text came from.
    Facts-only copies are not carried: align-run just wrote current ones.
    """
    hollie = json.loads((out / "hollie.json").read_text(encoding="utf-8"))
    run_id = hollie.get("runId")
    carried = []
    for name in AI_OUTPUTS:
        try:
            doc = json.loads(store.get_bytes(latest["prefix"] + name).decode("utf-8"))
        except FileNotFoundError:
            continue
        if not isinstance(doc, dict) or doc.get("model") == "facts":
            continue
        doc.setdefault("carriedFrom", latest["runId"])
        if run_id:
            doc["runId"] = run_id
        (out / name).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        carried.append(name)
    return carried, run_id


def main_sync_only(cfg, store):
    """Sources plus non-AI build. Publishes only when the content hash changes.

    Never reads the OpenAI secret, never runs agent-brief.py or heartbeat.py,
    never builds user briefs, and writes nothing under state/.
    """
    published = (cfg.get("publishedPrefix") or "published").strip("/")
    state_prefix = (cfg.get("statePrefix") or "state").strip("/") + "/"
    brain_key = cfg.get("brainKey") or "data/brain/brain.db"
    window = in_skip_window()
    if window:
        log("sync-only: inside skip window %s (6-hourly refresh). Exiting." % window)
        return 0
    if not acquire_lock(store, int(os.environ.get("SYNC_LOCK_TTL_MIN") or 50)):
        return 0
    try:
        return _sync_only(store, published, state_prefix, brain_key)
    finally:
        store.delete(LOCK_KEY)


def _sync_only(store, published, state_prefix, brain_key):
    t0 = datetime.now(timezone.utc)
    work = Path(os.environ.get("REFRESH_WORK") or "/tmp/gtm-refresh")
    if work.exists():
        shutil.rmtree(work)
    out = work / "out" / "data"
    out.mkdir(parents=True)
    (work / "var").mkdir(parents=True)
    latest_key = published + "/LATEST.json"
    try:
        latest_raw, latest_tag = store.get_with_tag(latest_key)
        latest = json.loads(latest_raw.decode("utf-8"))
    except FileNotFoundError:
        log("sync-only: %s is missing; nothing to carry the narrative from. Publishing nothing." % latest_key)
        return 1
    log("sync-only: LATEST is %s (mode %s)" % (latest.get("runId"), latest.get("mode") or "full"))

    db_path = work / "brain.db"
    try:
        db_tag = store.get_file(brain_key, db_path)
    except FileNotFoundError:
        log("brain.db is missing at " + brain_key + ". Publishing nothing.")
        return 1
    if db_path.stat().st_size < 64:
        log("brain.db is empty. Publishing nothing.")
        return 1
    db_before = file_sha256(db_path)

    # Inputs the build reads. Restored read-only; sync-only never writes state/.
    for name in ("hollie-feedback.json", "crm-proposals.json"):
        try:
            (out / name).write_bytes(store.get_bytes(state_prefix + name))
        except FileNotFoundError:
            pass
    try:
        (work / "var" / "hollie-operator-state.json").write_bytes(
            store.get_bytes(state_prefix + "hollie-operator-state.json"))
    except FileNotFoundError:
        pass

    wanted = [x.strip() for x in os.environ.get("SYNC_ONLY_SOURCES", ",".join(SYNC_ONLY_SOURCES)).split(",") if x.strip()]
    scripts = [(script, secret) for script, secret in SYNC_SCRIPTS if script.replace("_sync.py", "") in wanted]
    log("sync-only: sources " + ", ".join(s for s, _ in scripts) + " (otterly is left to the 6-hourly run)"
        if "otterly" not in wanted else "sync-only: sources " + ", ".join(s for s, _ in scripts))
    sync_dir = install_vendored_sync(os.environ.get("REFRESH_SYNC_DIR") or (work / "brain-sync"))
    ran, failed, skipped = run_syncs(store, db_path, sync_dir, scripts)
    t_sync = datetime.now(timezone.utc)

    if file_sha256(db_path) == db_before:
        log("brain.db unchanged (sha256), not uploaded")
    elif store.put_file_if_match(brain_key, db_path, db_tag):
        log("uploaded brain.db")
    else:
        log("brain.db changed in S3 during this run (another writer). Not uploading, not publishing; "
            "the next run picks up from the newer copy.")
        return 0

    env = {k: v for k, v in os.environ.items() if k != "OPENAI_API_KEY"}
    env["BRAIN_DB"] = str(db_path)
    env["OUT_DATA"] = str(out)
    env["HOLLIE_STATE_DIR"] = str(work / "var")
    env["HOME"] = str(work)
    env["GTM_FACTS_ONLY"] = "1"
    py = sys.executable
    try:
        run_step([py, str(ROOT / "scripts" / "brain-data.py")], env, ROOT)
        run_step([py, str(ROOT / "scripts" / "sheet-review.py")], env, ROOT)
        run_step([py, str(ROOT / "scripts" / "align-run.py")], env, ROOT)
        carried, run_id = carry_forward_ai(store, latest, out)
        log("carried forward from %s: %s (stamped %s)" % (
            latest.get("runId"), ", ".join(carried) or "none (facts-only copies kept)", run_id))
        finish_build(env)
    except SystemExit as exc:
        log("step failed. Publishing nothing.")
        return int(exc.code or 1)
    snap = assert_real(out)

    new_hash = content_hash(tree_files(out))
    old_hash = latest.get("contentHash") or content_hash(published_files(store, latest["prefix"]))
    t_build = datetime.now(timezone.utc)
    timing = "sync %.0fs, build %.0fs" % ((t_sync - t0).total_seconds(), (t_build - t_sync).total_seconds())
    code = EXIT_SYNC_FAILED if failed else 0
    if new_hash == old_hash:
        log("no change (content %s matches %s). Published nothing. %s" % (new_hash[:12], latest.get("runId"), timing))
        return code

    _, tag_now = store.get_with_tag(latest_key)
    if tag_now != latest_tag:
        log("LATEST.json moved during this run (another publisher). Not publishing.")
        return code
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + snap
    prefix = published + "/" + run_id + "/"
    publish_tree(store, out, prefix)
    pointer = json.dumps({"runId": run_id, "prefix": prefix, "snapshotId": snap,
                          "publishedAt": datetime.now(timezone.utc).isoformat(),
                          "mode": "sync-only", "contentHash": new_hash,
                          "aiFrom": latest.get("aiFrom") or latest.get("runId")}).encode()
    if not store.put_bytes_if_match(latest_key, pointer, latest_tag, "application/json"):
        log("LATEST.json moved while publishing %s. Left it pointing at the other run." % run_id)
        return code
    # The carried files are already copied into this run, so the source run
    # may age out. Still keep it while it is inside the window.
    prune_runs(store, published, keep=int(os.environ.get("SYNC_KEEP_RUNS") or 10),
               protect={run_id, latest.get("runId")})
    log("published %s (content %s, was %s). %s" % (run_id, new_hash[:12], old_hash[:12], timing))
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as exc:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
