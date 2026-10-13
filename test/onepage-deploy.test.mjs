// The one-page build is deploy-ready: onepage/deploy-check.mjs accepts a real build and
// refuses a broken one, and workspace/refresh/deploy.sh --onepage runs that check before
// any AWS call (a fake `aws` on PATH fails the test if it is ever invoked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderHtml, buildView } from '../onepage/build.mjs';
import { checkBuild } from '../onepage/deploy-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = JSON.parse(readFileSync(join(ROOT, 'shared', 'workspace-scope.json'), 'utf8'));

// A minimal view the page renders (no data beyond what the components need).
const view = () => buildView({
  meta: { asOf: '2026-10-13T16:00:00Z', portalId: null, provisional: 'provisional (awaiting sign-off)', notSynced: [], leadSourcesAt: null },
  freshness: [], flags: [],
  headline: { open: { count: 0, amount: 0, weighted: 0 }, onHold: { count: 0, amount: 0, noAmount: 0 }, stages: [], change: null, definition: 'x' },
  deals: [], closed: { won: { count: 0, amount: 0 }, lostByStage: [], lost: [], reasonsDoc: null, reasonsNote: '' },
  leads: { connected: false, reason: 'none', items: [] }, mqlFunnel: { available: false }, paidDeals: null, reviewList: null,
  rules: { answeredAt: '2026-10-13T09:48:00-07:00', brandedFlag: 'branded term' }, ads: [], outbound: null,
  meetings: { items: [], thisMonth: { matched: 0, unmatched: 0, noContact: 0 }, upcoming: { matched: 0, unmatched: 0, noContact: 0 }, scope: {}, windowStart: null, definition: '' },
  calls: { items: [], scope: { total: 0, prospect: 0, customer: 0, internal: 0, partner_other: 0 }, classification: 'strategy', definition: '' },
  insights: null, scope: { droppedPipelines: [], customerCompanies: 0, currentPage: null },
});

test('deploy-check accepts a built page and refuses broken ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-'));
  try {
    writeFileSync(join(dir, 'index.html'), renderHtml(view()));
    const ok = checkBuild(dir);
    assert.equal(ok.ok, true, ok.problems.join('; '));
    assert.equal(ok.asOf, '2026-10-13T16:00:00Z');
    assert.equal(checkBuild(join(dir, 'missing')).ok, false);
    writeFileSync(join(dir, 'index.html'), renderHtml(view()).replace('</body>', `<p>${SCOPE.hiddenOwner.pattern}</p></body>`));
    assert.match(checkBuild(dir).problems.join(), /hidden owner/);
    writeFileSync(join(dir, 'index.html'), renderHtml(view()).replace('</head>', '<script src="https://cdn.example/x.js"></script></head>'));
    assert.match(checkBuild(dir).problems.join(), /external scripts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy.sh --onepage refuses a broken build before any AWS call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-deploy-sh-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'aws'), `#!/bin/sh\ntouch "${join(dir, 'aws-called')}"\nexit 99\n`);
    chmodSync(join(bin, 'aws'), 0o755);
    const r = spawnSync('bash', [join(ROOT, 'workspace', 'refresh', 'deploy.sh'), '--onepage', join(dir, 'no-build')],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not deployable/);
    assert.ok(!existsSync(join(dir, 'aws-called')), 'aws must not be called');
    const bad = spawnSync('bash', [join(ROOT, 'workspace', 'refresh', 'deploy.sh'), '--onepage'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.ok(!existsSync(join(dir, 'aws-called')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
