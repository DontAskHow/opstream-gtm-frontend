// End-to-end browser check of Hollie's Marketing home, Events & shows, Sales & CS,
// Connections, and the LinkedIn draft. Google is mocked at the HTTP boundary.
// SCREENSHOT_DIR=<dir> also saves desktop and mobile screenshots.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-unit-fixture';
process.env.OPENAI_API_KEY = '';

const { createServer, setHooks, resetAuth } = await import('./agent-server.mjs');

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
  else console.log('ok ' + name);
}

const REFRESH = 'refresh-token-unit-fixture';
const PHOTO = 'https://photos.example.test/hollie.png';
const fetched = [];
const chats = [];
const logs = [];
const origError = console.error;
console.error = (...args) => { logs.push(args.map(String).join(' ')); };

async function fetchImpl(url, opts) {
  const target = String(url);
  fetched.push(target + ' ' + ((opts && opts.method) || 'GET'));
  if (target.includes('oauth2.googleapis.com/token')) {
    return { ok: true, json: async () => ({ refresh_token: REFRESH, access_token: 'access-hollie', expires_in: 3600, scope: '' }) };
  }
  if (target.includes('userinfo')) {
    return { ok: true, json: async () => ({ email: 'hollie@opstream.ai', name: 'Hollie Farrahi', picture: PHOTO }) };
  }
  if (target.includes('/gmail/v1/users/me/messages?')) return { ok: true, json: async () => ({ messages: [{ id: 'm1' }] }) };
  if (target.includes('/gmail/v1/users/me/messages/')) {
    return { ok: true, json: async () => ({ id: 'm1', snippet: 'Booth 14 is confirmed', payload: { headers: [{ name: 'Subject', value: 'DPW Amsterdam booth confirmation' }, { name: 'From', value: 'events@dpw.example' }] } }) };
  }
  if (target.includes('calendar')) {
    return { ok: true, json: async () => ({ items: [{ summary: 'DPW Amsterdam booth shift', start: { date: '2026-09-30' } }] }) };
  }
  if (target.includes('drive/v3/files?')) {
    return { ok: true, json: async () => ({ files: [{ id: 'f1', name: 'DPW Amsterdam talk track', mimeType: 'application/vnd.google-apps.document' }] }) };
  }
  throw new Error('unexpected url ' + target);
}

async function callChatApi(payload) {
  chats.push(payload);
  const user = payload.messages.find(m => m.role === 'user');
  if (user && /Write one LinkedIn post/.test(user.content)) {
    const google = /OWN GOOGLE WORKSPACE/.test(user.content);
    return { choices: [{ message: { content: google ? 'We are at DPW Amsterdam this week. Booth 14.' : 'Opstream will be at the show this week.' } }] };
  }
  return { choices: [{ message: { content: '<p>Ask me about your marketing.</p>' } }] };
}

setHooks({
  fetchImpl,
  callChatApi,
  persistStateFile: async () => {},
  putSecretString: async () => '{}',
});
resetAuth();
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

function request(method, reqPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + reqPath, {
      method, headers: { cookie: cookie || '', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const marketing = JSON.parse(fs.readFileSync(path.join(root, 'out/data/marketing.json'), 'utf8'));
const hollie = JSON.parse(fs.readFileSync(path.join(root, 'out/data/hollie.json'), 'utf8'));
const thisWeek = (marketing.shows.items || []).filter(s => s.phase === 'this-week');
const shots = process.env.SCREENSHOT_DIR || '';
if (shots) fs.mkdirSync(shots, { recursive: true });

const LEFTOVERS = [
  [/HubSpot stage id/i, 'HubSpot stage id'],
  [/\bCompany \d{6,}\b/, 'raw company id'],
  [/priority-pins/i, 'priority-pins file'],
  [/Summary is not in English/i, 'language tag'],
  [/AI: —|through —/, 'empty AI range'],
  [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(\+00:00|Z)/, 'raw timestamp'],
  [/August and September have no actuals entered/, 'stale About spend line'],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome', args: ['--no-sandbox'] });

async function openPage(context, width) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('photos.example.test')) errors.push(r.status() + ' ' + r.url()); });
  await page.route('https://photos.example.test/**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="14" fill="#ec3013"/></svg>' }));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Where to focus' }).waitFor();
  await page.locator('.priority-card').first().waitFor();
  return { page, errors };
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: false });
}

async function leftovers(page, label) {
  const text = await page.locator('body').innerText();
  for (const [re, what] of LEFTOVERS) check(label + ' has no ' + what, !re.test(text), (text.match(re) || [])[0]);
}

async function goView(page, label) {
  await page.locator('header nav button', { hasText: label }).first().click();
  await page.waitForTimeout(300);
}

async function publicRun(width, tag) {
  const context = await browser.newContext();
  const { page, errors } = await openPage(context, width);
  const pressed = await page.getByRole('button', { name: 'Marketing', exact: true }).getAttribute('aria-pressed');
  check(tag + ' marketing is the home view', pressed === 'true');
  const cards = await page.locator('section[aria-label="Priorities"] .priority-card').allInnerTexts();
  check(tag + ' priorities come from the operator', cards.length === hollie.marketingPriorities.length && cards.length >= 3,
    cards.length + ' vs ' + hollie.marketingPriorities.length);
  check(tag + ' first priority is this week\'s shows', thisWeek.every(s => cards[0].includes(s.name)));
  check(tag + ' cards show owner and last interaction', cards.every(t => /Owner:/.test(t) && /Last interaction:/.test(t) && /Next step:/.test(t)));
  await shot(page, 'marketing-home-' + tag);
  const events = page.locator('#events-shows');
  const eventsText = await events.innerText();
  check(tag + ' events list this week\'s shows', thisWeek.every(s => eventsText.includes(s.name)));
  check(tag + ' events show planned and recorded', /Planned/.test(eventsText) && /Recorded/.test(eventsText));
  check(tag + ' events have prep checklist', /Prep/i.test(eventsText) && /Sponsorship signed/.test(eventsText));
  await events.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById('events-shows').scrollIntoView({ block: 'start' }));
  await shot(page, 'events-shows-' + tag);
  await leftovers(page, tag + ' marketing');

  if (width >= 600) {
    const first = page.locator('section[aria-label="Priorities"] .priority-card').first();
    await first.locator('button[aria-pressed]').first().click();
    check('star marks a priority', (await page.locator('section[aria-label="Priorities"] .priority-card').first().locator('button[aria-pressed]').first().getAttribute('aria-pressed')) === 'true');
    const card = page.locator('section[aria-label="Priorities"] .priority-card').nth(1);
    await card.locator('button[aria-expanded]').first().click();
    const box = card.locator('textarea');
    await box.click();
    await box.pressSequentially('Can you take these, @Dou');
    await card.locator('.mention-option', { hasText: 'Doug Daniels' }).click();
    await card.getByRole('button', { name: 'Save comment' }).click();
    await card.locator('.priority-comment').first().waitFor();
    const saved = await card.locator('.priority-comments').innerText();
    check('comment keeps the @mention', /@Doug Daniels/.test(saved) && /Nobody is notified/.test(saved));
  }

  await page.getByRole('button', { name: 'Sales & CS', exact: true }).click();
  await page.getByRole('heading', { name: 'What the team needs today' }).waitFor();
  const sales = await page.locator('main').innerText();
  check(tag + ' sales view keeps the queue', /Action queue/i.test(sales) && !/Where to focus/.test(sales));
  await shot(page, 'sales-cs-' + tag);
  await leftovers(page, tag + ' sales');

  await page.locator('.workspace-account-button').click();
  const panel = page.locator('section[aria-label="Connections"]');
  await panel.waitFor();
  const conn = await panel.innerText();
  check(tag + ' signed-out connections offer sign-in', /Sign in with Google/.test(conn));
  await page.evaluate(() => scrollTo(0, 0));
  await shot(page, 'connections-signed-out-' + tag);

  if (width >= 600) {
    for (const label of ['Pipeline', 'Accounts', 'Meetings', 'Drafts']) {
      await goView(page, label);
      await leftovers(page, label.toLowerCase());
    }
    await page.locator('header button', { hasText: 'About this data' }).first().click();
    await page.waitForTimeout(300);
    await leftovers(page, 'about');
    await goView(page, 'Drafts');
    const mode = await page.locator('select').filter({ has: page.locator('option[value="cs"]') }).first().inputValue().catch(() => '');
    check('content mode defaults to marketing', mode === 'marketing' || mode === '', mode);
    await goView(page, 'Today');
    await page.getByRole('button', { name: 'Marketing', exact: true }).click();
    await page.locator('#events-shows .show-card').first().getByRole('button', { name: 'Draft LinkedIn post' }).click();
    await page.getByRole('heading', { name: 'Drafts' }).waitFor();
    const draftText = await page.locator('main').innerText();
    check('signed-out LinkedIn draft opens in Drafts', /LinkedIn posts/.test(draftText) && /Sources:/.test(draftText) && /Dashboard:/.test(draftText) && !/Gmail:/.test(draftText));
  }
  check(tag + ' page has no errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

await publicRun(1440, 'desktop');
await publicRun(390, 'mobile');
check('signed-out visitor never calls Google', !fetched.some(line => /googleapis\.com\/(gmail|calendar|drive)/.test(line)));

const start = await request('GET', '/api/google/sign-in');
const state = new URL(start.headers.location).searchParams.get('state');
const callback = await request('GET', '/api/gmail/oauth/callback?code=from-google&state=' + encodeURIComponent(state));
const cookie = String([].concat(callback.headers['set-cookie'] || [])[0] || '').split(';')[0];
check('mock sign-in', callback.status === 302 && cookie.startsWith('gtm_user='));
const sid = cookie.split('=')[1];

for (const [width, tag] of [[1440, 'desktop'], [390, 'mobile']]) {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'gtm_user', value: sid, url: base }]);
  const { page, errors } = await openPage(context, width);
  await page.locator('header', { hasText: 'Signed in as' }).waitFor();
  await page.locator('section[aria-label="Your brief"]').waitFor();
  const header = await page.locator('header').innerText();
  check(tag + ' header names the signed-in person', /Signed in as\s+Hollie Farrahi/.test(header));
  const photo = await page.locator('header .header-photo').getAttribute('style');
  check(tag + ' header shows the Google photo', String(photo || '').includes(PHOTO));
  const main = await page.locator('main').innerText();
  check(tag + ' your brief is on the marketing home', /your brief/i.test(main) && /DPW Amsterdam booth/.test(main));
  await shot(page, 'marketing-home-signed-in-' + tag);
  await page.locator('.workspace-account-button').click();
  const panel = page.locator('section[aria-label="Connections"]');
  await panel.waitFor();
  const conn = await panel.innerText();
  check(tag + ' connections show the signed-in mailbox', /Connected as hollie@opstream\.ai/.test(conn) && !/disabled/i.test(conn));
  await page.evaluate(() => scrollTo(0, 0));
  await shot(page, 'connections-signed-in-' + tag);
  if (width >= 600) {
    await page.locator('section[aria-label="Connections"]').getByRole('button', { name: 'Close' }).click();
    const card = page.locator('#events-shows .show-card', { hasText: 'DPW Amsterdam' }).first();
    await card.getByRole('button', { name: 'Draft LinkedIn post' }).click();
    await page.getByRole('heading', { name: 'Drafts' }).waitFor();
    const draft = await page.locator('main').innerText();
    check('signed-in LinkedIn draft cites Gmail, Calendar and Drive',
      /Gmail: “DPW Amsterdam booth confirmation”/.test(draft) && /Calendar: “DPW Amsterdam booth shift”/.test(draft) && /Drive: “DPW Amsterdam talk track”/.test(draft));
    check('signed-in LinkedIn draft uses the model text', /Booth 14/.test(await page.locator('textarea#draft-message').inputValue()));
    await shot(page, 'linkedin-draft-signed-in-' + tag);
  }
  check(tag + ' signed-in page has no errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

const linkedInChats = chats.filter(c => /Write one LinkedIn post/.test((c.messages.find(m => m.role === 'user') || {}).content || ''));
check('LinkedIn prompt has no send or post tool', linkedInChats.every(c => !c.tools));
check('nothing was sent or posted', !fetched.some(line => /messages\/send|\/drafts |linkedin\.com/i.test(line)));
check('logs hide the token', !logs.join('\n').includes(REFRESH));

console.error = origError;
await browser.close();
server.close();
const report = { ok: failures.length === 0, failures, screenshots: shots || null };
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
