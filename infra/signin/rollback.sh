#!/usr/bin/env bash
# Puts the GTM preview back on HTTP Basic only, in one distribution update: re-associates the CloudFront
# Functions gtm-preview-auth-db5553a4 (viewer-request) and gtm-preview-headers-db5553a4 (viewer-response),
# removes the Lambda@Edge association and detaches the response headers policy that stood in for the
# headers function. That is the pre-sign-in configuration. The Lambda, its versions, role, secrets and the
# (now unattached) headers policy are left in place; teardown removes them.
#
#   infra/signin/rollback.sh            # update + wait until Deployed
#   infra/signin/rollback.sh --no-wait
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-opstream-deploy}"
export AWS_PAGER=""
WAIT=1
for a in "$@"; do
  case "$a" in
    --no-wait) WAIT=0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

ACCOUNT=080403790510
DIST=EZQ1E2Y6O6NDG
AUTH_FN=gtm-preview-auth-db5553a4
AUTH_FN_ARN=arn:aws:cloudfront::$ACCOUNT:function/$AUTH_FN
HEADERS_FN_ARN=arn:aws:cloudfront::$ACCOUNT:function/gtm-preview-headers-db5553a4

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong AWS account" >&2; exit 1; }
# Never leave the preview without a viewer-request gate: the Basic function must still be live.
[ "$(aws cloudfront describe-function --name "$AUTH_FN" --stage LIVE --query FunctionSummary.Status --output text 2>/dev/null)" = DEPLOYED ] \
  || { echo "$AUTH_FN is not deployed (LIVE); refusing to remove the Lambda gate" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
aws cloudfront get-distribution-config --id "$DIST" > "$TMP/dist.json"
ETAG=$(jq -r .ETag "$TMP/dist.json")
jq --arg a "$AUTH_FN_ARN" --arg h "$HEADERS_FN_ARN" '.DistributionConfig
  | .DefaultCacheBehavior.LambdaFunctionAssociations = {Quantity: 0}
  | del(.DefaultCacheBehavior.ResponseHeadersPolicyId)
  | .DefaultCacheBehavior.FunctionAssociations = {Quantity: 2, Items: [
      {FunctionARN: $h, EventType: "viewer-response"}, {FunctionARN: $a, EventType: "viewer-request"}]}' \
  "$TMP/dist.json" > "$TMP/new.json"
if jq -S .DistributionConfig "$TMP/dist.json" | cmp -s - <(jq -S . "$TMP/new.json"); then
  echo "distribution $DIST already on $AUTH_FN (no Lambda association)"
else
  aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config "file://$TMP/new.json" >/dev/null
  echo "distribution $DIST: viewer-request -> $AUTH_FN, viewer-response -> headers function, Lambda@Edge and headers policy removed"
fi
if [ "$WAIT" = 1 ]; then
  echo "waiting for $DIST to be Deployed..."
  aws cloudfront wait distribution-deployed --id "$DIST"
  echo "distribution $DIST Deployed"
fi
