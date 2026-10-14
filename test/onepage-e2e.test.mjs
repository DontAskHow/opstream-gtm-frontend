// End to end on synthetic data: scripts/synthetic-data.cjs (brainFixture) ->
// scripts/fixture-db.py -> scripts/workspace-data.py -> onepage/build.mjs, then
// assertions on the rendered HTML and JSON. No real data is read.
// base:   today's brain.db shape, with Strategy's call classification, the lead-source
//         review list and Pipeline's paid-deal export.
// synced: the tables and fields the sync change adds, without those three files (the
//         fallbacks: built-in call rule, paid rules on contact fields).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, buildView, assertScrubbed } from '../onepage/build.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { brainFixture, SYNTHETIC_SCRUB } = require('../scripts/synthetic-data.cjs');
const page = require('../onepage/page.cjs');
const RULES = JSON.parse(readFileSync(join(ROOT, 'config', 'lead-rules.json'), 'utf8'));
// The synthetic person the fixture plants; the real patterns never enter the repo.
process.env.WORKSPACE_SCRUB_PATTERNS = SYNTHETIC_SCRUB;
delete process.env.WORKSPACE_SCRUB_PATTERNS_FILE;

// Runs the data step the way the sync job does: --inputs-dir with the files named as in S3
// (state/gtm-inputs/<name>), then builds the page with the data inside.
function run({ synced = false, inputs = true, files = true, env = {}, patternsFile = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-e2e-'));
  const fx = brainFixture({ synced });
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fx));
  for (const [k, v] of Object.entries(fx.inputs)) writeFileSync(join(dir, k + '.json'), JSON.stringify(v));
  execFileSync('python3', [join(ROOT, 'scripts', 'fixture-db.py'), join(dir, 'fixture.json'), join(dir, 'brain.db')]);
  const ind = join(dir, 'inputs');
  mkdirSync(ind);
  const put = (name, text) => writeFileSync(join(ind, name), text);
  put('lead-sources.json', JSON.stringify(fx.inputs.leadSources));
  if (inputs) {
    put('lost-reasons.json', JSON.stringify(fx.inputs.lostReasons));
    put('insights.json', JSON.stringify(fx.inputs.insights));
    put('lead-insights.json', JSON.stringify(fx.inputs.leadInsights));
  }
  if (files) {
    put('records.jsonl', fx.text['records.jsonl']);
    put('lead-source-review.csv', fx.text['review.csv']);
    put('paid-deals.json', JSON.stringify(fx.inputs.paidExport));
  }
  if (patternsFile) put('scrub-patterns.txt', '# synthetic\n' + SYNTHETIC_SCRUB + '\n');
  const args = [join(ROOT, 'scripts', 'workspace-data.py'), '--db', join(dir, 'brain.db'), '--inputs-dir', ind,
    '--as-of', fx.expect.asOf, '--out', join(dir, 'workspace.json'), '--quiet'];
  if (inputs) args.push('--prior', join(dir, 'prior.json'), '--current-page', join(dir, 'currentPage.json'), '--portal-id', '12345');
  const e = { ...process.env, CALL_CLASSIFICATION: '', LEAD_SOURCE_REVIEW: '', PAID_EXPORT: '', ...env };
  execFileSync('python3', args, { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  const { view, html } = build({ data: join(dir, 'workspace.json'), out: join(dir, 'out'), quiet: true });
  const json = readFileSync(join(dir, 'workspace.json'), 'utf8');
  return { dir, fx, ex: fx.expect, data: JSON.parse(json), json, view, html, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fig = (html, key) => {
  const m = new RegExp(`data-fig="${key}"><div class="tile-l">[^<]*</div><div class="tile-v num">([^<]*)<`).exec(html);
  return m && m[1];
};
const lead = (r, name) => r.data.leads.items.find((l) => l.company === name);

const base = run();
const synced = run({ synced: true, files: false });
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
  const r = run({ inputs: false, files: false });
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
  assert.ok(data.deals.some((d) => d.name === 'Juniper new team'), "a customer's new Sales Pipeline deal stays");
});

test('closed lost and disqualified separately; lost reasons cover new business only', () => {
  const { data, view, html, ex } = base;
  const by = Object.fromEntries(data.closed.lostByStage.map((x) => [x.stage, x]));
  assert.equal(by['Closed lost'].count, ex.closed.lost);
  assert.equal(by['Closed lost'].amount, ex.closed.lostAmount);
  assert.equal(by.Disqualified.count, ex.closed.dq);
  assert.equal(fig(html, 'lost-closed-lost'), '3');
  assert.equal(fig(html, 'lost-disqualified'), '1');
  assert.deepEqual(data.closed.lost.filter((d) => d.postWin).map((d) => d.id), ex.closed.postWin, 'a loss created after the first win is an expansion');
  assert.equal(view.closed.reasons.count, ex.closed.reasons);
  const rows = Object.fromEntries(view.closed.reasons.rows.map((r) => [r.key, r]));
  assert.equal(rows.went_dark.deals[0].source, 'file');
  assert.equal(rows.not_a_fit.byStage.Disqualified, 1);
  assert.match(view.closed.reasons.basis, /1 of 3 deals categorized by lost-reasons\.json/);
  assert.match(html, /Expansion losses at customers \(not categorized\)/);
});

test('leads: Lead Tracker companies with their first lead date', () => {
  const { data, html, ex } = base;
  const L = data.leads;
  assert.equal(L.total, ex.leads.total);
  assert.equal(L.mql, ex.leads.mql);
  assert.equal(L.sql, ex.leads.sql);
  assert.equal(fig(page.renderPage(base.view, { lp: 'all' }).main, 'leads'), '10');
  const north = lead(base, 'Northstar Labs');
  assert.equal(north.leadDate, '2026-08-01', 'earliest of the duplicate rows');
  assert.deepEqual(north.rows, [4, 6]);
  assert.equal(lead(base, 'Willow Health').leadDate, '2026-10-02', 'First Touch when Lead Date is empty');
  assert.ok(lead(base, 'Elm Partners').mql, 'an SQL date counts as a Sheet MQL');
  assert.ok(lead(base, 'Birch Co').flags.some((f) => f.kind === 'sheet'));
});

test('HubSpot is primary for source; the Sheet is the fallback; review-list statuses decide', () => {
  // undetermined (no MQL yet): the HubSpot-primary source is kept.
  const orchid = lead(base, 'Orchid Retail');
  assert.deepEqual([orchid.sheetSource, orchid.source, orchid.sourceBasis, orchid.rule], ['Inbound', 'Paid', 'hubspot', 'HubSpot source (review list)']);
  assert.equal(orchid.platform, 'OpenAI (ChatGPT) Ads');
  assert.equal(orchid.mqlChannel, 'undetermined');
  assert.ok(orchid.review && orchid.flags.some((f) => f.kind === 'review'));
  // resolved: credited to the channel of the touch at the MQL; a different first touch is shown.
  const cedar = lead(base, 'Cedar Harbor');
  assert.deepEqual([cedar.sheetSource, cedar.source, cedar.rule, cedar.firstTouch], ['Events', 'Outbound', 'MQL touch (review list)', 'Events (Synthetic show)']);
  // on_hold*: neither side changes; the current source stays, flagged.
  const birch = lead(base, 'Birch Co');
  assert.deepEqual([birch.source, birch.sourceBasis, birch.hold], ['Webinar', 'sheet', 'On hold, pending Reviewer']);
  assert.ok(birch.evidence.every((e) => !e.decides));
  assert.ok(birch.flags.some((f) => f.kind === 'hold'));
  const quartz = lead(base, 'Quartz Media');
  assert.deepEqual([quartz.source, quartz.sourceBasis, quartz.rule, quartz.review], ['Paid', 'hubspot', 'HubSpot check (Pipeline)', false]);
  assert.equal(base.data.leads.hubspotSourced, 5);
  assert.equal(base.data.leads.reviewLeads, 5);
  // The review list file is shown as is, linked to the leads.
  assert.equal(base.data.reviewList.rows.length, 3);
  assert.equal(base.data.reviewList.leadIds['9'], orchid.id);
  const rv = page.renderPage(base.view, { rv: '1' }).main;
  assert.match(rv, /Source disagreements to review/);
  assert.match(rv, /gus@orchid\.example: OpenAI via utm/);
  assert.match(rv, /On hold, pending Reviewer/);
  // The Pipeline export names platforms but never moves a source.
  const north = lead(base, 'Northstar Labs');
  assert.equal(north.source, 'Inbound');
  assert.ok(north.evidence.some((e) => e.rule === 'Paid deal (Pipeline export)' && !e.decides));
});

test("Pipeline's paid leads and deals: conversion date and the predates-spend-window flag; a check supersedes a Sheet note", () => {
  const elm = lead(base, 'Elm Partners');
  assert.deepEqual([elm.sheetSource, elm.source, elm.platform, elm.conversionDate, elm.predatesSpendWindow], ['RFP', 'Paid', 'LinkedIn Ads', '2026-01-17', true]);
  const d = page.renderPage(base.view, { lead: elm.id }).drawer;
  assert.match(d, /predates spend window/);
  assert.match(d, /Jan 17, 2026/);
  const li = base.data.paidDeals.sales.find((x) => x.id === '7011');
  assert.deepEqual([li.conversionDate, li.predatesSpendWindow], ['2026-02-20', true]);
  assert.equal(base.data.paidDeals.predates, 1);
  assert.match(page.renderPage(base.view, { pd: 'LinkedIn Ads' }).main, /predates spend window/);
  assert.match(page.renderPage(base.view, { deal: '7011' }).drawer, /predates spend window/);
  // The Sheet note says Reddit; Pipeline's check says branded Google: Google it is, and Reddit has none.
  const spruce = lead(base, 'Spruce Labs');
  assert.deepEqual([spruce.source, spruce.platform, spruce.tag], ['Paid', 'Google Ads', RULES.ads.brandedFlag]);
  assert.ok(spruce.evidence.find((e) => e.rule === 'Lead Tracker note').superseded);
  const reddit = base.data.leads.platforms.find((p) => p.key === 'reddit');
  assert.deepEqual([reddit.confirmed, reddit.trackerNamed], [0, 0]);
});

test('paid platforms: named vs at most, Lead Tracker notes alone vs with HubSpot evidence', () => {
  const L = base.data.leads;
  assert.equal(L.openai.confirmed, base.ex.leads.openaiConfirmed);
  assert.equal(L.openai.atMost, base.ex.leads.openaiAtMost);
  assert.equal(L.openai.trackerNamed, 2);
  assert.equal(L.openai.trackerAtMost, 3);
  const maple = lead(base, 'Maple Analytics');
  assert.equal(maple.subSource, 'Platform not named');
  assert.deepEqual(maple.possiblePlatforms, ['OpenAI (ChatGPT) Ads', 'Reddit Ads']);
  assert.equal(L.platforms.find((p) => p.key === 'reddit').confirmed, 0);
  assert.match(base.html, /Pipeline check: 0 traceable HubSpot leads/);
});

test('paid deals: Pipeline export (all pipelines counted, Sales shown), branded flag, deal drawer evidence', () => {
  const p = base.data.paidDeals;
  assert.equal(p.basis, 'Pipeline export');
  assert.equal(p.total, base.ex.paid.total);
  assert.equal(p.sales.length, base.ex.paid.sales);
  assert.equal(p.otherPipelines, 1);
  assert.deepEqual(p.byPlatform, { 'Google Ads': 1, 'LinkedIn Ads': 1 });
  assert.equal(p.branded, 1);
  assert.equal(p.companyLevel, 1);
  const cedar = lead(base, 'Cedar Harbor');
  assert.ok(cedar.evidence.some((e) => e.rule === 'Paid deal (Pipeline export)' && e.branded));
  const html = page.renderPage(base.view, { pd: 'Google Ads', deal: '7002' });
  assert.match(html.main, /Paid-attributed deals/);
  assert.match(html.drawer, /Google Ads <span class="tag">branded term<\/span>/);
});

test('paid deals without an export: the same rules on synced contact fields, with a company-level fallback', () => {
  const p = synced.data.paidDeals;
  assert.match(p.basis, /computed from synced HubSpot contact fields/);
  const by = Object.fromEntries(p.sales.map((d) => [d.id, d]));
  assert.equal(by['7001'].level, 'deal');
  assert.equal(by['7001'].branded, true);
  assert.equal(by['7007'].level, 'company');
  assert.equal(by['7007'].platform, 'OpenAI (ChatGPT) Ads');
  assert.equal(p.total, 5);
});

test('leads with the new sync tables: every form fill is a lead; each rule fires in order', () => {
  const by = (n) => lead(synced, n);
  assert.equal(by('Northstar Labs').rule, 'HubSpot form submission');
  assert.equal(by('Northstar Labs').subSource, 'Demo Request');
  const orchid = by('Orchid Retail');
  assert.equal(orchid.rule, 'HubSpot form submission', 'an "uncertain" form now counts like any form');
  assert.ok(orchid.evidence[0].detail.includes('was "uncertain" in the mapping'));
  assert.equal(by('Cedar Harbor').rule, 'Event list upload');
  assert.equal(by('Cedar Harbor').subSource, 'Synthetic East 2026', 'list 692 is excluded by scope; 884 counts');
  assert.equal(by('Pine Robotics').rule, 'paid_touch_campaign');
  assert.equal(by('Pine Robotics').platform, 'OpenAI (ChatGPT) Ads');
  assert.equal(by('Willow Health').source, 'Outbound');
  assert.equal(by('Willow Health').subSource, 'Job changer');
  assert.equal(by('Willow Health').tag, 'job_changer');
  assert.ok(!synced.data.flags.some((f) => f.key === 'not-synced'));
  assert.ok(!/mapping unconfirmed/.test(synced.html));
});

test('lead → MQL (90 days, proposed): hidden without its inputs, computed with them', () => {
  assert.equal(base.data.mqlFunnel.available, false);
  assert.equal(fig(base.html, 'lead-mql-90'), null);
  const main = page.renderPage(base.view, {}).main;
  assert.ok(!/Lead → MQL/.test(main) && !base.html.includes(RULES.mql.label), 'no tile, no column, no placeholder');
  // With its inputs it is computed (ben booked via the book-a-demo page; ana and gus filled lead forms) but stays
  // hidden while config/lead-rules.json says show: false (MQL-VALIDATION.md); the figures stay in the file.
  const f = synced.data.mqlFunnel;
  assert.equal(RULES.mql.show, false);
  assert.deepEqual([f.available, f.reason, f.computed.numerator, f.computed.denominator, f.computed.bookersWithoutForm], [false, RULES.mql.hiddenBecause, 1, 3, 1]);
  assert.equal(fig(synced.html, 'lead-mql-90'), null);
  assert.ok(!synced.html.includes(RULES.mql.label), 'hidden entirely');
  // Shown (show: true): the tile, with its numerator and denominator.
  const shown = buildView({ ...synced.data, mqlFunnel: { available: true, ...f.computed, label: RULES.mql.label } }, null);
  const leads = page.renderPage(shown, {}).main;
  assert.match(leads, /data-fig="lead-mql-90"><div class="tile-l">Lead → MQL \(book-a-demo\), 90 days \(proposed\)<\/div><div class="tile-v num">33\.3%/);
  assert.match(leads, /1<\/span> booked via book-a-demo ÷ <span class="num">3<\/span> lead-form fillers and bookers/);
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

test('outbound: every campaign counts in the reply rate; tags filter; opens/meetings not tracked', () => {
  const o = base.data.outbound;
  assert.equal(o.count, base.ex.outbound.count);
  assert.equal(o.sends, base.ex.outbound.sends);
  assert.equal(o.replies, base.ex.outbound.replies);
  assert.equal(fig(base.html, 'reply-rate'), '19.9%');
  const by = Object.fromEntries(o.campaigns.map((c) => [c.name, c]));
  assert.deepEqual(by['Customer company -> New Company'].tags, ['job_changer', 'sales']);
  assert.deepEqual(by['Customer company -> New Company (Bad ICP)'].flags, ['Bad ICP']);
  assert.ok(by['Synthetic Event Outreach'].mostlyInvite);
  assert.match(base.html, /not tracked/);
  const filtered = page.renderPage(base.view, { ot: 'job_changer' }).main;
  assert.match(filtered, /Tagged Job changer<\/td>(<td[^>]*><\/td>){2}<td class="num">41<\/td><td class="num">8<\/td>/);
  assert.equal(synced.data.outbound.campaigns.find((c) => c.name === 'Synthetic Outbound A').autoReplies, 1, 'auto-replies are flagged per campaign');
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
  assert.ok(ids.includes('8008'), 'before the first win: prospect');
  assert.ok(!ids.includes('8009'), 'after the first win: customer');
  assert.ok(!ids.includes('8004'), 'CS owners are out');
  assert.ok(!ids.includes('8012'), 'an unlinked meeting naming a customer company is out');
  assert.ok(!ids.includes('8016'), 'a meeting tied to a Renewal deal is out');
  assert.equal(M.items.find((m) => m.id === '8010').reason, 'no Sales Pipeline deal at the linked company');
  assert.equal(M.items.find((m) => m.id === '8001').recordingId, 'R1001', 'the Fathom summary is linked');
});

test("calls: Strategy's per-call classification decides; only prospect calls count", () => {
  const C = base.data.calls;
  const ex = base.ex.calls.strategy;
  assert.equal(C.classification, 'strategy');
  for (const k of ['total', 'prospect', 'customer', 'internal', 'partner_other']) assert.equal(C.scope[k], ex[k], k);
  assert.deepEqual(C.items.map((c) => c.id).sort(), ['R1001', 'R1004', 'R1007']);
  assert.equal(C.items.find((c) => c.id === 'R1007').recorder, 'Unassigned');
  const r1 = C.items.find((c) => c.id === 'R1001');
  assert.equal(r1.strategy.deal.id, '7001');
  assert.deepEqual(r1.strategy.competitors, ['Zip']);
  assert.match(base.html, /3<\/span> prospect, 3 customer, 1 internal, 1 partner\/other/);
  assert.match(page.renderPage(base.view, { call: 'R1001' }).drawer, /price budget/);
  assert.ok(!/call classification unavailable/.test(page.renderPage(base.view, {}).main));
});

test('calls without the classification file: the built-in rule, labelled "call classification unavailable"', () => {
  const C = synced.data.calls;
  assert.equal(C.classification, 'fallback');
  for (const k of ['total', 'internal', 'cs', 'customer', 'prospect']) assert.equal(C.scope[k], base.ex.callsFallback[k], k);
  assert.match(synced.html, /call classification unavailable/);
  assert.ok(synced.data.flags.some((f) => f.key === 'calls'));
  const r = run({ files: false, env: { CALL_CLASSIFICATION: '/nonexistent/records.jsonl' } });
  try {
    assert.equal(r.data.calls.classification, 'fallback');
    assert.match(r.data.calls.classificationNote, /records\.jsonl not found/);
  } finally { r.cleanup(); }
});

test('hidden owner: "Unassigned" everywhere, and nowhere in the HTML or JSON', () => {
  const pat = SYNTHETIC_SCRUB;
  for (const r of [base, synced]) {
    assert.ok(!r.json.toLowerCase().includes(pat), 'workspace.json');
    assert.ok(!r.html.toLowerCase().includes(pat), 'index.html');
  }
  const { data } = base;
  assert.equal(data.deals.find((d) => d.id === '7011').owner, 'Unassigned');
  assert.equal(lead(base, 'Maple Analytics').owner, 'Unassigned');
  assert.equal(data.meetings.items.find((m) => m.id === '8003').owner, 'Unassigned');
  assert.match(data.meetings.items.find((m) => m.id === '8001').title, /with Unassigned$/);
  assert.equal(data.insights.insights[0].owner, 'Unassigned / Alex Morgan');
  assert.equal(lead(base, 'Elm Partners').owner, 'Unassigned', '"not assigned" in the Sheet');
  assert.throws(() => assertScrubbed('owner: ' + pat.toUpperCase(), 'test'), /scrub check failed/);
});

test('the build refuses data that still carries the hidden owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-scrub-'));
  try {
    const d = structuredClone(base.data);
    d.deals[0].owner = SYNTHETIC_SCRUB + ' K';
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
  assert.ok(!/<h2[^>]*>This week/i.test(html));
  assert.ok(!/HubSpot bridge|Sheet-active/i.test(html));
  assert.ok(!/records\.json(?!l)|recordsOpenCount|unmatchedRecordings/.test(html));
});

test('scope footer: what the redesign removes from the current page', () => {
  const cp = base.data.scope.currentPage;
  assert.deepEqual({ companies: cp.companies, meetings: cp.meetings, recordings: cp.recordings, recordingsTotal: cp.recordingsTotal }, base.ex.currentPage);
  assert.match(base.html, /removes 3 customer companies, their 6 meetings and 3 of 5 recordings/);
});

test('drill-down: source row -> lead list -> lead drawer, meetings -> list -> drawer, from the hash', () => {
  const v = base.view;
  const orchid = v.leads.items.find((l) => l.company === 'Orchid Retail');
  const out = page.renderPage(v, page.parseState(`#src=Paid&lp=all&lead=${orchid.id}`));
  assert.match(out.main, /aria-expanded="true"/);
  assert.match(out.main, /Search leads/);
  assert.match(out.drawer, /role="dialog"/);
  assert.match(out.drawer, /Rule that fired/);
  assert.match(out.drawer, /from HubSpot \(primary\)/);
  assert.match(out.drawer, /differs: on the review list/);
  const north = v.leads.items.find((l) => l.company === 'Northstar Labs');
  const nd = page.renderPage(v, { lead: north.id }).drawer;
  assert.match(nd, /Send the pilot plan/, 'lead-insights.json by HubSpot contact id');
  assert.ok(!/fathom\.video/.test(nd), 'URL fragments in the insight are dropped');
  assert.match(nd, /app\.hubspot\.com\/contacts\/12345\/record\/0-2\/9001/, 'company link');
  assert.match(nd, /data-set="deal=7011"/, 'deal -> deal drawer');
  assert.match(nd, /Paid deal \(Pipeline export\)<\/b> <span class="muted small">\(evidence only\)/);
  assert.match(page.renderPage(v, { deal: '7011' }).drawer, /app\.hubspot\.com\/contacts\/12345\/record\/0-3\/7011/, 'deal link');
  const m = page.renderPage(v, page.parseState('#mo=*&mb=unmatched&mp=month&mtg=8001'));
  assert.match(m.main, /aria-pressed="true">Unmatched/);
  assert.match(m.drawer, /approvals are slow/, 'Fathom summary in the meeting drawer');
  assert.match(page.renderPage(v, { deal: '7008' }).drawer, /Went dark/);
  assert.deepEqual(page.applyChange({ lead: 'L4', src: 'Paid' }, 'mtg=8001'), { src: 'Paid', mtg: '8001' });
  assert.deepEqual(page.applyChange({ src: 'Paid' }, 'src=Paid', true), {});
  assert.equal(page.stateHash({ src: 'Paid', lead: 'L4' }), '#lead=L4&src=Paid');
});

test('the page is self-contained, labels times PT and works on mobile', () => {
  const { html } = base;
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<script src=|<link [^>]*href=/.test(html), 'no external scripts or styles');
  assert.match(html, /Updated [A-Z][a-z]{2} \d+, \d+:\d\d [AP]M PT/);
  assert.equal(base.data.meta.asOf, '2026-10-13T16:00:00Z');
  assert.match(html, /@media \(max-width: 640px\)/);
  assert.match(html, /\.drawer \{ width: 100%/);
  assert.match(html, /provisional \(awaiting Reviewer\)/, 'who from needs_<who> in lead-sources.json');
});

test('buildView: an invalid lost-reasons file is ignored and every deal auto-mapped', () => {
  const d = structuredClone(base.data);
  d.closed.reasonsDoc = { deals: 'nope' };
  const v = buildView(d);
  assert.match(v.closed.reasons.basis, /did not pass validation/);
  assert.equal(v.closed.reasons.fromFile, 0);
});

test('scrub patterns: from the env or --inputs-dir/scrub-patterns.txt; without any the data step refuses', () => {
  const r = run({ env: { WORKSPACE_SCRUB_PATTERNS: '' }, patternsFile: true });
  try {
    assert.ok(!r.json.toLowerCase().includes(SYNTHETIC_SCRUB));
    assert.equal(r.data.deals.find((d) => d.id === '7011').owner, 'Unassigned');
  } finally { r.cleanup(); }
  assert.throws(() => run({ env: { WORKSPACE_SCRUB_PATTERNS: '' } }), (e) => /no scrub patterns/.test(String(e.stderr)));
  // The build refuses too, without patterns.
  const saved = process.env.WORKSPACE_SCRUB_PATTERNS;
  process.env.WORKSPACE_SCRUB_PATTERNS = '';
  try {
    assert.throws(() => build({ data: join(base.dir, 'workspace.json'), out: join(base.dir, 'out2'), quiet: true }), /no scrub patterns/);
  } finally { process.env.WORKSPACE_SCRUB_PATTERNS = saved; }
});

test('inputs degrade one by one and are listed in meta.inputs', () => {
  assert.deepEqual(base.data.meta.inputs, { 'lead-sources.json': true, 'lost-reasons.json': true, 'insights.json': true, 'lead-insights.json': true,
    'records.jsonl': true, 'lead-source-review.csv': true, 'paid-deals.json': true, 'source-overrides.json': false });
  const s = synced.data.meta.inputs;
  assert.deepEqual([s['records.jsonl'], s['lead-source-review.csv'], s['paid-deals.json']], [false, false, false]);
  assert.equal(synced.data.calls.classification, 'fallback');
  assert.equal(synced.data.reviewList, null);
  assert.match(synced.data.paidDeals.basis, /computed/);
});
