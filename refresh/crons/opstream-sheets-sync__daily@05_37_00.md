---
id: opstream-sheets-sync
title: Opstream Sheets sync
enabled: true
owner: goal:opstream-brain-source-extension
mode: task
schedule:
  kind: daily
  timezone: America/Phoenix
  time: 05:37:00
metadata:
  tags: [cron:flexible-time]
  originating_channel_context_json: '{"originating_channel":"main","chat_kind":"direct","event_kind":"message","require_mention":false}'
  presentation_locale: en-US
---
Run the Opstream Google Sheets sync into the company brain and report the result.

Steps:
1. Run `python3 ~/workspace/brain/sync/sheets_sync.py`. It is read-only against the Sheets API (spreadsheets.get + values.batchGet) and fails closed: on any auth/rate-limit failure it exits non-zero without touching watermarks. Logs go to `~/workspace/brain/sync/logs/`.
2. Check the exit status and the latest sheets log tail.
3. Verify against `~/workspace/brain/brain.db`: `SELECT watermark, last_run, note FROM sync_state WHERE source='sheets';` — the watermark should have advanced to this run. Expect roughly 9 spreadsheets / ~80 tabs / ~22k rows; flag it if a spreadsheet drops to 0 tabs or a new spreadsheet ID appears.
4. Reporting: on success, reply with one terse line (spreadsheets/tabs/rows synced). On failure, report the error, confirm watermarks were untouched, and say the next scheduled run will retry — do not invent a manual rerun.

Do not modify the sync scripts. Do not write to any source system.
