# Public frontend verification — 2026-09-25

Inputs: only the invented records in `scripts/synthetic-data.cjs`; a fresh browser context; local preview on port 4173. No application database or provider credentials.

Failure modes and expected outcomes: all navigation views must render without exceptions; account details must resolve synthetic records; stars and draft edits must survive reload; comments must save; email must remain disabled; 390px layout must fit; the static server must not expose `.git`.

Setup and rerun:

```powershell
npm ci
npm run build
# Keep this running in a separate terminal:
npm run dev
# Verified here using installed Microsoft Edge:
$env:BROWSER_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node scripts/verify-preview.cjs
npm run security:scan
```

For bundled Chromium, run `npx playwright install chromium` and omit `BROWSER_PATH`.

Actual outcome: all listed browser checks passed. See `result.json`, `desktop.png`, and `mobile.png`. The build succeeded. The Git-visible source scan found no detected provider tokens or private keys. The public copy excludes original data files, production backend/configuration and Git history; inline customer records and business metrics were replaced with synthetic/empty fixtures.

Earlier failures: the initial assembly used a JavaScript replacement string containing dollar sequences, corrupting the generated component. Switching to a replacement callback corrected it. The first persistence check reloaded before the debounced save; the final check waits for the persisted value before reloading. The first temporary tunnel inherited an unrelated ingress configuration and returned 404; a dedicated configuration resolved it. These are not claimed as first-pass successes.

Limits: browser-local demonstration only; no production authentication, shared multi-user persistence, Slack or Gmail verification. The browser checks do not exercise every filter or export. Public CDN availability is required for the existing runtime and font. The temporary preview returns HTTP 200 and serves only `out/` while the local preview and tunnel remain running.
