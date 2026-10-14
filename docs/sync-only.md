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
   restored as read-only inputs. Before `term_scrub.py` it writes
   `live_deals.json` and `workspace.json` (both below).
7. Carries the AI narrative forward from the LATEST run:
   `agent-brief.json`, `heartbeat.json`, and `heartbeat-fixes.json`, the
   three files `agent-brief.py` and `heartbeat.py` write. Their `runId` is set
   to this build's `hollie.json` run id, because `data-bindings.js` hides the
   brief when the ids differ. `generatedAt` and `model` stay as the AI run
   wrote them, and `carriedFrom` names the source run. Facts-only copies are
   not carried; the fresh ones from `align-run.py` are kept.
   Until `:latest` is rebuilt, the 6-hourly job counts the open book from
   the Sheet's active rows, so these carried files (and each 6-hourly
   publish, until the next sync-only run) can show a different open count
   than `workspace.json` and `align-run.py`, which use the HubSpot Sales
   Pipeline.
8. Hashes the output tree with volatile fields removed: `generatedAt`,
   `runId`, `collectedAt`, `fetchedAt`, `capturedAt`, per-source `at` and
   `lastOkAt`, and the per-run counters in a successful source's `detail`.
   Facts-only AI files are skipped, and so is `workspace.json`'s
   `headline.change` (see below). If the hash matches LATEST
   (`contentHash` when a sync-only run published it, otherwise the hash of
   the published files), the run logs `no change` and publishes nothing,
   unless LATEST's `publishedAt` is older than `PUBLISH_MAX_AGE_MIN`
   (default 25; 0 turns it off). Then it logs `republish: unchanged content,
   last publish N min old` and publishes anyway, so the published fetch
   times (`workspace.json` `fresh.*.fetchedAt` among them) keep moving in a
   quiet period: about every 30 minutes at the 15-minute schedule.
9. Otherwise it publishes `published/<runId>/` the same way the full run
   does. Before writing `LATEST.json` it re-reads it and writes with
   `If-Match`, so a 6-hourly publish that lands meanwhile wins. LATEST gets
   `"mode": "sync-only"`, `contentHash`, and `aiFrom`, the AI run the
   narrative came from. Prune keeps 10 runs (`SYNC_KEEP_RUNS`) and never
   deletes the new run or the run it copied from. The carried files are
   copied before pruning.
10. Exit codes: 0 for a publish, `no change`, the lock held, or a skip window.
    4 when a source sync failed or was skipped (needs a connection, secret
    missing), when `live_deals.json` could not be written, or when
    `sheet-review.json` has no `leadTracker` rollup. The run still publishes
    the rest. A missing `workspace.json` does not change the exit code. Any
    other non-zero code means a build step failed and nothing was published.

## HubSpot deal export (`live_deals.json`)

Both modes write `live_deals.json` into the snapshot from brain.db, with no
HubSpot call, in the shape of gtm-ws `scripts/hubspot-recon-export.py` (88ff273):

- `pipes {id: label}` and `stages {id: {pipe, label, closed, prob}}`. `closed` and
  `prob` come from HubSpot pipeline metadata, which `hubspot_sync.py` stores in
  `hubspot_pipelines.is_closed` and `probability`.
- `deals[]` has `id`, `properties`, `createdAt`, `updatedAt`, `archived`, `url`,
  `companyIds` (primary company first), `ownerHistory`, and `derived`.
  - `properties` is dealname, pipeline, dealstage, amount,
    hs_deal_stage_probability, hs_forecast_probability, closedate,
    hubspot_owner_id, hs_is_closed, hs_is_closed_won, createdate,
    hs_lastmodifieddate, closed_lost_reason, and hs_object_id.
  - `ownerHistory` is the `hubspot_owner_id` history, newest first:
    `{value, timestamp, sourceType}`.
  - `derived` is stage, pipeline, amount, probability, weighted, isClosed
    from stage metadata, onHold, and the owner name.
- `companies {id: {name, domain}}` for every associated company, and
  `owners {id: {name, email, archived}}` including archived owners.
- `openBook` sums salesOpen, salesOnHold, and allPipelinesOpen.
- `fetchedAt` (last good HubSpot sync) is an extra key; the preview Lambda reads it.

How `hubspot_sync.py` collects these, paced under the limits above:

- `closed_lost_reason` and the other later deal properties come with the
  incremental deal search. Deals stored before then get them once from a
  paged search (about 6 calls).
- Owners are stored with an `archived` flag.
- Company order and owner history go in `hubspot_deal_extras`. They come from
  two read-only batch endpoints: v4 deal→company associations (100 a call;
  label type 5 = primary) and v3 deals batch read with
  `propertiesWithHistory=hubspot_owner_id,dealstage` (50 a call). The dealstage
  history (`stage_history`, newest first) says which stage a deal was in when a
  meeting was booked. Changed deals, and deals stored before `stage_history`
  existed, are read every run (about 2 calls; the first run after
  `stage_history` was added re-reads every deal once, about 18 calls), all
  deals every `HUBSPOT_EXTRAS_FULL_HOURS` (default 6, about 12 calls for 578
  deals). The read-only guard in
  `common.py` allows only these `…/batch/read` POSTs, CRM search, and
  `POST /crm/v3/lists/search` (a read); every other non-GET is refused.

Older sync code (the 6-hourly job) rewrites `hubspot_pipelines` and
`hubspot_owners` without the new columns. When `closed` metadata is NULL, the
export uses the previous snapshot's stages. With no previous export either,
no file is written and the run exits 4. Deals archived in HubSpot are not
tracked, so a deal stays until the sync sees it change.

## One-page workspace data (`workspace.json`)

Sync-only runs also write `workspace.json`, the data the one-page workspace
fetches, with `scripts/workspace-data.py` (rules in
`shared/workspace-scope.json`, `shared/open-pipeline.json` and
`config/lead-rules.json`, whose `reporting` block holds the Oct 13 2026
reporting rules: customers, free-mail and internal addresses and careers forms
out of the form counts, meeting-link bookings, ad-platform leads and a separate
lead → MQL figure, applied once in the script's scope step and written to added
fields only, so existing `workspace.json` fields keep their meaning). A
booking counts as a customer booking when a contact on it is a customer or a
deal on it is owned by a customer-success owner; a deal in an excluded
pipeline is only dropped, so a booking on it still counts. It reads brain.db and the data files under
`state/gtm-inputs/`, all downloaded each run: `lead-sources.json`,
`lead-source-review.csv`, `paid-deals.json`, `records.jsonl`,
`lead-insights.json`, `lost-reasons.json`, `insights.json`,
`source-overrides.json`, and `scrub-patterns.txt`. Each is optional, and a missing one is logged and that
part of the page degrades. `source-overrides.json` holds human source rulings per deal and lead, so they
survive every refresh (`config/lead-rules.json` `source.overrides`); its `provenance` text is never written
out. The scrub patterns are the exception. Without
them (or `WORKSPACE_SCRUB_PATTERNS` on the task) the script refuses to run.
`--prior` is the LATEST run's `live_deals.json`, for the "what changed" note.

The step never stops a publish. If it fails, or runs past
`WORKSPACE_TIMEOUT_S` (default 120), the run logs `WARNING: workspace.json
not built (...)`, removes any partial file, and publishes without it. The
preview Lambda keeps the last good copy. On 0.25 vCPU it takes about 20 to
25 s against a 650 MB brain.db. It needs `s3:ListBucket` on `state/` and
`s3:GetObject` on `state/gtm-inputs/*`, which the task role already has.

`headline.change` is left out of the content hash. It compares with the
LATEST run's export and names that export's fetch time, so it differs on
every run. A deal change it reports also changes `live_deals.json` and the
rest of `workspace.json`. The published note therefore stays on the last real
change instead of turning into "no change" one run later.

`fresh` (added last, read only by the fresh frontend) carries the form fills,
meeting-link bookings, closed-won deals and per-deal call activity that app
used to take from its one-time extract, in the same shapes and under the same
reporting rules. Its contract is in `docs/workspace-fresh.md`. It adds a few
hundred KB, and it is left out (with a warning) if the file would pass the
3 MiB budget.

## HubSpot attribution, forms, lists, and imports

Contacts carry source attribution (`hs_analytics_source*`,
`hs_latest_source*`), first and recent conversion, `hs_object_source*`,
`hs_google_click_id`, the first-touch URL and referrer
(`hs_analytics_first_url`, `hs_analytics_first_referrer`), and the lead, MQL,
SQL, and customer lifecycle dates. Contacts stored before the first-touch
fields were added get them from a new `HUBSPOT_CONTACT_BACKFILL=restart:<n>`.
Until that backfill is done, `workspace.json` `adLeads.firstUrlSynced` stays
false: incremental runs store the key (null when unset) only on the contacts
they read. It turns true when the contact backfill is done and started after
the field's `addedAt` (`config/lead-rules.json` `reporting.adLeads.contactFields`),
or when at least 99% of stored contacts carry the key;
`adLeads.firstUrlCoverage` gives the share.
Custom `paid_touch_campaign` and `utm_*` properties are added when
`GET /crm/v3/properties/contacts` lists them; when they are absent, or the call
fails, the sync goes on without them. The incremental search reads these
properties for contacts that changed.

Meetings carry `hs_meeting_source`, `hs_meeting_source_id`, and
`hs_activity_type`. They also carry any meeting property that names the
booking link, if `GET /crm/v3/properties/meetings` lists one. A property
matches when its name contains `booking`, `meeting_link`/`meetings_link`, or
`scheduling_page`, or when its label contains "booking", "meeting link",
"meetings link", or "scheduling page". `hs_internal_meeting_notes` and
`hs_scheduled_tasks` are never fetched. `hs_meeting_location` and
`hs_meeting_external_url` are never stored, because they can hold conference
links with passcodes; the meeting backfill removes them from meetings already
stored. When the properties call fails, meetings are read without the booking
link properties.

`HUBSPOT_CONTACT_BACKFILL=1` re-reads every contact's properties once and
merges them into `hubspot_objects`. Each search asks for `hs_object_id` above
the last stored id, 200 per call, so the 10,000-result search cap does not
apply. `sync_state` `hubspot_contact_backfill` holds that id after every
page, so an interrupted backfill resumes there. When it finishes it is marked
done and later runs skip it. `HUBSPOT_CONTACT_BACKFILL=restart` starts over
once: the value is recorded in that `sync_state` row, so leaving it set does
not restart every run. Set a new value (`restart:2`, say) to start over again.
It leaves associations and the contacts watermark alone. 10,000 contacts take
about 50 searches. Each backfill reads at most `HUBSPOT_BACKFILL_MAX_PAGES`
pages a run (default 150, so 30,000 objects) and resumes next run. `HUBSPOT_MEETING_BACKFILL=1` (or `restart`) does the same
for meetings, so meetings stored before the source and booking link
properties existed get them. Its state is in `sync_state`
`hubspot_meeting_backfill`, and it records its own `sync_outcomes` row of the
same name.

After the objects, three extra pulls run every time. Each writes its own
`sync_outcomes` row (`hubspot_forms`, `hubspot_lists`, `hubspot_imports`,
plus `hubspot_contact_backfill` and `hubspot_meeting_backfill` when set).
A failure in one, such as a 403
for a scope the app lacks, is recorded there with its route and status, and
logged to stdout (CloudWatch) as one line:

    EXTRA_PULL_FAILED <name> <route> <status>

for example `EXTRA_PULL_FAILED hubspot_imports GET /crm/v3/imports 403`. The
`hubspot` row stays ok, the other pulls still run, and the exit code stays 0.
Lemlist's `lemlist_activities` and `lemlist_leads` log the same line. Their
tables are created up front, so they exist even when the pull fails.

| Table | Source | Refresh |
| --- | --- | --- |
| `hubspot_forms` | `GET /marketing/v3/forms`, `formTypes=all`, active then `archived=true` | every run (one call per 100 forms) |
| `hubspot_form_submissions` | `GET /form-integrations/v1/submissions/forms/{guid}`, 50 a page, newest first | first pull: all pages, `FORM_SUBMISSION_MAX_CALLS` a run (default 200). Later: stops at the form's watermark |
| `hubspot_lists` | `POST /crm/v3/lists/search`, 500 a page | every run, mirrored (deleted lists go) |
| `hubspot_list_memberships` | `GET /crm/v3/lists/{id}/memberships`, 250 a page, contact lists (`0-1`) only | each list at most every `LIST_MIN_INTERVAL_MIN` (default 360); `LIST_MEMBERSHIP_MAX_CALLS` pages a run (default 400) |
| `hubspot_imports` | `GET /crm/v3/imports` | every run |

The per-form watermark (`sync_state` `hubspot_forms`) is the newest
`submittedAt` in ms. Forms without one are read in full, newest first; these
first pulls share `FORM_SUBMISSION_MAX_CALLS` pages a run. A form cut short
keeps its paging cursor in `sync_state` `hubspot_forms_progress` and the next
run carries on from there. An archived form is read once more after it is
archived (catching submissions since its watermark), then no longer. A form
that fails keeps its watermark (and drops its cursor, so its pull starts
over); the others go on, and `hubspot_forms` records the failure. A
submission with a missing or non-numeric `submittedAt` is stored with
`submitted_at` NULL and does not move the watermark. Submissions are keyed by
`conversionId`, or by a hash when it is missing. `contact_email` is the
`email` field value. Field values, `page_url`, and `page_title` are cut at
8000 characters, like other raw fields.

Some form types have no exportable submissions. HubSpot answers HTTP 400 with
`"Submissions can't be exported for this form."` and an `errorType` starting
with `FORM_TYPE`. That is not a failure. The form gets
`hubspot_forms.submissions_exportable` = 0 and its check time goes into
`hubspot_forms_progress` (`notExportable`). It is skipped until
`NOT_EXPORTABLE_RECHECK_DAYS` (7) have passed, then asked again. Its
`formType` is recorded too (`notExportableTypes`). Other forms of that type
are skipped without a request for as long, and the first one asked after
that re-checks the type. Forms of a type listed in `HUBSPOT_FORMS_SKIP_TYPES`
(comma list) are always skipped. Skipped forms also get 0. A form read
without that error gets 1 and clears its type, and NULL means not asked yet.
The `hubspot_forms` detail lists the skipped form ids (the first 6, then a
count). With only these skips, the row is ok=1 and `last_ok_at` moves. Any
other 400, or any other error status, still fails `hubspot_forms` as before.

The list catalog is mirrored only from a complete answer. A page without a
`lists` array, a `hasMore` without a later offset, or an empty catalog while
lists are stored (or `total` > 0) fails `hubspot_lists` and leaves the stored
lists and memberships as they were. Each contact list's memberships are read
when that list's last complete read is older than `LIST_MIN_INTERVAL_MIN`.
`sync_state` `hubspot_lists` holds that time per list, so a list whose read
failed is retried next run while the others wait. Membership pages share
`LIST_MEMBERSHIP_MAX_CALLS` a run. A list cut short is staged in
`hubspot_list_memberships_pending`, its cursor is kept, and the next run
resumes it. Its stored rows are replaced only when its read is complete.

## Lemlist leads and activities

`lemlist_activities` comes from `GET /api/activities?version=v2` for
emailsReplied, linkedinReplied, meetingBooked, emailsSent, emailsClicked,
and emailsOpened, across all campaigns. Each request covers a 30-day
`minDate`/`maxDate` window and pages by `offset`, 100 a page. `sync_state`
`lemlist_activities` holds, per type, the end of the last complete window, and
later runs re-read from an hour before it (about 6 calls). The first pull
starts at the oldest campaign. A run stops after `LEMLIST_ACTIVITY_MAX_CALLS`
calls (default 300, about 2.5 min). A window it cut short is kept in
`sync_state` `lemlist_activities_resume` with its dates and offset, and the
next run re-reads that same window from that offset, so a window with more
rows than one run can page through still advances. Reply types go first.
Reply activities keep their full `raw_json` (message preview and text), so
later code can tell auto-replies. Other types drop the nested `lead` object.

`lemlist_leads` has one row per lead per campaign from
`GET /api/v2/campaigns/{id}/export/leads?state=all&format=json`. When that
is refused, the rows come from `GET /api/campaigns/{id}/leads/`, paged by
`offset` (or by `next` cursor). That route has no email or domain. A
campaign's rows are replaced at most every `LEMLIST_LEADS_MIN_INTERVAL_MIN`
(default 360; 0 exports every run), and a run exports at most
`LEMLIST_LEADS_MAX_EXPORTS` campaigns (default 8). Campaigns never exported go
first, then those with the oldest export, so refresh times spread over
several runs instead of all falling due together. `sync_state`
`lemlist_leads` holds the time of each campaign's last complete export, so a
campaign that failed is tried again next run.
`contacted_at`, `opened_at`, `clicked_at`, `replied_at`, and
`meeting_booked_at` are the first matching activity for that lead id in that
campaign, updated every run from the stored activities.

Both write their own `sync_outcomes` rows (`lemlist_activities`,
`lemlist_leads`) and fail alone, as on HubSpot. A 429 is retried after
`Retry-After` or 2, 4, 8, and 16 s.

## Run time

Incremental extra calls per run: HubSpot about 4 plus one per active form
(at 0.15 s each, 50 forms add about 8 s), and each list's memberships every
6 h at one call per 250 members, at most `LIST_MEMBERSHIP_MAX_CALLS` (400,
about 1 min) a run. Lemlist adds about 6 activity calls, and every 6 h one
export per campaign, at most 8 a run (each can take up to its 120 s timeout,
so 16 min at worst). The one-off pulls
are capped per run and resume: the first submission pull at
`FORM_SUBMISSION_MAX_CALLS` (200 pages of 50, about 30 s), the first activity
pull at `LEMLIST_ACTIVITY_MAX_CALLS`. The contact and meeting backfills run
only with their variables set, at most `HUBSPOT_BACKFILL_MAX_PAGES` pages each
a run.

## Tests

`refresh/tests/test_sync_e2e.py` runs `hubspot_sync.py` and `lemlist_sync.py`
unmodified against local fakes (`refresh/tests/fakes.py`). The scripts get
`HTTPS_PROXY` pointing at a local proxy that answers CONNECT only for
api.hubapi.com and api.lemlist.com. That proxy serves those hosts itself with
a CA made for the run (`SSL_CERT_FILE`). Secrets Manager is faked through
`AWS_ENDPOINT_URL_SECRETS_MANAGER`. The tests check tables, row counts,
watermarks, and `sync_outcomes` across repeated runs. They cover paging,
429s, archived forms (including one archived after its watermark), a missing
scope (403 on imports and on forms), list answers without a `lists` array or
with no lists, a list whose memberships fail, a non-numeric `submittedAt`,
a form whose submissions can't be exported (marked, skipped with others of
its type and of `HUBSPOT_FORMS_SKIP_TYPES`, re-checked a week later) next to
a plain 400 that still fails, forms pulled on the sync-only path with no
backfill variable set,
the per-run caps on submissions, memberships and activities (including one
window larger than the budget) resuming, the leads interval, a one-time
backfill restart, the meeting source and booking link properties (and a 403
when listing meeting properties), the resumable and page-capped meeting
backfill, the per-run leads export cap, the `EXTRA_PULL_FAILED` lines, and that only GETs and the
read-only POSTs were sent.

    python3 -m unittest discover -s refresh/tests -v

They need Python 3 with boto3 and the `openssl` CLI, and take about 3 to 5
minutes, mostly the scripts' own pacing. Nothing leaves the machine.

`refresh/tests/test_run_workspace.py` runs `main_sync_only` against a
filesystem store with a synthetic brain.db, `state/gtm-inputs/` and a
published run. The real `workspace-data.py`, content hash and publish run;
only the build steps that are not in this repo are stubbed. It checks that
`workspace.json` is published and built from the inputs and the prior. It
checks that a no-change HubSpot sync publishes nothing and that a deal change
publishes. It also checks that a refused step (no scrub patterns, with a
partial file left behind), a timeout, and a failing inputs listing all still
publish, without `workspace.json`.

`refresh/tests/test_fresh_e2e.py` runs the same portal as the reporting-rules
end to end, plus wins, Fathom recordings and `records.jsonl`. It checks
`workspace.json` `fresh` against the sections it comes from, that it carries no
person names or emails, that the page is the same with or without it, and the
over-budget fallback.

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
