// node --test test/
// GTM preview sign-in (infra/signin/edge): cookies, allowlist, Basic gate, Google ID token checks,
// and the viewer-request handler end to end with fake Secrets Manager / Google. All keys are generated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../infra/signin/edge/lib.js');
const { createHandler, cached } = require('../infra/signin/edge/index.js');

const KEY = crypto.randomBytes(48).toString('hex');
const NOW = 1_800_000_000;
const CLIENT_ID = '123-test.apps.googleusercontent.com';
const BASIC = 'Basic ' + Buffer.from('preview:test-password').toString('base64');
const BASIC_SHA = crypto.createHash('sha256').update('preview:test-password').digest('hex');

// ---------- signed cookies ----------
test('session cookie round-trips and carries a 12h expiry', () => {
  const c = L.readSession(KEY, L.makeSession(KEY, 'Test.User@Opstream.ai', NOW), NOW + 10);
  assert.equal(c.email, 'test.user@opstream.ai');
  assert.equal(c.exp - c.iat, 12 * 3600);
});

test('session cookie: tampered payload, tampered signature, wrong key, wrong purpose are rejected', () => {
  const tok = L.makeSession(KEY, 'test.user@opstream.ai', NOW);
  const [p, s] = tok.split('.');
  const forgedPayload = L.b64url(JSON.stringify({ email: 'test.user@opstream.ai', iat: NOW, exp: NOW + 10 * 86400 }));
  assert.equal(L.readSession(KEY, forgedPayload + '.' + s, NOW), null);
  const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  assert.equal(L.readSession(KEY, p + '.' + flipped, NOW), null);
  assert.equal(L.readSession('another-key-another-key-another-key!', tok, NOW), null);
  const asState = L.signToken(KEY, 'state', { email: 'test.user@opstream.ai', iat: NOW, exp: NOW + 60 });
  assert.equal(L.readSession(KEY, asState, NOW), null);
});

test('session cookie: expired, malformed and garbage values are rejected', () => {
  const tok = L.makeSession(KEY, 'test.user@opstream.ai', NOW);
  assert.equal(L.readSession(KEY, tok, NOW + 12 * 3600), null);
  assert.equal(L.readSession(KEY, tok, NOW + 12 * 3600 - 1).email, 'test.user@opstream.ai');
  for (const bad of [undefined, '', 'garbage', 'a.b', 'a.b.c', tok + '.x', '.' + tok.split('.')[1], 'x'.repeat(5000), '%%%.***']) {
    assert.equal(L.readSession(KEY, bad, NOW), null, String(bad).slice(0, 20));
  }
  // Correctly signed but with a lifetime longer than 12h, or a disallowed email: still rejected.
  assert.equal(L.readSession(KEY, L.signToken(KEY, 'session', { email: 'test.user@opstream.ai', iat: NOW, exp: NOW + 13 * 3600 }), NOW), null);
  assert.equal(L.readSession(KEY, L.signToken(KEY, 'session', { email: 'x@notopstream.ai', iat: NOW, exp: NOW + 60 }), NOW), null);
  assert.equal(L.readSession(KEY, L.signToken(KEY, 'session', { email: 'test.user@opstream.ai', iat: NOW + 3600, exp: NOW + 7200 }), NOW), null);
});

// ---------- allowlist ----------
test('allowlist: @opstream.ai and the one named account only', () => {
  for (const ok of ['test.user@opstream.ai', 'TEST.USER@OPSTREAM.AI', ' test.user@opstream.ai ', 'zackkaufman39@gmail.com', 'ZackKaufman39@Gmail.com']) {
    assert.equal(L.isAllowedEmail(ok), true, ok);
  }
  for (const bad of ['evil@opstream.ai.evil.com', 'x@notopstream.ai', 'x@sub.opstream.ai.com', 'opstream.ai', '@opstream.ai',
    'x@opstream.ai@evil.com', 'zackkaufman39@gmail.com.evil.com', 'zackkaufman39+x@gmail.com', 'someone@example.com', 'x@opstream.aii', '', null, undefined, 42]) {
    assert.equal(L.isAllowedEmail(bad), false, String(bad));
  }
});

// ---------- return path ----------
test('return path is same-origin path only (no open redirect)', () => {
  assert.equal(L.safeReturnPath('/accounts?tab=1'), '/accounts?tab=1');
  for (const bad of ['https://evil.com/', '//evil.com/x', '/\\evil.com', 'evil.com', '/a\r\nLocation: x', '/_auth/callback?x', '/_auth', '', null]) {
    assert.equal(L.safeReturnPath(bad), '/', String(bad));
  }
});

// ---------- Basic gate ----------
test('basic auth: constant-time hash compare, rejects wrong/missing/malformed', () => {
  assert.equal(L.basicAuthOk(BASIC, BASIC_SHA), true);
  assert.equal(L.basicAuthOk('basic ' + BASIC.slice(6), BASIC_SHA), true);
  assert.equal(L.basicAuthOk('Basic ' + Buffer.from('preview:wrong').toString('base64'), BASIC_SHA), false);
  assert.equal(L.basicAuthOk(undefined, BASIC_SHA), false);
  assert.equal(L.basicAuthOk('Bearer abc', BASIC_SHA), false);
  assert.equal(L.basicAuthOk(BASIC, ''), false);
  assert.equal(L.basicAuthOk(BASIC, undefined), false);
  // An empty credential must not match the hash of the empty string.
  assert.equal(L.basicAuthOk('Basic ', crypto.createHash('sha256').update('').digest('hex')), false);
});

// ---------- Google ID token ----------
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] };

function jwt(claims, { kid = 'k1', alg = 'RS256', key = rsa.privateKey, header } = {}) {
  const h = L.b64url(JSON.stringify(header || { alg, kid, typ: 'JWT' }));
  const p = L.b64url(JSON.stringify(claims));
  const sig = alg === 'RS256' ? crypto.sign('sha256', Buffer.from(h + '.' + p), key) : Buffer.from('x');
  return h + '.' + p + '.' + L.b64url(sig);
}
const goodClaims = (over = {}) => ({
  iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: '1', email: 'test.user@opstream.ai',
  email_verified: true, nonce: 'n-123', iat: NOW - 5, exp: NOW + 3600, ...over,
});
const verify = (tok, over = {}) => L.verifyIdToken(tok, { jwks: JWKS, clientId: CLIENT_ID, nonce: 'n-123', nowS: NOW, ...over });

test('id_token: a correctly signed Google token verifies (both issuer spellings)', () => {
  assert.equal(verify(jwt(goodClaims())).ok, true);
  assert.equal(verify(jwt(goodClaims({ iss: 'accounts.google.com' }))).ok, true);
});

test('id_token: signature, alg, kid, iss, aud, azp, exp, nonce, email_verified are enforced', () => {
  const cases = [
    [jwt(goodClaims(), { key: other.privateKey }), 'signature'],
    [jwt(goodClaims(), { kid: 'nope' }), 'unknown-kid'],
    [jwt(goodClaims(), { header: { alg: 'none', kid: 'k1' } }), 'alg'],
    [jwt(goodClaims(), { header: { alg: 'HS256', kid: 'k1' } }), 'alg'],
    [jwt(goodClaims({ iss: 'https://evil.example' })), 'iss'],
    [jwt(goodClaims({ aud: 'someone-else' })), 'aud'],
    [jwt(goodClaims({ azp: 'someone-else' })), 'azp'],
    [jwt(goodClaims({ exp: NOW - 120 })), 'exp'],
    [jwt(goodClaims({ iat: NOW + 3600 })), 'iat'],
    [jwt(goodClaims({ nonce: 'other' })), 'nonce'],
    [jwt(goodClaims({ nonce: undefined })), 'nonce'],
    [jwt(goodClaims({ email_verified: false })), 'email-unverified'],
    [jwt(goodClaims({ email_verified: 'true' })), 'email-unverified'],
    ['a.b', 'malformed'],
    ['not a jwt at all', 'malformed'],
  ];
  for (const [tok, reason] of cases) assert.deepEqual(verify(tok), { ok: false, reason }, reason);
  // Payload swapped under a valid signature.
  const [h, , s] = jwt(goodClaims()).split('.');
  assert.equal(verify(h + '.' + L.b64url(JSON.stringify(goodClaims({ email: 'other.test@opstream.ai' }))) + '.' + s).reason, 'signature');
});

// ---------- handler ----------
const ev = (uri, { qs = '', headers = {} } = {}) => {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = [{ key: k, value: v }];
  return { Records: [{ cf: { request: { uri, querystring: qs, method: 'GET', headers: h } } }] };
};
const cookiesOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.value);
const cookiePair = (setCookieValue) => setCookieValue.split(';')[0];

function makeHandler(over = {}) {
  const cfg = { clientId: CLIENT_ID, clientSecret: 'test-secret', sessionKey: KEY, basicAuthRequired: true, basicAuthSha256: BASIC_SHA, ...over.cfg };
  const calls = { exchange: [] };
  const handler = createHandler({
    now: () => NOW * 1000,
    getConfig: over.getConfig || (async () => cfg),
    getJwks: async () => JWKS,
    exchangeCode: over.exchangeCode || (async (args) => { calls.exchange.push(args); return over.idToken; }),
  });
  return { handler, calls };
}

async function startFlow(handler, uri = '/accounts/', qs = 'tab=2') {
  const res = await handler(ev(uri, { qs, headers: { Authorization: BASIC } }));
  assert.equal(res.status, '302');
  const loc = new URL(res.headers.location[0].value);
  return { res, loc, stateCookie: cookiePair(cookiesOf(res)[0]) };
}

test('handler: no Basic credentials -> 401 challenge; wrong credentials -> 401', async () => {
  const { handler } = makeHandler();
  for (const headers of [{}, { Authorization: 'Basic ' + Buffer.from('preview:nope').toString('base64') }]) {
    const res = await handler(ev('/', { headers }));
    assert.equal(res.status, '401');
    assert.match(res.headers['www-authenticate'][0].value, /^Basic realm=/);
    assert.match(res.headers['cache-control'][0].value, /no-store/);
  }
});

test('handler: Basic only -> 302 to Google with exact redirect_uri, state, nonce, PKCE and a signed state cookie', async () => {
  const { handler } = makeHandler();
  const { res, loc, stateCookie } = await startFlow(handler);
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = loc.searchParams;
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('redirect_uri'), 'https://d3m8bzysq99qfh.cloudfront.net/_auth/callback');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid email');
  assert.equal(q.get('prompt'), 'select_account');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('state').length >= 32 && q.get('nonce').length >= 32);
  const sc = cookiesOf(res)[0];
  assert.match(sc, /^__Host-gtm_state=[^;]+; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  const saved = L.readState(KEY, stateCookie.split('=')[1], NOW);
  assert.equal(saved.state, q.get('state'));
  assert.equal(saved.nonce, q.get('nonce'));
  assert.equal(saved.returnTo, '/accounts/?tab=2');
  assert.equal(res.headers['cache-control'][0].value, 'no-store');
});

test('handler: forged, garbage, expired or tampered session cookies are not served', async () => {
  const { handler } = makeHandler();
  const valid = L.makeSession(KEY, 'test.user@opstream.ai', NOW);
  const [p, s] = valid.split('.');
  const bad = [
    'garbage', L.makeSession('wrong-key-wrong-key-wrong-key-wrong', 'test.user@opstream.ai', NOW),
    L.makeSession(KEY, 'test.user@opstream.ai', NOW - 13 * 3600),
    L.b64url(JSON.stringify({ email: 'test.user@opstream.ai', iat: NOW, exp: NOW + 99999 })) + '.' + s,
    p + '.' + L.b64url(crypto.randomBytes(32)),
  ];
  for (const v of bad) {
    for (const uri of ['/', '/data.js', '/insights.json']) {
      const res = await handler(ev(uri, { headers: { Authorization: BASIC, Cookie: `${L.SESSION_COOKIE}=${v}` } }));
      assert.equal(res.status, '302', uri);
      assert.match(res.headers.location[0].value, /^https:\/\/accounts\.google\.com\//);
    }
  }
});

test('handler: subresource fetches without a session get 403 and no new state cookie', async () => {
  const { handler } = makeHandler();
  const res = await handler(ev('/data.js', { headers: { Authorization: BASIC, 'Sec-Fetch-Mode': 'no-cors' } }));
  assert.equal(res.status, '403');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('handler: valid session passes the request through and maps "/" to index.html', async () => {
  const { handler } = makeHandler();
  const cookie = `other=1; ${L.SESSION_COOKIE}=${L.makeSession(KEY, 'zackkaufman39@gmail.com', NOW)}`;
  const req = await handler(ev('/', { headers: { Authorization: BASIC, Cookie: cookie } }));
  assert.equal(req.uri, '/index.html');
  assert.equal(req.status, undefined);
  const js = await handler(ev('/data.js', { headers: { Authorization: BASIC, Cookie: cookie } }));
  assert.equal(js.uri, '/data.js');
  // ...but still not without Basic while it is required.
  assert.equal((await handler(ev('/', { headers: { Cookie: cookie } }))).status, '401');
});

test('handler: basic_auth_required=false skips only the Basic gate', async () => {
  const { handler } = makeHandler({ cfg: { basicAuthRequired: false } });
  assert.equal((await handler(ev('/'))).status, '302');
  const cookie = `${L.SESSION_COOKIE}=${L.makeSession(KEY, 'test.user@opstream.ai', NOW)}`;
  assert.equal((await handler(ev('/', { headers: { Cookie: cookie } }))).uri, '/index.html');
});

test('callback: allowed account -> session cookie, state cleared, back to the original path', async () => {
  let idToken;
  const { handler, calls } = makeHandler({ exchangeCode: async (a) => { calls.exchange.push(a); return idToken; } });
  const { loc, stateCookie } = await startFlow(handler);
  idToken = jwt(goodClaims({ nonce: loc.searchParams.get('nonce'), email: 'Test.User@Opstream.ai' }));
  const res = await handler(ev('/_auth/callback', { qs: `code=abc&state=${loc.searchParams.get('state')}`, headers: { Authorization: BASIC, Cookie: stateCookie } }));
  assert.equal(res.status, '302');
  assert.equal(res.headers.location[0].value, '/accounts/?tab=2');
  const set = cookiesOf(res);
  assert.ok(set.includes(L.clearCookie(L.STATE_COOKIE)));
  const session = set.find((c) => c.startsWith(L.SESSION_COOKIE + '=') && !c.includes('Max-Age=0'));
  assert.match(session, /; Max-Age=43200; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  assert.equal(L.readSession(KEY, cookiePair(session).split('=')[1], NOW).email, 'test.user@opstream.ai');
  // PKCE verifier from the state cookie went to the token exchange.
  const c = calls.exchange[0];
  assert.equal(c.code, 'abc');
  assert.equal(L.b64url(crypto.createHash('sha256').update(c.verifier).digest()), loc.searchParams.get('code_challenge'));
});

test('callback: state mismatch, missing state cookie or forged state cookie -> 400, no exchange', async () => {
  const { handler, calls } = makeHandler({ idToken: 'unused' });
  const { loc, stateCookie } = await startFlow(handler);
  const forged = `${L.STATE_COOKIE}=${L.makeState('wrong-key-wrong-key-wrong-key-wrong', { state: loc.searchParams.get('state'), nonce: 'n'.repeat(32), verifier: 'v'.repeat(43), returnTo: '/' }, NOW)}`;
  for (const [qs, cookie] of [[`code=abc&state=nope`, stateCookie], [`code=abc&state=${loc.searchParams.get('state')}`, ''], [`code=abc&state=${loc.searchParams.get('state')}`, forged], ['code=abc', stateCookie]]) {
    const res = await handler(ev('/_auth/callback', { qs, headers: { Authorization: BASIC, Cookie: cookie } }));
    assert.equal(res.status, '400', qs);
    assert.ok(!cookiesOf(res).some((c) => c.startsWith(L.SESSION_COOKIE + '=') && !c.includes('Max-Age=0')));
  }
  assert.equal(calls.exchange.length, 0);
});

test('callback: expired state cookie -> 400', async () => {
  const { handler } = makeHandler({ idToken: 'unused' });
  const { loc, stateCookie } = await startFlow(handler);
  const later = createHandler({ now: () => (NOW + 601) * 1000, getConfig: async () => ({ clientId: CLIENT_ID, clientSecret: 's', sessionKey: KEY, basicAuthRequired: false }), getJwks: async () => JWKS, exchangeCode: async () => 'x' });
  const res = await later(ev('/_auth/callback', { qs: `code=abc&state=${loc.searchParams.get('state')}`, headers: { Cookie: stateCookie } }));
  assert.equal(res.status, '400');
});

test('callback: non-allowlisted, unverified or wrong-nonce accounts -> 403, no session', async () => {
  for (const over of [{ email: 'evil@opstream.ai.evil.com' }, { email: 'x@notopstream.ai' }, { email_verified: false }, { nonce: 'replayed' }]) {
    let idToken;
    const { handler } = makeHandler({ exchangeCode: async () => idToken });
    const { loc, stateCookie } = await startFlow(handler);
    idToken = jwt(goodClaims({ nonce: loc.searchParams.get('nonce'), ...over }));
    const res = await handler(ev('/_auth/callback', { qs: `code=abc&state=${loc.searchParams.get('state')}`, headers: { Authorization: BASIC, Cookie: stateCookie } }));
    assert.equal(res.status, '403', JSON.stringify(over));
    assert.ok(!cookiesOf(res).some((c) => c.startsWith(L.SESSION_COOKIE + '=') && !c.includes('Max-Age=0')));
    if (over.email) assert.match(res.body, /href="\/_auth\/logout"/);
  }
});

test('callback: provider error and token-exchange failure do not sign in', async () => {
  const { handler } = makeHandler({ exchangeCode: async () => { throw new Error('token exchange failed: 400 invalid_grant'); } });
  let { loc, stateCookie } = await startFlow(handler);
  let res = await handler(ev('/_auth/callback', { qs: `error=access_denied&state=${loc.searchParams.get('state')}`, headers: { Authorization: BASIC, Cookie: stateCookie } }));
  assert.equal(res.status, '403');
  ({ loc, stateCookie } = await startFlow(handler));
  res = await handler(ev('/_auth/callback', { qs: `code=abc&state=${loc.searchParams.get('state')}`, headers: { Authorization: BASIC, Cookie: stateCookie } }));
  assert.equal(res.status, '502');
});

test('logout clears both cookies and shows a signed-out page', async () => {
  const { handler } = makeHandler();
  const res = await handler(ev('/_auth/logout', { headers: { Authorization: BASIC } }));
  assert.equal(res.status, '200');
  assert.deepEqual(cookiesOf(res).sort(), [L.clearCookie(L.SESSION_COOKIE), L.clearCookie(L.STATE_COOKIE)].sort());
  assert.match(res.body, /Signed out/);
  assert.equal(res.headers['cache-control'][0].value, 'no-store');
});

test('config unavailable -> 503 (fail closed)', async () => {
  const { handler } = makeHandler({ getConfig: async () => { throw new Error('AccessDenied'); } });
  const res = await handler(ev('/', { headers: { Authorization: BASIC } }));
  assert.equal(res.status, '503');
});

test('config cache: reuses within TTL, reloads after, serves stale only while the reload fails', async () => {
  let n = 0, failing = false;
  const get = cached(async () => { if (failing) throw new Error('down'); return ++n; }, 1000, 5000);
  const t0 = Date.now();
  assert.equal(await get({ now: t0 }), 1);
  assert.equal(await get({ now: t0 + 500 }), 1);
  assert.equal(await get({ now: t0 + 2000 }), 2);
  failing = true;
  assert.equal(await get({ now: Date.now() + 2000 }), 2);
  await assert.rejects(get({ now: Date.now() + 10000 }), /down/);
});

test('config cache: a slow refresh on a warm instance returns the cached copy, and the result lands later', async () => {
  let n = 0, release;
  const get = cached(async () => { n += 1; if (n === 1) return 'v1'; await new Promise((r) => { release = r; }); return 'v2'; }, 1000, 60000, 20);
  assert.equal(await get(), 'v1');
  const t = Date.now() + 2000;
  assert.equal(await get({ now: t }), 'v1');
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await get({ now: Date.now() }), 'v2');
});
