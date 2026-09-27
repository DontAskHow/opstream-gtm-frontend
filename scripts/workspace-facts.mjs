// Open-book facts for the assistant and its tools.
// Numbers come from workspace-model.cjs, the same module the page uses.
// This file does not start a server and does not call a model.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const model = require('../workspace-model.cjs');

export const DATA_TOOL_NAMES = ['get_pipeline_metrics', 'lookup_deals'];

// Files the assistant context is built from. A request reloads when any of
// these change on disk. Missing files still count, so a later write reloads.
export const CONTEXT_FILES = ['verified.json', 'records.json', 'hollie.json', 'agent-brief.json', 'crm-proposals.json'];

export function dataRevision(dataDir) {
  return CONTEXT_FILES.map(name => {
    try {
      const st = fs.statSync(path.join(dataDir, name));
      return name + ':' + st.mtimeMs + ':' + st.size;
    } catch {
      return name + ':missing';
    }
  }).join('|');
}

export function needsReload(previous, current) {
  return !previous || previous !== current;
}

export function collectedLabel(generatedAt) {
  return generatedAt ? model.formatDateTime(generatedAt) : null;
}

export const ASSISTANT_TOOL_NAMES = [
  'get_pipeline_metrics',
  'lookup_deals',
  'create_draft',
  'propose_crm_update',
  'mark_queue_item',
  'read_briefing',
  'navigate',
];

export const DATA_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'get_pipeline_metrics',
      description: 'Read the open-book metrics already computed for the page: largest open deal, open pipeline count and amount, weighted pipeline, and quarter leads, MQL, and SQL. Open pipeline excludes past close dates, renewals, current agreements, Disqualified, and On Hold. Use this for pipeline size, the largest open deal, or lead counts. Repeat the result. Do not recompute it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_deals',
      description: 'Look up deals by company, deal name, or owner. Each result says whether it is in the open book. Renewals, current agreements, Disqualified, On Hold, and past close dates come back with inOpenBook false and a reason. Say that reason when you mention one. A renewal is not an open deal.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Company name, deal name, or owner label' },
        },
        required: ['query'],
      },
    },
  },
];

function money(value) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return null;
  return '$' + Math.round(n).toLocaleString('en-US');
}

function roundAmount(value) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return null;
  return Math.round(n);
}

export function exclusionReason(deal, today) {
  if (model.isOpenPipeline(deal, today)) return null;
  if (deal?.closed === true) return 'closed';
  if (model.isTestRecord(deal)) return 'verification fixture';
  const blob = (String(deal?.stage || deal?.stageLabel || '') + ' ' + String(deal?.dealName || '')).toLowerCase();
  if (/closed\s*won|closed\s*lost|closedwon|closedlost/.test(blob)) return 'closed won or lost';
  if (/disqualif/.test(blob)) return 'Disqualified';
  if (/\bon hold\b/.test(blob)) return 'On Hold';
  if (/current agreement/.test(blob)) return 'current agreement';
  if (/\brenewal\b/.test(blob)) return 'renewal';
  const close = model.dateOnly(deal?.close);
  if (close && today && close < today) return 'past close date';
  return 'excluded';
}

function statusTag(reason) {
  return reason ? 'NOT IN THE OPEN BOOK (' + reason + ')' : 'OPEN DEAL';
}

function ownerTail(resolved) {
  let tail = 4;
  const prefix = 'Owner #\u2026';
  for (const info of resolved.values()) {
    if (!info.named && String(info.label).startsWith(prefix)) tail = Math.max(tail, info.label.length - prefix.length);
  }
  return tail;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadWorkspace(dataDir) {
  const verified = readJson(path.join(dataDir, 'verified.json'));
  const records = readJson(path.join(dataDir, 'records.json'));
  let sheetReview = null;
  try { sheetReview = readJson(path.join(dataDir, 'sheet-review.json')); } catch { sheetReview = null; }
  return computeFacts(verified, records, null, sheetReview);
}

// One index for the whole extract. companyForOpportunity scans every company
// for every deal; doing that here would walk the snapshot hundreds of times.
function companyIndex(records) {
  const companies = records?.companies || [];
  const byDeal = new Map();
  const byId = new Map();
  const byName = new Map();
  for (const company of companies) {
    if (company && company.id != null && !byId.has(company.id)) byId.set(company.id, company);
    if (company && company.name && !byName.has(company.name)) byName.set(company.name, company);
    for (const deal of company?.deals || []) {
      if (!deal || deal.id == null) continue;
      let holders = byDeal.get(deal.id);
      if (!holders) { holders = []; byDeal.set(deal.id, holders); }
      holders.push(company);
    }
  }
  return { byDeal, byId, byName };
}

function companyForIndexed(opportunity, index) {
  if (!opportunity || !index) return null;
  const holders = index.byDeal.get(opportunity.id) || [];
  const named = holders.find(c => c.name === opportunity.name);
  if (named) return named;
  if (holders.length === 1) return holders[0];
  const id = String(opportunity.companyId || '').replace(/^company:/, '');
  return index.byId.get(id) || holders[0] || index.byName.get(opportunity.name) || null;
}

export function computeFacts(verified, records, today, sheetReview) {
  today = today || model.asOf(records?.generatedAt);
  const overrides = model.sheetOverrides(sheetReview);
  const annotated = model.annotateOpportunities(verified?.opportunities || [], records).map(o => model.applySheetDeal(o, overrides));
  const pipe = model.pipelineTotals(annotated, today);
  const bounds = model.periodBounds('quarter', null, null, today);
  const funnel = model.funnel(verified?.leads || [], records, bounds.start, bounds.end);
  const index = companyIndex(records);
  const quietByCompany = new Map();
  const quietFor = company => {
    if (!company) return null;
    const key = company.id != null ? company.id : company;
    if (quietByCompany.has(key)) return quietByCompany.get(key);
    const days = model.daysQuiet(company, today);
    quietByCompany.set(key, days);
    return days;
  };
  const linked = annotated.map(o => {
    const company = companyForIndexed(o, index);
    return { o, company, rawOwner: o.owner || company?.owner || '' };
  });
  const ownerValues = [
    ...linked.filter(x => model.listStatus(x.o, today) !== 'excluded').map(x => x.rawOwner),
    ...(verified?.leads || []).map(r => r.owner),
  ];
  const resolved = model.resolveOwners(ownerValues);
  const tail = ownerTail(resolved);
  const infoFor = raw => resolved.get(String(raw ?? '')) || model.ownerInfo(raw, tail);

  const deals = linked.map(({ o, company, rawOwner }) => {
    const reason = exclusionReason(o, today);
    const info = infoFor(rawOwner);
    const quiet = quietFor(company);
    return {
      id: o.id,
      company: model.pipelineCompanyName(company?.name, o.dealName, o.name),
      opportunityName: model.companyName(o.name),
      dealName: o.dealName || '',
      amount: roundAmount(o.amount),
      amountLabel: money(o.amount) || 'amount not entered',
      stage: model.stageDisplay(o.stage),
      close: model.dateOnly(o.close),
      owner: info.label,
      ownerTitle: info.title,
      daysQuiet: quiet,
      inOpenBook: !reason,
      reason: reason || 'open',
      tag: statusTag(reason),
    };
  });
  const byId = new Map(deals.filter(d => d.id).map(d => [d.id, d]));
  const largestRow = model.largestDeal(pipe.deals);
  const largest = largestRow ? deals.find(d => d.id === largestRow.id) || null : null;
  const metrics = {
    asOf: today,
    timezone: model.PHOENIX,
    definition: 'Open pipeline excludes past close dates, renewals, current agreements, Disqualified, and On Hold.',
    quarter: { start: bounds.start, end: bounds.end, label: bounds.label },
    openCount: pipe.count,
    openAmount: roundAmount(pipe.openAmount) ?? 0,
    openAmountLabel: money(pipe.openAmount) || '$0',
    weighted: pipe.weighted == null ? null : Math.round(pipe.weighted),
    weightedLabel: pipe.weighted == null ? null : money(pipe.weighted),
    leads: funnel.leads,
    mql: funnel.mql,
    sql: funnel.sql,
    collectedAt: records?.generatedAt || null,
    collectedLabel: collectedLabel(records?.generatedAt),
    largest: largest ? {
      company: largest.company,
      dealName: largest.dealName,
      amount: largest.amount,
      amountLabel: largest.amountLabel,
      stage: largest.stage,
      owner: largest.owner,
      close: largest.close,
      daysQuiet: largest.daysQuiet,
      inOpenBook: true,
      id: largest.id,
    } : null,
  };

  const lines = [];
  lines.push('DATA COLLECTED: ' + (metrics.collectedLabel || 'unknown') + ' (source timestamp ' + (metrics.collectedAt || 'unknown') + '). This is when the files on disk were generated. Repeat this timestamp when you give current figures. Do not describe the figures as newer than this collection.');
  lines.push('WORKSPACE DATA (real records from the company brain: HubSpot, Fathom, Sheets). Never invent records; say when something is not in the data.');
  lines.push('OPEN BOOK METRICS (America/Phoenix date ' + today + '). ' + metrics.definition + ' These figures are already computed. Repeat them. Do not calculate another open-pipeline total. A renewal, current agreement, On Hold, Disqualified, or past-close deal is not an open deal, even when its amount is larger.');
  if (metrics.largest) {
    const g = metrics.largest;
    lines.push('LARGEST OPEN DEAL: ' + g.company + ' — ' + (g.dealName || g.company) + ', ' + g.amountLabel + ', stage ' + g.stage + ', owner ' + g.owner + ', close ' + (g.close || 'not entered') + ', quiet days ' + (g.daysQuiet == null ? 'n/a' : g.daysQuiet) + '.');
  } else {
    lines.push('LARGEST OPEN DEAL: none.');
  }
  lines.push('OPEN PIPELINE: ' + metrics.openCount + ' deals, ' + metrics.openAmountLabel + ' open, ' + (metrics.weightedLabel || 'weighted n/a') + ' weighted.');
  lines.push('QUARTER ' + bounds.start + ' – ' + bounds.end + ': ' + funnel.leads + ' leads / ' + funnel.mql + ' MQL / ' + funnel.sql + ' SQL.');
  const marketing = model.marketingView(verified?.leads || [], records, verified?.report?.spend, today);
  lines.push('MARKETING BRIEF (America/Phoenix ' + today + '). Repeat these figures. Do not invent another weekly count.');
  for (const interval of marketing.intervals || []) {
    lines.push('- ' + interval.label + ': ' + interval.leads + ' leads, MQL ' + interval.mql + ', SQL ' + interval.sql + '. ' + interval.note);
  }
  for (const source of marketing.sources || []) {
    lines.push('- SOURCE ' + source.channel + ': this week ' + source.week + ', 6-week average ' + source.six + ', quarter ' + source.quarter + ', cost per lead ' + source.cpl + '.');
  }
  const byAmount = (a, b) => (b.amount || 0) - (a.amount || 0) || String(a.company).localeCompare(String(b.company));
  const describe = d => d.tag + ': ' + d.company + ' — ' + (d.dealName || d.company) + ', ' + d.amountLabel + ', stage ' + d.stage + ', owner ' + d.owner + ', close ' + (d.close || 'not entered') + ', quiet days ' + (d.daysQuiet == null ? 'n/a' : d.daysQuiet) + '.';
  for (const d of deals.filter(d => d.inOpenBook).sort(byAmount)) lines.push(describe(d));
  for (const d of deals.filter(d => !d.inOpenBook).sort(byAmount)) lines.push(describe(d));

  for (const c of records?.companies || []) {
    const dealBits = (c.deals || []).map(d => {
      const known = d.id && byId.get(d.id);
      const reason = known ? (known.inOpenBook ? null : known.reason) : exclusionReason({
        ...d,
        dealName: d.name || d.dealName || '',
        stage: d.stage || d.stageLabel || '',
        name: c.name,
      }, today);
      const tag = known ? known.tag : statusTag(reason);
      const amt = money(d.amount) || 'amount not entered';
      const stage = model.stageDisplay(d.stageLabel || d.stage);
      const who = infoFor(d.owner || c.owner).label;
      return (d.name || 'Untitled deal') + ' [' + tag + ', ' + stage + ', ' + amt + ', owner ' + who + ', close ' + (model.dateOnly(d.close) || 'not entered') + ']';
    });
    const contacts = (c.contacts || []).slice(0, 8).map(x => x.name + (x.title ? ' — ' + x.title : '') + (x.email ? ' <' + x.email + '>' : '')).join('; ');
    const quiet = quietFor(c);
    const owner = infoFor(c.owner).label;
    lines.push('- ACCOUNT ' + model.companyName(c.name) + ' (id ' + c.id + '): owner ' + owner + '; ' + [c.industry, c.domain].filter(Boolean).join(', ') + '. Deals: ' + (dealBits.join('; ') || 'none') + '. Quiet days: ' + (quiet == null ? 'n/a' : quiet) + '. Contacts: ' + (contacts || 'none') + '. Last contact: ' + (c.lastContact || 'n/a') + '.');
  }
  return { today, metrics, deals, context: lines.join('\n'), infoFor };
}

function metricsPayload(facts) {
  const m = facts.metrics;
  return {
    definition: m.definition,
    asOf: m.asOf,
    timezone: m.timezone,
    largestOpenDeal: m.largest,
    openCount: m.openCount,
    openAmount: m.openAmount,
    openAmountLabel: m.openAmountLabel,
    weighted: m.weighted,
    weightedLabel: m.weightedLabel,
    quarter: m.quarter,
    leads: m.leads,
    mql: m.mql,
    sql: m.sql,
    collectedAt: m.collectedAt,
    collectedLabel: m.collectedLabel,
  };
}

function lookupDeals(facts, query) {
  const q = String(query || '').trim().toLowerCase();
  const matches = !q ? [] : facts.deals.filter(d => [d.company, d.dealName, d.opportunityName, d.stage, d.owner].join(' ').toLowerCase().includes(q));
  matches.sort((a, b) => (b.amount || 0) - (a.amount || 0) || String(a.dealName).localeCompare(String(b.dealName)));
  return {
    query: String(query || ''),
    definition: facts.metrics.definition,
    matchCount: matches.length,
    deals: matches.slice(0, 20).map(d => ({
      company: d.company,
      dealName: d.dealName,
      amount: d.amount,
      amountLabel: d.amountLabel,
      stage: d.stage,
      owner: d.owner,
      close: d.close,
      daysQuiet: d.daysQuiet,
      inOpenBook: d.inOpenBook,
      reason: d.reason,
    })),
  };
}

export function runAssistantTool(name, args, facts) {
  const input = args || {};
  if (!facts && DATA_TOOL_NAMES.includes(name)) return JSON.stringify({ error: 'Workspace data unavailable.' });
  if (name === 'get_pipeline_metrics') return JSON.stringify(metricsPayload(facts));
  if (name === 'lookup_deals') return JSON.stringify(lookupDeals(facts, input.query));
  if (name === 'read_briefing') {
    return JSON.stringify({ ok: true, note: 'The morning brief is read by the server from agent-brief.json. Nothing was sent.' });
  }
  if (name === 'create_draft' || name === 'navigate' || name === 'propose_crm_update' || name === 'mark_queue_item') {
    return JSON.stringify({
      ok: true,
      tool: name,
      recorded: false,
      note: 'Action stays in the workspace. Nothing was sent and nothing was written to HubSpot.',
    });
  }
  return JSON.stringify({ error: 'Unknown tool', tool: name });
}
