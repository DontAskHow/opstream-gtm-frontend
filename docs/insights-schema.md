# Analysis file (`insights.json`)

The GTM workspace's **Analysis** panel (overview page) shows one JSON file, `/insights.json`, written by the Strategy seat. The page reads it with `fetch('insights.json', {cache: 'no-store'})`, validates it, and renders every string as plain text with `textContent`. Nothing in the file is parsed as HTML, and the file carries no links. Instead, the page matches the text against its own data when it renders (see [References](#references)). If the file is missing (S3 behind CloudFront answers 403 or 404), the panel shows **"No insights published yet"**. If the file is there but invalid, the panel shows the same title and says the file doesn't match the format. A partial file is never shown.

- Enforcing validator: `workspace/src/insights.js`. The page and the publish script both use it.
- JSON Schema (mirrors the validator): `docs/insights.schema.json`.

## Shape

```json
{
  "generated_at": "2026-10-12T19:07:29-07:00",
  "headline": "One sentence the reader should take away.",
  "insights": [
    {
      "title": "Short title",
      "evidence": "What the data shows, with figures.",
      "citations": ["where each figure came from"],
      "why_it_matters": "Why this matters now.",
      "recommended_play": "What to do, concretely.",
      "owner": "Who does it",
      "confidence": "high"
    }
  ],
  "data_quality_flags": ["A plain-text flag", {"deal": "Example", "issue": "amount missing"}],
  "changed_since_last": "What changed since the previous file (a string, or an array of strings).",
  "goals": [
    {"metric": "open_amount", "target": 500000, "label": "Grow the open book", "by": "2026-12-31", "note": "Optional context."},
    {"metric": "closed_lost_to_competitor_count", "competitor": "Example Rival", "target": 2, "label": "Lose less to Example Rival"}
  ]
}
```

| Field | Rule |
|---|---|
| `generated_at` | Required. ISO 8601 date-time with seconds and an explicit offset (`Z` or `±hh:mm`). The panel shows it as "Generated …" in PT. |
| `headline` | Required string, 1–400 characters. |
| `insights` | Required array of 1–20 items. |
| `insights[].title` | Required, ≤ 200 characters. |
| `insights[].evidence` | Required, ≤ 2000 characters. |
| `insights[].citations` | Optional array of ≤ 20 strings, each ≤ 1000 characters. Shown collapsed. |
| `insights[].why_it_matters` | Required, ≤ 1200 characters. |
| `insights[].recommended_play` | Required, ≤ 1200 characters. |
| `insights[].owner` | Required, ≤ 300 characters. |
| `insights[].confidence` | Required: `low`, `medium` or `high`. |
| `data_quality_flags` | Required array (may be empty) of ≤ 50 entries. Each entry is a string, or an object whose values are strings, numbers, booleans or null. An object is shown as `key: value · key: value`. |
| `changed_since_last` | Required. A string, or an array of ≤ 50 strings. Shown as one muted line under the insights. |
| `goals` | Optional array of ≤ 12 goals. Files without it are valid. |
| `goals[].metric` | Required. One of the metric keys below. |
| `goals[].target` | Required number ≥ 0, in the metric's unit: dollars, a count, or a percent (0–100, so at most 100) for the rate metrics. |
| `goals[].label` | Required, ≤ 200 characters. |
| `goals[].by` | Optional calendar date, `YYYY-MM-DD`. Shown as "by …"; flagged "passed" when the date is past and the goal isn't met. |
| `goals[].note` | Optional, ≤ 400 characters. |
| `goals[].competitor` | Required when `metric` is `closed_lost_to_competitor_count`, and rejected with any other metric. ≤ 100 characters. |

### Goal metrics

Each goal's current value is computed in the page from the same data the overview shows (`metricValues` in `workspace/src/insights.js`). A goal is met at or above its target, except the "at most" metrics, which are met at or below it. If the metric has a headline tile, the tile gets a "Goal: …" line.

| `metric` | Current value | Met when | Headline tile |
|---|---|---|---|
| `open_count` | Open deals in the headline pipeline, On Hold excluded | ≥ target | Open deals |
| `open_amount` | Their open amount | ≥ target | Open amount |
| `weighted` | Their weighted amount (amount × stage probability) | ≥ target | Weighted |
| `on_hold_count` | On Hold deals in the headline pipeline | ≤ target | On Hold |
| `on_hold_amount` | Their amount | ≤ target | On Hold |
| `closed_lost_count` | Closed-lost deals (closed and not won) in the headline pipeline | ≤ target | Closed lost |
| `closed_won_count` | Closed-won deals in the headline pipeline in the HubSpot export (all time) | ≥ target | — |
| `closed_won_amount` | Their amount | ≥ target | — |
| `meetings_this_month` | CRM meetings starting this calendar month (PT), past and upcoming | ≥ target | — |
| `meetings_upcoming` | CRM meetings starting from now on | ≥ target | — |
| `commit_stage_amount` | Open amount of the open, non-On-Hold deals in the headline pipeline's commit stages (see below) | ≥ target | — |
| `lead_to_mql_rate` | Distinct contacts who booked through the book-a-demo HubSpot meeting link ÷ distinct contacts with a form submission, trailing 90 days PT (proposed; see below) | ≥ target | — |
| `unowned_lead_count` | Lead Tracker rows with no owner (see below) | ≤ target | — |
| `outbound_reply_rate` | Lemlist replies ÷ sends × 100 over **every** campaign, any status, that reports both | ≥ target | — |
| `ai_share_of_voice` | Otterly AI share of voice (percent), only while Otterly is connected | ≥ target | — |
| `closed_lost_to_competitor_count` | Closed-lost deals in the headline pipeline whose lost reason names `competitor` | ≤ target | — |

Rules behind the new metrics. A value the data can't give shows "—" and the goal is neither met nor missed.

- **Commit stages** are picked from HubSpot's stage metadata, never by name: every open stage of the headline pipeline with a stage probability of at least 0.7 (`COMMIT_PROBABILITY`). On Hold deals are left out, as on the Open amount tile. With no such stage the value is unknown. The goal shows which stages it counted.
- **Unowned leads** are Lead Tracker rows (`leadTracker` in `data.js`: rows, rows with an MQL date, rows without an owner; never the rows). A row is unowned when its owner cell is blank or a placeholder such as "not assigned", "unassigned", "none" or "n/a".
- **Lead → MQL rate** (r12, proposed) is per contact: contacts who booked through the book-a-demo HubSpot meeting link (meeting source `MEETINGS_PUBLIC` plus a booking-link match, via meeting → contact associations) ÷ contacts with at least one form submission, both over the trailing 90 days in PT. It reads `mqlFunnel` (`available`, `numerator`, `denominator`); while those HubSpot fields are not synced the value is unknown and the page hides the metric. Rates are rounded to 0.1 percent.
- **Outbound reply rate** (r12) counts every Lemlist campaign in any status, including the job-changer, website-intent and Bad ICP campaigns; their tags are filters, not exclusions. Campaigns that don't report sends or replies are skipped, and with no sends the rate is unknown.
- **AI share of voice** is Otterly's `shareOfVoice` as of its last successful fetch (`times.ai`). It's unknown when the Otterly source isn't connected.
- **Closed lost to a competitor** matches `competitor` as a whole word or phrase, in any case, inside each closed-lost deal's lost reason (or a `competitor` field, if the deal carries one). "Rival" matches "went with rival" but not "rivalry". The count has no headline tile, but it cites the lost-reasons panel.

Every string must be non-empty. Unknown fields at any level are rejected, so a typo such as `why_it_maters` fails loudly instead of disappearing. The whole file must be ≤ 256 KB.

## References

When the page renders a file, it looks for things the text names that the page also shows, using `findRefs` in `workspace/src/insights.js`. The matching runs against the current data, so no names are written into the code:

- **Deals and accounts** by name (an account's legal suffix such as "Inc." is optional). These link to `#/deal/<id>` and `#/account/<id>`.
- **Stages** of the headline pipeline. Open stages link to the pipeline view filtered to that stage. On Hold, lost and won stages cite the matching metric.
- **Pipelines** by name. The headline pipeline points at its panel, and the others link to their pipeline view.
- **Headline metrics**, by phrase ("open amount", "weighted pipeline", "open deals", "closed lost", "commit stage", "reply rate", …), by their data path (`headline.active.openAmount`), or by the figure exactly as the page formats it. **Overview panels** are matched by name ("lost reasons", "close date", "meetings over time", …). Clicking a metric or panel reference scrolls to it and outlines it briefly ("reply rate" opens the campaigns page instead). Hovering an insight outlines everything it cites.

A one-word name or stage only matches with the same capitalization. Longer names match in any case. A name that two different things share is never linked. Text that matches nothing stays plain.

## Publishing

```sh
node /workspace/gtm-refresh15/workspace/refresh/publish-insights.mjs /workspace/gtm-insights/insights.json
```

The script validates the file and refuses (exit 1, with a list of problems) on any error. It then compares the file's sha256 with the `sha256` metadata on `s3://opstream-gtm-preview-db5553a4/insights.json`. If they match, it uploads nothing. Otherwise it uploads with `Content-Type: application/json` and `Cache-Control: no-store`. It uses the AWS CLI with `--profile opstream-deploy` (override with `GTM_AWS_PROFILE`). Add `--dry-run` to validate and compare without uploading.

The scheduled data refresh (`workspace/refresh/`) never touches `insights.json`.
