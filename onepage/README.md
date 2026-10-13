# GTM one-page view

`build.mjs` turns a snapshot directory into a single, self-contained `index.html`. The page has inline CSS, no JS and no external requests. It has four panels:

1. **Pipeline by stage** (`records.json` + `run-facts.json`): headline open count, open amount and weighted amount from run facts. Then open deals (`closed` falsy) grouped by `stageLabel` (falling back to `stage`) with count and total amount, sorted by amount. The snapshot has no stage-order field. Below that are the top 8 open deals by amount; close dates in the past are flagged.
2. **Active campaigns & results** (`marketing.json` → `outbound.campaignStats`, `status == "running"`): sorted by sent. Reply rate = replied ÷ delivered. Opens of 0 show as "—" because that means open tracking is off. Also includes a small paid-ads table from `marketing.ads`.
3. **Upcoming content**: always an empty state for now, because no content calendar exists in the snapshots.
4. **This week** (`agent-brief.json`): the first 5 unique lines from `whatsNew`, then `topActions` (titles), then `watchOuts`.

Each panel header shows "Updated …" from its source's timestamp, rendered in `America/Phoenix` and labelled "PT". Missing values render as "—"; nothing is estimated.

## Usage

```sh
node onepage/build.mjs --data /path/to/snapshot-dir --out /path/to/output-dir
```

Node 18+ is required, with no dependencies. The data directory must contain `records.json`, `marketing.json`, `agent-brief.json` and `run-facts.json`. If a file is missing, the build prints a warning and that panel shows "—".

## Data hygiene

This repo is public. Keep snapshot data and the generated page **outside** the repo, or in an ignored path (`gtm-onepage-out/`, `gtm-data/` are in `.gitignore`). The generated HTML contains real customer names and amounts, so never commit it.
