// Turns snapshot JSON (and, when given, the HubSpot reconciliation export)
// into the one object the browser app reads as window.GTM_DATA.
// Pure functions over parsed inputs; build.mjs does the file I/O.
// Nothing here estimates a number: a missing value stays null and the app
// shows "—" or a labelled empty state.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../workspace-model.cjs');

export const TZ = 'America/Phoenix';

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (v == null || v === '' ? null : String(v));
const numText = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const dealKey = (id) => (id == null ? null : 'deal-' + String(id).replace(/^deal-/, ''));
const bareId = (id) => String(id ?? '').replace(/^deal-/, '');

// Open / On Hold / closed and the headline pipeline come from pipeline-def.json via
// workspace-model.cjs, the same rule scripts/gtm_metrics.py reads. Nothing here
// decides it from a stage name.
const HEADLINE_KIND = model.PIPELINE_DEF.headlineKind;
const status = (closed, stageLabel) => model.pipelineStatus({ closed, stageLabel });

export function phoenixDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

// CRM notes arrive as HTML. Reduce them to plain text (the app never injects
// data as HTML); the wording is kept as-is.
export function htmlToText(html) {
  if (html == null) return null;
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// "COMPUTER_SOFTWARE" -> "Computer software". The segment is the HubSpot
// company industry.
export const SEGMENT_FIELD = 'industry';
export const segmentOf = (company) => (company ? model.humanEnum(company.industry) || 'Industry not set' : 'No account in snapshot');

function projectRecording(r) {
  return {
    id: str(r.id), title: str(r.title), date: str(r.date), minutes: num(r.minutes), recordedBy: str(r.recordedBy),
    invitees: arr(r.invitees).length,
    summary: arr(r.summary).map((s) => ({ t: str(s?.t), x: str(s?.x) })).filter((s) => s.x),
    actions: arr(r.actions).filter((a) => typeof a === 'string'),
    hasTranscript: !!r.hasTranscript, transcriptLines: num(r.transcriptLines),
  };
}

// ---------- pipeline from the HubSpot reconciliation export ----------

// live_deals.json: {pipes: id -> label, stages: id -> {pipe, label, closed, prob}, deals: [{id, properties}]}.
// JSON.parse puts integer-like keys (most stage ids) first, so the export's key
// order is not HubSpot's display order. Stages are ordered by HubSpot's own
// stage probability metadata instead: open stages low to high, closed stages after.
export function hubspotPipelines(live) {
  const pipeIdByLabel = new Map(Object.entries(live?.pipes || {}).map(([id, label]) => [label, id]));
  const pipelines = new Map();
  for (const [sid, s] of Object.entries(live?.stages || {})) {
    const label = String(s.pipe ?? 'Pipeline not recorded');
    if (!pipelines.has(label)) {
      const id = pipeIdByLabel.get(label) ?? label;
      pipelines.set(label, { id, label, kind: model.pipelineKind({ pipeline: id, pipelineLabel: label }) || 'unknown', stages: [] });
    }
    pipelines.get(label).stages.push({
      id: sid, label: String(s.label ?? '').trim() || 'No stage', closed: s.closed === true,
      // HubSpot stage probability is a 0–1 fraction.
      probability: model.probabilityFromScale(s.prob, 'fraction'),
    });
  }
  const byProb = (a, b) => (a.closed - b.closed) || ((a.probability ?? 2) - (b.probability ?? 2)) * (a.closed ? -1 : 1);
  for (const p of pipelines.values()) p.stages.sort(byProb);
  return [...pipelines.values()];
}

export function hubspotDeals(live, { owners, recordsDeals }) {
  const stages = live?.stages || {};
  const pipes = live?.pipes || {};
  return arr(live?.deals).map((d) => {
    const p = d.properties || {};
    const s = stages[p.dealstage];
    const pipeLabel = s?.pipe ?? pipes[p.pipeline] ?? null;
    const stageLabel = s ? String(s.label).trim() : null;
    // Closed comes from the stage's isClosed metadata; hs_is_closed only when the stage is not in the catalog.
    const closed = s ? s.closed === true : String(p.hs_is_closed).toLowerCase() === 'true';
    const rec = recordsDeals.get(dealKey(d.id));
    const ownerName = owners[String(p.hubspot_owner_id ?? '')] ?? null;
    const st = status(closed, stageLabel);
    return {
      id: dealKey(d.id), name: str(p.dealname) ?? 'Untitled deal', companyId: rec?.companyId ?? null,
      pipelineId: str(p.pipeline) ?? pipeLabel, pipeline: pipeLabel ?? 'Pipeline not recorded',
      stageId: str(p.dealstage), stage: stageLabel ?? 'Stage not in catalog', closed,
      open: st !== 'closed', onHold: st === 'onHold',
      amount: numText(p.amount),
      probability: model.probabilityFromScale(numText(p.hs_deal_stage_probability), 'fraction'),
      close: day(p.closedate), created: day(p.createdate),
      owner: ownerName ?? rec?.owner ?? (p.hubspot_owner_id ? 'Owner not in owners list' : 'Unassigned'),
      inRecords: !!rec, source: 'hubspot',
      historyCount: rec ? rec.historyCount : 0,
    };
  });
}

// ---------- pipeline from records.json only (no reconciliation export) ----------

function recordsOnlyDeals(recordsDeals) {
  return [...recordsDeals.values()].map((d) => {
    const st = status(d.closed, d.stageLabel);
    return {
      id: d.id, name: d.name ?? 'Untitled deal', companyId: d.companyId,
      pipelineId: 'records', pipeline: 'All pipelines (pipeline not recorded in records.json)',
      stageId: d.stage, stage: d.stageLabel ?? 'Stage not labelled', closed: !!d.closed,
      open: st !== 'closed', onHold: st === 'onHold',
      amount: d.amount,
      // records.json stores probability as 0–100 percent.
      probability: model.probabilityFromScale(d.probability, 'percent'),
      close: day(d.close), created: day(d.created), owner: d.owner ?? 'Unassigned',
      inRecords: true, source: 'records', historyCount: d.historyCount,
    };
  });
}

function recordsOnlyPipelines(deals) {
  const stages = new Map();
  for (const d of deals) if (!stages.has(d.stage)) stages.set(d.stage, { id: d.stageId, label: d.stage, closed: !d.open, probability: null });
  return [{ id: 'records', label: deals[0]?.pipeline ?? 'All pipelines', kind: 'unknown', stages: [...stages.values()] }];
}

// Totals over open, non-On-Hold deals plus On Hold separately, per pipeline.
// Weighted = amount × probability over deals with both; the rest are counted.
export function pipelineFigures(pipelines, deals) {
  const round = (t) => ({ ...t, openAmount: Math.round(t.openAmount * 100) / 100, weighted: Math.round(t.weighted * 100) / 100 });
  return pipelines.map((p) => {
    const inPipe = deals.filter((d) => d.pipeline === p.label && d.open);
    const active = inPipe.filter((d) => !d.onHold);
    const hold = inPipe.filter((d) => d.onHold);
    return { id: p.id, label: p.label, kind: p.kind, active: round(model.openTotals(active)), onHold: round(model.openTotals(hold)) };
  });
}

// The headline is the one pipeline of pipeline-def.json's headline kind (new business).
function headline(figures) {
  const nb = figures.filter((f) => f.kind === HEADLINE_KIND);
  if (nb.length !== 1) return null;
  return { pipeline: nb[0].label, ...nb[0] };
}

// --expect "count=<n>,amount=<n>,weighted=<n>,holdCount=<n>,holdAmount=<n>" (figures stay on the command line, never in the repo)
export function parseExpect(text) {
  if (!text) return null;
  const out = {};
  for (const part of String(text).split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k) continue;
    const n = Number(v);
    if (!['count', 'amount', 'weighted', 'holdCount', 'holdAmount', 'noProbability'].includes(k) || !Number.isFinite(n)) {
      throw new Error(`bad --expect entry "${part}"`);
    }
    out[k] = n;
  }
  return out;
}

export function checkExpect(head, expect) {
  if (!expect || !head) return { checked: false, matches: false, rows: [] };
  const actual = {
    count: head.active.count, amount: head.active.openAmount, weighted: head.active.weighted,
    holdCount: head.onHold.count, holdAmount: head.onHold.openAmount, noProbability: head.active.noProbabilityCount,
  };
  const rows = Object.entries(expect).map(([k, want]) => ({ key: k, want, got: actual[k], ok: Math.abs(actual[k] - want) < 0.005 }));
  return { checked: true, matches: rows.length > 0 && rows.every((r) => r.ok), rows };
}

// ---------- data quality: Sheet vs HubSpot ----------

export function dataQuality({ sheetReview, deals, source }) {
  const sheet = arr(sheetReview?.deals);
  const byId = new Map(deals.map((d) => [d.id, d]));
  const sheetIds = new Set(sheet.map((s) => dealKey(s.id)));
  const sheetRow = (s, d) => ({
    id: dealKey(s.id), name: str(s.name) ?? d?.name ?? null, sheetStage: str(s.stage),
    hubspotStage: d?.stage ?? null, hubspotPipeline: d?.pipeline ?? null,
    amount: num(s.amount) ?? d?.amount ?? null, owner: str(s.owner) ?? d?.owner ?? null,
  });
  const active = sheet.filter((s) => model.sheetClassName(s.stage) === 'active');
  const closedButActive = [], otherDiffs = [], notInHubspot = [];
  for (const s of active) {
    const d = byId.get(dealKey(s.id));
    if (!d) notInHubspot.push(sheetRow(s, null));
    else if (d.closed) closedButActive.push(sheetRow(s, d));
    else if (d.onHold || model.pipelineKind({ pipelineLabel: d.pipeline }) !== HEADLINE_KIND && source === 'hubspot') otherDiffs.push(sheetRow(s, d));
  }
  // Only the HubSpot export knows each deal's pipeline, so only it can say which new-business deals are missing.
  const missingFromSheet = source === 'hubspot'
    ? deals.filter((d) => d.open && !d.onHold && model.pipelineKind({ pipelineLabel: d.pipeline }) === HEADLINE_KIND && !sheetIds.has(d.id))
      .map((d) => ({ id: d.id, name: d.name, hubspotStage: d.stage, amount: d.amount, owner: d.owner, close: d.close }))
    : null;
  return {
    sheetGeneratedAt: str(sheetReview?.generatedAt), sheetActiveCount: active.length, sheetDealCount: sheet.length,
    closedButActive, missingFromSheet, otherDiffs, notInHubspot,
  };
}

// ---------- everything ----------

export function buildData(inp) {
  const { records, marketing, brief, operator, sheetReview, recon, expect, transcripts = [] } = inp;
  const owners = records?.owners || {};

  const companies = [];
  const recordsDeals = new Map();
  for (const c of arr(records?.companies)) {
    const id = str(c.id);
    if (!id) continue;
    const dealIds = [];
    for (const d of arr(c.deals)) {
      const did = dealKey(d.id);
      if (!did) continue;
      dealIds.push(did);
      recordsDeals.set(did, {
        id: did, companyId: id, name: str(d.name), stage: str(d.stage), stageLabel: str(d.stageLabel),
        amount: num(d.amount), probability: num(d.probability), close: str(d.close), created: str(d.created),
        owner: str(d.owner), closed: !!d.closed,
        historyCount: arr(d.history).length + arr(d.amountHistory).length + arr(d.closeHistory).length,
        history: [...arr(d.history), ...arr(d.amountHistory), ...arr(d.closeHistory)],
      });
    }
    companies.push({
      id, name: str(c.name) ?? 'Company not named', owner: str(c.owner), domain: str(c.domain),
      industry: str(c.industry), segment: segmentOf(c), lifecycle: str(c.lifecycle), employees: num(c.employees),
      city: str(c.city), country: str(c.country), created: str(c.created), lastContact: str(c.lastContact),
      description: str(c.description), dealIds,
      contactCount: arr(c.contacts).length, emailCount: num(c.emails?.count), callCount: arr(c.calls).length,
      notes: arr(c.notes).map((n) => ({ id: str(n.id), date: str(n.date), owner: str(n.owner), text: htmlToText(n.text) }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
      meetings: arr(c.meetings).map((m) => ({
        id: str(m.id), title: str(m.title), start: str(m.start), outcome: str(m.outcome), owner: str(m.owner),
        invitees: arr(m.invitees).length,
      })).sort((a, b) => String(b.start).localeCompare(String(a.start))),
      recordings: arr(c.recordings).map(projectRecording).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    });
  }
  const companyById = new Map(companies.map((c) => [c.id, c]));

  const source = recon?.live ? 'hubspot' : 'records';
  let deals, pipelines;
  if (source === 'hubspot') {
    deals = hubspotDeals(recon.live, { owners, recordsDeals });
    pipelines = hubspotPipelines(recon.live);
  } else {
    deals = recordsOnlyDeals(recordsDeals);
    pipelines = recordsOnlyPipelines(deals);
  }
  const notInExport = source === 'hubspot' ? [...recordsDeals.keys()].filter((id) => !deals.some((d) => d.id === id)) : [];
  const sheetById = new Map(arr(sheetReview?.deals).map((s) => [dealKey(s.id), s]));
  for (const d of deals) {
    const c = d.companyId ? companyById.get(d.companyId) : null;
    d.account = c?.name ?? null;
    d.segment = segmentOf(c);
    const s = sheetById.get(d.id);
    d.sheet = s ? { stage: str(s.stage), amount: num(s.amount), close: str(s.close), owner: str(s.owner), probability: num(s.probability) } : null;
  }

  const figures = pipelineFigures(pipelines, deals);
  const head = headline(figures);
  const expectCheck = checkExpect(head, expect);
  const quality = dataQuality({ sheetReview, deals, source });
  const recordsOpen = [...recordsDeals.values()].filter((d) => !d.closed).length;
  // The Sheet-to-HubSpot bridge holds when Sheet-active − closed in HubSpot − other differences + missing = HubSpot count.
  const bridge = head && quality.missingFromSheet
    ? quality.sheetActiveCount - quality.closedButActive.length - quality.otherDiffs.length - quality.notInHubspot.length + quality.missingFromSheet.length
    : null;

  const history = {
    deals: recordsDeals.size,
    withHistory: [...recordsDeals.values()].filter((d) => d.historyCount > 0).length,
    entries: [...recordsDeals.values()].flatMap((d) => d.history.map((h) => ({ dealId: d.id, deal: d.name, ...h }))),
  };

  const mk = marketing || {};
  const projectLeads = (l) => ({ count: num(l?.count), mql: num(l?.mql), sql: num(l?.sql) });
  const asOf = phoenixDate(records?.generatedAt) ?? phoenixDate(new Date().toISOString());

  return {
    builtAt: new Date().toISOString(),
    asOf,
    segmentField: SEGMENT_FIELD,
    times: {
      records: str(records?.generatedAt), marketing: str(mk.generatedAt),
      outbound: str(mk.outbound?.fetchedAt), web: str(mk.web?.fetchedAt), brief: str(brief?.generatedAt),
      operator: str(operator?.generatedAt), sheet: str(sheetReview?.generatedAt), recon: str(recon?.fetchedAt),
    },
    sources: arr(mk.sources).map((s) => ({ source: str(s.source), label: str(s.label) ?? str(s.source), ok: !!s.ok, at: str(s.at), lastOkAt: str(s.lastOkAt), detail: str(s.detail) })),
    pipelineSource: source,
    definition: model.PIPELINE_DEF.definition,
    recordsOpenCount: recordsOpen,
    recordsDealCount: recordsDeals.size,
    pipelines, figures, headline: head, expect: expectCheck, bridge, notInExport: notInExport.length,
    quality,
    deals, companies, history,
    unmatchedRecordings: arr(records?.unmatchedRecordings).length,
    outbound: mk.outbound ? {
      byStatus: mk.outbound.byStatus || null,
      campaigns: arr(mk.outbound.campaignStats).map((c) => ({
        id: str(c.campaignId), name: str(c.name), status: str(c.status), sent: num(c.sent), delivered: num(c.delivered),
        opened: num(c.opened), replied: num(c.replied), bounced: num(c.bounced), meetings: num(c.meetings),
      })),
    } : null,
    ads: arr(mk.ads).map((a) => ({
      name: str(a.name), spend: num(a.spend), impressions: num(a.impressions), clicks: num(a.clicks),
      conversions: num(a.conversions), window: str(a.window),
    })),
    spend: mk.spend ? {
      connected: !!mk.spend.connected, source: str(mk.spend.source), lastEnteredMonth: str(mk.spend.lastEnteredMonth),
      missingMonths: arr(mk.spend.missingMonths).map(String),
      months: arr(mk.spend.months).map((m) => ({ month: str(m.month), label: str(m.label), planned: num(m.planned), actual: num(m.actual) })),
      channels: arr(mk.spend.channels).map((c) => ({ name: str(c.name), amount: num(c.amount) })),
    } : null,
    shows: mk.shows ? {
      source: str(mk.shows.source),
      items: arr(mk.shows.items).map((s) => ({
        id: str(s.id), name: str(s.name), dateLabel: str(s.dateLabel), start: str(s.start), end: str(s.end),
        location: str(s.location), status: str(s.status), leads: projectLeads(s.leads), meetingRequests: projectLeads(s.meetingRequests),
      })),
      eventRoi: arr(mk.shows.eventRoi?.rows).map((r) => ({
        name: str(r.name), shows: arr(r.shows).length, planned: num(r.planned), paid: num(r.paid),
        leads: num(r.leads), mql: num(r.mql), sql: num(r.sql), end: str(r.end),
      })),
    } : null,
    brief: brief ? {
      whatsNew: arr(brief.whatsNew).filter((s) => typeof s === 'string'),
      topActions: arr(brief.topActions).map((a) => str(a?.title)).filter(Boolean),
      watchOuts: arr(brief.watchOuts).filter((s) => typeof s === 'string'),
    } : null,
    operator: operator ? {
      briefMeetings: arr(operator.brief?.meetings?.items).map((m) => ({
        meetingId: str(m.meetingId), title: str(m.title), start: str(m.start), companyId: str(m.companyId), company: str(m.company),
      })),
      prep: arr(operator.prep).map((p) => ({
        meetingId: str(p.meetingId), title: str(p.title), start: str(p.start), outcome: str(p.outcome),
        companyId: str(p.companyId), company: str(p.company), callGoal: str(p.callGoal),
        attendees: arr(p.attendees).map((a) => ({ name: str(a.name), title: str(a.title) })),
        lastCall: p.lastCall ? {
          recordingId: str(p.lastCall.recordingId), title: str(p.lastCall.title), date: str(p.lastCall.date),
          summary: arr(p.lastCall.summary).filter((s) => typeof s === 'string'),
          takeaways: arr(p.lastCall.takeaways).filter((s) => typeof s === 'string'),
          actions: arr(p.lastCall.actions).filter((s) => typeof s === 'string'),
        } : null,
        unresolvedActions: arr(p.unresolvedActions).map((a) => ({ action: str(a?.action), from: str(a?.from), date: str(a?.date) })).filter((a) => a.action),
        suggestedAgenda: arr(p.suggestedAgenda).filter((s) => typeof s === 'string'),
      })),
    } : null,
    transcripts,
  };
}

// A short, deterministic text report of the pipeline figures for the build log.
export function figuresReport(data) {
  const usd = (v) => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'));
  // A total over deals that all lack an amount is unknown, not $0.
  let t = null;
  const money = (v) => (t && t.count > 0 && t.noAmountCount === t.count ? '— (no amounts)' : usd(v));
  const lines = [`pipeline source: ${data.pipelineSource === 'hubspot' ? 'HubSpot reconciliation export (--recon)' : 'records.json (no --recon)'}`];
  for (const f of data.figures) {
    t = f.active;
    const active = `  ${f.label} [${f.kind}]: open excl On Hold ${f.active.count} deals, ${money(f.active.openAmount)} open, ` +
      `${money(f.active.weighted)} weighted, ${f.active.noProbabilityCount} without probability, ${f.active.noAmountCount} without amount; `;
    t = f.onHold;
    lines.push(active + `On Hold ${f.onHold.count} deals, ${money(f.onHold.openAmount)}`);
    t = null;
  }
  lines.push(`  records.json open deals (HubSpot stage not closed, all pipelines): ${data.recordsOpenCount} of ${data.recordsDealCount}`);
  return lines.join('\n');
}
