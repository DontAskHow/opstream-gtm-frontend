#!/usr/bin/env bash
# v14 rollout. Run in AWS CloudShell (us-east-2) from the folder that holds
# refresh-src-v14.zip, gtm-refresh-v14.yaml and opstream-gtm-v14.zip.
#
# Part A rolls out the v14 refresh job: the same steps as v13 with the v14
# source. It publishes a run where the Sheet's probability wins (weighted
# $889,750 on the Sep 28 book), meetings carry their own invitees, each
# meeting is stored once, GA4 sessions are www-only, vendor payments are
# matched to shows, follow-ups are signed by whoever ran the call, pulse
# suggestions are internal notes, and every file carries one runId.
# Part B deploys the v14 dashboard bundle to Elastic Beanstalk as a new
# application version. It changes code only: no option settings, no
# environment properties. Each instance swaps in the latest published run
# before it takes traffic and polls every 2 minutes.
#
#   bash gtm-v14.sh                   both parts, A then B
#   SKIP_REFRESH=1 bash gtm-v14.sh    only B (the page works on the v13 run;
#                                     the v14 data fixes appear after A runs)
set -euo pipefail

REGION=us-east-2
BUCKET=opstream-gtm-data-080403790510
STACK=opstream-gtm-refresh
SOURCE_KEY=code/refresh-src/v14.zip
ZIP=refresh-src-v14.zip
TEMPLATE=gtm-refresh-v14.yaml
BUNDLE=opstream-gtm-v14.zip
ENV_NAME=opstream-gtm-prod
ROLLBACK=v13-20260928-175730

for f in "$ZIP" "$TEMPLATE" "$BUNDLE"; do
  [ -f "$f" ] || { echo "missing $f in $(pwd)"; exit 1; }
done

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

if [ "${SKIP_REFRESH:-}" != "1" ]; then
  echo "== A1. upload $ZIP to s3://$BUCKET/$SOURCE_KEY"
  aws s3 cp "$ZIP" "s3://$BUCKET/$SOURCE_KEY" --region "$REGION"

  echo "== A2. deploy $STACK with SourceKey=$SOURCE_KEY (other parameters keep their current values)"
  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "$STACK" \
    --template-file "$TEMPLATE" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides SourceKey="$SOURCE_KEY" \
    --no-fail-on-empty-changeset

  echo "== A3. build the refresh image in CodeBuild"
  PROJECT=$(output CodeBuildProject)
  BUILD_ID=$(aws codebuild start-build --region "$REGION" --project-name "$PROJECT" --query 'build.id' --output text)
  echo "build $BUILD_ID"
  while true; do
    STATUS=$(aws codebuild batch-get-builds --region "$REGION" --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)
    echo "  $STATUS"
    case "$STATUS" in
      SUCCEEDED) break ;;
      FAILED|FAULT|STOPPED|TIMED_OUT) echo "build $STATUS. Logs: /aws/codebuild/$PROJECT"; exit 1 ;;
    esac
    sleep 20
  done

  echo "== A4. run the refresh task unless one is already running"
  CLUSTER=$(output ClusterName)
  RUNNING=$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --family opstream-gtm-refresh \
    --desired-status RUNNING --query 'taskArns' --output text)
  if [ -n "$RUNNING" ] && [ "$RUNNING" != "None" ]; then
    TASK=$(echo "$RUNNING" | awk '{print $1}')
    echo "already running: $TASK"
  else
    VPC=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
    SUBNETS=$(aws ec2 describe-subnets --region "$REGION" --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true \
      --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
    SG=$(output TaskSecurityGroupId)
    TASK=$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --launch-type FARGATE \
      --task-definition opstream-gtm-refresh \
      --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
      --query 'tasks[0].taskArn' --output text)
    echo "started: $TASK"
  fi

  echo "== A5. wait for the task to finish (up to 30 minutes)"
  for _ in $(seq 1 90); do
    LAST=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].lastStatus' --output text)
    [ "$LAST" = "STOPPED" ] && break
    echo "  $LAST"
    sleep 20
  done
  aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" \
    --query 'tasks[0].{status:lastStatus,exitCode:containers[0].exitCode,reason:stoppedReason}' --output table
  echo "Logs: CloudWatch /opstream/gtm-refresh. Look for 'sync summary' and 'align-run run-... open 32 3960000'."

  echo "== A6. LATEST.json and the published run-facts"
  aws s3 cp "s3://$BUCKET/published/LATEST.json" - --region "$REGION"
  echo
  PREFIX=$(aws s3 cp "s3://$BUCKET/published/LATEST.json" - --region "$REGION" \
    | python3 -c 'import json,sys; l=json.load(sys.stdin); print((l.get("prefix") or "published/" + l["runId"] + "/").rstrip("/"))')
  aws s3 cp "s3://$BUCKET/$PREFIX/run-facts.json" - --region "$REGION" \
    | python3 -c 'import json,sys; f=json.load(sys.stdin); print("run-facts:", f["runId"], "open", f["openCount"], f["openAmount"], "weighted", f["weighted"])'
fi

echo "== B1. find the Elastic Beanstalk application for $ENV_NAME"
APP=$(aws elasticbeanstalk describe-environments --region "$REGION" --environment-names "$ENV_NAME" \
  --query 'Environments[0].ApplicationName' --output text)
PREVIOUS=$(aws elasticbeanstalk describe-environments --region "$REGION" --environment-names "$ENV_NAME" \
  --query 'Environments[0].VersionLabel' --output text)
[ -n "$APP" ] && [ "$APP" != "None" ] || { echo "environment $ENV_NAME not found in $REGION"; exit 1; }
echo "application $APP, currently running $PREVIOUS"

echo "== B2. recent 5xx on $ENV_NAME before the deploy (audit item B20)"
aws elasticbeanstalk describe-environment-health --region "$REGION" --environment-name "$ENV_NAME" \
  --attribute-names Status HealthStatus Causes ApplicationMetrics \
  --query '{health:HealthStatus,causes:Causes,requests:ApplicationMetrics.RequestCount,status:ApplicationMetrics.StatusCodes}' --output json || true

LABEL=v14-$(date -u +%Y%m%d-%H%M%S)
EB_BUCKET=$(aws elasticbeanstalk create-storage-location --region "$REGION" --query S3Bucket --output text)
echo "== B3. upload $BUNDLE to s3://$EB_BUCKET/$APP/$LABEL.zip"
aws s3 cp "$BUNDLE" "s3://$EB_BUCKET/$APP/$LABEL.zip" --region "$REGION"

echo "== B4. create application version $LABEL"
aws elasticbeanstalk create-application-version --region "$REGION" \
  --application-name "$APP" --version-label "$LABEL" \
  --source-bundle S3Bucket="$EB_BUCKET",S3Key="$APP/$LABEL.zip" \
  --description "v14: live-audit fixes, numbers block, sign-in for writes" \
  --process >/dev/null
for _ in $(seq 1 30); do
  VSTATUS=$(aws elasticbeanstalk describe-application-versions --region "$REGION" --application-name "$APP" \
    --version-labels "$LABEL" --query 'ApplicationVersions[0].Status' --output text)
  echo "  $VSTATUS"
  [ "$VSTATUS" = "PROCESSED" ] && break
  [ "$VSTATUS" = "FAILED" ] && { echo "the bundle did not validate"; exit 1; }
  sleep 5
done

echo "== B5. deploy $LABEL to $ENV_NAME (code only: no option settings)"
aws elasticbeanstalk update-environment --region "$REGION" --environment-name "$ENV_NAME" --version-label "$LABEL" >/dev/null
aws elasticbeanstalk wait environment-updated --region "$REGION" --environment-names "$ENV_NAME"
aws elasticbeanstalk describe-environments --region "$REGION" --environment-names "$ENV_NAME" \
  --query 'Environments[0].{version:VersionLabel,health:Health,status:Status,url:CNAME}' --output table

CNAME=$(aws elasticbeanstalk describe-environments --region "$REGION" --environment-names "$ENV_NAME" \
  --query 'Environments[0].CNAME' --output text)
echo "== B6. smoke check (files first, no curl pipe; nothing here writes)"
SMOKE=$(mktemp -d)
ok=1
curl -fsS -o "$SMOKE/stamp.json" "http://$CNAME/api/data-stamp" || ok=0
curl -fsS -o "$SMOKE/page.html" "http://$CNAME/" || ok=0
curl -fsS -o "$SMOKE/facts.json" "http://$CNAME/data/run-facts.json" || ok=0
# A signed-out Done must be refused. The server rejects it before touching any file.
curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"itemId":"q:smoke:check","action":"done"}' "http://$CNAME/api/hollie/feedback" > "$SMOKE/feedback.code" || true
if [ "$ok" = 1 ]; then
  python3 - "$SMOKE" <<'PYCHECK' || ok=0
import json, re, sys
d = sys.argv[1]
stamp = json.load(open(d + "/stamp.json"))
facts = json.load(open(d + "/facts.json"))
page = open(d + "/page.html", encoding="utf-8").read()
code = open(d + "/feedback.code").read().strip()
checks = {
    "data stamp and run-facts carry one runId": bool(stamp.get("runId")) and stamp.get("runId") == facts.get("runId"),
    "shared-view label is in the page": "Shared view · not signed in" in page,
    "the numbers block ships": 'id="kpi-block"' in page,
    "signed-out queue writes are refused (401)": code == "401",
    "no banned product name": not re.search("gr" + "ok", page, re.I),
    "no demo or legacy code in the page": not re.search(r"legacyOpenPipeline|Requested 09:12|demo-mode", page),
}
for name, good in checks.items():
    print(("ok " if good else "FAIL ") + name)
print("serving", stamp.get("runId"), "collected", stamp.get("label"), "· open", facts.get("openCount"), facts.get("openAmount"), "weighted", facts.get("weighted"))
if facts.get("weighted") != 889750:
    print("note: weighted is", facts.get("weighted"), "- the Sheet-probability total appears once Part A has published a v14 run.")
sys.exit(0 if all(checks.values()) else 1)
PYCHECK
fi
rm -rf "$SMOKE"
if [ "$ok" = 1 ]; then echo "v14 is live"; else echo "Smoke check failed. Roll back with the line below."; fi
echo "Rollback: aws elasticbeanstalk update-environment --region $REGION --environment-name $ENV_NAME --version-label $ROLLBACK"
echo "== V14 DONE"
