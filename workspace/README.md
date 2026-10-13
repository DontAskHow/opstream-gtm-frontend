# GTM workspace

An interactive, local-only GTM workspace in Opstream's brand. `build.mjs` reads a data snapshot, brand assets and (optionally) the HubSpot reconciliation export, then writes a static site. The site works when opened from `file://` or through `serve.mjs`. This directory holds code only. Snapshot data and generated output never belong in this repo.

## Usage

```sh
node workspace/build.mjs \
  --data  /workspace/gtm-data \
  --brand /workspace/gtm-brand \
  --out   /workspace/gtm-onepage-out/workspace \
  --recon <pipeline-recon-dir> \
  --expect count=<n>,amount=<n>,weighted=<n>,holdCount=<n>,holdAmount=<n>
node workspace/serve.mjs --dir /workspace/gtm-onepage-out/workspace [--port 8787]   # http://127.0.0.1:8787/
```

Node 20 is required, with no dependencies and no network access. `--recon` and `--expect` are optional (see below). The builder refuses to clear an `--out` directory that isn't empty unless it wrote that directory itself (it leaves a `.gtm-workspace-build` marker).

The build prints the pipeline figures it computed, per pipeline, plus the expected-figure check and the data-quality counts. You can verify the numbers without opening the page.

## Output

| File | Contents |
|---|---|
| `index.html`, `app.js`, `styles.css` | The app (copied from `src/`) |
| `data.js` | `window.GTM_DATA = {…}`, a trimmed projection of the inputs (`lib/project.mjs`) |
| `vendor/gtm-charts.js` | A small hand-written SVG chart kit (`src/charts.js`) |
| `vendor/insights.js` | The Analysis file validator (`src/insights.js`), shared with `refresh/publish-insights.mjs` |
| `transcripts/<recording-id>.js` | Per-recording transcripts. Each loads on demand when you click "Show transcript". |
| `fonts/`, `logo.svg` | Poppins (from `source/assets/fonts`) and the brand `logo-main.svg` |

The page's CSP sets `connect-src 'self'`. The app makes only two same-origin reads, both `no-store` and both optional: `refresh.json` (the "Last refreshed" time written by the scheduled refresh, `refresh/README.md`) and `insights.json` (the Analysis panel, `docs/insights-schema.md`). Under `file://` they fail, so the header shows the time from `data.js` and the Analysis panel says no insights are published. The app has no ask box and no send actions. Links inside recording summaries render as plain text. The Analysis text has no links of its own; names the page recognizes from its data (deals, accounts, stages, headline metrics, overview panels) become in-page links (`docs/insights-schema.md`).

## Inputs

- `--data`:
  - `records.json`: companies with deals, contacts (counted only), meetings, notes and recordings (`summary`, `actions`), plus owners.
  - `marketing.json`: `outbound.campaignStats`, `ads`, `spend`, `shows.items`/`eventRoi` and `sources`.
  - `agent-brief.json`, `sheet-review.json` (the master Sheet's open deal rows). `run-facts.json` is not read.
  - `transcripts/*.json`.
  - The meeting-prep file is found by its shape: a JSON file with `prep[]` and `brief`.
- `--brand`: `logo-main.svg`. The colors and fonts are in `src/styles.css`.
- `--recon`: `live_deals.json`, the HubSpot export (`pipes`, `stages` with `closed`/`prob` metadata, and `deals[].properties`). When it's present, **HubSpot is the source of truth for every pipeline number**. Without it, pipeline numbers come from `records.json`, which doesn't record pipelines, and are labelled unreconciled.

## Pipeline rules

- **One definition**: `shared/open-pipeline.json` (data-free): pipeline kinds, On Hold stage labels, the closed rule (HubSpot `isClosed` wins), and the fields stage and pipeline names are read from, with their fallbacks. `workspace-model.cjs` (and so this builder's `lib/project.mjs`) and `scripts/gtm_metrics.py` all read it; change the rule there, nowhere else. `test/open-pipeline-e2e.test.mjs` runs one synthetic HubSpot export through both and checks they give the same open set.
- **Open**: the HubSpot stage isn't closed (`isClosed` metadata; `hs_is_closed` only when the stage isn't in the catalog). A stage name never decides closed.
- **Active** = open and not a stage listed in `onHoldStageLabels` (compared on letters only). On Hold is always reported on its own line.
- **Pipelines are never mixed.** Each HubSpot pipeline has its own totals, stage table and funnel, chosen with the pipeline selector. The headline is the single new-business pipeline. A pipeline's kind comes from `pipelineKinds` in `shared/open-pipeline.json` (renewal / customer success / partner by label); anything else with a recorded pipeline is new business. Renewal, Customer Success and Partnerships are listed separately.
- **Weighted** = amount × HubSpot stage probability (0–1), summed over deals that have both. Deals without a probability stay in the open amount and are counted next to the weighted figure. A total over deals that all lack an amount shows "—", not $0.
- **Stage order** follows HubSpot's stage probability metadata. (`JSON.parse` reorders numeric stage ids, so the export's key order can't be used.)
- **The caveat**: HubSpot is the only headline. The red "unreconciled" caveat goes away only when the build is given `--expect` and every computed figure matches exactly. Otherwise it stays and says which figures differ.
- **Data quality**: Sheet-active rows that HubSpot has closed, open new-business HubSpot deals missing from the Sheet's open rows, other stage differences, and the bridge from the Sheet count to the HubSpot count.

## Views (hash routes)

- `#/overview`: the HubSpot headline, the Analysis panel, the 5-line brief (what's new first, then top actions, then watch-outs), upcoming prep meetings, all pipelines (each on its own row), and a filtered view: the funnel with the largest deals per stage, value by close month, and meetings over time (click a month to list its meetings).
- `#/pipeline?pipe=&owner=&stage=&seg=&from=&to=`: summary tiles, the funnel and close-month charts (click to filter), a sortable deals table, and accounts. Sheet-vs-HubSpot differences are flagged on the deal page only.
- `#/deal/<id>` shows a deal's HubSpot fields, its Sheet values and any data-quality flags. `#/account/<id>` shows an account's fields and deals. Both pages also show the account's meetings, notes, and recording summaries with action items (verbatim).
- `#/campaigns?c=<campaignId>`: running campaigns (sent / opened / replied / meetings; zero opens read "tracking off"), all campaigns, paid ads by channel, spend, and tradeshow leads → MQL → SQL.
- `#/prep`, `#/prep/<account id>`: accounts with a meeting in the last or next 14 days, plus every account in the prep brief. Each account page shows meetings, the prep brief's fields, open deals, recording summaries and next steps only from existing fields ("No recording summary in the data" when there are none), and notes.

**Segment** is the HubSpot company `industry`, with "Industry not set" and "No account in snapshot" buckets.

Every panel shows "Updated …" from its source's `generatedAt`/`fetchedAt`/`collectedAt`, in `America/Phoenix`, labelled PT. The HubSpot export has no timestamp, so its file time is used. Nothing is estimated: missing values show "—" or a labelled empty state.

## Tests

```sh
npm test   # node --test test/ && python3 -m unittest discover -s scripts/tests
```

`test/workspace-build.test.mjs` builds from synthetic fixtures and checks the figures, the caveat, data quality, the output guard and the server.

## Scheduled preview refresh and Analysis

`refresh/` holds the Lambda that rebuilds the private preview's `data.js` from the published snapshot every 15 minutes (`refresh/README.md`), plus `refresh/publish-insights.mjs`, which validates and publishes the Strategy seat's Analysis file (`docs/insights-schema.md`). `test/preview-refresh.test.mjs` and `test/insights.test.mjs` cover change detection, the fallbacks, the alarms and the Analysis shape.
