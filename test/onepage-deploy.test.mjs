// The one-page build is deploy-ready: onepage/deploy-check.mjs accepts real builds (the
// data-less app page and a page with data inside) and refuses broken ones, and
// workspace/refresh/deploy.sh --onepage / --onepage-app run their checks before any AWS
// call (a fake `aws` on PATH fails the test if it is ever invoked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
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
