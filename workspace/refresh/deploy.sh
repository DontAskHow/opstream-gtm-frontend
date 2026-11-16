#!/usr/bin/env bash
# Deploys the GTM preview refresh: IAM roles, log group, Lambda, error alarm,
# EventBridge Scheduler schedule, and the page's static files. Idempotent: re-run
# to update. Does NOT touch prod (opstream-gtm-dashboard / opstream-gtm-prod, the
# opstream-gtm-refresh task or schedule) and never writes to the data bucket.
#
#   workspace/refresh/deploy.sh            # deploy/update; keeps the schedule's current state
#   workspace/refresh/deploy.sh --enable   # also (re)enable the schedule
#   workspace/refresh/deploy.sh --disabled # create or leave the schedule DISABLED
#   workspace/refresh/deploy.sh --no-app   # skip uploading index.html/app.js/styles.css/vendor
#   workspace/refresh/deploy.sh --onepage-app
#                                          # serve the one-page workspace with live data: build the data-less
#                                          # onepage index.html (it fetches /workspace.json), update the function
#                                          # (it copies each snapshot's workspace.json to the preview bucket), run
#                                          # it once, and upload index.html only once workspace.json is there.
#   workspace/refresh/deploy.sh --onepage DIR
#                                          # static fallback: upload DIR/index.html (a page built with its data
#                                          # inside by onepage/build.mjs --data); its data is fixed at build time.
#   workspace/refresh/deploy.sh --restore-app
#                                          # put the workspace app's index.html back even when the live page is
#                                          # another page (without it, a plain deploy leaves any index.html that
#                                          # carries a gtm-page tag, e.g. onepage-app or fresh-workspace).
#   workspace/refresh/deploy.sh --lambda-only
#                                          # update only the function's code and environment: no IAM, log group,
#                                          # schedule, alarm or concurrency change, and no file in the preview bucket
#                                          # (index.html, app.js, ...) is touched. The function must already exist.
#
# The function's environment: LIVE_PULL=0, the scrub patterns (below), and the optional minute settings
# WORKSPACE_MAX_AGE_MIN, WORKSPACE_STALE_MIN, FRESH_STALE_MIN (workspace-json.mjs): set in the deploy
# shell to change them, else the current function's values are kept (unset: the code's defaults).
#
# Scrub patterns (people who must never appear) are never in the repo. Pass them as
# WORKSPACE_SCRUB_PATTERNS (comma list) or WORKSPACE_SCRUB_PATTERNS_FILE; they go into the
# function's environment. Without them the function keeps its current value; --onepage-app
# requires them and refuses before any AWS call.
#
# Never uploads insights.json or lost-reasons.json: the Strategy seat publishes
# those with refresh/publish-insights.mjs and refresh/publish-lost-reasons.mjs.
#
# Off switch: workspace/refresh/gtm-preview-refresh-off.sh
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-opstream-deploy}"
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2
export AWS_PAGER=""

ENABLE=0; DISABLE=0; APP=1; ONEPAGE=""; ONEPAGE_APP=0; RESTORE_APP=0; LAMBDA_ONLY=0
TMP=""; ONEPAGE_APP_DIR=""
trap 'rm -rf "$TMP" "$ONEPAGE_APP_DIR"' EXIT
while [ $# -gt 0 ]; do
  case "$1" in
    --enable) ENABLE=1 ;;
    --disabled) DISABLE=1 ;;
    --no-app) APP=0 ;;
    --onepage) ONEPAGE="${2:?--onepage needs a directory}"; shift ;;
    --onepage-app) ONEPAGE_APP=1 ;;
    --restore-app) RESTORE_APP=1 ;;
    --lambda-only) LAMBDA_ONLY=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$LAMBDA_ONLY" = 1 ]; then
  [ -n "$ONEPAGE" ] || [ "$ONEPAGE_APP" = 1 ] || [ "$RESTORE_APP" = 1 ] || [ "$ENABLE" = 1 ] || [ "$DISABLE" = 1 ] && {
    echo "--lambda-only updates the function only; it does not combine with --onepage, --onepage-app, --restore-app, --enable or --disabled" >&2; exit 2; }
  APP=0
fi
# The one-page build is checked before anything touches AWS.
if [ -n "$ONEPAGE" ]; then ONEPAGE_FILE=$(node "$ROOT/onepage/deploy-check.mjs" "$ONEPAGE") || exit 1; APP=0; fi
[ -n "$ONEPAGE" ] && [ "$ONEPAGE_APP" = 1 ] && { echo "--onepage and --onepage-app are exclusive" >&2; exit 2; }
SCRUB="${WORKSPACE_SCRUB_PATTERNS:-}"
if [ -z "$SCRUB" ] && [ -n "${WORKSPACE_SCRUB_PATTERNS_FILE:-}" ]; then
  [ -r "$WORKSPACE_SCRUB_PATTERNS_FILE" ] || { echo "WORKSPACE_SCRUB_PATTERNS_FILE $WORKSPACE_SCRUB_PATTERNS_FILE is not readable" >&2; exit 1; }
  SCRUB=$(python3 - "$WORKSPACE_SCRUB_PATTERNS_FILE" <<'PY'
import re, sys
lines = [l.strip() for l in open(sys.argv[1], encoding="utf-8") if l.strip() and not l.strip().startswith("#")]
print(",".join(p for p in (x.strip() for x in re.split(r"[,\n]", "\n".join(lines))) if p))
PY
)
  [ -n "$SCRUB" ] || { echo "WORKSPACE_SCRUB_PATTERNS_FILE $WORKSPACE_SCRUB_PATTERNS_FILE has no patterns (only comments or blank lines)" >&2; exit 1; }
fi
if [ "$ONEPAGE_APP" = 1 ]; then
  [ -n "$SCRUB" ] || { echo "--onepage-app needs scrub patterns: set WORKSPACE_SCRUB_PATTERNS or WORKSPACE_SCRUB_PATTERNS_FILE" >&2; exit 1; }
  ONEPAGE_APP_DIR="$(mktemp -d)"
  node "$ROOT/onepage/build.mjs" --app --out "$ONEPAGE_APP_DIR" --quiet || exit 1
  ONEPAGE_FILE=$(node "$ROOT/onepage/deploy-check.mjs" --app "$ONEPAGE_APP_DIR") || exit 1
  APP=0
fi
CALLER=$(aws sts get-caller-identity --query Account --output text)
# AWS_ACCOUNT_ID, when set, must match the account the credentials are for.
ACCOUNT=${AWS_ACCOUNT_ID:-$CALLER}
FN=gtm-preview-refresh
ROLE=gtm-preview-refresh-role
SCHED_ROLE=gtm-preview-refresh-scheduler
SCHEDULE=gtm-preview-refresh-15m
ALARM=gtm-preview-refresh-errors
LOG_GROUP=/aws/lambda/$FN
DATA_BUCKET=opstream-gtm-data-$ACCOUNT
PREVIEW_BUCKET=opstream-gtm-preview-db5553a4
TOPIC=arn:aws:sns:us-east-2:$ACCOUNT:opstream-gtm-refresh-failures
FN_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:$FN

[ "$CALLER" = "$ACCOUNT" ] || { echo "wrong AWS account" >&2; exit 1; }
TMP="$(mktemp -d)"

if [ "$LAMBDA_ONLY" != 1 ]; then
# ---------- log group (14-day retention) ----------
aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 14

# ---------- Lambda execution role ----------
cat > "$TMP/trust-lambda.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole",
 "Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}}]}
EOF
# The function only reads the published snapshot: no Secrets Manager, no provider
# APIs (LIVE_PULL stays 0 and is not granted). CloudFront uses the CachingDisabled
# managed policy on its only behavior, so there is no cloudfront:* permission
# either (see README.md). ListBucket on the preview bucket makes a missing
# refresh.json read as 404 instead of 403.
cat > "$TMP/policy-lambda.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"OwnLogGroupOnly","Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],
  "Resource":"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:$LOG_GROUP:*"},
 {"Sid":"SnapshotList","Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::$DATA_BUCKET",
  "Condition":{"StringLike":{"s3:prefix":["published/*"]}}},
 {"Sid":"SnapshotRead","Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::$DATA_BUCKET/published/*"},
 {"Sid":"PreviewDataJsAndRefreshJson","Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],
  "Resource":["arn:aws:s3:::$PREVIEW_BUCKET/data.js","arn:aws:s3:::$PREVIEW_BUCKET/refresh.json","arn:aws:s3:::$PREVIEW_BUCKET/_state/hubspot-live.json"]},
 {"Sid":"PreviewWorkspaceJsonWriteOnly","Effect":"Allow","Action":"s3:PutObject",
  "Resource":["arn:aws:s3:::$PREVIEW_BUCKET/workspace.json"]},
 {"Sid":"PreviewListSoMissingIs404","Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::$PREVIEW_BUCKET"},
 {"Sid":"Alarm","Effect":"Allow","Action":"sns:Publish","Resource":"$TOPIC"}
]}
EOF
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$TMP/trust-lambda.json"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$TMP/trust-lambda.json" \
    --description "gtm-preview-refresh Lambda: read published snapshot, write preview data.js/refresh.json" >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name gtm-preview-refresh --policy-document "file://$TMP/policy-lambda.json"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

# ---------- Scheduler role ----------
cat > "$TMP/trust-sched.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole",
 "Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}}]}
EOF
cat > "$TMP/policy-sched.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":["$FN_ARN","$FN_ARN:*"]}]}
EOF
if aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$SCHED_ROLE" --policy-document "file://$TMP/trust-sched.json"
else
  aws iam create-role --role-name "$SCHED_ROLE" --assume-role-policy-document "file://$TMP/trust-sched.json" \
    --description "EventBridge Scheduler: invoke gtm-preview-refresh only" >/dev/null
fi
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name invoke-gtm-preview-refresh --policy-document "file://$TMP/policy-sched.json"
SCHED_ROLE_ARN=$(aws iam get-role --role-name "$SCHED_ROLE" --query Role.Arn --output text)
fi

# ---------- package (code only; the snapshot is read at run time) ----------
( cd "$ROOT" && python3 - "$TMP/fn.zip" <<'PY'
import sys, zipfile
# sources.mjs holds the LIVE_PULL code (and the Fathom matcher compose.mjs uses); it never runs with LIVE_PULL=0.
# The page's view and render code (onepage/, workspace/src validators) let workspace-json.mjs trial-render each file.
files = ["workspace/refresh/handler.mjs", "workspace/refresh/compose.mjs", "workspace/refresh/sources.mjs", "workspace/refresh/workspace-json.mjs",
         "workspace/build.mjs", "workspace/lib/project.mjs", "workspace-model.cjs", "shared/open-pipeline.json",
         "onepage/view.cjs", "onepage/page.cjs", "workspace/src/lost-reasons.js", "workspace/src/insights.js",
         "config/freshness-sources.json"]
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        info = zipfile.ZipInfo(f, date_time=(2020, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, open(f, "rb").read())
PY
)

# ---------- Lambda ----------
# The function's environment: LIVE_PULL=0 and the scrub patterns (given now, else kept from the current function).
if [ -z "$SCRUB" ]; then
  SCRUB=$(aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables.WORKSPACE_SCRUB_PATTERNS' --output text 2>/dev/null || true)
  [ "$SCRUB" = "None" ] && SCRUB=""
fi
if [ -z "$SCRUB" ]; then
  [ "$ONEPAGE_APP" = 1 ] && { echo "--onepage-app needs scrub patterns: set WORKSPACE_SCRUB_PATTERNS or WORKSPACE_SCRUB_PATTERNS_FILE" >&2; exit 1; }
  echo "warning: no scrub patterns; the function will keep the last good workspace.json and alarm workspace-scrub-patterns-missing" >&2
fi
# Written to a private file and passed as file://, so the patterns never appear on a command line.
# The current environment (it holds the patterns too) is read into a private file for the minute settings.
( umask 077; aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json > "$TMP/env-now.json" 2>/dev/null || true )
( umask 077; SCRUB="$SCRUB" python3 - "$TMP/env-now.json" > "$TMP/env.json" <<'PY'
import json, os, sys
try:
    now = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    now = None
now = now if isinstance(now, dict) else {}
v = {"LIVE_PULL": "0"}
if os.environ["SCRUB"]:
    v["WORKSPACE_SCRUB_PATTERNS"] = os.environ["SCRUB"]
for k in ("WORKSPACE_MAX_AGE_MIN", "WORKSPACE_STALE_MIN", "FRESH_STALE_MIN"):
    x = os.environ.get(k, "").strip() or str(now.get(k) or "").strip()
    if x:
        v[k] = x
print(json.dumps({"Variables": v}))
PY
)
rm -f "$TMP/env-now.json"
if [ "$LAMBDA_ONLY" = 1 ]; then
  aws lambda get-function --function-name "$FN" >/dev/null 2>&1 || { echo "--lambda-only: $FN does not exist; run a full deploy first" >&2; exit 1; }
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$TMP/fn.zip" --architectures arm64 >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" --environment "file://$TMP/env.json" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN"
  echo "function  $FN_ARN (code and environment only; IAM, schedule, alarm and the preview bucket's files untouched)"
  exit 0
fi
FN_CONFIG=(--runtime nodejs20.x --handler workspace/refresh/handler.handler --role "$ROLE_ARN"
  --memory-size 512 --timeout 120 --environment "file://$TMP/env.json"
  --description "GTM preview refresh: published snapshot -> data.js when changed (no AI, no provider APIs)"
  --logging-config "LogFormat=Text,LogGroup=$LOG_GROUP")
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$TMP/fn.zip" --architectures arm64 >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" "${FN_CONFIG[@]}" >/dev/null
else
  # A new role can take a few seconds to be assumable by Lambda.
  for i in 1 2 3 4 5 6; do
    if aws lambda create-function --function-name "$FN" --architectures arm64 --zip-file "fileb://$TMP/fn.zip" "${FN_CONFIG[@]}" >/dev/null 2>"$TMP/err"; then break; fi
    grep -q "cannot be assumed" "$TMP/err" && [ "$i" -lt 6 ] && { sleep 10; continue; }
    cat "$TMP/err" >&2; exit 1
  done
fi
aws lambda wait function-updated-v2 --function-name "$FN"
# One run at a time; no async retries (the next run is 15 minutes away).
aws lambda put-function-concurrency --function-name "$FN" --reserved-concurrent-executions 1 >/dev/null
aws lambda put-function-event-invoke-config --function-name "$FN" --maximum-retry-attempts 0 --maximum-event-age-in-seconds 600 >/dev/null

# ---------- alarm: any Lambda error -> SNS ----------
aws cloudwatch put-metric-alarm --alarm-name "$ALARM" \
  --alarm-description "gtm-preview-refresh Lambda errored (the function also publishes the error text to this topic)" \
  --namespace AWS/Lambda --metric-name Errors --dimensions Name=FunctionName,Value="$FN" \
  --statistic Sum --period 900 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC" --ok-actions "$TOPIC"

# ---------- schedule ----------
SCHED_ARGS=(--name "$SCHEDULE" --schedule-expression "rate(15 minutes)" --flexible-time-window Mode=OFF
  --target "{\"Arn\":\"$FN_ARN\",\"RoleArn\":\"$SCHED_ROLE_ARN\",\"RetryPolicy\":{\"MaximumRetryAttempts\":0,\"MaximumEventAgeInSeconds\":600}}"
  --description "GTM preview refresh every 15 minutes (off switch: gtm-preview-refresh-off.sh)")
if STATE=$(aws scheduler get-schedule --name "$SCHEDULE" --query State --output text 2>/dev/null); then
  [ "$ENABLE" = 1 ] && STATE=ENABLED
  [ "$DISABLE" = 1 ] && STATE=DISABLED
  aws scheduler update-schedule "${SCHED_ARGS[@]}" --state "$STATE" >/dev/null
else
  STATE=ENABLED; [ "$DISABLE" = 1 ] && STATE=DISABLED
  aws scheduler create-schedule "${SCHED_ARGS[@]}" --state "$STATE" >/dev/null
fi

# ---------- page code (static files only; data.js is the function's job) ----------
if [ "$APP" = 1 ]; then
  up() { aws s3 cp "$ROOT/workspace/src/$1" "s3://$PREVIEW_BUCKET/$2" --content-type "$3" --cache-control no-store --only-show-errors; }
  LIVE_PAGE=$(aws s3api head-object --bucket "$PREVIEW_BUCKET" --key index.html --query 'Metadata."gtm-page"' --output text 2>/dev/null || true)
  if [ "$LIVE_PAGE" = "onepage-app" ] && [ "$RESTORE_APP" != 1 ]; then
    echo "index.html is the one-page workspace: left as it is (pass --restore-app to put the workspace app back)" >&2
  elif [ -n "$LIVE_PAGE" ] && [ "$LIVE_PAGE" != "None" ] && [ "$RESTORE_APP" != 1 ]; then
    echo "index.html carries gtm-page=$LIVE_PAGE: left as it is (pass --restore-app to put the workspace app back)" >&2
  else
    up index.html index.html "text/html; charset=utf-8"
  fi
  up app.js app.js "application/javascript; charset=utf-8"
  up styles.css styles.css "text/css; charset=utf-8"
  up charts.js vendor/gtm-charts.js "application/javascript; charset=utf-8"
  up insights.js vendor/insights.js "application/javascript; charset=utf-8"
  up lost-reasons.js vendor/lost-reasons.js "application/javascript; charset=utf-8"
fi

# ---------- one-page workspace (replaces the app's index.html) ----------
if [ -n "$ONEPAGE" ]; then
  aws s3 cp "$ONEPAGE_FILE" "s3://$PREVIEW_BUCKET/index.html" --content-type "text/html; charset=utf-8" --cache-control no-store --only-show-errors
  echo "page      s3://$PREVIEW_BUCKET/index.html (one-page workspace from $ONEPAGE)"
fi
# Live one-page workspace: run the updated function once so workspace.json is in place, then swap index.html.
if [ "$ONEPAGE_APP" = 1 ]; then
  # --cli-read-timeout above the function's 120 s timeout, so a slow run is not retried (run twice) by the CLI.
  # AWS CLI v1 has no --cli-binary-format (it sends --payload as raw JSON already).
  BINFMT=(); aws --version 2>&1 | grep -q '^aws-cli/2' && BINFMT=(--cli-binary-format raw-in-base64-out)
  for i in 1 2 3 4 5 6; do
    aws lambda invoke --function-name "$FN" "${BINFMT[@]}" --cli-read-timeout 150 --payload '{}' \
      "$TMP/invoke.json" >"$TMP/invoke-meta.json" 2>"$TMP/invoke.err" && break
    grep -q "TooManyRequests" "$TMP/invoke.err" && [ "$i" -lt 6 ] && { sleep 20; continue; }
    cat "$TMP/invoke.err" >&2; echo "the function did not run; index.html NOT uploaded (the live page is unchanged)" >&2; exit 1
  done
  # invoke exits 0 when the function itself fails: read FunctionError.
  if ! python3 -c 'import json,sys; sys.exit(1 if json.load(open(sys.argv[1])).get("FunctionError") else 0)' "$TMP/invoke-meta.json"; then
    echo "the function failed (FunctionError); index.html NOT uploaded (the live page is unchanged). Its output:" >&2
    head -c 600 "$TMP/invoke.json" >&2; echo >&2; exit 1
  fi
  # The run must have published or confirmed workspace.json, not kept an older copy or withheld it.
  aws s3 cp "s3://$PREVIEW_BUCKET/refresh.json" "$TMP/refresh.json" --only-show-errors
  if ! WS=$(python3 - "$TMP/refresh.json" <<'PY'
import json, sys
try:
    w = (json.load(open(sys.argv[1])) or {}).get("workspace") or {}
except (OSError, ValueError, AttributeError):
    print("unreadable "); sys.exit(1)
print("%s %s" % (w.get("status"), w.get("problem") or ""))
sys.exit(0 if w.get("status") in ("uploaded", "unchanged") else 1)
PY
  ); then
    echo "refresh.json .workspace is '$WS', not uploaded/unchanged; index.html NOT uploaded (the live page is unchanged)" >&2; exit 1
  fi
  if ! aws s3api head-object --bucket "$PREVIEW_BUCKET" --key workspace.json >/dev/null 2>&1; then
    echo "workspace.json is not in s3://$PREVIEW_BUCKET; index.html NOT uploaded (the live page is unchanged)" >&2; exit 1
  fi
  aws s3 cp "$ONEPAGE_FILE" "s3://$PREVIEW_BUCKET/index.html" --content-type "text/html; charset=utf-8" --cache-control no-store \
    --metadata gtm-page=onepage-app --only-show-errors
  echo "page      s3://$PREVIEW_BUCKET/index.html (one-page workspace, live: fetches workspace.json; workspace.json $WS)"
fi

echo "function  $FN_ARN"
echo "role      $ROLE_ARN"
echo "scheduler $SCHED_ROLE_ARN"
echo "schedule  arn:aws:scheduler:$AWS_REGION:$ACCOUNT:schedule/default/$SCHEDULE ($STATE)"
echo "alarm     arn:aws:cloudwatch:$AWS_REGION:$ACCOUNT:alarm:$ALARM"
echo "logs      $LOG_GROUP"
