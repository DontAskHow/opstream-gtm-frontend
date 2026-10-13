// The Analysis file (insights.json): the validator the page and the publish
// script share, its agreement with docs/insights.schema.json, the
// publish-only-on-change rule, goal metrics and the matcher that links insight
// text to the page. Synthetic content only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkText, decide } from '../workspace/refresh/publish-insights.mjs';

const require = createRequire(import.meta.url);
const { validate, parse, flagText, METRICS, metricValues, commitStages, goalValue, goalProgress, mentions, refIndex, findRefs } = require('../workspace/src/insights.js');
const schema = JSON.parse(readFileSync(new URL('../docs/insights.schema.json', import.meta.url), 'utf8'));

const item = () => ({
  title: 'Example title', evidence: 'Figures from the example data.', citations: ['data.js headline.active'],
  why_it_matters: 'Because.', recommended_play: 'Do the thing.', owner: 'Avery Example', confidence: 'medium',
});
const good = () => ({
  generated_at: '2026-01-16T12:00:00-07:00', headline: 'One line.', insights: [item()],
  data_quality_flags: ['a flag', { deal: 'Example', missing: 'amount', count: 2 }], changed_since_last: 'First version.',
});
const errs = (doc) => validate(doc).errors.join('\n');

test('a well-formed file passes, with or without citations, string or array changes', () => {
  assert.deepEqual(validate(good()).errors, []);
  const d = good();
  delete d.insights[0].citations;
  d.changed_since_last = ['one', 'two'];
  d.data_quality_flags = [];
  d.generated_at = '2026-01-16T19:00:00Z';
  assert.equal(validate(d).ok, true);
});

test('each rule rejects', () => {
  const cases = [
    [(d) => delete d.headline, /headline/],
    [(d) => { d.generated_at = '2026-01-16T12:00:00'; }, /generated_at/],
    [(d) => { d.generated_at = '2026-01-16'; }, /generated_at/],
    [(d) => { d.insights = []; }, /insights: must be an array of 1–20/],
    [(d) => { d.insights = Array.from({ length: 21 }, item); }, /insights: must be an array/],
    [(d) => { d.insights[0].confidence = 'certain'; }, /confidence/],
    [(d) => { d.insights[0].owner = ''; }, /owner: must be a non-empty string/],
    [(d) => { d.insights[0].evidence = 'x'.repeat(2001); }, /evidence: longer than 2000/],
    [(d) => { d.insights[0].why_it_maters = 'typo'; }, /why_it_maters: unknown field/],
    [(d) => { d.extra = 1; }, /extra: unknown field/],
    [(d) => { d.data_quality_flags = [{ nested: { a: 1 } }]; }, /data_quality_flags\[0\]/],
    [(d) => { d.data_quality_flags = [7]; }, /data_quality_flags\[0\]/],
    [(d) => { d.changed_since_last = 3; }, /changed_since_last/],
    [(d) => { d.insights[0].citations = 'one'; }, /citations/],
  ];
  for (const [mutate, re] of cases) {
    const d = good();
    mutate(d);
    assert.match(errs(d), re);
  }
  assert.equal(parse('{not json').ok, false);
  assert.equal(parse('[]').ok, false);
  assert.equal(parse('x'.repeat(300000)).ok, false);
});

test('flags render as plain text', () => {
  assert.equal(flagText({ deal: 'Example', count: 2, ok: null }), 'deal: Example · count: 2 · ok: —');
  assert.equal(flagText('<b>not html</b>'), '<b>not html</b>');
});

test('the JSON schema mirrors the validator', () => {
  assert.deepEqual(schema.required.sort(), ['changed_since_last', 'data_quality_flags', 'generated_at', 'headline', 'insights']);
  assert.equal(schema.additionalProperties, false);
  const it = schema.properties.insights.items;
  assert.deepEqual(Object.keys(it.properties).sort(), Object.keys(item()).sort());
  assert.deepEqual(it.required.sort(), Object.keys(item()).filter((k) => k !== 'citations').sort());
  assert.deepEqual(it.properties.confidence.enum, ['low', 'medium', 'high']);
  const g = schema.properties.goals;
  assert.equal(g.maxItems, 12);
  assert.equal(g.items.additionalProperties, false);
  assert.deepEqual(Object.keys(g.items.properties).sort(), ['by', 'competitor', 'label', 'metric', 'note', 'target']);
  assert.deepEqual(g.items.required.sort(), ['label', 'metric', 'target']);
  assert.deepEqual(g.items.properties.metric.enum, Object.keys(METRICS));
  assert.equal(g.items.properties.label.maxLength, 200);
  assert.equal(g.items.properties.note.maxLength, 400);
  assert.equal(g.items.properties.competitor.maxLength, 100);
  // competitor: required with the competitor metric(s), rejected otherwise; percent targets ≤ 100.
  const [comp, pctRule] = g.items.allOf;
  assert.deepEqual([comp.if.properties.metric.const], Object.keys(METRICS).filter((k) => METRICS[k].competitor));
  assert.deepEqual(comp.then.required, ['competitor']);
  assert.deepEqual(comp.else.not.required, ['competitor']);
  assert.deepEqual(pctRule.if.properties.metric.enum, Object.keys(METRICS).filter((k) => METRICS[k].format === 'pct'));
  assert.equal(pctRule.then.properties.target.maximum, 100);
  assert.equal(schema.properties.insights.maxItems, 20);
  const re = new RegExp(schema.properties.generated_at.pattern);
  assert.ok(re.test(good().generated_at));
  assert.ok(!re.test('2026-01-16T12:00:00'));
});

test('publish uploads only when the content hash changed', () => {
  const text = JSON.stringify(good());
  const r = checkText(text);
  assert.equal(r.ok, true);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(decide(r.sha256, null), 'upload');
  assert.equal(decide(r.sha256, r.sha256), 'unchanged');
  assert.equal(decide(r.sha256, 'f'.repeat(64)), 'upload');
  assert.equal(checkText('{"headline":"x"}').ok, false);
});

const goal = (o = {}) => ({ metric: 'open_amount', target: 100000, label: 'Grow the open book', ...o });

test('goals are optional; well-formed goals pass', () => {
  const d = good();
  assert.equal('goals' in d, false);
  assert.equal(validate(d).ok, true);
  d.goals = [];
  assert.equal(validate(d).ok, true);
  d.goals = [goal(), goal({ metric: 'closed_lost_count', target: 0, by: '2026-12-31', note: 'Keep it low.' })];
  assert.deepEqual(validate(d).errors, []);
  // Every metric, the competitor one with its competitor; percent targets up to 100.
  const all = Object.keys(METRICS).map((metric) => goal({
    metric, ...(METRICS[metric].format === 'pct' ? { target: 40 } : {}), ...(METRICS[metric].competitor ? { competitor: 'Example Rival' } : {}),
  }));
  for (let i = 0; i < all.length; i += 12) {
    d.goals = all.slice(i, i + 12);
    assert.deepEqual(validate(d).errors, []);
  }
  d.goals = [goal({ metric: 'outbound_reply_rate', target: 100 }), goal({ metric: 'lead_to_mql_rate', target: 12.5 })];
  assert.deepEqual(validate(d).errors, []);
  d.goals = Array.from({ length: 12 }, () => goal());
  assert.equal(validate(d).ok, true);
});

test('each goal rule rejects', () => {
  const cases = [
    [(d) => { d.goals = goal(); }, /goals: must be an array of at most 12/],
    [(d) => { d.goals = Array.from({ length: 13 }, () => goal()); }, /goals: must be an array of at most 12/],
    [(d) => { d.goals = ['open_amount']; }, /goals\[0\]: must be an object/],
    [(d) => { d.goals = [goal({ metric: 'revenue' })]; }, /goals\[0\]\.metric: must be one of open_count/],
    [(d) => { d.goals = [goal({ metric: 'toString' })]; }, /goals\[0\]\.metric/],
    [(d) => { d.goals = [goal({ target: '100' })]; }, /goals\[0\]\.target/],
    [(d) => { d.goals = [goal({ target: -1 })]; }, /goals\[0\]\.target/],
    [(d) => { d.goals = [goal({ target: Infinity })]; }, /goals\[0\]\.target/],
    [(d) => { const g = goal(); delete g.target; d.goals = [g]; }, /goals\[0\]\.target/],
    [(d) => { d.goals = [goal({ label: '' })]; }, /goals\[0\]\.label: must be a non-empty string/],
    [(d) => { d.goals = [goal({ label: 'x'.repeat(201) })]; }, /goals\[0\]\.label: longer than 200/],
    [(d) => { d.goals = [goal({ note: 'x'.repeat(401) })]; }, /goals\[0\]\.note: longer than 400/],
    [(d) => { d.goals = [goal({ note: '' })]; }, /goals\[0\]\.note/],
    [(d) => { d.goals = [goal({ by: '2026-02-30' })]; }, /goals\[0\]\.by: must be a calendar date/],
    [(d) => { d.goals = [goal({ by: '2026-12-31T00:00:00Z' })]; }, /goals\[0\]\.by/],
    [(d) => { d.goals = [goal({ owner: 'someone' })]; }, /goals\[0\]\.owner: unknown field/],
    [(d) => { d.goals = [goal({ metric: 'closed_lost_to_competitor_count' })]; }, /goals\[0\]\.competitor: must be a non-empty string/],
    [(d) => { d.goals = [goal({ metric: 'closed_lost_to_competitor_count', competitor: ' ' })]; }, /goals\[0\]\.competitor: must be a non-empty string/],
    [(d) => { d.goals = [goal({ metric: 'closed_lost_to_competitor_count', competitor: 7 })]; }, /goals\[0\]\.competitor/],
    [(d) => { d.goals = [goal({ metric: 'closed_lost_to_competitor_count', competitor: 'x'.repeat(101) })]; }, /goals\[0\]\.competitor: longer than 100/],
    [(d) => { d.goals = [goal({ competitor: 'Example Rival' })]; }, /goals\[0\]\.competitor: only allowed with a metric that names a competitor \(closed_lost_to_competitor_count\)/],
    [(d) => { d.goals = [goal({ metric: 'closed_lost_count', competitor: 'Example Rival' })]; }, /goals\[0\]\.competitor: only allowed/],
    [(d) => { d.goals = [goal({ metric: 'outbound_reply_rate', target: 101 })]; }, /goals\[0\]\.target: outbound_reply_rate is a percent, so at most 100/],
    [(d) => { d.goals = [goal({ metric: 'ai_share_of_voice', target: 250 })]; }, /goals\[0\]\.target: ai_share_of_voice is a percent/],
  ];
  for (const [mutate, re] of cases) {
    const d = good();
    mutate(d);
    assert.match(errs(d), re);
  }
});

// A tiny synthetic GTM_DATA in the shape lib/project.mjs writes.
const pageData = () => ({
  pipelineSource: 'hubspot',
  headline: {
    pipeline: 'Main Pipeline',
    active: { count: 3, openAmount: 60000, weighted: 21000, noAmountCount: 0, noProbabilityCount: 0 },
    onHold: { count: 1, openAmount: 5000, noAmountCount: 0 },
  },
  closedLost: { count: 2, amount: 9000, byStage: [{ stage: 'Lost', count: 2 }], reasons: [], noReason: 2 },
  // Stage probabilities are HubSpot's 0–1 metadata; ≥ 0.7 open is a commit stage.
  pipelines: [{ label: 'Main Pipeline', stages: [
    { id: 's1', label: 'Discovery', closed: false, probability: 0.2 },
    { id: 's2', label: 'Proposal sent', closed: false, probability: 0.8 },
    { id: 's3', label: 'On Hold', closed: false, probability: 0.9 },
    { id: 's4', label: 'Lost', closed: true, probability: 0 },
    { id: 's5', label: 'Won', closed: true, probability: 1 },
  ] }, { label: 'Renewal Pipeline', stages: [] }],
  companies: [
    { id: 'c1', name: 'Examplo Industries, Inc.', meetings: [{ id: 'm1', start: '2026-03-10T17:00:00Z' }, { id: 'm2', start: '2026-03-20T17:00:00Z' }] },
    { id: 'c2', name: 'Sample', meetings: [{ id: 'm2', start: '2026-03-20T17:00:00Z' }, { id: 'm3', start: '2026-02-01T17:00:00Z' }] },
    { id: 'c3', name: 'Company not named', meetings: [] },
  ],
  deals: [
    { id: 'd1', name: 'Examplo expansion', pipeline: 'Main Pipeline', stageId: 's1', stage: 'Discovery', open: true, onHold: false, amount: 40000 },
    { id: 'd2', name: 'Sample pilot', pipeline: 'Main Pipeline', stageId: 's2', stage: 'Proposal sent', open: true, onHold: false, amount: 20000 },
    { id: 'd3', name: 'Paused one', pipeline: 'Main Pipeline', stageId: 's3', stage: 'On Hold', open: true, onHold: true, amount: 5000 },
    { id: 'd4', name: 'Gone one', pipeline: 'Main Pipeline', stageId: 's4', stage: 'Lost', open: false, lost: true, amount: 9000, lostReason: 'Went with EXAMPLE  rival, cheaper' },
    { id: 'd5', name: 'Signed one', pipeline: 'Main Pipeline', stageId: 's5', stage: 'Won', open: false, won: true, amount: 12000 },
    { id: 'd6', name: 'Twin', pipeline: 'Renewal Pipeline', stage: 'Open', open: true },
    { id: 'd7', name: 'Twin', pipeline: 'Renewal Pipeline', stage: 'Open', open: true },
    { id: 'd8', name: 'Gone two', pipeline: 'Main Pipeline', stageId: 's4', stage: 'Lost', open: false, lost: true, amount: null, lostReason: 'Example rivalry inside the team' },
    { id: 'd9', name: 'Gone elsewhere', pipeline: 'Renewal Pipeline', stage: 'Lost', open: false, lost: true, lostReason: 'Example Rival' },
  ],
  leadTracker: { total: 8, mql: 2, unowned: 3 },
  outbound: { campaigns: [
    { status: 'running', sent: 200, replied: 3 },
    { status: 'running', sent: 100, replied: 0 },
    { status: 'running', sent: null, replied: 2 },
    { status: 'paused', sent: 1000, replied: 50 },
    { status: 'draft', sent: 0, replied: 0 },
  ] },
  ai: { connected: true, shareOfVoice: 12.5 },
});
const NOW = new Date('2026-03-15T12:00:00Z');
const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');

test('metric values come from the page data; goal progress follows the direction', () => {
  const v = metricValues(pageData(), NOW);
  assert.deepEqual(v, {
    open_count: 3, open_amount: 60000, weighted: 21000, on_hold_count: 1, on_hold_amount: 5000, closed_lost_count: 2,
    closed_won_count: 1, closed_won_amount: 12000, meetings_this_month: 2, meetings_upcoming: 1,
    // Proposal sent only: the On Hold deal sits in a ≥ 0.7 stage but stays out, as on the tiles.
    commit_stage_amount: 20000,
    lead_to_mql_rate: 25, unowned_lead_count: 3,
    // Running campaigns with both figures: 3 replies / 300 sends.
    outbound_reply_rate: 1,
    ai_share_of_voice: 12.5,
    // Needs the goal's competitor (goalValue).
    closed_lost_to_competitor_count: null,
  });
  // No headline (records-only build): pipeline metrics are unknown, not zero.
  const bare = metricValues({ companies: [] }, NOW);
  assert.equal(bare.open_amount, null);
  assert.equal(bare.closed_won_count, null);
  assert.equal(bare.meetings_upcoming, 0);
  // All open deals without an amount: unknown, as on the tile.
  const noAmt = pageData();
  noAmt.headline.active.noAmountCount = 3;
  assert.equal(metricValues(noAmt, NOW).open_amount, null);
  for (const k of ['commit_stage_amount', 'lead_to_mql_rate', 'unowned_lead_count', 'outbound_reply_rate', 'ai_share_of_voice']) assert.equal(bare[k], null, k);

  assert.deepEqual(goalProgress(goal({ target: 120000 }), 60000), { value: 60000, ratio: 0.5, met: false, over: false });
  assert.deepEqual(goalProgress(goal({ target: 50000 }), 60000), { value: 60000, ratio: 1, met: true, over: false });
  assert.deepEqual(goalProgress(goal({ metric: 'closed_lost_count', target: 4 }), 2), { value: 2, ratio: 0.5, met: true, over: false });
  assert.deepEqual(goalProgress(goal({ metric: 'closed_lost_count', target: 1 }), 2), { value: 2, ratio: 1, met: false, over: true });
  assert.deepEqual(goalProgress(goal({ metric: 'closed_lost_count', target: 0 }), 0), { value: 0, ratio: 0, met: true, over: false });
  assert.equal(goalProgress(goal(), null).met, null);
});

test('new goal metrics: commit stages from metadata, leads, outbound, AI share of voice, competitor losses', () => {
  const d = pageData();
  assert.deepEqual(commitStages(d).map((s) => s.label), ['Proposal sent', 'On Hold']);
  // No stage at ≥ 0.7, or a records-only build: unknown, not zero. A commit stage with no deals: 0.
  const low = pageData();
  low.pipelines[0].stages.forEach((s) => { if (!s.closed) s.probability = 0.5; });
  assert.equal(metricValues(low, NOW).commit_stage_amount, null);
  assert.equal(metricValues({ ...pageData(), pipelineSource: 'records' }, NOW).commit_stage_amount, null);
  const empty = pageData();
  empty.deals = empty.deals.filter((x) => x.stageId !== 's2');
  assert.equal(metricValues(empty, NOW).commit_stage_amount, 0);
  const noAmt = pageData();
  noAmt.deals.find((x) => x.id === 'd2').amount = null;
  assert.equal(metricValues(noAmt, NOW).commit_stage_amount, null);
  // Rates are percents rounded to 0.1; no rows or no sends: unknown.
  assert.equal(metricValues({ ...d, leadTracker: { total: 3, mql: 1, unowned: 0 } }, NOW).lead_to_mql_rate, 33.3);
  assert.equal(metricValues({ ...d, leadTracker: { total: 0, mql: 0, unowned: 0 } }, NOW).lead_to_mql_rate, null);
  assert.equal(metricValues({ ...d, outbound: { campaigns: [{ status: 'paused', sent: 10, replied: 1 }] } }, NOW).outbound_reply_rate, null);
  // AI share of voice only while connected.
  assert.equal(metricValues({ ...d, ai: { connected: false, shareOfVoice: 12.5 } }, NOW).ai_share_of_voice, null);
  // Competitor losses: headline pipeline only, whole word or phrase, any case and spacing.
  const g = (competitor) => goal({ metric: 'closed_lost_to_competitor_count', competitor, target: 1 });
  assert.equal(goalValue(g('example rival'), d), 1);
  assert.equal(goalValue(g('Example'), d), 2);
  assert.equal(goalValue(g('rival'), d), 1, 'not "rivalry"');
  assert.equal(goalValue(g('Nobody'), d), 0);
  assert.equal(goalValue(g('rival'), { ...d, pipelineSource: 'records' }), null);
  assert.equal(goalValue(g('rival'), { ...d, closedLost: null }), null);
  assert.equal(goalValue(goal(), d), 60000);
  assert.deepEqual(goalProgress(g('Example'), goalValue(g('Example'), d)), { value: 2, ratio: 1, met: false, over: true });
  assert.equal(goalProgress(goal({ metric: 'unowned_lead_count', target: 3 }), 3).met, true);
  assert.equal(goalProgress(goal({ metric: 'outbound_reply_rate', target: 2 }), 1).ratio, 0.5);
  // The matcher behind it.
  assert.equal(mentions('Picked C++ tools', 'c++'), true);
  assert.equal(mentions('lost to Ünïcode Co', 'ünïcode'), true);
  assert.equal(mentions('Ünïcodes', 'ünïcode'), false);
  assert.equal(mentions(null, 'x'), false);
});

test('references in insight text are matched against the page data', () => {
  const idx = refIndex(pageData(), { money: [usd], now: NOW });
  const refs = (t) => findRefs(t, idx).map((r) => [r.text, r.ref.kind, r.ref.id ?? r.ref.key ?? r.ref.stage ?? r.ref.pipe]);

  // Deals and accounts by name; the longer deal name wins over the account inside it;
  // a legal suffix is optional; possessives still match.
  assert.deepEqual(refs('Examplo expansion is stuck; Examplo Industries’ champion left. Sample’s pilot is fine.'), [
    ['Examplo expansion', 'deal', 'd1'], ['Examplo Industries', 'account', 'c1'], ['Sample', 'account', 'c2'],
  ]);
  assert.deepEqual(refs('Examplo Industries, Inc. renewed'), [['Examplo Industries, Inc.', 'account', 'c1']]);
  // One-word names are case-sensitive and need word boundaries.
  assert.deepEqual(refs('a sample of deals; Samples; Resample'), []);
  // Open stages filter the pipeline; On Hold, lost and won stages cite their metric.
  assert.deepEqual(refs('Two deals in proposal sent and one in Discovery, but discovery here is a verb.'), [
    ['proposal sent', 'stage', 'Proposal sent'], ['Discovery', 'stage', 'Discovery'],
  ]);
  assert.deepEqual(refs('Lost and Won stages; deals On Hold'), [
    ['Lost', 'metric', 'closed_lost_count'], ['Won', 'metric', 'closed_won_count'], ['On Hold', 'metric', 'on_hold_count'],
  ]);
  // Headline metrics by phrase or by their figure as the page formats it; panels by name.
  assert.deepEqual(refs('Open amount is $60,000 and the weighted pipeline is $21,000; see lost reasons and the close-date chart.'), [
    ['Open amount', 'metric', 'open_amount'], ['$60,000', 'metric', 'open_amount'], ['weighted pipeline', 'metric', 'weighted'],
    ['$21,000', 'metric', 'weighted'], ['lost reasons', 'panel', 'lost'], ['close-date', 'panel', 'closeMonth'],
  ]);
  assert.deepEqual(refs('the open pipeline by stage panel'), [['open pipeline by stage', 'panel', 'stages']]);
  // The commit-stage figure is not matched (it is often one deal's amount too).
  assert.deepEqual(refs('Commit stages hold $20,000; the reply rate fell.'), [
    ['Commit stages', 'metric', 'commit_stage_amount'], ['reply rate', 'metric', 'outbound_reply_rate'],
  ]);
  assert.deepEqual(refs('$60,0000 is not a figure'), []);
  // Pipelines: the headline one points at its panel, the others at their pipeline view.
  assert.deepEqual(refs('Main Pipeline vs renewal pipeline'), [['Main Pipeline', 'panel', 'headline'], ['renewal pipeline', 'pipeline', 'Renewal Pipeline']]);
  // Ambiguous names (two deals called the same) and placeholders are never linked.
  assert.deepEqual(refs('Twin deals; Company not named'), []);
  // Citations that name a data path cite the metric.
  assert.deepEqual(refs('data.js headline.active.count'), [['headline.active.count', 'metric', 'open_count']]);
  // Offsets index the original text, so the page can split it with textContent.
  const text = 'İ before Sample';
  const [hit] = findRefs(text, idx);
  assert.equal(text.slice(hit.start, hit.end), 'Sample');
  assert.deepEqual(findRefs('', idx), []);
  assert.deepEqual(findRefs('<b>Sample</b>', idx).map((r) => r.text), ['Sample']);
});
