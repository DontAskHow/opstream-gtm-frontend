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
#
# Never uploads insights.json or lost-reasons.json: the Strategy seat publishes
# those with refresh/publish-insights.mjs and refresh/publish-lost-reasons.mjs.
#
# Off switch: workspace/refresh/gtm-preview-refresh-off.sh
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-opstream-deploy}"
export AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2
export AWS_PAGER=""

ENABLE=0; DISABLE=0; APP=1
for a in "$@"; do
  case "$a" in
    --enable) ENABLE=1 ;;
    --disabled) DISABLE=1 ;;
    --no-app) APP=0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACCOUNT=080403790510
FN=gtm-preview-refresh
ROLE=gtm-preview-refresh-role
SCHED_ROLE=gtm-preview-refresh-scheduler
SCHEDULE=gtm-preview-refresh-15m
ALARM=gtm-preview-refresh-errors
LOG_GROUP=/aws/lambda/$FN
DATA_BUCKET=opstream-gtm-data-080403790510
PREVIEW_BUCKET=opstream-gtm-preview-db5553a4
TOPIC=arn:aws:sns:us-east-2:$ACCOUNT:opstream-gtm-refresh-failures
FN_ARN=arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:$FN

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong AWS account" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

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

# ---------- package (code only; the snapshot is read at run time) ----------
( cd "$ROOT" && python3 - "$TMP/fn.zip" <<'PY'
import sys, zipfile
# sources.mjs holds the LIVE_PULL code (and the Fathom matcher compose.mjs uses); it never runs with LIVE_PULL=0.
files = ["workspace/refresh/handler.mjs", "workspace/refresh/compose.mjs", "workspace/refresh/sources.mjs",
         "workspace/build.mjs", "workspace/lib/project.mjs", "workspace-model.cjs", "shared/open-pipeline.json"]
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        info = zipfile.ZipInfo(f, date_time=(2020, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, open(f, "rb").read())
PY
)

# ---------- Lambda ----------
FN_CONFIG=(--runtime nodejs20.x --handler workspace/refresh/handler.handler --role "$ROLE_ARN"
  --memory-size 512 --timeout 120 --environment "Variables={LIVE_PULL=0}"
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
  up index.html index.html "text/html; charset=utf-8"
  up app.js app.js "application/javascript; charset=utf-8"
  up styles.css styles.css "text/css; charset=utf-8"
  up charts.js vendor/gtm-charts.js "application/javascript; charset=utf-8"
  up insights.js vendor/insights.js "application/javascript; charset=utf-8"
  up lost-reasons.js vendor/lost-reasons.js "application/javascript; charset=utf-8"
fi

echo "function  $FN_ARN"
echo "role      $ROLE_ARN"
echo "scheduler $SCHED_ROLE_ARN"
echo "schedule  arn:aws:scheduler:$AWS_REGION:$ACCOUNT:schedule/default/$SCHEDULE ($STATE)"
echo "alarm     arn:aws:cloudwatch:$AWS_REGION:$ACCOUNT:alarm:$ALARM"
echo "logs      $LOG_GROUP"
