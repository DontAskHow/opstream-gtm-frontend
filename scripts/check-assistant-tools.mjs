// Runs every assistant tool against the on-disk snapshot. Does not start the
// server and does not call a model. Real records stay in out/data.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_TOOL_NAMES, loadWorkspace, runAssistantTool } from './workspace-facts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const facts = loadWorkspace(path.join(root, 'out', 'data'));
const failures = [];

function check(name, ok, detail) {
  if (!ok) failures.push(name + ': ' + detail);
}

const toolResults = {};
for (const name of ASSISTANT_TOOL_NAMES) {
  const args = name === 'lookup_deals' ? { query: 'Kidde' }
    : name === 'create_draft' ? { company: 'NXP', text: 'hello' }
    : name === 'navigate' ? { view: 'accounts' }
    : name === 'propose_crm_update' ? { company: 'NXP', field: 'stage', proposedValue: 'Discovery', rationale: 'check' }
    : name === 'mark_queue_item' ? { itemId: 'q:stale_deal:example', action: 'done' }
    : {};
  let text;
  try { text = runAssistantTool(name, args, facts); }
  catch (e) { failures.push(name + ' threw: ' + e.message); continue; }
  check(name + ' returns text', typeof text === 'string' && text.length > 0, 'empty');
  toolResults[name] = text;
}

const metrics = JSON.parse(toolResults.get_pipeline_metrics);
const largest = metrics.largestOpenDeal || {};
check('largest company', largest.company === 'NXP', JSON.stringify(largest.company));
check('largest deal', largest.dealName === 'NXP - New Deal', JSON.stringify(largest.dealName));
check('largest amount', largest.amount === 500000 && largest.amountLabel === '$500,000', JSON.stringify(largest.amount) + ' ' + largest.amountLabel);
check('largest in open book', largest.inOpenBook === true, String(largest.inOpenBook));
check('open count', metrics.openCount === 83, String(metrics.openCount));
check('open amount', metrics.openAmount === 4736300 && metrics.openAmountLabel === '$4,736,300', metrics.openAmount + ' ' + metrics.openAmountLabel);
check('weighted', metrics.weighted === 1212860 && metrics.weightedLabel === '$1,212,860', metrics.weighted + ' ' + metrics.weightedLabel);
check('funnel', metrics.leads === 383 && metrics.mql === 279 && metrics.sql === 118, [metrics.leads, metrics.mql, metrics.sql].join('/'));

const kidde = JSON.parse(runAssistantTool('lookup_deals', { query: 'Kidde Global Solutions' }, facts));
const renewal = (kidde.deals || []).find(d => /Renewal Agreement - 2027/.test(d.dealName || '') && d.amount === 514800);
check('kidde renewal found', !!renewal, 'missing');
if (renewal) {
  check('kidde not open', renewal.inOpenBook === false, String(renewal.inOpenBook));
  check('kidde reason', renewal.reason === 'renewal', renewal.reason);
}
const nxp = JSON.parse(runAssistantTool('lookup_deals', { query: 'NXP' }, facts));
const nxpOpen = (nxp.deals || []).find(d => d.amount === 500000 && d.inOpenBook);
check('nxp open lookup', !!nxpOpen && nxpOpen.company === 'NXP', nxpOpen ? nxpOpen.company : 'missing');

const lines = facts.context.split('\n');
const largestLine = lines.find(l => l.startsWith('LARGEST OPEN DEAL:'));
check('context largest line', !!largestLine && largestLine.includes('NXP') && largestLine.includes('$500,000') && !/kidde/i.test(largestLine), largestLine || 'missing');
const renewalLine = lines.find(l => l.includes('Renewal Agreement - 2027') && l.includes('$514,800'));
check('context renewal label', !!renewalLine && renewalLine.includes('NOT IN THE OPEN BOOK (renewal)'), renewalLine || 'missing');
check('context open total', facts.context.includes('OPEN PIPELINE: 83 deals, $4,736,300 open, $1,212,860 weighted.'), 'missing open pipeline line');
check('context funnel', facts.context.includes('383 leads / 279 MQL / 118 SQL'), 'missing funnel line');

const openLines = lines.filter(l => l.startsWith('OPEN DEAL:') || l.startsWith('LARGEST OPEN DEAL:'));
check('owner labels', openLines.every(l => !/owner Owner \d{5,}/.test(l) && !/owner \d{6,}/.test(l)), 'full owner id in an open-deal line');
check('no open-deals header', !facts.context.includes('Open deals:'), 'account lines still say Open deals');

const py = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, "scripts")
from gtm_metrics import snapshot_metrics
ver = json.load(open("out/data/verified.json"))
rec = json.load(open("out/data/records.json"))
book = snapshot_metrics(ver, rec)
kidde = [d for d in book["deals"] if "Renewal Agreement - 2027" in (d.get("dealName") or "") and d.get("amount") == 514800]
print(json.dumps({
  "today": book["today"],
  "openCount": book["openCount"],
  "openAmount": book["openAmount"],
  "weighted": book["weighted"],
  "leads": book["leads"],
  "mql": book["mql"],
  "sql": book["sql"],
  "largest": book["largest"],
  "kidde": [{"dealName": d["dealName"], "amount": d["amount"], "inOpenBook": d["inOpenBook"], "reason": d["reason"], "owner": d["ownerLabel"]} for d in kidde],
}))
`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const pyBook = JSON.parse(py);
check('python count', pyBook.openCount === metrics.openCount, String(pyBook.openCount));
check('python amount', pyBook.openAmount === metrics.openAmount, String(pyBook.openAmount));
check('python weighted', pyBook.weighted === metrics.weighted, String(pyBook.weighted));
check('python funnel', pyBook.leads === 383 && pyBook.mql === 279 && pyBook.sql === 118, [pyBook.leads, pyBook.mql, pyBook.sql].join('/'));
check('python largest', pyBook.largest && pyBook.largest.company === 'NXP' && pyBook.largest.amount === 500000 && pyBook.largest.owner === largest.owner, JSON.stringify(pyBook.largest));
check('python kidde', pyBook.kidde.length === 1 && pyBook.kidde[0].inOpenBook === false && pyBook.kidde[0].reason === 'renewal', JSON.stringify(pyBook.kidde));
check('python date', pyBook.today === facts.today, pyBook.today + ' vs ' + facts.today);

const report = {
  ok: failures.length === 0,
  today: facts.today,
  tools: ASSISTANT_TOOL_NAMES,
  largestOpenDeal: { company: largest.company, dealName: largest.dealName, amount: largest.amountLabel, owner: largest.owner },
  openPipeline: { deals: metrics.openCount, open: metrics.openAmountLabel, weighted: metrics.weightedLabel },
  funnel: { leads: metrics.leads, mql: metrics.mql, sql: metrics.sql },
  kiddeRenewal: renewal ? { dealName: renewal.dealName, amount: renewal.amountLabel, inOpenBook: renewal.inOpenBook, reason: renewal.reason } : null,
  pythonMatchesPage: failures.filter(f => f.startsWith('python')).length === 0,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
