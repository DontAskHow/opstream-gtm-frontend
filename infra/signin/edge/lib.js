'use strict';
// Pure helpers for the GTM preview sign-in (Lambda@Edge viewer-request).
// No I/O here: secrets, JWKS and the token exchange are passed in by index.js,
// so everything below is unit-tested in test/signin-edge.test.mjs.
const crypto = require('node:crypto');

const ORIGIN = 'https://d3m8bzysq99qfh.cloudfront.net';
const CALLBACK_PATH = '/_auth/callback';
const LOGOUT_PATH = '/_auth/logout';
const REDIRECT_URI = ORIGIN + CALLBACK_PATH;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

// __Host- cookies: Secure, Path=/, no Domain, so no other origin can set or scope them.
const SESSION_COOKIE = '__Host-gtm_session';
const STATE_COOKIE = '__Host-gtm_state';
const SESSION_TTL_S = 12 * 60 * 60;
const STATE_TTL_S = 10 * 60;
const CLOCK_SKEW_S = 60;

// Who may see the preview: any verified @opstream.ai Google account, plus one named account.
const ALLOWED_DOMAIN_SUFFIX = '@opstream.ai';
const ALLOWED_EMAILS = ['zackkaufman39@gmail.com'];

function isAllowedEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) return false;
  return e.endsWith(ALLOWED_DOMAIN_SUFFIX) || ALLOWED_EMAILS.includes(e);
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => (typeof s === 'string' && B64URL.test(s) ? Buffer.from(s, 'base64url') : null);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  // Hash first so the comparison is constant-time even when lengths differ.
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(x).digest(), crypto.createHash('sha256').update(y).digest());
}

// ---------- signed cookies: base64url(JSON) "." base64url(HMAC-SHA256(key, purpose "." payload)) ----------
// The purpose label keeps a state cookie from ever verifying as a session cookie and vice versa.
function hmac(key, purpose, payload) {
  return crypto.createHmac('sha256', key).update(purpose + '.' + payload).digest();
}

function signToken(key, purpose, claims) {
  if (!key) throw new Error('missing signing key');
  const payload = b64url(JSON.stringify(claims));
  return payload + '.' + b64url(hmac(key, purpose, payload));
}

// Returns the claims, or null for anything malformed, tampered or expired.
function verifyToken(key, purpose, token, nowS) {
  if (!key || typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const sig = fromB64url(parts[1]);
  if (!sig || sig.length !== 32 || !fromB64url(parts[0])) return null;
  if (!crypto.timingSafeEqual(sig, hmac(key, purpose, parts[0]))) return null;
  let claims;
  try { claims = JSON.parse(fromB64url(parts[0]).toString('utf8')); } catch { return null; }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  if (!Number.isInteger(claims.exp) || claims.exp <= nowS) return null;
  if (!Number.isInteger(claims.iat) || claims.iat > nowS + CLOCK_SKEW_S) return null;
  return claims;
}

function makeSession(key, email, nowS) {
  return signToken(key, 'session', { email: String(email).toLowerCase(), iat: nowS, exp: nowS + SESSION_TTL_S });
}

function readSession(key, token, nowS) {
  const c = verifyToken(key, 'session', token, nowS);
  if (!c || c.exp - c.iat > SESSION_TTL_S || !isAllowedEmail(c.email)) return null;
  return c;
}

function makeState(key, fields, nowS) {
  return signToken(key, 'state', { ...fields, iat: nowS, exp: nowS + STATE_TTL_S });
}

function readState(key, token, nowS) {
  const c = verifyToken(key, 'state', token, nowS);
  if (!c || c.exp - c.iat > STATE_TTL_S) return null;
  if (![c.state, c.nonce, c.verifier].every((v) => typeof v === 'string' && v.length >= 22 && B64URL.test(v))) return null;
  return { ...c, returnTo: safeReturnPath(c.returnTo) };
}

// Same-origin path only: "/x?y". Anything else (absolute URLs, "//host", backslashes,
// control characters, the auth endpoints themselves) returns "/".
function safeReturnPath(p) {
  if (typeof p !== 'string' || p.length > 2048) return '/';
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return '/';
  if (/[\u0000-\u001f\u007f\s]/.test(p)) return '/';
  if (p === '/_auth' || p.startsWith('/_auth/') || p.startsWith('/_auth?')) return '/';
  return p;
}

// ---------- HTTP Basic (the pre-existing preview gate) ----------
// The config secret holds sha256("user:password") as hex, never the password itself.
function basicAuthOk(headerValue, expectedSha256Hex) {
  if (typeof expectedSha256Hex !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256Hex)) return false;
  const m = typeof headerValue === 'string' && headerValue.match(/^Basic\s+([A-Za-z0-9+/=]{1,1024})\s*$/i);
  const supplied = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
  const got = crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(got, Buffer.from(expectedSha256Hex, 'hex')) && !!m;
}

// ---------- Google ID token (RS256) ----------
function verifyIdToken(idToken, { jwks, clientId, nonce, nowS }) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof idToken !== 'string' || idToken.length > 8192) return fail('malformed');
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return fail('malformed');
  let header, claims;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch { return fail('malformed'); }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return fail('alg');
  const jwk = ((jwks && jwks.keys) || []).find((k) => k && k.kid === header.kid && k.kty === 'RSA'
    && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
  if (!jwk) return fail('unknown-kid');
  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    valid = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), key, fromB64url(parts[2]));
  } catch { valid = false; }
  if (!valid) return fail('signature');
  if (!claims || typeof claims !== 'object') return fail('malformed');
  if (!GOOGLE_ISSUERS.includes(claims.iss)) return fail('iss');
  const audOk = typeof claims.aud === 'string' ? claims.aud === clientId
    : Array.isArray(claims.aud) && claims.aud.includes(clientId) && claims.azp === clientId;
  if (!clientId || !audOk) return fail('aud');
  if (claims.azp !== undefined && claims.azp !== clientId) return fail('azp');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S <= nowS) return fail('exp');
  if (typeof claims.iat === 'number' && claims.iat > nowS + CLOCK_SKEW_S) return fail('iat');
  if (typeof nonce !== 'string' || typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) return fail('nonce');
  if (claims.email_verified !== true) return fail('email-unverified');
  if (typeof claims.email !== 'string') return fail('email');
  return { ok: true, claims };
}

// ---------- requests ----------
function header(request, name) {
  const h = request.headers && request.headers[name];
  return h && h.length ? h[0].value : undefined;
}

function parseCookies(request) {
  const out = {};
  for (const h of (request.headers && request.headers.cookie) || []) {
    for (const part of String(h.value).split(';')) {
      const i = part.indexOf('=');
      if (i < 1) continue;
      const name = part.slice(0, i).trim();
      if (!(name in out)) out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function authorizeUrl({ clientId, state, nonce, challenge }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'openid email',
    state, nonce, prompt: 'select_account', code_challenge: challenge, code_challenge_method: 'S256',
  });
  return GOOGLE_AUTH_URL + '?' + q.toString();
}

// ---------- responses (generated at viewer-request, so the viewer-response headers function does not run on them) ----------
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const HEADER_KEYS = {
  'cache-control': 'Cache-Control', 'x-robots-tag': 'X-Robots-Tag', 'x-content-type-options': 'X-Content-Type-Options',
  'referrer-policy': 'Referrer-Policy', 'content-type': 'Content-Type', 'content-security-policy': 'Content-Security-Policy',
  location: 'Location', 'www-authenticate': 'WWW-Authenticate', 'set-cookie': 'Set-Cookie',
};

function respond(status, description, { headers = {}, cookies = [], body } = {}) {
  const all = { ...BASE_HEADERS, ...headers };
  if (body !== undefined) {
    all['content-type'] = all['content-type'] || 'text/html; charset=utf-8';
    all['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  }
  const out = {};
  for (const [k, v] of Object.entries(all)) out[k] = [{ key: HEADER_KEYS[k] || k, value: v }];
  if (cookies.length) out['set-cookie'] = cookies.map((value) => ({ key: 'Set-Cookie', value }));
  const res = { status: String(status), statusDescription: description, headers: out };
  if (body !== undefined) res.body = body;
  return res;
}

function setCookie(name, value, maxAge) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
const clearCookie = (name) => setCookie(name, '', 0);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, html) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d2433}`
    + 'a{color:#2457c5}h1{font-size:1.4rem}</style></head><body>'
    + `<h1>${esc(title)}</h1>${html}</body></html>`;
}

module.exports = {
  ORIGIN, CALLBACK_PATH, LOGOUT_PATH, REDIRECT_URI, GOOGLE_AUTH_URL, GOOGLE_ISSUERS,
  SESSION_COOKIE, STATE_COOKIE, SESSION_TTL_S, STATE_TTL_S, ALLOWED_DOMAIN_SUFFIX, ALLOWED_EMAILS,
  isAllowedEmail, b64url, fromB64url, safeEqual, signToken, verifyToken, makeSession, readSession,
  makeState, readState, safeReturnPath, basicAuthOk, verifyIdToken, header, parseCookies, authorizeUrl,
  respond, setCookie, clearCookie, esc, page,
};
