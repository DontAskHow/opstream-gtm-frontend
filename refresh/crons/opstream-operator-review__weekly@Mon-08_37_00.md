---
id: opstream-operator-review
title: Weekly Hollie operator review
enabled: true
owner: goal:opstream-gtm-dashboard
mode: task
schedule:
  kind: weekly
  timezone: America/Phoenix
  time: 08:37:00
  dow: [Mon]
metadata:
  tags: [cron:flexible-time]
  originating_channel_context_json: '{"originating_channel":"main","chat_kind":"direct","event_kind":"message","require_mention":false,"device_id":"d28748205c968530"}'
  presentation_locale: en-US
---
Weekly review of how the Opstream GTM dashboard's invisible operator is serving Hollie. Read-only review:
1. Read `~/workspace/opstream-gtm-frontend/out/data/hollie-feedback.json` (her Dismiss/Done actions, if any), `~/workspace/opstream-gtm-frontend/var/hollie-operator-state.json` (what was surfaced and when), and `~/workspace/brain/sync/logs/` (latest sync runs, if the sync scripts exist yet).
2. Look for patterns: queue kinds she dismisses repeatedly, items that never get actioned, sync failures, or autonomy tiers that look miscalibrated.
3. If you see a clear, safe improvement (e.g. stop surfacing a queue kind she always dismisses, adjust a threshold), make the minimal change to `scripts/hollie-operator.py` or `scripts/hollie-autonomy.json` and note it. Never change `send_anything` or `external_messages` away from `never`. Never touch `~/workspace/brain/brain.db` except reads.
4. Report to Zack in chat ONLY if there is something actionable or genuinely worth knowing (a pattern in her usage, a needed decision, a broken sync). Otherwise stay silent.

Log observations to `~/memory/YYYY-MM-DD.md` (today's date), never edit `MEMORY.md` directly.
