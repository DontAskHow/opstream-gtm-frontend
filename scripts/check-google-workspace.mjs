// Sign-in, sign-out, secret write, and the email tool. Google and Secrets Manager
// are mocked at the HTTP boundary. The public dashboard stays available.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import workspaceModel from '../workspace-model.cjs';

process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-unit-fixture';
process.env.OPENAI_API_KEY = '';

const { createServer, setHooks, resetAuth } = await import('./agent-server.mjs');
const { putSecretString } = await import('./published-swap.mjs');
const { userHash, userSecretId } = await import('./google-identity.mjs');
const { buildPersonalBrief, gtmIndex } = await import('./google-workspace.mjs');

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
  else console.log('ok ' + name);
}

const REFRESH = 'refresh-token-unit-fixture';
const ACCESS = 'access-token-unit-fixture';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let profileEmail = 'hollie@opstream.ai';
const fetched = [];
const logs = [];
const origError = console.error;
console.error = (...args) => { logs.push(args.map(String).join(' ')); };

async function fetchImpl(url, opts) {
  const target = String(url);
  fetched.push(target + ' ' + ((opts && opts.method) || 'GET'));
  if (target.includes('oauth2.googleapis.com/token')) {
    return { ok: true, json: async () => ({ refresh_token: REFRESH, access_token: ACCESS, expires_in: 3600, scope: '' }) };
  }
  if (target.includes('userinfo')) {
    return { ok: true, json: async () => ({ email: profileEmail, name: 'Hollie Farrahi', picture: 'https://example.test/a.png' }) };
  }
  if (target.includes('/gmail/v1/users/me/messages?')) {
    return { ok: true, json: async () => ({ messages: [{ id: 'm1' }] }) };
  }
  if (target.includes('/gmail/v1/users/me/messages/')) {
    return {
      ok: true,
      json: async () => ({
        id: 'm1',
        snippet: 'The shows are next month',
        payload: { headers: [{ name: 'Subject', value: 'Upcoming shows' }, { name: 'From', value: 'promoter@shows.example' }] },
      }),
    };
  }
  if (target.includes('calendar')) {
    return { ok: true, json: async () => ({ items: [{ summary: 'Show planning', start: { date: '2026-09-28' }, attendees: [{ email: 'a@shows.example' }] }] }) };
  }
  if (target.includes('drive')) {
    return { ok: true, text: async () => 'Show notes', json: async () => ({ files: [] }) };
  }
  if (target.includes('/drafts')) {
    return { ok: true, json: async () => ({ id: 'draft-1' }) };
  }
  throw new Error('unexpected url');
}

async function callChatApi(payload) {
  const names = (payload.tools || []).map(tool => tool.function.name);
  const lastUser = [...payload.messages].reverse().find(message => message.role === 'user');
  const askedEmail = lastUser && /email/i.test(lastUser.content);
  if (askedEmail && names.includes('search_email') && !payload.messages.some(message => message.role === 'tool')) {
    return {
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_email', arguments: JSON.stringify({ query: 'upcoming shows' }) } }],
        },
      }],
    };
  }
  if (payload.messages.some(message => message.role === 'tool')) {
    const tool = payload.messages.find(message => message.role === 'tool');
    check('email tool text', String(tool.content || '').includes('Upcoming shows'));
    return { choices: [{ message: { content: '<p>From your email <strong>Upcoming shows</strong>.</p>' } }] };
  }
  check('anonymous tools omit email', !names.includes('search_email'));
  return { choices: [{ message: { content: '<p>Sign in with Google to read your email.</p>' } }] };
}

const secretCalls = [];
setHooks({
  fetchImpl,
  callChatApi,
  putSecretString: (id, value) => putSecretString(id, value, {
    request(action, payload) {
      secretCalls.push({ action, id, payload });
      return Buffer.from('{}');
    },
  }),
});

function request(port, method, reqPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: reqPath, method,
      headers: {
        cookie: cookie || '',
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw.join(';') : String(raw || '');
  const pair = line.split(';').map(part => part.trim()).find(part => part.startsWith('gtm_user='));
  return pair || '';
}

resetAuth();
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const home = await request(port, 'GET', '/');
check('public page', home.status === 200 && home.body.includes('GTM Workspace') && home.body.includes('Email sending is disabled in this public workspace') && home.body.includes('Sign in with Google'));
check('public page is not a google redirect', !String(home.headers.location || '').includes('accounts.google.com'));
const anon = await request(port, 'GET', '/api/session');
check('public session', anon.status === 200 && JSON.parse(anon.body).signedIn === false);

const anonAsk = await request(port, 'POST', '/api/ask', { body: JSON.stringify({ message: 'What is the open pipeline?', history: [] }) });
check('anonymous ask', anonAsk.status === 200 && anonAsk.body.includes('Sign in with Google') && !anonAsk.body.includes(REFRESH));

const deniedStart = await request(port, 'GET', '/api/google/sign-in');
const deniedUrl = new URL(deniedStart.headers.location);
profileEmail = 'stranger@gmail.com';
const denied = await request(port, 'GET', '/api/gmail/oauth/callback?code=from-google&state=' + encodeURIComponent(deniedUrl.searchParams.get('state')));
check('allow list rejects', denied.status === 403 && denied.body.includes('not on the Opstream allow list') && !denied.body.includes(REFRESH) && secretCalls.length === 0);

profileEmail = 'hollie@opstream.ai';
const start = await request(port, 'GET', '/api/google/sign-in');
const startUrl = new URL(start.headers.location);
const scope = startUrl.searchParams.get('scope') || '';
check('sign-in redirects', start.status === 302 && startUrl.hostname === 'accounts.google.com');
check('read scopes', scope.includes('gmail.readonly') && scope.includes('calendar.readonly') && scope.includes('drive.readonly') && scope.includes('openid'));
check('sign-in state prefix', String(startUrl.searchParams.get('state') || '').startsWith('user:'));
check('sign-in does not request send', !scope.includes('gmail.send') && !scope.includes('gmail.compose'));
const callback = await request(port, 'GET', '/api/gmail/oauth/callback?code=from-google&state=' + encodeURIComponent(startUrl.searchParams.get('state')));
const sessionCookie = cookieFrom(callback);
check('sign-in cookie', callback.status === 302 && sessionCookie.startsWith('gtm_user=') && !callback.body.includes(REFRESH));
const saved = secretCalls[0];
const secretJson = saved ? JSON.parse(saved.payload.SecretString) : {};
check('secret id', saved && saved.payload.SecretId === userSecretId('hollie@opstream.ai') && saved.payload.SecretId === 'opstream-gtm/users/' + userHash('hollie@opstream.ai') + '/google');
check('client token', saved && UUID.test(String(saved.payload.ClientRequestToken || '')));
check('secret has refresh token', secretJson.refresh_token === REFRESH && secretJson.email === 'hollie@opstream.ai');
const me = await request(port, 'GET', '/api/session', { cookie: sessionCookie });
const meJson = JSON.parse(me.body);
check('signed in header data', meJson.signedIn === true && meJson.email === 'hollie@opstream.ai' && meJson.name === 'Hollie Farrahi' && meJson.initials === 'HF' && !JSON.stringify(meJson).includes(REFRESH));

const ask = await request(port, 'POST', '/api/ask', { cookie: sessionCookie, body: JSON.stringify({ message: 'Please read my email about the upcoming shows', history: [] }) });
check('assistant cites email', ask.status === 200 && ask.body.includes('Upcoming shows') && !ask.body.includes(REFRESH));
check('gmail read was called', fetched.some(line => line.includes('/gmail/v1/users/me/messages')));
check('no send request', !fetched.some(line => line.includes('messages/send')));

const send = await request(port, 'POST', '/api/gmail/send', { cookie: sessionCookie, body: JSON.stringify({ to: 'a@b.c', subject: 'Hi', body: 'Hello', confirmed: true }) });
check('send route absent', send.status === 405);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['scripts/agent-server.mjs', 'scripts/google-workspace.mjs', 'scripts/google-identity.mjs', 'collaboration.js', 'source/workspace.html'].map(rel => fs.readFileSync(path.join(root, rel), 'utf8')).join('\n');
check('no send path in source', !sources.includes('messages/send') && !sources.includes('/api/gmail/send'));

const signedOut = await request(port, 'POST', '/auth/logout', { cookie: sessionCookie });
check('sign-out post', signedOut.status === 302 && String(signedOut.headers.location) === '/' && String(signedOut.headers['set-cookie']).includes('Max-Age=0'));
const afterPost = await request(port, 'GET', '/api/session', { cookie: sessionCookie });
check('session cleared', JSON.parse(afterPost.body).signedIn === false);
const linkOut = await request(port, 'GET', '/auth/logout');
check('sign-out link', linkOut.status === 302 && !String(linkOut.status) .includes('405'));

profileEmail = 'zackkaufman39@gmail.com';
const zackStart = await request(port, 'GET', '/api/google/sign-in');
const zackUrl = new URL(zackStart.headers.location);
const zack = await request(port, 'GET', '/api/gmail/oauth/callback?code=from-google&state=' + encodeURIComponent(zackUrl.searchParams.get('state')));
check('gmail allow list', zack.status === 302 && secretCalls.some(call => JSON.parse(call.payload.SecretString).email === 'zackkaufman39@gmail.com'));

workspaceModel.ownerCatalog = { '384787270': 'Hollie Farrahi', 'hollie.farrahi@opstream.ai': 'Hollie Farrahi' };
check('meeting owner name', workspaceModel.displayOwner('Owner 384787270') === 'Hollie Farrahi');
check('meeting email owner', workspaceModel.displayOwner('hollie.farrahi@opstream.ai') === 'Hollie Farrahi');
check('unknown owner stays numbered', workspaceModel.displayOwner('Owner 999001').startsWith('Owner #'));
const py = execFileSync('python3', ['-c', `
import sys
sys.path.insert(0, "scripts")
from gtm_metrics import owner_info
info = owner_info("Owner 384787270", 4, {"384787270": "Hollie Farrahi"})
print(info["label"])
`], { cwd: root, encoding: 'utf8' }).trim();
check('python owner catalog', py === 'Hollie Farrahi');

const brief = await buildPersonalBrief({
  fetchImpl,
  token: ACCESS,
  email: 'hollie@opstream.ai',
  index: gtmIndex({ companies: [] }, { deals: [] }),
  now: new Date('2026-09-27T18:00:00Z'),
});
check('personal brief', brief.meetings.length > 0 && brief.followUps.some(item => item.title.includes('Upcoming shows')) && !JSON.stringify(brief).includes(REFRESH));

const skipped = execFileSync('node', ['scripts/build-user-brief.mjs'], {
  cwd: root,
  input: JSON.stringify({ email: 'hollie@opstream.ai' }),
  encoding: 'utf8',
});
check('brief skips empty token', skipped.includes('"skipped":true') && !skipped.includes(REFRESH));

check('logs hide the token', !logs.join('\n').includes(REFRESH));
console.error = origError;
server.close();

const report = { ok: failures.length === 0, failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
