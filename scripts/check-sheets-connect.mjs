// One-time Sheets consent: state, scopes, and the refresh token stays out of HTML.
import { createSheetsConnect, REFRESH_SECRET_ID, SHEETS_SCOPES } from './sheets-connect.mjs';
import { SecretError, putSecretString } from './published-swap.mjs';

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
  else console.log('ok ' + name);
}

const REFRESH = 'refresh-token-unit-fixture';
const ACCESS = 'access-token-unit-fixture';
const SECRET = 'client-secret-unit-fixture';
const REDIRECT = 'https://dash.example/api/gmail/oauth/callback';

let now = 1_700_000_000_000;
const saved = [];
let fetches = 0;

function fakeFetch(url, opts) {
  fetches += 1;
  if (String(url).includes('oauth2.googleapis.com/token')) {
    const body = String(opts.body || '');
    check('token post has secret', body.includes('client_secret=' + encodeURIComponent(SECRET)) || body.includes(SECRET), 'missing');
    check('token post has code', body.includes('code=from-google'), 'missing');
    return Promise.resolve({
      ok: true,
      json: async () => ({ refresh_token: REFRESH, access_token: ACCESS, expires_in: 3600 }),
    });
  }
  if (String(url).includes('userinfo')) {
    return Promise.resolve({ ok: true, json: async () => ({ email: 'zackkaufman39@gmail.com' }) });
  }
  throw new Error('unexpected url');
}

const connect = createSheetsConnect({
  loadClient: async () => ({ clientId: 'client-id.apps.googleusercontent.com', clientSecret: SECRET }),
  saveRefreshToken: async (token) => { saved.push(token); },
  fetchImpl: fakeFetch,
  now: () => now,
  randomBytes: (n) => Buffer.alloc(n, 7),
});

const started = await connect.start(REDIRECT);
const auth = new URL(started.url);
check('offline', auth.searchParams.get('access_type') === 'offline');
check('consent', auth.searchParams.get('prompt') === 'consent');
check('granted scopes kept', auth.searchParams.get('include_granted_scopes') === 'true');
check('redirect uri', auth.searchParams.get('redirect_uri') === REDIRECT, auth.searchParams.get('redirect_uri'));
check('client id', auth.searchParams.get('client_id') === 'client-id.apps.googleusercontent.com');
check('no client secret in url', !started.url.includes(SECRET));
check('sheets state', started.state.startsWith('sheets:') && auth.searchParams.get('state') === started.state);
const scope = auth.searchParams.get('scope') || '';
for (const item of SHEETS_SCOPES) check('scope ' + item.split('/').pop(), scope.includes(item));

const unknown = await connect.callback({ code: 'from-google', state: 'sheets:not-issued', error: '', redirectUri: REDIRECT });
check('unknown state', unknown.ok === false && unknown.status === 400 && fetches === 0);

const ok = await connect.callback({ code: 'from-google', state: started.state, error: '', redirectUri: REDIRECT });
check('saved once', saved.length === 1 && saved[0] === REFRESH);
check('success email', ok.ok && ok.html.includes('zackkaufman39@gmail.com') && ok.html.includes(REFRESH_SECRET_ID));
check('html hides tokens', !ok.html.includes(REFRESH) && !ok.html.includes(ACCESS) && !ok.html.includes(SECRET));

const replay = await connect.callback({ code: 'from-google', state: started.state, error: '', redirectUri: REDIRECT });
check('replay rejected', replay.ok === false && saved.length === 1);

const again = await connect.start(REDIRECT);
now += 11 * 60 * 1000;
const expired = await connect.callback({ code: 'from-google', state: again.state, error: '', redirectUri: REDIRECT });
check('expired rejected', expired.ok === false && saved.length === 1 && !expired.html.includes(REFRESH));

const hostile = await connect.start(REDIRECT);
const denied = await connect.callback({
  code: 'from-google',
  state: hostile.state,
  error: 'access_denied attacker-controlled description',
  redirectUri: REDIRECT,
});
check('error not echoed', denied.ok === false && !denied.html.includes('attacker-controlled') && !denied.html.includes(REFRESH));

let stored = [];
const noRefreshFetch = async (url) => {
  if (String(url).includes('userinfo')) return { ok: true, json: async () => ({ email: 'x@y.z' }) };
  return { ok: true, json: async () => ({ access_token: ACCESS }) };
};
const bare = createSheetsConnect({
  loadClient: async () => ({ clientId: 'id', clientSecret: SECRET }),
  saveRefreshToken: async (token) => { stored.push(token); },
  fetchImpl: noRefreshFetch,
  now: () => now,
});
const bareStart = await bare.start(REDIRECT);
const bareResult = await bare.callback({ code: 'abc', state: bareStart.state, redirectUri: REDIRECT });
check('missing refresh token', bareResult.ok === false && stored.length === 0 && !bareResult.html.includes(ACCESS));

const leak = createSheetsConnect({
  loadClient: async () => ({ clientId: 'id', clientSecret: SECRET }),
  saveRefreshToken: async () => { throw new Error(REFRESH); },
  fetchImpl: fakeFetch,
  now: () => now,
});
const leakStart = await leak.start(REDIRECT);
const leakResult = await leak.callback({ code: 'from-google', state: leakStart.state, redirectUri: REDIRECT });
check('save failure hides token', leakResult.status === 500 && !leakResult.html.includes(REFRESH) && !leakResult.html.includes(ACCESS));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const calls = [];
await putSecretString(REFRESH_SECRET_ID, REFRESH, {
  request(action, payload) {
    calls.push({ action, payload });
    if (action === 'PutSecretValue') {
      if (payload.SecretString !== REFRESH || payload.SecretId !== REFRESH_SECRET_ID) throw new Error('payload');
      throw new SecretError('ResourceNotFoundException');
    }
    if (payload.SecretString !== REFRESH || payload.Name !== REFRESH_SECRET_ID) throw new Error('payload');
    return Buffer.from('{}');
  },
});
check('create secret', calls.map((call) => call.action).join(',') === 'PutSecretValue,CreateSecret');
for (const call of calls) {
  check(
    'client token ' + call.action,
    UUID.test(String(call.payload.ClientRequestToken || '')),
    String(call.payload.ClientRequestToken || ''),
  );
}

let deniedSave = false;
try {
  await putSecretString(REFRESH_SECRET_ID, REFRESH, {
    request() {
      const err = new Error('boom ' + REFRESH);
      err.code = 'AccessDeniedException';
      throw err;
    },
  });
} catch (err) {
  deniedSave = true;
  check('secret error hides value', err.code === 'AccessDeniedException' && !String(err.message).includes(REFRESH) && !String(err).includes(REFRESH));
}
check('secret error thrown', deniedSave);

const report = { ok: failures.length === 0, failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
