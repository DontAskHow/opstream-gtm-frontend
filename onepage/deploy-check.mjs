#!/usr/bin/env node
// Checks a built one-page workspace before workspace/refresh/deploy.sh uploads it.
// Exit 0 and print the file to upload, or exit 1 with the problems. No network, no AWS.
//   node onepage/deploy-check.mjs --app <dir>   the data-less page (fetches workspace.json)
//   node onepage/deploy-check.mjs <dir>         a page built with its data inside
// Scrub patterns come from WORKSPACE_SCRUB_PATTERNS / WORKSPACE_SCRUB_PATTERNS_FILE; a page
// with data inside is refused without them.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubPatterns } from './build.mjs';

const MAX_BYTES = 15 * 1024 * 1024;

export function checkBuild(dir, { app = false, patterns = scrubPatterns() } = {}) {
  const file = join(resolve(dir), 'index.html');
  const problems = [];
  if (!existsSync(file)) return { ok: false, file, problems: [`${file} not found (build it with onepage/build.mjs)`] };
  const size = statSync(file).size;
  const html = readFileSync(file, 'utf8');
  const hasData = /<script type="application\/json" id="gtm-data">/.test(html);
  if (size > MAX_BYTES) problems.push(`index.html is ${size} bytes, over ${MAX_BYTES}`);
  if (!/^<!doctype html>/i.test(html)) problems.push('index.html does not start with <!doctype html>');
  if (/<script[^>]+src=|<link[^>]+href=/i.test(html)) problems.push('external scripts or styles found; the page must be self-contained');
  if (app) {
    if (hasData) problems.push('the app page must not carry data (build it with --app)');
    if (!/connect-src 'self'/.test(html)) problems.push("the app page's CSP must allow connect-src 'self' to fetch workspace.json");
    if (!html.includes("'workspace.json'")) problems.push('the app page does not fetch workspace.json');
  } else {
    if (!hasData) problems.push('the embedded data block is missing');
    if (!/Content-Security-Policy" content="default-src 'none'; style-src/.test(html)) problems.push("the default-src 'none' CSP (no network) is missing");
    if (!patterns.length) problems.push('no scrub patterns to check a page with data (set WORKSPACE_SCRUB_PATTERNS or WORKSPACE_SCRUB_PATTERNS_FILE)');
  }
  const low = html.toLowerCase();
  patterns.forEach((p, i) => { if (low.includes(p)) problems.push(`scrub pattern #${i + 1} appears in the page`); });
  const m = /"generatedAt":"([^"]+)"/.exec(html) || /"asOf":"([^"]+)"/.exec(html);
  return { ok: problems.length === 0, file, size, generatedAt: m ? m[1] : null, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const app = args.includes('--app');
  const dir = args.find((a) => a !== '--app');
  if (!dir) { console.error('Usage: node onepage/deploy-check.mjs [--app] <dir with index.html>'); process.exit(2); }
  const r = checkBuild(dir, { app });
  if (!r.ok) { console.error(`not deployable:\n- ${r.problems.join('\n- ')}`); process.exit(1); }
  console.log(r.file);
  console.error(`ok: ${r.size} bytes${app ? ' (app: fetches workspace.json)' : `, data generated ${r.generatedAt}`}`);
}
