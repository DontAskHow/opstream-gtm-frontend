// The one-page build is deploy-ready: onepage/deploy-check.mjs accepts real builds (the
// data-less app page and a page with data inside) and refuses broken ones, and
// workspace/refresh/deploy.sh --onepage / --onepage-app run their checks before any AWS
// call (a fake `aws` on PATH fails the test if it is ever invoked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { renderHtml, renderAppHtml, buildView } from '../onepage/build.mjs';
import { checkBuild } from '../onepage/deploy-check.mjs';

const require = createRequire(import.meta.url);
const { SYNTHETIC_SCRUB } = require('../scripts/synthetic-data.cjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS = [SYNTHETIC_SCRUB];

// A minimal view the page renders (no data beyond what the components need).
const view = () => buildView({
  schemaVersion: 1,
  meta: { generatedAt: '2026-10-13T16:00:00Z', portalId: null, provisional: 'provisional (awaiting sign-off)', notSynced: [], leadSourcesAt: null },
  freshness: [], flags: [],
  headline: { open: { count: 0, amount: 0, weighted: 0 }, onHold: { count: 0, amount: 0, noAmount: 0 }, stages: [], change: null, definition: 'x' },
  deals: [], closed: { won: { count: 0, amount: 0 }, lostByStage: [], lost: [], reasonsDoc: null, reasonsNote: '' },
  leads: { connected: false, reason: 'none', items: [] }, mqlFunnel: { available: false }, paidDeals: null, reviewList: null,
  rules: { answeredAt: '2026-10-13T09:48:00-07:00', brandedFlag: 'branded term' }, ads: [], outbound: null,
  meetings: { items: [], thisMonth: { matched: 0, unmatched: 0, noContact: 0 }, upcoming: { matched: 0, unmatched: 0, noContact: 0 }, scope: {}, windowStart: null, definition: '' },
  calls: { items: [], scope: { total: 0, prospect: 0, customer: 0, internal: 0, partner_other: 0 }, classification: 'strategy', definition: '' },
  insights: null, scope: { droppedPipelines: [], customerCompanies: 0, currentPage: null },
});

test('deploy-check accepts both builds and refuses broken ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-'));
  try {
    writeFileSync(join(dir, 'index.html'), renderAppHtml());
    const app = checkBuild(dir, { app: true, patterns: PATTERNS });
    assert.equal(app.ok, true, app.problems.join('; '));
    assert.match(checkBuild(dir, { app: false, patterns: PATTERNS }).problems.join(), /embedded data block is missing/);
    writeFileSync(join(dir, 'index.html'), renderHtml(view()));
    const baked = checkBuild(dir, { patterns: PATTERNS });
    assert.equal(baked.ok, true, baked.problems.join('; '));
    assert.equal(baked.generatedAt, '2026-10-13T16:00:00Z');
    assert.match(checkBuild(dir, { app: true, patterns: PATTERNS }).problems.join(), /must not carry data/);
    assert.match(checkBuild(dir, { patterns: [] }).problems.join(), /no scrub patterns/);
    assert.equal(checkBuild(join(dir, 'missing'), { patterns: PATTERNS }).ok, false);
    writeFileSync(join(dir, 'index.html'), renderHtml(view()).replace('</body>', `<p>${SYNTHETIC_SCRUB}</p></body>`));
    const hit = checkBuild(dir, { patterns: PATTERNS }).problems.join();
    assert.match(hit, /scrub pattern #1 appears/);
    assert.ok(!hit.includes(SYNTHETIC_SCRUB), 'the pattern itself is never echoed');
    writeFileSync(join(dir, 'index.html'), renderHtml(view()).replace('</head>', '<script src="https://cdn.example/x.js"></script></head>'));
    assert.match(checkBuild(dir, { patterns: PATTERNS }).problems.join(), /external scripts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function deploy(args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-sh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'aws'), `#!/bin/sh\ntouch "${join(dir, 'aws-called')}"\nexit 99\n`);
  chmodSync(join(bin, 'aws'), 0o755);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WORKSPACE_SCRUB')));
  const r = spawnSync('bash', [join(ROOT, 'workspace', 'refresh', 'deploy.sh'), ...args.map((a) => a.replace('$DIR', dir))],
    { env: { ...clean, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf8' });
  const called = existsSync(join(dir, 'aws-called'));
  rmSync(dir, { recursive: true, force: true });
  return { ...r, called };
}

test('deploy.sh refuses broken one-page deploys before any AWS call', () => {
  const r = deploy(['--onepage', '$DIR/no-build'], { WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not deployable/);
  assert.equal(r.called, false);
  const noDir = deploy(['--onepage']);
  assert.notEqual(noDir.status, 0);
  assert.equal(noDir.called, false);
  const noPatterns = deploy(['--onepage-app']);
  assert.equal(noPatterns.status, 1);
  assert.match(noPatterns.stderr, /--onepage-app needs scrub patterns/);
  assert.equal(noPatterns.called, false);
  const both = deploy(['--onepage', '$DIR', '--onepage-app'], { WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB });
  assert.notEqual(both.status, 0);
  assert.equal(both.called, false);
});

test('deploy.sh --onepage-app builds and checks the data-less page, then needs AWS (the fake refuses)', () => {
  // With patterns given, the build and check pass and the first AWS call is the account check.
  const r = deploy(['--onepage-app'], { WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB });
  assert.notEqual(r.status, 0);
  assert.equal(r.called, true, 'got as far as the account check');
  assert.ok(!/not deployable|needs scrub patterns/.test(r.stderr), r.stderr);
});

// A fake `aws` for the whole --onepage-app run: logs every call's arguments and answers the
// queries deploy.sh makes. FAKE_FUNCTION_ERROR, FAKE_REFRESH, FAKE_NO_WORKSPACE and
// FAKE_INDEX_META steer the invoke -> check -> upload sequence. FAKE_CURRENT_ENV is the function's
// current environment (JSON); FAKE_ENV_OUT receives the environment file deploy.sh sends; FAKE_POLICY_DIR
// receives each role policy document.
const FAKE_AWS = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "sts get-caller-identity") echo 123456789012 ;;
  "iam get-role") [[ "$*" == *--query* ]] && echo arn:aws:iam::123456789012:role/fake ;;
  "lambda get-function-configuration")
    if [[ "$*" == *"--query Environment.Variables --"* ]]; then echo "\${FAKE_CURRENT_ENV:-null}"; else echo "\${FAKE_CURRENT_PATTERNS:-None}"; fi ;;
  "iam put-role-policy")
    for a in "$@"; do [[ "$a" == file://* ]] && [ -n "$FAKE_POLICY_DIR" ] && cp "\${a#file://}" "$FAKE_POLICY_DIR/"; done ;;
  "lambda update-function-configuration")
    for a in "$@"; do [[ "$a" == file://* ]] && [ -n "$FAKE_ENV_OUT" ] && cp "\${a#file://}" "$FAKE_ENV_OUT"; done ;;
  "lambda invoke")
    out="\${@: -1}"; echo '{"ok":true}' > "$out"
    if [ -n "$FAKE_FUNCTION_ERROR" ]; then echo '{"StatusCode":200,"FunctionError":"Unhandled"}'; else echo '{"StatusCode":200}'; fi ;;
  "scheduler get-schedule") echo ENABLED ;;
  "s3api head-object")
    if [[ "$*" == *workspace.json* ]]; then [ -n "$FAKE_NO_WORKSPACE" ] && exit 254; exit 0; fi
    if [[ "$*" == *index.html* ]]; then echo "\${FAKE_INDEX_META:-None}"; fi ;;
  "s3 cp")
    if [[ "$3" == s3://*refresh.json ]]; then printf '%s' "$FAKE_REFRESH" > "$4"; fi ;;
esac
exit 0
`;

function deployRun(args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-seq-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'aws'), FAKE_AWS);
  chmodSync(join(bin, 'aws'), 0o755);
  const log = join(dir, 'aws.log');
  writeFileSync(log, '');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WORKSPACE_SCRUB') && !k.startsWith('FAKE_')));
  const r = spawnSync('bash', [join(ROOT, 'workspace', 'refresh', 'deploy.sh'), ...args],
    { env: { ...clean, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...env }, encoding: 'utf8', timeout: 300000 });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  return { ...r, calls };
}
const ok = JSON.stringify({ workspace: { status: 'uploaded', problem: null } });
const uploadsIndex = (calls) => calls.some((c) => /^s3 cp .*index\.html s3:\/\/[^ ]+\/index\.html/.test(c));

test('deploy.sh --onepage-app: invoke (150 s read timeout) -> FunctionError -> refresh.json status -> head -> upload', () => {
  const r = deployRun(['--onepage-app'], { WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB, FAKE_REFRESH: ok });
  assert.equal(r.status, 0, r.stderr);
  const i = r.calls.findIndex((c) => c.startsWith('lambda invoke'));
  assert.ok(i >= 0 && /--cli-read-timeout 150/.test(r.calls[i]));
  const order = ['lambda invoke', 's3 cp s3://opstream-gtm-preview-db5553a4/refresh.json', 's3api head-object --bucket opstream-gtm-preview-db5553a4 --key workspace.json', 's3 cp '];
  let at = -1;
  for (const step of order) { const j = r.calls.findIndex((c, k) => k > at && c.startsWith(step)); assert.ok(j > at, `${step} in order`); at = j; }
  assert.ok(uploadsIndex(r.calls));
  assert.ok(r.calls.some((c) => /index\.html .*--metadata gtm-page=onepage-app/.test(c)));
  // Patterns go to the function through a private file, never on a command line.
  assert.ok(!r.calls.join('\n').toLowerCase().includes(SYNTHETIC_SCRUB));
  assert.ok(r.calls.some((c) => /update-function-configuration .*--environment file:\/\//.test(c)));
  // workspace.json: write-only for the function.
  const policy = readFileSync(join(ROOT, 'workspace', 'refresh', 'deploy.sh'), 'utf8');
  assert.match(policy, /"Action":"s3:PutObject",\s*"Resource":\["arn:aws:s3:::\$PREVIEW_BUCKET\/workspace\.json"\]/);
  assert.ok(!/s3:GetObject[^}]*workspace\.json/.test(policy));
});

test('deploy.sh --onepage-app keeps the live page on a failed run, a kept or withheld copy, or no workspace.json', () => {
  const env = { WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB, FAKE_REFRESH: ok };
  const failed = deployRun(['--onepage-app'], { ...env, FAKE_FUNCTION_ERROR: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FunctionError/);
  assert.ok(!uploadsIndex(failed.calls));
  for (const status of ['kept-last-good', 'withheld']) {
    const r = deployRun(['--onepage-app'], { ...env, FAKE_REFRESH: JSON.stringify({ workspace: { status, problem: 'x' } }) });
    assert.equal(r.status, 1, status);
    assert.match(r.stderr, new RegExp(`'${status} x'`));
    assert.ok(!uploadsIndex(r.calls), status);
  }
  const garbled = deployRun(['--onepage-app'], { ...env, FAKE_REFRESH: '{"workspace": ' });
  assert.equal(garbled.status, 1);
  assert.match(garbled.stderr, /'unreadable '/);
  assert.ok(!/Traceback/.test(garbled.stderr));
  assert.ok(!uploadsIndex(garbled.calls));
  const none = deployRun(['--onepage-app'], { ...env, FAKE_NO_WORKSPACE: '1' });
  assert.equal(none.status, 1);
  assert.ok(!uploadsIndex(none.calls));
});

test('a plain deploy leaves a live one-page index.html unless --restore-app', () => {
  const env = { FAKE_CURRENT_PATTERNS: SYNTHETIC_SCRUB, FAKE_INDEX_META: 'onepage-app' };
  const kept = deployRun([], env);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stderr, /index\.html is the one-page workspace: left as it is/);
  assert.ok(!kept.calls.some((c) => /src\/index\.html s3:/.test(c)));
  assert.ok(kept.calls.some((c) => /src\/app\.js s3:/.test(c)), 'the other app files still go up');
  const restored = deployRun(['--restore-app'], env);
  assert.equal(restored.status, 0, restored.stderr);
  assert.ok(restored.calls.some((c) => /src\/index\.html s3:/.test(c)));
});

test('deploy.sh: a patterns file with only comments stops with a message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-pat-'));
  try {
    writeFileSync(join(dir, 'p.txt'), '# nothing here\n\n');
    const r = deployRun(['--onepage-app'], { WORKSPACE_SCRUB_PATTERNS_FILE: join(dir, 'p.txt') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has no patterns/);
    assert.equal(r.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy.sh --lambda-only: function code and environment only; IAM, schedule, alarm and every bucket file untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-env-'));
  try {
    const envOut = join(dir, 'env.json');
    const r = deployRun(['--lambda-only'], {
      FAKE_CURRENT_PATTERNS: SYNTHETIC_SCRUB, FAKE_INDEX_META: 'fresh-workspace', FAKE_ENV_OUT: envOut,
      FAKE_CURRENT_ENV: JSON.stringify({ LIVE_PULL: '0', WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB, WORKSPACE_STALE_MIN: '45', OTHER: 'dropped' }),
      FRESH_STALE_MIN: '80',
    });
    assert.equal(r.status, 0, r.stderr);
    const verbs = r.calls.map((c) => c.split(' ').slice(0, 2).join(' '));
    assert.deepEqual([...new Set(verbs)].sort(), ['lambda get-function', 'lambda get-function-configuration', 'lambda update-function-code', 'lambda update-function-configuration', 'lambda wait', 'sts get-caller-identity']);
    const conf = r.calls.find((c) => c.startsWith('lambda update-function-configuration'));
    assert.match(conf, /^lambda update-function-configuration --function-name gtm-preview-refresh --environment file:\/\/\S+$/, 'environment only: runtime, role, memory, timeout unchanged');
    assert.ok(!r.calls.some((c) => /^(s3|s3api|iam|scheduler|cloudwatch|logs) /.test(c)), 'no bucket, IAM, schedule, alarm or log group call');
    assert.ok(!r.calls.join('\n').toLowerCase().includes(SYNTHETIC_SCRUB), 'patterns never on a command line');
    assert.match(r.stdout, /code and environment only/);
    // Patterns and minute settings kept from the current function; a setting given now wins.
    assert.deepEqual(JSON.parse(readFileSync(envOut, 'utf8')).Variables,
      { LIVE_PULL: '0', WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB, WORKSPACE_STALE_MIN: '45', FRESH_STALE_MIN: '80' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const extra of ['--onepage-app', '--restore-app', '--enable', '--disabled']) {
    const r = deployRun(['--lambda-only', extra], { WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB });
    assert.equal(r.status, 2, extra);
    assert.match(r.stderr, /does not combine/);
    assert.equal(r.calls.length, 0, extra);
  }
});

test('deploy.sh takes the account from STS: policy, alarm topic and function ARN carry the caller\'s account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-acct-'));
  try {
    const r = deployRun(['--no-app'], { FAKE_CURRENT_PATTERNS: SYNTHETIC_SCRUB, FAKE_POLICY_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    const statements = JSON.parse(readFileSync(join(dir, 'policy-lambda.json'), 'utf8')).Statement;
    const resource = (sid) => statements.find((st) => st.Sid === sid).Resource;
    assert.equal(resource('SnapshotList'), 'arn:aws:s3:::opstream-gtm-data-123456789012');
    assert.equal(resource('SnapshotRead'), 'arn:aws:s3:::opstream-gtm-data-123456789012/published/*');
    assert.equal(resource('Alarm'), 'arn:aws:sns:us-east-2:123456789012:opstream-gtm-refresh-failures');
    assert.equal(resource('OwnLogGroupOnly'), 'arn:aws:logs:us-east-2:123456789012:log-group:/aws/lambda/gtm-preview-refresh:*');
    assert.ok(r.calls.some((c) => c.startsWith('cloudwatch put-metric-alarm') && c.includes('--alarm-actions arn:aws:sns:us-east-2:123456789012:opstream-gtm-refresh-failures')));
    assert.match(r.stdout, /^function {2}arn:aws:lambda:us-east-2:123456789012:function:gtm-preview-refresh$/m);
    assert.equal(r.calls.filter((c) => c.startsWith('sts get-caller-identity')).length, 1, 'one STS call');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy.sh refuses when AWS_ACCOUNT_ID is not the caller\'s account, before any other AWS call', () => {
  const wrong = deployRun(['--lambda-only'], { FAKE_CURRENT_PATTERNS: SYNTHETIC_SCRUB, AWS_ACCOUNT_ID: '000000000000' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /wrong AWS account/);
  assert.deepEqual(wrong.calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['sts get-caller-identity']);
  const right = deployRun(['--lambda-only'], { FAKE_CURRENT_PATTERNS: SYNTHETIC_SCRUB, AWS_ACCOUNT_ID: '123456789012' });
  assert.equal(right.status, 0, right.stderr);
});

test('a plain deploy leaves any tagged index.html (the fresh frontend) unless --restore-app', () => {
  const r = deployRun([], { FAKE_CURRENT_PATTERNS: SYNTHETIC_SCRUB, FAKE_INDEX_META: 'fresh-workspace' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /index\.html carries gtm-page=fresh-workspace: left as it is/);
  assert.ok(!r.calls.some((c) => /src\/index\.html s3:/.test(c)));
  const untagged = deployRun([], { FAKE_CURRENT_PATTERNS: SYNTHETIC_SCRUB });
  assert.ok(untagged.calls.some((c) => /src\/index\.html s3:/.test(c)), 'an untagged index.html is the workspace app: updated');
});
