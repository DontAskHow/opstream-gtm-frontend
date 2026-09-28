// End-to-end check of the v13 fixes: who is signed in, owner names, the
// stale-run guard, the review's broken and misleading items, and the terms that
// must never reach the page. Google, OpenAI and S3 are mocked at the boundary.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-unit-fixture';
process.env.OPENAI_API_KEY = '';
const { createServer, setHooks, resetAuth } = await import('./agent-server.mjs');
const { showTiming } = await import('./marketing-drafts.mjs');

const failures = [];
const check = (name, ok, detail) => { if (!ok) failures.push(name + (detail ? ': ' + String(detail).slice(0, 400) : '')); else console.log('ok ' + name); };
process.on('uncaughtException', e => { console.log(JSON.stringify({ ok: false, failures, crashed: String(e && e.message || e).split('\n')[0] }, null, 2)); process.exit(1); });
const load = f => JSON.parse(fs.readFileSync(path.join(root, 'out/data', f), 'utf8'));
const hollie = load('hollie.json'), marketing = load('marketing.json'), records = load('records.json'), review = load('sheet-review.json');
const BANNED = /grok/i;
const PHOTO = 'https://photos.example.test/hollie.png';

// ---- mocks ----
const chats = [];
let chatReply = null;
async function fetchImpl(url) {
  const target = String(url);
  if (target.includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => ({ refresh_token: 'refresh-fixture', access_token: 'access-fixture', expires_in: 3600, scope: '' }) };
  if (target.includes('userinfo')) return { ok: true, json: async () => ({ email: 'hollie@opstream.ai', name: 'Hollie Farrahi', picture: PHOTO }) };
  if (target.includes('/gmail/v1/users/me/messages?')) return { ok: true, json: async () => ({ messages: [] }) };
  if (target.includes('calendar')) return { ok: true, json: async () => ({ items: [] }) };
  if (target.includes('drive/v3/files?')) return { ok: true, json: async () => ({ files: [] }) };
  throw new Error('unexpected url ' + target);
}
async function callChatApi(payload) {
  chats.push(payload);
  if (chatReply) return { choices: [{ message: { content: chatReply(payload) } }] };
  return { choices: [{ message: { content: 'Answer.' } }] };
}
setHooks({ fetchImpl, callChatApi, persistStateFile: async () => {}, putSecretString: async () => '{}' });
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
const pageErrors = [];
async function openPage(context, url = '/') {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1360, height: 1000 });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (/never resolved/.test(m.text())) pageErrors.push(m.text()); });
  await page.route('https://photos.example.test/**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="14" fill="#0f766e"/></svg>' }));
  await page.goto(base + url, { waitUntil: 'networkidle' });
  await page.locator('header').waitFor();
  await page.waitForTimeout(400);
  return page;
}
const visibleText = page => page.locator('body').innerText();

// ---- 1a. who is logged in ----
const pub = await browser.newContext();
let page = await openPage(pub);
await page.getByRole('heading', { name: 'Where to focus' }).waitFor();
let header = await page.locator('header').innerText();
check('public view is labeled the shared view', /Shared view · not signed in/.test(header) && /Sign in with Google/.test(header));
check('public view never claims a signed-in person', !/Signed in as|Zack Kaufman/.test(await visibleText(page)));
check('header shows the run time', /· run \d{1,2}:\d{2} [AP]M Phoenix/.test(header), header);
if (shots) await page.locator('header').screenshot({ path: path.join(shots, 'header-shared-view.png') });

const start = await request('GET', '/api/google/sign-in');
const state = new URL(start.headers.location).searchParams.get('state');
const callback = await request('GET', '/api/gmail/oauth/callback?code=from-google&state=' + encodeURIComponent(state));
const cookie = String([].concat(callback.headers['set-cookie'] || [])[0] || '').split(';')[0];
const signed = await browser.newContext();
await signed.addCookies([{ name: 'gtm_user', value: cookie.split('=')[1], url: base }]);
page = await openPage(signed);
await page.locator('header .signed-in-user').waitFor();
header = await page.locator('header').innerText();
check('signed in: name and email are in the header', /Hollie Farrahi/.test(header) && /hollie@opstream\.ai/.test(header) && !/Shared view/.test(header), header);
check('signed in: the Google photo is in the header', String(await page.locator('header .header-photo').getAttribute('style')).includes(PHOTO));
check('signed in: Sign out is one click away', (await page.locator('header a.signed-in-signout').getAttribute('href')) === '/auth/logout');
if (shots) await page.locator('header').screenshot({ path: path.join(shots, 'header-signed-in.png') });
const brief = JSON.parse((await request('GET', '/api/me/brief', { cookie })).body || '{}');
check('signed-in brief has no numeric owner', !/owner (?:Owner )?\d{5,}/i.test(JSON.stringify(brief)));

// ---- 1b. owner names, never numbers ----
const ownerPattern = /(?:^|[·:]\s*)(?:Owner\s*#?\s*…?)?\d{5,}\s*$|Owner #/m;
const ownerViews = ['/?view=meetings&meetings=upcoming', '/?view=meetings&meetings=past', '/?view=accounts&accounts=deals', '/?view=accounts&accounts=follow', '/?view=accounts&accounts=leads', '/?view=briefing'];
let numbered = [];
for (const url of ownerViews) {
  const p = await openPage(pub, url);
  if (url.endsWith('briefing')) await p.getByRole('button', { name: 'Sales & CS', exact: true }).click();
  await p.waitForTimeout(300);
  const lines = (await visibleText(p)).split('\n').filter(l => ownerPattern.test(l.trim()));
  numbered.push(...lines.map(l => url + ' → ' + l.trim()));
  if (url.includes('meetings=upcoming')) {
    const rows = await p.locator('.meeting-row').count();
    for (let i = 0; i < Math.min(rows, 5); i++) {
      await p.locator('.meeting-row').nth(i).click();
      await p.locator('[aria-modal="true"]').waitFor();
      numbered.push(...(await p.locator('[aria-modal="true"]').innerText()).split('\n').filter(l => ownerPattern.test(l.trim())).map(l => 'drawer → ' + l));
      await p.keyboard.press('Escape');
    }
  }
  await p.close();
}
check('no visible owner field is a bare HubSpot number', numbered.length === 0, numbered.slice(0, 5).join(' | '));
check('records carry no numeric owner label', !/"owner": "(?:Owner )?\d{5,}"/.test(fs.readFileSync('out/data/records.json', 'utf8')));

// ---- B1 / N1. Draft nudge opens its own draft ----
page = await openPage(pub);
await page.getByRole('button', { name: 'Sales & CS', exact: true }).click();
const nudge = hollie.queue.find(q => q.kind === 'stale_deal');
const nudgeCard = page.locator('article', { hasText: nudge.title.split(' — ')[0] }).first();
await nudgeCard.getByRole('button', { name: 'Draft nudge' }).click();
await page.locator('#draft-subject').waitFor();
const nudgeUrl = new URL(page.url());
const nudgeSubject = await page.locator('#draft-subject').inputValue(), nudgeText = await page.locator('#draft-message').inputValue();
check('B1 Draft nudge opens Drafts › Emails on the new draft', nudgeUrl.searchParams.get('purpose') === 'email' && nudgeUrl.searchParams.get('draftId') === 'seed:' + nudge.id, nudgeUrl.search);
check('B1 the open draft is the nudge, not a DPW draft', (await page.locator('.email-composer h6').first().innerText()).toLowerCase().includes(String(nudge.company).toLowerCase().slice(0, 6)) && !/DPW/.test(nudgeSubject), nudgeSubject);
check('N1 nudge subject and body read as a person wrote them', / and Opstream: next steps$/.test(nudgeSubject) && !/Nudge |last interaction on file|Is this still a priority/i.test(nudgeSubject + nudgeText) && /\nBest,\n/.test(nudgeText), nudgeSubject + ' / ' + nudgeText.slice(0, 120));
check('N1 nudge is signed by the Sheet deal owner', (() => { const sd = review.deals.find(d => String(d.id) === String(nudge.dealId || '').replace(/^deal-/, '')); return !sd || !sd.owner || nudgeText.includes(sd.owner); })(), nudgeText.slice(-60));
if (shots) await page.screenshot({ path: path.join(shots, 'b1-nudge-draft.png') });

// ---- B2. cost per lead ----
page = await openPage(pub, '/?view=pipeline&perf=demand');
const cpl = await page.locator('div', { hasText: /^Cost per lead:/ }).allInnerTexts();
check('B2 cost per lead is filled on every marketing card', cpl.length === 3 && cpl.every(t => /Cost per lead: (\$[\d,]+|needs .* actuals|no leads in this window)$/.test(t.trim())), cpl.join(' | '));
check('B2 no template value is left unresolved', !pageErrors.some(e => /never resolved/.test(e)), pageErrors.filter(e => /never resolved/.test(e)).join(' | '));

// ---- N5. Spend and Website open on their own data ----
for (const tab of ['spend', 'web']) {
  const p = await openPage(pub, '/?view=pipeline&perf=' + tab);
  check('N5 Pipeline › ' + tab + ' has no headline or decision cards', (await p.locator('section[aria-label="Key numbers"]').count()) === 0 && (await p.getByText('Worth a decision').count()) === 0);
  await p.close();
}
check('N5 Demand still shows the headline numbers', (await page.locator('section[aria-label="Key numbers"]').count()) === 1);

// ---- B3. the Pulse uses the headline book ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-v13-'));
fs.cpSync(path.join(root, 'out/data'), path.join(tmp, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'sitecustomize.py'), `
import io, json, os, urllib.request
LOG = os.environ["MOCK_LOG"]
class Resp(io.BytesIO):
    status = 200
    def __enter__(self): return self
    def __exit__(self, *a): return False
def urlopen(req, *a, **k):
    body = json.loads(req.data.decode("utf-8"))
    open(LOG, "a").write(json.dumps(body) + "\\n")
    content = {"summary": "Pulse.", "insights": [
        {"title": "Snapshot reports no open-book deals", "detail": "It reports 0 open deals and $0.", "priority": "high", "kind": "risk"},
        {"title": "GrokBot pilot", "detail": "Replace GrokBot with an opt-out alternative.", "priority": "low", "kind": "info"},
        {"title": "Commit is covered", "detail": "Perella covers the September commit.", "priority": "medium", "kind": "info"}]}
    return Resp(json.dumps({"choices": [{"message": {"content": json.dumps(content)}, "finish_reason": "stop"}]}).encode("utf-8"))
urllib.request.urlopen = urlopen
`);
const hbLog = path.join(tmp, 'hb.jsonl');
const hb = spawnSync('python3', ['scripts/heartbeat.py'], { cwd: root, encoding: 'utf8', env: { ...process.env, OUT_DATA: path.join(tmp, 'data'), OPENAI_API_KEY: 'sk-fixture', PYTHONPATH: tmp, MOCK_LOG: hbLog } });
spawnSync('python3', ['scripts/term_scrub.py', path.join(tmp, 'data')], { cwd: root, encoding: 'utf8' });
const sent = fs.existsSync(hbLog) ? JSON.parse(fs.readFileSync(hbLog, 'utf8').trim().split('\n')[0]) : null;
const bookSeg = sent ? sent.messages[1].content.slice(sent.messages[1].content.indexOf('"openBook"')) : '';
const dump = { openBook: bookSeg ? { openCount: Number((bookSeg.match(/"openCount": (\d+)/) || [])[1]), openAmount: Number((bookSeg.match(/"openAmount": ([\d.]+)/) || [])[1]) } : null };
const pulse = JSON.parse(fs.readFileSync(path.join(tmp, 'data/heartbeat.json'), 'utf8'));
check('B3 the Pulse is given the headline open book', dump.openBook && dump.openBook.openCount === 32 && dump.openBook.openAmount === 3960000, JSON.stringify(dump.openBook) + hb.stderr.slice(-300));
check('B3 a Pulse insight that says the book is empty is dropped', !pulse.insights.some(i => /no open-book deals|0 open deals/i.test(i.title + i.detail)) && pulse.insights.some(i => /Commit is covered/.test(i.title)));
check('B3 “early pipeline” is defined', hollie.goals.some(g => /of the open book is in early stages \(SQL, discovery, demo\)/.test(g.status)) && !JSON.stringify(hollie).includes('early pipeline'));
check('model text never names the banned terms after the refresh scrub', !BANNED.test(fs.readFileSync(path.join(tmp, 'data/heartbeat.json'), 'utf8')));

// ---- B4. every instance serves the latest validated run ----
const app = path.join(tmp, 'app'), store = path.join(tmp, 'store');
fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
for (const rel of ['workspace-model.cjs', 'scripts/agent-server.mjs', 'scripts/workspace-facts.mjs', 'scripts/published-swap.mjs', 'scripts/sheets-connect.mjs', 'scripts/google-identity.mjs', 'scripts/google-workspace.mjs', 'scripts/marketing-drafts.mjs', 'scripts/email-draft.mjs', 'scripts/term-scrub.mjs', 'refresh-config.json']) fs.copyFileSync(path.join(root, rel), path.join(app, rel));
fs.mkdirSync(path.join(app, 'out/data'), { recursive: true });
fs.writeFileSync(path.join(app, 'out/index.html'), '<!doctype html><title>stale guard</title>');
const baked = { generatedAt: '2026-09-27T22:02:00-07:00', verifiedSnapshotId: 'brain-baked', runId: 'run-2026-09-28-050200', companies: [] };
fs.writeFileSync(path.join(app, 'out/data/records.json'), JSON.stringify(baked));
fs.writeFileSync(path.join(app, 'out/data/verified.json'), JSON.stringify({ snapshotId: 'brain-baked' }));
const runId = 'run-2026-09-28-161500', prefix = 'published/' + runId + '/';
const fresh = { generatedAt: '2026-09-28T09:15:00-07:00', verifiedSnapshotId: 'brain-fresh', runId, companies: [{ id: '1', name: 'Acme', notes: [{ text: 'Replace GrokBot w/ an alternative' }] }] };
fs.mkdirSync(path.join(store, prefix), { recursive: true });
fs.writeFileSync(path.join(store, prefix, 'records.json'), JSON.stringify(fresh));
fs.writeFileSync(path.join(store, prefix, 'verified.json'), JSON.stringify({ snapshotId: 'brain-fresh' }));
fs.writeFileSync(path.join(store, prefix, 'hollie.json'), JSON.stringify({ runId }));
fs.writeFileSync(path.join(store, prefix, 'MANIFEST.txt'), 'records.json\nverified.json\nhollie.json\n');
fs.writeFileSync(path.join(store, 'published/LATEST.json'), JSON.stringify({ runId, prefix }));
const port = 4331;
const child = spawn(process.execPath, ['scripts/agent-server.mjs'], { cwd: app, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', REFRESH_FS_ROOT: store }, stdio: ['ignore', 'pipe', 'pipe'] });
let first = null;
for (let i = 0; i < 200 && !first; i++) {
  try { const r = await fetch('http://127.0.0.1:' + port + '/api/data-stamp'); first = await r.json(); } catch { await new Promise(r => setTimeout(r, 100)); }
}
const served = first ? await (await fetch('http://127.0.0.1:' + port + '/data/records.json')).text() : '';
child.kill();
check('B4 the first response after start is already the latest published run', first && first.runId === runId && first.generatedAt === fresh.generatedAt, JSON.stringify(first));
check('B4 a swapped-in run is scrubbed of banned terms', served.includes('Acme') && !BANNED.test(served), served.slice(0, 200));
check('B4 instances poll for new runs every 2 minutes', JSON.parse(fs.readFileSync('refresh-config.json', 'utf8')).pollMinutes === 2);

// ---- M1 / M2. show attribution and hot leads ----
const ams = marketing.shows.items.find(s => s.id === 'show:dpw-amsterdam');
page = await openPage(pub);
await page.getByRole('heading', { name: 'Where to focus' }).waitFor();
const amsCard = await page.locator('#show-dpw-amsterdam').innerText();
check('M1 the DPW card names every company asking to meet', ams.requestRows.filter(r => !r.mql).every(r => amsCard.includes(r.company)), amsCard.slice(0, 300));
check('M1 no “Vanatge” anywhere on the page', !/Vanatge/.test(await visibleText(page)));
const wip = marketing.shows.items.find(s => /Women in Procurement/.test(s.name));
check('M2 WIP leads are attributed to WIP from the note', ['Faegre Drinker', 'Honeywell'].every(n => (wip.leadRows || []).some(r => r.company === n)));
const hotCard = hollie.marketingPriorities.find(p => p.id === 'mkt:hot-leads');
check('M2 Faegre Drinker is flagged as a hot lead, not a check-in', !!hotCard && /Faegre Drinker/.test(hotCard.why) && !JSON.parse(fs.readFileSync('out/data/draft-seeds.json', 'utf8')).filter(d => d.purpose === 'campaign').some(d => /Faegre/.test(d.text)));
await page.locator('[data-priority-id="mkt:hot-leads"]').getByRole('button', { name: hotCard.primary.label }).click();
await page.locator('.lead-filter-line').waitFor();
const hotRows = await page.locator('.leads-table tbody tr').allInnerTexts();
check('M2 the hot-leads button lists them with a Hot tag', hotRows.length === hotCard.expectedRows && hotRows.every(t => /\bHot\b/.test(t)), hotRows.length + ' rows');
check('M2 the recent-show wording is not a stale check-in', !JSON.parse(fs.readFileSync('out/data/draft-seeds.json', 'utf8')).some(d => d.showId === 'show:data-in-procurement' && /A lot has changed/.test(d.text)));

// ---- M3 / M4 / M5. one BT Sourced, Sheet owners and Sheet dates ----
check('M3 BT Sourced is one account', records.companies.filter(c => /^BT Sourced$/i.test(c.name)).length === 1);
check('M3 BT Sourced is not called quiet for 338 days', !hollie.queue.some(q => /BT Sourced/.test(q.title) && /quiet 3\d\d days/.test(q.title)));
page = await openPage(pub);
await page.getByRole('button', { name: 'Sales & CS', exact: true }).click();
const perella = await page.locator('article', { hasText: 'Which is right for Perella' }).first().innerText();
check('M4 queue owner comes from the Sheet', /Owner: Doug Daniels/.test(perella) && !/Jeremy/.test(perella), perella.split('\n').find(l => /Owner/.test(l)));
const known = await page.locator('article', { hasText: 'Which is right for Known' }).first().innerText();
check('M4 Known shows its Sheet owner', /Owner: Tim Schwab/.test(known), known.split('\n').find(l => /Owner/.test(l)));
const taboola = hollie.queue.find(q => /Taboola/.test(q.title));
const sheetTaboola = review.deals.find(d => d.company === 'Taboola');
check('M5 queue text uses the Sheet close date', !taboola || (taboola.why.includes(sheetTaboola.close) && !taboola.why.includes('2026-06-15')), taboola && taboola.why);

// ---- M6. spend compared with plan to date ----
const spendCard = hollie.marketingPriorities.find(p => p.id === 'mkt:spend-not-entered');
check('M6 spend is compared with the plan for the same months', /Through July, recorded spend is \$[\d.]+K against \$[\d.]+K planned for those months \(\$[\d.]+K over plan\)/.test(spendCard.why) && /full-year plan is \$600K/.test(spendCard.why), spendCard.why);
page = await openPage(pub, '/?view=pipeline&perf=spend');
const spendLine = ((await visibleText(page)).match(/Through July: (\$[\d.]+K) recorded against (\$[\d.]+K) planned for those months \((\$[\d.]+K) over plan\)/) || []);
check('M6 Pipeline › Spend says the same', spendLine.length === 4 && spendCard.why.includes(spendLine[1] + ' against ' + spendLine[2]) && spendCard.why.includes(spendLine[3] + ' over plan'), spendLine[0]);

// ---- M7. MQL-no-SQL list sorted and without dead leads ----
const p5 = hollie.marketingPriorities.find(p => p.id === 'mkt:mql-no-sql');
page = await openPage(pub);
await page.locator('[data-priority-id="mkt:mql-no-sql"]').getByRole('button', { name: p5.primary.label }).click();
await page.locator('.lead-filter-line').waitFor();
const dates = (await page.locator('.leads-table tbody tr td:nth-child(5)').allInnerTexts()).map(t => Date.parse(t));
check('M7 leads are newest first', dates.every((d, i) => i === 0 || d <= dates[i - 1]), dates.map(d => new Date(d).toISOString().slice(0, 10)).join(','));
check('M7 dead and disqualified notes are left out', !(await page.locator('.leads-table').innerText()).match(/No show on call|different direction|DQd/i) && /(\d+) more are left out/.test(p5.why), p5.why);

// ---- M8. one action-item count per call ----
const fu = hollie.queue.find(q => q.kind === 'followup_draft');
const fuCount = Number((fu.title.match(/(\d+) action item/) || [])[1]);
const owed = hollie.brief.followupsOwed.items.find(o => o.queueId === fu.id);
const prep = hollie.prep.find(p => p.lastCall && p.lastCall.recordingId === owed.recordingId);
const seed = JSON.parse(fs.readFileSync('out/data/draft-seeds.json', 'utf8')).find(d => d.id === 'seed:queue:' + fu.id);
const bullets = (seed.text.match(/^- /gm) || []).length;
check('M8 queue, follow-ups owed, prep and draft agree on action items', owed.actionCount === fuCount && bullets === fuCount && (!prep || (prep.lastCall.actions.length === fuCount && prep.suggestedAgenda.some(a => a.includes(fuCount + ' item')))), [fuCount, owed.actionCount, bullets, prep && prep.lastCall.actions.length].join('/'));
check('M8 follow-ups owed matches the queue', hollie.brief.followupsOwed.items.length === hollie.queue.filter(q => q.kind === 'followup_draft').length);

// ---- M9. Phoenix time ----
page = await openPage(pub, '/?view=meetings&meetings=upcoming');
const nowMs = Date.now();
const upcomingStarts = records.companies.flatMap(c => c.meetings || []).filter(m => /T\d{2}:/.test(m.start || '') && Date.parse(m.start) < nowMs).map(m => m.title);
const upText = await visibleText(page);
check('M9 meetings that already started are not in Upcoming', !records.companies.flatMap(c => c.meetings || []).some(m => /T\d{2}:/.test(m.start || '') && Date.parse(m.start) < nowMs && Date.parse(m.start) > nowMs - 86400000 && upText.includes(m.title)) || upcomingStarts.length === 0);
chatReply = () => 'Answer.';
await request('POST', '/api/ask', { body: JSON.stringify({ message: 'When is ProcureCon East?', history: [] }) });
const sys = chats[chats.length - 1].messages[0].content;
check('M9 Ask AI is told the time in Phoenix', /Right now it is \w+day, \w+ \d+, 20\d\d(,| at) \d{1,2}:\d{2}\s?[AP]M in America\/Phoenix/.test(sys), sys.match(/Right now it is[^.]*/)?.[0]);
check('M9 no raw timestamp in operator text', !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(JSON.stringify(hollie.goals) + JSON.stringify(hollie.queue.map(q => q.why))));

// ---- M10 / M14 / M15. counts that add up ----
page = await openPage(pub, '/?view=pipeline&perf=demand');
const renewText = await visibleText(page);
const renewCount = (renewText.match(/The total counts ([\d,]+) renewals/) || [])[1];
check('M10 renewal button and total use one count', renewCount && renewText.includes('Show the ' + renewCount + ' renewals') && renewText.includes('Not included: ' + renewCount + ' renewals'), renewCount);
const p2 = hollie.marketingPriorities.find(p => p.id === 'mkt:webinar-unowned');
check('M14 webinar card counts unique people', /unique people/.test(p2.why), p2.why);
page = await openPage(pub, '/?view=accounts&accounts=leads&leadSource=Webinar&owner=Unassigned');
check('M14 lead list shows unique people and repeats', /\d+ unique people/.test(await page.locator('.lead-filter-line').innerText()));
check('M15 banner names all six sources', /HubSpot, Fathom, Sheets, GA4, LemList, Otterly/.test(await page.locator('#topBanner').innerText()));

// ---- N2 / N4. draft quality ----
const allSeeds = JSON.parse(fs.readFileSync('out/data/draft-seeds.json', 'utf8'));
check('N2 no draft pastes a non-English paragraph into English copy', allSeeds.every(d => !/[\u0590-\u06FF]/.test(d.text)));
const recordingSeeds = allSeeds.filter(d => /recording/i.test(d.text) && d.purpose === 'email');
check('N2 a promised recording comes with its link', recordingSeeds.every(d => /https:\/\/fathom\.video\//.test(d.text) || !/recording of our call/i.test(d.text)));
const webinar = allSeeds.find(d => d.id === 'seed:campaign:webinar-registrants');
check('N4 webinar draft names the webinar and its date', !webinar || (webinar.text.includes(marketing.webinar.title) && webinar.text.includes(marketing.webinar.date)), webinar && webinar.text.slice(0, 140));
check('N4 campaign drafts end with a named sender', allSeeds.filter(d => d.purpose === 'campaign').every(d => /\nBest,\n[A-Z][a-z]+ [A-Z][a-z]+\nOpstream$/.test(d.text)), allSeeds.filter(d => d.purpose === 'campaign').map(d => d.text.slice(-40)).join(' | '));

// ---- N6 / N7 / N8 ----
check('N6 prep lists no closed agreements as open deals', hollie.prep.every(p => (p.openDeals || []).every(d => !/closed/i.test(String(d.stage || '')))));
page = await openPage(pub);
await page.getByRole('heading', { name: 'Where to focus' }).waitFor();
const events = await page.locator('#events-shows').innerText();
check('N7 public view says to sign in to match the calendar', /Sign in with Google to match these meetings against your calendar/.test(events) && !/\b0 booked\b/.test(events));
check('N8 a show that starts tomorrow is written in the future tense', /tomorrow; write in the future tense/.test(showTiming({ start: '2026-09-29', end: '2026-09-30' }, '2026-09-28')) && /on now/.test(showTiming({ start: '2026-09-28', end: '2026-09-30' }, '2026-09-28')) && /ended 3 days ago/.test(showTiming({ start: '2026-09-24', end: '2026-09-25' }, '2026-09-28')));
chatReply = () => 'Opstream will be at ProcureCon East. Booth [booth number].';
await request('POST', '/api/drafts/linkedin', { body: JSON.stringify({ showId: 'show:procurecon-east' }) });
const liPrompt = chats[chats.length - 1].messages[1].content;
check('N8 LinkedIn prompt carries tense and no internal counts', /Timing: /.test(liPrompt) && !/Lead Tracker rows/.test(liPrompt));

// ---- banned terms, everywhere a user can see ----
chatReply = () => JSON.stringify({ subject: 'GrokBot follow-up', body: 'Hi,\n\nWe use Grok for this.\n\nBest,\nDoug' });
const email = JSON.parse((await request('POST', '/api/ask', { body: JSON.stringify({ format: 'email', draft: { purpose: 'email', company: 'Acme', text: 'Hi' } }) })).body);
check('AI email output is scrubbed', !BANNED.test(JSON.stringify(email)) && /the assistant follow-up/.test(email.subject), JSON.stringify(email));
chatReply = () => '<p>GrokBot says hello.</p>';
const answer = (await request('POST', '/api/ask', { body: JSON.stringify({ message: 'hi', history: [] }) })).body;
check('Ask AI answers are scrubbed', !BANNED.test(answer), answer.slice(0, 200));
chatReply = () => 'We met the Grok team.';
const li = (await request('POST', '/api/drafts/linkedin', { body: JSON.stringify({ showId: 'show:procurecon-east' }) })).body;
check('LinkedIn drafts are scrubbed', !BANNED.test(li), li.slice(0, 200));
const shipped = [];
for (const file of fs.readdirSync('out', { recursive: true })) {
  const full = path.join('out', String(file));
  if (fs.statSync(full).isFile() && /\.(html|js|json|css|txt|md|svg)$/.test(full) && BANNED.test(fs.readFileSync(full, 'utf8'))) shipped.push(full);
}
check('no shipped file names the banned terms (UI, titles, meta, comments, data)', shipped.length === 0, shipped.join(', '));
const seen = [];
for (const url of ['/', '/?view=pipeline&perf=demand', '/?view=pipeline&perf=spend', '/?view=pipeline&perf=web', '/?view=accounts&accounts=deals', '/?view=accounts&accounts=follow', '/?view=accounts&accounts=leads', '/?view=meetings&meetings=upcoming', '/?view=meetings&meetings=past', '/?view=drafts', '/?view=data']) {
  const p = await openPage(pub, url);
  const html = await p.content();
  if (BANNED.test(html)) seen.push(url);
  await p.close();
}
check('no rendered view names the banned terms', seen.length === 0, seen.join(', '));
check('no page errors', pageErrors.filter(e => !/never resolved/.test(e)).length === 0, pageErrors.join(' | '));

await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ ok: failures.length === 0, failures, screenshots: shots || null }, null, 2));
process.exit(failures.length ? 1 : 0);
