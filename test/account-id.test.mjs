// The AWS account id is read at run time, never written in a tracked file.
// 123456789012 is the synthetic id these tests use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// ---- wiring: the resolved names are what the live S3 and SNS calls use ----

const DATA = 'opstream-gtm-data-123456789012';
const TOPIC = 'arn:aws:sns:us-east-2:123456789012:opstream-gtm-refresh-failures';
const GEN = '2026-01-15T18:00:00+00:00';

// Fake S3 and SNS behind makeDeps: one published snapshot in the data bucket (whatever its name), nothing in the preview bucket.
// Each world has its own run id: loadSnapshot caches a run per warm container.
let worlds = 0;
function fakeAws(dataBucket = DATA) {
  const runId = 'run-test-' + ++worlds;
  const prefix = `published/${runId}/`;
  const files = {
    'records.json': { generatedAt: GEN, owners: {}, companies: [{ id: 'c1', name: 'Example Corp', domain: 'example.com', deals: [] }] },
    'marketing.json': { generatedAt: GEN, sources: [] },
    'sheet-review.json': { generatedAt: GEN, deals: [] },
    'agent-brief.json': { generatedAt: GEN, whatsNew: [], topActions: [], watchOuts: [] },
    'prep-file.json': { generatedAt: GEN, prep: [], brief: { meetings: { items: [] } } },
    'hubspot-deals.json': {
      fetchedAt: GEN, pipes: { default: 'Sales Pipeline' }, stages: { s1: { pipe: 'Sales Pipeline', label: 'Discovery', closed: false, prob: '0.2' } },
      deals: [{ id: '101', properties: { dealname: 'Example Corp - New', dealstage: 's1', pipeline: 'default', amount: '1000', hs_deal_stage_probability: '0.2' } }],
    },
  };
  const objects = new Map(Object.entries(files).map(([k, v]) => [prefix + k, JSON.stringify(v)]));
  objects.set('published/LATEST.json', JSON.stringify({ runId, prefix, publishedAt: new Date().toISOString() }));
  const w = { calls: [], made: [], notes: [] };
  w.deps = {
    async getText(bucket, key) { w.calls.push(['getText', bucket, key]); return bucket === dataBucket ? objects.get(key) ?? null : null; },
    async list(bucket, p) {
      w.calls.push(['list', bucket, p]);
      return bucket === dataBucket ? [...objects.keys()].filter((k) => k.startsWith(p)).map((k) => ({ key: k, size: objects.get(k).length })) : [];
    },
    async put(bucket, key) { w.calls.push(['put', bucket, key]); },
    async notify(subject) { w.notes.push(subject); },
  };
  w.makeDeps = async (cfg) => { w.made.push(cfg); return w.deps; };
  w.dataCalls = () => w.calls.filter(([op, , key]) => op === 'list' || key.startsWith('published/'));
  return w;
}

for (const dryRun of [false, true]) {
  test(`handler${dryRun ? ' (dryRun)' : ''}: SNS gets the resolved topic and every snapshot read uses the resolved bucket`, async (t) => {
    if (process.env.DATA_BUCKET || process.env.TOPIC_ARN) return t.skip('DATA_BUCKET / TOPIC_ARN set in this shell');
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    const w = fakeAws();
    const out = await handler(dryRun ? { dryRun: true } : {}, { invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789012:function:x' }, { makeDeps: w.makeDeps });
    assert.equal(w.made.length, 1);
    assert.equal(w.made[0].topicArn, TOPIC);
    assert.equal(w.made[0].dataBucket, DATA);
    const reads = w.dataCalls();
    assert.deepEqual(reads.slice(0, 2), [['getText', DATA, 'published/LATEST.json'], ['list', DATA, `published/run-test-${worlds}/`]]);
    assert.ok(reads.length > 2, 'snapshot files were read');
    assert.deepEqual(reads.filter(([, bucket]) => bucket !== DATA), []);
    assert.ok(!w.calls.some(([, bucket]) => bucket.includes('{accountId}')));
    assert.equal(out.dryRun, dryRun || undefined);
    if (dryRun) assert.deepEqual(w.calls.filter(([op]) => op === 'put'), [], 'dryRun writes nothing');
  });
}

test('handler with a Lambda-style callback as its third argument still builds the real AWS deps', async (t) => {
  if (process.env.DATA_BUCKET || process.env.TOPIC_ARN) return t.skip('DATA_BUCKET / TOPIC_ARN set in this shell');
  t.mock.method(console, 'error', () => {});
  // The AWS SDK is not installed here, so reaching awsDeps shows up as its import failing.
  await assert.rejects(handler({ dryRun: true }, { invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789012:function:x' }, () => {}),
    (e) => e.code === 'ERR_MODULE_NOT_FOUND' && /@aws-sdk\/client-s3/.test(e.message));
});

test('DATA_BUCKET and TOPIC_ARN, read at import, win over the account placeholder', () => {
  const script = `
    const { CONFIG, configFor, handler } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'workspace/refresh/handler.mjs')).href)});
    const made = [], buckets = new Set();
    const deps = { async getText(b) { buckets.add(b); return null; }, async list(b) { buckets.add(b); return []; }, async put() {}, async notify() {} };
    console.error = () => {};
    await handler({ dryRun: true }, {}, { makeDeps: async (cfg) => { made.push(cfg); return deps; } }).catch(() => {});
    console.log(JSON.stringify({ dataBucket: CONFIG.dataBucket, topicArn: CONFIG.topicArn, same: configFor(undefined) === CONFIG,
      made: made.map((c) => [c.dataBucket, c.topicArn]), buckets: [...buckets] }));`;
  const env = { ...process.env, DATA_BUCKET: 'B-data', TOPIC_ARN: 'arn:aws:sns:us-east-2:123456789012:t' };
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env }));
  assert.equal(out.dataBucket, 'B-data');
  assert.equal(out.topicArn, 'arn:aws:sns:us-east-2:123456789012:t');
  assert.equal(out.same, true, 'no context needed');
  assert.deepEqual(out.made, [['B-data', 'arn:aws:sns:us-east-2:123456789012:t']]);
  assert.ok(out.buckets.includes('B-data'));
  assert.ok(!out.buckets.some((b) => b.includes('{accountId}')));
});
