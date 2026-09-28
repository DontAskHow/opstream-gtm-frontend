#!/usr/bin/env python3
"""Refresh the GTM dashboard from S3 and publish one run.

Filesystem mode (tests, no AWS):
  REFRESH_MODE=fs REFRESH_FS_ROOT=/tmp/gtm-fs python3 refresh/run.py

Fails non-zero, and publishes nothing, when brain.db is missing or a step
would fall back to synthetic data.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import traceback
from datetime import datetime, timezone
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


def prune_runs(store, published_prefix, keep=10):
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
        log("prune " + old)
        for key in runs[old]:
            store.delete(key)


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
    ran = []
    failed = []
    skipped = []
    for script, secret in SYNC_SCRIPTS:
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
    node = os.environ.get("NODE_BIN") or "node"
    try:
        run_step([py, str(ROOT / "scripts" / "brain-data.py")], env, ROOT)
        run_step([py, str(ROOT / "scripts" / "sheet-review.py")], env, ROOT)
        run_step([py, str(ROOT / "scripts" / "align-run.py")], env, ROOT)
        if env.get("OPENAI_API_KEY"):
            run_step([py, str(ROOT / "scripts" / "agent-brief.py")], env, ROOT)
            run_step([py, str(ROOT / "scripts" / "heartbeat.py")], env, ROOT)
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


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as exc:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
