#!/usr/bin/env bash
# Sync-only GTM refresh: task definition, cluster, scheduler role, schedules,
# and failure alert. Account, network, and image values come from the
# environment so none are kept in this repository.
#
#   ACCOUNT_ID=... REGION=us-east-2 IMAGE_TAG=sync-only-<sha> \
#   SUBNETS=subnet-a,subnet-b,subnet-c SECURITY_GROUP=sg-... \
#   TOPIC_ARN=arn:aws:sns:...:opstream-gtm-refresh-failures \
#   CPU=256 MEMORY=1024 STATE=DISABLED ./setup.sh
#
# Leaves the 6-hourly job (schedule opstream-gtm-refresh, task definition
# opstream-gtm-refresh:1, image tag latest) untouched.
set -euo pipefail
: "${ACCOUNT_ID:?}" "${IMAGE_TAG:?}" "${SUBNETS:?}" "${SECURITY_GROUP:?}" "${TOPIC_ARN:?}"
REGION="${REGION:-us-east-2}"; CPU="${CPU:-256}"; MEMORY="${MEMORY:-1024}"; STATE="${STATE:-DISABLED}"
export AWS_DEFAULT_REGION="$REGION"
ARN="arn:aws:%s:$REGION:$ACCOUNT_ID"
IAM="arn:aws:iam::$ACCOUNT_ID:role"
CLUSTER_ARN="arn:aws:ecs:$REGION:$ACCOUNT_ID:cluster/opstream-gtm-sync"
TMP=$(mktemp -d)

# Task definition: same roles and log group as the 6-hourly job, stream prefix "sync".
cat > "$TMP/taskdef.json" <<JSON
{"family":"opstream-gtm-sync","requiresCompatibilities":["FARGATE"],"networkMode":"awsvpc",
 "cpu":"$CPU","memory":"$MEMORY",
 "taskRoleArn":"$IAM/opstream-gtm-refresh-task","executionRoleArn":"$IAM/opstream-gtm-refresh-exec",
 "containerDefinitions":[{"name":"sync","essential":true,
  "image":"$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/opstream-gtm-refresh:$IMAGE_TAG",
  "environment":[{"name":"SYNC_ONLY","value":"1"},{"name":"GA4_MIN_INTERVAL_MIN","value":"60"},
                 {"name":"SYNC_SKIP_WINDOWS","value":"0,6,12,18:10-29"},{"name":"SYNC_LOCK_TTL_MIN","value":"50"}],
  "logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/opstream/gtm-refresh",
   "awslogs-region":"$REGION","awslogs-stream-prefix":"sync"}}}]}
JSON
# TASK_DEF=opstream-gtm-sync:<n> reuses a registered revision instead.
if [ -n "${TASK_DEF:-}" ]; then
  TD=$(aws ecs describe-task-definition --task-definition "$TASK_DEF" --query taskDefinition.taskDefinitionArn --output text)
else
  TD=$(aws ecs register-task-definition --cli-input-json "file://$TMP/taskdef.json" --query taskDefinition.taskDefinitionArn --output text)
fi
echo "task definition $TD"

# Own cluster, so the existing cluster-wide failure rule does not alert twice.
aws ecs describe-clusters --clusters opstream-gtm-sync --query 'clusters[?status==`ACTIVE`].clusterArn' --output text | grep -q . \
  || aws ecs create-cluster --cluster-name opstream-gtm-sync >/dev/null

# Scheduler role: RunTask on this family in this cluster only, PassRole for the two task roles.
if ! aws iam get-role --role-name opstream-gtm-sync-scheduler >/dev/null 2>&1; then
  aws iam create-role --role-name opstream-gtm-sync-scheduler --assume-role-policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"scheduler.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT_ID\"}}}]}" >/dev/null
fi
aws iam put-role-policy --role-name opstream-gtm-sync-scheduler --policy-name run-task --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ecs:RunTask\",\"Resource\":\"arn:aws:ecs:$REGION:$ACCOUNT_ID:task-definition/opstream-gtm-sync:*\",\"Condition\":{\"ArnEquals\":{\"ecs:cluster\":\"$CLUSTER_ARN\"}}},{\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":[\"$IAM/opstream-gtm-refresh-task\",\"$IAM/opstream-gtm-refresh-exec\"]}]}"

# Schedules (America/Phoenix, no flexible window).
schedule() {  # name expression retries max-age-seconds
  local subnets; subnets=$(printf '"%s",' ${SUBNETS//,/ }); subnets="[${subnets%,}]"
  local target="{\"Arn\":\"$CLUSTER_ARN\",\"RoleArn\":\"$IAM/opstream-gtm-sync-scheduler\",
    \"RetryPolicy\":{\"MaximumRetryAttempts\":$3,\"MaximumEventAgeInSeconds\":$4},
    \"EcsParameters\":{\"TaskDefinitionArn\":\"$TD\",\"TaskCount\":1,\"LaunchType\":\"FARGATE\",
      \"NetworkConfiguration\":{\"awsvpcConfiguration\":{\"Subnets\":$subnets,\"SecurityGroups\":[\"$SECURITY_GROUP\"],\"AssignPublicIp\":\"ENABLED\"}}}}"
  local verb=create; aws scheduler get-schedule --name "$1" >/dev/null 2>&1 && verb=update
  aws scheduler $verb-schedule --name "$1" --schedule-expression "$2" --schedule-expression-timezone America/Phoenix \
    --flexible-time-window Mode=OFF --state "$STATE" --target "$target" >/dev/null
  echo "schedule $1 $2 ($verb, $STATE)"
}
schedule opstream-gtm-sync-15m                "cron(0/15 * * * ? *)"         0 900
schedule opstream-gtm-sync-precheckin-weekday "cron(20 7 ? * MON-FRI *)"     1 600
schedule opstream-gtm-sync-precheckin-monday  "cron(0 8 ? * MON *)"          1 600

# Failure alert: non-zero exit or failed start of any opstream-gtm-sync revision.
aws events put-rule --name opstream-gtm-sync-task-failed --state ENABLED --event-pattern \
  "{\"source\":[\"aws.ecs\"],\"detail-type\":[\"ECS Task State Change\"],\"detail\":{\"lastStatus\":[\"STOPPED\"],\"taskDefinitionArn\":[{\"prefix\":\"arn:aws:ecs:$REGION:$ACCOUNT_ID:task-definition/opstream-gtm-sync:\"}],\"\$or\":[{\"containers\":{\"exitCode\":[{\"anything-but\":0}]}},{\"stopCode\":[\"TaskFailedToStart\"]}]}}" >/dev/null
aws events put-targets --rule opstream-gtm-sync-task-failed --targets "Id=notify,Arn=$TOPIC_ARN" >/dev/null
echo "rule opstream-gtm-sync-task-failed -> $TOPIC_ARN"
echo "The topic policy must allow events.amazonaws.com to sns:Publish (see docs/sync-only.md)."
