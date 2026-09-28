// End-to-end check of every Today, Events & shows, Pipeline, Accounts, Meetings
// and Drafts call to action: each click must land on the exact filtered list,
// draft or external record it names. The model and Google are mocked at the
// server boundary; nothing leaves this machine.
// SCREENSHOT_DIR=<dir> also saves screenshots of the fixed buttons.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.OPENAI_API_KEY = '';
const { createServer, setHooks, resetAuth } = await import('./agent-server.mjs');
const { parseEmailReply } = await import('./email-draft.mjs');

const failures = [];
const started = Date.now();
process.on('uncaughtException', e => {
  console.log(JSON.stringify({ ok: false, failures, crashed: String(e && e.message || e).split('\n')[0] }, null, 2));
  process.exit(1);
});
function check(name, ok, detail) {
  if (!ok) failures.push(name + (detail ? ': ' + detail : ''));
  else console.log('ok ' + name + (process.env.CTA_TIMING ? ' (' + ((Date.now() - started) / 1000).toFixed(1) + 's)' : ''));
}
const load = f => JSON.parse(fs.readFileSync(path.join(root, 'out/data', f), 'utf8'));
const hollie = load('hollie.json'), marketing = load('marketing.json'), records = load('records.json');
const seedsFile = load('draft-seeds.json'), seeds = Array.isArray(seedsFile) ? seedsFile : seedsFile.drafts || [];
const runFacts = load('run-facts.json'), sheetReview = load('sheet-review.json');
const shows = marketing.shows.items;
const card = id => hollie.marketingPriorities.find(p => p.id === id || p.id.startsWith(id));
const dpwAms = shows.find(s => s.id === 'show:dpw-amsterdam'), dpwNy = shows.find(s => s.id === 'show:dpw-new-york');
const HUBSPOT = 'https://app.hubspot.com/contacts/21303277/record/';

// ---- server-side contracts that need no browser ----
check('runId is the UTC date and time of the run', (() => {
  const m = String(runFacts.runId).match(/^run-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return false;
  const at = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + 'Z');
  return Math.abs(at - Date.parse(hollie.generatedAt)) < 60000;
})(), runFacts.runId + ' vs ' + hollie.generatedAt);
check('records and the operator carry the same runId', records.runId === runFacts.runId && hollie.runId === runFacts.runId);
const oneLine = parseEmailReply('Subject: Meeting at DPW Amsterdam Hi Nadine, Thanks for asking to meet. Would Wed work? Best, Doug');
check('one-line reply splits subject from body', oneLine.subject === 'Meeting at DPW Amsterdam' && /^Hi Nadine,/.test(oneLine.body), JSON.stringify(oneLine));
const meta = parseEmailReply("I can't create a workspace draft without a confirmed account name, but here it is.\nSubject: Booth time\nHi,\n\nText.\n\nLet me know if you want changes.");
check('assistant commentary is stripped', meta.subject === 'Booth time' && meta.body === 'Hi,\n\nText.', JSON.stringify(meta));

// ---- mocks ----
const chats = [];
let emailReply = () => JSON.stringify({ subject: 'Meeting at DPW Amsterdam: booth time', body: 'Hi Nadine,\n\nThanks for asking to meet at DPW Amsterdam.\n\nBest,\nDoug Daniels' });
async function callChatApi(payload) {
  chats.push(payload);
  const user = (payload.messages || []).find(m => m.role === 'user') || {};
  if (/Write one LinkedIn post/.test(user.content)) return { choices: [{ message: { content: 'Opstream will be at the show this week. Booth [booth number].' } }] };
  if (payload.response_format?.type === 'json_object') return { choices: [{ message: { content: emailReply() } }] };
  return { choices: [{ message: { content: '<p>Ask me about your marketing.</p>' } }] };
}
const outbound = [];
setHooks({ fetchImpl: async url => { outbound.push(String(url)); throw new Error('unexpected url ' + url); }, callChatApi, persistStateFile: async () => {}, putSecretString: async () => '{}' });
resetAuth();
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome', args: ['--no-sandbox'] });
const shots = process.env.SCREENSHOT_DIR || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const popups = [];
context.on('page', p => popups.push(p.url()));

async function home() {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Where to focus' }).waitFor();
  await page.waitForTimeout(300);
}
const priority = id => page.locator('[data-priority-id^="' + id + '"]');
async function shot(name, locator) {
  if (!shots) return;
  if (locator) await locator.screenshot({ path: path.join(shots, name + '.png') });
  else await page.screenshot({ path: path.join(shots, name + '.png') });
}
const leadRows = () => page.locator('.leads-table tbody tr');
async function leadCells(col) { return page.locator('.leads-table tbody tr td:nth-child(' + col + ')').allInnerTexts(); }
async function draftFields() {
  return {
    subject: await page.locator('#draft-subject').inputValue(),
    to: (await page.locator('#draft-to').count()) ? await page.locator('#draft-to').inputValue() : null,
    text: await page.locator('#draft-message').inputValue(),
    list: await page.locator('.draft-list-item strong').allInnerTexts(),
    showLine: (await page.locator('.draft-show-line').count()) ? await page.locator('.draft-show-line').innerText() : '',
  };
}
async function download(click) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
}
function csvRows(text) {
  const rows = [[]];
  let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ',') { rows[rows.length - 1].push(cell); cell = ''; }
    else if (ch === '\n') { rows[rows.length - 1].push(cell); cell = ''; rows.push([]); }
    else if (ch !== '\r') cell += ch;
  }
  rows[rows.length - 1].push(cell);
  return rows.filter(r => r.some(c => c !== ''));
}
const emailsOnly = to => to.split(',').map(x => x.trim()).filter(Boolean).every(x => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x));
const noRepeats = to => { const xs = to.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); return new Set(xs).size === xs.length; };

// ---- P1 · shows this week ----
await home();
const p1 = card('mkt:shows-soon');
await shot('p1-shows-this-week', priority('mkt:shows-soon'));
check('P1 primary names the DPW Amsterdam meetings', /^Book the 6 DPW Amsterdam meetings$/.test(p1.primary.label), p1.primary.label);
await priority('mkt:shows-soon').getByRole('button', { name: p1.primary.label }).click();
await page.locator('.draft-show-line').waitFor();
let f = await draftFields();
const meetSeeds = seeds.filter(d => d.showId === 'show:dpw-amsterdam' && d.purpose === 'event');
check('P1 opens exactly the 6 DPW Amsterdam meeting drafts', f.list.length === 6 && f.list.every(t => / · meeting at DPW Amsterdam$/.test(t)) && /Drafts for DPW Amsterdam: 6 event follow-ups/.test(f.showLine), f.list.join(' | ') + ' / ' + f.showLine);
check('P1 meeting drafts: one per requester', meetSeeds.length === dpwAms.requestRows.filter(r => !r.mql).length);
await page.locator('.draft-list-item', { hasText: 'Vanatge Towers' }).click();
f = await draftFields();
const vanatge = dpwAms.requestRows.find(r => r.company === 'Vanatge Towers');
check('DPW draft To is the Lead Tracker contact email', f.to === vanatge.email && emailsOnly(f.to), f.to);
check('DPW draft greets the contact by name', f.text.startsWith('Hi ' + vanatge.contact.split(' ')[0] + ','), f.text.split('\n')[0]);
check('DPW draft has booth and time-slot lines', /booth \[booth number\]/.test(f.text) && /Wed Sep 30 at \[time\] or Thu Oct 1 at \[time\]/.test(f.text), f.text);
check('DPW draft is signed by the lead owner', /\nDoug Daniels\nOpstream$/.test(f.text), f.text.slice(-40));
await shot('dpw-meeting-draft-filled');
const noEmail = meetSeeds.filter(d => !d.recipients);
check('DPW drafts with no email say so', noEmail.every(d => /No contact email for .* in the Lead Tracker or HubSpot/.test(d.rationale)), noEmail.map(d => d.company).join(', '));
check('DPW drafts never put a name in To', meetSeeds.every(d => !d.recipients || emailsOnly(d.recipients)));

await home();
const postsBefore = chats.filter(c => /Write one LinkedIn post/.test((c.messages.find(m => m.role === 'user') || {}).content)).length;
await priority('mkt:shows-soon').getByRole('button', { name: 'Draft LinkedIn post · ProcureCon East' }).click();
await page.locator('#draft-subject').waitFor();
f = await draftFields();
check('P1 LinkedIn button drafts ProcureCon East', /ProcureCon East/.test(f.subject), f.subject);
await home();
await priority('mkt:shows-soon').getByRole('button', { name: 'Draft LinkedIn post · DPW Amsterdam' }).click();
await page.waitForFunction(() => /DPW Amsterdam/.test(document.querySelector('#draft-subject')?.value || ''));
f = await draftFields();
check('P1 has a LinkedIn button per show', /DPW Amsterdam/.test(f.subject), f.subject);
const posts = chats.filter(c => /Write one LinkedIn post/.test((c.messages.find(m => m.role === 'user') || {}).content)).length;
check('each LinkedIn button made one request', posts - postsBefore === 2, String(posts - postsBefore));
await home();
const staffLinks = await priority('mkt:shows-soon').locator('a', { hasText: 'Add booth staff' }).evaluateAll(as => as.map(a => a.href));
check('P1 booth-staff links open the show-calendar rows', staffLinks.length >= 1 && staffLinks.every(h => h.startsWith('https://docs.google.com/spreadsheets/d/' + dpwAms.sheetRow.spreadsheetId)), staffLinks.join(' '));

// ---- P2 · webinar registrants ----
const p2 = card('mkt:webinar-unowned');
await priority('mkt:webinar-unowned').getByRole('button', { name: p2.primary.label }).click();
await page.locator('.lead-filter-line').waitFor();
const p2rows = await leadRows().count();
check('P2 opens the unassigned webinar registrants', p2rows === p2.expectedRows && p2rows === 61, p2rows + ' rows');
check('P2 rows are all Webinar and Unassigned', (await leadCells(3)).every(t => t === 'Webinar') && (await leadCells(4)).every(t => t === 'Unassigned'));
check('P2 filter line names the filters', /Source: Webinar · Owner: Unassigned/.test(await page.locator('.lead-filter-line').innerText()));
const contacts = await leadCells(2);
check('leads show contact name and title', contacts.some(t => t !== '—' && t.length > 3), contacts.slice(0, 3).join(' | '));
const rowLinks = await page.locator('.leads-table a.sheet-row-link').evaluateAll(as => as.map(a => ({ href: a.href, text: a.textContent })));
const ltId = sheetReview.leads.find(l => l.sheetRow)?.sheetRow.spreadsheetId;
check('each lead links to its Lead Tracker row', rowLinks.length === p2rows && rowLinks.every(l => l.href.startsWith('https://docs.google.com/spreadsheets/d/' + ltId + '/edit') && /^Row \d+/.test(l.text)), JSON.stringify(rowLinks[0]));
check('the URL keeps the lead filters', /leadSource=Webinar/.test(page.url()) && /owner=Unassigned/.test(page.url()), page.url());
const leadsCsv = await download(() => page.getByRole('button', { name: /^Export \d+ leads$/ }).click());
check('lead export has contact columns and only the filtered rows', /^Company,Contact,Title,Email,/.test(leadsCsv.text) && csvRows(leadsCsv.text).length === p2rows + 1, leadsCsv.text.split('\n')[0]);
await home();
await priority('mkt:webinar-unowned').getByRole('button', { name: 'See webinar conversion' }).click();
await page.locator('#leads-by-source').waitFor();
await page.waitForTimeout(200);
const byTop = await page.locator('#leads-by-source').evaluate(el => el.getBoundingClientRect().top);
check('P2 secondary opens Pipeline › Selected period by source', /view=pipeline/.test(page.url()) && byTop >= 0 && byTop < 300, 'top ' + byTop);

// ---- P3 · spend ----
await home();
const p3 = card('mkt:spend-not-entered');
const actuals = await priority('mkt:spend-not-entered').locator('a.btn-primary').getAttribute('href');
check('P3 primary opens the budget workbook Actuals tab', actuals === marketing.spend.sheet.url && actuals.includes('1b6ushSaYgv9CIhiQUn4mYD4nao7y4wJ-w_76wgS67LQ'), actuals);
await priority('mkt:spend-not-entered').getByRole('button', { name: 'Open the actuals to-do note' }).click();
await page.locator('#draft-subject').waitFor();
f = await draftFields();
check('P3 opens the actuals note', /^Enter .* actuals$/.test(f.subject) && /Actuals tab/.test(f.text), f.subject);
await home();
await priority('mkt:spend-not-entered').getByRole('button', { name: 'See spend' }).click();
check('P3 See spend opens Pipeline › Spend', /perf=spend/.test(page.url()), page.url());

// ---- P4 · show leads stuck ----
await home();
const p4 = card('mkt:show-followups');
check('P4 targets the show with the most leads', p4.primary.target.id === 'show:dpw-new-york' && /DPW New York follow-ups \(49 leads\)/.test(p4.primary.label), p4.primary.label);
await shot('p4-show-followups', priority('mkt:show-followups'));
await priority('mkt:show-followups').getByRole('button', { name: p4.primary.label }).click();
await page.locator('.draft-show-line').waitFor();
f = await draftFields();
check('P4 opens the drafts filtered to DPW New York', /Drafts for DPW New York/.test(f.showLine) && f.list.length >= 1 && f.list.every(t => /DPW New York/.test(t)), f.showLine + ' / ' + f.list.join(' | '));
check('P4 draft is a LemList campaign', /purpose=campaign/.test(page.url()) && /\{\{firstName\}\}/.test(f.text) && /\{\{companyName\}\}/.test(f.text));
check('P4 uses re-engagement wording for a June show', !/while it is fresh/i.test(f.text) && /back in June/.test(f.text), f.text.slice(0, 120));
await page.getByRole('button', { name: 'Show all drafts' }).click();
check('the show filter clears', (await page.locator('.draft-show-line').count()) === 0);
await home();
await priority('mkt:show-followups').getByRole('button', { name: 'Show these past shows' }).click();
await page.waitForTimeout(300);
const pastOpen = await page.locator('#past-shows').evaluate(d => d.open);
const lit = await page.locator('#past-shows [data-highlight="true"]').evaluateAll(ps => ps.map(p => p.id));
check('P4 opens Past shows', pastOpen === true);
check('P4 highlights DPW New York and Data in Procurement', lit.length === 2 && lit.includes('show-dpw-new-york') && lit.includes('show-data-in-procurement'), lit.join(','));
const nyBox = await page.locator('#show-dpw-new-york').evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, y: scrollY }; });
check('P4 scrolls the highlighted shows into view', nyBox.y > 0 && nyBox.top >= 0 && nyBox.bottom <= nyBox.h, JSON.stringify(nyBox));
await shot('p4-past-shows-highlighted');
await home();
const nyCsv = await download(() => priority('mkt:show-followups').getByRole('button', { name: 'Download DPW New York leads (CSV)' }).click());
const nyLines = csvRows(nyCsv.text);
const withEmail = nyLines.slice(1).filter(r => r[2]);
check('P4 CSV is LemList-ready with the show\'s leads', nyLines[0].slice(0, 4).join(',') === 'firstName,lastName,email,companyName' && nyLines.length === dpwNy.leads.count + 1 && withEmail.every(r => /@/.test(r[2])), nyLines.length - 1 + ' rows, ' + withEmail.length + ' with email');
await priority('mkt:show-followups').getByRole('button', { name: /Open the Data in Procurement follow-ups/ }).click();
await page.locator('.draft-show-line').waitFor();
check('P4 also opens the Data in Procurement follow-up', /Drafts for Data in Procurement/.test((await draftFields()).showLine));

// ---- P5 / P6 · lead stages ----
await home();
for (const [id, stage] of [['mkt:mql-no-sql', 'mql-no-sql'], ['mkt:unworked-by-source', 'no-mql']]) {
  const p = card(id);
  await priority(id).getByRole('button', { name: p.primary.label }).click();
  await page.locator('.lead-filter-line').waitFor();
  const n = await leadRows().count();
  const mqls = await leadCells(6), sqls = await leadCells(7);
  const ok = stage === 'no-mql' ? mqls.every(t => t === '—') : mqls.every(t => t !== '—') && sqls.every(t => t === '—');
  check(id + ' opens the ' + stage + ' leads', n === p.expectedRows && ok && new RegExp('leadStage=' + stage).test(page.url()), n + ' rows vs ' + p.expectedRows);
  if (stage === 'mql-no-sql') await shot('p5-mql-no-sql-leads');
  await home();
}
check('P6 shows about 190 leads, not the whole tracker', card('mkt:unworked-by-source').expectedRows < sheetReview.leads.length);

// ---- Events & shows ----
await home();
await page.locator('#show-dpw-amsterdam').getByRole('button', { name: 'Open meeting request drafts (6)' }).click();
await page.locator('.draft-show-line').waitFor();
check('show card opens its meeting drafts', /Drafts for DPW Amsterdam: 6 event follow-ups/.test((await draftFields()).showLine));
await home();
const calLink = await page.locator('#show-dpw-amsterdam a', { hasText: /show calendar/ }).getAttribute('href');
check('show card links to its show-calendar row', calLink === dpwAms.sheetRow.url, calLink);
await page.locator('#past-shows summary').click();
await page.waitForTimeout(200);
const today = records.generatedAt.slice(0, 10);
const stale = shows.filter(s => s.phase === 'past' && s.end && (Date.parse(today) - Date.parse(s.end)) / 86400000 > 14);
for (const s of stale) {
  const row = page.locator('#show-' + s.id.replace(/^show:/, ''));
  check('no LinkedIn post for ' + s.name + ' (over 2 weeks past)', (await row.getByRole('button', { name: /LinkedIn/ }).count()) === 0);
}
check('past-show posts never publish lead counts', seeds.filter(d => d.purpose === 'linkedin').every(d => !/shared their details|\d+ people/.test(d.text)));
check('no seeded post for a stale show', !seeds.some(d => d.purpose === 'linkedin' && stale.some(s => s.id === d.showId)));
await page.locator('#show-dpw-new-york').getByRole('button', { name: /Open the follow-up for 49 leads/ }).click();
await page.locator('.draft-show-line').waitFor();
check('past-show row opens its follow-up', /Drafts for DPW New York/.test((await draftFields()).showLine));

// ---- Coming up ----
await home();
await page.locator('.coming-row', { hasText: 'DPW Amsterdam' }).click();
await page.waitForTimeout(300);
const amsTop = await page.locator('#show-dpw-amsterdam').evaluate(el => el.getBoundingClientRect().top);
check('Coming up row scrolls to its show card', amsTop >= 0 && amsTop < 200, 'top ' + amsTop);
check('Coming up row highlights the show', (await page.locator('#show-dpw-amsterdam').getAttribute('data-highlight')) === 'true');

// ---- Pipeline ----
await page.goto(base + '/?view=pipeline&perf=demand', { waitUntil: 'networkidle' });
await page.locator('button', { hasText: 'Meetings completed' }).first().waitFor();
for (const [label, kind] of [['Meetings completed', 'completed'], ['Recordings', 'recordings']]) {
  await page.goto(base + '/?view=pipeline&perf=demand', { waitUntil: 'networkidle' });
  const btn = page.locator('button', { hasText: label }).first();
  const value = Number(((await btn.innerText()).match(/\n([\d,]+)\n/) || [])[1]?.replace(/,/g, ''));
  await btn.click();
  await page.locator('.meeting-kind-line').waitFor();
  const n = await page.locator('.meeting-row').count();
  check(label + ' card opens those ' + value + ' past meetings', n === value && new RegExp('meetingKind=' + kind).test(page.url()), n + ' rows vs ' + value);
}
await page.goto(base + '/?view=pipeline&perf=demand', { waitUntil: 'networkidle' });
const closeBtn = page.getByRole('button', { name: /^Review the \d+ deals closing / });
if (await closeBtn.count()) {
  const want = Number((await closeBtn.innerText()).match(/Review the (\d+)/)[1]);
  await closeBtn.click();
  await page.locator('.close-on-line').waitFor();
  const n = await page.locator('[data-screen-label="Accounts"] table tbody tr').count();
  check('Review by close date lists only the deals on that date', n === want && /closeOn=\d{4}-\d{2}-\d{2}/.test(page.url()), n + ' vs ' + want);
} else check('Review by close date is offered', false, 'no shared close date button');

// ---- Accounts, HubSpot links and follow-up drafts ----
const nxp = records.companies.find(c => /^NXP/.test(c.name));
await page.goto(base + '/?view=account&account=' + encodeURIComponent(nxp.id), { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: /NXP/ }).waitFor();
const coLink = await page.getByRole('link', { name: /Open in HubSpot/ }).getAttribute('href');
const coId = nxp.refs.find(r => r.startsWith('hubspot:companies:')).split(':')[2];
check('account page links to the HubSpot company', coLink === HUBSPOT + '0-2/' + coId, coLink);
const dealLinks = await page.locator('a.deal-hubspot-link').evaluateAll(as => as.map(a => a.href));
check('account deals link to HubSpot deals', dealLinks.length >= 1 && dealLinks.every(h => h.startsWith(HUBSPOT + '0-3/')), dealLinks.join(' '));
await page.locator('aside button', { hasText: nxp.contacts[0].name }).first().click();
await page.locator('.evidence-source-links a').first().waitFor();
const contactLinks = await page.locator('.evidence-source-links a').evaluateAll(as => as.map(a => a.href));
check('contact side panel links to the HubSpot contact', contactLinks.some(h => h.startsWith(HUBSPOT + '0-1/')), contactLinks.join(' '));
await page.keyboard.press('Escape');
await page.getByRole('button', { name: /follow-up draft/ }).first().click();
await page.locator('#draft-to').waitFor();
f = await draftFields();
check('Start a follow-up draft: To is email addresses, no repeats', f.to && emailsOnly(f.to) && noRepeats(f.to), f.to);
check('Start a follow-up draft: body is prefilled', f.text.trim().length > 40 && /^Hi/.test(f.text), f.text.slice(0, 80));

await page.goto(base + '/?view=accounts&accounts=follow', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Review draft' }).first().waitFor();
await page.getByRole('button', { name: 'Review draft' }).first().click();
await page.locator('#draft-to').waitFor();
f = await draftFields();
check('Review draft: To is email addresses, no repeats', f.to && emailsOnly(f.to) && noRepeats(f.to), f.to);

const rec = records.companies.flatMap(c => c.recordings || []).find(r => (r.invitees || []).filter(i => i.email && !/opstream/.test(i.email)).length >= 2);
await page.goto(base + '/?view=meeting&meeting=' + encodeURIComponent(rec.id), { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /follow-up draft/ }).first().click();
await page.locator('#draft-to').waitFor();
f = await draftFields();
check('meeting follow-up: To is email addresses, no repeats', f.to && emailsOnly(f.to) && noRepeats(f.to), f.to);

await page.goto(base + '/?view=pipeline&perf=demand', { waitUntil: 'networkidle' });
const noteRow = page.locator('section', { has: page.locator('h6', { hasText: 'Latest owner notes' }) }).locator('button').nth(1);
await noteRow.click();
await page.locator('[aria-modal="true"]').waitFor();
const noteLinks = await page.locator('.evidence-source-links a').evaluateAll(as => as.map(a => a.href));
check('owner-note panel links to the HubSpot deal', noteLinks.some(h => h.startsWith(HUBSPOT + '0-3/')), noteLinks.join(' ') || 'no links');
await page.keyboard.press('Escape');
await page.goto(base + '/?view=meetings&meetings=upcoming', { waitUntil: 'networkidle' });
await page.locator('.meeting-row').first().waitFor();
const rows = await page.locator('.meeting-row').count();
let dupes = 0;
for (let i = 0; i < Math.min(rows, 6); i++) {
  await page.locator('.meeting-row').nth(i).click();
  await page.locator('[aria-modal="true"]').waitFor();
  const txt = await page.locator('#evidence-readable').innerText();
  const m = txt.match(/Who (?:is invited|was there)\s*\n([^\n]+)/);
  if (m) { const names = m[1].split(', '); if (new Set(names).size !== names.length) dupes++; }
  await page.keyboard.press('Escape');
}
check('meeting panels list each attendee once', dupes === 0, dupes + ' panels with repeats');

// ---- Meetings prep link ----
await page.goto(base + '/?view=meetings', { waitUntil: 'networkidle' });
const prep = page.getByRole('button', { name: /meeting prep brief/ });
check('Meetings prep link names the real briefs', (await prep.count()) === 1 && !/Briefing tab/.test(await page.locator('body').innerText()));
await prep.click();
await page.locator('#meeting-prep').waitFor();
check('prep link opens Today › Sales & CS meeting prep', (await page.getByRole('button', { name: 'Sales & CS', exact: true }).getAttribute('aria-pressed')) === 'true' && (await page.locator('#meeting-prep').isVisible()));

// ---- Drafts: Generate with AI, Gmail, LemList ----
await home();
await priority('mkt:shows-soon').getByRole('button', { name: p1.primary.label }).click();
await page.locator('.draft-list-item', { hasText: 'Vanatge Towers' }).click();
check('signed out: no disabled "Sign in with Google to send" button', (await page.getByRole('button', { name: 'Sign in with Google to send' }).count()) === 0);
check('signed out: Copy for Gmail is the primary button', (await page.locator('.composer-actions .btn-primary').first().innerText()) === 'Copy for Gmail');
const compose = new URL(await page.getByRole('link', { name: /Open in Gmail/ }).getAttribute('href'));
f = await draftFields();
check('Gmail compose link has To, subject and body', compose.origin === 'https://mail.google.com' && compose.searchParams.get('view') === 'cm' && compose.searchParams.get('to') === f.to && compose.searchParams.get('su') === f.subject && compose.searchParams.get('body') === f.text, compose.href.slice(0, 120));
await page.locator('.composer-actions .btn-primary', { hasText: 'Copy for Gmail' }).click();
const clip = await page.evaluate(() => navigator.clipboard.readText());
check('Copy for Gmail copies To, subject and body', clip.startsWith('To: ' + f.to + '\nSubject: ' + f.subject + '\n\n') && clip.endsWith(f.text));

const before = await draftFields();
const asks = chats.length;
emailReply = () => 'Subject: Meeting at DPW Amsterdam Hi Nadine, Thanks for asking to meet. Would Wed Sep 30 at [time] work? Best, Doug Daniels';
await page.getByRole('button', { name: 'Generate with AI' }).click();
await page.locator('.form-success, .form-error', { hasText: /AI draft generated|Could not generate/ }).first().waitFor();
f = await draftFields();
const sent = chats.slice(asks).find(c => c.response_format?.type === 'json_object');
check('Generate with AI asks for JSON with the company and recipients', !!sent && !sent.tools && /Company: Vanatge Towers/.test(sent.messages[1].content) && sent.messages[1].content.includes('To: ' + before.to), sent ? sent.messages[1].content.slice(0, 160) : 'no request');
check('Generate with AI: one-line reply keeps subject and body apart', f.subject === 'Meeting at DPW Amsterdam' && /^Hi Nadine,/.test(f.text), JSON.stringify([f.subject, f.text.slice(0, 40)]));
emailReply = () => JSON.stringify({ subject: 'DPW Amsterdam: time at booth [booth number]', body: 'Hi Nadine,\n\nWould Wed Sep 30 at [time] work?\n\nDoug Daniels' });
await page.getByRole('button', { name: 'Generate with AI' }).click();
await page.waitForFunction(() => /time at booth/.test(document.querySelector('#draft-subject')?.value || ''));
f = await draftFields();
check('Generate with AI: JSON reply fills subject and body', f.subject === 'DPW Amsterdam: time at booth [booth number]' && f.text === 'Hi Nadine,\n\nWould Wed Sep 30 at [time] work?\n\nDoug Daniels', JSON.stringify(f.text));
await shot('generate-with-ai-working');
emailReply = () => "I can't create a workspace draft without a confirmed account name.";
const kept = await draftFields();
await page.getByRole('button', { name: 'Generate with AI' }).click();
await page.locator('.form-error', { hasText: /Could not generate/ }).waitFor();
f = await draftFields();
check('Generate with AI never blanks the message', f.text === kept.text && f.subject === kept.subject);

await page.goto(base + '/?view=drafts&purpose=campaign', { waitUntil: 'networkidle' });
await page.locator('.draft-list-item', { hasText: 'Webinar registrant follow-up' }).click();
f = await draftFields();
const recording = marketing.webinarRecording;
check('LemList webinar copy includes the recording link or a marked placeholder', recording ? f.text.includes(recording.url) : /\[recording link\]/.test(f.text), f.text.slice(0, 160));

// ---- About this data ----
await page.goto(base + '/?view=data', { waitUntil: 'networkidle' });
await page.locator('a.source-link').first().waitFor();
const srcLinks = await page.locator('a.source-link').evaluateAll(as => Object.fromEntries(as.map(a => [a.textContent.replace(' ↗', ''), a.href])));
check('About this data links HubSpot', srcLinks['HubSpot CRM'] === 'https://app.hubspot.com/contacts/21303277');
check('About this data links the master Sheet', srcLinks['Master Sheet (pipeline_meeting1_v2)'] === 'https://docs.google.com/spreadsheets/d/' + ltId + '/edit');
check('About this data links the budget workbook', srcLinks['Marketing budget workbook'] === marketing.spend.sheet.url);
check('About this data links LemList, GA4, Fathom and Otterly', ['LemList', 'GA4 · www.opstream.ai', 'Fathom', 'Otterly · AI answers'].every(k => /^https:\/\//.test(srcLinks[k] || '')), JSON.stringify(srcLinks));

check('no page errors', errors.length === 0, errors.join(' | '));
check('the server made no outbound calls', outbound.length === 0, outbound.join(' '));
await browser.close();
server.close();
console.log(JSON.stringify({ ok: failures.length === 0, failures, screenshots: shots || null }, null, 2));
process.exit(failures.length ? 1 : 0);
