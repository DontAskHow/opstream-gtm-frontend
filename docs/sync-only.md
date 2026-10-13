# Sync-only refresh (every 15 minutes)

`SYNC_ONLY=1 python3 refresh/run.py` keeps the dashboard's source data fresh
between the 6-hourly full refresh runs without calling OpenAI.

## What a sync-only run does

1. Exits at once inside `SYNC_SKIP_WINDOWS` (default `0,6,12,18:10-29`,
   America/Phoenix), the minutes around the 6-hourly run at :17.
2. Takes the S3 lock `locks/sync-only.json` (conditional create,
   `If-None-Match: *`). A lock younger than `SYNC_LOCK_TTL_MIN` (default 50)
   means another sync-only run is still going, so this one exits 0.
3. Reads `published/LATEST.json`, then streams `brain.db` and keeps its ETag.
4. Runs the source syncs: sheets, hubspot, fathom, ga4, lemlist
   (`SYNC_ONLY_SOURCES`). Otterly is left to the 6-hourly run. Its API
   allowance is monthly, and it already skips itself above 50 %.
5. Uploads `brain.db` only if its sha256 changed, with `If-Match` on the ETag
   from step 3. If another writer replaced it in the meantime, the run uploads
   nothing, publishes nothing, and exits 0. The next run starts from the newer
   copy.
6. Runs `brain-data.py`, `sheet-review.py`, `align-run.py`, `term_scrub.py`,
   and the renderer, with `GTM_FACTS_ONLY=1`. It never runs `agent-brief.py`
   or `heartbeat.py`, never reads `opstream-gtm/openai-api-key`, never builds
   per-user briefs, and writes nothing under `state/`. The state files are
   restored as read-only inputs.
7. Carries the AI narrative forward from the LATEST run:
   `agent-brief.json`, `heartbeat.json`, and `heartbeat-fixes.json`, the
   three files `agent-brief.py` and `heartbeat.py` write. Their `runId` is set
   to this build's `hollie.json` run id, because `data-bindings.js` hides the
   brief when the ids differ. `generatedAt` and `model` stay as the AI run
   wrote them, and `carriedFrom` names the source run. Facts-only copies are
   not carried; the fresh ones from `align-run.py` are kept.
8. Hashes the output tree with volatile fields removed: `generatedAt`,
   `runId`, `collectedAt`, `fetchedAt`, `capturedAt`, per-source `at` and
   `lastOkAt`, and the per-run counters in a successful source's `detail`.
   Facts-only AI files are skipped. If the hash matches LATEST
   (`contentHash` when a sync-only run published it, otherwise the hash of
   the published files), the run logs `no change` and publishes nothing.
9. Otherwise it publishes `published/<runId>/` the same way the full run
   does. Before writing `LATEST.json` it re-reads it and writes with
   `If-Match`, so a 6-hourly publish that lands meanwhile wins. LATEST gets
   `"mode": "sync-only"`, `contentHash`, and `aiFrom`, the AI run the
   narrative came from. Prune keeps 10 runs (`SYNC_KEEP_RUNS`) and never
   deletes the new run or the run it copied from. The carried files are
   copied before pruning.
10. Exit codes: 0 for a publish, `no change`, the lock held, or a skip window.
    4 when a source sync failed or `live_deals.json` could not be written (the
    run still publishes the rest). Any
    other non-zero code means a build step failed and nothing was published.

## HubSpot deal export (`live_deals.json`)

Both modes write `live_deals.json` into the snapshot from brain.db, with no
HubSpot call:
`{fetchedAt, pipes: {pipelineId: label}, stages: {stageId: {pipe, label, closed, prob}}, deals: [{id, properties}]}`.
The deal properties are amount, closedate, createdate, dealname, dealstage,
hs_deal_stage_probability, hs_forecast_probability, hs_is_closed,
hs_is_closed_won, hubspot_owner_id, and pipeline. hs_lastmodifieddate is
left out so the file only changes when deal data does. `fetchedAt` is the
last good HubSpot sync. The preview Lambda `gtm-preview-refresh` finds the
file by this shape.

- Stage `closed` and `prob` come from `hubspot_pipelines.is_closed` and
  `probability`. `hubspot_sync.py` stores them from the
  `GET /crm/v3/pipelines/deals` call it already makes.
- Older sync code rewrites that table without those columns. When they are
  NULL, the stages are taken from the previous snapshot's export. With no
  previous export either, the file is not written and the run exits 4.
- hs_forecast_probability, hs_is_closed, and hs_is_closed_won are now
  fetched with deals. Deals stored before that get them once from a paged
  search (about 6 calls), with no association refresh and no watermark
  change.
- Deals archived in HubSpot are not tracked, so a deal stays in the export
  until the sync sees it change.

## GA4

Every runReport sends `returnPropertyQuota: true` and logs tokens consumed
and remaining (numbers only). A pull is skipped, with nothing recorded and
no token minted, when the last good pull is under `GA4_MIN_INTERVAL_MIN`
minutes old (default 60, 0 disables). GA4 data is daily-granular.

Standard-property core quotas
(https://developers.google.com/analytics/devguides/reporting/data/v1/quotas):
200,000 tokens per property per day, 40,000 per property per hour, 14,000
per project per property per hour, 10 concurrent requests, 10 server errors
per project per property per hour, and 120 potentially thresholded requests
per hour.

## HubSpot pacing

CRM search is limited to 5 requests per second, apart from the 110 requests
per 10 seconds an installed public app gets. The old 0.12 s pacing sent
searches at about 8 per second, and that caused the `SECONDLY` 429s.
Searches now run at 4 per second, other calls at about 6.7 per second, and a
429 is retried after 1, 2, 4, 8, and 10 s.

## Infrastructure

`infra/gtm-sync/setup.sh` creates the `opstream-gtm-sync` task definition
family, the `opstream-gtm-sync` cluster, the `opstream-gtm-sync-scheduler`
role, the three schedules, and the failure rule. It does not touch the
6-hourly job.

The SNS topic needs a statement that allows `events.amazonaws.com` to
`sns:Publish`, conditioned on the rule ARNs.
