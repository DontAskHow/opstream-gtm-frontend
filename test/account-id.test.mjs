// The AWS account id is read at run time, never written in a tracked file.
// 123456789012 is the synthetic id these tests use.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataBucket } from '../scripts/published-swap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC = '123456789012';
const OLD_SHAPE = /^opstream-gtm-data-\d{12}$/;
const config = JSON.parse(fs.readFileSync(path.join(root, 'refresh-config.json'), 'utf8'));

// Tracked files in a git checkout that hold a 12-digit run other than the synthetic id.
function accountIdHits(dir) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const rel of files) {
    if (rel === 'package-lock.json') continue;
    const file = path.join(dir, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?<![\d.])\d{12}(?!\d)/g)) if (m[0] !== SYNTHETIC) hits.push(rel);
  }
  return [...new Set(hits)];
}

test('no tracked file carries a 12-digit account id', () => {
  assert.deepEqual(accountIdHits(root), []);
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

// ---- wiring: the resolved name is what the live S3 calls use ----

test('Python S3Store sends the resolved bucket on every S3 call', () => {
  const py = String.raw`
import json, sys, types
calls = []
class NoSuchKey(Exception): pass
class FakeS3:
    exceptions = types.SimpleNamespace(NoSuchKey=NoSuchKey)
    def __getattr__(self, op):
        def call(*args, **kwargs):
            calls.append([op, kwargs.get("Bucket", args[1] if len(args) > 1 else None)])
            if op == "get_object": return {"Body": types.SimpleNamespace(read=lambda: b"x")}
            if op == "list_objects_v2": return {"Contents": [{"Key": "published/a"}], "IsTruncated": False}
            return {}
        return call
class FakeSTS:
    def get_caller_identity(self):
        calls.append(["sts", None]); return {"Account": "123456789012"}
clients = []
def client(name, region_name=None):
    clients.append([name, region_name])
    return {"s3": FakeS3(), "sts": FakeSTS(), "secretsmanager": object()}[name]
sys.modules["boto3"] = types.SimpleNamespace(client=client)
sys.path.insert(0, "refresh")
import run
store = run.S3Store("opstream-gtm-data-{accountId}", "us-east-2")
store.get_bytes("k"); store.put_bytes("k", b"x"); store.put_file("k", "/dev/null")
store.exists("k"); store.list_keys("published/"); store.delete("k")
print(json.dumps({"bucket": store.bucket, "calls": calls, "clients": clients}))
`;
  const out = JSON.parse(execFileSync('python3', ['-c', py], { cwd: root, encoding: 'utf8' }));
  const bucket = 'opstream-gtm-data-' + SYNTHETIC;
  assert.equal(out.bucket, bucket);
  assert.deepEqual(out.calls, [['sts', null], ['get_object', bucket], ['put_object', bucket], ['upload_file', bucket],
    ['head_object', bucket], ['list_objects_v2', bucket], ['delete_object', bucket]]);
  assert.deepEqual(out.clients, [['sts', 'us-east-2'], ['s3', 'us-east-2'], ['secretsmanager', 'us-east-2']]);
});

// A fresh copy of published-swap.mjs, so its cached account id does not leak between tests.
let fresh = 0;
const freshSwap = () => import('../scripts/published-swap.mjs?fresh=' + ++fresh);

function mockImds(t, { accountId = SYNTHETIC, document } = {}) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    seen.push({ url: u, signal: init.signal });
    if (u.endsWith('/latest/api/token')) return new Response('tok');
    if (u.endsWith('/latest/meta-data/iam/security-credentials/')) return new Response('eb-role\n');
    if (u.endsWith('/latest/meta-data/iam/security-credentials/eb-role')) return Response.json({ AccessKeyId: 'AKIDEXAMPLE', SecretAccessKey: 'secret', Token: 'session' });
    if (u.endsWith('/latest/dynamic/instance-identity/document')) return document ? document(init) : Response.json({ accountId, region: 'us-east-2' });
    throw new Error('unexpected fetch ' + u);
  });
  return seen;
}

function mockS3(t, body = 'state-body') {
  const requests = [];
  t.mock.method(https, 'request', (opts, onRes) => {
    const req = new EventEmitter();
    const chunks = [];
    req.write = (c) => chunks.push(Buffer.from(c));
    req.end = () => {
      requests.push({ method: opts.method, host: opts.host, path: opts.path, hostHeader: opts.headers.host, body: Buffer.concat(chunks).toString() });
      const res = new EventEmitter();
      res.statusCode = 200;
      onRes(res);
      res.emit('data', Buffer.from(opts.method === 'GET' ? body : ''));
      res.emit('end');
    };
    return req;
  });
  return requests;
}

test('readStateFile and persistStateFile GET and PUT on the resolved bucket host', async (t) => {
  t.mock.method(console, 'error', () => {});
  const before = process.env.REFRESH_FS_ROOT;
  delete process.env.REFRESH_FS_ROOT;
  t.after(() => { if (before !== undefined) process.env.REFRESH_FS_ROOT = before; });
  mockImds(t);
  const requests = mockS3(t);
  const { readStateFile, persistStateFile } = await freshSwap();
  assert.equal(await readStateFile(root, 'users/h/brief.json'), 'state-body');
  await persistStateFile(root, 'users/h/sends.json', '{"n":1}');
  const host = 'opstream-gtm-data-' + SYNTHETIC + '.s3.us-east-2.amazonaws.com';
  assert.deepEqual(requests, [
    { method: 'GET', host, path: '/state/users/h/brief.json', hostHeader: host, body: '' },
    { method: 'PUT', host, path: '/state/users/h/sends.json', hostHeader: host, body: '{"n":1}' },
  ]);
});

test('an IMDS account id that is not 12 digits is refused, nothing goes to S3, and the next call retries', async (t) => {
  t.mock.method(console, 'error', () => {});
  const before = process.env.REFRESH_FS_ROOT;
  delete process.env.REFRESH_FS_ROOT;
  t.after(() => { if (before !== undefined) process.env.REFRESH_FS_ROOT = before; });
  const requests = mockS3(t);
  const swap = await freshSwap();
  for (const bad of ['12345678901', '1234567890123', 'abcdefghijkl', '', null]) {
    mockImds(t, { accountId: bad });
    await assert.rejects(swap.dataBucket(config), /imds account id/, String(bad));
    assert.equal(await swap.readStateFile(root, 'x.json'), null);
    await swap.persistStateFile(root, 'x.json', 'y');
  }
  assert.deepEqual(requests, []);
  mockImds(t);
  assert.equal(await swap.dataBucket(config), 'opstream-gtm-data-' + SYNTHETIC);
});

test('the IMDS identity-document request times out instead of hanging', { timeout: 5000 }, async (t) => {
  const seen = mockImds(t, {
    document: (init) => new Promise((_, reject) => {
      if (!init.signal) return; // no timeout: hangs, and the test's own 5 s timeout fails it
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }),
  });
  // AbortSignal.timeout does not hold the event loop open; the server's listener does in production.
  const alive = setTimeout(() => {}, 4500);
  t.after(() => clearTimeout(alive));
  const { dataBucket: freshDataBucket } = await freshSwap();
  const started = Date.now();
  await assert.rejects(freshDataBucket(config), (e) => e.name === 'TimeoutError');
  assert.ok(Date.now() - started < 2000, 'gave up within 2 s');
  assert.ok(seen.find((s) => s.url.endsWith('/instance-identity/document')).signal instanceof AbortSignal);
});

// ---- the CloudFormation template ----

// Every scalar in the template with the mapping keys above it. Enough YAML for this file:
// block mappings and sequences, "- " items, quoted scalars, block scalars (skipped), CFN short tags.
function templateScalars(text) {
  const out = [];
  const stack = [];
  let block = null;
  text.split('\n').forEach((line, i) => {
    const indentOf = (l) => l.length - l.trimStart().length;
    if (block !== null) {
      if (!line.trim() || indentOf(line) > block) return;
      block = null;
    }
    let rest = line.trim();
    if (!rest || rest.startsWith('#')) return;
    let indent = indentOf(line);
    while (rest.startsWith('- ')) { rest = rest.slice(2).trimStart(); indent += 2; }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const kv = /^([^\s{["'!][^\s]*?):(?: +(.*))?$/.exec(rest);
    let value = rest;
    if (kv) {
      stack.push({ indent, key: kv[1] });
      value = kv[2] ?? '';
      if (value === '|' || value === '>') { block = indent; return; }
      if (!value) return;
    }
    const sub = /^!Sub\s+/.test(value);
    const raw = value.replace(/^!Sub\s+/, '').replace(/^"(.*)"$/, '$1');
    out.push({ line: i + 1, path: stack.map((s) => s.key), sub, raw });
  });
  return out;
}

const fillPseudo = (s) => s.replaceAll('${AWS::AccountId}', SYNTHETIC).replaceAll('${AWS::Region}', 'us-east-2');
const TEMPLATE = fs.readFileSync(path.join(root, 'infra/gtm-refresh.yaml'), 'utf8');
const NAMED = /opstream-gtm-data-|arn:aws:secretsmanager|arn:aws:s3:::/;

test('template: every S3 and Secrets Manager ARN and the CodeBuild source, filled with the synthetic account', () => {
  const B = 'arn:aws:s3:::opstream-gtm-data-123456789012';
  const S = 'arn:aws:secretsmanager:us-east-2:123456789012:secret:opstream-gtm/';
  const found = templateScalars(TEMPLATE)
    .filter((s) => s.path[0] !== 'Parameters' && NAMED.test(s.raw))
    .map((s) => [s.path[1], s.path.at(-1), s.sub ? fillPseudo(s.raw) : 'NOT !Sub: ' + s.raw]);
  assert.deepEqual(found, [
    ['TaskRole', 'Resource', B],
    ['TaskRole', 'Resource', B + '/*'],
    ['TaskRole', 'Resource', S + '*'],
    ['TaskRole', 'Resource', S + 'hubspot-oauth-*'],
    ['BeanstalkReadPolicy', 'Resource', B + '/published/*'],
    ['BeanstalkReadPolicy', 'Resource', B],
    ['BeanstalkReadPolicy', 'Resource', B + '/state/*'],
    ['BeanstalkReadPolicy', 'Resource', S + 'google-oauth-client-id-*'],
    ['BeanstalkReadPolicy', 'Resource', S + 'google-oauth-client-secret-*'],
    ['BeanstalkReadPolicy', 'Resource', S + 'google-sheets-refresh-token-*'],
    ['BeanstalkReadPolicy', 'Resource', S + 'users/*'],
    ['CodeBuildRole', 'Resource', B + '/code/refresh-src/*'],
    ['RefreshBuild', 'Location', 'opstream-gtm-data-123456789012/${SourceKey}'],
  ]);
});

test('template: no bucket or secret name outside !Sub, and no literal account or region inside one', () => {
  const named = templateScalars(TEMPLATE).filter((s) => NAMED.test(s.raw));
  const outside = named.filter((s) => !s.sub && !(s.path[0] === 'Parameters' && s.path.at(-1) === 'Description'));
  assert.deepEqual(outside.map((s) => s.line + ': ' + s.raw), []);
  const literal = named.filter((s) => s.sub && (/\d{12}/.test(s.raw) || /:us-east-2:|:us-[a-z]+-\d:/.test(s.raw) || /^arn:aws:secretsmanager::/.test(s.raw)));
  assert.deepEqual(literal.map((s) => s.line + ': ' + s.raw), []);
  for (const s of named.filter((x) => x.raw.startsWith('arn:aws:secretsmanager'))) assert.ok(s.raw.startsWith('arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:'), s.line + ': ' + s.raw);
});

// ---- the guard itself: planted ids in a throwaway repo ----

// Built at run time so this file never holds a 12-digit run of its own (AWS's documentation example id).
const PLANTED = ['1111', '2222', '3333'].join('');

test('the guard reports planted account ids in the forms the repo used, and passes the synthetic one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {
    'bucket.json': `{ "dataBucket": "opstream-gtm-data-${PLANTED}" }\n`,
    'fallback.sh': `ACCOUNT=\${ACCOUNT_ID:-${PLANTED}}\n`,
    'arn.yaml': `Resource: arn:aws:secretsmanager:us-east-2:${PLANTED}:secret:x\n`,
    'synthetic.md': `opstream-gtm-data-${SYNTHETIC} and \${ACCOUNT_ID:-${SYNTHETIC}}\n`,
    'untracked.txt': `opstream-gtm-data-${PLANTED}\n`,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', 'bucket.json', 'fallback.sh', 'arn.yaml', 'synthetic.md'], { cwd: dir });
  assert.deepEqual(accountIdHits(dir).sort(), ['arn.yaml', 'bucket.json', 'fallback.sh']);
});

// ---- IMDS and STS answers that are not usable ----

test('an identity document that is not 200 is refused by status, not parsed', async (t) => {
  mockImds(t, { document: () => new Response('Not Found', { status: 404 }) });
  const { dataBucket: freshDataBucket } = await freshSwap();
  await assert.rejects(freshDataBucket(config), /imds identity 404/);
});

test('the IMDS token request times out instead of hanging', { timeout: 5000 }, async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', (url, init = {}) => {
    seen.push({ url: String(url), signal: init.signal });
    if (!String(url).endsWith('/latest/api/token')) throw new Error('unexpected fetch ' + url);
    return new Promise((_, reject) => {
      if (!init.signal) return; // no timeout: hangs, and the test's own 5 s timeout fails it
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  });
  // AbortSignal.timeout does not hold the event loop open; the server's listener does in production.
  const alive = setTimeout(() => {}, 4500);
  t.after(() => clearTimeout(alive));
  const { dataBucket: freshDataBucket } = await freshSwap();
  const started = Date.now();
  await assert.rejects(freshDataBucket(config), (e) => e.name === 'TimeoutError');
  assert.ok(Date.now() - started < 2000, 'gave up within 2 s');
  assert.deepEqual(seen.map((s) => s.url), ['http://169.254.169.254/latest/api/token']);
  assert.ok(seen[0].signal instanceof AbortSignal);
});

test('deploy script refuses an account id that is not 12 digits, from STS or AWS_ACCOUNT_ID', () => {
  const refused = (err) => err.status === 1 && /AWS account id is not 12 digits/.test(err.stderr);
  for (const out of ['', 'None', '12345678901', '1234567890123']) {
    const bin = fakeAws(`echo '${out}'`);
    assert.throws(() => deployBucket({ PATH: bin + ':' + process.env.PATH }), refused, JSON.stringify(out));
  }
  const bin = fakeAws('exit 1');
  assert.throws(() => deployBucket({ PATH: bin + ':' + process.env.PATH, AWS_ACCOUNT_ID: '12345' }), refused);
});
