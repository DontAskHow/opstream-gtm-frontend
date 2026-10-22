// Refresh-container entry: one user's secret JSON on stdin, brief JSON on stdout.
// The refresh token is never printed.
import fs from 'node:fs';
import { buildPersonalBrief, gtmIndex } from './google-workspace.mjs';
import { refreshAccessToken } from './google-identity.mjs';

function fail(code) {
  console.error('[user-brief] ' + code);
  process.stdout.write(JSON.stringify({ expired: false, skipped: true, meetings: [], followUps: [], notOnSheet: [], drafts: [] }));
  process.exit(0);
}

const raw = fs.readFileSync(0, 'utf8');
let doc = {};
try { doc = JSON.parse(raw || '{}'); }
catch { fail('SecretJson'); }

const email = String(doc.email || '').trim().toLowerCase();
const refreshToken = String(doc.refresh_token || '');
if (!email || !refreshToken) {
  process.stdout.write(JSON.stringify({ email, skipped: true, expired: false, meetings: [], followUps: [], notOnSheet: [], drafts: [] }));
  process.exit(0);
}

let records = {};
let sheet = {};
try { if (process.env.GTM_RECORDS) records = JSON.parse(fs.readFileSync(process.env.GTM_RECORDS, 'utf8')); }
catch { records = {}; }
try { if (process.env.GTM_SHEET) sheet = JSON.parse(fs.readFileSync(process.env.GTM_SHEET, 'utf8')); }
catch { sheet = {}; }

const client = {
  clientId: process.env.GTM_GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GTM_GOOGLE_CLIENT_SECRET || '',
};
if (!client.clientId || !client.clientSecret) fail('OAuthClient');

try {
  const refreshed = await refreshAccessToken({ refreshToken, client, fetchImpl: fetch });
  const brief = await buildPersonalBrief({
    fetchImpl: fetch,
    token: refreshed.accessToken,
    email,
    index: gtmIndex(records, sheet),
  });
  process.stdout.write(JSON.stringify(brief));
} catch (err) {
  const code = err && err.code === 'invalid_grant' ? 'invalid_grant' : 'Error';
  if (code === 'invalid_grant') {
    process.stdout.write(JSON.stringify({
      email, expired: true, generatedAt: new Date().toISOString(),
      meetings: [], followUps: [], notOnSheet: [], drafts: [],
    }));
    process.exit(0);
  }
  fail(code);
}
