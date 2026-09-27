"""Stand-in for brain-sync/common.py.

Sync scripts call get_surrogate(name). This reads Secrets Manager
(opstream-gtm/<name>) or the GTM_SECRET_<NAME> env var the refresh job sets.
It does not read a vault CLI.
"""
import json
import os
import urllib.request


def get_surrogate(name):
    env_key = "GTM_SECRET_" + str(name).upper().replace("-", "_")
    if os.environ.get(env_key):
        return os.environ[env_key]
    secret_id = "opstream-gtm/" + str(name)
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-2"
    try:
        import boto3
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_id)
        raw = resp.get("SecretString") or ""
    except Exception as exc:
        raise RuntimeError("secret %s is not available: %s" % (secret_id, exc))
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and "token" in parsed:
            return parsed["token"]
        if isinstance(parsed, dict) and len(parsed) == 1:
            return next(iter(parsed.values()))
    except Exception:
        pass
    return raw
