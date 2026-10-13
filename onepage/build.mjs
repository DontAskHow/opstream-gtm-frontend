#!/usr/bin/env node
// One-page GTM workspace. Reads the JSON scripts/workspace-data.py writes and
// renders one self-contained index.html (inline CSS and JS, no network). No data
// lives in this file. Usage:
//   node onepage/build.mjs --data workspace.json --out <dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const page = require('./page.cjs');
const lostReasons = require('../workspace/src/lost-reasons.js');
const insightsLib = require('../workspace/src/insights.js');
const SCOPE = JSON.parse(readFileSync(join(HERE, '..', 'shared', 'workspace-scope.json'), 'utf8'));
const USAGE = 'Usage: node onepage/build.mjs --data <workspace.json> --out <output-dir>';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(data|out)(?:=(.*))?$/.exec(argv[i]);
    if (m) args[m[1]] = m[2] ?? argv[++i];
    else if (argv[i] === '--quiet') args.quiet = true;
    else throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!args.data || !args.out) throw new Error(USAGE);
  return { data: resolve(args.data), out: resolve(args.out), quiet: !!args.quiet };
}

// Lost reasons: lost-reasons.json decides the deals it lists; HubSpot's reason
// auto-maps the rest (workspace/src/lost-reasons.js, the one categorizer).
function lostView(closed) {
  const doc = closed.reasonsDoc;
  const checked = doc ? lostReasons.validate(doc) : null;
  const valid = checked && checked.ok ? doc : null;
  const pipeline = SCOPE.salesPipelineId;
  // New business only: a loss created after the company's first win is an expansion at a customer.
  const deals = closed.lost.filter((d) => !d.postWin).map((d) => ({ id: lostReasons.dealKey(d.id), lost: true, pipeline, name: d.name, amount: d.amount, lostReason: d.lostReason }));
  const cat = lostReasons.categorize({ closedLost: { pipeline }, deals }, valid);
  const stageOf = Object.fromEntries(closed.lost.map((d) => [d.id, d.stage]));
  const rows = cat.rows.map((r) => ({
    key: r.key, label: r.label, count: r.count, amount: r.amount, competitors: r.competitors, unnamed: r.unnamed,
    byStage: r.deals.reduce((a, d) => { const st = stageOf[d.id.replace(/^deal-/, '')]; a[st] = (a[st] || 0) + 1; return a; }, {}),
    deals: r.deals.map((d) => ({ ...d, id: d.id.replace(/^deal-/, ''), stage: stageOf[d.id.replace(/^deal-/, '')] })),
  }));
  const basis = !doc ? 'No lost-reasons.json given: every deal is auto-mapped from HubSpot\'s lost reason.'
    : !valid ? `lost-reasons.json did not pass validation (${checked.errors[0]}), so every deal is auto-mapped from HubSpot's lost reason.`
      : `${cat.fromFile} of ${cat.count} deals categorized by lost-reasons.json (generated ${page.dateTime(doc.generated_at)}); ${cat.auto} auto-mapped from HubSpot's lost reason.`;
  return { rows, basis, fromFile: cat.fromFile, count: cat.count };
}

function insightsView(doc) {
  if (!doc) return null;
  const r = insightsLib.validate(doc);
  return r.ok ? { ok: true, errors: [], doc } : { ok: false, errors: r.errors || ['invalid'], doc: null };
}

// The view model the page renders: workspace.json plus the lost-reason categories.
export function buildView(data) {
  const v = structuredClone(data);
  v.closed.reasons = v.closed.lost.length ? lostView(v.closed) : null;
  const cat = {};
  for (const r of v.closed.reasons?.rows || []) for (const d of r.deals) cat[d.id] = { label: r.label, basis: d.basis };
  for (const d of v.closed.lost) if (cat[d.id]) { d.lostCategory = cat[d.id].label; d.lostBasis = cat[d.id].basis; }
  delete v.closed.reasonsDoc;
  v.insights = insightsView(v.insights);
  const c = v.headline.change;
  if (c) c.key = `chg:${c.since}:${c.to.count}:${c.to.amount}`;
  return v;
}

const safeJson = (x) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderHtml(view) {
  const css = readFileSync(join(HERE, 'styles.css'), 'utf8');
  const js = readFileSync(join(HERE, 'page.cjs'), 'utf8');
  const { header, main, drawer } = page.renderPage(view, {});
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>GTM workspace</title>
<style>${css}</style>
</head>
<body>
${header}
<main id="main" tabindex="-1">${main}</main>
<div id="drawer-root">${drawer}</div>
<script type="application/json" id="gtm-data">${safeJson(view)}</script>
<script>${js}</script>
</body>
</html>
`;
}

// The hidden owner must not appear anywhere in what the page ships.
export function assertScrubbed(text, what) {
  const p = SCOPE.hiddenOwner.pattern.toLowerCase();
  const i = text.toLowerCase().indexOf(p);
  if (i !== -1) throw new Error(`scrub check failed: ${what} contains the hidden owner at offset ${i}`);
}

export function build(opts) {
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  if (!existsSync(opts.data)) throw new Error(`--data ${opts.data} not found (write it with scripts/workspace-data.py)`);
  const raw = readFileSync(opts.data, 'utf8');
  assertScrubbed(raw, opts.data);
  const view = buildView(JSON.parse(raw));
  const html = renderHtml(view);
  assertScrubbed(html, 'index.html');
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, 'index.html'), html);
  const h = view.headline;
  log(`wrote ${join(opts.out, 'index.html')} (${Math.round(html.length / 1024)} KB)`);
  log(`  headline: ${h.open.count} open, ${page.usd(h.open.amount)}, ${page.usd(h.open.weighted)} weighted; On Hold ${h.onHold.count}, ${page.usd(h.onHold.amount)}`);
  return { view, html };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
