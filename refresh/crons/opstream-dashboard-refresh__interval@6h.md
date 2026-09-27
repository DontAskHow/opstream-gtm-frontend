---
id: opstream-dashboard-refresh
title: Opstream dashboard data refresh
enabled: true
owner: goal:opstream-gtm-dashboard
mode: task
schedule:
  kind: interval
  timezone: America/Phoenix
  at: 2026-09-25T07:32:02
  every: 6h
metadata:
  tags: [cron:automatic-interval-anchor]
  originating_channel_context_json: '{"originating_channel":"main","chat_kind":"direct","event_kind":"message","require_mention":false,"device_id":"d28748205c968530"}'
  presentation_locale: en-US
---
Refresh the Opstream GTM dashboard on its real data. Steps, in order:
1. `cd ~/workspace/opstream-gtm-frontend && npm run build` — this regenerates `out/data/*.json` from the company-brain DB (`~/workspace/brain/brain.db`) via `scripts/brain-data.py`, then reconciles the team's manual pipeline sheet (`pipeline_meeting1_v2`: HS_Data stages, Forecast buckets/targets, Lead Tracker) against the HubSpot extract via `scripts/sheet-review.py` → `out/data/sheet-review.json`, then refreshes Hollie's operator output (`out/data/hollie.json`) via `scripts/hollie-operator.py` (queue items carry a `goal`: land the commit / turn best case into commit / keep the pipeline fed / keep the forecast honest), then regenerates her LLM-written morning brief (`out/data/agent-brief.json`) via `scripts/agent-brief.py`, then runs the heartbeat (`scripts/heartbeat.py`) → `out/data/heartbeat.json`: a health check of the build output plus 3-5 proactive, LLM-written insights about what's new or changed (fail-soft by design: a heartbeat failure never breaks the build).
2. Sanity check: `out/data/verified.json` must parse and carry a `snapshotId`; `out/data/hollie.json` must parse with a `queue` array and a `goals` array; `out/data/sheet-review.json` must parse. `out/data/agent-brief.json` and `out/data/heartbeat.json` should parse too — if either is missing or stale, note it as a warning but do NOT treat the build as failed.
3. Read `out/data/heartbeat.json`. If `health.status` is `warning`, or any insight has `priority: "high"`, that is worth the user's attention: send a short chat message summarizing the health notes / high-priority insights (concrete names and numbers, no fluff). Otherwise stay silent on success.
4. Only if the build succeeded, restart the agent server so `/api/ask` re-grounds on the fresh data. Do NOT use `pkill -f` with a literal pattern — it matches the invoking shell's own command line and kills it. Instead: `PID=$(grep -o '[0-9]*' /tmp/agent-server.pid 2>/dev/null); [ -n "$PID" ] && kill $PID 2>/dev/null; sleep 2;` then `cd ~/workspace/opstream-gtm-frontend && (setsid nohup node scripts/agent-server.mjs >> /tmp/agent-server.log 2>&1 &)` then record the new PID with `ss -tlnp 2>/dev/null | grep 4173 | grep -o 'pid=[0-9]*' | head -1 > /tmp/agent-server.pid`. Verify with `curl -s -m 10 http://127.0.0.1:4173/api/health` (expect `{"ok":true,...}`).
5. If the build fails, do NOT restart the server — leave the last good data serving and record the build error.

If anything failed, report what failed and what you left running. Log observations to `~/memory/YYYY-MM-DD.md` (today's date), never edit `MEMORY.md` directly.
