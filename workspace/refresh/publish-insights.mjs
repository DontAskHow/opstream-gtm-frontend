#!/usr/bin/env node
// Publishes the Strategy seat's Analysis file to the private preview:
//   node workspace/refresh/publish-insights.mjs /workspace/gtm-insights/insights.json [--dry-run]
// Validates the file (workspace/src/insights.js, the same check the page runs;
// shape in docs/insights-schema.md), refuses on any error, and uploads to
// s3://opstream-gtm-preview-db5553a4/insights.json only when its sha256 differs
// from the sha256 metadata on the object already there. Node 20 + the AWS CLI;
// no other dependencies. Uses --profile opstream-deploy (override: GTM_AWS_PROFILE).
// publishFile is shared with publish-lost-reasons.mjs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const insights = require('../src/insights.js');

export const BUCKET = 'opstream-gtm-preview-db5553a4';
export const KEY = 'insights.json';
const REGION = 'us-east-2';
const PROFILE = process.env.GTM_AWS_PROFILE || 'opstream-deploy';

export function checkText(text, parse = insights.parse) {
  const r = parse(text);
  return { ...r, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

// 'upload' when there is no object or its stored hash differs; 'unchanged' otherwise.
export const decide = (localSha, remoteSha) => (remoteSha && remoteSha === localSha ? 'unchanged' : 'upload');

function aws(args) {
  return execFileSync('aws', [...args, '--profile', PROFILE, '--region', REGION], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function remoteSha(key) {
  try {
    const out = aws(['s3api', 'head-object', '--bucket', BUCKET, '--key', key, '--query', 'Metadata.sha256', '--output', 'text']).trim();
    return out && out !== 'None' ? out : null;
  } catch (e) {
    if (/\(404\)|Not Found/i.test(String(e.stderr))) return null;
    throw new Error(`could not read the current ${key}: ` + String(e.stderr || e.message).trim());
  }
}

// Validate a local file with parse, then upload it to s3://BUCKET/<key> only when its sha256 changed.
// describe(doc) is the "valid: …" summary; shown names where the page shows it.
export function publishFile(argv, { key, parse, script, describe, shown }) {
  const file = argv.find((a) => !a.startsWith('--'));
  const dry = argv.includes('--dry-run');
  if (!file) {
    console.error(`Usage: node workspace/refresh/${script} <${key}> [--dry-run]`);
    return 2;
  }
  const text = readFileSync(file, 'utf8');
  const r = checkText(text, parse);
  if (!r.ok) {
    console.error(`refusing to publish ${file}: ${r.errors.length} problem(s)`);
    for (const e of r.errors) console.error('  - ' + e);
    return 1;
  }
  console.log(`valid: ${describe(r.doc)}, generated_at ${r.doc.generated_at}, sha256 ${r.sha256.slice(0, 12)}…`);
  const current = remoteSha(key);
  if (decide(r.sha256, current) === 'unchanged') {
    console.log(`unchanged: s3://${BUCKET}/${key} already has this content; nothing uploaded`);
    return 0;
  }
  if (dry) {
    console.log(`dry run: would upload to s3://${BUCKET}/${key} (current sha256 ${current ? current.slice(0, 12) + '…' : 'none'})`);
    return 0;
  }
  aws(['s3', 'cp', resolve(file), `s3://${BUCKET}/${key}`, '--content-type', 'application/json; charset=utf-8',
    '--cache-control', 'no-store', '--metadata', `sha256=${r.sha256}`, '--only-show-errors']);
  console.log(`uploaded s3://${BUCKET}/${key}; ${shown} shows it on the next page load`);
  return 0;
}

export function runCli(main) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

const main = (argv) => publishFile(argv, {
  key: KEY, parse: insights.parse, script: 'publish-insights.mjs', shown: 'the Analysis panel',
  describe: (doc) => `${doc.insights.length} insights`,
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli(main);
