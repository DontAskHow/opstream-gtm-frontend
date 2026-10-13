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
const { validate, parse, flagText, METRICS, metricValues, goalProgress, refIndex, findRefs } = require('../workspace/src/insights.js');
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
  assert.deepEqual(Object.keys(g.items.properties).sort(), ['by', 'label', 'metric', 'note', 'target']);
  assert.deepEqual(g.items.required.sort(), ['label', 'metric', 'target']);
  assert.deepEqual(g.items.properties.metric.enum, Object.keys(METRICS));
  assert.equal(g.items.properties.label.maxLength, 200);
  assert.equal(g.items.properties.note.maxLength, 400);
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
  d.goals = Object.keys(METRICS).concat(['open_count', 'weighted']).map((metric) => goal({ metric }));
  assert.equal(d.goals.length, 12);
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
  pipelines: [{ label: 'Main Pipeline', stages: [] }, { label: 'Renewal Pipeline', stages: [] }],
  companies: [
    { id: 'c1', name: 'Examplo Industries, Inc.', meetings: [{ id: 'm1', start: '2026-03-10T17:00:00Z' }, { id: 'm2', start: '2026-03-20T17:00:00Z' }] },
    { id: 'c2', name: 'Sample', meetings: [{ id: 'm2', start: '2026-03-20T17:00:00Z' }, { id: 'm3', start: '2026-02-01T17:00:00Z' }] },
    { id: 'c3', name: 'Company not named', meetings: [] },
  ],
  deals: [
    { id: 'd1', name: 'Examplo expansion', pipeline: 'Main Pipeline', stage: 'Discovery', open: true, onHold: false, amount: 40000 },
    { id: 'd2', name: 'Sample pilot', pipeline: 'Main Pipeline', stage: 'Proposal sent', open: true, onHold: false, amount: 20000 },
    { id: 'd3', name: 'Paused one', pipeline: 'Main Pipeline', stage: 'On Hold', open: true, onHold: true, amount: 5000 },
    { id: 'd4', name: 'Gone one', pipeline: 'Main Pipeline', stage: 'Lost', open: false, lost: true, amount: 9000 },
    { id: 'd5', name: 'Signed one', pipeline: 'Main Pipeline', stage: 'Won', open: false, won: true, amount: 12000 },
    { id: 'd6', name: 'Twin', pipeline: 'Renewal Pipeline', stage: 'Open', open: true },
    { id: 'd7', name: 'Twin', pipeline: 'Renewal Pipeline', stage: 'Open', open: true },
  ],
});
const NOW = new Date('2026-03-15T12:00:00Z');
const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');

test('metric values come from the page data; goal progress follows the direction', () => {
  const v = metricValues(pageData(), NOW);
  assert.deepEqual(v, {
    open_count: 3, open_amount: 60000, weighted: 21000, on_hold_count: 1, on_hold_amount: 5000, closed_lost_count: 2,
    closed_won_count: 1, closed_won_amount: 12000, meetings_this_month: 2, meetings_upcoming: 1,
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

  assert.deepEqual(goalProgress(goal({ target: 120000 }), 60000), { value: 60000, ratio: 0.5, met: false, over: false });
  assert.deepEqual(goalProgress(goal({ target: 50000 }), 60000), { value: 60000, ratio: 1, met: true, over: false });
  assert.deepEqual(goalProgress(goal({ metric: 'closed_lost_count', target: 4 }), 2), { value: 2, ratio: 0.5, met: true, over: false });
  assert.deepEqual(goalProgress(goal({ metric: 'closed_lost_count', target: 1 }), 2), { value: 2, ratio: 1, met: false, over: true });
  assert.deepEqual(goalProgress(goal({ metric: 'closed_lost_count', target: 0 }), 0), { value: 0, ratio: 0, met: true, over: false });
  assert.equal(goalProgress(goal(), null).met, null);
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
