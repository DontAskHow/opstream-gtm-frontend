// The AWS account id is read at run time, never written in a tracked file.
// 123456789012 is the synthetic id these tests use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG, awsDeps, configFor, handler, sdk } from '../workspace/refresh/handler.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC = new Set(['123456789012', '000000000000']);
const FN_ARN = 'arn:aws:lambda:us-east-2:123456789012:function:gtm-preview-refresh';

// The last group of a canonical UUID (8-4-4-4-12) is twelve characters that can all be digits; it is not an account id.
const UUID_HEAD = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-$/i;

// Tracked files in a git checkout that hold a 12-digit run other than the synthetic ids.
function accountIdHits(dir) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = new Set();
  for (const rel of files) {
    if (rel === 'package-lock.json') continue;
    const file = join(dir, rel);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?<![\d.])\d{12}(?!\d)/g)) {
      if (SYNTHETIC.has(m[0]) || UUID_HEAD.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
      hits.add(rel);
    }
  }
  return [...hits];
}

test('no tracked file carries a 12-digit account id', () => {
  assert.deepEqual(accountIdHits(ROOT), []);
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
function snapshotObjects() {
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
  return { runId, objects };
}

function fakeAws(dataBucket = DATA) {
  const { objects } = snapshotObjects();
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

// Fake AWS SDK v3 modules for sdk.load / awsDeps(cfg, load): clients record every command they are sent.
function fakeSdk({ dataBucket = DATA, failLatest = false } = {}) {
  const { runId, objects } = snapshotObjects();
  const f = { runId, sent: [], clients: [], loaded: [] };
  const command = (name) => ({ [name]: class { constructor(input) { this.input = input; } } })[name];
  const client = (service, answer) => class { constructor(opts) { f.clients.push([service, opts.region]); } async send(c) { f.sent.push([c.constructor.name, c.input]); return answer(c); } };
  const noKey = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
  const s3 = (c) => {
    const { Bucket, Key, Prefix } = c.input;
    if (c.constructor.name === 'GetObjectCommand') {
      if (failLatest && Key === 'published/LATEST.json') throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      const text = Bucket === dataBucket ? objects.get(Key) : undefined;
      if (text === undefined) throw noKey();
      return { Body: { transformToString: async () => text } };
    }
    if (c.constructor.name === 'ListObjectsV2Command') {
      const keys = Bucket === dataBucket ? [...objects.keys()].filter((k) => k.startsWith(Prefix)) : [];
      return { Contents: keys.map((k) => ({ Key: k, Size: objects.get(k).length })), IsTruncated: false };
    }
    return {};
  };
  const modules = {
    '@aws-sdk/client-s3': { S3Client: client('s3', s3), GetObjectCommand: command('GetObjectCommand'), PutObjectCommand: command('PutObjectCommand'), ListObjectsV2Command: command('ListObjectsV2Command') },
    '@aws-sdk/client-sns': { SNSClient: client('sns', () => ({})), PublishCommand: command('PublishCommand') },
    '@aws-sdk/client-secrets-manager': { SecretsManagerClient: client('secretsmanager', () => ({ SecretString: 's' })), GetSecretValueCommand: command('GetSecretValueCommand') },
  };
  f.load = async (name) => { f.loaded.push(name); if (!modules[name]) throw new Error('unexpected module ' + name); return modules[name]; };
  f.of = (name) => f.sent.filter(([n]) => n === name).map(([, input]) => input);
  return f;
}

const RESOLVED = () => configFor({ invokedFunctionArn: FN_ARN }, { ...CONFIG, dataBucket: 'opstream-gtm-data-{accountId}', topicArn: 'arn:aws:sns:us-east-2:{accountId}:opstream-gtm-refresh-failures', livePull: false });

test('handler with a Lambda-style callback as its third argument still builds the real AWS deps', async (t) => {
  if (process.env.DATA_BUCKET || process.env.TOPIC_ARN) return t.skip('DATA_BUCKET / TOPIC_ARN set in this shell');
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const f = fakeSdk();
  t.mock.method(sdk, 'load', f.load);
  const out = await handler({ dryRun: true }, { invokedFunctionArn: FN_ARN }, () => {});
  assert.equal(out.dryRun, true);
  assert.deepEqual(f.loaded, ['@aws-sdk/client-s3', '@aws-sdk/client-sns'], 'awsDeps built the clients through sdk.load');
  const gets = f.of('GetObjectCommand');
  assert.deepEqual(gets.filter((i) => i.Key.startsWith('published/')).map((i) => i.Bucket).filter((b) => b !== DATA), []);
  assert.deepEqual(gets.filter((i) => !i.Key.startsWith('published/')).map((i) => i.Bucket).filter((b) => b !== CONFIG.previewBucket), [], 'preview reads stay on the preview bucket');
  assert.ok(gets.some((i) => i.Key === CONFIG.refreshKey), 'the previous refresh.json was read');
  assert.deepEqual(f.of('ListObjectsV2Command').map((i) => [i.Bucket, i.Prefix]), [[DATA, `published/${f.runId}/`]]);
  assert.deepEqual(f.of('PutObjectCommand'), [], 'dryRun writes nothing');
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

// ---- awsDeps: the resolved cfg reaches the SDK commands ----

test('awsDeps: PublishCommand gets the resolved topic; S3 commands get the bucket they are given; clients in the cfg region', async () => {
  const f = fakeSdk();
  const deps = await awsDeps(RESOLVED(), f.load);
  await deps.notify('subject', 'message');
  assert.deepEqual(f.of('PublishCommand'), [{ TopicArn: TOPIC, Subject: 'subject', Message: 'message' }]);
  await deps.getText(DATA, 'published/LATEST.json');
  await deps.getText('B-preview', 'refresh.json');
  await deps.list(DATA, 'published/');
  await deps.list('B-preview', '_state/');
  await deps.put('B-preview', 'data.js', 'x', { contentType: 'text/javascript' });
  assert.deepEqual(f.sent.filter(([n]) => n !== 'PublishCommand').map(([n, i]) => [n, i.Bucket]),
    [['GetObjectCommand', DATA], ['GetObjectCommand', 'B-preview'], ['ListObjectsV2Command', DATA], ['ListObjectsV2Command', 'B-preview'], ['PutObjectCommand', 'B-preview']]);
  assert.deepEqual(f.clients, [['s3', CONFIG.region], ['sns', CONFIG.region]]);
});

test('awsDeps refuses a config whose bucket or topic still has {accountId}', async () => {
  const f = fakeSdk();
  for (const cfg of [CONFIG, { ...RESOLVED(), topicArn: CONFIG.topicArn }, { ...RESOLVED(), dataBucket: 'opstream-gtm-data-{accountId}' }]) {
    if (!String(cfg.dataBucket).includes('{') && !String(cfg.topicArn).includes('{')) continue; // DATA_BUCKET and TOPIC_ARN both set in this shell
    await assert.rejects(awsDeps(cfg, f.load), /awsDeps needs the resolved config/);
  }
  assert.deepEqual(f.loaded, [], 'no SDK loaded');
});

test('awsDeps with LIVE_PULL loads Secrets Manager through the same loader', async () => {
  const f = fakeSdk();
  const deps = await awsDeps({ ...RESOLVED(), livePull: true }, f.load);
  assert.equal(await deps.secret('opstream-gtm/x'), 's');
  assert.deepEqual(f.loaded, ['@aws-sdk/client-s3', '@aws-sdk/client-sns', '@aws-sdk/client-secrets-manager']);
  assert.deepEqual(f.of('GetSecretValueCommand'), [{ SecretId: 'opstream-gtm/x' }]);
});

test('handler failure: the alarm is published to the resolved topic through the real awsDeps', async (t) => {
  if (process.env.DATA_BUCKET || process.env.TOPIC_ARN) return t.skip('DATA_BUCKET / TOPIC_ARN set in this shell');
  t.mock.method(console, 'error', () => {});
  const f = fakeSdk({ failLatest: true });
  t.mock.method(sdk, 'load', f.load);
  await assert.rejects(handler({}, { invokedFunctionArn: FN_ARN }), /AccessDenied/);
  assert.deepEqual(f.of('GetObjectCommand').find((i) => i.Key === 'published/LATEST.json').Bucket, DATA);
  const published = f.of('PublishCommand');
  assert.equal(published.length, 1);
  assert.equal(published[0].TopicArn, TOPIC);
  assert.equal(published[0].Subject, 'GTM preview refresh FAILED');
});

test('configFor with only one of bucket / topic still a placeholder fills that one and keeps the other', () => {
  const bucketSet = { ...CONFIG, dataBucket: 'B-data', topicArn: 'arn:aws:sns:us-east-2:{accountId}:opstream-gtm-refresh-failures' };
  assert.deepEqual([configFor({ invokedFunctionArn: FN_ARN }, bucketSet)].map((c) => [c.dataBucket, c.topicArn]), [['B-data', TOPIC]]);
  assert.throws(() => configFor({}, bucketSet), /no account id/);
  const topicSet = { ...CONFIG, dataBucket: 'opstream-gtm-data-{accountId}', topicArn: 'arn:aws:sns:us-east-2:123456789012:t' };
  assert.deepEqual([configFor({ invokedFunctionArn: FN_ARN }, topicSet)].map((c) => [c.dataBucket, c.topicArn]), [[DATA, 'arn:aws:sns:us-east-2:123456789012:t']]);
});

test('handler.length is below 3: the test seam is an optional third parameter, never a required one', () => {
  assert.ok(handler.length < 3, String(handler.length));
});

// ---- the guard itself: planted ids in a throwaway repo ----

// Built at run time so this file never holds a 12-digit run of its own (AWS's documentation example id).
const PLANTED = ['1111', '2222', '3333'].join('');

test('the guard reports planted account ids in the forms the repo used, and passes synthetic ids and UUID tails', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acct-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    'bucket.mjs': `dataBucket: process.env.DATA_BUCKET || 'opstream-gtm-data-${PLANTED}',\n`,
    'fallback.sh': `ACCOUNT=\${ACCOUNT_ID:-${PLANTED}}\n`,
    'topic.mjs': `topicArn: 'arn:aws:sns:us-east-2:${PLANTED}:opstream-gtm-refresh-failures',\n`,
    'synthetic.md': `opstream-gtm-data-123456789012 \${ACCOUNT_ID:-000000000000} f0000000-0000-4000-8000-${'0000000' + '00005'}\n`,
    'not-a-uuid.txt': `x-0000-4000-8000-${PLANTED}\n`,
    'untracked.txt': `opstream-gtm-data-${PLANTED}\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', ...Object.keys(files).filter((n) => n !== 'untracked.txt')], { cwd: dir });
  assert.deepEqual(accountIdHits(dir).sort(), ['bucket.mjs', 'fallback.sh', 'not-a-uuid.txt', 'topic.mjs']);
});
