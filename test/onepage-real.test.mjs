// Optional real-data run: the whole pipeline against the real brain.db and the
// Strategy/Pipeline files, asserting the audited figures. Skipped when the files
// are absent (CI, other machines). Output goes to a temp dir, never the repo.
// Paths: BRAIN_DB, GTM_INSIGHTS_DIR, GTM_PRIOR_EXPORT, GTM_CURRENT_PAGE, GTM_REFRESH_JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from '../onepage/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.BRAIN_DB || '/workspace/numaudit/brain.db';
const INS = process.env.GTM_INSIGHTS_DIR || '/workspace/gtm-insights';
const PRIOR = process.env.GTM_PRIOR_EXPORT || '/workspace/gtm-data/live_deals.json';
const PAGE = process.env.GTM_CURRENT_PAGE || '/workspace/numaudit/data.json';
const REFRESH = process.env.GTM_REFRESH_JSON || '/workspace/numaudit/refresh.json';
const present = [DB, join(INS, 'lead-sources.json')].every(existsSync);
const SCOPE = JSON.parse(readFileSync(join(ROOT, 'shared', 'workspace-scope.json'), 'utf8'));

// The audit's figures (Oct 13). The headline may move with HubSpot; it
// is asserted against an independent computation and compared to these.
const AUDIT = {
  open: [40, 5955000, 885750], onHold: [28, 1586000], change: [37, 5655000, 40, 5955000],
  closedLost: 302, disqualified: 69, leads: 498, mql: 65, rate: '13.1%', openai: [2, 9],
  meetings: [13, 9], currentPage: [26, 2063, 74, 103],
};

test('real data: audited figures end to end', { skip: !present && `real inputs not present (${DB})` }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asOf = existsSync(REFRESH) ? JSON.parse(readFileSync(REFRESH, 'utf8')).refreshedAt : new Date().toISOString();
  const opt = (flag, p) => (existsSync(p) ? [flag, p] : []);
  execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', DB, '--lead-sources', join(INS, 'lead-sources.json'),
    ...opt('--lost-reasons', join(INS, 'lost-reasons.json')), ...opt('--insights', join(INS, 'insights.json')),
    ...opt('--lead-insights', join(INS, 'lead-insights.json')), ...opt('--prior', PRIOR), ...opt('--current-page', PAGE),
    '--as-of', asOf, '--out', join(dir, 'workspace.json'), '--quiet']);
  const { view, html } = build({ data: join(dir, 'workspace.json'), out: join(dir, 'out'), quiet: true });
  const d = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'));
  const report = [];
  const check = (name, got, want) => { report.push(`${String(got) === String(want) ? 'PASS' : 'FAIL'}  ${name}: ${got}${String(got) === String(want) ? '' : ' (audit ' + want + ')'}`); assert.equal(String(got), String(want), name); };

  // Headline: an independent SQL computation from the HubSpot rows must equal the page.
  const indep = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3, json
c = sqlite3.connect('file:${DB}?mode=ro', uri=True)
st = {(p, s): (l, cl) for p, s, l, cl in c.execute('select pipeline_id, stage_id, stage_label, is_closed from hubspot_pipelines')}
o = [0, 0.0, 0.0]; h = [0, 0.0]
for (pj,) in c.execute("select properties_json from hubspot_objects where object_type='deals'"):
    p = json.loads(pj)
    if p.get('pipeline') != 'default': continue
    l, cl = st[('default', p['dealstage'])]
    if cl: continue
    a = float(p.get('amount') or 0)
    if l == 'On Hold': h[0] += 1; h[1] += a; continue
    o[0] += 1; o[1] += a; o[2] += a * float(p.get('hs_deal_stage_probability') or 0)
print(json.dumps({'open': [o[0], round(o[1]), round(o[2])], 'onHold': [h[0], round(h[1])]}))`], { encoding: 'utf8' }));
  const open = [d.headline.open.count, Math.round(d.headline.open.amount), Math.round(d.headline.open.weighted)];
  assert.deepEqual(open, indep.open, 'headline equals the HubSpot computation');
  assert.deepEqual([d.headline.onHold.count, Math.round(d.headline.onHold.amount)], indep.onHold);
  const moved = JSON.stringify(indep.open) !== JSON.stringify(AUDIT.open);
  console.log(`headline computed from HubSpot: ${indep.open[0]} open / $${indep.open[1].toLocaleString('en-US')} / $${indep.open[2].toLocaleString('en-US')} weighted; On Hold ${indep.onHold[0]} / $${indep.onHold[1].toLocaleString('en-US')}${moved ? ' (HubSpot moved since the audit)' : ''}`);
  if (!moved) {
    check('open deals', open[0], AUDIT.open[0]);
    check('open amount', open[1], AUDIT.open[1]);
    check('weighted', open[2], AUDIT.open[2]);
    check('On Hold', `${indep.onHold[0]} / ${indep.onHold[1]}`, AUDIT.onHold.join(' / '));
    const c = d.headline.change;
    check('what changed', `${c.from.count} / ${c.from.amount} -> ${c.to.count} / ${c.to.amount}`, `${AUDIT.change[0]} / ${AUDIT.change[1]} -> ${AUDIT.change[2]} / ${AUDIT.change[3]}`);
    assert.ok(c.deals.filter((x) => x.kind === 'new').length === 3, 'three new deals');
  }
  const by = Object.fromEntries(d.closed.lostByStage.map((x) => [x.stage, x.count]));
  check('Closed lost', by['Closed lost'], AUDIT.closedLost);
  check('Disqualified', by.Disqualified, AUDIT.disqualified);
  assert.equal(view.closed.reasons.count, AUDIT.closedLost + AUDIT.disqualified);
  check('leads', d.leads.total, AUDIT.leads);
  check('MQL incl SQL', d.leads.mql, AUDIT.mql);
  check('lead -> MQL', (100 * d.leads.rate).toFixed(1) + '%', AUDIT.rate);
  check('OpenAI leads named / at most', `${d.leads.openai.confirmed} / ${d.leads.openai.atMost}`, AUDIT.openai.join(' / '));
  check('meetings this month / upcoming (matched)', `${d.meetings.thisMonth.matched} / ${d.meetings.upcoming.matched}`, AUDIT.meetings.join(' / '));
  const cp = d.scope.currentPage;
  if (cp) check('removed from the current page', `${cp.companies} / ${cp.meetings} / ${cp.recordings} of ${cp.recordingsTotal}`, `${AUDIT.currentPage[0]} / ${AUDIT.currentPage[1]} / ${AUDIT.currentPage[2]} of ${AUDIT.currentPage[3]}`);
  const oa = d.ads.find((a) => a.key === 'openai');
  check('OpenAI platform conversions / events / checklist page / spend days', `${oa.conversions} / ${oa.events.length} / ${oa.landingPages[0].conversions} / ${oa.spendDays}`, '46 / 6 / 45 / 39');
  const auto = d.outbound.campaigns.filter((c) => c.mostlyInvite);
  assert.ok(auto.length && auto.every((c) => c.replies < c.repliesReported), 'invite-step auto-replies are not counted');
  assert.match(html, /provisional \(awaiting \w+\)/);
  assert.ok(!d.outbound.campaigns.some((c) => c.kind === 'customer'), 'customer campaigns not in outbound performance');
  const flags = d.flags.map((f) => f.label).join(' | ');
  for (const re of [/Reddit Ads data ends Sep 28/, /Otterly down/, /Spend actuals missing Aug–Oct/, /GA4 channels: \d+% Unassigned/]) assert.match(flags, re);
  assert.match(html, /Otterly down · last good Oct 3/);
  const pat = SCOPE.hiddenOwner.pattern;
  assert.ok(!html.toLowerCase().includes(pat) && !JSON.stringify(d).toLowerCase().includes(pat), 'hidden owner scrubbed');
  assert.ok(!/HubSpot bridge|Sheet-active|recordsOpenCount|recordsDealCount|unmatchedRecordings|This week/i.test(html), 'bridge, records counts and This week are dropped');
  const csNames = new Set(SCOPE.csOwnerIds);
  assert.ok(d.meetings.items.length > 0 && csNames.size === 2);
  console.log(report.join('\n'));
});
