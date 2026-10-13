# Lost-reason categories (`lost-reasons.json`)

The overview's **Why … deals were lost** panel puts every closed-lost deal of the headline pipeline (the deals `closedLost.count` counts) in exactly one of six categories, so the category counts always add up to that figure. The Strategy seat writes `/lost-reasons.json` to say which category each deal belongs to. The page reads it with `fetch('lost-reasons.json', {cache: 'no-store'})` and validates it. Deals the file doesn't list are **auto-mapped** from HubSpot's `closed_lost_reason` with keyword rules (see [Fallback rules](#fallback-rules)).

- The file is optional. If it is missing or can't be read, every deal is auto-mapped. If it is there but invalid, the whole file is ignored, every deal is auto-mapped, and the panel says so in one line. A partial file is never used.
- Enforcing validator and categorizer: `workspace/src/lost-reasons.js`. The page and the publish script both use it.
- JSON Schema (mirrors the validator): `docs/lost-reasons.schema.json`.

## Categories

Shown in this order:

| `category` | Label |
|---|---|
| `went_dark` | Went dark / no response |
| `competitor` | Chose a competitor |
| `not_a_fit` | Not a fit / disqualified |
| `no_budget_timing` | No budget or timing |
| `status_quo` | Stayed with the status quo |
| `unknown` | Unknown |

Each row shows the deal count, the summed amount (deals without an amount are left out of the sum and counted in the amount's tooltip) and a bar scaled to the largest row. The competitor row also lists deals per competitor name (for example `VendorX 14 · VendorY 3 · unnamed 7`). Names are grouped case-insensitively under their most common spelling. Clicking a row lists its deals, each linked to `#/deal/<id>`, with:

- HubSpot's lost reason exactly as entered (blank shows as "—"),
- the file's `basis` as muted text under it, when the file decided the deal,
- a marker: **inferred** when the file's entry has `"inferred": true`, **auto-mapped** when the fallback rules decided it, and none when the file's entry has `"inferred": false`.

## Shape

```json
{
  "generated_at": "2026-10-12T19:07:29-07:00",
  "deals": [
    {"deal_id": "1001", "category": "competitor", "competitor": "VendorX", "inferred": false, "basis": "Reason says they went with VendorX."},
    {"deal_id": "1002", "category": "competitor", "inferred": true, "basis": "Notes mention a cheaper alternative, not named."},
    {"deal_id": "1003", "category": "went_dark", "inferred": true, "basis": "No reply after the proposal."}
  ],
  "competitors": ["VendorX", "VendorY"]
}
```

| Field | Rule |
|---|---|
| `generated_at` | Required. ISO 8601 date-time with seconds and an explicit offset (`Z` or `±hh:mm`). The panel shows it as "Categories · Updated …" in PT. |
| `deals` | Required array of at most 2000 items. |
| `deals[].deal_id` | Required. The HubSpot deal id as a string (`"1001"`). The page's own ids carry a `deal-` prefix; it is accepted too and ignored when matching. 1–100 letters, digits, `-` or `_`. Each deal at most once. |
| `deals[].category` | Required. One of the six keys above. |
| `deals[].competitor` | Optional, and only allowed when `category` is `competitor` (otherwise absent or `null`). A non-empty string of at most 100 characters. Absent or `null` counts as "unnamed". |
| `deals[].inferred` | Required boolean. `true` when the category is Strategy's reading rather than what HubSpot's reason says. |
| `deals[].basis` | Required. Why this category, at most 500 characters. |
| `competitors` | Optional array of at most 50 names, each at most 100 characters. The fallback rules use it to recognize named competitors in deals the file doesn't list. |

Unknown fields are rejected, so a typo fails loudly. The file may be at most 2 MiB. Entries for deals that aren't closed-lost deals of the headline pipeline are ignored. Every string renders as plain text.

## Fallback rules

For a deal the file doesn't list, the page reads HubSpot's reason. Matching ignores case. A keyword matches at the start of a word (`ghost` matches "ghosted", `disqualif` matches "disqualified"), and `dark` and `later` match only as whole words. A competitor name from the file's `competitors` list must match as a whole word or phrase, and longer names are tried first. The first rule that matches decides:

1. Blank, `na` or `n/a` → `unknown`.
2. A name from the file's `competitors` list (only when a valid file is loaded) → `competitor`, with that name.
3. `status quo`, `in-house`, `in house`, `no change` → `status_quo`.
4. `competitor`, `went with`, `chose another`, `selected another vendor` → `competitor`, unnamed.
5. `irrelevant`, `not a fit`, `disqualif` → `not_a_fit`.
6. `budget`, `timing`, `later`, `next year` → `no_budget_timing`.
7. `ghost`, `no response`, `unresponsive`, `dark` → `went_dark`.
8. Anything else → `unknown`.

Why this order: a stated alternative is the most specific reason, so a named competitor wins, and staying in-house beats the generic competitor phrases ("went with an in-house build" is the status quo). Disqualification beats budget or timing. Going dark says how a deal ended, not why, so it applies only when nothing else does.

## Publishing

From the repo root:

```sh
node workspace/refresh/publish-lost-reasons.mjs /workspace/gtm-insights/lost-reasons.json
```

The script validates the file and refuses (exit 1, with a list of problems) on any error. It then compares the file's sha256 with the `sha256` metadata on `s3://opstream-gtm-preview-db5553a4/lost-reasons.json`. If they match, it uploads nothing. Otherwise it uploads with `Content-Type: application/json` and `Cache-Control: no-store`. It uses the AWS CLI with `--profile opstream-deploy` (override with `GTM_AWS_PROFILE`). Add `--dry-run` to validate and compare without uploading.

CloudFront serves the object the same way as `insights.json`: one behavior with caching disabled, reading the bucket through its origin access control, behind the preview's sign-in. The scheduled data refresh (`workspace/refresh/`) never touches `lost-reasons.json`, because its role can only write `data.js`, `refresh.json` and its own state file. `deploy.sh` uploads only the page's code.
