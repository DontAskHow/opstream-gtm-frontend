// node --test test/
// workspace-model.cjs must agree with scripts/gtm_metrics.py on the open book.
// All names, ids and amounts are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const m = require('../workspace-model.cjs');

const TODAY = '2026-10-12';

test('a Sheet-active row that HubSpot closed is out of the open book', () => {
  const deal = { id: 'deal-1', onSheet: true, sheetClass: 'active', stage: 'SQL', pipelineLabel: 'Sales Pipeline', closed: true };
  assert.equal(m.isOpenPipeline(deal, TODAY), false);
  assert.equal(m.exclusionReason(deal, TODAY), 'closed in HubSpot, still active on the Sheet');
});

test('closed comes only from the HubSpot isClosed flag, never a stage name', () => {
  const deal = { id: 'deal-1', stage: 'Closed lost', pipelineLabel: 'Sales Pipeline', closed: false };
  assert.equal(m.pipelineStatus(deal), 'open');
  assert.equal(m.isOpenPipeline({ ...deal, stage: 'Disqualified', hubspotStage: 'Closed lost' }, TODAY), true);
});

test('the Sheet does not decide membership; HubSpot stage does', () => {
  const opp = { id: 'deal-9', stage: 'SQL', stageLabel: 'SQL', pipeline: 'p1', pipelineLabel: 'Sales Pipeline', closed: false };
  const onSheetAsHold = m.applySheetDeal(opp, { 9: { stage: 'On Hold' } });
  assert.equal(onSheetAsHold.sheetClass, 'on hold');
  assert.equal(onSheetAsHold.hubspotStageLabel, 'SQL');
  assert.equal(m.isOpenPipeline(onSheetAsHold, TODAY), true);
  const heldInHubspot = m.applySheetDeal({ ...opp, stage: 'On Hold', stageLabel: 'On Hold' }, { 9: { stage: 'SQL' } });
  assert.equal(heldInHubspot.sheetClass, 'active');
  assert.equal(m.isOpenPipeline(heldInHubspot, TODAY), false);
  assert.equal(m.isOnHold(heldInHubspot), true);
});

test('a deal with no recorded pipeline is not new business', () => {
  const deal = { id: 'deal-8', onSheet: true, sheetClass: 'active', stage: 'SQL', closed: false };
  assert.equal(m.isOpenPipeline(deal, TODAY), false);
  assert.equal(m.exclusionReason(deal, TODAY), 'pipeline not recorded');
});

test('the rule is pipeline-def.json, read by both the JS model and gtm_metrics.py', () => {
  const root = join(__dirname, '..');
  assert.deepEqual(m.PIPELINE_DEF, JSON.parse(readFileSync(join(root, 'pipeline-def.json'), 'utf8')));
  const deals = [
    { pipelineLabel: 'Sales Pipeline', stageLabel: 'SQL', closed: false },
    { pipelineLabel: 'Sales Pipeline', stageLabel: 'On Hold', closed: false },
    { pipelineLabel: 'Sales Pipeline', stageLabel: 'on-hold', closed: false },
    { pipelineLabel: 'Sales Pipeline', stageLabel: 'Closed lost', closed: false },
    { pipelineLabel: 'Sales Pipeline', stageLabel: 'SQL', closed: true },
    { pipelineLabel: 'Sales Pipeline', stageLabel: 'SQL', hubspotStageLabel: 'On Hold', closed: false },
    { pipelineLabel: 'Renewal Pipeline', stageLabel: 'Negotiations', closed: false },
    { pipelineLabel: 'Customer Success Pipeline', stageLabel: 'On Hold', closed: false },
    { pipelineLabel: 'Partnerships Pipeline', stageLabel: 'Exploration', closed: false },
    { pipeline: '', stageLabel: 'SQL', closed: false },
  ];
  const js = deals.map((d) => [m.pipelineKind(d), m.pipelineStatus(d), m.isOpenPipeline(d, TODAY), m.isOnHold(d)]);
  const py = spawnSync('python3', ['-c', `import json,sys
sys.path.insert(0, ${JSON.stringify(join(root, 'scripts'))})
import gtm_metrics as gm
deals = json.load(sys.stdin)
print(json.dumps([[gm.pipeline_kind(d), gm.pipeline_status(d), gm.is_open_pipeline(d), gm.is_on_hold(d)] for d in deals]))`], { input: JSON.stringify(deals), encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), js);
  assert.deepEqual(js.map((r) => r[2]), [true, false, false, true, false, false, false, false, false, false]);
});

test('an open HubSpot deal that is not on the Sheet is in the book, past close included', () => {
  const deal = { id: 'deal-2', stage: 'SQL', pipelineLabel: 'Sales Pipeline', closed: false, close: '2026-01-01' };
  assert.equal(m.isOpenPipeline(deal, TODAY), true);
  assert.equal(m.isHubspotOnlyOpen(deal, TODAY), true);
  assert.equal(m.listStatus(deal, TODAY), 'past');
});

test('renewal, customer-success and partnership pipelines are never new business', () => {
  for (const pipelineLabel of ['Renewal Pipeline', 'Customer Success Pipeline', 'Partnerships Pipeline']) {
    const deal = { id: 'deal-3', onSheet: true, sheetClass: 'active', stage: 'SQL', pipelineLabel };
    assert.equal(m.isOpenPipeline(deal, TODAY), false, pipelineLabel);
  }
});

test('On Hold is its own book and drops HubSpot-closed rows', () => {
  const deal = { id: 'deal-4', stage: 'On Hold', pipelineLabel: 'Sales Pipeline', closed: false, amount: 300 };
  assert.equal(m.isOpenPipeline(deal, TODAY), false);
  assert.equal(m.exclusionReason(deal, TODAY), 'On Hold');
  assert.deepEqual(m.onHoldBook([deal, { ...deal, id: 'deal-5', closed: true }]).count, 1);
});

test('Sheet-only rows HubSpot closed are marked closed', () => {
  const review = { deals: [{ id: '77', name: 'Example - New Deal', company: 'Example', stage: 'SQL', amount: 1000, probability: 5 }] };
  const closed = m.hubspotClosedDeals({ closedDeals: [{ id: 'deal-77', stage: 'Closed lost' }] }, { companies: [] });
  const [row] = m.dealsWithSheet([], review, closed);
  assert.equal(row.hubspotClosed, true);
  assert.equal(m.isOpenPipeline(row, TODAY), false);
  // Not in HubSpot at all: no pipeline, so not in the open book.
  const [notInHubspot] = m.dealsWithSheet([], review);
  assert.equal(m.isOpenPipeline(notInHubspot, TODAY), false);
  assert.equal(notInHubspot.probability, 0.05);
});

test('weighted and open total: no-probability deals are in open, counted separately', () => {
  const deals = [
    { id: 'a', pipelineLabel: 'Sales Pipeline', amount: 1000, probability: 0.5 },
    { id: 'b', pipelineLabel: 'Sales Pipeline', amount: 3000, probability: null },
    { id: 'c', pipelineLabel: 'Sales Pipeline', amount: null, probability: 0.5 },
  ];
  const t = m.pipelineTotals(deals, TODAY);
  assert.equal(t.count, 3);
  assert.equal(t.openAmount, 4000);
  assert.equal(t.weighted, 500);
  assert.equal(t.noProbabilityCount, 1);
  assert.equal(t.noProbabilityAmount, 3000);
  assert.equal(t.noAmountCount, 1);
  assert.equal(m.pipelineTotals([], TODAY).weighted, null);
});

test('stage table groups by pipeline and never merges a shared stage label', () => {
  const rows = m.stageTable([
    { pipelineLabel: 'Renewal Pipeline', stage: 'Negotiations', amount: 10 },
    { pipelineLabel: 'Customer Success Pipeline', stage: 'Negotiations', amount: 5 },
    { pipelineLabel: 'Customer Success Pipeline', stage: 'Negotiations', amount: 5 },
  ]);
  assert.deepEqual(rows.map((r) => [r.pipeline, r.count, r.amount]), [
    ['Customer Success Pipeline', 2, 10],
    ['Renewal Pipeline', 1, 10],
  ]);
  const by = m.pipelineBreakdown([
    { pipelineLabel: 'Sales Pipeline', stage: 'SQL', amount: 100, probability: 0.1 },
    { pipelineLabel: 'Sales Pipeline', stage: 'On Hold', amount: 70, probability: 0.1 },
    { pipelineLabel: 'Sales Pipeline', stage: 'Closed lost', amount: 999, probability: 0, closed: true },
    { pipelineLabel: 'Renewal Pipeline', stage: 'Negotiations', amount: 50, probability: 0.9 },
  ]);
  assert.deepEqual(by.map((p) => [p.pipeline, p.kind, p.count, p.weighted, p.onHold.count, p.onHold.amount]), [
    ['Sales Pipeline', 'new business', 1, 10, 1, 70],
    ['Renewal Pipeline', 'renewal', 1, 45, 0, 0],
  ]);
});

test('annotateOpportunities converts by declared scale, never by guessing', () => {
  const small = m.annotateOpportunities([{ id: 'a', probability: 0.01 }, { id: 'b', probability: 0.02 }], {});
  assert.deepEqual(small.map((o) => o.probability), [0.01, 0.02]);
  assert.equal(m.annotateOpportunities([{ id: 'a', probability: 40 }], {}, 'percent')[0].probability, 0.4);
  assert.equal(m.annotateOpportunities([{ id: 'a', probability: 40 }], {})[0].probability, null);
  assert.equal(m.probabilityFromScale(1, 'fraction'), 1);
  assert.equal(m.probabilityFromScale(1, 'percent'), 0.01);
  assert.throws(() => m.probabilityFromScale(0.5, 'auto'));
});

test('no HubSpot links without a configured portal', () => {
  assert.deepEqual(m.hubspotLinks(['hubspot:deals:123']), []);
});
