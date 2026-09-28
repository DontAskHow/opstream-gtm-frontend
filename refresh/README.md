# GTM refresh

The dashboard on Elastic Beanstalk keeps serving the last good `out/data`. This job builds a new collection and publishes it to S3. The server reads `refresh-config.json` from the bundle (not an environment property) and, every 10 minutes, swaps in `published/LATEST.json` when that run validates.

Bucket: `opstream-gtm-data-080403790510` in `us-east-2`, account `080403790510`.

## What the container does

1. Download `data/brain/brain.db` and operator state from `state/`.
2. Run the vendored scripts in `refresh/brain-sync/` (`sheets_sync.py`, `hubspot_sync.py`, `fathom_sync.py`, `ga4_sync.py`, `lemlist_sync.py`, `otterly_sync.py`). These are the canonical syncs. `common.py` reads Secrets Manager (`opstream-gtm/<name>`) instead of the vault CLI. A missing secret is a logged warning (`skipping <script> because secret opstream-gtm/<name> is not present`) and that script is skipped. Sheets and GA4 both use `opstream-gtm/google-sheets-refresh-token` plus the OAuth client id and secret. A script that starts and exits 3 is logged (`needs a connection (exit 3)`) and skipped; the existing snapshot is still published. Exit 1 publishes nothing. The job then prints `sync summary: ran …` and `sync summary: skipped …`. The container does not download `code/brain-sync/` from S3 over these copies.
3. Upload `brain.db` back only when a sync actually succeeded. If every sync was skipped, the database already in the bucket is left unchanged and the build continues.
4. Run the same chain the 6-hour dashboard job described: `brain-data.py`, then `sheet-review.py`, then `align-run.py` (which runs `hollie-operator.py` and writes one run id, `run-YYYY-MM-DD-HHMMSS` in UTC). If `openai-api-key` exists, `agent-brief.py` and `heartbeat.py` call OpenAI directly with `gpt-6-luna`. Then esbuild bundles `evidence-renderer.mjs`. The container does not restart Elastic Beanstalk and does not send a chat message. The Monday operator review stays a separate weekly pass; it is not a second scheduler here. The old schedules are copied in `refresh/crons/`.
5. If `brain.db` is missing, or the snapshot id is synthetic, the process exits non-zero and does not write `published/LATEST.json`.
6. On success, upload `out/data` to `published/<run-id>/` and then write `published/LATEST.json`. Older runs are deleted after 10.

## Monthly cost (target at or under $5)

Prices are us-east-2 on-demand, checked against the public Fargate and CloudWatch price list as of 2026.

| Piece | Assumption | About |
| --- | --- | --- |
| Fargate 0.5 vCPU and 2 GB | 4 runs/day, 20 minutes each | $1.20 |
| Public IPv4 while the task runs | same 40 minutes/day, no NAT gateway | $0.10 |
| Ephemeral disk | default 20 GB (the 290 MB database fits) | $0 |
| CloudWatch Logs, 14-day retention | a few MB a day | $0.30 |
| ECR | one image | $0.10 |
| EventBridge Scheduler, SNS with no subscription | | under $0.05 |

About **$1.70 a month**. There is no NAT gateway and no email subscription. A NAT gateway alone would pass $30.

## Console and CloudShell, in order

Do these in account `080403790510`, region **US East (Ohio)**.

### 1. Google authorization and other secrets

Sheets and GA4 use the owner's Google account (`zackkaufman39@gmail.com`), which already has the tracked spreadsheets and GA4 property `304508954`. There is no service account.

The OAuth client is already in Secrets Manager, the same client the dashboard's Gmail connect uses:

- `opstream-gtm/google-oauth-client-id`
- `opstream-gtm/google-oauth-client-secret`

One-time connect, after the dashboard is deployed and the Beanstalk role has the policy from step 5. Open:

`https://<dashboard-host>/admin/connect-sheets`

Google asks for read-only scopes `spreadsheets.readonly`, `drive.metadata.readonly`, and `analytics.readonly`, plus `openid` and `userinfo.email` so the success page can name the account. The request sets `access_type=offline` and `prompt=consent`. The callback is the Gmail path that is already registered, with a `sheets:` state this server issued:

`https://<dashboard-host>/api/gmail/oauth/callback`

In Google Cloud console, project `opstream-marketing-dashboard`, that exact redirect URI must be on this OAuth client. If the dashboard host is not listed, add that URI. Do not add a second callback path. The server's example public base is `https://d1l47t29dh34cq.cloudfront.net`, so the connect URL there is `https://d1l47t29dh34cq.cloudfront.net/admin/connect-sheets` and the redirect URI is `https://d1l47t29dh34cq.cloudfront.net/api/gmail/oauth/callback`. If the live host differs, use that host with these same paths. `OAUTH_PUBLIC_BASE_URL`, when it is already set, picks the host. This setup does not add environment properties.

The callback stores the refresh token as `opstream-gtm/google-sheets-refresh-token` (create, or a new version). It is not logged and it is not written to disk or S3. The browser shows a plain page with the email that authorized.

Create the other secrets only when you have the credential (Console → Secrets Manager → Other type of secret → Plaintext). The job skips a sync until the secret exists. `openai-api-key` is already there. GA4 uses the Google refresh token above. There is no `ga4-credential` secret and no `lemlist-api-key` secret.

| Secret name | Plaintext |
| --- | --- |
| `opstream-gtm/google-sheets-refresh-token` | written by `/admin/connect-sheets` |
| `opstream-gtm/hubspot-oauth` | JSON for the existing Marketing Dashboard app: portal_id `21303277`, client_id, client_secret, refresh_token, token_endpoint `https://api.hubapi.com/oauth/2026-03/token`, api_base `https://api.hubapi.com`. Already in Secrets Manager. Do not create another app. |
| `opstream-gtm/fathom-token` | Fathom API token |
| `opstream-gtm/lemlist-token` | Lemlist API key |
| `opstream-gtm/otterly-token` | Otterly token |

Leave the encryption key as the default `aws/secretsmanager` key.

CloudShell cannot build this image reliably, and there is no local Docker. The stack includes a CodeBuild project that builds `refresh/Dockerfile` from a source zip in S3 and pushes it to the ECR repository the stack creates. The task uses the default VPC, public subnets, and a public IP for egress. There is no NAT gateway.

### 2. CloudShell: upload the source zip

In CloudShell, Actions → Upload file, and choose `refresh-src-v14.zip`. Then:

```bash
aws s3 cp refresh-src-v14.zip s3://opstream-gtm-data-080403790510/code/refresh-src/v14.zip --region us-east-2
```

The object key must match the `SourceKey` parameter (`code/refresh-src/v14.zip` unless you change it). The zip root must contain `refresh/Dockerfile`, not a parent folder.

### 3. CloudShell: deploy the stack

Upload `gtm-refresh.yaml` the same way (it is in the infra zip).

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region us-east-2)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text --region us-east-2 | tr '\t' ',')
aws cloudformation deploy \
  --region us-east-2 \
  --stack-name opstream-gtm-refresh \
  --template-file gtm-refresh.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ImageTag=latest SourceKey=code/refresh-src/v14.zip VpcId=$VPC PublicSubnetIds=$SUBNETS
```

`PublicSubnetIds` is a comma-separated list. `aws cloudformation deploy` accepts that for `List<AWS::EC2::Subnet::Id>`.

### 4. CloudShell: build the image in CodeBuild and wait

```bash
BUILD_ID=$(aws codebuild start-build --region us-east-2 --project-name opstream-gtm-refresh --query 'build.id' --output text)
echo "$BUILD_ID"
while true; do
  STATUS=$(aws codebuild batch-get-builds --region us-east-2 --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)
  echo "$STATUS"
  case "$STATUS" in
    SUCCEEDED) break ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "build failed"; exit 1 ;;
  esac
  sleep 20
done
```

Logs: CloudWatch → Log groups → `/aws/codebuild/opstream-gtm-refresh`. The project reads `s3://opstream-gtm-data-080403790510/code/refresh-src/v14.zip`, runs `docker build -f refresh/Dockerfile`, and pushes `latest` to the ECR repository the stack created. CodeBuild is not placed in the VPC, so it can reach Docker Hub and ECR.

### 5. Attach the dashboard policy

The stack output `EbPolicyArn` is the managed policy. Look up the instance role from the Elastic Beanstalk environment `opstream-gtm-prod` and attach it:

```bash
APP=$(aws elasticbeanstalk describe-environments --region us-east-2 --environment-names opstream-gtm-prod --query 'Environments[0].ApplicationName' --output text)
PROFILE=$(aws elasticbeanstalk describe-configuration-settings --region us-east-2 --application-name "$APP" --environment-name opstream-gtm-prod --query "ConfigurationSettings[0].OptionSettings[?Namespace=='aws:autoscaling:launchconfiguration' && OptionName=='IamInstanceProfile'].Value | [0]" --output text)
ROLE=$(aws iam get-instance-profile --instance-profile-name "$PROFILE" --query 'InstanceProfile.Roles[0].RoleName' --output text)
POLICY=$(aws cloudformation describe-stacks --region us-east-2 --stack-name opstream-gtm-refresh --query "Stacks[0].Outputs[?OutputKey=='EbPolicyArn'].OutputValue" --output text)
echo "role $ROLE"
echo "policy $POLICY"
aws iam attach-role-policy --role-name "$ROLE" --policy-arn "$POLICY"
```

That role can then read `published/*`, read and write `state/*` (including each person's brief at `state/users/<hash>/`), read `opstream-gtm/google-oauth-client-id` and `opstream-gtm/google-oauth-client-secret`, create or update `opstream-gtm/google-sheets-refresh-token`, and get, describe, create, or put `opstream-gtm/users/*`. The Fargate task role has `secretsmanager:GetSecretValue` and `DescribeSecret` on `arn:aws:secretsmanager:us-east-2:080403790510:secret:opstream-gtm/*`, plus `secretsmanager:ListSecrets` so the 6-hour job can find those user secrets. `PutSecretValue` on the task role is only on `arn:aws:secretsmanager:us-east-2:080403790510:secret:opstream-gtm/hubspot-oauth-*`, so a rotated HubSpot refresh token is written back to that secret. Do not add environment properties on the Beanstalk environment. The allow list and the bucket name are in `refresh-config.json` inside the application zip.

If the managed policy is already attached, this one CloudShell command updates it in place (previous VPC and subnet parameters stay):

```bash
aws cloudformation deploy \
  --region us-east-2 \
  --stack-name opstream-gtm-refresh \
  --template-file gtm-refresh.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides SourceKey=code/refresh-src/v14.zip
```

### 6. Run the task once

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region us-east-2)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text --region us-east-2 | tr '\t' ',')
SG=$(aws cloudformation describe-stacks --region us-east-2 --stack-name opstream-gtm-refresh --query "Stacks[0].Outputs[?OutputKey=='TaskSecurityGroupId'].OutputValue" --output text)
CLUSTER=$(aws cloudformation describe-stacks --region us-east-2 --stack-name opstream-gtm-refresh --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" --output text)
aws ecs run-task --region us-east-2 --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition opstream-gtm-refresh \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}"
```

Logs: CloudWatch → Log groups → `/opstream/gtm-refresh`.

A failed task publishes a message to the SNS topic `opstream-gtm-refresh-failures`. No email is subscribed. Add an email subscription later in the SNS console if you want one.

### 7. Confirm the pointer

```bash
aws s3 cp s3://opstream-gtm-data-080403790510/published/LATEST.json -
```

Within 10 minutes the Beanstalk app swaps to that run. If the object is corrupt, the app keeps serving the previous files.

## Local filesystem test

```bash
node scripts/check-refresh.mjs
```

That runs the entrypoint with `REFRESH_MODE=fs` against a small SQLite file, checks that a missing `brain.db` exits non-zero without moving `LATEST.json`, and checks that the server swap keeps the last good copy when a publish is corrupt.
