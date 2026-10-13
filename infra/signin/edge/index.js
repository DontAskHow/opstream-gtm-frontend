'use strict';
// GTM preview sign-in: Lambda@Edge, viewer-request, default behavior of distribution EZQ1E2Y6O6NDG.
//
//   1. HTTP Basic (the pre-existing preview gate), while the config secret says basic_auth_required.
//   2. A Google session (signed __Host-gtm_session cookie) for an allowed account.
// Both must pass; then "/" paths get index.html (as the old CloudFront Function did) and the request goes to S3.
//
// Lambda@Edge has no environment variables, so the Secrets Manager names are constants and
// the values are read at cold start and cached for CONFIG_TTL_MS. Nothing secret is logged.
//
// Viewer triggers get 128 MB (a small CPU share) and a 5 s limit. Loading AWS SDK v3 and opening a
// TLS connection per request took ~4.3 s cold, so this signs GetSecretValue with SigV4 itself and
// keeps one keep-alive socket per host.
const crypto = require('node:crypto');
const https = require('node:https');
const L = require('./lib.js');

const SECRETS = {
  clientId: { region: 'us-east-2', id: 'opstream-gtm/google-oauth-client-id' },
  clientSecret: { region: 'us-east-2', id: 'opstream-gtm/google-oauth-client-secret' },
  sessionKey: { region: 'us-east-1', id: 'opstream-gtm/preview-session-key' },
  edgeConfig: { region: 'us-east-1', id: 'opstream-gtm/preview-edge-config' },
};
const CONFIG_TTL_MS = 5 * 60 * 1000;
const CONFIG_MAX_STALE_MS = 60 * 60 * 1000; // serve a stale config this long if Secrets Manager is unreachable
const REFRESH_WAIT_MS = 1500; // a warm instance waits at most this long for a refresh before using its cached copy
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 60 * 60 * 1000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const HTTP_TIMEOUT_MS = 3000;

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

// ---------- default I/O ----------
const agents = {};
function request(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  agents[u.host] = agents[u.host] || new https.Agent({ keepAlive: true, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    const req = https.request(u, { method, headers, agent: agents[u.host], timeout: HTTP_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode, body: json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + u.host)));
    req.on('error', reject);
    req.end(body);
  });
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

// AWS Signature V4 for a JSON-1.1 POST to "/" (Secrets Manager). Credentials come from the
// Lambda runtime's environment (the edge role).
function signAwsJson({ region, service, target, body, creds, date = new Date() }) {
  const host = `${service}.${region}.amazonaws.com`;
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = { 'content-type': 'application/x-amz-json-1.1', host, 'x-amz-date': amzDate, 'x-amz-target': target };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = ['POST', '/', '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), sha256hex(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = ['aws4_request'].reduce(hmac, hmac(hmac(hmac('AWS4' + creds.secretAccessKey, day), region), service));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(key, toSign).toString('hex')}`;
  return { url: `https://${host}/`, headers };
}

async function getSecretValue({ region, id }) {
  const creds = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
  const body = JSON.stringify({ SecretId: id });
  const { url, headers } = signAwsJson({ region, service: 'secretsmanager', target: 'secretsmanager.GetSecretValue', body, creds });
  const { status, body: res } = await request(url, { method: 'POST', headers, body });
  if (status !== 200 || !res || typeof res.SecretString !== 'string') {
    throw new Error(`GetSecretValue ${id} failed: ${status} ${res && (res.__type || res.message) || ''}`.trim());
  }
  return res.SecretString.trim();
}

async function readSecrets() {
  // One socket per region: the two secrets in a region share it (one TLS handshake per region).
  const [clientId, clientSecret, sessionKey, edgeConfig] = await Promise.all(
    [SECRETS.clientId, SECRETS.clientSecret, SECRETS.sessionKey, SECRETS.edgeConfig].map(getSecretValue));
  const cfg = JSON.parse(edgeConfig);
  if (!clientId || !clientSecret || sessionKey.length < 32) throw new Error('incomplete sign-in config');
  return {
    clientId, clientSecret, sessionKey,
    // Fail closed: only an explicit false turns the Basic gate off.
    basicAuthRequired: cfg.basic_auth_required !== false,
    basicAuthSha256: typeof cfg.basic_auth_sha256 === 'string' ? cfg.basic_auth_sha256.toLowerCase() : '',
  };
}

async function fetchJwks() {
  const { status, body } = await request(JWKS_URL);
  if (status !== 200 || !body || !Array.isArray(body.keys)) throw new Error('jwks fetch failed: ' + status);
  return body;
}

async function exchangeCode({ code, verifier, clientId, clientSecret }) {
  const form = new URLSearchParams({
    code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret,
    redirect_uri: L.REDIRECT_URI, grant_type: 'authorization_code',
  }).toString();
  const { status, body } = await request(TOKEN_URL, {
    method: 'POST', body: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) },
  });
  if (status !== 200 || !body || typeof body.id_token !== 'string') {
    // Only Google's error code, never the response body (it can carry tokens).
    throw new Error('token exchange failed: ' + status + ' ' + (body && typeof body.error === 'string' ? body.error : ''));
  }
  return body.id_token;
}

// ---------- caches ----------
// Loads on first use and after ttlMs. While a usable older value exists (younger than maxStaleMs), a
// refresh that fails, or takes longer than refreshWaitMs, returns that value; the refresh keeps going
// and is picked up by a later request.
const SLOW = Symbol('slow');
function cached(load, ttlMs, maxStaleMs, refreshWaitMs = Infinity) {
  let value, at = 0, inflight = null;
  return async function get({ force = false, now = Date.now() } = {}) {
    if (value !== undefined && !force && now - at < ttlMs) return value;
    if (!inflight) {
      inflight = load().then((v) => { value = v; at = Date.now(); return v; }).finally(() => { inflight = null; });
      inflight.catch(() => {}); // nobody may be waiting on it any more
    }
    const usable = value !== undefined && now - at < maxStaleMs;
    try {
      if (!usable || force || refreshWaitMs === Infinity) return await inflight;
      let timer;
      const slow = new Promise((resolve) => { timer = setTimeout(resolve, refreshWaitMs, SLOW); });
      const r = await Promise.race([inflight, slow]).finally(() => clearTimeout(timer));
      if (r === SLOW) { log('stale-cache', { error: 'refresh slow' }); return value; }
      return r;
    } catch (err) {
      if (usable) { log('stale-cache', { error: err.message }); return value; }
      throw err;
    }
  };
}

// ---------- handler ----------
function createHandler(deps = {}) {
  const now = deps.now || (() => Date.now());
  const getConfig = deps.getConfig || cached(deps.readSecrets || readSecrets, CONFIG_TTL_MS, CONFIG_MAX_STALE_MS, REFRESH_WAIT_MS);
  const getJwks = deps.getJwks || cached(fetchJwks, JWKS_TTL_MS, JWKS_TTL_MS * 24);
  const exchange = deps.exchangeCode || exchangeCode;
  const random = deps.random || ((n) => crypto.randomBytes(n));
  let lastJwksRefresh = 0;

  async function verifyWithJwks(idToken, opts) {
    let r = L.verifyIdToken(idToken, { ...opts, jwks: await getJwks() });
    // Google rotates keys; refetch once (at most every 60 s) when the kid is new to us.
    if (!r.ok && r.reason === 'unknown-kid' && now() - lastJwksRefresh > 60000) {
      lastJwksRefresh = now();
      r = L.verifyIdToken(idToken, { ...opts, jwks: await getJwks({ force: true }) });
    }
    return r;
  }

  function startSignIn(request, cfg, nowS) {
    // Script/subresource fetches can't follow a redirect to Google usefully, and starting a sign-in
    // for each would overwrite the state cookie of a real navigation. Only navigations start one.
    const mode = L.header(request, 'sec-fetch-mode');
    if (mode && mode !== 'navigate') {
      return L.respond(403, 'Forbidden', { body: L.page('Sign-in required', '<p>Your session has ended. <a href="/">Sign in again</a>.</p>') });
    }
    const state = L.b64url(random(24)), nonce = L.b64url(random(24)), verifier = L.b64url(random(32));
    const challenge = L.b64url(crypto.createHash('sha256').update(verifier).digest());
    const returnTo = L.safeReturnPath(request.uri + (request.querystring ? '?' + request.querystring : ''));
    const stateCookie = L.makeState(cfg.sessionKey, { state, nonce, verifier, returnTo }, nowS);
    return L.respond(302, 'Found', {
      headers: { location: L.authorizeUrl({ clientId: cfg.clientId, state, nonce, challenge }) },
      cookies: [L.setCookie(L.STATE_COOKIE, stateCookie, L.STATE_TTL_S)],
    });
  }

  async function callback(request, cfg, cookies, nowS) {
    const clearState = L.clearCookie(L.STATE_COOKIE);
    const fail = (status, desc, msg) => L.respond(status, desc, {
      cookies: [clearState], body: L.page('Sign-in failed', `<p>${L.esc(msg)}</p><p><a href="/">Try again</a></p>`),
    });
    const q = new URLSearchParams(request.querystring || '');
    const saved = L.readState(cfg.sessionKey, cookies[L.STATE_COOKIE], nowS);
    if (!saved || !q.get('state') || !L.safeEqual(q.get('state'), saved.state)) {
      log('callback', { outcome: 'bad-state' });
      return fail(400, 'Bad Request', 'This sign-in link is invalid or has expired.');
    }
    if (q.get('error') || !q.get('code')) {
      log('callback', { outcome: 'provider-error', error: String(q.get('error') || 'no-code').slice(0, 64) });
      return fail(403, 'Forbidden', 'Google did not complete the sign-in.');
    }
    getJwks().catch(() => {}); // warm the JWKS cache while the code is exchanged
    let idToken;
    try {
      idToken = await exchange({ code: q.get('code'), verifier: saved.verifier, clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    } catch (err) {
      log('callback', { outcome: 'exchange-failed', error: err.message });
      return fail(502, 'Bad Gateway', 'Could not complete the sign-in with Google.');
    }
    const r = await verifyWithJwks(idToken, { clientId: cfg.clientId, nonce: saved.nonce, nowS });
    if (!r.ok) {
      log('callback', { outcome: 'id-token-rejected', reason: r.reason });
      return fail(403, 'Forbidden', 'The sign-in could not be verified.');
    }
    const email = r.claims.email.toLowerCase();
    if (!L.isAllowedEmail(email)) {
      log('callback', { outcome: 'denied', domain: email.split('@').pop() });
      return L.respond(403, 'Forbidden', {
        cookies: [clearState, L.clearCookie(L.SESSION_COOKIE)],
        body: L.page('Access denied', `<p>${L.esc(email)} does not have access to this preview.</p>`
          + `<p><a href="${L.LOGOUT_PATH}">Sign out</a> and sign in with an Opstream account.</p>`),
      });
    }
    log('callback', { outcome: 'allowed', domain: email.split('@').pop() });
    return L.respond(302, 'Found', {
      headers: { location: saved.returnTo },
      cookies: [clearState, L.setCookie(L.SESSION_COOKIE, L.makeSession(cfg.sessionKey, email, nowS), L.SESSION_TTL_S)],
    });
  }

  return async function handler(event) {
    const request = event.Records[0].cf.request;
    let cfg;
    try { cfg = await getConfig(); } catch (err) {
      log('config-unavailable', { error: err.message });
      return L.respond(503, 'Service Unavailable', { body: L.page('Temporarily unavailable', '<p>Please try again in a minute.</p>') });
    }
    try {
      if (cfg.basicAuthRequired && !L.basicAuthOk(L.header(request, 'authorization'), cfg.basicAuthSha256)) {
        return L.respond(401, 'Unauthorized', { headers: {
          'www-authenticate': 'Basic realm="Opstream GTM preview", charset="UTF-8"', 'cache-control': 'private, no-store' } });
      }
      const nowS = Math.floor(now() / 1000);
      const cookies = L.parseCookies(request);
      if (request.uri === L.CALLBACK_PATH) return await callback(request, cfg, cookies, nowS);
      if (request.uri === L.LOGOUT_PATH) {
        return L.respond(200, 'OK', {
          cookies: [L.clearCookie(L.SESSION_COOKIE), L.clearCookie(L.STATE_COOKIE)],
          body: L.page('Signed out', '<p>You are signed out of the Opstream GTM preview.</p><p><a href="/">Sign in again</a></p>'),
        });
      }
      if (request.uri === '/_auth' || request.uri.startsWith('/_auth/')) {
        return L.respond(404, 'Not Found', { body: L.page('Not found', '') });
      }
      if (!L.readSession(cfg.sessionKey, cookies[L.SESSION_COOKIE], nowS)) return startSignIn(request, cfg, nowS);
      if (request.uri.endsWith('/')) request.uri += 'index.html';
      return request;
    } catch (err) {
      log('error', { error: err.message });
      return L.respond(503, 'Service Unavailable', { body: L.page('Temporarily unavailable', '<p>Please try again in a minute.</p>') });
    }
  };
}

exports.createHandler = createHandler;
exports.cached = cached;
exports.SECRETS = SECRETS;
exports.signAwsJson = signAwsJson;
exports.handler = createHandler();
