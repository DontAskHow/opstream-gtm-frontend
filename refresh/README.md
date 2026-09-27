# GTM refresh

The dashboard on Elastic Beanstalk keeps serving the last good `out/data`. This job builds a new collection and publishes it to S3. The server reads `refresh-config.json` from the bundle (not an environment property) and, every 10 minutes, swaps in `published/LATEST.json` when that run validates.

Bucket: `opstream-gtm-data-080403790510` in `us-east-2`, account `080403790510`.

## What the container does

1. Download `data/brain/brain.db` and operator state from `state/`.
2. Run each sync script in `code/brain-sync/` whose secret exists. A missing secret is a logged warning and that script is skipped. `common.py` `get_surrogate` reads Secrets Manager (`opstream-gtm/<name>`), not a vault CLI.
3. Upload `brain.db` back only when a sync actually succeeded.
4. Run `brain-data.py`, `sheet-review.py`, `align-run.py` (which runs `hollie-operator.py` and writes one run id). If `openai-api-key` exists, `agent-brief.py` and `heartbeat.py` call OpenAI directly with `gpt-6-luna`. Then esbuild bundles `evidence-renderer.mjs`.
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

### 1. Secrets Manager

Console → Secrets Manager → Store a new secret → Other type of secret → Plaintext.

Create these only when you have the credential. The job skips a sync until the secret exists. `openai-api-key` is already there.

| Secret name | Plaintext |
| --- | --- |
| `opstream-gtm/google-sheets-credential` | the Google service-account JSON |
| `opstream-gtm/hubspot-token` | the HubSpot private app token |
| `opstream-gtm/fathom-token` | the Fathom API token |
| `opstream-gtm/lemlist-api-key` | the Lemlist API key |
| `opstream-gtm/otterly-token` | the Otterly token |
| `opstream-gtm/ga4-credential` | the GA4 service-account JSON |

Leave the encryption key as the default `aws/secretsmanager` key.

### 2. CloudShell: deploy the stack

This creates the ECR repository. The first task run waits until step 3 has pushed an image.

```bash
git clone https://github.com/DontAskHow/opstream-gtm-frontend.git
cd opstream-gtm-frontend
git checkout v6-live-source
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region us-east-2)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text --region us-east-2 | tr '\t' ',')
aws cloudformation deploy \
  --region us-east-2 \
  --stack-name opstream-gtm-refresh \
  --template-file infra/gtm-refresh.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ImageTag=latest VpcId=$VPC PublicSubnetIds=$SUBNETS
```

`PublicSubnetIds` is a comma-separated list. `aws cloudformation deploy` accepts that for `List<AWS::EC2::Subnet::Id>`.

### 3. CloudShell: build and push the image

Stay in the clone from step 2.

```bash
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 080403790510.dkr.ecr.us-east-2.amazonaws.com
docker build -f refresh/Dockerfile -t opstream-gtm-refresh .
docker tag opstream-gtm-refresh:latest 080403790510.dkr.ecr.us-east-2.amazonaws.com/opstream-gtm-refresh:latest
docker push 080403790510.dkr.ecr.us-east-2.amazonaws.com/opstream-gtm-refresh:latest
```

CloudShell's Docker disk is small. If the build fails for space, use the CloudShell Actions menu to increase storage, or build on a laptop and push with the same commands.

### 4. Attach the dashboard policy

The stack output `EbPolicyArn` is a managed policy. Console → IAM → Roles → `aws-elasticbeanstalk-ec2-role` → Add permissions → Attach policies → `opstream-gtm-eb-published-read`.

That role can then read `published/*` and read/write `state/*`. Do not add environment properties on the Beanstalk environment. The bucket name is already in `refresh-config.json` inside the application zip.

### 5. Run it once

Console → ECS → Clusters → `opstream-gtm-refresh` → Run new task → Launch type Fargate → Task definition `opstream-gtm-refresh` → the public subnets → turn on Public IP → the security group the stack created.

Or CloudShell:

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region us-east-2)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text --region us-east-2 | tr '\t' ',')
SG=$(aws cloudformation describe-stack-resources --stack-name opstream-gtm-refresh --region us-east-2 --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup'].PhysicalResourceId" --output text)
aws ecs run-task --region us-east-2 --cluster opstream-gtm-refresh --launch-type FARGATE \
  --task-definition opstream-gtm-refresh \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}"
```

Logs: CloudWatch → Log groups → `/opstream/gtm-refresh`.

A failed task publishes a message to the SNS topic `opstream-gtm-refresh-failures`. No email is subscribed. Add an email subscription later in the SNS console if you want one.

### 6. Confirm the pointer

```bash
aws s3 cp s3://opstream-gtm-data-080403790510/published/LATEST.json -
```

Within 10 minutes the Beanstalk app swaps to that run. If the object is corrupt, the app keeps serving the previous files.

## Local filesystem test

```bash
node scripts/check-refresh.mjs
```

That runs the entrypoint with `REFRESH_MODE=fs` against a small SQLite file, checks that a missing `brain.db` exits non-zero without moving `LATEST.json`, and checks that the server swap keeps the last good copy when a publish is corrupt.
