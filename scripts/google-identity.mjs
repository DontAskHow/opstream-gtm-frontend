// Google sign-in for one person. The refresh token is written only to
// Secrets Manager. Callers must not log the token or the secret document.
import crypto from 'node:crypto';

export const USER_STATE_PREFIX = 'user:';
export const COMPOSE_STATE_PREFIX = 'compose:';

export const READ_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

export const COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

const SCOPE_LABELS = {
  openid: 'Sign-in',
  email: 'Email address',
  profile: 'Profile',
  'https://www.googleapis.com/auth/gmail.readonly': 'Read Gmail',
  'https://www.googleapis.com/auth/calendar.readonly': 'Read Calendar',
  'https://www.googleapis.com/auth/drive.readonly': 'Read Drive',
  'https://www.googleapis.com/auth/gmail.compose': 'Create Gmail drafts',
};

export function safeCode(err) {
  const raw = err && err.code ? String(err.code) : '';
  return /^[A-Za-z0-9_]+$/.test(raw) ? raw : 'Error';
}

export function emailAllowed(email, allow) {
  const value = String(email || '').trim().toLowerCase();
  if (!value || !value.includes('@')) return false;
  for (const rule of allow || []) {
    const item = String(rule || '').trim().toLowerCase();
    if (!item) continue;
    if (item.startsWith('@')) {
      if (value.endsWith(item)) return true;
    } else if (value === item) return true;
  }
  return false;
}

export function userHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function userSecretId(email) {
  return 'opstream-gtm/users/' + userHash(email) + '/google';
}

export function initials(name, email) {
  const source = String(name || '').trim() || String(email || '').trim();
  const parts = source.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  const letters = (parts[0] ? parts[0][0] : '') + (parts[1] ? parts[1][0] : '');
  return (letters || 'U').toUpperCase();
}

export function scopeSummary(scopes) {
  const labels = [];
  for (const scope of scopes || []) {
    const label = SCOPE_LABELS[scope] || '';
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(', ');
}

export function authUrl({ clientId, redirectUri, state, scopes }) {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: (scopes || READ_SCOPES).join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
}

function googleError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

async function readJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

export async function exchangeCode({ code, redirectUri, client, fetchImpl }) {
  const fetchFn = fetchImpl || fetch;
  const params = new URLSearchParams({
    code: String(code || ''),
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const response = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const token = await readJson(response);
  if (!response.ok || !token.refresh_token || !token.access_token) throw googleError('TokenExchange');
  const profileRes = await fetchFn('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + token.access_token },
  });
  const profile = await readJson(profileRes);
  const email = String(profile.email || '').trim().toLowerCase();
  if (!profileRes.ok || !email) throw googleError('Profile');
  const picture = String(profile.picture || '');
  return {
    email,
    name: String(profile.name || '').trim(),
    picture: picture.startsWith('https://') ? picture : '',
    refreshToken: String(token.refresh_token),
    accessToken: String(token.access_token),
    expiresIn: Number(token.expires_in) || 3600,
    scopes: String(token.scope || '').split(/\s+/).filter(Boolean),
  };
}

export async function refreshAccessToken({ refreshToken, client, fetchImpl }) {
  const fetchFn = fetchImpl || fetch;
  const params = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const token = await readJson(response);
  if (!response.ok || !token.access_token) {
    const reason = String(token.error || '');
    throw googleError(reason === 'invalid_grant' ? 'invalid_grant' : 'TokenRefresh');
  }
  return {
    accessToken: String(token.access_token),
    expiresIn: Number(token.expires_in) || 3600,
  };
}

export function sessionPublic(session) {
  if (!session || !session.email) return { signedIn: false };
  const scopes = Array.isArray(session.scopes) ? session.scopes : [];
  return {
    signedIn: true,
    email: session.email,
    name: session.name || session.email,
    picture: session.picture || '',
    scopes,
    scopeSummary: scopeSummary(scopes),
    expired: !!session.expired,
    initials: initials(session.name, session.email),
    compose: scopes.includes(COMPOSE_SCOPE),
  };
}

export function secretDocument(session, extra) {
  const doc = {
    email: session.email,
    refresh_token: session.refreshToken,
    scopes: session.scopes || [],
    connected_at: new Date().toISOString(),
    name: session.name || '',
  };
  if (extra) Object.assign(doc, extra);
  return doc;
}
