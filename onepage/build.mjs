#!/usr/bin/env node
// One-page GTM view. Reads snapshot JSON from --data <dir>, writes a single
// self-contained index.html to --out <dir>. No data lives in this file.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TZ = 'America/Phoenix';
const TZ_LABEL = 'PT';
const DASH = '—';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data' || a === '--out') args[a.slice(2)] = argv[++i];
    else if (a.startsWith('--data=')) args.data = a.slice(7);
    else if (a.startsWith('--out=')) args.out = a.slice(6);
  }
  if (!args.data || !args.out) {
    console.error('Usage: node onepage/build.mjs --data <snapshot-dir> --out <output-dir>');
    process.exit(2);
  }
  return { data: resolve(args.data), out: resolve(args.out) };
}

function readJson(dir, file) {
  const p = join(dir, file);
  if (!existsSync(p)) {
    console.warn(`warn: ${file} not found; its panel will show missing values`);
    return null;
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------- formatting ----------
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function money(v) {
  if (!isNum(v)) return DASH;
  const sign = v < 0 ? '-' : '';
  const n = Math.abs(v);
  const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (n >= 1e9) return `${sign}$${trim((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `${sign}$${trim((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `${sign}$${Math.round(n / 1e3)}K`;
  return `${sign}$${Math.round(n)}`;
}

const int = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : DASH);
const pct = (num, den) => (isNum(num) && isNum(den) && den > 0 ? `${((num / den) * 100).toFixed(1)}%` : DASH);

function updated(iso) {
  if (!iso) return `Updated ${DASH}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `Updated ${DASH}`;
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(d);
  return `Updated ${s} ${TZ_LABEL}`;
}

// Today's calendar date (YYYY-MM-DD) in the display timezone.
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function shortDate(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return DASH;
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

const text = (v) => (v == null || v === '' ? DASH : esc(v));

function panel(title, updatedIso, body) {
  return `<section class="panel">
  <header><h2>${esc(title)}</h2><span class="updated">${esc(updated(updatedIso))}</span></header>
  ${body}
</section>`;
}

// ---------- panel 1: pipeline ----------
function pipelinePanel(records, facts) {
  const companies = Array.isArray(records?.companies) ? records.companies : [];
  const open = [];
  for (const c of companies) {
    for (const d of Array.isArray(c?.deals) ? c.deals : []) {
      if (!d?.closed && !/^(closed ?(won|lost)|closedwon|closedlost|disqualified|churn)$/i.test(String(d?.stageLabel || d?.stage || "").trim())) open.push({ company: c.name, deal: d });
    }
  }

  const stages = new Map();
  for (const { deal } of open) {
    const key = deal.stageLabel || deal.stage || DASH;
    const s = stages.get(key) || { stage: key, count: 0, amount: 0, priced: 0 };
    s.count++;
    if (isNum(deal.amount)) { s.amount += deal.amount; s.priced++; }
    stages.set(key, s);
  }
  // The snapshot carries no stage-order field, so pipeline order is not
  // inferable: sort by total amount desc, then count desc.
  const stageRows = [...stages.values()].sort((a, b) => b.amount - a.amount || b.count - a.count);
  const recordsTotal = stageRows.reduce((a, s) => a + s.amount, 0);

  const today = todayISO();
  const top = open
    .filter(({ deal }) => isNum(deal.amount))
    .sort((a, b) => b.deal.amount - a.deal.amount)
    .slice(0, 8);

  const headline = `<div class="kpis">
    <div class="kpi"><span class="kpi-v">${int(facts?.openCount)}</span><span class="kpi-l">Open deals</span></div>
    <div class="kpi"><span class="kpi-v">${money(facts?.openAmount)}</span><span class="kpi-l">Open amount</span></div>
    <div class="kpi"><span class="kpi-v">${money(facts?.weighted)}</span><span class="kpi-l">Weighted</span></div>
  </div>
  <p class="note">Headline: run facts, ${esc(updated(facts?.collectedAt))}.</p>`;

  const mismatch =
    isNum(facts?.openCount) && facts.openCount !== open.length
      ? `<p class="note warn">The stage table counts every CRM deal not marked closed, won, lost, disqualified or churned (${int(open.length)} deals, ${money(recordsTotal)}). That's broader than the run-facts headline (${int(facts.openCount)} deals), so treat stage totals as unreconciled.</p>`
      : '';

  const stageTable = stageRows.length
    ? `<table>
    <thead><tr><th>Stage</th><th class="n">Deals</th><th class="n">Amount</th></tr></thead>
    <tbody>${stageRows
      .map((s) => `<tr><td>${esc(s.stage)}</td><td class="n">${int(s.count)}</td><td class="n">${s.priced ? money(s.amount) : DASH}</td></tr>`)
      .join('')}</tbody>
  </table>`
    : `<p class="empty">No open deals in the data.</p>`;

  const topTable = top.length
    ? `<table class="deals">
    <thead><tr><th>Company / deal</th><th>Stage</th><th class="n">Amount</th><th class="n">Close</th></tr></thead>
    <tbody>${top
      .map(({ company, deal }) => {
        const past = deal.close && deal.close.slice(0, 10) < today;
        return `<tr><td><div class="co">${text(company)}</div><div class="sub">${text(deal.name)}</div></td><td>${text(deal.stageLabel || deal.stage)}</td><td class="n">${money(deal.amount)}</td><td class="n${past ? ' past' : ''}">${shortDate(deal.close)}${past ? ' <span class="flag" title="Close date has passed">past</span>' : ''}</td></tr>`;
      })
      .join('')}</tbody>
  </table>`
    : `<p class="empty">No open deals with an amount.</p>`;

  return panel(
    'Pipeline by stage',
    records?.generatedAt,
    `${headline}${mismatch}${stageTable}<h3>Deals that matter</h3>${topTable}`,
  );
}

// ---------- panel 2: campaigns ----------
function campaignsPanel(marketing) {
  const outbound = marketing?.outbound;
  const running = (Array.isArray(outbound?.campaignStats) ? outbound.campaignStats : [])
    .filter((c) => c?.status === 'running')
    .sort((a, b) => (isNum(b.sent) ? b.sent : -1) - (isNum(a.sent) ? a.sent : -1));

  const allOpensZero = running.length > 0 && running.every((c) => !c.opened);
  // opened = 0 means open tracking is off for that campaign, not zero opens.
  const opens = (v) => (isNum(v) && v > 0 ? int(v) : DASH);

  const table = running.length
    ? `<table>
    <thead><tr><th>Campaign</th><th class="n">Sent</th><th class="n">Delivered</th><th class="n">Opens</th><th class="n">Replied</th><th class="n">Reply rate</th><th class="n">Bounced</th><th class="n">Meetings</th></tr></thead>
    <tbody>${running
      .map((c) => `<tr><td>${text(c.name)}</td><td class="n">${int(c.sent)}</td><td class="n">${int(c.delivered)}</td><td class="n">${opens(c.opened)}</td><td class="n">${int(c.replied)}</td><td class="n">${pct(c.replied, c.delivered)}</td><td class="n">${int(c.bounced)}</td><td class="n">${int(c.meetings)}</td></tr>`)
      .join('')}</tbody>
  </table>
  <p class="note">${allOpensZero ? 'Open tracking is off for all running campaigns.' : 'Opens “—” = open tracking off (reported as 0).'} Reply rate = replied ÷ delivered.</p>`
    : `<p class="empty">No running campaigns in the data.</p>`;

  const ads = Array.isArray(marketing?.ads) ? marketing.ads : [];
  const adsTable = ads.length
    ? `<h3>Paid ads</h3><table class="compact">
    <thead><tr><th>Ad account</th><th class="n">Spend</th><th class="n">Clicks</th><th class="n">Conv.</th><th>Window</th></tr></thead>
    <tbody>${ads
      .map((a) => `<tr><td>${text(a.name)}</td><td class="n">${money(a.spend)}</td><td class="n">${int(a.clicks)}</td><td class="n">${int(a.conversions)}</td><td class="sub">${text(a.window)}</td></tr>`)
      .join('')}</tbody>
  </table>`
    : '';

  return panel('Active campaigns & results', outbound?.fetchedAt, table + adsTable);
}

// ---------- panel 3: content ----------
function contentPanel(marketing) {
  return panel(
    'Upcoming content',
    marketing?.generatedAt,
    `<div class="empty-state">No content calendar in the data yet — nothing to show.</div>`,
  );
}

// ---------- panel 4: this week ----------
function weekPanel(brief) {
  const asLine = (v) => (typeof v === 'string' ? v : v?.title || v?.text || '');
  const sources = [brief?.whatsNew, brief?.topActions, brief?.watchOuts];
  const seen = new Set();
  const lines = [];
  for (const list of sources) {
    for (const item of Array.isArray(list) ? list : []) {
      const line = asLine(item).trim();
      const key = line.toLowerCase().replace(/\s+/g, ' ');
      if (!line || seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  const five = lines.slice(0, 5);
  const body = five.length
    ? `<ol class="week">${five.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>${five.length < 5 ? `<p class="note">Only ${five.length} item(s) in the brief.</p>` : ''}`
    : `<p class="empty">No brief items in the data.</p>`;
  return panel('This week', brief?.generatedAt, body);
}

// ---------- page ----------
const CSS = `
*{box-sizing:border-box}
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c2430;--muted:#667085;--line:#e6e8ec;--accent:#2f5bd3;--warn:#b42318;--warnbg:#fef3f2}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1440px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;min-width:0;overflow-x:auto}
.panel header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--line)}
h2{margin:0;font-size:16px;font-weight:600}
h3{margin:18px 0 6px;font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.updated{font-size:12px;color:var(--muted);white-space:nowrap}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;font-weight:600;color:var(--muted)}
tbody tr:last-child td{border-bottom:0}
.n{text-align:right;white-space:nowrap}
.co{font-weight:600}
.sub{color:var(--muted);font-size:12px}
.past{color:var(--warn)}
.flag{display:inline-block;margin-left:4px;padding:0 6px;border-radius:999px;background:var(--warnbg);color:var(--warn);font-size:11px;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.kpi{background:var(--bg);border-radius:8px;padding:10px 12px}
.kpi-v{display:block;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.kpi-l{font-size:12px;color:var(--muted)}
.note{margin:8px 0 0;font-size:12px;color:var(--muted)}
.note.warn{color:var(--warn);background:var(--warnbg);padding:6px 8px;border-radius:6px}
.empty,.empty-state{color:var(--muted)}
.empty-state{display:flex;align-items:center;justify-content:center;text-align:center;min-height:160px;border:1px dashed var(--line);border-radius:8px;padding:16px}
.week{margin:0;padding-left:20px}
.week li{margin:0 0 10px}
.compact td,.compact th{padding:4px 8px}
footer{max-width:1440px;margin:0 auto;padding:0 24px 24px;font-size:12px;color:var(--muted)}
@media (max-width:900px){main{grid-template-columns:1fr;padding:12px;gap:12px}.panel{padding:14px}footer{padding:0 12px 16px}}
@media (max-width:480px){.kpi-v{font-size:18px}.kpis{gap:8px}table{font-size:12px}th,td{padding:5px 4px}th{font-size:11px}.sub{font-size:11px}.panel{padding:12px}.flag{display:none}}
`;

function render({ records, marketing, brief, facts }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>GTM one-page</title>
<style>${CSS}</style>
</head>
<body>
<main>
${pipelinePanel(records, facts)}
${campaignsPanel(marketing)}
${contentPanel(marketing)}
${weekPanel(brief)}
</main>
<footer>Built ${esc(updated(new Date().toISOString()).replace('Updated ', ''))} from snapshot data. Missing values show “—”.</footer>
</body>
</html>
`;
}

const { data, out } = parseArgs(process.argv.slice(2));
const html = render({
  records: readJson(data, 'records.json'),
  marketing: readJson(data, 'marketing.json'),
  brief: readJson(data, 'agent-brief.json'),
  facts: readJson(data, 'run-facts.json'),
});
mkdirSync(out, { recursive: true });
const file = join(out, 'index.html');
writeFileSync(file, html);
console.log(`wrote ${file} (${Buffer.byteLength(html)} bytes)`);
