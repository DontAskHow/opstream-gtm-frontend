# Claude Code entry point

Public frontend source for a GTM workspace demo. All data is synthetic.
Read `README.md` and `verification/README.md` first.

## Commands

Requires Node.js 22 or newer.

```sh
npm ci                 # install devDependencies (esbuild, marked, @playwright/test)
npm run build          # node build.cjs -> static files in out/
npm run dev            # node scripts/preview.mjs -> serves out/ at http://127.0.0.1:4173 (PORT overrides)
npm run security:scan  # scan Git-visible files for private keys and provider tokens
```

Browser check, with `npm run dev` running in another terminal:

```sh
npx playwright install chromium   # or set BROWSER_PATH to an installed Chrome/Edge
node scripts/verify-preview.cjs   # PREVIEW_URL overrides http://127.0.0.1:4173
```

`verify-preview.cjs` rewrites `verification/desktop.png`, `verification/mobile.png` and
`verification/result.json`. Commit those only when you mean to update the recorded results.

There is no deploy script in this repo.

## Layout

- `source/workspace.html`: assembled UI template; `build.cjs` inlines the root UI modules into it.
- Root `*.js` / `*.cjs` / `*.mjs`: UI modules. `draft-history.js` is legacy and not loaded by the build.
- `scripts/synthetic-data.cjs`: fictional fixture generator, run by the build.
- `demo-mode.js`: browser-local demo adapter (stores changes in the current browser only).

## Invariants

- Synthetic data only. Never add real companies, contacts, metrics, transcripts or drafts.
- Never commit credentials, `.env*`, databases, `out/` or `node_modules/` (all gitignored).
- Email, Slack and authentication stay disabled in the demo; `verify-preview.cjs` asserts the
  Send email button is disabled.
- The preview server serves only `out/`; `verify-preview.cjs` asserts `/.git/config` returns 404.

## Hard stops

- This repo is public. Do not add internal names, hosts, keys, backend config or private history.
- Run `npm run security:scan` before every push; it must print `PASS`.
