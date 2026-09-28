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
const thisWeek = (marketing.shows.items || []).filter(s => s.phase === 'soon' && s.approved);
const facts = JSON.parse(fs.readFileSync(path.join(root, 'out/data/run-facts.json'), 'utf8'));
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
  const theme = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return { accent: cs.getPropertyValue('--color-accent').trim(), bg: cs.getPropertyValue('--color-bg').trim(), banner: getComputedStyle(document.getElementById('topBanner')).backgroundColor, text: document.getElementById('topBanner').textContent }; });
  check(tag + ' uses the v10 theme', theme.accent.toLowerCase() === '#1ab396' && theme.bg.toLowerCase() === '#ffffff' && theme.banner === 'rgb(20, 62, 50)' && /collected /.test(theme.text), JSON.stringify(theme));
  const lemlist = await page.locator('#events-shows').innerText();
  check(tag + ' LemList stats state is said, not omitted', /LemList stats|sent and reply counts|stats not available on this API key/i.test(lemlist));
  const cards = await page.locator('section[aria-label="Priorities"] .priority-card').allInnerTexts();
  check(tag + ' priorities come from the operator', cards.length === hollie.marketingPriorities.length && cards.length >= 3,
    cards.length + ' vs ' + hollie.marketingPriorities.length);
  check(tag + ' first priority is this week\'s shows', thisWeek.length > 0 && thisWeek.every(s => cards[0].includes(s.name)));
  check(tag + ' show priority says where each show is', thisWeek.every(sh => new RegExp(sh.name + ' (is on now|starts (today|tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)|ends today)').test(cards[0])), cards[0].split('\n')[1]);
  check(tag + ' owner is Hollie with lead owners apart', /Owner: Hollie\b/.test(cards[0]) && !/Hollie \(marketing\)/.test(cards.join(' ')) && /Lead owners:/.test(cards.join(' ')));
  check(tag + ' spend is in dollars', /\$429K/.test(cards.join(' ')) && !/Currency is not stated/.test(cards.join(' ')));
  check(tag + ' cards show owner and latest activity', cards.every(t => /Owner:/.test(t) && /(Last interaction|Latest activity):/.test(t) && /Next step:/.test(t)));
  await shot(page, 'marketing-home-' + tag);
  const events = page.locator('#events-shows');
  const eventsText = await events.innerText();
  check(tag + ' events list this week\'s shows', thisWeek.every(s => eventsText.includes(s.name)));
  check(tag + ' events show planned and recorded', /Planned/.test(eventsText) && /Recorded/.test(eventsText));
  check(tag + ' events have prep checklist', /Prep/i.test(eventsText) && /Sponsorship signed/.test(eventsText));
  check(tag + ' shows with no data get one line', /No spend or attendees recorded yet/.test(eventsText));
  check(tag + ' unapproved and undated shows are compact', /Also on the calendar/i.test(eventsText) && /Workday Rising/.test(eventsText) && (await events.locator('.show-card', { hasText: 'Workday Rising' }).count()) === 0);
  check(tag + ' show money is $K', /\$28K/.test(eventsText) && /\$32\.7K/.test(eventsText));
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
    await checkDrafts(page);
    await checkTotals(page);
    await checkAccounts(page);
  }
  check(tag + ' page has no errors', errors.length === 0, errors.join(' | '));
  await context.close();
}

const num = t => Number(String(t || '').replace(/[^0-9.]/g, '') || 'NaN');

async function checkDrafts(page) {
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.setViewportSize({ width: 1440, height: 1000 });
  await fresh.goto(base + '/?view=drafts', { waitUntil: 'networkidle' });
  await fresh.getByRole('heading', { name: 'Drafts' }).waitFor();
  const tabs = await fresh.locator('.draft-purpose-tab').allInnerTexts();
  const count = label => num((tabs.find(t => t.startsWith(label)) || '').replace(label, ''));
  check('drafts are pre-filled on first load', (await fresh.locator('.draft-list-item').count()) > 0 && count('Event follow-ups') > 0 && count('LinkedIn posts') > 0 && count('Campaign drafts') > 0, tabs.join(' | '));
  await fresh.locator('.draft-purpose-tab', { hasText: 'Campaign drafts' }).click();
  const campaign = await fresh.locator('main').innerText();
  check('campaign draft copies for LemList', /Copy for LemList/.test(campaign) && /Version history/.test(campaign) && (await fresh.locator('.content-modes select').count()) === 2);
  await fresh.locator('.draft-purpose-tab', { hasText: 'Event follow-ups' }).click();
  const event = await fresh.locator('main').innerText();
  check('event follow-up is an email with a send path', /Event follow-ups/.test(event) && /\bTo\b/.test(event) && /Send via Gmail|Sign in with Google/.test(event));
  if (shots) await fresh.screenshot({ path: path.join(shots, 'drafts-desktop.png') });
  await context.close();
}

async function viewShots() {
  if (!shots) return;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [name, query] of [['pipeline-demand', 'view=pipeline&perf=demand'], ['pipeline-spend', 'view=pipeline&perf=spend'], ['pipeline-web', 'view=pipeline&perf=web'], ['accounts', 'view=accounts'], ['about', 'view=data']]) {
    await page.goto(base + '/?' + query, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, name + '-desktop.png') });
  }
  const spend = await (async () => { await page.goto(base + '/?view=pipeline&perf=spend', { waitUntil: 'networkidle' }); await page.waitForTimeout(400); return page.locator('main').innerText(); })();
  check('spend tab shows workbook actuals and ads', /\$27\.9K/.test(spend) && /Google Ads/.test(spend) && /Event payments not given to any one show/i.test(spend), [/\$27\.9K/.test(spend), /Google Ads/.test(spend), /Event payments not given/i.test(spend)].join(','));
  const web = await (async () => { await page.goto(base + '/?view=pipeline&perf=web', { waitUntil: 'networkidle' }); await page.waitForTimeout(400); return page.locator('main').innerText(); })();
  check('web tab shows AI mentions from Otterly', /AI answers mentioning Opstream/.test(web) && /46%/.test(web) && /Otterly/.test(web));
  await context.close();
}

async function checkTotals(page) {
  await goView(page, 'Today');
  await page.getByRole('button', { name: 'Marketing', exact: true }).click();
  const rows = await page.locator('#marketing-numbers .figure-row').allInnerTexts();
  const quarterRow = rows.find(r => /Quarter to date/.test(r)) || '';
  const weekRow = rows.find(r => /Last 7 days/.test(r)) || '';
  const qLeads = num(quarterRow.split('\n').pop());
  const qMql = num((quarterRow.match(/MQL ([\d,]+)/) || [])[1]);
  const qSql = num((quarterRow.match(/SQL ([\d,]+)/) || [])[1]);
  const sideSources = await page.locator('#marketing-numbers tbody tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
  check('side sources add up to the quarter', sideSources.reduce((n, r) => n + num(r[2]), 0) === qLeads, sideSources.length + ' rows vs ' + qLeads);
  check('side sources add up to the last 7 days', sideSources.reduce((n, r) => n + num(r[1]), 0) === num(weekRow.split('\n').pop()), weekRow);
  check('marketing numbers match run facts', qLeads === facts.leads && qMql === facts.mql && qSql === facts.sql, [qLeads, qMql, qSql].join('/') + ' vs ' + [facts.leads, facts.mql, facts.sql].join('/'));
  const unworkedCard = (await page.locator('section[aria-label="Priorities"] .priority-card', { hasText: 'have no MQL date yet' }).first().innerText().catch(() => '')).match(/(\d[\d,]*) leads have no MQL date yet/);
  await page.getByRole('button', { name: 'Sales & CS', exact: true }).click();
  const salesText = await page.locator('main').innerText();
  const salesUnworked = (salesText.match(/(\d[\d,]*) with no MQL date yet/) || [])[1];
  check('unworked leads agree', unworkedCard && salesUnworked && num(unworkedCard[1]) === num(salesUnworked), (unworkedCard && unworkedCard[1]) + ' vs ' + salesUnworked);
  check('sales brief repeats the quarter', salesText.includes(facts.leads + ' leads / ' + facts.mql + ' MQL / ' + facts.sql + ' SQL'));
  await goView(page, 'Pipeline');
  const cards = await page.locator('main button').evaluateAll(bs => bs.map(b => b.innerText));
  const card = label => num(((cards.find(t => t.startsWith(label)) || '').split('\n')[1]));
  check('pipeline cards match', card('New leads') === facts.leads && card('Marketing qualified') === facts.mql && card('Sales qualified') === facts.sql, [card('New leads'), card('Marketing qualified'), card('Sales qualified')].join('/'));
  const tables = await page.locator('main table').evaluateAll(ts => ts.map(t => [...t.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))));
  const bySource = tables.find(t => t.length && t[0].length === 5) || [];
  check('selected period by source adds up', bySource.reduce((n, r) => n + num(r[1]), 0) === facts.leads && bySource.reduce((n, r) => n + num(r[2]), 0) === facts.mql && bySource.reduce((n, r) => n + num(r[3]), 0) === facts.sql);
  check('no unknown source bucket', !bySource.some(r => /Unknown source/.test(r[0])));
  const leadSources = tables.find(t => t.length && t[0].length === 4) || [];
  check('leads by source quarter adds up', leadSources.reduce((n, r) => n + num(r[3]), 0) === facts.leads);
  const { computeFacts, runAssistantTool } = await import('./workspace-facts.mjs');
  const read = n => JSON.parse(fs.readFileSync(path.join(root, 'out/data', n), 'utf8'));
  const assistant = JSON.parse(runAssistantTool('get_pipeline_metrics', {}, computeFacts(read('verified.json'), read('records.json'), null, read('sheet-review.json'))));
  check('assistant repeats the same numbers', assistant.leads === facts.leads && assistant.mql === facts.mql && assistant.sql === facts.sql, [assistant.leads, assistant.mql, assistant.sql].join('/'));
}

async function checkAccounts(page) {
  await goView(page, 'Accounts');
  const text = await page.locator('main').innerText();
  const rows = await page.locator('main table tbody tr').allInnerTexts();
  check('accounts have no Opstream or event names', !rows.some(r => /^Opstream\b|The future of procurement/.test(r)) && rows.some(r => /BT Sourced/.test(r)) && rows.some(r => /TAPI \(Teva\)/.test(r)));
  const flagged = rows.filter(r => /HubSpot (amount|close|stage|owner)/.test(r)).length;
  check('HubSpot differences are specific', flagged > 0 && flagged < rows.length && !rows.some(r => /HubSpot differs/.test(r)), flagged + ' of ' + rows.length);
  check('placeholder close date is flagged', /probably a placeholder/.test(text) && rows.some(r => /likely placeholder close date/.test(r)));
  const taboola = rows.find(r => /^Taboola/.test(r)) || '';
  await page.getByRole('button', { name: 'Today' }).first().click();
  await page.getByRole('button', { name: 'Sales & CS', exact: true }).click();
  const nudge = await page.locator('article', { hasText: 'Nudge Taboola' }).first().innerText().catch(() => '');
  const owner = (nudge.match(/Owner: ([^\n]+?)(\s+Last interaction|\n|$)/) || [])[1] || '';
  check('Taboola owner matches Accounts', owner && taboola.includes(owner.trim().split(' ')[0]), owner + ' | ' + taboola.slice(0, 60));
  await goView(page, 'Meetings');
  const options = await page.locator('main select').first().locator('option').allInnerTexts();
  const firsts = options.filter(o => o !== 'Unassigned').map(o => o.split(' ')[0].toLowerCase());
  check('meeting owners are not duplicated', firsts.length === new Set(firsts).size, options.join(', '));
  await goView(page, 'Pipeline');
  const pipe = await page.locator('main').innerText();
  const rule = (pipe.match(/Open pipeline is the [^\n]+/) || [''])[0];
  check('pipeline states its rule', new RegExp('Open pipeline is the ' + facts.openCount + ' active new-business rows').test(rule) && /Not included: \d+ renewals and customer expansions \(\$[\d.]+[KM]/.test(rule) && /\d+ On Hold/.test(rule), rule);
  check('accounts state the same rule', /Open pipeline is the \d+ active new-business rows/.test(text));
  check('renewals are collapsed', /Show the \d+ renewals/.test(pipe) && !/No company linked|Scott McKenna/.test(pipe));
}

await publicRun(1440, 'desktop');
await viewShots();
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
  await page.locator('header .signed-in-user').waitFor();
  await page.locator('section[aria-label="Your brief"]').waitFor();
  const header = await page.locator('header').innerText();
  check(tag + ' header names the signed-in person', /Hollie Farrahi/.test(header) && /hollie@opstream\.ai/.test(header) && /Sign out/.test(header) && !/Shared view/.test(header));
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
  const amsterdam = await page.locator('#events-shows .show-card', { hasText: 'DPW Amsterdam' }).first().innerText();
  check(tag + ' calendar overlap is shown with a citation', /On your calendar: DPW Amsterdam booth shift/.test(amsterdam) && /Google Calendar/.test(amsterdam));
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
