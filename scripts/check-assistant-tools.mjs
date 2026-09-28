// Runs every assistant tool against the on-disk snapshot. Does not start the
// server and does not call a model. Real records stay in out/data.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_TOOL_NAMES, computeFacts, dataRevision, loadWorkspace, needsReload, runAssistantTool } from './workspace-facts.mjs';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'out', 'data');
// Quarter-to-date ends on the Phoenix calendar day the process runs. The
// figures below were measured as of 2026-09-26, the collection's Phoenix date.
// A later calendar day can include one more booked meeting without changing
// the open book. Lock both: the certified day, and live agreement with Python.
const CERTIFIED_DAY = '2026-09-27';
const verified = JSON.parse(fs.readFileSync(path.join(dataDir, 'verified.json'), 'utf8'));
const records = JSON.parse(fs.readFileSync(path.join(dataDir, 'records.json'), 'utf8'));
let sheetReview = null;
try { sheetReview = JSON.parse(fs.readFileSync(path.join(dataDir, 'sheet-review.json'), 'utf8')); } catch { sheetReview = null; }
const certified = computeFacts(verified, records, CERTIFIED_DAY, sheetReview);
const facts = loadWorkspace(dataDir);
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
const certifiedMetrics = JSON.parse(runAssistantTool('get_pipeline_metrics', {}, certified));
const certifiedLargest = certifiedMetrics.largestOpenDeal || {};
check('largest company', certifiedLargest.company === 'NXP', JSON.stringify(certifiedLargest.company));
check('largest deal', certifiedLargest.dealName === 'NXP - New Deal', JSON.stringify(certifiedLargest.dealName));
check('largest amount', certifiedLargest.amount === 500000 && certifiedLargest.amountLabel === '$500,000', JSON.stringify(certifiedLargest.amount) + ' ' + certifiedLargest.amountLabel);
check('largest in open book', certifiedLargest.inOpenBook === true, String(certifiedLargest.inOpenBook));
check('open count', certifiedMetrics.openCount === 32, String(certifiedMetrics.openCount));
check('open amount', certifiedMetrics.openAmount === 3960000 && certifiedMetrics.openAmountLabel === '$3,960,000', certifiedMetrics.openAmount + ' ' + certifiedMetrics.openAmountLabel);
check('weighted', certifiedMetrics.weighted === 904750 && certifiedMetrics.weightedLabel === '$904,750', certifiedMetrics.weighted + ' ' + certifiedMetrics.weightedLabel);
check('on hold', certifiedMetrics.onHoldCount === 15 && certifiedMetrics.onHoldAmount === 1300000 && certifiedMetrics.onHoldAmountLabel === '$1,300,000', [certifiedMetrics.onHoldCount, certifiedMetrics.onHoldAmount].join('/'));
check('hubspot only', certifiedMetrics.hubspotOnlyCount === 1 && certifiedMetrics.hubspotOnlyAmount === 0, [certifiedMetrics.hubspotOnlyCount, certifiedMetrics.hubspotOnlyAmount].join('/'));
check('renewals', certifiedMetrics.renewalCount === 74 && certifiedMetrics.renewalAmount === 3433665 && certifiedMetrics.renewalAmountLabel === '$3,433,665' && certifiedMetrics.renewalDuplicates === 3, [certifiedMetrics.renewalCount, certifiedMetrics.renewalAmount, certifiedMetrics.renewalDuplicates].join('/'));
check('funnel', certifiedMetrics.leads === 129 && certifiedMetrics.mql === 23 && certifiedMetrics.sql === 22, [certifiedMetrics.leads, certifiedMetrics.mql, certifiedMetrics.sql].join('/'));
check('nxp owner', certifiedLargest.owner === 'Tim', JSON.stringify(certifiedLargest.owner));
check('live largest still NXP', largest.company === 'NXP' && largest.amount === 500000 && largest.owner === 'Tim', JSON.stringify(largest));
check('live open book sheet-authoritative', metrics.openCount === 32 && metrics.openAmount === 3960000 && metrics.weighted === 904750, [metrics.openCount, metrics.openAmount, metrics.weighted].join('/'));
check('collected timestamp', !!metrics.collectedAt && facts.context.includes('DATA COLLECTED:') && facts.context.includes(metrics.collectedAt) && String(metrics.collectedLabel).includes('Phoenix'), metrics.collectedLabel || 'missing');
const revA = dataRevision(dataDir);
const revB = dataRevision(dataDir);
check('revision stable', revA === revB && revA.includes('records.json:'), revA.slice(0, 80));
check('reload when files change', needsReload('', revA) && needsReload(revA, revA + ':changed') && !needsReload(revA, revA), 'needsReload mismatch');

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

const lines = certified.context.split('\n');
const largestLine = lines.find(l => l.startsWith('LARGEST OPEN DEAL:'));
check('context largest line', !!largestLine && largestLine.includes('NXP') && largestLine.includes('$500,000') && !/kidde/i.test(largestLine), largestLine || 'missing');
const renewalLine = lines.find(l => l.includes('Renewal Agreement - 2027') && l.includes('$514,800'));
check('context renewal label', !!renewalLine && renewalLine.includes('NOT IN THE OPEN BOOK (renewal)'), renewalLine || 'missing');
check('context open total', certified.context.includes('OPEN PIPELINE: 32 deals, $3,960,000 open, $904,750 weighted.'), 'missing open pipeline line');
check('context on hold', certified.context.includes('ON HOLD: 15 deals, $1,300,000.'), 'missing on hold line');
check('context hubspot only', certified.context.includes('IN HUBSPOT, NOT ON THE SHEET: 1 deal, $0.'), 'missing hubspot-only line');
check('context renewals', certified.context.includes('RENEWALS: 74 current deals, $3,433,665.'), 'missing renewals line');
check('legacy renewal not open', certified.context.includes('NOT IN THE OPEN BOOK (renewal): No company on the Sheet row — Renewal, $50,000'), 'missing $50,000 renewal');
check('associated renewal company', certified.context.includes('NOT IN THE OPEN BOOK (renewal): Intuitive — Renewal, $350,000'), 'missing associated company');
check('marketing brief in context', certified.context.includes('MARKETING BRIEF'), 'missing marketing brief');
check('context funnel', certified.context.includes('129 leads / 23 MQL / 22 SQL'), 'missing funnel line');
const mozilla = certified.deals.find(d => /Mozilla Firefox/.test(d.dealName || '') && d.amount === 105000);
check('mozilla in the book', !!mozilla && mozilla.inOpenBook && mozilla.company === 'Mozilla' && mozilla.stage === 'Wider stakeholders' && mozilla.owner === 'Tim' && mozilla.closePassed === false, mozilla ? [mozilla.company, mozilla.stage, mozilla.owner, mozilla.inOpenBook].join('/') : 'missing');
const passed = ['CrossCountry', 'Taboola', 'ImPact Biotech', 'UVeye'].map(name => certified.deals.find(d => (d.dealName || '').includes(name) && d.inOpenBook));
check('past close sheet rows stay open', passed.every(d => d && d.closePassed) && passed.map(d => d.amount).join(',') === '50000,50000,35000,50000', passed.map(d => d ? d.dealName + ':' + d.closePassed : 'missing').join('; '));
check('past close flagged in context', ['CrossCountry', 'Taboola', 'ImPact Biotech', 'UVeye'].every(name => certified.context.includes(name) && certified.context.includes('close date passed')), 'missing close date passed');
const calendly = certified.deals.find(d => /Calendly/.test(d.dealName || ''));
check('calendly not in the total', !!calendly && calendly.inOpenBook === false && calendly.reason === 'In HubSpot, not on the Sheet', calendly ? calendly.reason : 'missing');
check('live funnel line', facts.context.includes(metrics.leads + ' leads / ' + metrics.mql + ' MQL / ' + metrics.sql + ' SQL'), 'missing live funnel line');

const openLines = lines.filter(l => l.startsWith('OPEN DEAL:') || l.startsWith('LARGEST OPEN DEAL:'));
check('owner labels', openLines.every(l => !/owner Owner \d{5,}/.test(l) && !/owner \d{6,}/.test(l)), 'full owner id in an open-deal line');
check('no open-deals header', !facts.context.includes('Open deals:'), 'account lines still say Open deals');

const py = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, "scripts")
from gtm_metrics import snapshot_metrics
ver = json.load(open("out/data/verified.json"))
rec = json.load(open("out/data/records.json"))
review = json.load(open("out/data/sheet-review.json"))
book = snapshot_metrics(ver, rec, today="${facts.today}", sheet_review=review)
kidde = [d for d in book["deals"] if "Renewal Agreement - 2027" in (d.get("dealName") or "") and d.get("amount") == 514800]
print(json.dumps({
  "today": book["today"],
  "collectedAt": book.get("collectedAt"),
  "openCount": book["openCount"],
  "openAmount": book["openAmount"],
  "weighted": book["weighted"],
  "leads": book["leads"],
  "mql": book["mql"],
  "sql": book["sql"],
  "renewalCount": book["renewalCount"],
  "renewalAmount": book["renewalAmount"],
  "onHoldCount": book["onHoldCount"],
  "onHoldAmount": book["onHoldAmount"],
  "hubspotOnlyCount": book["hubspotOnlyCount"],
  "largest": book["largest"],
  "kidde": [{"dealName": d["dealName"], "amount": d["amount"], "inOpenBook": d["inOpenBook"], "reason": d["reason"], "owner": d["ownerLabel"]} for d in kidde],
}))
`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const pyBook = JSON.parse(py);
check('python count', pyBook.openCount === metrics.openCount, String(pyBook.openCount));
check('python amount', pyBook.openAmount === metrics.openAmount, String(pyBook.openAmount));
check('python weighted', pyBook.weighted === metrics.weighted, String(pyBook.weighted));
check('python renewals', pyBook.renewalCount === metrics.renewalCount && pyBook.renewalAmount === metrics.renewalAmount, [pyBook.renewalCount, pyBook.renewalAmount].join('/'));
check('python on hold', pyBook.onHoldCount === 15 && pyBook.onHoldAmount === 1300000, [pyBook.onHoldCount, pyBook.onHoldAmount].join('/'));
check('python hubspot only', pyBook.hubspotOnlyCount === metrics.hubspotOnlyCount, String(pyBook.hubspotOnlyCount));
check('python funnel', pyBook.leads === metrics.leads && pyBook.mql === metrics.mql && pyBook.sql === metrics.sql, [pyBook.leads, pyBook.mql, pyBook.sql].join('/') + ' vs ' + [metrics.leads, metrics.mql, metrics.sql].join('/'));
check('certified day', certified.today === CERTIFIED_DAY, certified.today);
check('python largest', pyBook.largest && pyBook.largest.company === 'NXP' && pyBook.largest.amount === 500000 && pyBook.largest.owner === largest.owner, JSON.stringify(pyBook.largest));
check('python kidde', pyBook.kidde.length === 1 && pyBook.kidde[0].inOpenBook === false && pyBook.kidde[0].reason === 'renewal', JSON.stringify(pyBook.kidde));
check('python date', pyBook.today === facts.today, pyBook.today + ' vs ' + facts.today);
check('python collected', pyBook.collectedAt === metrics.collectedAt, String(pyBook.collectedAt));

const report = {
  ok: failures.length === 0,
  today: facts.today,
  tools: ASSISTANT_TOOL_NAMES,
  largestOpenDeal: { company: largest.company, dealName: largest.dealName, amount: largest.amountLabel, owner: largest.owner },
  openPipeline: { deals: metrics.openCount, open: metrics.openAmountLabel, weighted: metrics.weightedLabel },
  funnel: { leads: metrics.leads, mql: metrics.mql, sql: metrics.sql },
  collected: { at: metrics.collectedAt, label: metrics.collectedLabel },
  kiddeRenewal: renewal ? { dealName: renewal.dealName, amount: renewal.amountLabel, inOpenBook: renewal.inOpenBook, reason: renewal.reason } : null,
  pythonMatchesPage: failures.filter(f => f.startsWith('python')).length === 0,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
