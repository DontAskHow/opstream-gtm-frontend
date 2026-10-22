// The AWS account id is read at run time, never written in a tracked file.
// 123456789012 is the synthetic id these tests use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, configFor, handler } from '../workspace/refresh/handler.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC = new Set(['123456789012', '000000000000']);
const FN_ARN = 'arn:aws:lambda:us-east-2:123456789012:function:gtm-preview-refresh';

test('no tracked file carries a 12-digit account id', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = new Set();
  for (const rel of files) {
    if (rel === 'package-lock.json') continue;
    const file = join(ROOT, rel);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/(?<![\d.-])\d{12}(?!\d)/g)) if (!SYNTHETIC.has(m[0])) hits.add(rel);
  }
  assert.deepEqual([...hits], []);
});

test('handler defaults name the bucket and topic with the {accountId} placeholder', () => {
  if (process.env.DATA_BUCKET || process.env.TOPIC_ARN) return;
  assert.equal(CONFIG.dataBucket, 'opstream-gtm-data-{accountId}');
  assert.equal(CONFIG.topicArn, 'arn:aws:sns:us-east-2:{accountId}:opstream-gtm-refresh-failures');
});

test('configFor fills the account from context.invokedFunctionArn: the old literal shapes', () => {
  const cfg = configFor({ invokedFunctionArn: FN_ARN }, { ...CONFIG, dataBucket: 'opstream-gtm-data-{accountId}', topicArn: 'arn:aws:sns:us-east-2:{accountId}:opstream-gtm-refresh-failures' });
  assert.equal(cfg.dataBucket, 'opstream-gtm-data-123456789012');
  assert.equal(cfg.topicArn, 'arn:aws:sns:us-east-2:123456789012:opstream-gtm-refresh-failures');
  assert.match(cfg.dataBucket, /^opstream-gtm-data-\d{12}$/);
  assert.match(cfg.topicArn, /^arn:aws:sns:us-east-2:\d{12}:opstream-gtm-refresh-failures$/);
  // An alias-qualified ARN carries the same account.
  assert.equal(configFor({ invokedFunctionArn: FN_ARN + ':live' }, { ...CONFIG, dataBucket: 'opstream-gtm-data-{accountId}' }).dataBucket, 'opstream-gtm-data-123456789012');
});

test('configFor keeps DATA_BUCKET / TOPIC_ARN values as given and needs no context for them', () => {
  const given = { ...CONFIG, dataBucket: 'B-data', topicArn: 'arn:aws:sns:us-east-2:123456789012:t' };
  assert.equal(configFor(undefined, given), given);
});

test('configFor refuses a context without a function ARN instead of guessing a bucket', () => {
  const cfg = { ...CONFIG, dataBucket: 'opstream-gtm-data-{accountId}' };
  assert.throws(() => configFor({}, cfg), /no account id in context.invokedFunctionArn/);
  assert.throws(() => configFor({ invokedFunctionArn: 'arn:aws:lambda:us-east-2::function:x' }, cfg), /no account id/);
});

test('handler resolves the account from its context before it touches AWS', async (t) => {
  if (process.env.DATA_BUCKET || process.env.TOPIC_ARN) return;
  t.mock.method(console, 'error', () => {});
  await assert.rejects(handler({ dryRun: true }, {}), /no account id in context.invokedFunctionArn/);
});
