# GTM preview refresh (`gtm-preview-refresh`)

Every 15 minutes this Lambda rebuilds the private preview's `data.js` from the newest published snapshot and uploads it only when the content changed. It calls no AI and no provider API, and it reads no secrets. The sync-only `opstream-gtm-refresh` job publishes the snapshot: it syncs HubSpot, Sheets, GA4, lemlist and Fathom into `s3://opstream-gtm-data-080403790510/published/<runId>/` and moves `published/LATEST.json`.

```
EventBridge Scheduler gtm-preview-refresh-15m (rate 15 min, no flex window, 0 retries)
  -> Lambda gtm-preview-refresh (nodejs20.x arm64, 512 MB, 120 s, reserved concurrency 1, async retries 0)
       read  s3://opstream-gtm-data-080403790510/published/LATEST.json + that run's top-level JSON (read-only)
       build workspace/lib/project.mjs buildData(), the same code as workspace/build.mjs
       put   s3://opstream-gtm-preview-db5553a4/data.js       only when sha256(content) changed
       put   s3://opstream-gtm-preview-db5553a4/refresh.json  every successful check
       put   s3://opstream-gtm-preview-db5553a4/workspace.json  the run's workspace.json, checked, only when its content changed
       on problems / errors -> SNS opstream-gtm-refresh-failures; Errors alarm gtm-preview-refresh-errors -> same topic
```

## What the page gets

- **HubSpot per-deal fields** (amount, stage, closed status, pipeline, and the deal list itself) come from the snapshot's HubSpot deal export. The function finds it by shape, not by name: a top-level JSON with `pipes`, `stages` and `deals[].properties`, the `live_deals.json` shape `workspace/README.md` describes. `fetchedAt` (or `generatedAt`) is its HubSpot time. If the snapshot has no such file, the page falls back to `records.json` and labels it **unreconciled**. In that case pipelines can't be split and HubSpot-only deals are missing, and the function alarms (`snapshot-has-no-hubspot-export`) once.
- **Sheet and GA4 fields** (the master Sheet's deal rows, budget, show calendar, ad exports) are shown "as of <snapshot time>". The data-quality panel compares HubSpot against the Sheet as of the snapshot.
- **Header**: "Last refreshed <time PT>" from `/refresh.json` (fetched with `no-store`; falls back to `data.js` `refreshedAt`), then "data changed …" and "snapshot …". It turns amber when the last check is more than 45 minutes old.

## workspace.json (the one-page workspace)

The sync job writes `workspace.json` (scripts/workspace-data.py) into each published run. Every run, `workspace-json.mjs`:

- **checks** it: valid JSON, `schemaVersion` 1, `headline.open` present, `meta.generatedAt` present, ≤ 3 MB, and no scrub pattern (from the function's `WORKSPACE_SCRUB_PATTERNS`, set by `deploy.sh`; patterns are never logged or sent in alarms).
- **copies** it to the preview bucket (`no-store`, `x-amz-meta-sha256`) only when the sha256 of its content without timestamps (the sync job's volatile keys) differs from the last copied one. Unchanged content uploads nothing; `refresh.json.workspace.stamps` carries the newer timestamps, which the page applies.
- **keeps the last good copy** when the run has no `workspace.json` (`snapshot-has-no-workspace-json`), the file fails a check (`workspace-json-invalid`), or the function has no scrub patterns (`workspace-scrub-patterns-missing`). Each alarms once when it starts and once when it clears (no daily reminder), and the page shows "Showing the last good data: …".

`refresh.json.workspace` holds `status` (`uploaded` / `unchanged` / `kept-last-good`), `problem`, `errors`, `sha256`, `publishedSha256`, `publishedGeneratedAt`, `publishedRunId`, `checkedAt` and `stamps`. The step runs before the `data.js` build, so a problem there never holds it back.

## Change detection (why `data.js` isn't uploaded every run)

`compose.mjs` builds the data object, then swaps every value that only says *when* something was fetched or published for a placeholder before hashing. That covers the source times (`times.*`), each source's `at`/`lastOkAt`, the Sheet time, the snapshot run id and publish time, and the check time. The sha256 therefore covers content only. A re-sync that brings identical data under new timestamps uploads nothing.

- Changed: placeholders are filled with the real values and `data.js` is uploaded with `x-amz-meta-sha256`, `Cache-Control: no-store`, `refreshedAt` and `dataChangedAt`.
- Unchanged: only `refresh.json` is written. It holds `refreshedAt`, `dataChangedAt`, `dataSha256`, the current snapshot id and publish time, and `stamps` (the current values of those timestamps). The page applies `stamps` over `data.js`, so the "Updated …" labels stay current without re-uploading 900 KB.
- The stored hash is `refresh.json.dataSha256`. Delete `refresh.json` to force the next run to upload.

## Alarms

The function publishes to `opstream-gtm-refresh-failures` when its set of problems changes (and once when they clear). While a problem continues, it publishes again once a day. The problems are `snapshot-stale` (LATEST.json older than `SNAPSHOT_STALE_MINUTES`, default 60) and `snapshot-has-no-hubspot-export`. Any exception publishes the error text and fails the invocation. The CloudWatch alarm `gtm-preview-refresh-errors` (Errors ≥ 1 in 15 min) also notifies the topic. **The topic has no subscriptions today**, so add one (for example an email) to actually receive these.

## CloudFront invalidation: not used

Distribution `EZQ1E2Y6O6NDG` has one behavior (the default, no additional behaviors), and it uses cache policy `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` = `Managed-CachingDisabled` (min/default/max TTL 0). Every request goes to S3, so an invalidation would do nothing and would cost money above 1,000 paths a month. The role has no `cloudfront:*` permission. If a caching policy is ever added, invalidate only `/data.js` (and `/refresh.json`) and grant `cloudfront:CreateInvalidation` on that distribution only.

## IAM (`gtm-preview-refresh-role`, one inline policy)

| Action | Resource |
|---|---|
| `logs:CreateLogStream`, `logs:PutLogEvents` | `/aws/lambda/gtm-preview-refresh` only (the log group is created by `deploy.sh`, 14-day retention) |
| `s3:ListBucket` (prefix `published/*`), `s3:GetObject` | `opstream-gtm-data-080403790510/published/*`, read-only |
| `s3:GetObject`, `s3:PutObject` | `opstream-gtm-preview-db5553a4/data.js`, `/refresh.json`, `/workspace.json` and `/_state/hubspot-live.json` only |
| `s3:ListBucket` | the preview bucket, so a missing `refresh.json` reads as 404 rather than 403 |
| `sns:Publish` | `opstream-gtm-refresh-failures` |

There is no Secrets Manager or CloudFront permission. `gtm-preview-refresh-scheduler` can only call `lambda:InvokeFunction` on this function.

## Deploy, off switch, teardown

```sh
workspace/refresh/deploy.sh             # idempotent: roles, log group, function, alarm, schedule, page files; keeps the schedule's state
workspace/refresh/deploy.sh --enable    # ... and enable the schedule
workspace/refresh/deploy.sh --disabled  # ... and create/leave it DISABLED
WORKSPACE_SCRUB_PATTERNS_FILE=… workspace/refresh/deploy.sh --onepage-app   # serve the one-page workspace (see onepage/README.md)
workspace/refresh/gtm-preview-refresh-off.sh        # off switch (get-schedule, then update-schedule with State DISABLED)
ON=1 workspace/refresh/gtm-preview-refresh-off.sh   # back on
aws lambda invoke --profile opstream-deploy --region us-east-2 --function-name gtm-preview-refresh --payload '{"dryRun":true}' /tmp/out.json   # read-only check
```

`deploy.sh` also uploads the page's code (`index.html`, `app.js`, `styles.css`, `vendor/gtm-charts.js`, `vendor/insights.js`, `vendor/lost-reasons.js`) unless you pass `--no-app`. Neither the function nor `deploy.sh` writes `insights.json` or `lost-reasons.json`; the Strategy seat publishes those (`publish-insights.mjs`, `publish-lost-reasons.mjs`). `/workspace/gtm-preview-teardown.sh` deletes the schedule, alarm, function, log group and both roles before it removes the distribution and bucket.

## LIVE_PULL (off, not granted)

`sources.mjs` can pull HubSpot (OAuth refresh in memory only; GET-only guard; portal check; never writes the secret back), lemlist and Fathom directly. That code runs only when `LIVE_PULL=1`. The deployed function sets `LIVE_PULL=0`, and its role has no `secretsmanager:GetSecretValue`, so turning it on without changing IAM fails. It stays for the case where the sync job can't run. Turning it on needs `HUBSPOT_PORTAL_ID` (the expected portal, checked on every call), `secretsmanager:GetSecretValue` on `opstream-gtm/hubspot-oauth`, `opstream-gtm/lemlist-token` and `opstream-gtm/fathom-token`, plus get/put on `_state/*`. It never touches Google.

## Transcripts

`data.js` lists the transcripts that `records.json` links to and the snapshot has. The function never uploads transcript files. A transcript newer than the preview's last full upload shows "The transcript file is missing from this build" until the transcripts are copied.

## Cost (us-east-2, 2,976 runs a month)

Measured: about 3.6–4.2 s and 150–160 MB when a new snapshot must be read (cold or new run id), and about 0.25 s when the snapshot is already cached. The worst case assumes every run reads a new snapshot.

| Item | Math | $/month |
|---|---|---|
| Lambda requests | 2,976 × $0.20/1M | 0.0006 |
| Lambda compute (arm64) | 2,976 × 4.2 s × 0.5 GB = 6,250 GB-s × $0.0000133334 | 0.083 (0 inside the free tier) |
| S3 GET | ≤ 15 a run (LATEST, refresh.json, ~13 snapshot files) × 2,976 = 44,640 × $0.0004/1k | 0.018 |
| S3 PUT/LIST | ≤ 3 a run (LIST, refresh.json, data.js when changed) × 2,976 = 8,928 × $0.005/1k | 0.045 |
| Secrets Manager | 0 calls | 0 |
| CloudWatch Logs | ~0.7 KB a run ≈ 2 MB × $0.50/GB, 14-day retention | 0.001 |
| CloudWatch alarm | 1 standard alarm | 0.10 |
| SNS | a few publishes, no subscribers | 0 |
| EventBridge Scheduler | 2,976 invocations (14M free) | 0 |
| CloudFront invalidations | none (CachingDisabled) | 0 |
| **Total** | | **≈ $0.25** (≈ $0.17 with the Lambda free tier) |
