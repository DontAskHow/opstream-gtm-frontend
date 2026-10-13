// End to end on synthetic data: scripts/synthetic-data.cjs (brainFixture) ->
// scripts/fixture-db.py -> scripts/workspace-data.py -> onepage/build.mjs, then
// assertions on the rendered HTML and JSON. No real data is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, buildView, assertScrubbed } from '../onepage/build.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { brainFixture } = require('../scripts/synthetic-data.cjs');
const page = require('../onepage/page.cjs');
const SCOPE = JSON.parse(readFileSync(join(ROOT, 'shared', 'workspace-scope.json'), 'utf8'));

function run({ synced = false, inputs = true, extra = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-e2e-'));
  const fx = brainFixture({ synced });
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fx));
  for (const [k, v] of Object.entries(fx.inputs)) writeFileSync(join(dir, k + '.json'), JSON.stringify(v));
  execFileSync('python3', [join(ROOT, 'scripts', 'fixture-db.py'), join(dir, 'fixture.json'), join(dir, 'brain.db')]);
  const args = [join(ROOT, 'scripts', 'workspace-data.py'), '--db', join(dir, 'brain.db'), '--lead-sources', join(dir, 'leadSources.json'),
    '--as-of', fx.expect.asOf, '--out', join(dir, 'workspace.json'), '--quiet', ...extra];
  if (inputs) {
    args.push('--lost-reasons', join(dir, 'lostReasons.json'), '--insights', join(dir, 'insights.json'), '--lead-insights', join(dir, 'leadInsights.json'),
      '--prior', join(dir, 'prior.json'), '--current-page', join(dir, 'currentPage.json'), '--portal-id', '12345');
  }
  execFileSync('python3', args);
  const { view, html } = build({ data: join(dir, 'workspace.json'), out: join(dir, 'out'), quiet: true });
  const json = readFileSync(join(dir, 'workspace.json'), 'utf8');
  return { dir, fx, ex: fx.expect, data: JSON.parse(json), json, view, html, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fig = (html, key) => {
  const m = new RegExp(`data-fig="${key}"><div class="tile-l">[^<]*</div><div class="tile-v num">([^<]*)<`).exec(html);
  return m && m[1];
};

const base = run();
const synced = run({ synced: true });
test.after(() => { base.cleanup(); synced.cleanup(); });

test('headline: open Sales Pipeline deals, amount, weighted and On Hold', () => {
  const { html, data, ex } = base;
  assert.equal(data.headline.open.count, ex.headline.count);
  assert.equal(data.headline.open.amount, ex.headline.amount);
  assert.equal(data.headline.open.weighted, ex.headline.weighted);
  assert.equal(data.headline.onHold.count, ex.headline.onHoldCount);
  assert.equal(data.headline.onHold.amount, ex.headline.onHoldAmount);
  assert.equal(fig(html, 'open-count'), '4');
  assert.equal(fig(html, 'open-amount'), '$750,000');
  assert.equal(fig(html, 'weighted'), '$340,000');
  assert.equal(fig(html, 'on-hold'), '2');
});

test('what changed: from the prior export, with the deals that moved and its basis', () => {
  const c = base.data.headline.change;
  const e = base.ex.change;
  assert.deepEqual([c.from.count, c.from.amount, c.to.count, c.to.amount], [e.fromCount, e.fromAmount, e.toCount, e.toAmount]);
  assert.deepEqual(c.deals.filter((d) => d.kind === 'new').map((d) => d.id), e.newIds);
  assert.deepEqual(c.deals.filter((d) => d.kind === 'stage').map((d) => d.id), e.stageIds);
  assert.match(c.basis, /prior\.json/);
  assert.match(base.html, /What changed:<\/strong> open deals went from <span class="num">3<\/span> \/ <span class="num">\$600,000<\/span> to <span class="num">4<\/span>/);
  assert.match(base.html, /data-dismiss="chg:/, 'the note can be dismissed');
});

test('what changed without a prior export falls back to createdate and says so', () => {
  const r = run({ inputs: false });
  try {
    const c = r.data.headline.change;
    assert.deepEqual(c.deals.map((d) => d.id), ['7003']);
    assert.equal(c.from.count, 3);
    assert.match(c.basis, /No earlier HubSpot export/);
  } finally { r.cleanup(); }
});

test('Sales Pipeline only: renewal, partnerships and CS deals never appear', () => {
  const { data, html } = base;
  assert.ok(data.deals.every((d) => !/renewal|partnership|success plan/i.test(d.name)));
  assert.ok(!/Bluebird renewal|Maple partnership|Juniper success plan/.test(html));
  // A customer's new Sales Pipeline deal stays in the pipeline.
  assert.ok(data.deals.some((d) => d.name === 'Juniper new team'));
});

test('closed lost and disqualified are separate, lost reasons from the file then auto-mapped', () => {
  const { data, view, html, ex } = base;
  const by = Object.fromEntries(data.closed.lostByStage.map((x) => [x.stage, x]));
  assert.equal(by['Closed lost'].count, ex.closed.lost);
  assert.equal(by['Closed lost'].amount, ex.closed.lostAmount);
  assert.equal(by.Disqualified.count, ex.closed.dq);
  assert.equal(fig(html, 'lost-closed-lost'), '2');
  assert.equal(fig(html, 'lost-disqualified'), '1');
  const rows = Object.fromEntries(view.closed.reasons.rows.map((r) => [r.key, r]));
  assert.equal(rows.went_dark.deals[0].source, 'file');
  assert.equal(rows.competitor.count, 1);
  assert.equal(rows.not_a_fit.byStage.Disqualified, 1);
  assert.match(view.closed.reasons.basis, /1 of 3 deals categorized by lost-reasons\.json/);
});

test('leads: Lead Tracker companies, first lead date, MQL counts SQL', () => {
  const { data, html, ex } = base;
  const L = data.leads;
  assert.equal(L.total, ex.leads.total);
  assert.equal(L.mql, ex.leads.mql);
  assert.equal(L.sql, ex.leads.sql);
  assert.equal(fig(html, 'leads'), '9');
  assert.equal(fig(html, 'lead-mql'), '44.4%');
  const north = L.items.find((l) => l.company === 'Northstar Labs');
  assert.equal(north.leadDate, '2026-08-01', 'earliest of the duplicate rows');
  assert.deepEqual(north.rows, [4, 6]);
  assert.equal(L.items.find((l) => l.company === 'Willow Health').leadDate, '2026-10-02', 'First Touch when Lead Date is empty');
  assert.ok(L.items.find((l) => l.company === 'Elm Partners').mql, 'an SQL date counts as MQL');
  assert.ok(L.items.find((l) => l.company === 'Birch Co').flags.some((f) => f.kind === 'sheet'));
});

test('leads: Sheet Source wins; conflicts flagged; paid platforms, OpenAI named vs at most', () => {
  const L = base.data.leads;
  const orchid = L.items.find((l) => l.company === 'Orchid Retail');
  assert.equal(orchid.source, 'Inbound');
  assert.ok(orchid.conflict);
  assert.equal(L.openai.confirmed, base.ex.leads.openaiConfirmed);
  assert.equal(L.openai.atMost, base.ex.leads.openaiAtMost);
  const maple = L.items.find((l) => l.company === 'Maple Analytics');
  assert.equal(maple.subSource, 'Platform not named');
  assert.deepEqual(maple.possiblePlatforms, ['OpenAI (ChatGPT) Ads', 'Reddit Ads']);
  assert.equal(L.items.find((l) => l.company === 'Quartz Media').subSource, 'Google Ads');
  assert.equal(L.items.find((l) => l.company === 'Pine Robotics').rule, 'Lead Tracker note');
});

test('leads: not-yet-synced sources are labelled, and the mapping is provisional', () => {
  const { data, html } = base;
  assert.equal(data.meta.notSynced.length, 7);
  assert.ok(data.flags.some((f) => f.key === 'not-synced'));
  assert.equal(data.leads.items.find((l) => l.company === 'Cedar Harbor').subSource, 'List: memberships not yet synced');
  assert.match(html, /not yet synced/);
  assert.match(html, /provisional \(awaiting Reviewer\)/, 'who from needs_<who> in lead-sources.json');
});

test('leads with the new sync tables: each rule fires in order', () => {
  const L = synced.data.leads;
  const by = (n) => L.items.find((l) => l.company === n);
  assert.equal(by('Northstar Labs').rule, 'HubSpot form submission');
  assert.equal(by('Northstar Labs').subSource, 'demo_request');
  assert.equal(by('Orchid Retail').unconfirmed, true, 'an uncertain form mapping is "mapping unconfirmed"');
  assert.equal(by('Cedar Harbor').rule, 'Event list upload');
  assert.equal(by('Cedar Harbor').subSource, 'Synthetic East 2026', 'list 692 is excluded by scope; 884 counts');
  assert.equal(by('Pine Robotics').rule, 'paid_touch_campaign');
  assert.equal(by('Pine Robotics').platform, 'OpenAI (ChatGPT) Ads');
  assert.equal(by('Willow Health').subSource, 'Customer job changer');
  assert.equal(by('Willow Health').tag, 'customer→new company');
  assert.ok(!synced.data.flags.some((f) => f.key === 'not-synced'));
  assert.match(synced.html, /mapping unconfirmed/);
});

test('ad platforms: platform-reported events, not leads, with spend days and how each counts', () => {
  const { data, html } = base;
  const by = Object.fromEntries(data.ads.map((a) => [a.key, a]));
  assert.equal(by.openai.conversions, 7);
  assert.equal(by.openai.spendDays, 12);
  assert.equal(by.openai.events.length, 2);
  assert.equal(by.openai.landingPages[0].conversions, 6);
  assert.equal(by.google.spendDays, 2);
  assert.deepEqual(by.google.window, { start: '2026-09-01', end: '2026-10-11', basis: 'first and last day with spend' });
  assert.equal(by.google.allConversions, 30);
  assert.equal(by.reddit.stale, true);
  assert.equal(by.linkedin.connected, false);
  assert.match(html, /platform-reported events, not leads/);
});

test('outbound: sales campaigns only, real replies, opens/meetings not tracked', () => {
  const o = base.data.outbound;
  assert.deepEqual(o.campaigns.map((c) => c.name), ['Synthetic Outbound A', 'Synthetic Event Outreach']);
  assert.equal(o.delivered, base.ex.outbound.delivered);
  assert.equal(o.replies, base.ex.outbound.replies);
  assert.equal(o.campaigns[1].replies, 5);
  assert.ok(o.campaigns[1].mostlyInvite);
  assert.ok(o.excluded.some((c) => c.kind === 'customer'));
  assert.match(base.html, /not tracked/);
  assert.match(base.html, /replies look automatic/);
  const s = synced.data.outbound;
  assert.equal(s.campaigns[0].replies, 2, 'an out-of-office reply is not a real reply');
  assert.equal(s.campaigns[0].autoReplies, 1);
});

test('meetings: the call rule, CS owners out, matched / unmatched / no contact', () => {
  const { data, html, ex } = base;
  const M = data.meetings;
  assert.deepEqual(M.thisMonth, ex.meetings.thisMonth);
  assert.deepEqual(M.upcoming, ex.meetings.upcoming);
  for (const k of Object.keys(ex.meetings.scope)) assert.equal(M.scope[k], ex.meetings.scope[k], k);
  assert.equal(fig(html, 'meetings-month'), '4');
  assert.equal(fig(html, 'meetings-upcoming'), '3');
  const ids = M.items.map((m) => m.id);
  assert.ok(ids.includes('8008'), 'a call at a won company before its first win is a prospect meeting');
  assert.ok(!ids.includes('8009'), 'after the first win it is a customer meeting');
  assert.ok(!ids.includes('8004'), 'CS owners are out');
  assert.ok(!ids.includes('8012'), 'an unlinked meeting naming a customer company is out');
  assert.ok(!ids.includes('8016'), 'a meeting tied to a Renewal deal is out');
  assert.equal(M.items.find((m) => m.id === '8010').reason, 'no Sales Pipeline deal at the linked company');
  assert.equal(M.items.find((m) => m.id === '8001').recordingId, 'R1001', 'the Fathom summary is linked');
  assert.ok(!M.items.some((m) => /Casey|Drew/.test(m.owner)));
});

test('calls: Fathom prospect calls only', () => {
  const C = base.data.calls;
  const ex = base.ex.calls;
  for (const k of ['total', 'internal', 'cs', 'customer', 'prospect']) assert.equal(C.scope[k], ex[k], k);
  assert.equal(C.items.length, ex.listed);
  assert.deepEqual(C.items.map((c) => c.id).sort(), ['R1001', 'R1004', 'R1007']);
  assert.equal(C.items.find((c) => c.id === 'R1007').recorder, 'Unassigned');
  assert.ok(!/\]\(https/.test(C.items.find((c) => c.id === 'R1001').summary), 'markdown links are reduced to text');
});

test('hidden owner: "Unassigned" everywhere, and nowhere in the HTML or JSON', () => {
  const pat = SCOPE.hiddenOwner.pattern;
  for (const r of [base, synced]) {
    assert.ok(!r.json.toLowerCase().includes(pat), 'workspace.json');
    assert.ok(!r.html.toLowerCase().includes(pat), 'index.html');
  }
  const { data } = base;
  assert.equal(data.deals.find((d) => d.id === '7011').owner, 'Unassigned');
  assert.equal(data.leads.items.find((l) => l.company === 'Maple Analytics').owner, 'Unassigned');
  assert.equal(data.meetings.items.find((m) => m.id === '8003').owner, 'Unassigned');
  assert.match(data.meetings.items.find((m) => m.id === '8001').title, /with Unassigned$/);
  assert.equal(data.insights.insights[0].owner, 'Unassigned / Alex Morgan');
  assert.equal(data.leads.items.find((l) => l.company === 'Elm Partners').owner, 'Unassigned', '"not assigned" in the Sheet');
  assert.throws(() => assertScrubbed('owner: ' + pat.toUpperCase(), 'test'), /scrub check failed/);
});

test('the build refuses data that still carries the hidden owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-scrub-'));
  try {
    const d = structuredClone(base.data);
    d.deals[0].owner = SCOPE.hiddenOwner.pattern + ' K';
    writeFileSync(join(dir, 'w.json'), JSON.stringify(d));
    assert.throws(() => build({ data: join(dir, 'w.json'), out: join(dir, 'out'), quiet: true }), /scrub check failed/);
    assert.ok(!existsSync(join(dir, 'out', 'index.html')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('staleness and freshness chips', () => {
  const { data, html } = base;
  const keys = data.flags.map((f) => f.key);
  for (const k of ['otterly', 'ads-reddit', 'spend', 'ga4', 'not-synced']) assert.ok(keys.includes(k), k);
  assert.match(html, /Otterly down · last good Oct 3, 6:18 AM PT/);
  assert.match(html, /Reddit Ads data ends Sep 28/);
  assert.match(html, /Spend actuals missing Aug–Oct/);
  assert.match(html, /GA4 channels: 40% Unassigned/);
  assert.match(html, /HubSpot 8:50 AM PT/);
});

test('dropped: This week, bridge and records counts', () => {
  const { html } = base;
  assert.ok(!/This week/i.test(html));
  assert.ok(!/HubSpot bridge|Sheet-active/i.test(html));
  assert.ok(!/records\.json|recordsOpenCount|unmatchedRecordings/.test(html));
});

test('scope footer: what the redesign removes from the current page', () => {
  const cp = base.data.scope.currentPage;
  assert.deepEqual({ companies: cp.companies, meetings: cp.meetings, recordings: cp.recordings, recordingsTotal: cp.recordingsTotal }, base.ex.currentPage);
  assert.match(base.html, /removes 3 customer companies, their 6 meetings and 3 of 5 recordings/);
});

test('drill-down: source row -> lead list -> lead drawer, meetings -> list -> drawer, from the hash', () => {
  const v = base.view;
  const orchid = v.leads.items.find((l) => l.company === 'Orchid Retail');
  const s = page.parseState(`#src=Inbound&lead=${orchid.id}`);
  const out = page.renderPage(v, s);
  assert.match(out.main, /aria-expanded="true"/);
  assert.match(out.main, /Search leads/);
  assert.match(out.drawer, /role="dialog"/);
  assert.match(out.drawer, /Rule that fired/);
  assert.match(out.drawer, /conflict/);
  const north = v.leads.items.find((l) => l.company === 'Northstar Labs');
  const nd = page.renderPage(v, { lead: north.id }).drawer;
  assert.match(nd, /Send the pilot plan/, 'lead-insights.json by HubSpot contact id');
  assert.ok(!/fathom\.video/.test(nd), 'URL fragments in the insight are dropped');
  assert.match(nd, /app\.hubspot\.com\/contacts\/12345\/record\/0-2\/9001/, 'company link');
  assert.match(nd, /data-set="deal=7011"/, 'deal -> deal drawer');
  assert.match(page.renderPage(v, { deal: '7011' }).drawer, /app\.hubspot\.com\/contacts\/12345\/record\/0-3\/7011/, 'deal link');
  const m = page.renderPage(v, page.parseState('#mo=*&mb=unmatched&mtg=8001'));
  assert.match(m.main, /aria-pressed="true">Unmatched/);
  assert.match(m.drawer, /approvals are slow/, 'Fathom summary in the meeting drawer');
  const d = page.renderPage(v, { deal: '7008' }).drawer;
  assert.match(d, /Went dark/);
  // Opening one drawer closes another; empty values clear keys.
  assert.deepEqual(page.applyChange({ lead: 'L4', src: 'Paid' }, 'mtg=8001'), { src: 'Paid', mtg: '8001' });
  assert.deepEqual(page.applyChange({ src: 'Paid' }, 'src=Paid', true), {});
  assert.equal(page.stateHash({ src: 'Paid', lead: 'L4' }), '#lead=L4&src=Paid');
});

test('the page is self-contained, labels times PT and works on mobile', () => {
  const { html } = base;
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<script src=|<link [^>]*href=/.test(html), 'no external scripts or styles');
  assert.match(html, /data as of Oct 13, 9:00 AM PT/);
  assert.match(html, /@media \(max-width: 640px\)/);
  assert.match(html, /\.drawer \{ width: 100%/);
  assert.match(html, /<script type="application\/json" id="gtm-data">/);
});

test('buildView: an invalid lost-reasons file is ignored and every deal auto-mapped', () => {
  const d = structuredClone(base.data);
  d.closed.reasonsDoc = { deals: 'nope' };
  const v = buildView(d);
  assert.match(v.closed.reasons.basis, /did not pass validation/);
  assert.equal(v.closed.reasons.fromFile, 0);
});
