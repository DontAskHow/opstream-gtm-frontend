# Opstream GTM frontend

Frontend and refresh job for the Opstream GTM workspace: pipeline, marketing, meetings and drafts from HubSpot, the master Sheet, Fathom, GA4, LemList and Otterly.

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
- Signed-in Google session, browser-local drafts and preferences, and the confirmed Gmail send in `account-session.js`.

The database, credentials, company snapshots, transcripts and deployment settings are not in this repository. The refresh job publishes the collection to S3 and each server instance swaps it in.

`source/workspace.html` is the assembled, data-cleaned UI template. The standalone HTML fragments and CSS are also retained for reference; the build uses the assembled template.

The existing runtime loads React 18, React DOM, Babel and Archivo from their public CDNs, so viewing requires internet access. Their upstream licenses apply. No new project license is granted by this publication.

## Verification

End-to-end suites (Google, HubSpot, LemList, Otterly and OpenAI are mocked at the HTTP boundary; nothing leaves the machine):

```sh
npm run build
node scripts/check-cta-buttons.mjs      # every Today, Events, Pipeline, Accounts, Meetings and Drafts button
node scripts/check-v13.mjs              # identity header, owner names, stale-run guard, v13 review fixes, banned terms
node scripts/check-marketing-home.mjs
python3 scripts/check-source-syncs.py   # refresh/run.py against mocked source APIs
npm run security:scan
```

Set `CHROME_PATH` to a Chrome executable if it is not at `/usr/local/bin/google-chrome`.
