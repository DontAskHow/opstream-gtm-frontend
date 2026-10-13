// The Oct 13 2026 reporting rules in workspace.json, end to end on synthetic data: scripts/synthetic-data.cjs
// (brainFixture, synced) -> scripts/fixture-db.py -> scripts/workspace-data.py -> onepage/build.mjs.
// Blended stage probability and, per ad platform, HubSpot-sourced leads apart from the platform's own conversions.
// The fields are additions only: the page renders exactly as it does without them. No real data is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build, buildView } from '../onepage/build.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { brainFixture, SYNTHETIC_SCRUB } = require('../scripts/synthetic-data.cjs');
const page = require('../onepage/page.cjs');
const RULES = JSON.parse(readFileSync(join(ROOT, 'config', 'lead-rules.json'), 'utf8')).reporting;
process.env.WORKSPACE_SCRUB_PATTERNS = SYNTHETIC_SCRUB;
delete process.env.WORKSPACE_SCRUB_PATTERNS_FILE;

function run(edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-rules-'));
  const fx = brainFixture({ synced: true });
  edit(fx);
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fx));
  execFileSync('python3', [join(ROOT, 'scripts', 'fixture-db.py'), join(dir, 'fixture.json'), join(dir, 'brain.db')]);
  mkdirSync(join(dir, 'inputs'));
  writeFileSync(join(dir, 'inputs', 'lead-sources.json'), JSON.stringify(fx.inputs.leadSources));
  execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', join(dir, 'brain.db'), '--inputs-dir', join(dir, 'inputs'),
    '--as-of', fx.expect.asOf, '--out', join(dir, 'workspace.json'), '--quiet'],
  { env: { ...process.env, CALL_CLASSIFICATION: '', LEAD_SOURCE_REVIEW: '', PAID_EXPORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const { html } = build({ data: join(dir, 'workspace.json'), out: join(dir, 'out'), quiet: true });
  const data = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return { data, html };
}

// workspace.json without the fields the reporting rules add: what the page had before them.
function withoutAdded(data) {
  const d = structuredClone(data);
  for (const k of ['forms', 'adLeads']) delete d[k];
  delete d.meetings.bookings;
  delete d.scope.reporting;
  delete d.rules.reportingApprovedAt;
  delete d.meta.reportingContactFields;
  if (d.mqlFunnel.computed) delete d.mqlFunnel.computed.afterReportingRules;
  delete d.mqlFunnel.afterReportingRules;
  for (const a of d.ads) for (const k of ['hubspotLeads', 'aiReferral', 'figureLabel']) delete a[k];
  for (const x of d.headline.stages) for (const k of ['blendedProbability', 'probabilityMixed']) delete x[k];
  return d;
}
const render = (data) => page.renderPage(buildView(data, null), {});

test('blended stage probability: weighted ÷ amount, mixed when deal probabilities differ from the stage default; page unchanged', () => {
  // Cedar expansion (Demo meeting, stage default 25 %) at 40 %: the stage blends to 40 %.
  const { data, html } = run((fx) => {
    const row = fx.tables.hubspot_objects.rows.find((r) => r[0] === 'deals' && r[1] === '7002');
    row[2] = { ...row[2], hs_deal_stage_probability: '0.4' };
  });
  const st = Object.fromEntries(data.headline.stages.map((s) => [s.label, s]));
  const demo = st['Demo meeting'];
  assert.deepEqual([demo.amount, demo.weighted, demo.probability, demo.probabilityMixed], [200000, 80000, 0.25, true]);
  assert.equal(demo.blendedProbability, 0.4);
  // SQL: every deal at the stage default; no tooltip.
  assert.deepEqual([st.SQL.blendedProbability, st.SQL.probabilityMixed], [0.05, false]);
  // A stage with no amount: no blend.
  assert.equal(st.Decision.blendedProbability, null);
  // The page is unchanged: it still shows the stage default, and renders as it does without the new fields.
  assert.ok(!html.includes('blended; stage default'));
  assert.deepEqual(render(data), render(withoutAdded(data)));
});

test('ad platforms: HubSpot-sourced leads per platform; OpenAI "All Conversions" stays a platform-reported event, never a lead; page unchanged', () => {
  const { data, html } = run((fx) => {
    // ana clicked a ChatGPT ad (first URL utm cpc); hal arrived from a ChatGPT referral (organic) and booked.
    const set = (id, props) => { const r = fx.tables.hubspot_objects.rows.find((x) => x[0] === 'contacts' && x[1] === id); r[2] = { ...r[2], ...props }; };
    set('5001', { hs_analytics_first_url: 'https://www.example.com/?utm_source=chatgpt&utm_medium=cpc', utm_source: null, utm_medium: null });
    set('5008', { hs_analytics_source: 'AI_REFERRALS', hs_analytics_first_referrer: 'https://chatgpt.com/' });
    fx.tables.hubspot_objects.rows.push(['meetings', '8101', { hs_object_id: '8101', hs_meeting_title: 'Hal booking', hs_meeting_source: RULES.meetings.sourceValue,
      hs_createdate: '2026-09-01T15:00:00Z', hs_meeting_start_time: '2026-09-02T15:00:00Z', hubspot_owner_id: '101' }, fx.expect.asOf]);
    fx.tables.hubspot_associations.rows.push(['meetings', '8101', 'contacts', '5008'], ['contacts', '5008', 'meetings', '8101']);
  });
  const openai = data.ads.find((a) => a.key === 'openai');
  // The OpenAI report's account-wide conversions (7, "All Conversions") are events; HubSpot has one OpenAI lead.
  assert.equal(openai.conversions, 7);
  assert.equal(openai.conversionType, 'All Conversions');
  assert.equal(openai.figureLabel, RULES.adLeads.platformFigureLabel);
  assert.deepEqual([openai.hubspotLeads.leads, openai.aiReferral.leads], [1, 1]);
  const ai = data.adLeads.aiReferral;
  assert.deepEqual([ai.name, ai.ids], [RULES.adLeads.aiReferral.label, ['5008']]);
  // Paid PAID_SEARCH contact (fay) with no first-touch platform: not credited to OpenAI from a paid_touch_campaign name.
  assert.equal(data.adLeads.unnamed.leads + (data.adLeads.unnamed.excluded.customer || 0) + (data.adLeads.unnamed.excluded.noConversion || 0), data.adLeads.unnamed.contacts);
  // The page is unchanged: no HubSpot-lead line, and it renders as it does without the new fields.
  assert.ok(!html.includes('HubSpot leads:'));
  assert.deepEqual(render(data), render(withoutAdded(data)));
  // Lead counts are untouched by the platform's conversions: the Leads tile counts Lead Tracker companies only.
  assert.equal(data.leads.total, 10);
});
