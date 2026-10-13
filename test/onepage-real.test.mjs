// Optional real-data run: the whole pipeline against the real brain.db and the
// Strategy / Pipeline files, asserting the audited figures. Skipped when the files
// are absent (CI, other machines). Output goes to a temp dir, never the repo.
// Paths: BRAIN_DB, GTM_INSIGHTS_DIR, GTM_PRIOR_EXPORT, GTM_CURRENT_PAGE, GTM_REFRESH_JSON,
// CALL_CLASSIFICATION, LEAD_SOURCE_REVIEW, PAID_EXPORT, GTM_LEMLIST_SNAPSHOT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from '../onepage/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = (k, d) => process.env[k] || d;
const DB = env('BRAIN_DB', '/workspace/numaudit/brain.db');
const INS = env('GTM_INSIGHTS_DIR', '/workspace/gtm-insights');
const PRIOR = env('GTM_PRIOR_EXPORT', '/workspace/gtm-data/live_deals.json');
const PAGE = env('GTM_CURRENT_PAGE', '/workspace/numaudit/data.json');
const REFRESH = env('GTM_REFRESH_JSON', '/workspace/numaudit/refresh.json');
const CALLS = env('CALL_CLASSIFICATION', '/workspace/gtm-redesign/records.jsonl');
const REVIEW = env('LEAD_SOURCE_REVIEW', join(INS, 'lead-source-review.csv'));
const PAID = env('PAID_EXPORT', join(homedir(), 'opstream-employee/work/pipeline-recon-20261012/live_deals.json'));
const LEMLIST_SNAPSHOT = env('GTM_LEMLIST_SNAPSHOT', '/workspace/gtm-data/marketing.json');
const present = [DB, join(INS, 'lead-sources.json'), CALLS, REVIEW, PAID].every(existsSync);
const SCOPE = JSON.parse(readFileSync(join(ROOT, 'shared', 'workspace-scope.json'), 'utf8'));
const RULES = JSON.parse(readFileSync(join(ROOT, 'config', 'lead-rules.json'), 'utf8'));

// The audit's figures (Oct 13). The headline may move with HubSpot; it is asserted
// against an independent computation and compared to these.
const AUDIT = {
  open: [40, 5955000, 885750], onHold: [28, 1586000], change: [37, 5655000, 40, 5955000],
  closedLost: 302, disqualified: 69, lostReasons: 369, leads: 498, sheetMql: [65, 498], openaiTracker: [2, 9],
  meetings: [13, 9], currentPage: [26, 2063, 74, 103], calls: { prospect: 1078, customer: 1007, internal: 149, partner_other: 2 },
  paidDeals: 30, reviewRows: 25, leadInsights: 745,
};

const py = (code) => JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }));

test('real data: audited figures end to end', { skip: !present && `real inputs not present (${DB})` }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asOf = existsSync(REFRESH) ? JSON.parse(readFileSync(REFRESH, 'utf8')).refreshedAt : new Date().toISOString();
  const opt = (flag, p) => (existsSync(p) ? [flag, p] : []);
  execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', DB, '--lead-sources', join(INS, 'lead-sources.json'),
    ...opt('--lost-reasons', join(INS, 'lost-reasons.json')), ...opt('--insights', join(INS, 'insights.json')),
    ...opt('--lead-insights', join(INS, 'lead-insights.json')), ...opt('--prior', PRIOR), ...opt('--current-page', PAGE),
    '--call-classification', CALLS, '--review-list', REVIEW, '--paid-export', PAID, '--as-of', asOf, '--out', join(dir, 'workspace.json'), '--quiet']);
  const { view, html } = build({ data: join(dir, 'workspace.json'), out: join(dir, 'out'), quiet: true });
  const d = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'));
  const report = [];
  const check = (name, got, want) => {
    const ok = String(got) === String(want);
    report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : ' (expected ' + want + ')'}`);
    assert.equal(String(got), String(want), name);
  };

  // Headline: an independent SQL computation from the HubSpot rows must equal the page.
  const indep = py(`
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
camps = [json.loads(r).get('stats') or {} for (r,) in c.execute('select raw_json from lemlist_campaigns')]
print(json.dumps({'open': [o[0], round(o[1]), round(o[2])], 'onHold': [h[0], round(h[1])],
                  'lemlist': [len(camps), sum(s.get('replied') or 0 for s in camps), sum(s.get('messagesSent') or 0 for s in camps)]}))`);
  const open = [d.headline.open.count, Math.round(d.headline.open.amount), Math.round(d.headline.open.weighted)];
  assert.deepEqual(open, indep.open, 'headline equals the HubSpot computation');
  assert.deepEqual([d.headline.onHold.count, Math.round(d.headline.onHold.amount)], indep.onHold);
  const moved = JSON.stringify(indep.open) !== JSON.stringify(AUDIT.open);
  console.log(`headline computed from HubSpot: ${indep.open[0]} open / $${indep.open[1].toLocaleString('en-US')} / $${indep.open[2].toLocaleString('en-US')} weighted; On Hold ${indep.onHold[0]} / $${indep.onHold[1].toLocaleString('en-US')}${moved ? ' (HubSpot moved since the audit)' : ''}`);
  if (!moved) {
    check('open deals / amount / weighted', open.join(' / '), AUDIT.open.join(' / '));
    check('On Hold', `${indep.onHold[0]} / ${indep.onHold[1]}`, AUDIT.onHold.join(' / '));
    const c = d.headline.change;
    check('what changed', `${c.from.count} / ${c.from.amount} -> ${c.to.count} / ${c.to.amount}`, `${AUDIT.change[0]} / ${AUDIT.change[1]} -> ${AUDIT.change[2]} / ${AUDIT.change[3]}`);
  }
  const by = Object.fromEntries(d.closed.lostByStage.map((x) => [x.stage, x.count]));
  check('Closed lost / Disqualified', `${by['Closed lost']} / ${by.Disqualified}`, `${AUDIT.closedLost} / ${AUDIT.disqualified}`);
  check('lost reasons (new-business deals)', `${view.closed.reasons.count} (from file ${view.closed.reasons.fromFile})`, `${AUDIT.lostReasons} (from file ${AUDIT.lostReasons})`);

  // Calls: Strategy's classification, exactly.
  const sc = d.calls.scope;
  check('calls prospect / customer / internal / partner', `${sc.prospect} / ${sc.customer} / ${sc.internal} / ${sc.partner_other}`,
    `${AUDIT.calls.prospect} / ${AUDIT.calls.customer} / ${AUDIT.calls.internal} / ${AUDIT.calls.partner_other}`);
  assert.equal(d.calls.classification, 'strategy');
  assert.ok(d.calls.items.length > 0 && d.calls.items.every((c) => c.strategy), 'listed calls are prospect calls from the classification');

  // Leads.
  check('leads', d.leads.total, AUDIT.leads);
  check('old lead -> MQL (per company, Sheet, SQL counts as MQL)', `${d.leads.mql}/${d.leads.total} = ${(100 * d.leads.mql / d.leads.total).toFixed(1)}%`, `${AUDIT.sheetMql[0]}/${AUDIT.sheetMql[1]} = 13.1%`);
  check('new lead -> MQL (r12, 90 days proposed)', d.mqlFunnel.available ? 'shown' : 'hidden', 'hidden');
  assert.ok(!html.includes(RULES.mql.label), 'hidden entirely: no tile, no placeholder');
  check('OpenAI leads, Lead Tracker notes: named / at most', `${d.leads.openai.trackerNamed} / ${d.leads.openai.trackerAtMost}`, AUDIT.openaiTracker.join(' / '));
  console.log(`OpenAI leads with HubSpot evidence: ${d.leads.openai.confirmed} named, at most ${d.leads.openai.atMost}`);
  check('review list rows', d.reviewList.rows.length, AUDIT.reviewRows);
  assert.ok(d.leads.items.filter((l) => l.review).length >= AUDIT.reviewRows, 'every review row is on a lead');
  check('lead-insights contacts loaded', d.meta.leadInsights, AUDIT.leadInsights);
  check('paid deals (Pipeline export, all pipelines)', d.paidDeals.total, AUDIT.paidDeals);
  console.log(`paid deals in the Sales Pipeline: ${d.paidDeals.sales.length} ${JSON.stringify(d.paidDeals.byPlatform)}; ${d.paidDeals.branded} branded; ${d.paidDeals.companyLevel} company-level`);

  // Outbound reply rate (r12): every campaign, any status. Asserted against brain.db's own sums.
  const o = d.outbound;
  check('outbound reply rate (all campaigns, brain.db)', `${o.replies}/${o.sends} over ${o.count}`, `${indep.lemlist[1]}/${indep.lemlist[2]} over ${indep.lemlist[0]}`);
  assert.equal(o.count, 23);
  // Strategy's 89/4,738 comes from the 3:31 AM snapshot without the two job-changer campaigns.
  if (existsSync(LEMLIST_SNAPSHOT)) {
    const cs = JSON.parse(readFileSync(LEMLIST_SNAPSHOT, 'utf8')).outbound.campaignStats;
    const sum = (xs, k) => xs.reduce((a, c) => a + (c[k] || 0), 0);
    const jc = cs.filter((c) => /^Customer company -> New Company/.test(c.name));
    console.log(`Lemlist 3:31 AM snapshot: all ${cs.length} campaigns ${sum(cs, 'replied')}/${sum(cs, 'sent')}; without the ${jc.length} 'Customer company -> New Company' campaigns ${sum(cs, 'replied') - sum(jc, 'replied')}/${sum(cs, 'sent') - sum(jc, 'sent')}`);
    assert.equal(`${sum(cs, 'replied') - sum(jc, 'replied')}/${sum(cs, 'sent') - sum(jc, 'sent')}`, '89/4738', "Strategy's 89/4,738 reconciles to the snapshot minus the job-changer campaigns");
  }

  check('meetings this month / upcoming (matched)', `${d.meetings.thisMonth.matched} / ${d.meetings.upcoming.matched}`, AUDIT.meetings.join(' / '));
  const cp = d.scope.currentPage;
  if (cp) check('removed from the current page', `${cp.companies} / ${cp.meetings} / ${cp.recordings} of ${cp.recordingsTotal}`, `${AUDIT.currentPage[0]} / ${AUDIT.currentPage[1]} / ${AUDIT.currentPage[2]} of ${AUDIT.currentPage[3]}`);
  const oa = d.ads.find((a) => a.key === 'openai');
  check('OpenAI platform conversions / events / checklist page / spend days', `${oa.conversions} / ${oa.events.length} / ${oa.landingPages[0].conversions} / ${oa.spendDays}`, '46 / 6 / 45 / 39');
  const rd = d.ads.find((a) => a.key === 'reddit');
  check('Reddit spend / traceable leads', `${rd.spend} / ${d.leads.platforms.find((p) => p.key === 'reddit').confirmed}`, '5151.27 / 0');
  const flags = d.flags.map((f) => f.label).join(' | ');
  for (const re of [/Reddit Ads data ends Sep 28/, /Otterly down/, /Spend actuals missing Aug–Oct/, /GA4 channels: \d+% Unassigned/]) assert.match(flags, re);
  assert.match(html, /provisional \(awaiting \w+\)/);
  const pat = SCOPE.hiddenOwner.pattern;
  assert.ok(!html.toLowerCase().includes(pat) && !JSON.stringify(d).toLowerCase().includes(pat), 'hidden owner scrubbed');
  assert.ok(!/HubSpot bridge|Sheet-active|recordsOpenCount|recordsDealCount|unmatchedRecordings|<h2[^>]*>This week/i.test(html), 'bridge, records counts and the This week section are dropped');
  console.log(report.join('\n'));
});
