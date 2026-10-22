"""Build each signed-in user's private brief. Tokens stay in Secrets Manager."""
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def refresh_user_briefs(store, state_prefix, out_dir, log, client_id="", client_secret=""):
    try:
        names = [name for name in store.list_secret_names("users/") if name.endswith("/google")]
    except Exception as exc:
        log("user briefs: list failed (" + type(exc).__name__ + ")")
        return
    if not names:
        log("user briefs: none")
        return
    records = Path(out_dir) / "records.json"
    sheet = Path(out_dir) / "sheet-review.json"
    script = ROOT / "scripts" / "build-user-brief.mjs"
    prefix = state_prefix.strip("/") + "/"
    for name in names:
        digest = name.split("/")[1] if name.count("/") >= 2 else "user"
        try:
            raw = store.secret_value(name)
        except Exception as exc:
            log("user brief " + digest + " unreadable (" + type(exc).__name__ + ")")
            continue
        env = {
            "GTM_RECORDS": str(records),
            "GTM_SHEET": str(sheet),
            "GTM_GOOGLE_CLIENT_ID": client_id,
            "GTM_GOOGLE_CLIENT_SECRET": client_secret,
            "PATH": os.environ.get("PATH", ""),
        }
        proc = subprocess.run(
            [os.environ.get("NODE_BIN") or "node", str(script)],
            input=raw.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(ROOT),
        )
        if proc.returncode != 0:
            log("user brief " + digest + " failed (" + str(proc.returncode) + ")")
            continue
        try:
            brief = json.loads(proc.stdout.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            log("user brief " + digest + " failed (json)")
            continue
        if not isinstance(brief, dict):
            log("user brief " + digest + " failed (shape)")
            continue
        brief.pop("refresh_token", None)
        store.put_bytes(
            prefix + "users/" + digest + "/brief.json",
            json.dumps(brief).encode("utf-8"),
            "application/json",
        )
        log("user brief " + digest + " stored")
