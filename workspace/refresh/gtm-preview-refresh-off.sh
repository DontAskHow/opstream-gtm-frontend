#!/usr/bin/env bash
# Off switch for the GTM preview refresh: sets the EventBridge Scheduler schedule
# gtm-preview-refresh-15m to DISABLED, keeping every other field as it is
# (update-schedule replaces the whole schedule, so the current values are read first).
# Turn it back on with:  workspace/refresh/deploy.sh --enable   (or ON=1 this script)
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-opstream-deploy}" AWS_REGION=us-east-2 AWS_PAGER=""
NAME=gtm-preview-refresh-15m
STATE=DISABLED; [ "${ON:-0}" = 1 ] && STATE=ENABLED
S=$(aws scheduler get-schedule --name "$NAME" --output json)
field() { python3 -c "import json,sys; d=json.load(sys.stdin); v=d$1; print(v if isinstance(v,str) else json.dumps(v))" <<<"$S"; }
aws scheduler update-schedule --name "$NAME" \
  --schedule-expression "$(field "['ScheduleExpression']")" \
  --flexible-time-window "$(field "['FlexibleTimeWindow']")" \
  --target "$(field "['Target']")" \
  --description "$(field ".get('Description','')")" \
  --state "$STATE" >/dev/null
echo "$NAME: $(aws scheduler get-schedule --name "$NAME" --query State --output text)"
