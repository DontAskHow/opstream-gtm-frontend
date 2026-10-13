# Analysis file (`insights.json`)

The GTM workspace's **Analysis** panel (overview page) shows one JSON file, `/insights.json`, written by the Strategy seat. The page reads it with `fetch('insights.json', {cache: 'no-store'})`, validates it, and renders every string as plain text with `textContent`. Nothing in the file is parsed as HTML or turned into a link. If the file is missing (S3 behind CloudFront answers 403 or 404), the panel shows **"No insights published yet"**. If the file is there but invalid, the panel shows the same title and says the file doesn't match the format. A partial file is never shown.

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
  "changed_since_last": "What changed since the previous file (a string, or an array of strings)."
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
| `changed_since_last` | Required. A string, or an array of ≤ 50 strings. |

Every string must be non-empty. Unknown fields at any level are rejected, so a typo such as `why_it_maters` fails loudly instead of disappearing. The whole file must be ≤ 256 KB.

## Publishing

```sh
node /workspace/gtm-refresh15/workspace/refresh/publish-insights.mjs /workspace/gtm-insights/insights.json
```

The script validates the file and refuses (exit 1, with a list of problems) on any error. It then compares the file's sha256 with the `sha256` metadata on `s3://opstream-gtm-preview-db5553a4/insights.json`. If they match, it uploads nothing. Otherwise it uploads with `Content-Type: application/json` and `Cache-Control: no-store`. It uses the AWS CLI with `--profile opstream-deploy` (override with `GTM_AWS_PROFILE`). Add `--dry-run` to validate and compare without uploading.

The scheduled data refresh (`workspace/refresh/`) never touches `insights.json`.
