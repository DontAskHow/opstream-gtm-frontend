// node --test test/
// End-to-end: one synthetic HubSpot export (live_deals.json shape) through the
// workspace (workspace/lib/project.mjs -> workspace-model.cjs) and through
// scripts/gtm_metrics.py. Both read shared/open-pipeline.json, so they must give
// the same open book, the same On Hold line and the same totals.
// Every name, id and amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildData } from '../workspace/lib/project.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = createRequire(import.meta.url)('../workspace-model.cjs');

const stage = (pipe, label, closed, prob) => ({ pipe, label, closed, prob: String(prob) });
const deal = (id, name, props) => ({ id, properties: { dealname: name, ...props } });
const LIVE = {
  pipes: { nb: 'Sales Pipeline', rn: 'Renewal Pipeline', cs: 'Customer Success Pipeline', pt: 'Partnerships Pipeline' },
  stages: {
    s1: stage('Sales Pipeline', 'Discovery', false, 0.1),
    s2: stage('Sales Pipeline', 'Proposal', false, 0.5),
    s3: stage('Sales Pipeline', 'On Hold', false, 0.1),
    s4: stage('Sales Pipeline', 'on-hold', false, 0.1),
    s5: stage('Sales Pipeline', 'Closed lost', true, 0),
    s6: stage('Sales Pipeline', 'Closed won', false, 1), // a name says closed; the catalog says open
    s7: stage('Sales Pipeline', 'Contract signed', true, 1),
    r1: stage('Renewal Pipeline', 'Negotiation', false, 0.8),
    c1: stage('Customer Success Pipeline', 'On Hold', false, 0.5),
    p1: stage('Partnerships Pipeline', 'Exploration', false, 0.3),
  },
  deals: [
    deal('1', 'Example Anvils - New', { pipeline: 'nb', dealstage: 's1', amount: '120000', hs_deal_stage_probability: '0.1' }),
    deal('2', 'Sample Rockets - New', { pipeline: 'nb', dealstage: 's2', amount: '45000.5', hs_deal_stage_probability: '0.5' }),
    deal('3', 'Demo Kites - New', { pipeline: 'nb', dealstage: 's2', amount: '30000' }), // no probability
    deal('4', 'Fictional Bolts - New', { pipeline: 'nb', dealstage: 's1', hs_deal_stage_probability: '0.1' }), // no amount
    deal('5', 'Imaginary Gears - New', { pipeline: 'nb', dealstage: 's3', amount: '60000', hs_deal_stage_probability: '0.1' }),
    deal('6', 'Mock Pulleys - New', { pipeline: 'nb', dealstage: 's4', amount: '7000', hs_deal_stage_probability: '0.1' }),
    deal('7', 'Pretend Levers - New', { pipeline: 'nb', dealstage: 's5', amount: '90000', hs_deal_stage_probability: '0' }),
    deal('8', 'Placeholder Pumps - New', { pipeline: 'nb', dealstage: 's6', amount: '11000', hs_deal_stage_probability: '1' }),
    // isClosed wins over hs_is_closed both ways.
    deal('9', 'Toy Valves - New', { pipeline: 'nb', dealstage: 's7', amount: '5000', hs_is_closed: 'false' }),
    deal('10', 'Fake Springs - New', { pipeline: 'nb', dealstage: 's1', amount: '8000', hs_deal_stage_probability: '0.1', hs_is_closed: 'true' }),
    // Stage not in the catalog: hs_is_closed decides; the pipeline label comes from pipes.
    deal('11', 'Model Cogs - New', { pipeline: 'nb', dealstage: 'gone', amount: '13000', hs_is_closed: 'false' }),
    deal('12', 'Sketch Rivets - New', { pipeline: 'nb', dealstage: 'gone', amount: '14000', hs_is_closed: 'true' }),
    // No recorded pipeline and no catalog stage: not new business.
    deal('13', 'Draft Hinges - New', { dealstage: 'gone', amount: '15000', hs_is_closed: 'false' }),
    deal('14', 'Example Anvils - Renewal', { pipeline: 'rn', dealstage: 'r1', amount: '20000', hs_deal_stage_probability: '0.8' }),
    deal('15', 'Sample Rockets - Success', { pipeline: 'cs', dealstage: 'c1', amount: '9000', hs_deal_stage_probability: '0.5' }),
    deal('16', 'Demo Kites - Partner', { pipeline: 'pt', dealstage: 'p1', amount: '3000', hs_deal_stage_probability: '0.3' }),
  ],
};

function python(live) {
  const r = spawnSync('python3', ['-c', `import json,sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
import gtm_metrics as gm
deals = gm.deals_from_hubspot_export(json.load(sys.stdin))
book = [d for d in deals if gm.is_open_pipeline(d)]
hold = [d for d in deals if gm.is_on_hold(d)]
print(json.dumps({"open": [d["id"] for d in book], "hold": [d["id"] for d in hold],
                  "status": {d["id"]: gm.pipeline_status(d) for d in deals},
                  "active": gm.open_totals(book), "onHold": gm.open_totals(hold)}))`], { input: JSON.stringify(live), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const pick = (t) => ({ count: t.count, openAmount: t.openAmount, weighted: Math.round(t.weighted * 100) / 100, noProbabilityCount: t.noProbabilityCount, noAmountCount: t.noAmountCount });
const STATUS = { true: 'open', false: 'closed' };

test('the workspace and gtm_metrics.py give the same open book from one HubSpot export', () => {
  const data = buildData({ recon: { live: LIVE, fetchedAt: '2026-10-12T00:00:00Z' } });
  const js = {
    open: data.deals.filter((d) => d.openBook).map((d) => d.id),
    hold: data.deals.filter((d) => d.onHoldBook).map((d) => d.id),
    status: Object.fromEntries(data.deals.map((d) => [d.id, d.onHold ? 'onHold' : STATUS[d.open]])),
  };
  const py = python(LIVE);

  assert.deepEqual(js.open, ['deal-1', 'deal-2', 'deal-3', 'deal-4', 'deal-8', 'deal-10', 'deal-11']);
  assert.deepEqual(js.hold, ['deal-5', 'deal-6']);
  assert.deepEqual(py.open, js.open);
  assert.deepEqual(py.hold, js.hold);
  assert.deepEqual(py.status, js.status);

  // The headline the app shows is that open book.
  assert.equal(data.headline.pipeline, 'Sales Pipeline');
  assert.deepEqual(pick(data.headline.active), pick(py.active));
  assert.deepEqual(pick(data.headline.onHold), pick(py.onHold));
  assert.deepEqual(pick(data.headline.active), { count: 7, openAmount: 227000.5, weighted: 46300.25, noProbabilityCount: 2, noAmountCount: 1 });
});

test('there is one definition file and both sides load it', () => {
  const def = JSON.parse(readFileSync(join(ROOT, 'shared', 'open-pipeline.json'), 'utf8'));
  assert.deepEqual(model.PIPELINE_DEF, def);
  const r = spawnSync('python3', ['-c', `import json,sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
import gtm_metrics as gm
print(json.dumps(gm.PIPELINE_DEF))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), def);
  // The definition carries rules, never data.
  assert.doesNotMatch(JSON.stringify(def), /\$\d|\b\d{4,}\b/);
});
