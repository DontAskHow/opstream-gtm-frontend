# GTM one-page workspace

One page, one question per section: **Pipeline** (where are we?), **Leads** (where do they come from?), **Meetings** (who is meeting prospects?), **Calls** (what are prospects saying?), then Strategy's **Analysis**.

## Live data flow

```
sync job (has brain.db)            scripts/workspace-data.py --inputs-dir … --prior … --out out/workspace.json
  └─ publishes published/<runId>/  (workspace.json rides along with the snapshot; LATEST.json moves)
preview refresh Lambda (15 min)    validates it, copies it to the preview bucket when its content changed (or the live copy is over 25 min old and a newer one is in)
  └─ s3://<preview>/workspace.json + refresh.json (.workspace: status, sha256, newest timestamps)
index.html (no data)               fetches workspace.json + refresh.json (no-store), renders client-side
```

The data step, as the sync job runs it (Python 3, stdlib only):

```sh
python3 scripts/workspace-data.py --db brain.db --inputs-dir DIR --portal-id N \
  [--prior previous-run/live_deals.json] --out out/workspace.json
```

`--inputs-dir` holds any of these files (the sync job copies them from `s3://opstream-gtm-data-<account-id>/state/gtm-inputs/<name>`). Each one is optional; a missing one is listed in `meta.inputs` and its part of the page degrades:

| File | From | Without it |
|---|---|---|
| `lead-sources.json` | Pipeline | No sub-sources, platforms or campaign tags |
| `lead-source-review.csv` | Pipeline | No review list |
| `paid-deals.json` | Pipeline's deals export (`live_deals.json` shape with `derived.paid_platform`) | Paid deals computed from synced contact fields |
| `records.jsonl` | Strategy's per-call classification | "call classification unavailable"; the built-in call rule |
| `lead-insights.json` | Strategy | No insight in the lead drawer |
| `lost-reasons.json` | Strategy | Every loss auto-mapped from HubSpot's reason |
| `insights.json` | Strategy | No Analysis section |
| `scrub-patterns.txt` | operator | Required unless `WORKSPACE_SCRUB_PATTERNS` / `WORKSPACE_SCRUB_PATTERNS_FILE` is set: the step refuses to run without patterns |

Explicit flags (`--lead-sources`, `--call-classification`, `--review-list`, `--paid-export`, …) override the directory. `--prior` is the previous published run's `live_deals.json` (for the "what changed" note). `--as-of` and `--current-page` are for local audits. The output stays under 3 MB (a warning above it) and uses the sync job's volatile key names for every timestamp (`generatedAt`, `fetchedAt`, `at`, `lastOkAt`), so the same data published twice hashes the same in the sync job and in the refresh Lambda.

**Scrub patterns** (people who must never appear) are never in this repo. Every step reads them from `WORKSPACE_SCRUB_PATTERNS` (comma list) or `WORKSPACE_SCRUB_PATTERNS_FILE` (comma- or line-separated); the data step also reads `scrub-patterns.txt` in `--inputs-dir`. Owners matching a pattern become "Unassigned", every string is scrubbed, and the data step, `build.mjs`, `deploy-check.mjs` and the Lambda all refuse output that still contains a pattern, or run without patterns.

**The page** (`node onepage/build.mjs --app --out DIR`) carries no data. On load it fetches `workspace.json` and `refresh.json` from its own origin with `cache: no-store`, builds the view with the same code a local build uses (`view.cjs`, `page.cjs`, the lost-reasons and Analysis validators), and re-checks every 5 minutes: an unchanged file only updates the header in place (times from `refresh.json`, which apply only when their `forTextSha256` matches the sha256 of the fetched text). The header shows "Updated <time> PT" from the data's `generatedAt` (or the newer time the Lambda recorded in `refresh.json` for unchanged content), amber once that is over 45 minutes old, plus per-source freshness chips. If the Lambda had to keep the last good copy, a red chip says why. If `workspace.json` can't be fetched or parsed, the page shows the error and a "Try again" button. Hash state and drill-downs work as in a built page.

For local audits, `node onepage/build.mjs --data workspace.json --out DIR` builds a page with the data inside (needs scrub patterns).

## Files

| File | Role |
|---|---|
| `scripts/workspace-data.py` | Data shaping: scope, lead attribution, meeting match, calls, freshness. |
| `config/freshness-sources.json` | Which `sync_outcomes` rows get a header chip, their labels and order, and which internal rows roll up into which parent. |
| `config/lead-rules.json` | The lead-source override layer (answers of Oct 13, 9:48 AM PT, and the r12 metric definitions). Rules only, no data; change a rule here, not in code. |
| `shared/workspace-scope.json` | Scope rules (data-free): Sales Pipeline id, dropped pipelines, CS owner ids, the "Unassigned" label for scrubbed people (the patterns themselves are never in the repo), event lists that don't count on their own, form bucket → Source. |
| `onepage/page.cjs` | The components (tile, chip, table, expand row, list, drawer, bar) and the page. Runs in Node for the first paint and inlined in the page for hash state, expand rows, lists and drawers. |
| `onepage/build.mjs` | View model (lost reasons via `workspace/src/lost-reasons.js`, Analysis via `workspace/src/insights.js`), HTML, and the scrub check. |
| `onepage/styles.css` | Tokens (8 px spacing; 28/16/14/12 type; neutrals, one accent, one alert) and the components. Mobile: one column, fewer columns, full-screen drawer. |
| `onepage/view.cjs` | The view model (lost-reason categories, validated Analysis, refresh stamps); runs in Node and the browser. |
| `onepage/deploy-check.mjs` | Checks a build before upload: `--app` (data-less, fetches workspace.json) or a page with data (self-contained, CSP, no scrub pattern). |
| `workspace/refresh/workspace-json.mjs` | The Lambda's workspace.json step: checks, content hash without timestamps, copy / skip / keep last good. |

## Scope (applied in `workspace-data.py`)

- **Sales Pipeline only** (`default`). Renewal, Partnerships and Customer Success deals never reach the page. Closed Won Sales Pipeline deals stay in pipeline figures; a customer's new Sales Pipeline deal stays visible.
- **Calls** use Strategy's per-call classification (`records.jsonl`, rules in its CLASSIFICATION.md): only `prospect` calls are counted and listed; customer, internal and partner/other calls are counted apart. The call drawer shows Strategy's call type, deal at call time, buyer roles, competitors, objections and next steps.
- **Meetings** (HubSpot) use the call rule: a company is a customer at time *t* if it has a Renewal or Customer Success deal, or *t* is on/after its first Closed Won date, or it is a lifecycle customer with no won date. A meeting linked to a Renewal/CS deal, or with nothing linked and a title naming a customer company, is a customer meeting. CS owners' meetings and internal-only meetings are out. The same rule is the calls fallback.
- **Lost reasons** cover new-business losses only: a loss created after its company's first win (an expansion at a customer) is listed apart, not categorized. `lost-reasons.json` decides the deals it lists; HubSpot's reason auto-maps the rest.
- **Scrubbed people** (scrub patterns, see above) are "Unassigned" in every owner, attribution, label, note and insight field: one recursive scrub over the whole output. `workspace-data.py`, `build.mjs`, `deploy-check.mjs` and the refresh Lambda all fail if a pattern survives.
- "This week", the Sheet→HubSpot "bridge" count and the `records.json` counts are gone: they explained a reconciliation, not a decision.

## Sections

- **Header**: data as-of time (PT) and one chip per user-facing source (`config/freshness-sources.json`: HubSpot, Sheets, Fathom, GA4, Lemlist, Otterly, Reddit, spend), "last good <time> PT"; a source that is down shows in red with its last good time, and the page keeps showing that data. Internal sync steps (`hubspot_contact_backfill`, `hubspot_forms`, `lemlist_leads`, …) have no chip: they roll up into their parent, which turns amber when one fails (red when the parent itself failed) and names it in its tooltip. An unlisted `<parent>_…` row rolls up the same way; any other unlisted row shows only while it fails. `workspace.json` keeps every row; the roll-up runs in the page (`view.cjs`), after `refresh.json`'s stamps. Staleness chips: ad reports that end more than 3 days before the as-of time, missing spend actuals (budget Sheet), GA4 Unassigned share ≥ 20 %, sources not yet synced, call classification unavailable.
- **Pipeline**: open deals, open amount, weighted (amount × the deal's HubSpot stage probability), On Hold separately; a dismissible **what changed** note (below); open deals by stage (the bar component); largest open deals; Closed lost and Disqualified as separate tiles, then why new-business deals were lost.
- **Leads**: a lead is a company on the Lead Tracker with its first lead date (Lead Date, else First Touch). Rows by Source → sub-source chips → lead list → lead drawer (source and the rule that fired, every piece of evidence, dates, company, deals, meetings, contacts, the lead insight from `lead-insights.json` by HubSpot contact id, the Sheet rows). Then the review list, paid-attributed deals, ad platforms (platform-reported events, **not leads**) and Lemlist.
- **Meetings**: HubSpot meetings by owner: matched (a linked contact's company has a Sales Pipeline deal), unmatched (linked, no Sales Pipeline deal), no contact linked. Owner or bucket → list → meeting drawer (contacts, companies and deals, the Fathom summary of a prospect call on the same day with a shared guest).
- **Calls**: Fathom prospect calls by recorder → list → call drawer.
- **Analysis**: `insights.json`, validated with the existing validator.

**Date ranges.** Leads, Meetings and Calls each have a range selector; **This week** is the default everywhere: Monday 00:00 to the end of today in America/Phoenix (UTC−7, no DST), labelled with its dates ("This week · Oct 12–13"). In this range each section compares with last week over the same Monday-to-weekday window ("+1 vs last week (Oct 5–6: 1)"): the absolute change always, a percentage only when both weeks have at least 5 (otherwise "n<5: no %"). An empty week says so ("No leads yet this week (Oct 12–13). Last week (Oct 5–6): 0."). The other ranges are unchanged (Leads: this month, 90 days, this year, all time; Meetings: this month, upcoming, 30 and 90 days; Calls: this month, 30 and 90 days). "Now" for every range (and for "close date passed") is the open tab's clock, never earlier than the data's as-of time: a tab left open across a day boundary (Monday 00:00 PT starts a new week) re-renders within a minute (also on becoming visible again) with the ranges recomputed, keeping the hash, an open drawer and list search/sort/page. A Node render (tests, `--data` builds) uses the data's as-of time. A chosen range sticks per section: it goes into the hash (`lp`, `mp`, `cp`) and into localStorage, which applies when a link has no range. The fixed tiles (meetings this month / upcoming) keep their own definitions.

Every list: search, sort, 25 per page. The URL hash keeps the state (`#src=Paid&lead=L363`, `#mo=*&mb=unmatched&mtg=…`, `#lost=competitor&deal=…`, `#rv=1`, `#pd=Google%20Ads`, `#ot=job_changer`, `lp`/`mp`/`cp` periods), so a link opens the same view. Esc or the scrim closes the drawer.

## Lead sources

`lead-sources.json` (Pipeline) is the mapping; `config/lead-rules.json` overrides it where they conflict. Everything from the mapping is labelled "provisional (awaiting <who>)", with <who> from the file's `needs_<who>` key ("sign-off" without one).

- **Review list statuses** (`lead-source-review.csv`, keyed by HubSpot company id in its `hubspot_company_id` column; a row without one is listed but not applied, and `row` is never used to match): `resolved` credits the lead to `mql_channel`, the channel of the touch at its MQL booking, and shows `different_first_touch`; `undetermined` (no MQL yet) keeps the HubSpot-primary source; `on_hold*` keeps the current source on both sides and flags the lead.
- **Pipeline's paid leads and deals** (`ads.paid_leads`, export `conversion_date` / `predates_spend_window`) show the conversion date and a "predates spend window" flag (still counted). A Pipeline check whose verdict names another platform supersedes a Lead Tracker note (e.g. a note that says Reddit when the evidence is branded Google search).
- **HubSpot is primary.** A lead's Source is the first *deciding* rule below, i.e. where its conversion happened. The Lead Tracker Source is used only when HubSpot has no evidence and is always shown as evidence. A disagreement puts the lead on the review list; nothing is overwritten and nothing is written to the Sheet.
- **Rules, in order**: Lemlist lead email (campaign tags from the config; job-changer campaigns are Outbound with tag `job_changer`) → HubSpot form / UTM (paid form or UTM with a paid signal) → HubSpot form submission (every form fill is a lead, except forms marked not a lead source, i.e. careers) → event list upload (lists with `kind` event that count, minus `eventListExclusions`) → HubSpot UTM / click id → `paid_touch_campaign` → HubSpot original source → HubSpot import → HubSpot source from the review list → Pipeline's HubSpot checks (`ads.checks_*`, e.g. a confirmed paid LinkedIn or OpenAI lead) → paid deal from Pipeline's export (evidence only: deal-level, with a company fallback, so it names a platform but never moves a source) → the Lead Tracker note (evidence only).
- **Paid platform**: the first rule that names one; else "Platform not named", with *possible* platforms whose configured conversion events the note mentions. Branded Google search counts as paid and is flagged "branded term". "Named" counts use each lead's resolved platform; the Lead Tracker-notes-only count is shown beside it.
- **Paid-attributed deals**: Pipeline's export (all pipelines counted, Sales Pipeline shown), by platform, with branded and company-level counts; the deal drawer shows the evidence.
- **Lead → MQL (book-a-demo), 90 days (proposed)**: external contacts who booked through the book-a-demo HubSpot scheduling page (`hs_meeting_source` = `MEETINGS_PUBLIC` and `hs_created_by_scheduling_page` in `mql.bookingLinkIds`, via meeting → contact associations) ÷ external contacts who filled a lead form (careers forms excluded) or booked, trailing 90 days. External: not an owner's email domain (free-mail never internal). **Hidden** while `mql.show` is `false` (validation of Oct 13: the HubSpot MQL-date cross-check is not possible and incremental meeting syncs drop the booking fields; reason in `mql.hiddenBecause`); the figures stay in `workspace.json` `mqlFunnel.computed`. It is also hidden when its inputs are missing or when the page ids match none of the window's scheduling-page bookings (never a silent 0 %). Hidden means no tile, no column, no placeholder. The Lead Tracker's own MQL/SQL dates are shown as "Sheet MQL".
- **Outbound reply rate**: replies ÷ sends over every Lemlist campaign in any status (job-changer, website-intent and Bad ICP included). Tags are filters; Bad ICP and invite-step-heavy reply counts are flagged. Opens and meetings are "not tracked".
- Tables and contact fields the sync has not written yet are listed as **not yet synced**, and the sub-sources that need them say so. They are used as soon as they exist.

## What changed

Pass earlier HubSpot deal exports (`live_deals.json` shape) with `--prior`. The note compares the headline with the newest export older than the current HubSpot sync whose totals differ, and lists deals that are new (not in that export; HubSpot createdate shown), moved in or out of the open set, changed amount, or changed open stage. Without an export it lists open deals created in the 24 hours before the as-of time and says so. Dismissal is stored in the browser per change.

## Deploy

```sh
WORKSPACE_SCRUB_PATTERNS_FILE=/path/outside/repo/scrub-patterns.txt workspace/refresh/deploy.sh --onepage-app
```

builds the data-less page and checks it (before any AWS call), updates the refresh Lambda (code, write-only IAM on `workspace.json`, the scrub patterns in its environment, passed as a private `file://` so they never appear on a command line), then runs the function once (`--cli-read-timeout 150`, longer than its 120 s timeout, so the CLI never runs it twice). It uploads `index.html` (marked `gtm-page=onepage-app`) only when the run did not fail (`FunctionError`), `refresh.json` `.workspace.status` is `uploaded` or `unchanged`, and `workspace.json` is in the bucket; otherwise the live page is left as it is.

A plain `deploy.sh` (for example, to rotate the patterns or update the function) leaves a live one-page (or any `gtm-page`-tagged) `index.html` alone, and `deploy.sh --lambda-only` touches no bucket file at all; `--restore-app` puts the older workspace app back. `deploy.sh --onepage DIR` still uploads a page with data inside (a static fallback).

When a newly added pattern matches the latest snapshot, the function replaces the live `workspace.json` with a small "withheld" document (by PutObject; it has no delete permission) and the page shows a notice instead of data until a clean snapshot arrives.

## Tests

```sh
npm test                                   # includes all of these
node --test test/onepage-e2e.test.mjs      # synthetic brain (scripts/synthetic-data.cjs brainFixture) end to end, both paths
node --test test/onepage-real.test.mjs     # real brain.db + Strategy / Pipeline files; skipped when absent
node --test test/onepage-live.test.mjs     # the Lambda's copy / skip / keep-last-good / missing paths (fake S3) and the fetching page (browser if available)
node --test test/onepage-deploy.test.mjs   # deploy-check, refusals before AWS, and the invoke -> check -> upload sequence against a fake aws
```

The real-data run reads `BRAIN_DB`, `GTM_INPUTS_DIR` (the inputs directory, including `scrub-patterns.txt`), `GTM_PRIOR_EXPORT`, `GTM_CURRENT_PAGE`, `GTM_REFRESH_JSON` and `GTM_LEMLIST_SNAPSHOT` (defaults under `/workspace`), builds into a temp dir and prints PASS/FAIL per figure. It hard-codes no counts, because brain.db and the inputs drift with every sync. Each figure is either recomputed independently or checked as an invariant:

- **Recomputed from SQL over brain.db:** the headline and On Hold, closed-not-won by stage, the Lemlist sums, and the failing sync sources.
- **Recomputed from the Lead Tracker rows:** leads (distinct companies) and Sheet MQL.
- **Recomputed from the input files:** calls (`records.jsonl` audiences over the brain.db recordings), review rows, paid deals, lead insights, and the lost-reasons file coverage.
- **Invariants:** categories sum to totals, lists stay subsets, and flags follow their causes.

It also checks that the file passes the Lambda's checks and hashes the same across runs. Fixed values live only in the synthetic tests. The synthetic tests use the made-up pattern from `scripts/synthetic-data.cjs` (`SYNTHETIC_SCRUB`).
