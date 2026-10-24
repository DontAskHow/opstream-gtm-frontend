// Public-safe: reads tracked source only. No Otterly API calls, no live credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const otterly = fs.readFileSync(path.join(root, 'refresh/brain-sync/otterly_sync.py'), 'utf8');
const metrics = fs.readFileSync(path.join(root, 'scripts/gtm_metrics.py'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'refresh/brain-sync/README.md'), 'utf8');

test('QUOTA_THRESHOLD is exactly 0.75 (live fetcher stop; not loosened)', () => {
  const match = otterly.match(/^QUOTA_THRESHOLD\s*=\s*([0-9.]+)\s*$/m);
  assert.ok(match, 'QUOTA_THRESHOLD assignment missing');
  assert.equal(Number(match[1]), 0.75);
  assert.equal((otterly.match(/QUOTA_THRESHOLD\s*=\s*/g) || []).length, 1);
  assert.doesNotMatch(otterly, /QUOTA_THRESHOLD\s*=\s*0\.50/);
});

test('quota docstring and README describe the 75% gate', () => {
  assert.match(otterly, /Over 75% of the period/);
  assert.doesNotMatch(otterly, /Over 50% of the period/);
  assert.match(readme, /more than 75% of the period/);
  assert.doesNotMatch(readme, /more than 50% of the period/);
});

test('account_name keeps the Kidde/Carrier alias used by the running fetcher', () => {
  // Match the Python source literally (raw string uses \b; display name is title case).
  assert.ok(metrics.includes(String.raw`\bkidde\b`), 'missing kidde pattern');
  assert.ok(metrics.includes(String.raw`\bcarrier\b`), 'missing carrier pattern');
  assert.ok(metrics.includes('Kidde Global Solutions'), 'missing Kidde Global Solutions alias');
});

test('no __pycache__ or .pyc is tracked', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const bad = files.filter((f) => f.includes('__pycache__') || f.endsWith('.pyc'));
  assert.deepEqual(bad, []);
});
