// The AWS account id is read at run time, never written in a tracked file.
// 123456789012 is the synthetic id these tests use.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataBucket } from '../scripts/published-swap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC = '123456789012';
const OLD_SHAPE = /^opstream-gtm-data-\d{12}$/;
const config = JSON.parse(fs.readFileSync(path.join(root, 'refresh-config.json'), 'utf8'));

test('no tracked file carries a 12-digit account id', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const rel of files) {
    if (rel === 'package-lock.json') continue;
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?<![\d.])\d{12}(?!\d)/g)) if (m[0] !== SYNTHETIC) hits.push(rel);
  }
  assert.deepEqual([...new Set(hits)], []);
});

test('refresh-config.json names the bucket with the {accountId} placeholder', () => {
  assert.equal(config.dataBucket, 'opstream-gtm-data-{accountId}');
});

test('Node resolves the placeholder to the old literal bucket shape', async () => {
  const name = await dataBucket(config, async () => SYNTHETIC);
  assert.equal(name, 'opstream-gtm-data-' + SYNTHETIC);
  assert.match(name, OLD_SHAPE);
});

test('Node leaves a literal bucket name alone and never looks up the account', async () => {
  const name = await dataBucket({ dataBucket: 'opstream-gtm-data-' + SYNTHETIC }, async () => { throw new Error('looked up'); });
  assert.equal(name, 'opstream-gtm-data-' + SYNTHETIC);
});

test('Node reads the account from the IMDSv2 instance identity document', async t => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    seen.push([String(url), init.method || 'GET', (init.headers || {})['X-aws-ec2-metadata-token'] || '']);
    if (String(url).endsWith('/latest/api/token')) return new Response('tok');
    if (String(url).endsWith('/latest/dynamic/instance-identity/document')) return Response.json({ accountId: SYNTHETIC, region: 'us-east-2' });
    throw new Error('unexpected ' + url);
  });
  assert.equal(await dataBucket(config), 'opstream-gtm-data-' + SYNTHETIC);
  assert.equal(await dataBucket(config), 'opstream-gtm-data-' + SYNTHETIC);
  assert.deepEqual(seen, [
    ['http://169.254.169.254/latest/api/token', 'PUT', ''],
    ['http://169.254.169.254/latest/dynamic/instance-identity/document', 'GET', 'tok'],
  ]);
});

test('Python resolves the placeholder to the same bucket as Node', () => {
  const out = execFileSync('python3', ['-c', [
    'import json, sys',
    'sys.path.insert(0, "refresh")',
    'import run',
    'calls = []',
    'cfg = run.load_config()',
    'print(run.resolve_bucket(cfg["dataBucket"], lambda: calls.append(1) or "' + SYNTHETIC + '"))',
    'print(run.resolve_bucket("opstream-gtm-data-' + SYNTHETIC + '", lambda: calls.append(1) or "x"))',
    'print(len(calls))',
  ].join('\n')], { cwd: root, encoding: 'utf8', env: { ...process.env, REFRESH_CONFIG: path.join(root, 'refresh-config.json') } });
  assert.deepEqual(out.trim().split('\n'), ['opstream-gtm-data-' + SYNTHETIC, 'opstream-gtm-data-' + SYNTHETIC, '1']);
});

function deployBucket(env) {
  const script = fs.readFileSync(path.join(root, 'deploy/gtm-v14.sh'), 'utf8');
  const head = script.slice(script.indexOf('set -euo pipefail'), script.indexOf('\nSTACK='));
  return execFileSync('bash', ['-c', head + '\necho "$BUCKET"'], { encoding: 'utf8', env }).trim();
}

function fakeAws(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-aws-'));
  fs.writeFileSync(path.join(dir, 'aws'), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  return dir;
}

test('deploy script reads the account from STS at run time', () => {
  const bin = fakeAws('[ "$1 $2" = "sts get-caller-identity" ] && echo ' + SYNTHETIC);
  const env = { PATH: bin + ':' + process.env.PATH };
  assert.equal(deployBucket(env), 'opstream-gtm-data-' + SYNTHETIC);
});

test('deploy script takes AWS_ACCOUNT_ID over STS', () => {
  const bin = fakeAws('exit 1');
  const env = { PATH: bin + ':' + process.env.PATH, AWS_ACCOUNT_ID: SYNTHETIC };
  assert.equal(deployBucket(env), 'opstream-gtm-data-' + SYNTHETIC);
});

test('deploy script stops when STS fails', () => {
  const bin = fakeAws('exit 254');
  assert.throws(() => deployBucket({ PATH: bin + ':' + process.env.PATH }), /Command failed/);
});
