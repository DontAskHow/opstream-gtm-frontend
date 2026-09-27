# Company-brain incremental syncs

The refresh job runs these files. `common.py`, `sheets_sync.py`, and
`lemlist_sync.py` read Secrets Manager (`opstream-gtm/<name>`) instead of the
vault CLI. The other four scripts are unchanged and pick that up through
`common.authed_request`. A missing secret is skipped by `refresh/run.py`
before the script starts.



Incremental, read-only sync scripts for the company brain (`~/workspace/brain/brain.db`).
Each script pulls only what changed since its watermark, upserts into the DB,
then advances the watermark in `sync_state`. On any auth failure the script
exits non-zero **without touching watermarks**.

## Scripts

| Script | Source | Incremental key | Notes |
|---|---|---|---|
| `hubspot_sync.py` | HubSpot portal 21303277 | per-object-type `hs_lastmodifieddate` / `lastmodifieddate` watermark | 10 object types; **tickets excluded** (outside registered scope); associations refreshed for changed objects only; 100 req/10s pacing; long text truncated at 8000 chars |
| `fathom_sync.py` | Fathom | `recording_start_time` watermark | New meetings get detail + transcript + summary + action items; `meetings`, `transcripts`, `transcript_fts` updated |
| `sheets_sync.py` | Google Sheets | n/a (full re-pull, 15,718 rows) | Re-pulls the 9 tracked spreadsheets, all tabs, via `hatch_gws_cli`; per-spreadsheet atomic replace |
| `lemlist_sync.py` | Lemlist | n/a (full campaign refresh, 20 campaigns) | Fills per-campaign stats where the API exposes them; leaves null otherwise |
| `ga4_sync.py` | GA4 property 304508954 | n/a (re-runs 30d report) | sessions / totalUsers / screenPageViews |
| `otterly_sync.py` | Otterly | n/a (re-fetches 2 brand reports) | **Quota-gated**: checks usage first; skips entirely if >50% of monthly quota used, or if quota can't be determined (fail closed) |

## Credentials

- `hubspot` / `fathom` / `lemlist` / `otterly`: vault connectors `custom.hubspot`,
  `custom.fathom`, `custom.lemlist`, `custom.otterly` (register with
  `credentials.request_api_access`, then scaffold skills if desired). Surrogate
  tokens are sent only to each provider's documented hosts.
- `sheets`: Google Workspace connector via `hatch_gws_cli` (`google_sheets` credential).
- `ga4`: vault connector `custom.google-analytics` (fallbacks: `google.analytics`, `custom.google`).
- No Gmail sync exists or is planned (permission limited to engagement-evidence search).
- Slack is never touched (removed at Zack's request).

## Running

```bash
cd ~/workspace/brain/sync
python3 hubspot_sync.py   # etc.
```

Exit codes: `0` success · `1` error (watermarks untouched) · `3` needs connection.

Logs: `logs/<source>-YYYYMMDD.log`.

## Scope rules (do not change without Zack)

- Read-only against all source systems. No writes, no messages, no sync schedules to sources.
- Tickets excluded from HubSpot. Slack excluded everywhere. Gmail not synced.
- Never invent records; missing fields stay null.

## Recommended cron cadence (not yet created — wire after review)

| Script | Cadence | Rationale |
|---|---|---|
| `fathom_sync.py` | every 2h, weekdays 6a–8p Phoenix | meetings land during work hours; Hollie's prep/follow-ups depend on freshness |
| `hubspot_sync.py` | every 6h | CRM changes steadily; incremental deltas are cheap |
| `sheets_sync.py` | daily ~5:30a Phoenix | budget/ad sheets update at most daily |
| `lemlist_sync.py` | daily ~5:45a Phoenix | campaign stats move daily |
| `ga4_sync.py` | daily ~6a Phoenix | 30d rolling report |
| `otterly_sync.py` | weekly Mon ~6a Phoenix | brand reports recalculate slowly; quota-gated anyway |

All times America/Phoenix. Order in the morning batch: hubspot → fathom → sheets → lemlist → ga4 → otterly.
After syncs run, rebuild the dashboard data (`npm run build` in
`~/workspace/opstream-gtm-frontend`) so Hollie's operator sees fresh data.
