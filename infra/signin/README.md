# GTM preview sign-in (`gtm-preview-signin-edge`)

Google sign-in in front of the private preview (CloudFront `EZQ1E2Y6O6NDG`, S3 origin via OAC). One Lambda@Edge function runs on **viewer-request** for every request on the only (default) behavior:

```
viewer -> CloudFront EZQ1E2Y6O6NDG (Managed-CachingDisabled, so every request is checked)
  viewer-request: Lambda@Edge gtm-preview-signin-edge:<version>   (us-east-1, nodejs20.x, 128 MB, 5 s, no env vars)
     1. HTTP Basic, same credential as before, while the config secret says basic_auth_required (fail closed)
     2. signed __Host-gtm_session cookie for an allowed Google account; otherwise -> Google
     3. "/" paths -> index.html, request goes to S3
  response headers policy gtm-preview-headers-policy-db5553a4: X-Robots-Tag, Cache-Control private no-store,
     X-Content-Type-Options nosniff, Referrer-Policy no-referrer (the same four the old headers function set),
     plus Strict-Transport-Security max-age=31536000
```

CloudFront rejects a behavior that has a CloudFront Function on any viewer event alongside Lambda@Edge on any viewer event (`InvalidLambdaFunctionAssociation`). So both CloudFront Functions (`gtm-preview-auth-db5553a4` and `gtm-preview-headers-db5553a4`) are disassociated, not deleted. The Lambda enforces the Basic credential itself, and a response headers policy (no code, no per-request charge) sets the headers. `rollback.sh` restores the original configuration exactly.

## Flow

| Request | Response |
|---|---|
| no/wrong Basic credential (while required) | `401` with the same `WWW-Authenticate: Basic realm="Opstream GTM preview"` |
| no valid session, page navigation | `302` to `https://accounts.google.com/o/oauth2/v2/auth` (`scope=openid email`, `prompt=select_account`, random `state` + `nonce`, PKCE S256). It also sets `__Host-gtm_state` (HMAC-signed `{state, nonce, verifier, returnTo}`, 10 min). `returnTo` is a same-origin path only. |
| no valid session, script/fetch (`Sec-Fetch-Mode` not `navigate`) | `403`, no new state cookie (so a background fetch can't clobber a sign-in in progress) |
| `/_auth/callback` | The state cookie must verify and match `state`. The code is exchanged at `oauth2.googleapis.com/token` (with the PKCE verifier). The `id_token` is checked: RS256 against Google's JWKS (cached 1 h, refetched once for an unknown `kid`), `aud`, `azp`, `iss`, `exp`, `nonce`, `email_verified === true`, then the allowlist (with `hd`, below). An allowed account gets `302` back to `returnTo` plus a session cookie. Any other account gets `403` with a sign-out link. A bad or missing state gets `400`. |
| `/_auth/logout` | `200` signed-out page, both cookies cleared |

**Allowed accounts**: a verified Google email ending in `@opstream.ai` (the whole suffix including `@`, case-insensitive) **whose id_token has `hd` = `opstream.ai`**, i.e. an account of the opstream.ai Google Workspace, or the one named Gmail address in `edge/lib.js` (exact match). Google is only authoritative for a non-Gmail address when `hd` is present: a consumer Google account registered under an `@opstream.ai` address (for example one an employee made before offboarding) has `email_verified: true` but no `hd`, and is refused. **Session**: `__Host-gtm_session` = base64url(`{email, hd, iat, exp}`) + HMAC-SHA256, 12 h, `HttpOnly; Secure; SameSite=Lax; Path=/`. Verification is constant-time and rejects malformed, tampered, expired or over-long sessions, and re-checks the allowlist including `hd` on every request. Every generated response is `no-store`.

**Time budget** (viewer-request has a hard 5 s limit, and going over is a CloudFront 503): every HTTP request has a total deadline, not just a socket-idle timeout. Secrets Manager reads get 2 s each (a cold start takes ~1 s). In `/_auth/callback`, the token exchange and the JWKS fetch share what is left of 3.8 s from the start of the invocation, and Google calls are capped at 2 s each. A slow Google answer gives a `502` sign-in-failed page and no session.

## Secrets (no values in this repo)

| Secret | Region | Content |
|---|---|---|
| `opstream-gtm/google-oauth-client-id`, `opstream-gtm/google-oauth-client-secret` | us-east-2 | existing Google OAuth web client (read only) |
| `opstream-gtm/preview-session-key` | us-east-1 | 48 random bytes (hex), HMAC key for both cookies |
| `opstream-gtm/preview-edge-config` | us-east-1 | `{"basic_auth_required": true, "basic_auth_sha256": sha256("user:password")}` |

The function reads all four at cold start and caches them for 5 minutes. A refresh that fails, or takes over 1.5 s, falls back to the cached copy for up to 1 h. With no copy at all, it returns `503`. Lambda@Edge has no environment variables, so the names are constants in `edge/index.js`. Viewer triggers are limited to 128 MB, which also means little CPU, and to 5 s. Loading AWS SDK v3 took a cold start to ~4.3 s, so the function signs `GetSecretValue` (SigV4) itself over one keep-alive socket per region. A cold start now takes ~0.9–1.1 s and a warm request ~2–20 ms.

A config secret that is not a JSON object makes the function return `503` (fail closed), and the log line says only `edge config is not JSON` (the parser's own message would quote the value).

The role `gtm-preview-signin-edge-role` (trusted by `lambda` and `edgelambda`) can only call `secretsmanager:GetSecretValue` on exactly those four ARNs and write its own log groups (`/aws/lambda/us-east-1.gtm-preview-signin-edge` in whichever region served the request). `deploy.sh` sets 14-day retention on every such log group that exists; a region that starts serving traffic later gets a new group with no expiry until `deploy.sh` is re-run.

## Scripts

```sh
infra/signin/deploy.sh             # secrets (create-if-missing), role, function + numbered version, headers policy, distribution; waits for Deployed
infra/signin/rollback.sh           # back to the two CloudFront Functions exactly as before (Basic only)
infra/signin/set-basic-auth.sh off # drop the Basic gate (asks to type "off"; --yes skips). Live within ~5 min, 1 h worst case. "on" restores it.
node --test test/signin-edge.test.mjs
```

`set-basic-auth.sh` checks the AWS account, needs an explicit `on` or `off`, and only a JSON `false` in the secret turns Basic off (`"false"`, missing or malformed keep it on). One-command wrappers outside the repo: `/workspace/gtm-signin/basic-auth-off.sh` and `basic-auth-on.sh`.

`deploy.sh` is idempotent: unchanged code and config reuse the last version, and an unchanged distribution is not updated. Secret values go through `secret.py` (boto3, stdin) and are never printed or put on a command line.

## Cutover

1. Add `https://d3m8bzysq99qfh.cloudfront.net/_auth/callback` to the OAuth client's **Authorized redirect URIs** in Google Cloud Console.
2. Sign in with an `@opstream.ai` account (expect the page) and with a non-allowed Google account (expect the 403 page).
3. `infra/signin/set-basic-auth.sh off`.
4. Later, once nothing needs `rollback.sh`, delete the CloudFront Function `gtm-preview-auth-db5553a4`.

## Revoking access

There is no per-user revocation. The allowlist (email and `hd`) is re-checked on every request, but a session cookie stays valid for up to 12 h after someone is offboarded: a suspended Workspace account can't sign in again, yet its existing cookie still verifies. **Kill switch:** replace the session HMAC key. That signs everyone out, and every edge picks it up within ~5 min (up to 1 h at an edge that can't reach Secrets Manager). The value goes through stdin and is never shown:

```sh
openssl rand -hex 48 | tr -d '\n' | python3 -c 'import sys, boto3
boto3.Session(profile_name="opstream-deploy").client("secretsmanager", region_name="us-east-1").put_secret_value(
    SecretId="opstream-gtm/preview-session-key", SecretString=sys.stdin.read())'
```

## Rotating the Basic credential (for a human; not automated)

While Basic is on, and for `rollback.sh` (which puts Basic back as the only gate), the credential is only as good as its secrecy. To rotate it, change all three together: the hardcoded value in the CloudFront Function `gtm-preview-auth-db5553a4` (then publish it), `basic_auth_sha256` in `opstream-gtm/preview-edge-config` (sha256 hex of `user:newpassword`), and `/workspace/gtm-preview-credentials.txt`. Until the edges pick up the new hash (~5 min) the old credential still works on the Lambda path.

