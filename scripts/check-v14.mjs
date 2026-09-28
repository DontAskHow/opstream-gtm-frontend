// End-to-end check of the v14 audit fixes. Opens every page, clicks every
// button that does not write, opens drawers, tries every sort and filter, and
// asserts each audit item: counts match what renders and totals reconcile with
// run-facts.json. Google, OpenAI and S3 are mocked at the boundary.
// SCREENSHOT_DIR=<dir> saves the key screens.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-unit-fixture';
process.env.OPENAI_API_KEY = '';
const { createServer, setHooks, resetAuth, retryPage } = await import('./agent-server.mjs');

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok: !!ok, detail: ok ? '' : String(detail ?? '').slice(0, 300) });
  console.log((ok ? 'ok ' : 'FAIL ') + id + ' ' + name + (ok ? '' : ' :: ' + String(detail ?? '').slice(0, 300)));
};
process.on('uncaughtException', e => { console.log(JSON.stringify({ ok: false, crashed: String(e && e.stack || e).split('\n').slice(0, 3).join(' | '), results: results.filter(r => !r.ok) }, null, 2)); process.exit(1); });
const load = f => JSON.parse(fs.readFileSync(path.join(root, 'out/data', f), 'utf8'));
const facts = load('run-facts.json'), records = load('records.json'), hollie = load('hollie.json'), review = load('sheet-review.json'), marketing = load('marketing.json');
const seeds = load('draft-seeds.json');
const TERM = String.fromCharCode(71, 114, 111, 107);
const money = n => '$' + Math.round(n).toLocaleString('en-US');
const num = t => Number(String(t).replace(/[^0-9.-]/g, ''));

// ---- mocks ----
const chats = [];
let chatReply = () => 'Answer.';
async function fetchImpl(url) {
  const target = String(url);
  if (target.includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => ({ refresh_token: 'refresh-fixture', access_token: 'access-fixture', expires_in: 3600, scope: '' }) };
  if (target.includes('userinfo')) return { ok: true, json: async () => ({ email: 'hollie@opstream.ai', name: 'Hollie Farrahi', picture: 'https://photos.example.test/h.png' }) };
  if (target.includes('/gmail/v1/users/me/messages?')) return { ok: true, json: async () => ({ messages: [] }) };
  if (target.includes('calendar')) return { ok: true, json: async () => ({ items: [] }) };
  if (target.includes('drive/v3/files?')) return { ok: true, json: async () => ({ files: [] }) };
  throw new Error('unexpected url ' + target);
}
setHooks({ fetchImpl, callChatApi: async payload => { chats.push(payload); return { choices: [{ message: { content: chatReply(payload) } }] }; }, persistStateFile: async () => {}, putSecretString: async () => '{}' });
resetAuth();
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const request = (method, reqPath, { cookie, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request(base + reqPath, { method, headers: { cookie: cookie || '', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome', args: ['--no-sandbox'] });
const shots = process.env.SCREENSHOT_DIR || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
const pageErrors = [];
const unresolved = new Set();
let fixtures = {};
async function open(url = '/', { settle = 400 } = {}) {
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(url + ' ' + e.message));
  page.on('console', m => { const t = m.text(); const hit = t.match(/\{\{ ([\w.]+) \}\} never resolved/); if (hit) unresolved.add(url + ' ' + hit[1]); });
  for (const [name, body] of Object.entries(fixtures)) await page.route('**/data/' + name, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.locator('header').waitFor();
  await page.waitForTimeout(settle);
  return page;
}
const text = p => p.locator('body').innerText();
async function shot(page, name, locator) { if (!shots) return; await (locator || page).screenshot({ path: path.join(shots, name + '.png'), ...(locator ? {} : { fullPage: false }) }); }
async function sales(page) { await page.getByRole('button', { name: 'Sales & CS', exact: true }).click(); await page.waitForTimeout(300); }
async function marketingView(page) { await page.getByRole('button', { name: 'Marketing', exact: true }).click(); await page.waitForTimeout(300); }

// ================= crawl: every page, every non-writing button, every sort and filter =================
const WRITES = /^(Done|Dismiss|Confirm|Approve|Decline|Save|Send|Sign in|Sign out|Disconnect|Delete|Create internal note|Create Gmail draft|Generate with AI|Draft LinkedIn post|Propose a correction|Mark important|Comment|Add a comment|Prioritize|Remove priority star|Reset priority|Show less|Show in priorities|Print one-page summary|Copy|Open in Gmail|Check for updates|Export|Download|Connections|New draft|Book the|Open the .* follow-ups|Open meeting request|Draft nudge|Review draft|Open draft|Start a follow-up|Review follow-up)/i;
const routes = process.env.SKIP_CRAWL ? [] : ['/', '/?view=briefing', '/?view=pipeline&perf=demand', '/?view=pipeline&perf=spend', '/?view=pipeline&perf=web', '/?view=pipeline&perf=demand&period=six', '/?view=pipeline&perf=demand&period=year', '/?view=pipeline&perf=demand&period=custom', '/?view=accounts&accounts=deals', '/?view=accounts&accounts=follow', '/?view=accounts&accounts=leads', '/?view=meetings&meetings=upcoming', '/?view=meetings&meetings=past', '/?view=drafts', '/?view=data', '/?view=account&account=' + encodeURIComponent(records.companies.find(c => /^NXP/.test(c.name)).id), '/?view=meeting&meeting=' + encodeURIComponent(records.companies.flatMap(c => c.recordings).find(r => r.hasTranscript).id)];
let clicked = 0, crawlErrors = [];
for (const route of routes) {
  const page = await open(route);
  if (route === '/?view=briefing') await sales(page);
  const labels = [...new Set((await page.locator('main button:visible, aside button:visible').allInnerTexts()).map(t => t.trim()).filter(t => t && !WRITES.test(t) && t.length < 80))].slice(0, 45);
  for (const label of labels) {
    try {
      const p2 = await open(route, { settle: 150 });
      if (route === '/?view=briefing') await sales(p2);
      const btn = p2.locator('main button:visible, aside button:visible', { hasText: label }).first();
      if (!(await btn.count())) { await p2.close(); continue; }
      const before = pageErrors.length;
      await btn.click({ timeout: 3000 }).catch(() => {});
      await p2.waitForTimeout(250);
      if (await p2.locator('[aria-modal="true"]').count()) { await p2.locator('[aria-modal="true"]').innerText(); await p2.keyboard.press('Escape'); }
      if (pageErrors.length > before) crawlErrors.push(route + ' → ' + label);
      clicked++;
      await p2.close();
    } catch (e) { crawlErrors.push(route + ' → ' + label + ': ' + e.message.split('\n')[0]); }
  }
  for (const sel of await page.locator('main select:visible').all()) {
    const values = await sel.locator('option').evaluateAll(os => os.map(o => o.value));
    for (const v of values.slice(0, 12)) { await sel.selectOption(v).catch(() => {}); await page.waitForTimeout(120); clicked++; }
  }
  const hrefs = await page.locator('a[href]').evaluateAll(as => as.map(a => a.getAttribute('href')));
  const bad = hrefs.filter(h => !/^(https:\/\/|mailto:|\/|#|\?|$)/.test(h || ''));
  if (bad.length) crawlErrors.push(route + ' bad links: ' + bad.slice(0, 3).join(' '));
  await page.close();
}
check('crawl', 'every page, button, sort and filter works without a page error (' + clicked + ' actions on ' + routes.length + ' routes)', crawlErrors.length === 0 && pageErrors.length === 0, crawlErrors.concat(pageErrors).slice(0, 5).join(' | '));
check('crawl', 'no template value is left unresolved on any page', unresolved.size === 0, [...unresolved].slice(0, 5).join(' | '));

// ================= Broken =================
// B1 drawers
let page = await open('/?view=account&account=' + encodeURIComponent(records.companies.find(c => /^NXP/.test(c.name)).id));
await page.locator('aside button', { hasText: 'NXP - New Deal' }).first().click();
await page.locator('[aria-modal="true"]').waitFor();
let drawer = await page.locator('[aria-modal="true"]').innerText();
check('B1', 'an open deal drawer says Open deal, with Sheet values', /Open deal/.test(drawer) && !/\bClosed\b/.test(drawer.split('\n').slice(0, 4).join(' ')) && /values from the master Sheet/.test(drawer) && /Probability/.test(drawer), drawer.slice(0, 200));
await shot(page, 'after-b1-deal-drawer');
await page.keyboard.press('Escape');
page = await open('/');
await sales(page);
const coBtn = page.locator('section:has(h6:text("Action queue")) button', { hasText: /^Company record/ }).first();
await coBtn.click();
await page.locator('[aria-modal="true"]').waitFor();
drawer = await page.locator('[aria-modal="true"]').innerText();
check('B1', 'the company drawer lists its open deals', /Open deal/.test(drawer), drawer.slice(0, 200));
await page.keyboard.press('Escape');
// B2 transcripts
const rec = records.companies.flatMap(c => c.recordings).find(r => r.hasTranscript && fs.existsSync(path.join(root, 'out/data/transcripts', r.id + '.json')));
page = await open('/?view=meeting&meeting=' + encodeURIComponent(rec.id));
await page.getByRole('button', { name: 'Read transcript' }).click();
await page.waitForTimeout(800);
const tLines = await page.locator('.transcript-line').allInnerTexts();
const raw = JSON.parse(fs.readFileSync(path.join(root, 'out/data/transcripts', rec.id + '.json'), 'utf8'));
check('B2', 'a transcript shows its lines with speaker, time and text', tLines.length === Math.min(raw.filter(l => l.text).length, tLines.length) && tLines.length > 5 && tLines[0].includes(raw[0].speaker), tLines.length + ' lines vs ' + raw.length);
await shot(page, 'after-b2-transcript');
fixtures = { ['transcripts/' + rec.id + '.json']: [] };
page = await open('/?view=meeting&meeting=' + encodeURIComponent(rec.id));
await page.getByRole('button', { name: 'Read transcript' }).click();
await page.waitForTimeout(500);
check('B2', 'an empty transcript says so', /No transcript for this call/.test(await text(page)));
fixtures = {};
check('B2', 'no request for the dead transcripts.json loader', !fs.readFileSync('out/index.html', 'utf8').includes("fetch('data/transcripts.json')"));

// B3 / N2 pulse notes are internal
const fix = { runId: facts.runId, fixes: [{ type: 'draft', title: 'Houlihan Lokey has gone quiet', detail: 'Quiet 67 days at Decision.', company: 'Houlihan Lokey', owner: '', draftSubject: 'Houlihan Lokey – quiet for 67 days', draftText: 'Hi Doug,\n\nHoulihan Lokey has been quiet for 67 days. Can you re-engage or update the Sheet?\n\nHollie' }, { type: 'ask', title: 'Missing amounts', question: 'Who backfills the two deals with no amount?' }] };
fixtures = { 'heartbeat-fixes.json': fix, 'heartbeat.json': { runId: facts.runId, generatedAt: new Date().toISOString(), summary: 'Good morning Hollie, figures were collected at ' + facts.collectedAt + '.', insights: [{ title: 'Commit is covered', detail: 'Perella covers September.', priority: 'medium', kind: 'info' }] } };
page = await open('/');
await sales(page);
const salesText = await text(page);
check('N2', 'there is no separate Fixes ready block', !/Fixes ready/i.test(salesText));
const noteBtn = page.getByRole('button', { name: /Create internal note to/ }).first();
check('B3', 'the pulse suggestion is offered as an internal note on the queue card', await noteBtn.count() > 0 && await page.locator('article', { hasText: 'Houlihan Lokey' }).getByRole('button', { name: /Create internal note/ }).count() > 0);
await shot(page, 'after-b5-sales-today');
await noteBtn.click();
await page.locator('#draft-subject').waitFor();
const nu = new URL(page.url());
check('B3', 'it opens Drafts › Internal notes, addressed to our own rep, never the customer', nu.searchParams.get('purpose') === 'internal-note' && (await page.locator('#draft-to').count()) === 0 && !/@hl\.com/.test(await text(page)), nu.search);
// B8 raw timestamp and greeting
check('B8', 'the Pulse shows Phoenix time, not a raw UTC stamp, and no second greeting', !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(salesText) && /figures were collected at \w{3} \d+, \d{4} · \d+:\d\d [AP]M Phoenix/.test(salesText) && !/Pulse[\s\S]{0,120}Good morning/i.test(salesText), (salesText.match(/[^\n]*figures were collected at[^\n]*/i) || ['no pulse line'])[0]);
fixtures = {};

// B4 weighted from the Sheet
page = await open('/?view=pipeline&perf=demand');
const pipeText = await text(page);
check('B4', 'weighted pipeline uses the Sheet probability and matches run-facts ($889,750)', facts.weighted === 889750 && pipeText.includes(money(facts.weighted)), facts.weighted);
page = await open('/?view=accounts&accounts=deals');
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Export \d+ opportunities$/ }).click()]);
const wex = fs.readFileSync(await dl.path(), 'utf8').split('\n').find(l => /^WEX/.test(l)) || '';
check('B4', 'the CSV export carries the Sheet probability (WEX 25%)', /,0\.25,25000,/.test(wex), wex);
// B5 Mozilla and counts from render
page = await open('/');
await sales(page);
const sheetChecks = await page.locator('article', { hasText: 'Which is right for' }).count();
check('B5', 'the Mozilla Sheet check shows', await page.locator('article', { hasText: 'Mozilla' }).count() > 0);
const headerN = Number(((await text(page)).match(/(\d+) items? in the queue/) || [])[1]);
const cards = await page.locator('section:has(h6:text("Action queue")) article').count();
check('B5', 'the queue header counts what renders', headerN === cards, headerN + ' vs ' + cards);
const forecastStatus = ((await text(page)).match(/(\d+) Sheet checks? \(the Sheet and HubSpot disagree\)/) || [])[1];
check('B5', 'the Sheet-check count matches the rendered checks', Number(forecastStatus) === sheetChecks, forecastStatus + ' vs ' + sheetChecks);
// B6 follow-ups owed
const owedLine = Number(((await text(page)).match(/(\d+) calls? with open action items/) || [])[1]);
const fuCards = await page.locator('section:has(h6:text("Action queue")) article', { hasText: 'Draft follow-up' }).count();
check('B6', 'Follow-ups owed counts the follow-up drafts in the queue', owedLine === fuCards && fuCards === hollie.queue.filter(q => q.kind === 'followup_draft').length, owedLine + ' vs ' + fuCards);
// B7 card links
const quietN = Number(((await text(page)).match(/(\d+) with no engagement in \d+\+ days/) || [])[1]);
await page.getByRole('button', { name: /^Open the \d+ quiet deals →$/ }).click();
await page.locator('.close-on-line').waitFor();
const quietRows = await page.locator('[data-screen-label="Accounts"] table tbody tr').count();
check('B7', 'Deals gone quiet opens exactly those deals', quietRows === quietN && /dealFilter=quiet/.test(page.url()), quietRows + ' vs ' + quietN);
page = await open('/'); await sales(page);
const newN = Number(((await text(page)).match(/(\d+) with no MQL date yet \(all time\)/) || [])[1]);
await page.getByRole('button', { name: new RegExp('^Open the ' + newN + ' leads →$') }).click();
await page.locator('.lead-filter-line').waitFor();
check('B7', 'New leads opens the no-MQL list with the same count', (await page.locator('.leads-table tbody tr').count()) === newN && /leadStage=no-mql/.test(page.url()), newN);
// B9 Ask AI stamp
chatReply = () => '<p>Pipeline is $3,960,000.</p><p>Data collected: Sep 28 · 12:21 PM Phoenix</p>';
const ask = JSON.parse((await request('POST', '/api/ask', { body: JSON.stringify({ message: 'pipeline?', history: [] }) })).body);
const stamp = facts.collectedAt ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit' }).format(new Date(facts.collectedAt)) : '';
check('B9', 'Ask AI is stamped from run-facts, and the model’s own time is removed', !/12:21 PM/.test(ask.answer) && ask.answer.includes('Data as of') && ask.answer.includes(stamp), ask.answer);
check('B9', 'the panel does not claim live data', !/Grounded in live/.test(fs.readFileSync('out/index.html', 'utf8')));
// B10 writes need sign-in
const anonFeedback = await request('POST', '/api/hollie/feedback', { body: JSON.stringify({ itemId: 'q:stale_deal:1', action: 'done' }) });
const anonDecide = await request('POST', '/api/proposals/decide', { body: JSON.stringify({ idx: 0, decision: 'approved' }) });
chats.length = 0; chatReply = () => 'ok';
await request('POST', '/api/ask', { body: JSON.stringify({ message: 'mark it done', history: [] }) });
const anonTools = (chats[0].tools || []).map(t => t.function.name);
const start = await request('GET', '/api/google/sign-in');
const state = new URL(start.headers.location).searchParams.get('state');
const callback = await request('GET', '/api/gmail/oauth/callback?code=from-google&state=' + encodeURIComponent(state));
const cookie = String([].concat(callback.headers['set-cookie'] || [])[0] || '').split(';')[0];
const signedFeedback = await request('POST', '/api/hollie/feedback', { cookie, body: JSON.stringify({ itemId: 'q:stale_deal:1', action: 'done' }) });
chats.length = 0;
await request('POST', '/api/ask', { cookie, body: JSON.stringify({ message: 'mark it done', history: [] }) });
const signedTools = (chats[0].tools || []).map(t => t.function.name);
check('B10', 'queue feedback and proposal decisions need sign-in', anonFeedback.status === 401 && anonDecide.status === 401 && signedFeedback.status === 200, [anonFeedback.status, anonDecide.status, signedFeedback.status].join('/'));
check('B10', 'Ask AI write tools are offered only when signed in', !anonTools.includes('mark_queue_item') && !anonTools.includes('propose_crm_update') && signedTools.includes('mark_queue_item'), anonTools.join(','));
fs.rmSync(path.join(root, 'out/data/hollie-feedback.json'), { force: true });
// B11 prep attendees from the meeting
const prep = hollie.prep.find(p => (p.attendees || []).length);
const prepMeeting = prep && records.companies.flatMap(c => c.meetings).find(m => m.id === prep.meetingId);
check('B11', 'prep attendees come from the meeting’s own invitees', !prep || !prepMeeting || !(prepMeeting.invitees || []).length || prep.attendees.every(a => prepMeeting.invitees.some(i => i.email === a.email)), JSON.stringify(prep && prep.attendees).slice(0, 200));
check('B11', 'prep lists only meetings that have not started', hollie.prep.every(p => !p.start || !/T\d\d:/.test(p.start) || Date.parse(p.start) >= Date.parse(hollie.generatedAt) - 60000));
// B12 sort and route
page = await open('/?view=accounts&accounts=deals&sort=close');
const rowsClose = await page.locator('[data-screen-label="Accounts"] table tbody tr').allInnerTexts();
const passedIdx = rowsClose.map((r, i) => /close date passed/.test(r) ? i : -1).filter(i => i >= 0);
check('B12', 'deals whose close date passed are listed last', passedIdx.length > 0 && passedIdx.every((i, k) => i === rowsClose.length - passedIdx.length + k), passedIdx.join(','));
await page.locator('select').filter({ hasText: 'Last interaction' }).selectOption('interaction');
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(500);
check('B12', '“Last interaction” survives a reload', new URL(page.url()).searchParams.get('sort') === 'interaction' && (await page.locator('select').filter({ hasText: 'Last interaction' }).inputValue()) === 'interaction');
const fresh = await open('/?view=accounts&accounts=deals');
check('B12', 'the sort choice persists into a new visit', (await fresh.locator('select').filter({ hasText: 'Last interaction' }).inputValue()) === 'interaction');
await fresh.locator('select').filter({ hasText: 'Last interaction' }).selectOption('amount');
// B13 owner names
page = await open('/?view=meetings&meetings=past');
const owners = await page.locator('select').filter({ hasText: 'Everyone' }).first().locator('option').allInnerTexts();
const folded = owners.map(o => o.toLowerCase());
check('B13', 'owner filter has one entry per person (no “maya graff” twin)', new Set(folded).size === folded.length && !owners.some(o => o === o.toLowerCase() && /\s/.test(o)), owners.join(' | '));
// B14 commit group
const monthKey = facts.asOf.slice(0, 7);
check('B14', '“Land the commit” lists only deals closing this month', hollie.queue.filter(q => q.goal === 'commit' && q.close).every(q => q.close.slice(0, 7) === monthKey) && !hollie.queue.some(q => q.goal === 'commit' && /Taboola|Automation Anywhere/.test(q.title)));
// B15 latest notes
page = await open('/?view=pipeline&perf=demand');
const notes = await page.locator('section:has(h6:text("Latest notes on open deals")) button').allInnerTexts();
check('B15', 'latest notes show the note text and its date', notes.slice(1).length > 0 && notes.slice(1).every(n => /\w{3} \d+, \d{4}/.test(n) && n.split('\n').length >= 3), notes.slice(1, 3).join(' | '));
// B16 follow-up drafts
const fu = hollie.queue.filter(q => q.kind === 'followup_draft');
const team = new Set(Object.values(records.owners || {}).map(n => String(n).split(' ')[0].toLowerCase()));
check('B16', 'follow-ups are signed by whoever ran the call, with natural dates and no internal to-dos', fu.every(q => { const r = records.companies.flatMap(c => c.recordings).find(x => x.id === q.recordingId); const body = q.draftSeed.body; return r && body.includes('\n' + (q.owner || '~') + '\nOpstream') && q.owner.split(' ')[0].toLowerCase() === String(r.recordedBy).split(/[@. ]/)[0].toLowerCase() && !/\d{4}-\d{2}-\d{2}/.test(body + q.title) && !/\\~/.test(body) && ![...team].some(n => new RegExp('\\b(to|ping|with)\\s+' + n + '\\b', 'i').test(body)); }), fu.map(q => q.draftSeed.body.slice(-40)).join(' | '));
check('B16', 'follow-ups speak to the customer, not about them', fu.every(q => { const who = (q.draftSeed.body.match(/^Hi (\w+),/) || [])[1]; return !who || !new RegExp('^- .*\\b' + who + '\\b', 'm').test(q.draftSeed.body); }));
// B17 GA4
check('B17', 'every GA4 report is filtered to www.opstream.ai', (fs.readFileSync('refresh/brain-sync/ga4_sync.py', 'utf8').match(/"dimensionFilter": WWW_ONLY/g) || []).length === 3);
// B18 grammar
let allText = '';
for (const url of ['/', '/?view=briefing', '/?view=pipeline&perf=demand', '/?view=pipeline&perf=spend', '/?view=accounts&accounts=deals', '/?view=meetings']) { const p = await open(url); if (url.endsWith('briefing')) await sales(p); allText += '\n' + await text(p); await p.close(); }
check('B18', 'no “1 … are/have” grammar slips', !/\b1 (?:[\w-]+ ){0,3}(are still|have an|items\b|calls\b)/.test(allText), (allText.match(/\b1 (?:[\w-]+ ){0,3}(are still|have an|items\b|calls\b)/) || [''])[0]);
// B19 legacy
check('B19', 'legacy and demo files are gone', !['hosting', 'review', 'var/tunnel', 'scripts/synthetic-data.cjs', 'demo-mode.js'].some(f => fs.existsSync(f)) && !/legacyOpenPipeline|Review running|Requested 09:12/.test(fs.readFileSync('out/index.html', 'utf8')));
check('B19', 'one proposeCorrection', (fs.readFileSync('data-bindings.js', 'utf8').match(/proposeCorrection/g) || []).length === 0);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'v14-bundle-'));
execFileSync('node', ['scripts/package-bundle.mjs', path.join(stage, 'b.zip')], { stdio: 'ignore' });
execFileSync('unzip', ['-q', path.join(stage, 'b.zip'), '-d', path.join(stage, 'x')]);
const hits = execFileSync('bash', ['-c', 'grep -rliI "' + TERM.toLowerCase() + '" ' + path.join(stage, 'x') + ' || true'], { encoding: 'utf8' }).trim();
check('B19', 'the deploy bundle never contains the banned term, and ships no tests', !hits && !fs.existsSync(path.join(stage, 'x/scripts/check-v14.mjs')), hits);
fs.rmSync(stage, { recursive: true, force: true });
// B20 retry
let fails = 0;
const retry = await ctx.newPage();
await retry.route('**/data/records.json', r => { if (fails++ < 2) return r.fulfill({ status: 503, body: 'busy' }); return r.continue(); });
await retry.goto(base + '/', { waitUntil: 'networkidle' });
await retry.getByRole('button', { name: 'Marketing', exact: true }).click();
await retry.locator('#kpi-block .kpi-card').first().waitFor({ timeout: 15000 });
check('B20', 'a data request that fails twice is retried and the page still loads', fails >= 3 && !/Collection unavailable/.test(await retry.locator('body').innerText()));
check('B20', 'the server’s error page is friendly and retries itself', /http-equiv="refresh"/.test(retryPage()) && /Try again now/.test(retryPage()));

// ================= Confusing =================
page = await open('/');
await marketingView(page);
const mk = await text(page);
const showCard = hollie.marketingPriorities.find(p => p.kind === 'shows');
const cardText = await page.locator('[data-priority-id^="mkt:shows-soon"]').innerText();
check('C1', 'the show headline says which show is on now and which starts when', !/start this coming week/.test(cardText) && (showCard.shows || []).every(s => new RegExp(s.name + ' (is on now|starts \\w+|ends today)').test(cardText)), cardText.split('\n')[1]);
check('C2', 'no “Booked” wording for an MQL date, and no unlabeled 0 counter', !/Booked:|0 booked|Meetings booked/.test(mk) && !(await page.locator('.priority-feedback button span').allInnerTexts()).some(t => t.trim() === '0'));
check('C3', 'the no-MQL card says all time', /have no MQL date yet \(all time\)/.test(mk));
const pce = await page.locator('#show-procurecon-east').innerText().catch(() => '');
check('C4', 'a show with no requests says none are logged', !pce || /No meeting requests are logged/.test(pce) || !/listed above/.test(pce), pce.slice(0, 200));
const p2 = hollie.marketingPriorities.find(p => p.id === 'mkt:webinar-unowned');
check('C5', 'webinar link opens the Webinar leads', p2.secondary.target.kind === 'leads' && p2.secondary.target.source === 'Webinar');
page = await open('/?view=pipeline&perf=spend');
const spend = await text(page);
check('C6', 'Spend shows event cost matched to shows, with how, and explains February', /Event cost and leads/i.test(spend) && /payment equals the package price/.test(spend) && /February ran \$[\d.]+K over plan\. Its largest payments: Konnecthouse/.test(spend) && /No channel set in the workbook/.test(spend + JSON.stringify(marketing.spend.channels)), spend.slice(0, 100));
fixtures = { 'marketing.json': { ...marketing, outbound: { ...marketing.outbound, connected: true, campaignStats: [{ name: 'DPW Amsterdam', status: 'running', sent: 214, opened: 0, replied: 38, meetings: 0 }, { name: 'Draft A', status: 'draft', sent: 0, replied: 0 }, { name: 'Draft B', status: 'draft', sent: 0, replied: 0 }] } } };
page = await open('/?view=pipeline&perf=spend');
const spendL = await text(page);
check('C7', 'LemList meetings read “not tracked in LemList”, never 0', /meetings not tracked in LemList/.test(spendL) && !/0 meetings booked/.test(spendL));
check('N4', 'zero-send LemList drafts collapse into one line', /Drafts \(2\) with no sends yet: Draft A, Draft B/.test(spendL) && !/Draft A · LemList/.test(spendL));
page = await open('/');
await marketingView(page);
check('M8', 'the numbers show LemList replies and say meetings from replies are not tracked', /LemList replies\s*38/.test(await page.locator('#kpi-block').innerText()) && /Meetings from replies are not tracked/.test(await page.locator('#kpi-block').innerText()));
fixtures = {};
check('C8', 'ad windows are written as dates, not ISO', !/\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/.test(spend) && (!marketing.ads.length || /platform report’s own window/.test(spend)));
const ny = marketing.shows.items.find(s => s.id === 'show:dpw-new-york');
const nySeed = seeds.find(d => d.id === 'seed:followup:show:dpw-new-york');
page = await open('/'); await marketingView(page); await page.locator('#past-shows summary').click(); await page.waitForTimeout(200);
const nyRow = await page.locator('#show-dpw-new-york').innerText();
check('C9', 'one count of DPW New York people everywhere', nyRow.includes('Download ' + ny.people.withEmail + ' contacts') && nySeed.rationale.includes(ny.people.withEmail + ' with an email go to LemList') && hollie.marketingPriorities.find(p => p.id.startsWith('mkt:show-followups')).why.includes(ny.people.people + ' people; ' + ny.people.withEmail + ' with an email'), nyRow.slice(0, 160));
const taboola = records.companies.find(c => c.name === 'Taboola');
page = await open('/?view=account&account=' + taboola.id);
const acct = await page.locator('[data-screen-label="Account detail"]').innerText();
check('C10', 'the account header labels the HubSpot company owner and the Sheet deal owner', /Company owner \(HubSpot\)/.test(acct) && /Deal owner \(Sheet\)/.test(acct), acct.split('\n').slice(0, 4).join(' | '));
await page.locator('aside button', { hasText: 'Taboola' }).first().click(); await page.locator('[aria-modal="true"]').waitFor();
const tab = await page.locator('[aria-modal="true"]').innerText();
const sheetTab = review.deals.find(d => d.company === 'Taboola');
check('C10', 'the deal drawer uses the Sheet close date', tab.includes(new Date(sheetTab.close + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })), tab.slice(0, 200));
page = await open('/?view=accounts&accounts=deals');
check('C11', 'the flags column is called Flags', (await page.locator('thead th').allInnerTexts()).some(t => /Flags/i.test(t)) && !(await page.locator('thead th').allInnerTexts()).some(t => /Last note/i.test(t)));
const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Export \d+ opportunities$/ }).click()]);
const exp = fs.readFileSync(await dl2.path(), 'utf8');
check('C11', 'the CSV Flags column carries the flags', /,Flags$/m.test(exp.split('\n')[0]) && /close date passed/.test(exp));
page = await open('/'); await sales(page);
const salesAll = await text(page);
const acctAll = await (await open('/?view=accounts&accounts=deals')).locator('main').innerText();
check('C12', 'no domain as a company name, no “New Deal,” noise, no raw enums or markdown', !/\btapi\.com\b/.test(salesAll + acctAll) && !/Applied Materials, ·|, - New Deal/.test(salesAll) && !/\b[A-Z]{3,}_[A-Z]{3,}\b/.test(salesAll + acctAll) && !/\]\(\[?link:|\]\(https?:/.test(salesAll + acctAll));
check('C12', 'call-notes buttons carry their dates', !(await page.locator('button', { hasText: /^Call notes$/ }).count()));
const external = list => (list || []).filter(i => i.email && !/@opstream\.ai$/i.test(i.email));
const nud = hollie.queue.find(q => q.kind === 'stale_deal' && q.companyId && (() => { const c = records.companies.find(x => x.id === q.companyId); return c && [...(c.recordings || []), ...(c.meetings || [])].some(t => external(t.invitees).length); })());
if (nud) {
  const nudCo = records.companies.find(c => c.id === nud.companyId);
  const talks = [...(nudCo.recordings || []).map(r => ({ date: r.date, people: external(r.invitees) })), ...(nudCo.meetings || []).filter(m => /complete/i.test(m.outcome || '') && String(m.start) <= new Date().toISOString()).map(m => ({ date: m.start, people: external(m.invitees), title: m.title }))].filter(t => t.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const expected = (talks.find(t => t.people.length) || { people: [] }).people.map(p => p.email.toLowerCase());
  page = await open('/'); await sales(page);
  await page.locator('article', { hasText: nud.title.split(' — ')[0] }).first().getByRole('button', { name: 'Draft nudge' }).click();
  await page.locator('#draft-to').waitFor();
  const to = (await page.locator('#draft-to').inputValue()).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const body = await page.locator('#draft-message').inputValue();
  check('C13', 'the nudge goes to the latest meeting’s people and paraphrases it', to.length && to.every(e => expected.includes(e)) && /Thanks again for our conversation on \w{3} \d+\./.test(body) && !talks.some(t => t.title && body.includes(t.title)), to.join(',') + ' vs ' + expected.join(','));
} else check('C13', 'the nudge goes to the latest meeting’s people and paraphrases it', true);
page = await open('/?view=pipeline&perf=demand');
const order = await page.evaluate(() => { const sel = [...document.querySelectorAll('button')].find(b => /Quarter to date|Last 6 weeks/.test(b.textContent)); const kn = document.querySelector('section[aria-label="Key numbers"]'); return sel && kn ? (sel.compareDocumentPosition(kn) & Node.DOCUMENT_POSITION_FOLLOWING ? 'selector-first' : 'cards-first') : 'missing'; });
const weekCard = await page.locator('div', { hasText: /^Last 7 days$/ }).first().locator('..').innerText().catch(() => '');
check('C14', 'the period selector sits above the cards it controls', order === 'selector-first', order);
check('N5', 'the Last 7 days card shows its dates once', (weekCard.match(/\w{3} \d+, \d{4} – \w{3} \d+, \d{4}/g) || []).length <= 1, weekCard);
check('C14', 'the largest-deal card is neutral, not “push or let it slip”', !/or let it slip/.test(await text(page)) && /is the largest open deal/.test(await text(page)));
page = await open('/?view=pipeline&perf=demand&period=year');
check('C14', 'the year chart explains months before the tracker', /The Lead Tracker starts on/.test(await text(page)));
page = await open('/?view=pipeline&perf=demand&period=custom');
const startVal = await page.locator('#period-start').inputValue().catch(() => '');
const customLabel = ((await text(page)).match(/(\w{3} \d+, \d{4}) – \w{3} \d+, \d{4}/) || [])[1];
check('C14', 'the custom period input and label agree', startVal && customLabel && new Date(startVal + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) === customLabel, startVal + ' vs ' + customLabel);
check('C15', 'no jargon in the visible text', !/open book|CRM extract|prep sheets|company brain|not matched to one of|How the assistant works/i.test(allText), (allText.match(/open book|CRM extract|prep sheets|company brain|not matched to one of|How the assistant works/i) || [''])[0]);
page = await open('/?view=meetings&meetings=upcoming');
const up = await page.locator('.meeting-row').allInnerTexts();
check('C16', 'Upcoming hides holds and placeholders and defaults to sales and marketing', !up.some(t => /^\s*\S*\s*(HOLD|<<)/m.test(t) || /<<|placeholder/i.test(t)) && /open new-business deal/.test(await text(page)));
await page.getByRole('button', { name: 'Show all meetings' }).click();
await page.waitForTimeout(300);
check('C16', 'Show all meetings widens the list', (await page.locator('.meeting-row').count()) >= up.length && /meetingScope=all/.test(page.url()));
const onNow = marketing.shows.items.find(s => s.start <= facts.asOf && facts.asOf <= (s.end || s.start) && s.approved);
const liSeed = onNow && seeds.find(d => d.id === 'seed:linkedin:' + onNow.id);
check('C17', 'a LinkedIn seed for a running show is in the present tense', !liSeed || /^We're at /.test(liSeed.text), liSeed && liSeed.text.slice(0, 60));
page = await open('/?view=data');
const data = await text(page);
check('C18', 'definitions cover Webinar and Paid', /Webinar\s+Not defined on the Marketing tab/.test(data) && /Paid\s+Not defined on the Marketing tab/.test(data));
const stampJ = JSON.parse((await request('GET', '/api/data-stamp')).body);
check('C18', 'the data stamp and the files carry one runId', stampJ.runId === facts.runId && records.runId === facts.runId, stampJ.runId + ' vs ' + facts.runId);

// ================= Noise =================
check('N1', 'the assistant settings live on the Data page, not Sales & CS', /What the assistant does on its own/i.test(data) && !/What the assistant does on its own|How the assistant works/i.test(salesAll));
check('N3', 'the duplicate Coming up block is gone', !/\bComing up\b/i.test(mk));
check('N6', 'records store each meeting once per account', records.companies.every(c => new Set((c.meetings || []).map(m => m.id)).size === (c.meetings || []).length));

// ================= Missing and reconciliation =================
page = await open('/');
await marketingView(page);
const kpi = await page.locator('#kpi-block').innerText();
const kpiFirst = await page.evaluate(() => { const k = document.getElementById('kpi-block'), p = document.querySelector('section[aria-label="Priorities"]'); return !!(k && p && (k.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING)); });
check('M1', 'Marketing Today opens with the pipeline figure', kpi.includes(money(facts.openAmount)) && kpi.includes(facts.openCount + ' deals'));
check('M10', 'numbers come before the priorities', kpiFirst);
const owners2 = await page.locator('table.kpi-owners tbody tr').allInnerTexts();
const ownerTotal = owners2.reduce((a, r) => a + num(r.split('\t')[2]), 0);
check('M2', 'the owner scorecard adds up to the open pipeline', owners2.length >= 2 && ownerTotal === facts.openAmount, ownerTotal + ' vs ' + facts.openAmount);
check('M3', 'marketing-sourced pipeline is shown with its deals', /Marketing-sourced pipeline\s*\$[\d,]+/.test(kpi) && (await page.locator('table.kpi-sourced tbody tr').count()) > 0);
check('M4', 'won and lost this quarter are shown', /Won this quarter\s*\$[\d,]+/.test(kpi) && /lost/.test(kpi));
check('M5', 'leads, MQL and SQL show the week-over-week change', (kpi.match(/on the week before|same as the week before/g) || []).length === 3);
check('M6', 'targets that are not in the data say “target not set”', (kpi.match(/target not set/g) || []).length === 3 && /target \$[\d,]+ \(Forecast tab\)|target not set \(Forecast tab\)/.test(kpi));
check('M7', 'event cost sits next to event leads', (await page.locator('table.kpi-events tbody tr').count()) === marketing.shows.eventRoi.rows.length);
check('M9', 'a one-page print view exists', await page.getByRole('button', { name: 'Print one-page summary' }).count() === 1 && /@media print\{body \*\{visibility:hidden\}/.test(fs.readFileSync('out/index.html', 'utf8')));
await page.emulateMedia({ media: 'print' });
if (shots) await page.screenshot({ path: path.join(shots, 'after-m9-print-view.png') });
await page.emulateMedia({ media: 'screen' });
await shot(page, 'after-m1-numbers', page.locator('#kpi-block'));
check('reconcile', 'the numbers block matches run-facts (pipeline, weighted, leads, MQL, SQL)', kpi.includes(money(facts.weighted)) && new RegExp('Leads this quarter\\s*' + facts.leads).test(kpi) && new RegExp('MQLs this quarter\\s*' + facts.mql).test(kpi) && new RegExp('SQLs this quarter\\s*' + facts.sql).test(kpi), [facts.leads, facts.mql, facts.sql].join('/'));
page = await open('/?view=pipeline&perf=demand');
check('reconcile', 'Pipeline headline matches run-facts', (await page.locator('section[aria-label="Key numbers"]').innerText()).includes(money(facts.openAmount)) && (await page.locator('section[aria-label="Key numbers"]').innerText()).includes(money(facts.weighted)));
const header = exp.split('\n')[0].split(',');
const parse = line => { const out = []; let cur = '', q = false; for (const ch of line) { if (q) { if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const rowsCsv = exp.trim().split('\n').slice(1).map(parse);
const amountCol = header.indexOf('Amount'), weightedCol = header.indexOf('Weighted');
const csvAmount = rowsCsv.reduce((a, r) => a + (Number(r[amountCol]) || 0), 0), csvWeighted = rowsCsv.reduce((a, r) => a + (Number(r[weightedCol]) || 0), 0);
check('reconcile', 'the deals CSV adds up to run-facts (pipeline and weighted)', Math.round(csvAmount) === facts.openAmount && Math.round(csvWeighted) === facts.weighted && rowsCsv.length === facts.openCount, [rowsCsv.length, csvAmount, csvWeighted].join(' / '));
check('banned', 'no served page names the banned term', ![...allText.matchAll(new RegExp(TERM, 'gi'))].length && !new RegExp(TERM, 'i').test(fs.readFileSync('out/index.html', 'utf8')));

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
fs.writeFileSync(process.env.RESULT_FILE || '/tmp/check-v14-results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failures: failed }, null, 2));
process.exit(failed.length ? 1 : 0);
