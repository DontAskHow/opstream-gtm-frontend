// Deploy zip for the Elastic Beanstalk process: web: node scripts/agent-server.mjs
// The server loads scripts/workspace-facts.mjs, which requires ../workspace-model.cjs.
// That file has to sit at the bundle root, next to scripts/ and out/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLE_REQUIRED = [
  'Procfile',
  'package.json',
  'package-lock.json',
  'workspace-model.cjs',
  'scripts/agent-server.mjs',
  'scripts/workspace-facts.mjs',
  'out/index.html',
];

const SKIP_DIR = new Set(['__pycache__', 'node_modules']);
const SKIP_FILE = new Set(['verify-metrics.mjs']);

function copyFiltered(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (SKIP_DIR.has(path.basename(src))) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyFiltered(path.join(src, name), path.join(dest, name));
    return;
  }
  if (SKIP_FILE.has(path.basename(src))) return;
  if (src.endsWith('.pyc')) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

export function stageBundle(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['Procfile', 'package.json', 'package-lock.json', 'workspace-model.cjs']) {
    fs.copyFileSync(path.join(root, name), path.join(dest, name));
  }
  copyFiltered(path.join(root, 'scripts'), path.join(dest, 'scripts'));
  copyFiltered(path.join(root, 'out'), path.join(dest, 'out'));
  const missing = BUNDLE_REQUIRED.filter(rel => !fs.existsSync(path.join(dest, rel)));
  if (missing.length) throw new Error('Bundle is missing runtime files: ' + missing.join(', '));
}

export function writeZip(zipPath) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-bundle-'));
  stageBundle(stage);
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  return zipPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zipPath = path.resolve(process.argv[2] || '/opt/cursor/artifacts/opstream-gtm-v8.3.zip');
  writeZip(zipPath);
  const listed = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  for (const rel of BUNDLE_REQUIRED) {
    if (!listed.includes(rel)) throw new Error('Zip listing is missing ' + rel);
  }
  console.log(JSON.stringify({ zip: zipPath, bytes: fs.statSync(zipPath).size, required: BUNDLE_REQUIRED }));
}
