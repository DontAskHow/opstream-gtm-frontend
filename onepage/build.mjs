#!/usr/bin/env node
// One-page GTM workspace. Two outputs, one set of components (page.cjs, view.cjs):
//   --app                 index.html with NO data: it fetches workspace.json (and refresh.json)
//                         from its own origin and renders client-side. This is what is deployed;
//                         the preview refresh Lambda keeps workspace.json current.
//   --data workspace.json index.html with the data inside (local previews, tests).
// No data lives in this file.
//   node onepage/build.mjs --app --out <dir>
//   node onepage/build.mjs --data workspace.json --out <dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const page = require('./page.cjs');
const { buildView: viewOf } = require('./view.cjs');
const USAGE = 'Usage: node onepage/build.mjs (--app | --data <workspace.json>) --out <output-dir>';
export const DATA_FILE = 'workspace.json';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(data|out)(?:=(.*))?$/.exec(argv[i]);
    if (m) args[m[1]] = m[2] ?? argv[++i];
    else if (argv[i] === '--quiet') args.quiet = true;
    else if (argv[i] === '--app') args.app = true;
    else throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
  }
  if ((!args.data && !args.app) || (args.data && args.app) || !args.out) throw new Error(USAGE);
  return { data: args.data ? resolve(args.data) : null, app: !!args.app, out: resolve(args.out), quiet: !!args.quiet };
}

export const buildView = (data, refresh) => viewOf(data, refresh);

// Scrub patterns are never in the repo: WORKSPACE_SCRUB_PATTERNS (comma list), else the file
// WORKSPACE_SCRUB_PATTERNS_FILE (comma- or line-separated). Same rules as scripts/workspace-data.py.
export function scrubPatterns(env = process.env) {
  let raw = env.WORKSPACE_SCRUB_PATTERNS || '';
  if (!raw.trim() && env.WORKSPACE_SCRUB_PATTERNS_FILE && existsSync(env.WORKSPACE_SCRUB_PATTERNS_FILE)) raw = readFileSync(env.WORKSPACE_SCRUB_PATTERNS_FILE, 'utf8');
  return [...new Set(raw.split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter((x) => x && !x.startsWith('#')))];
}

// A scrubbed person must not appear anywhere in what the page ships. Without patterns, refuse.
export function assertScrubbed(text, what, patterns = scrubPatterns()) {
  if (!patterns.length) throw new Error('scrub check failed: no scrub patterns (set WORKSPACE_SCRUB_PATTERNS or WORKSPACE_SCRUB_PATTERNS_FILE)');
  const low = text.toLowerCase();
  for (const p of patterns) {
    const i = low.indexOf(p);
    if (i !== -1) throw new Error(`scrub check failed: ${what} contains a scrub pattern at offset ${i}`);
  }
}

const safeJson = (x) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const asset = (f) => readFileSync(join(HERE, f), 'utf8');

function shell({ csp, header, main, drawer, data, scripts }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>GTM workspace</title>
<style>${asset('styles.css')}</style>
</head>
<body>
${header}
<main id="main" tabindex="-1">${main}</main>
<div id="drawer-root">${drawer}</div>
${data == null ? '' : `<script type="application/json" id="gtm-data">${safeJson(data)}</script>\n`}${scripts.map((s) => `<script>${s}</script>`).join('\n')}
</body>
</html>
`;
}

// The built page: data inside, no network.
export function renderHtml(view, opts = {}) {
  const { header, main, drawer } = page.renderPage(view, {}, opts);
  return shell({ csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    header, main, drawer, data: view, scripts: [asset('page.cjs')] });
}

// The deployed page: no data; fetches workspace.json and refresh.json from its own origin.
export function renderAppHtml() {
  return shell({ csp: "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    header: page.loadingHeader(), main: '<p class="loading" id="loading">Loading the workspace…</p>', drawer: '', data: null,
    scripts: [readFileSync(join(HERE, '..', 'workspace', 'src', 'lost-reasons.js'), 'utf8'), readFileSync(join(HERE, '..', 'workspace', 'src', 'insights.js'), 'utf8'),
      asset('view.cjs'), asset('page.cjs')] });
}

export function build(opts) {
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  mkdirSync(opts.out, { recursive: true });
  if (opts.app) {
    const html = renderAppHtml();
    writeFileSync(join(opts.out, 'index.html'), html);
    log(`wrote ${join(opts.out, 'index.html')} (${Math.round(html.length / 1024)} KB, no data: fetches ${DATA_FILE})`);
    return { html };
  }
  if (!existsSync(opts.data)) throw new Error(`--data ${opts.data} not found (write it with scripts/workspace-data.py)`);
  const raw = readFileSync(opts.data, 'utf8');
  const patterns = scrubPatterns();
  assertScrubbed(raw, opts.data, patterns);
  const view = buildView(JSON.parse(raw));
  const html = renderHtml(view);
  assertScrubbed(html, 'index.html', patterns);
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
