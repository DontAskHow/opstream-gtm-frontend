# Opstream GTM frontend

Public frontend source for the GTM workspace, with entirely synthetic companies, contacts, pipeline, marketing metrics, meetings and drafts.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
npm run dev
```

Open http://127.0.0.1:4173. The build writes static files to `out/`.

## Included

- Responsive Today, Performance, Accounts, Meetings, Drafts and Data views.
- Priority stars, comments and mentions, account details, evidence drawers, filters, charts, CSV exports, draft composition and version controls.
- Component template in `source/workspace.html`, original UI modules at the root, styles and design-system runtime under `source/`.
- Fictional fixture generator in `scripts/synthetic-data.cjs` and browser-local demo adapter in `demo-mode.js`.

The demo stores changes only in the current browser. Email, Slack and authentication are disabled. The production backend, databases, credentials, company snapshots, transcripts, original draft text, deployment settings and private Git history are excluded. Production API integration code remains in `collaboration.js`; the demo adapter substitutes local behavior.

`source/workspace.html` is the assembled, data-cleaned UI template. The standalone HTML fragments and CSS are also retained for reference; the build uses the assembled template. `draft-history.js` is a retained legacy helper, not loaded by the current build.

The existing runtime loads React 18, React DOM, Babel and Archivo from their public CDNs, so viewing requires internet access. Their upstream licenses apply. No new project license is granted by this publication.

## Verification

With the preview running:

```sh
npx playwright install chromium
node scripts/verify-preview.cjs
npm run security:scan
```

Alternatively set `BROWSER_PATH` to an installed Chrome/Edge executable. See `verification/README.md` for the recorded results and limitations.
