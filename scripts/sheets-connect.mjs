// One-time admin consent for the owner's Google account.
// The refresh token is handed to saveRefreshToken and is never logged,
// never placed in HTML, and never written to disk or S3 by this module.
import crypto from 'node:crypto';

export const SHEETS_STATE_PREFIX = 'sheets:';
export const REFRESH_SECRET_ID = 'opstream-gtm/google-sheets-refresh-token';
export const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

const STATE_TTL_MS = 10 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function plainPage(title, paragraph) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>'
    + escapeHtml(title)
    + '</title></head><body><h1>'
    + escapeHtml(title)
    + '</h1><p>'
    + escapeHtml(paragraph)
    + '</p></body></html>';
}

export function createSheetsConnect({ loadClient, saveRefreshToken, fetchImpl, now, randomBytes } = {}) {
  const states = new Map();
  const clock = now || (() => Date.now());
  const bytes = randomBytes || ((n) => crypto.randomBytes(n));
  const fetchFn = fetchImpl || fetch;

  function purge(t) {
    for (const [key, rec] of states) {
      if (t - rec.createdAt > STATE_TTL_MS) states.delete(key);
    }
  }

  async function start(redirectUri) {
    const client = await loadClient();
    if (!client || !client.clientId || !client.clientSecret) {
      throw new Error('oauth client missing');
    }
    const t = clock();
    purge(t);
    const key = Buffer.from(bytes(32)).toString('hex');
    states.set(key, { createdAt: t, redirectUri });
    const state = SHEETS_STATE_PREFIX + key;
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SHEETS_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString();
    return { url, state };
  }

  function consume(state) {
    if (!state || !String(state).startsWith(SHEETS_STATE_PREFIX)) return null;
    const key = String(state).slice(SHEETS_STATE_PREFIX.length);
    const rec = states.get(key);
    if (!rec) return null;
    states.delete(key);
    if (clock() - rec.createdAt > STATE_TTL_MS) return null;
    return rec;
  }

  async function callback({ code, state, error, redirectUri }) {
    const rec = consume(state);
    if (error || !rec || !code || rec.redirectUri !== redirectUri) {
      return {
        ok: false,
        status: 400,
        html: plainPage(
          'Sheets was not connected',
          'This authorization link is no longer valid. Open /admin/connect-sheets again.',
        ),
      };
    }
    let tokenJson = {};
    try {
      const client = await loadClient();
      const params = new URLSearchParams({
        code: String(code),
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
      tokenJson = await response.json();
      if (!response.ok || !tokenJson.refresh_token) {
        return {
          ok: false,
          status: 400,
          html: plainPage(
            'Sheets was not connected',
            'Google did not return a refresh token. Open /admin/connect-sheets again.',
          ),
        };
      }
      let email = '';
      try {
        const profile = await fetchFn('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: 'Bearer ' + tokenJson.access_token },
        });
        const profileJson = await profile.json();
        email = profileJson && profileJson.email ? String(profileJson.email) : '';
      } catch {
        email = '';
      }
      await saveRefreshToken(tokenJson.refresh_token);
      const who = email || 'The Google account';
      return {
        ok: true,
        status: 200,
        email,
        html: plainPage(
          'Sheets connected',
          who + ' authorized read-only access. The refresh token is stored as ' + REFRESH_SECRET_ID + '.',
        ),
      };
    } catch {
      return {
        ok: false,
        status: 500,
        html: plainPage(
          'Sheets was not connected',
          'The refresh token could not be saved. It was not written to disk.',
        ),
      };
    }
  }

  return { start, callback };
}
