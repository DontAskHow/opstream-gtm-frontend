#!/usr/bin/env node
// Checks a built one-page workspace before it is uploaded (workspace/refresh/deploy.sh --onepage <dir>).
// Exit 0 and print the file to upload, or exit 1 with the problems. No network, no AWS.
//   node onepage/deploy-check.mjs <dir with index.html>
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCOPE = JSON.parse(readFileSync(join(HERE, '..', 'shared', 'workspace-scope.json'), 'utf8'));
const MAX_BYTES = 15 * 1024 * 1024;

export function checkBuild(dir) {
  const file = join(resolve(dir), 'index.html');
  const problems = [];
  if (!existsSync(file)) return { ok: false, file, problems: [`${file} not found (build it with onepage/build.mjs)`] };
  const size = statSync(file).size;
  const html = readFileSync(file, 'utf8');
  if (size > MAX_BYTES) problems.push(`index.html is ${size} bytes, over ${MAX_BYTES}`);
  if (!/^<!doctype html>/i.test(html)) problems.push('index.html does not start with <!doctype html>');
  if (!/Content-Security-Policy" content="default-src 'none'/.test(html)) problems.push("the default-src 'none' CSP is missing");
  if (!/<script type="application\/json" id="gtm-data">/.test(html)) problems.push('the embedded data block is missing');
  if (/<script[^>]+src=|<link[^>]+href=/i.test(html)) problems.push('external scripts or styles found; the page must be self-contained');
  if (html.toLowerCase().includes(SCOPE.hiddenOwner.pattern.toLowerCase())) problems.push('the hidden owner appears in the page');
  const m = /"asOf":"([^"]+)"/.exec(html);
  return { ok: problems.length === 0, file, size, asOf: m ? m[1] : null, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node onepage/deploy-check.mjs <dir with index.html>'); process.exit(2); }
  const r = checkBuild(dir);
  if (!r.ok) { console.error(`not deployable:\n- ${r.problems.join('\n- ')}`); process.exit(1); }
  console.log(r.file);
  console.error(`ok: ${r.size} bytes, data as of ${r.asOf}`);
}
