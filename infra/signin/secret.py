#!/usr/bin/env python3
"""Secrets Manager helper for the GTM preview sign-in. Never prints secret values.

  <value on stdin> | secret.py create --region R --name N --description D
      Creates the secret from stdin if it does not exist yet; an existing secret is left alone.
      (aws-cli v1 cannot read a pipe as a file:// parameter, so values go through boto3 instead
      of argv or a temp file.)
  secret.py basic-hash-config [CREDENTIALS_FILE]
      Writes to stdout the edge config JSON {"basic_auth_required": true, "basic_auth_sha256": ...}
      from a user=/password= file. Only meant to be piped into `create`.
  secret.py set-flag --region R --name N --key basic_auth_required --value true|false
      Reads the JSON secret, sets one boolean, writes a new version. Prints only the key and new value.
"""
import argparse, hashlib, json, os, sys

import boto3


def client(region):
    return boto3.Session(profile_name=os.environ.get("AWS_PROFILE", "opstream-deploy")).client("secretsmanager", region_name=region)


def cmd_create(a):
    sm = client(a.region)
    try:
        arn = sm.describe_secret(SecretId=a.name)["ARN"]
        print(f"exists   {arn}")
        return
    except sm.exceptions.ResourceNotFoundException:
        pass
    value = sys.stdin.read().strip()
    if len(value) < a.min_length:
        sys.exit(f"refusing to create {a.name}: stdin value shorter than {a.min_length} characters")
    arn = sm.create_secret(Name=a.name, Description=a.description, SecretString=value,
                           Tags=[{"Key": "project", "Value": "gtm-preview"}])["ARN"]
    print(f"created  {arn}")


def cmd_basic_hash_config(a):
    kv = {}
    with open(a.file) as f:
        for line in f:
            if "=" in line:
                k, v = line.rstrip("\r\n").split("=", 1)
                kv[k.strip()] = v
    if not kv.get("user") or not kv.get("password"):
        sys.exit("credentials file needs user= and password= lines")
    digest = hashlib.sha256(f"{kv['user']}:{kv['password']}".encode()).hexdigest()
    sys.stdout.write(json.dumps({"basic_auth_required": True, "basic_auth_sha256": digest}))


def cmd_set_flag(a):
    sm = client(a.region)
    cfg = json.loads(sm.get_secret_value(SecretId=a.name)["SecretString"])
    value = {"true": True, "false": False}[a.value]
    cfg[a.key] = value
    sm.put_secret_value(SecretId=a.name, SecretString=json.dumps(cfg))
    print(f"{a.name}: {a.key} = {json.dumps(value)} (edge functions pick this up within ~5 minutes)")


p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
c = sub.add_parser("create"); c.add_argument("--region", required=True); c.add_argument("--name", required=True)
c.add_argument("--description", default=""); c.add_argument("--min-length", type=int, default=32); c.set_defaults(fn=cmd_create)
h = sub.add_parser("basic-hash-config"); h.add_argument("file", nargs="?", default="/workspace/gtm-preview-credentials.txt"); h.set_defaults(fn=cmd_basic_hash_config)
s = sub.add_parser("set-flag"); s.add_argument("--region", required=True); s.add_argument("--name", required=True)
s.add_argument("--key", required=True, choices=["basic_auth_required"]); s.add_argument("--value", required=True, choices=["true", "false"]); s.set_defaults(fn=cmd_set_flag)
args = p.parse_args()
args.fn(args)
