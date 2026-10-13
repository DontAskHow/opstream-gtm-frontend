# GTM one-page workspace

One page, one question per section: **Pipeline** (where are we?), **Leads** (where do they come from?), **Meetings** (who is meeting prospects?), **Calls** (what are prospects saying?), then Strategy's **Analysis**. Two steps build it:

```sh
python3 scripts/workspace-data.py --db brain.db --lead-sources lead-sources.json \
  [--lost-reasons lost-reasons.json] [--insights insights.json] [--lead-insights lead-insights.json] \
  [--prior live_deals.json ...] [--current-page data.json] [--portal-id N] [--as-of ISO] \
  --out /path/outside/repo/workspace.json
node onepage/build.mjs --data /path/outside/repo/workspace.json --out /path/outside/repo/site
```

`workspace-data.py` (Python 3.9+, stdlib only) opens `brain.db` read-only, applies every scope rule once and writes one JSON. `build.mjs` (Node 20, no dependencies) renders one self-contained `index.html`: inline CSS and JS, data in a `<script type="application/json">`, a CSP that allows no network requests. Both print the audited figures. Keep inputs and output outside the repo: the output holds real names and amounts.

## Files

| File | Role |
|---|---|
| `scripts/workspace-data.py` | Data shaping: scope, lead attribution, meeting match, calls, freshness. |
| `shared/workspace-scope.json` | Scope rules (data-free): Sales Pipeline id, dropped pipelines, CS owner ids, the hidden owner (escaped), event lists that don't count on their own, form bucket → Source. |
| `onepage/page.cjs` | The components (tile, chip, table, expand row, list, drawer, bar) and the page. Runs in Node for the first paint and inlined in the page for hash state, expand rows, lists and drawers. |
| `onepage/build.mjs` | View model (lost reasons via `workspace/src/lost-reasons.js`, Analysis via `workspace/src/insights.js`), HTML, and the scrub check. |
| `onepage/styles.css` | Tokens (8 px spacing; 28/16/14/12 type; neutrals, one accent, one alert) and the components. Mobile: one column, fewer columns, full-screen drawer. |

## Scope (applied in `workspace-data.py`)

- **Sales Pipeline only** (`default`). Renewal, Partnerships and Customer Success deals never reach the page. Closed Won Sales Pipeline deals stay in pipeline figures; a customer's new Sales Pipeline deal stays visible.
- **CS owners** (`csOwnerIds`, plus `customer_success.owners` in lead-sources.json) are out of meetings, and their Fathom recordings (by the owners' emails from `hubspot_owners`) are out of calls.
- **The call rule** (meetings and calls only). A company is a customer at time *t* if it has a Renewal or Customer Success deal, or *t* is on/after its first Closed Won date, or it is a lifecycle customer with no won date. Before the first win a call is a prospect call. A HubSpot meeting linked to a Renewal/CS deal is a customer meeting. A meeting with nothing linked counts as a customer meeting when its title names a customer company. Internal-only meetings and recordings (no external guest) are out.
- **The hidden owner** (pattern in `hiddenOwner`) is "Unassigned" in every owner, attribution, label, note and insight field: one recursive scrub over the whole output. `workspace-data.py` and `build.mjs` both fail if the pattern survives.
- "This week", the Sheet→HubSpot "bridge" count and the `records.json` counts are gone: they explained a reconciliation, not a decision.

## Sections

- **Header**: data as-of time (PT) and one chip per `sync_outcomes` source, "last good <time> PT"; a source that is down shows in red with its last good time, and the page keeps showing that data. Staleness chips: ad reports that end more than 3 days before the as-of time, missing spend actuals (budget Sheet), GA4 Unassigned share ≥ 20 %, and the sources not yet synced.
- **Pipeline**: open deals, open amount, weighted (amount × the deal's HubSpot stage probability), On Hold separately; a dismissible **what changed** note (below); open deals by stage (the bar component); largest open deals; Closed lost and Disqualified as separate tiles, then why they were lost (`lost-reasons.json` decides its deals, HubSpot's reason auto-maps the rest).
- **Leads**: a lead is a company on the Lead Tracker with its first lead date (Lead Date, else First Touch); MQL counts companies with an MQL or SQL date. Rows by the Sheet's Source → sub-source chips → lead list → lead drawer. Then ad platforms (platform-reported events, **not leads**: spend, days with spend and their window, each platform's own conversion count and how it counts) and Lemlist sales campaigns.
- **Meetings**: HubSpot meetings by owner: matched (a linked contact's company has a Sales Pipeline deal), unmatched (linked, no Sales Pipeline deal), no contact linked. Owner or bucket → list → meeting drawer (contacts, companies and deals, the Fathom summary of a prospect call on the same day with a shared guest).
- **Calls**: Fathom prospect calls by recorder → list → call drawer.
- **Analysis**: `insights.json`, validated with the existing validator.

Every list: search, sort, 25 per page. The URL hash keeps the state (`#src=Paid&lead=L363`, `#mo=*&mb=unmatched&mtg=…`, `#lost=competitor&deal=…`, `lp`/`mp`/`cp` periods), so a link opens the same view. Esc or the scrim closes the drawer.

## Lead sources (`lead-sources.json`, provisional)

The page labels everything taken from this file "provisional (awaiting <who>)", with <who> from the file's `needs_<who>` key ("sign-off" without one). A mapping change edits only that file.

- **Source** is the Sheet's Source column; it wins. Other evidence that names a different source is flagged as a conflict on the lead, never resolved.
- **Evidence rules, in order** (the first that fires is shown as "rule that fired"): Lemlist lead email (`lemlist_leads`; campaigns from `lemlist.campaigns`: "separate sub-source" buckets are tagged *customer→new company* and sub-source "Customer job changer"; exclude/nurture ignored) → HubSpot form / UTM (`hubspot_form_submissions`; `ads_conversion` forms or paid UTM values/gclid → Paid) → HubSpot form submission (`forms[]` bucket; `uncertain` forms are "mapping unconfirmed") → event list upload (`hubspot_list_memberships`, lists with `kind` event that count, minus `eventListExclusions`; purchased lists never count) → `paid_touch_campaign` → HubSpot original source (Paid Search/Social, gclid) → HubSpot import → the Lead Tracker note (names a platform from `ads.platforms` and says ad/paid).
- **Paid platform**: the first rule that names one; else "Platform not named". For those, *possible* platforms are the ones whose configured conversion events (from the platform report Sheets) the note mentions; "at most" = named + possible.
- Tables and contact fields the sync has not written yet are listed as **not yet synced**, and the sub-sources that need them say so. They are used as soon as they exist.

## What changed

Pass earlier HubSpot deal exports (`live_deals.json` shape) with `--prior`. The note compares the headline with the newest export older than the current HubSpot sync whose totals differ, and lists deals that are new (not in that export; HubSpot createdate shown), moved in or out of the open set, changed amount, or changed open stage. Without an export it lists open deals created in the 24 hours before the as-of time and says so. Dismissal is stored in the browser per change.

## Tests

```sh
npm test                                # includes the two below
node --test test/onepage-e2e.test.mjs   # synthetic brain (scripts/synthetic-data.cjs brainFixture) end to end
node --test test/onepage-real.test.mjs  # real brain.db + Strategy files; skipped when absent
```

The real-data run reads `BRAIN_DB`, `GTM_INSIGHTS_DIR`, `GTM_PRIOR_EXPORT`, `GTM_CURRENT_PAGE` and `GTM_REFRESH_JSON` (defaults under `/workspace`), builds into a temp dir, checks the headline against an independent SQL computation, and prints PASS/FAIL per audited figure.
