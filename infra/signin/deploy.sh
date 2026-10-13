#!/usr/bin/env bash
# Deploys Google sign-in for the GTM preview (distribution EZQ1E2Y6O6NDG) as a Lambda@Edge
# viewer-request function. Idempotent: re-run to update.
#
#   1. Secrets (us-east-1), created only if missing, values never displayed:
#        opstream-gtm/preview-session-key   random 48 bytes (hex) from openssl, HMAC key for the cookies
#        opstream-gtm/preview-edge-config   {"basic_auth_required": true, "basic_auth_sha256": sha256("user:password")}
#                                           from $BASIC_AUTH_CREDENTIALS_FILE; never overwritten by this script
#      Read (not created): us-east-2 opstream-gtm/google-oauth-client-id and -client-secret.
#   2. IAM role gtm-preview-signin-edge-role: GetSecretValue on exactly those four ARNs, plus its own logs.
#   3. Lambda gtm-preview-signin-edge (us-east-1, nodejs20.x, x86_64, 128 MB, 5 s, no env vars),
#      then a numbered version.
#   4. Response headers policy gtm-preview-headers-policy-db5553a4: the same four headers the CloudFront
#      Function gtm-preview-headers-db5553a4 sets, plus HSTS (max-age one year). CloudFront rejects a behavior that has a CloudFront
#      Function on any viewer event and Lambda@Edge on any viewer event (InvalidLambdaFunctionAssociation),
#      so that function cannot stay on viewer-response; the policy (no code, no per-request charge) replaces it.
#   5. Distribution default behavior, in one update: the Lambda version on viewer-request, both CloudFront
#      Functions disassociated (not deleted; rollback.sh puts them back), the headers policy attached.
#   6. 14-day retention on the function's log groups that exist (Lambda@Edge creates one in each region
#      that serves traffic, with no expiry); re-run to cover regions that started serving later.
#
#   infra/signin/deploy.sh             # deploy + wait until the distribution is Deployed
#   infra/signin/deploy.sh --no-wait
#   infra/signin/deploy.sh --no-dist   # build/publish only, leave the distribution alone
#
# Undo: infra/signin/rollback.sh. Drop the Basic gate later: infra/signin/set-basic-auth.sh off
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-opstream-deploy}"
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER=""

WAIT=1; DIST_UPDATE=1
for a in "$@"; do
  case "$a" in
    --no-wait) WAIT=0 ;;
    --no-dist) DIST_UPDATE=0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT=080403790510
DIST=EZQ1E2Y6O6NDG
FN=gtm-preview-signin-edge
ROLE=gtm-preview-signin-edge-role
HEADERS_POLICY=gtm-preview-headers-policy-db5553a4
LOG_RETENTION_DAYS=14
SESSION_SECRET=opstream-gtm/preview-session-key
CONFIG_SECRET=opstream-gtm/preview-edge-config
BASIC_AUTH_CREDENTIALS_FILE="${BASIC_AUTH_CREDENTIALS_FILE:-/workspace/gtm-preview-credentials.txt}"

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong AWS account" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------- secrets ----------
openssl rand -hex 48 | tr -d '\n' | python3 "$HERE/secret.py" create --region us-east-1 --name "$SESSION_SECRET" \
  --description "GTM preview sign-in: HMAC-SHA256 key for session/state cookies (Lambda@Edge $FN)"
if aws secretsmanager describe-secret --secret-id "$CONFIG_SECRET" >/dev/null 2>&1; then
  echo "exists   $CONFIG_SECRET (left as is; flip the flag with set-basic-auth.sh)"
else
  [ -r "$BASIC_AUTH_CREDENTIALS_FILE" ] || { echo "need $BASIC_AUTH_CREDENTIALS_FILE (user=/password=) to create $CONFIG_SECRET" >&2; exit 1; }
  python3 "$HERE/secret.py" basic-hash-config "$BASIC_AUTH_CREDENTIALS_FILE" \
    | python3 "$HERE/secret.py" create --region us-east-1 --name "$CONFIG_SECRET" \
        --description "GTM preview sign-in config: basic_auth_required flag and sha256 of the Basic credential"
fi
arn() { aws secretsmanager describe-secret --region "$1" --secret-id "$2" --query ARN --output text; }
ARN_CLIENT_ID=$(arn us-east-2 opstream-gtm/google-oauth-client-id)
ARN_CLIENT_SECRET=$(arn us-east-2 opstream-gtm/google-oauth-client-secret)
ARN_SESSION=$(arn us-east-1 "$SESSION_SECRET")
ARN_CONFIG=$(arn us-east-1 "$CONFIG_SECRET")

# ---------- edge role ----------
cat > "$TMP/trust.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":["lambda.amazonaws.com","edgelambda.amazonaws.com"]},"Action":"sts:AssumeRole"}]}
EOF
# Lambda@Edge logs to /aws/lambda/us-east-1.$FN in whichever region served the request.
cat > "$TMP/policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"ReadSignInSecrets","Effect":"Allow","Action":"secretsmanager:GetSecretValue",
  "Resource":["$ARN_CLIENT_ID","$ARN_CLIENT_SECRET","$ARN_SESSION","$ARN_CONFIG"]},
 {"Sid":"OwnLogs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
  "Resource":["arn:aws:logs:*:$ACCOUNT:log-group:/aws/lambda/us-east-1.$FN","arn:aws:logs:*:$ACCOUNT:log-group:/aws/lambda/us-east-1.$FN:*",
              "arn:aws:logs:us-east-1:$ACCOUNT:log-group:/aws/lambda/$FN","arn:aws:logs:us-east-1:$ACCOUNT:log-group:/aws/lambda/$FN:*"]}
]}
EOF
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$TMP/trust.json"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$TMP/trust.json" \
    --description "Lambda@Edge $FN: read the four sign-in secrets, write own logs" >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$FN" --policy-document "file://$TMP/policy.json"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

# ---------- package (fixed timestamps so unchanged code publishes no new version) ----------
python3 - "$TMP/fn.zip" "$HERE/edge" <<'PY'
import sys, zipfile, os
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for f in ["index.js", "lib.js"]:
        info = zipfile.ZipInfo(f, date_time=(2020, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, open(os.path.join(sys.argv[2], f), "rb").read())
PY

# ---------- Lambda (Lambda@Edge: us-east-1, x86_64, viewer limits 128 MB / 5 s, no environment) ----------
FN_CONFIG=(--runtime nodejs20.x --handler index.handler --role "$ROLE_ARN" --memory-size 128 --timeout 5
  --description "GTM preview sign-in (viewer-request): Basic gate, then Google session for allowed accounts")
CODE_SHA=$(openssl dgst -sha256 -binary "$TMP/fn.zip" | base64)
WANT="$CODE_SHA nodejs20.x index.handler $ROLE_ARN 128 5"
LATEST_VERSION=$(aws lambda list-versions-by-function --function-name "$FN" --query 'Versions[?Version!=`$LATEST`].Version' --output text 2>/dev/null | tr '\t' '\n' | sort -n | tail -1 || true)
HAVE=""
[ -n "$LATEST_VERSION" ] && HAVE=$(aws lambda get-function-configuration --function-name "$FN:$LATEST_VERSION" \
  --query '[CodeSha256,Runtime,Handler,Role,MemorySize,Timeout]' --output text | tr '\t' ' ')
if [ -n "$LATEST_VERSION" ] && [ "$HAVE" = "$WANT" ]; then
  VERSION_ARN=$(aws lambda get-function-configuration --function-name "$FN:$LATEST_VERSION" --query FunctionArn --output text)
  echo "unchanged: reusing version $LATEST_VERSION"
else
  if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$TMP/fn.zip" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$FN"
    aws lambda update-function-configuration --function-name "$FN" "${FN_CONFIG[@]}" >/dev/null
  else
    for i in 1 2 3 4 5 6; do
      if aws lambda create-function --function-name "$FN" --architectures x86_64 --zip-file "fileb://$TMP/fn.zip" "${FN_CONFIG[@]}" >/dev/null 2>"$TMP/err"; then break; fi
      grep -q "cannot be assumed" "$TMP/err" && [ "$i" -lt 6 ] && { sleep 10; continue; }
      cat "$TMP/err" >&2; exit 1
    done
  fi
  aws lambda wait function-updated-v2 --function-name "$FN"
  VERSION_ARN=$(aws lambda publish-version --function-name "$FN" --description "deployed by infra/signin/deploy.sh" --query FunctionArn --output text)
fi
aws lambda wait function-active-v2 --function-name "$VERSION_ARN"
echo "role      $ROLE_ARN"
echo "function  $VERSION_ARN"
echo "secrets   $ARN_SESSION"
echo "          $ARN_CONFIG"

# ---------- log retention (only groups that exist; a failure here only warns) ----------
for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
  for g in "/aws/lambda/us-east-1.$FN" "/aws/lambda/$FN"; do
    [ "$g" = "/aws/lambda/$FN" ] && [ "$r" != us-east-1 ] && continue
    if ! cur=$(aws logs describe-log-groups --region "$r" --log-group-name-prefix "$g" \
        --query "logGroups[?logGroupName=='$g'].[logGroupName,retentionInDays]" --output text 2>/dev/null); then
      echo "warning: could not read log groups in $r" >&2; continue
    fi
    [ -n "$cur" ] || continue
    if [ "$(echo "$cur" | cut -f2)" = "$LOG_RETENTION_DAYS" ]; then
      echo "logs      $r $g: ${LOG_RETENTION_DAYS}d"
    elif aws logs put-retention-policy --region "$r" --log-group-name "$g" --retention-in-days "$LOG_RETENTION_DAYS"; then
      echo "logs      $r $g: retention set to ${LOG_RETENTION_DAYS}d"
    else
      echo "warning: could not set retention on $r $g" >&2
    fi
  done
done

[ "$DIST_UPDATE" = 1 ] || exit 0

# ---------- response headers policy (replaces the viewer-response CloudFront Function) ----------
cat > "$TMP/headers.json" <<EOF
{"Name":"$HEADERS_POLICY","Comment":"Same headers as CloudFront Function gtm-preview-headers-db5553a4, plus HSTS",
 "SecurityHeadersConfig":{"ContentTypeOptions":{"Override":true},"ReferrerPolicy":{"ReferrerPolicy":"no-referrer","Override":true},
   "StrictTransportSecurity":{"AccessControlMaxAgeSec":31536000,"IncludeSubdomains":false,"Preload":false,"Override":true}},
 "CustomHeadersConfig":{"Quantity":2,"Items":[
   {"Header":"X-Robots-Tag","Value":"noindex, nofollow","Override":true},
   {"Header":"Cache-Control","Value":"private, no-store","Override":true}]}}
EOF
POLICY_ID=$(aws cloudfront list-response-headers-policies --type custom \
  --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='$HEADERS_POLICY'].ResponseHeadersPolicy.Id | [0]" --output text)
if [ -z "$POLICY_ID" ] || [ "$POLICY_ID" = None ]; then
  POLICY_ID=$(aws cloudfront create-response-headers-policy --response-headers-policy-config "file://$TMP/headers.json" --query ResponseHeadersPolicy.Id --output text)
  echo "created response headers policy $HEADERS_POLICY ($POLICY_ID)"
else
  aws cloudfront get-response-headers-policy-config --id "$POLICY_ID" --query ResponseHeadersPolicyConfig > "$TMP/headers-now.json"
  # CloudFront echoes unset security headers back as {}; drop those before comparing.
  if ! jq -S 'del(..|select(. == {}))' "$TMP/headers-now.json" | cmp -s - <(jq -S . "$TMP/headers.json"); then
    PET=$(aws cloudfront get-response-headers-policy-config --id "$POLICY_ID" --query ETag --output text)
    aws cloudfront update-response-headers-policy --id "$POLICY_ID" --if-match "$PET" --response-headers-policy-config "file://$TMP/headers.json" >/dev/null
    echo "updated response headers policy $HEADERS_POLICY ($POLICY_ID)"
  fi
fi
echo "headers   response headers policy $POLICY_ID"

# ---------- distribution: Lambda on viewer-request, CloudFront Functions off, headers policy on ----------
aws cloudfront get-distribution-config --id "$DIST" > "$TMP/dist.json"
ETAG=$(jq -r .ETag "$TMP/dist.json")
jq --arg v "$VERSION_ARN" --arg p "$POLICY_ID" '.DistributionConfig
  | .DefaultCacheBehavior.LambdaFunctionAssociations = {Quantity: 1, Items: [{LambdaFunctionARN: $v, EventType: "viewer-request", IncludeBody: false}]}
  | .DefaultCacheBehavior.FunctionAssociations = {Quantity: 0}
  | .DefaultCacheBehavior.ResponseHeadersPolicyId = $p' \
  "$TMP/dist.json" > "$TMP/new.json"
if jq -S .DistributionConfig "$TMP/dist.json" | cmp -s - <(jq -S . "$TMP/new.json"); then
  echo "distribution $DIST already uses $VERSION_ARN"
else
  aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config "file://$TMP/new.json" \
    --query 'Distribution.{Status:Status,LastModified:LastModifiedTime}' --output text
  echo "distribution $DIST updated: viewer-request -> $VERSION_ARN"
fi
if [ "$WAIT" = 1 ]; then
  echo "waiting for $DIST to be Deployed (typically 3-10 min)..."
  aws cloudfront wait distribution-deployed --id "$DIST"
  echo "distribution $DIST Deployed"
fi
