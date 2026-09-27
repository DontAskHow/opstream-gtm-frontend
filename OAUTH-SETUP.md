# Google sign-in for the GTM workspace

The dashboard uses the OAuth client already stored as `opstream-gtm/google-oauth-client-id` and `opstream-gtm/google-oauth-client-secret` in project `opstream-marketing-dashboard`. The callback stays `/api/gmail/oauth/callback`. Do not add a second redirect path. Sign-in uses a `user:` state and requests every scope below in that one consent, including `gmail.send` and `gmail.compose`. Sheets consent keeps using a `sheets:` state.

The assistant can prepare a ready-to-send email. Gmail sends only when the signed-in user clicks Send on that specific draft and confirms the recipients and subject. The message is sent from that user's own Gmail. The assistant has no send tool. There is no scheduled send and no bulk send. Each send is logged (time, from, to, subject, Gmail message id; not the body) to `s3://opstream-gtm-data-080403790510/state/users/<hash>/sends.json` and listed in that user's profile menu.

This repository does not record the consent screen's Publishing status. `refresh/README.md` only describes the Sheets scopes (`spreadsheets.readonly`, `drive.metadata.readonly`, `analytics.readonly`, plus `openid` and `userinfo.email`). v10 also asks for Gmail, Calendar, and Drive scopes.

## What the status means

If the consent screen is **External** and the publishing status is **Testing**:

- Refresh tokens expire after 7 days.
- Only the people listed as test users can connect.
- The dashboard then shows **Google access expired, reconnect** instead of failing silently. The person uses Sign in with Google again.

`gmail.readonly`, `gmail.compose`, and `drive.readonly` are restricted scopes. `calendar.readonly` is a sensitive scope. `gmail.send` is also a sensitive scope: an External app needs Google verification before Production, or the Workspace admin must trust this OAuth client so `@opstream.ai` users can grant it. Google requires verification before an External app can use restricted scopes in Production. An **Internal** consent screen skips that verification, but only people inside the Opstream Google Workspace can sign in. `zackkaufman39@gmail.com` is on the allow list and is not an `@opstream.ai` account, so an Internal-only screen blocks that account.

The allow list itself is `googleAllow` in `refresh-config.json`: any `@opstream.ai` address, plus `zackkaufman39@gmail.com`. It is not an Elastic Beanstalk environment property.

## What Zack clicks in Google Cloud

Project: `opstream-marketing-dashboard`.

1. APIs & Services → OAuth consent screen. Leave the user type **External** while `zackkaufman39@gmail.com` must be able to sign in.
2. Edit the app. Under scopes, add:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `.../auth/gmail.readonly`
   - `.../auth/calendar.readonly`
   - `.../auth/drive.readonly`
   - `.../auth/gmail.compose`
   - `.../auth/gmail.send` (`gmail.send` is a sensitive scope: verification for an External production app, or Workspace admin trust)
3. Under Test users, add `zackkaufman39@gmail.com` and Hollie's `@opstream.ai` address (and anyone else who will sign in while the status stays Testing).
4. APIs & Services → Credentials → the existing OAuth client. Authorized redirect URIs must include `https://d1l47t29dh34cq.cloudfront.net/api/gmail/oauth/callback`. If the live host differs, add that host with the same path. Do not add a new path.
5. APIs & Services → Library. Enable the Gmail API, Google Calendar API, and Google Drive API if they are not already enabled.
6. To stop the 7-day expiry, submit the consent screen for verification (Google will ask for a scope justification, a review of the sensitive `gmail.send` scope, and, for restricted scopes, a security assessment). Until that is approved, leave the app in Testing and expect reconnects every 7 days. The UI copy for that state is `Google access expired, reconnect`. Anyone who signed in before `gmail.send` was added must sign in again so the new consent is granted.

## What the Workspace admin allows

In the Opstream Google Workspace admin console:

1. Security → Access and data control → API controls → App access control.
2. Trust the OAuth client whose id is the value of `opstream-gtm/google-oauth-client-id`, or add it as an approved app, so `@opstream.ai` users are not blocked as an unconfigured third-party app.
3. If the admin later switches this client to **Internal**, remove `zackkaufman39@gmail.com` from `googleAllow` or give that account a user in the Workspace. Internal apps cannot sign in a consumer Gmail account.

No new server is required. Sign-in runs on the existing Elastic Beanstalk environment `opstream-gtm-prod` in `us-east-2`. The 6-hour Fargate refresh reads the same per-user secrets and writes each brief to `s3://opstream-gtm-data-080403790510/state/users/<hash>/brief.json`.
