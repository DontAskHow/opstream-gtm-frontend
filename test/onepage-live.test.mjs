// The live one-page workspace: the sync job publishes workspace.json with each snapshot
// run, the preview refresh Lambda copies it to the preview bucket (copy / skip unchanged /
// keep last good / missing), and the data-less page fetches it and renders client-side.
// Fake S3 and SNS, synthetic data only, no AWS. The browser part needs Python Playwright
// (PLAYWRIGHT_PYTHON, default /workspace/.venv-pw/bin/python) and is skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { refresh } from '../workspace/refresh/handler.mjs';
import { contentHash, validateWorkspace, stripVolatile, PROBLEMS, SCHEMA_VERSION } from '../workspace/refresh/workspace-json.mjs';
import { renderAppHtml } from '../onepage/build.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { brainFixture, SYNTHETIC_SCRUB } = require('../scripts/synthetic-data.cjs');
const { buildView } = require('../onepage/view.cjs');
const page = require('../onepage/page.cjs');

// One synthetic workspace.json from the real data step (the way the sync job runs it).
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-live-ws-'));
  const fx = brainFixture({});
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fx));
  execFileSync('python3', [join(ROOT, 'scripts', 'fixture-db.py'), join(dir, 'fixture.json'), join(dir, 'brain.db')]);
  const ind = join(dir, 'in');
  mkdirSync(ind);
  writeFileSync(join(ind, 'lead-sources.json'), JSON.stringify(fx.inputs.leadSources));
  writeFileSync(join(ind, 'records.jsonl'), fx.text['records.jsonl']);
  writeFileSync(join(ind, 'scrub-patterns.txt'), SYNTHETIC_SCRUB + '\n');
  const env = { ...process.env, WORKSPACE_SCRUB_PATTERNS: '', WORKSPACE_SCRUB_PATTERNS_FILE: '', CALL_CLASSIFICATION: '', LEAD_SOURCE_REVIEW: '', PAID_EXPORT: '' };
  execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', join(dir, 'brain.db'), '--inputs-dir', ind,
    '--portal-id', '12345', '--out', join(dir, 'workspace.json'), '--quiet'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = readFileSync(join(dir, 'workspace.json'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return text;
}
const WS = makeWorkspace();
const restamp = (text, iso) => {
  const d = JSON.parse(text);
  d.meta.generatedAt = iso;
  for (const f of d.freshness) { f.at = iso; f.lastOkAt = iso; }
  return JSON.stringify(d);
};

// ---------- the Lambda against a fake S3 ----------
const GEN = '2026-10-13T15:00:00Z';
function snapshotFiles() {
  return {
    'records.json': { generatedAt: GEN, owners: {}, companies: [{ id: 'c1', name: 'Example Corp', deals: [{ id: '101', name: 'Example', stage: 's1', amount: 1000 }] }] },
    'marketing.json': { generatedAt: GEN, outbound: { fetchedAt: GEN, campaignStats: [] }, sources: [] },
    'agent-brief.json': { generatedAt: GEN, whatsNew: [], topActions: [], watchOuts: [] },
    'hubspot-deals.json': { fetchedAt: GEN, pipes: { default: 'Sales Pipeline' }, stages: { s1: { pipe: 'Sales Pipeline', label: 'Discovery', closed: false, prob: '0.2' } },
      deals: [{ id: '101', properties: { dealname: 'Example', dealstage: 's1', pipeline: 'default', amount: '1000', hs_deal_stage_probability: '0.2' } }] },
  };
}

function world({ patterns = [SYNTHETIC_SCRUB] } = {}) {
  const s3 = new Map();
  const w = { s3, puts: [], notes: [], tmp: mkdtempSync(join(tmpdir(), 'onepage-live-')), runs: 0 };
  let clock = Date.parse('2026-10-13T16:00:00Z');
  w.publish = (workspaceText) => {
    const runId = `run-${++w.runs}`;
    const prefix = `published/${runId}/`;
    for (const [k, v] of Object.entries(snapshotFiles())) s3.set(`data/${prefix}${k}`, JSON.stringify(v));
    if (workspaceText != null) s3.set(`data/${prefix}workspace.json`, workspaceText);
    s3.set('data/published/LATEST.json', JSON.stringify({ runId, prefix, publishedAt: new Date(clock).toISOString() }));
  };
  w.deps = {
    async getText(bucket, key) { return s3.get(`${bucket === 'B-data' ? 'data' : 'preview'}/${key}`) ?? null; },
    async put(bucket, key, body, opts) { w.puts.push({ key, opts }); s3.set(`preview/${key}`, body); },
    async list(bucket, prefix) { return [...s3.keys()].filter((k) => k.startsWith('data/' + prefix)).map((k) => ({ key: k.slice(5), size: s3.get(k).length })); },
    async notify(subject, message) { w.notes.push({ subject, message }); },
  };
  w.cfg = { dataBucket: 'B-data', latestKey: 'published/LATEST.json', previewBucket: 'B-preview', dataKey: 'data.js', refreshKey: 'refresh.json',
    hubspotCacheKey: '_state/hubspot-live.json', maxSnapshotFileBytes: 5e6, tmp: w.tmp, livePull: false, staleMinutes: 1e6,
    workspaceKey: 'workspace.json', scrubPatterns: patterns };
  w.run = (advanceMin = 15) => { clock += advanceMin * 60e3; return refresh(w.deps, { cfg: w.cfg, now: () => new Date(clock), log: () => {} }); };
  w.wsPuts = () => w.puts.filter((p) => p.key === 'workspace.json').length;
  w.refreshDoc = () => JSON.parse(s3.get('preview/refresh.json'));
  w.done = () => rmSync(w.tmp, { recursive: true, force: true });
  return w;
}

test('workspace.json: the synthetic data step output passes the checks', () => {
  const v = validateWorkspace(WS, [SYNTHETIC_SCRUB]);
  assert.deepEqual(v.errors, []);
  assert.equal(v.doc.schemaVersion, SCHEMA_VERSION);
  assert.ok(Buffer.byteLength(WS) < 3 * 1048576);
  // Time keys use the sync job's volatile names, so the same content hashes the same.
  assert.equal(contentHash(JSON.parse(WS)), contentHash(JSON.parse(restamp(WS, '2026-10-14T00:00:00Z'))));
  assert.ok(!('asOf' in JSON.parse(WS).meta), 'asOf only when given');
  const stripped = JSON.stringify(stripVolatile(JSON.parse(WS)));
  assert.ok(!stripped.includes(JSON.parse(WS).meta.generatedAt), 'no build time survives the strip');
});

test('Lambda: copies a new workspace.json, skips an unchanged one, stamps the newer times', async (t) => {
  const w = world();
  t.after(w.done);
  w.publish(restamp(WS, '2026-10-13T16:00:00Z'));
  const r1 = await w.run();
  assert.equal(r1.workspace.status, 'uploaded');
  assert.equal(w.wsPuts(), 1);
  assert.equal(w.puts.find((p) => p.key === 'workspace.json').opts.cacheControl, 'no-store');
  // Same content, newer timestamps: not uploaded; refresh.json carries the new times.
  w.publish(restamp(WS, '2026-10-13T16:30:00Z'));
  const r2 = await w.run();
  assert.equal(r2.workspace.status, 'unchanged');
  assert.equal(w.wsPuts(), 1);
  const doc = w.refreshDoc();
  assert.equal(doc.workspace.stamps.generatedAt, '2026-10-13T16:30:00Z');
  assert.equal(doc.workspace.publishedGeneratedAt, '2026-10-13T16:00:00Z');
  const view = buildView(JSON.parse(w.s3.get('preview/workspace.json')), doc);
  assert.equal(view.meta.generatedAt, '2026-10-13T16:30:00Z', 'the page shows the newer time');
  // Changed content: uploaded again.
  const changed = JSON.parse(WS); changed.headline.open.count += 1;
  w.publish(JSON.stringify(changed));
  assert.equal((await w.run()).workspace.status, 'uploaded');
  assert.equal(w.wsPuts(), 2);
  assert.equal(w.notes.length, 0, 'no alarm on the happy path');
});

test('Lambda: an invalid workspace.json (scrub hit, schema) keeps the last good copy and alarms once', async (t) => {
  const w = world();
  t.after(w.done);
  w.publish(WS);
  await w.run();
  const good = w.s3.get('preview/workspace.json');
  const bad = JSON.parse(WS); bad.deals[0].owner = SYNTHETIC_SCRUB.toUpperCase() + ' Example';
  w.publish(JSON.stringify(bad));
  const r = await w.run();
  assert.equal(r.workspace.status, 'kept-last-good');
  assert.equal(r.workspace.problem, PROBLEMS.invalid);
  assert.equal(w.s3.get('preview/workspace.json'), good);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].message, /scrub check: pattern #1 appears/);
  assert.ok(!w.notes[0].message.toLowerCase().includes(SYNTHETIC_SCRUB), 'the pattern itself is never echoed');
  const doc = w.refreshDoc();
  assert.equal(doc.workspace.problem, PROBLEMS.invalid);
  assert.equal(buildView(JSON.parse(good), doc).live.problem, PROBLEMS.invalid, 'the page says it shows the last good copy');
  const wrong = JSON.parse(WS); wrong.schemaVersion = 99;
  w.publish(JSON.stringify(wrong));
  assert.equal((await w.run()).workspace.problem, PROBLEMS.invalid);
  w.publish('{"not": "json"');
  assert.equal((await w.run()).workspace.problem, PROBLEMS.invalid);
  assert.equal(w.notes.length, 1, 'the same problem does not alarm again');
});

test('Lambda: a snapshot without workspace.json keeps the previous copy and alarms once, with no daily reminder', async (t) => {
  const w = world();
  t.after(w.done);
  w.publish(WS);
  await w.run();
  w.publish(null);
  const r = await w.run();
  assert.equal(r.workspace.problem, PROBLEMS.missing);
  assert.ok(r.failing.includes('snapshot-has-no-workspace-json'));
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].subject, /snapshot-has-no-workspace-json/);
  assert.ok(w.s3.has('preview/workspace.json'), 'the last good copy stays');
  await w.run(60 * 25); // a day later, still missing
  assert.equal(w.notes.length, 1, 'no reminder for workspace problems');
  w.publish(WS);
  const back = await w.run();
  assert.equal(back.workspace.status, 'unchanged');
  assert.equal(w.notes.length, 2);
  assert.match(w.notes[1].subject, /problems cleared/);
});

test('Lambda: without scrub patterns nothing is copied', async (t) => {
  const w = world({ patterns: [] });
  t.after(w.done);
  w.publish(WS);
  const r = await w.run();
  assert.equal(r.workspace.problem, PROBLEMS.noPatterns);
  assert.equal(w.wsPuts(), 0);
});

test('page (no browser): stamps, the 45-minute amber, the last-good banner, the error view', () => {
  const data = JSON.parse(restamp(WS, '2026-10-13T16:00:00Z'));
  const now = Date.parse('2026-10-13T16:10:00Z');
  const fresh = page.header(buildView(data, null), { now });
  assert.match(fresh, /chip-ok" data-updated="2026-10-13T16:00:00Z"/);
  assert.match(fresh, /Updated Oct 13, 9:00 AM PT/);
  const old = page.header(buildView(data, null), { now: now + 50 * 60e3 });
  assert.match(old, /chip-warn" data-updated=/);
  assert.match(old, /over 45 min ago/);
  // Stamps apply only when refresh.json says the current content is the published copy.
  const stamped = { refreshedAt: '2026-10-13T17:00:00Z', workspace: { sha256: 'a', publishedSha256: 'a', stamps: { generatedAt: '2026-10-13T16:55:00Z', freshness: [] } } };
  assert.match(page.header(buildView(data, stamped), { now: now + 50 * 60e3 }), /chip-ok" data-updated="2026-10-13T16:55:00Z"/);
  const notPublished = { workspace: { sha256: 'b', publishedSha256: 'a', stamps: { generatedAt: '2026-10-13T16:55:00Z' } } };
  assert.equal(buildView(data, notPublished).meta.generatedAt, '2026-10-13T16:00:00Z');
  const lastGood = { refreshedAt: '2026-10-13T17:00:00Z', workspace: { status: 'kept-last-good', problem: PROBLEMS.missing, publishedSha256: 'a', stamps: null } };
  assert.match(page.header(buildView(data, lastGood), { now }), /Showing the last good data: the latest snapshot has no workspace\.json/);
  assert.match(page.errorView('workspace.json answered HTTP 404.'), /could not be loaded[\s\S]*HTTP 404[\s\S]*data-retry/);
  const app = renderAppHtml();
  assert.ok(!app.includes('id="gtm-data"'), 'the deployed page carries no data');
  assert.match(app, /connect-src 'self'/);
});

// ---------- a real browser against a local server ----------
const PY = process.env.PLAYWRIGHT_PYTHON || '/workspace/.venv-pw/bin/python';
const hasBrowser = existsSync(PY) && (() => { try { execFileSync(PY, ['-c', 'import playwright'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('page (browser): fetches workspace.json, renders, deep-links, ages to amber, shows errors', { skip: !hasBrowser && 'Python Playwright not available' }, async (t) => {
  const files = { '/index.html': renderAppHtml(), '/workspace.json': restamp(WS, new Date().toISOString()), '/refresh.json': null };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const body = files[path];
    if (body == null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const view = buildView(JSON.parse(files['/workspace.json']), null);
  const leadId = view.leads.items.find((l) => l.company === 'Orchid Retail').id;
  const script = `
import json, sys
from playwright.sync_api import sync_playwright
url, lead = sys.argv[1], sys.argv[2]
out = {}
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(url + '#src=Paid&lead=' + lead); pg.wait_for_selector('#pipeline'); pg.wait_for_selector('.drawer')
    out['open'] = pg.inner_text('[data-fig="open-count"] .tile-v'); out['drawer'] = pg.inner_text('.drawer h2')
    out['updatedClass'] = pg.get_attribute('[data-updated]', 'class'); out['hash'] = pg.evaluate('location.hash')
    pg.keyboard.press('Escape'); out['closed'] = pg.locator('.drawer').count()
    print(json.dumps(out)); sys.stdout.flush()
    sys.stdin.readline()  # the test swaps the files
    pg.goto(url); pg.wait_for_selector('#pipeline'); out2 = {'updatedClass': pg.get_attribute('[data-updated]', 'class'), 'banner': pg.locator('.chip-alert').all_inner_texts()}
    print(json.dumps(out2)); sys.stdout.flush()
    sys.stdin.readline()
    pg.goto(url); pg.wait_for_selector('.sec.error'); out3 = {'error': pg.inner_text('.sec.error')}
    print(json.dumps(out3)); sys.stdout.flush()
    sys.stdin.readline()
    pg.click('[data-retry]'); pg.wait_for_selector('#pipeline'); out3b = {'retried': True, 'errors': errors}
    print(json.dumps(out3b)); sys.stdout.flush()
    b.close()
`;
  const dir = mkdtempSync(join(tmpdir(), 'onepage-browser-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'check.py'), script);
  const child = spawn(PY, [join(dir, 'check.py'), url, leadId], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const lines = [];
  const waiters = [];
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (waiters.length) waiters.shift()(l); else lines.push(l); } });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const next = () => new Promise((resolve, reject) => {
    if (lines.length) return resolve(JSON.parse(lines.shift()));
    const to = setTimeout(() => reject(new Error('browser check timed out: ' + err.slice(-500))), 120000);
    waiters.push((l) => { clearTimeout(to); resolve(JSON.parse(l)); });
  });
  const a = await next();
  assert.equal(a.open, '4');
  assert.equal(a.drawer, 'Orchid Retail');
  assert.match(a.updatedClass, /chip-ok/);
  assert.match(a.hash, /lead=/);
  assert.equal(a.closed, 0);
  // Old data and a refresh.json that says the latest snapshot had none: amber + last-good banner.
  files['/workspace.json'] = restamp(WS, '2026-01-01T00:00:00Z');
  files['/refresh.json'] = JSON.stringify({ refreshedAt: new Date().toISOString(), workspace: { status: 'kept-last-good', problem: PROBLEMS.missing } });
  child.stdin.write('\n');
  const b = await next();
  assert.match(b.updatedClass, /chip-warn/);
  assert.ok(b.banner.some((x) => /last good data/.test(x)));
  // workspace.json missing: a clear error, then recovery on retry.
  delete files['/workspace.json'];
  child.stdin.write('\n');
  const c = await next();
  assert.match(c.error, /could not be loaded/);
  assert.match(c.error, /HTTP 404/);
  files['/workspace.json'] = WS;
  child.stdin.write('\n');
  const d = await next();
  assert.equal(d.retried, true);
  assert.deepEqual(d.errors, []);
  child.stdin.end();
});
