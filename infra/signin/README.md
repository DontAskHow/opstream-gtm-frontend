# GTM preview sign-in (`gtm-preview-signin-edge`)

Google sign-in in front of the private preview (CloudFront `EZQ1E2Y6O6NDG`, S3 origin via OAC). One Lambda@Edge function runs on **viewer-request** for every request on the only (default) behavior:

```
viewer -> CloudFront EZQ1E2Y6O6NDG (Managed-CachingDisabled, so every request is checked)
  viewer-request: Lambda@Edge gtm-preview-signin-edge:<version>   (us-east-1, nodejs20.x, 128 MB, 5 s, no env vars)
     1. HTTP Basic, same credential as before, while the config secret says basic_auth_required (fail closed)
     2. signed __Host-gtm_session cookie for an allowed Google account; otherwise -> Google
     3. "/" paths -> index.html, request goes to S3
  response headers policy gtm-preview-headers-policy-db5553a4: X-Robots-Tag, Cache-Control private no-store,
     X-Content-Type-Options nosniff, Referrer-Policy no-referrer (the same four the old headers function set)
```

CloudFront rejects a behavior that has a CloudFront Function on any viewer event alongside Lambda@Edge on any viewer event (`InvalidLambdaFunctionAssociation`). So both CloudFront Functions (`gtm-preview-auth-db5553a4` and `gtm-preview-headers-db5553a4`) are disassociated, not deleted. The Lambda enforces the Basic credential itself, and a response headers policy (no code, no per-request charge) sets the headers. `rollback.sh` restores the original configuration exactly.

## Flow

| Request | Response |
|---|---|
| no/wrong Basic credential (while required) | `401` with the same `WWW-Authenticate: Basic realm="Opstream GTM preview"` |
| no valid session, page navigation | `302` to `https://accounts.google.com/o/oauth2/v2/auth` (`scope=openid email`, `prompt=select_account`, random `state` + `nonce`, PKCE S256). It also sets `__Host-gtm_state` (HMAC-signed `{state, nonce, verifier, returnTo}`, 10 min). `returnTo` is a same-origin path only. |
| no valid session, script/fetch (`Sec-Fetch-Mode` not `navigate`) | `403`, no new state cookie (so a background fetch can't clobber a sign-in in progress) |
| `/_auth/callback` | The state cookie must verify and match `state`. The code is exchanged at `oauth2.googleapis.com/token` (with the PKCE verifier). The `id_token` is checked: RS256 against Google's JWKS (cached 1 h, refetched once for an unknown `kid`), `aud`, `azp`, `iss`, `exp`, `nonce`, `email_verified === true`. An allowed account gets `302` back to `returnTo` plus a session cookie. Any other account gets `403` with a sign-out link. A bad or missing state gets `400`. |
| `/_auth/logout` | `200` signed-out page, both cookies cleared |

**Allowed accounts**: a verified Google email ending in `@opstream.ai` (the whole suffix including `@`, case-insensitive), or the one named address in `edge/lib.js`. **Session**: `__Host-gtm_session` = base64url(`{email, iat, exp}`) + HMAC-SHA256, 12 h, `HttpOnly; Secure; SameSite=Lax; Path=/`. Verification is constant-time and rejects malformed, tampered, expired or over-long sessions, and re-checks the allowlist. Every generated response is `no-store`.

## Secrets (no values in this repo)

| Secret | Region | Content |
|---|---|---|
| `opstream-gtm/google-oauth-client-id`, `opstream-gtm/google-oauth-client-secret` | us-east-2 | existing Google OAuth web client (read only) |
| `opstream-gtm/preview-session-key` | us-east-1 | 48 random bytes (hex), HMAC key for both cookies |
| `opstream-gtm/preview-edge-config` | us-east-1 | `{"basic_auth_required": true, "basic_auth_sha256": sha256("user:password")}` |

The function reads all four at cold start and caches them for 5 minutes. A refresh that fails, or takes over 1.5 s, falls back to the cached copy for up to 1 h. With no copy at all, it returns `503`. Lambda@Edge has no environment variables, so the names are constants in `edge/index.js`. Viewer triggers are limited to 128 MB, which also means little CPU, and to 5 s. Loading AWS SDK v3 took a cold start to ~4.3 s, so the function signs `GetSecretValue` (SigV4) itself over one keep-alive socket per region. A cold start now takes ~0.9–1.1 s and a warm request ~2–20 ms.

The role `gtm-preview-signin-edge-role` (trusted by `lambda` and `edgelambda`) can only call `secretsmanager:GetSecretValue` on exactly those four ARNs and write its own log groups (`/aws/lambda/us-east-1.gtm-preview-signin-edge` in whichever region served the request).

## Scripts

```sh
infra/signin/deploy.sh             # secrets (create-if-missing), role, function + numbered version, headers policy, distribution; waits for Deployed
infra/signin/rollback.sh           # back to the two CloudFront Functions exactly as before (Basic only)
infra/signin/set-basic-auth.sh off # drop the Basic gate (no code change; live within ~5 min). "on" restores it.
node --test test/signin-edge.test.mjs
```

`deploy.sh` is idempotent: unchanged code and config reuse the last version, and an unchanged distribution is not updated. Secret values go through `secret.py` (boto3, stdin) and are never printed or put on a command line.

## Cutover

1. Add `https://d3m8bzysq99qfh.cloudfront.net/_auth/callback` to the OAuth client's **Authorized redirect URIs** in Google Cloud Console.
2. Sign in with an `@opstream.ai` account (expect the page) and with a non-allowed Google account (expect the 403 page).
3. `infra/signin/set-basic-auth.sh off`.
4. Later, once nothing needs `rollback.sh`, delete the CloudFront Function `gtm-preview-auth-db5553a4`.
