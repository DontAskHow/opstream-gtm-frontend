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
import { contentHash, textHash, validateWorkspace, stripVolatile, PROBLEMS, SCHEMA_VERSION } from '../workspace/refresh/workspace-json.mjs';
import { renderAppHtml } from '../onepage/build.mjs';
import { withheldDocument, staleness, STALE, MAX_AGE_MINUTES, WORKSPACE_STALE_MINUTES, FRESH_STALE_MINUTES } from '../workspace/refresh/workspace-json.mjs';
const withheldDoc = () => withheldDocument('2026-10-13T17:00:00Z');

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
  // mode: LATEST.json's mode. The sync-only job (every 15 min) writes workspace.json; the 6-hourly full job (no mode) does not.
  w.publish = (workspaceText, mode = 'sync-only') => {
    const runId = `run-${++w.runs}`;
    const prefix = `published/${runId}/`;
    for (const [k, v] of Object.entries(snapshotFiles())) s3.set(`data/${prefix}${k}`, JSON.stringify(v));
    if (workspaceText != null) s3.set(`data/${prefix}workspace.json`, workspaceText);
    s3.set('data/published/LATEST.json', JSON.stringify({ runId, prefix, publishedAt: new Date(clock).toISOString(), ...(mode ? { mode } : {}) }));
  };
  w.deps = {
    async getText(bucket, key) { return s3.get(`${bucket === 'B-data' ? 'data' : 'preview'}/${key}`) ?? null; },
    async put(bucket, key, body, opts) { w.puts.push({ key, opts }); s3.set(`preview/${key}`, body); },
    async list(bucket, prefix) { return [...s3.keys()].filter((k) => k.startsWith('data/' + prefix)).map((k) => ({ key: k.slice(5), size: s3.get(k).length })); },
    async notify(subject, message) { w.notes.push({ subject, message }); },
  };
  w.cfg = { dataBucket: 'B-data', latestKey: 'published/LATEST.json', previewBucket: 'B-preview', dataKey: 'data.js', refreshKey: 'refresh.json',
    hubspotCacheKey: '_state/hubspot-live.json', maxSnapshotFileBytes: 5e6, tmp: w.tmp, livePull: false, staleMinutes: 1e6,
    workspaceKey: 'workspace.json', scrubPatterns: patterns,
    // Off unless a test sets them (the copy-on-age and stale tests below).
    workspaceMaxAgeMinutes: 1e6, workspaceStaleMinutes: 1e6, freshStaleMinutes: 1e6 };
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

test('workspace.json checks: a file the page cannot render, a parse error, an escaped name', () => {
  // The minimum the old check accepted: it does not render, so it is refused.
  const bare = JSON.stringify({ schemaVersion: 1, meta: { generatedAt: '2026-10-13T16:00:00Z' }, headline: { open: { count: 1, amount: 1 } } });
  const v = validateWorkspace(bare, [SYNTHETIC_SCRUB]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /closed missing/.test(e)));
  // Every key present but one section broken: the trial render catches it.
  const broken = JSON.parse(WS); broken.leads.items = 'oops';
  assert.match(validateWorkspace(JSON.stringify(broken), [SYNTHETIC_SCRUB]).errors.join(), /does not render \(TypeError\)/);
  // A truncated file: no text from the file in the error (a parse message would quote it).
  const cut = '{"owner": Jane Secret, "x": 1';
  assert.deepEqual(validateWorkspace(cut, [SYNTHETIC_SCRUB]).errors, ['not valid JSON']);
  // The scrub check runs on the raw text before parsing, and on decoded strings.
  const rawHit = '{"owner": "' + SYNTHETIC_SCRUB + ' Example", "x": ';
  const r1 = validateWorkspace(rawHit, [SYNTHETIC_SCRUB]);
  assert.deepEqual([r1.scrubHit, r1.errors], [true, ['scrub check: pattern #1 appears']]);
  const escaped = JSON.parse(WS); escaped.deals[0].owner = '__NAME__';
  const escapedText = JSON.stringify(escaped).replace('__NAME__', [...SYNTHETIC_SCRUB].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
  assert.ok(!escapedText.toLowerCase().includes(SYNTHETIC_SCRUB));
  const r2 = validateWorkspace(escapedText, [SYNTHETIC_SCRUB]);
  assert.equal(r2.scrubHit, true);
  assert.match(r2.errors[0], /escaped/);
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
  const live = w.s3.get('preview/workspace.json');
  assert.equal(doc.workspace.stamps.forTextSha256, textHash(live), 'stamps are keyed to the live file');
  const view = buildView(JSON.parse(live), doc, textHash(live));
  assert.equal(view.meta.generatedAt, '2026-10-13T16:30:00Z', 'the page shows the newer time');
  assert.equal(buildView(JSON.parse(live), doc, 'another-file').meta.generatedAt, '2026-10-13T16:00:00Z', 'not over another file');
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
  assert.equal(r.workspace.status, 'kept-last-good', 'same patterns as when the live copy was checked: keep it');
  const wrong = JSON.parse(WS); wrong.schemaVersion = 99;
  w.publish(JSON.stringify(wrong));
  assert.equal((await w.run()).workspace.problem, PROBLEMS.invalid);
  w.publish('{"not": "json"');
  assert.equal((await w.run()).workspace.problem, PROBLEMS.invalid);
  assert.equal(w.notes.length, 1, 'the same problem does not alarm again');
});

test('Lambda: a 6-hourly snapshot (mode not sync-only) without workspace.json is expected: no alarm, no banner, unless none came for > 60 min', async (t) => {
  const w = world();
  t.after(w.done);
  w.publish(WS);
  assert.equal((await w.run()).workspace.status, 'uploaded');
  const seen = w.refreshDoc().workspace.workspaceSeenAt;
  assert.ok(seen, 'the time a sync-only snapshot last brought a good copy');
  // The full job publishes (LATEST has no mode, as run.py writes it): quiet, last good copy kept.
  w.publish(null, null);
  const full = await w.run(15);
  assert.equal(full.workspace.status, 'kept-last-good');
  assert.equal(full.workspace.problem, null);
  assert.ok(!full.failing.includes(PROBLEMS.missing));
  assert.equal(w.notes.length, 0, 'no alarm');
  const block = w.refreshDoc().workspace;
  assert.equal(block.workspaceSeenAt, seen, 'the last sync-only sighting is kept, not moved');
  assert.match(block.note, /full job, which does not write workspace\.json/);
  assert.equal(page.header(buildView(JSON.parse(WS), w.refreshDoc()), { now: Date.parse('2026-10-13T16:30:00Z') }).includes('Showing the last good data'), false, 'no banner on the page');
  // Explicit non-sync-only modes too.
  w.publish(null, 'full');
  assert.equal((await w.run(15)).workspace.problem, null);
  // Still no sync-only snapshot with workspace.json 60 minutes after the last one: alarm (once).
  const late = await w.run(31);
  assert.equal(late.workspace.problem, PROBLEMS.missing);
  assert.ok(late.failing.includes(PROBLEMS.missing));
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].subject, /snapshot-has-no-workspace-json/);
  assert.ok(w.s3.has('preview/workspace.json'), 'the last good copy stays');
  // The next sync-only snapshot brings it back and clears the problem.
  w.publish(WS);
  const back = await w.run();
  assert.equal(back.workspace.status, 'unchanged');
  assert.equal(back.workspace.problem, null);
  assert.ok(Date.parse(w.refreshDoc().workspace.workspaceSeenAt) > Date.parse(seen));
  // A sync-only snapshot without workspace.json still alarms at once (its job should have written it).
  const n = w.notes.length;
  w.publish(null);
  const bad = await w.run();
  assert.equal(bad.workspace.problem, PROBLEMS.missing);
  assert.equal(w.notes.length, n + 1);
});

test('Lambda: a full snapshot right after deploy (no sync-only copy seen yet) alarms: nothing proves workspace.json is flowing', async (t) => {
  const w = world();
  t.after(w.done);
  w.publish(null, null);
  const r = await w.run();
  assert.equal(r.workspace.problem, PROBLEMS.missing);
  assert.equal(w.notes.length, 1);
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

test('Lambda: a newly matching scrub pattern replaces the live copy with a withheld notice (PutObject only)', async (t) => {
  const w = world({ patterns: ['notpresent'] });
  t.after(w.done);
  const named = JSON.parse(WS); named.deals[0].owner = 'Ozzy Example';
  w.publish(JSON.stringify(named));
  await w.run();
  assert.match(w.s3.get('preview/workspace.json'), /Ozzy Example/, 'clean under the old patterns');
  // A pattern is added: the next snapshot (same data) now matches, and so does the live copy.
  w.cfg.scrubPatterns = ['notpresent', 'ozzy'];
  w.publish(JSON.stringify(named));
  const r = await w.run();
  assert.equal(r.workspace.status, 'withheld');
  assert.equal(r.workspace.problem, PROBLEMS.withheld);
  const live = w.s3.get('preview/workspace.json');
  assert.ok(!/ozzy/i.test(live), 'the name is gone from the live object');
  assert.equal(JSON.parse(live).withheld, true);
  assert.ok(!JSON.stringify(w.refreshDoc()).toLowerCase().includes('ozzy'), 'refresh.json never names it');
  assert.equal(w.notes.length, 1);
  assert.ok(!w.notes[0].message.toLowerCase().includes('ozzy'));
  const puts = w.wsPuts();
  w.publish(JSON.stringify(named));
  assert.equal((await w.run()).workspace.status, 'withheld', 'stays withheld while the snapshot still matches');
  assert.equal(w.wsPuts(), puts, 'no re-upload');
  // A clean snapshot brings the data back.
  w.publish(WS);
  const back = await w.run();
  assert.equal(back.workspace.status, 'uploaded');
  assert.equal(JSON.parse(w.s3.get('preview/workspace.json')).withheld, undefined);
  assert.match(page.withheldView(JSON.parse(withheldDoc())), /withheld[\s\S]*next clean snapshot/);
});

// The build time and every available fresh.<section>.fetchedAt, as a later sync of the same data writes them.
const stampAll = (text, gen, fetched = gen) => {
  const d = JSON.parse(restamp(text, gen));
  for (const sec of Object.values(d.fresh || {})) if (sec && sec.available === true) sec.fetchedAt = fetched;
  return JSON.stringify(d);
};
const at = (hhmm) => `2026-10-13T${hhmm}:00Z`;
const ms = (iso) => new Date(iso).toISOString(); // the function's own times carry milliseconds
const FRESH_SECTIONS = Object.entries(JSON.parse(WS).fresh || {}).filter(([, x]) => x && x.available === true).map(([k]) => k);

test('Lambda: unchanged content is copied again once the live copy is older than WORKSPACE_MAX_AGE_MIN and the snapshot is newer', async (t) => {
  const w = world();
  t.after(w.done);
  w.cfg.workspaceMaxAgeMinutes = 25;
  assert.ok(FRESH_SECTIONS.length >= 2, 'the synthetic workspace.json has fresh sections');
  w.publish(stampAll(WS, at('16:00'), at('15:58')));
  const r1 = await w.run(); // 16:15
  assert.deepEqual([r1.workspace.status, r1.workspace.reason], ['uploaded', 'content']);
  let doc = w.refreshDoc();
  assert.equal(doc.workspace.writtenAt, ms(at('16:15')));
  assert.deepEqual(doc.workspace.freshAt, Object.fromEntries(FRESH_SECTIONS.map((k) => [k, at('15:58')])));
  // Same content, newer times; the live copy (built 16:00) is 30 min old at 16:30: copied, reason refresh-age.
  const newer = stampAll(WS, at('16:20'), at('16:18'));
  w.publish(newer);
  const r2 = await w.run(); // 16:30
  assert.deepEqual([r2.workspace.status, r2.workspace.reason, r2.workspace.uploaded], ['uploaded', 'refresh-age', true]);
  assert.equal(w.wsPuts(), 2);
  assert.equal(w.s3.get('preview/workspace.json'), newer, 'the page bucket has the newer file');
  assert.equal(JSON.parse(w.s3.get('preview/workspace.json')).fresh[FRESH_SECTIONS[0]].fetchedAt, at('16:18'), 'fresh.*.fetchedAt moves');
  doc = w.refreshDoc();
  assert.deepEqual([doc.workspace.status, doc.workspace.reason, doc.workspace.publishedGeneratedAt, doc.workspace.writtenAt], ['uploaded', 'refresh-age', at('16:20'), ms(at('16:30'))]);
  assert.equal(doc.workspace.stamps.forTextSha256, textHash(newer));
  assert.equal(doc.workspace.sha256, doc.workspace.publishedSha256, 'same content hash as before');
  // Newer again, but the live copy (16:20) is exactly 25 min old at 16:45: not older than the limit, kept.
  w.publish(stampAll(WS, at('16:35'), at('16:33')));
  const r3 = await w.run(); // 16:45
  assert.deepEqual([r3.workspace.status, r3.workspace.uploaded], ['unchanged', false]);
  assert.equal(w.refreshDoc().workspace.writtenAt, ms(at('16:30')));
  assert.equal(w.refreshDoc().workspace.freshAt[FRESH_SECTIONS[0]], at('16:18'), 'the live copy’s times, not the snapshot’s');
  // 17:00: 40 min old and the snapshot is newer: copied.
  const r4 = await w.run();
  assert.deepEqual([r4.workspace.status, r4.workspace.reason], ['uploaded', 'refresh-age']);
  assert.equal(w.wsPuts(), 3);
  // The same file as the live copy is never copied again, however old.
  const r5 = await w.run(45); // 17:45
  assert.deepEqual([r5.workspace.status, r5.workspace.uploaded], ['unchanged', false]);
  // A snapshot older than the live copy (an out-of-order pointer) is not copied either.
  w.publish(stampAll(WS, at('15:00')));
  assert.equal((await w.run()).workspace.status, 'unchanged');
  assert.equal(w.wsPuts(), 3);
  // A content change still uploads at once, whatever the age.
  const changed = JSON.parse(stampAll(WS, at('18:10'))); changed.headline.open.count += 1;
  w.publish(JSON.stringify(changed));
  const r6 = await w.run(); // 18:15
  assert.deepEqual([r6.workspace.status, r6.workspace.reason], ['uploaded', 'content']);
  assert.equal(w.notes.length, 0, 'no alarm');
  // The page: an uploaded copy is shown as current (no last-good banner).
  const live = w.s3.get('preview/workspace.json');
  const v = buildView(JSON.parse(live), w.refreshDoc(), textHash(live));
  assert.deepEqual([v.live.status, v.live.problem], ['uploaded', null]);
  assert.ok(!page.header(v, { now: Date.parse(at('18:16')) }).includes('Showing the last good data'));
});

test('Lambda: workspace-stale and fresh-stale in refresh.json failing: not while the sync keeps publishing; alarmed (with a daily reminder) once the live copy stops moving', async (t) => {
  const w = world();
  t.after(w.done);
  // fresh at 90 (not the default 75) so the two limits fall on different 15-minute runs here.
  Object.assign(w.cfg, { workspaceMaxAgeMinutes: 25, workspaceStaleMinutes: 60, freshStaleMinutes: 90 });
  // A quiet period at the normal cadence: the sync republishes unchanged content every 30 min
  // (fetched 3 min before), and the function runs every 15. Nothing is flagged.
  let clock = Date.parse(at('16:00')); // after each run: that run's time
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  for (let i = 0; i < 12; i++) {
    if (i % 2 === 0) w.publish(stampAll(WS, iso(clock + 12 * 60e3), iso(clock + 10 * 60e3)));
    const r = await w.run(); clock += 15 * 60e3;
    assert.deepEqual(r.failing, [], `run ${i}`);
  }
  assert.equal(w.notes.length, 0);
  let doc = w.refreshDoc();
  assert.deepEqual(doc.failing, []);
  assert.ok(Number.isFinite(doc.workspace.writtenAgeMinutes) && doc.workspace.writtenAgeMinutes <= 30, JSON.stringify(doc.workspace));
  assert.deepEqual(Object.keys(doc.workspace.freshAges).sort(), [...FRESH_SECTIONS].sort());
  const lastWritten = Date.parse(doc.workspace.writtenAt);
  const lastFetched = Date.parse(doc.workspace.freshAt[FRESH_SECTIONS[0]]);
  // The sync stops publishing. The live copy ages; past 60 min since it was written: workspace-stale.
  let r;
  do { r = await w.run(); clock += 15 * 60e3; } while (!r.failing.length);
  const firstFlag = clock;
  assert.deepEqual(r.failing, ['workspace-stale']);
  assert.ok(firstFlag - lastWritten > 60 * 60e3 && firstFlag - lastWritten <= 75 * 60e3);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].subject, /GTM preview refresh: workspace-stale/);
  assert.match(w.notes[0].message, /workspace\.json on the page: last written .* min ago\); fresh section ages \(min\):/);
  doc = w.refreshDoc();
  assert.deepEqual(doc.failing, ['workspace-stale']);
  assert.ok(doc.workspace.writtenAgeMinutes > 60);
  // The page shows nothing new: these are not workspace.problem.
  assert.deepEqual([doc.workspace.status, doc.workspace.problem], ['unchanged', null]);
  assert.ok(!page.header(buildView(JSON.parse(w.s3.get('preview/workspace.json')), doc), { now: firstFlag }).includes('Showing the last good data'));
  // Past 90 min since the fetch: fresh-stale too (a change of the set: one more alarm).
  do { r = await w.run(); clock += 15 * 60e3; } while (r.failing.length < 2);
  assert.deepEqual(r.failing, ['workspace-stale', 'fresh-stale']);
  assert.ok(clock - lastFetched > 90 * 60e3);
  assert.ok(Object.values(w.refreshDoc().workspace.freshAges).every((a) => a > 90));
  assert.equal(w.notes.length, 2);
  // Unlike the workspace.json problems these are not quiet: the daily reminder fires.
  await w.run(15); clock += 15 * 60e3;
  assert.equal(w.notes.length, 2);
  r = await w.run(60 * 24); clock += 60 * 24 * 60e3;
  assert.equal(w.notes.length, 3);
  assert.match(w.notes[2].message, /^reminder\./);
  // The sync publishes again: the newer copy goes up (refresh-age) and both clear.
  w.publish(stampAll(WS, iso(clock + 11 * 60e3), iso(clock + 9 * 60e3)));
  r = await w.run(); clock += 15 * 60e3;
  assert.deepEqual([r.workspace.status, r.workspace.reason, r.failing], ['uploaded', 'refresh-age', []]);
  assert.equal(w.notes.length, 4);
  assert.match(w.notes[3].subject, /problems cleared/);
});

test('Lambda: fresh-stale alone when a section stopped syncing; unavailable sections are ignored; times recorded before this change fill in', async (t) => {
  const w = world();
  t.after(w.done);
  Object.assign(w.cfg, { workspaceMaxAgeMinutes: 25, workspaceStaleMinutes: 60, freshStaleMinutes: 75 });
  // Built now, but one section's source last synced 2 hours ago.
  const d = JSON.parse(stampAll(WS, at('16:10'), at('16:08')));
  const [stuck, other] = FRESH_SECTIONS;
  d.fresh[stuck].fetchedAt = at('14:10');
  w.publish(JSON.stringify(d));
  const r = await w.run(); // 16:15
  assert.equal(r.workspace.status, 'uploaded');
  assert.deepEqual(r.failing, ['fresh-stale']);
  assert.equal(r.workspace.freshAges[stuck], 125);
  assert.equal(r.workspace.freshAges[other], 7);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].subject, /fresh-stale/);
  // The same section unavailable (its source not synced): it has no time, so it is not judged.
  delete d.fresh[stuck].fetchedAt; d.fresh[stuck] = { available: false, reason: 'not synced' };
  d.meta.generatedAt = at('16:20');
  w.publish(JSON.stringify(d));
  const r2 = await w.run(); // 16:30: refresh-age upload
  assert.deepEqual([r2.workspace.status, r2.failing], ['uploaded', []]);
  assert.ok(!(stuck in w.refreshDoc().workspace.freshAt));
  // refresh.json from before this change (no writtenAt, no freshAt): the build time stands in for
  // the write time, and the fresh times are read from the snapshot when it is the live file.
  const old = w.refreshDoc();
  delete old.workspace.writtenAt; delete old.workspace.freshAt; delete old.workspace.freshAges; delete old.workspace.writtenAgeMinutes;
  w.s3.set('preview/refresh.json', JSON.stringify(old));
  const r3 = await w.run(); // 16:45, same file as live
  assert.equal(r3.workspace.status, 'unchanged');
  const doc = w.refreshDoc();
  assert.equal(doc.workspace.writtenAt, null);
  assert.equal(doc.workspace.writtenAgeMinutes, 25, 'from publishedGeneratedAt 16:20');
  assert.equal(doc.workspace.freshAt[other], at('16:08'));
  assert.deepEqual(r3.failing, []);
});

test('staleness: defaults, the worst normal case (the 6-hourly skip window) does not flag, unknown times never flag', () => {
  assert.deepEqual([MAX_AGE_MINUTES, WORKSPACE_STALE_MINUTES, FRESH_STALE_MINUTES], [25, 60, 75]);
  const now = at('19:00');
  const min = (m) => new Date(Date.parse(now) - m * 60e3).toISOString();
  // Around the skip window the live copy can be ~45-60 min old and its fetch times ~12 min older.
  assert.deepEqual(staleness({ writtenAt: min(60), freshAt: { won: min(72), calls: min(72) } }, now).failing, []);
  assert.deepEqual(staleness({ writtenAt: min(61), freshAt: { won: min(72) } }, now).failing, [STALE.workspace]);
  const s = staleness({ writtenAt: min(10), freshAt: { won: min(76), calls: min(5), submissions: null } }, now);
  assert.deepEqual([s.failing, s.writtenAgeMinutes, s.freshAges], [[STALE.fresh], 10, { won: 76, calls: 5, submissions: null }]);
  assert.deepEqual(staleness({ writtenAt: null, publishedGeneratedAt: min(90), freshAt: null }, now), { failing: [STALE.workspace], writtenAgeMinutes: 90, freshAges: null });
  assert.deepEqual(staleness({}, now), { failing: [], writtenAgeMinutes: null, freshAges: null });
  assert.deepEqual(staleness({ writtenAt: 'garbage', freshAt: { won: 'garbage' } }, now).failing, []);
  assert.deepEqual(staleness({ writtenAt: min(31), freshAt: { won: min(31) } }, now, { workspaceStaleMinutes: 30, freshStaleMinutes: 30 }).failing, [STALE.workspace, STALE.fresh]);
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
  // Stamps apply only to the exact file they were recorded for (sha256 of its text).
  const stamped = { refreshedAt: '2026-10-13T17:00:00Z', workspace: { stamps: { forTextSha256: 'abc', generatedAt: '2026-10-13T16:55:00Z', freshness: [] } } };
  assert.match(page.header(buildView(data, stamped, 'abc'), { now: now + 50 * 60e3 }), /chip-ok" data-updated="2026-10-13T16:55:00Z"/);
  assert.equal(buildView(data, stamped, 'other').meta.generatedAt, '2026-10-13T16:00:00Z');
  assert.equal(buildView(data, stamped, null).meta.generatedAt, '2026-10-13T16:00:00Z');
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

test('page (browser): fetches workspace.json, renders, deep-links, re-checks in place, ages to amber, shows errors', { skip: !hasBrowser && 'Python Playwright not available', timeout: 900000 }, async (t) => {
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
  // One browser session driven step by step over stdin/stdout; every wait is bounded, the child is always killed.
  const script = `
import json, sys
from playwright.sync_api import sync_playwright
url, lead = sys.argv[1], sys.argv[2]
T = 240000
def say(o):
    print(json.dumps(o)); sys.stdout.flush()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.set_default_timeout(T)
    errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(url + '#src=Paid&lead=' + lead); pg.wait_for_selector('#pipeline'); pg.wait_for_selector('.drawer')
    o = {'open': pg.inner_text('[data-fig="open-count"] .tile-v'), 'drawer': pg.inner_text('.drawer h2'),
         'updatedClass': pg.get_attribute('[data-updated]', 'class'), 'hash': pg.evaluate('location.hash')}
    o['lpDefault'] = pg.get_attribute('[data-set="lp=week"]', 'aria-pressed')
    pg.keyboard.press('Escape'); o['closed'] = pg.locator('.drawer').count(); say(o)
    for cmd in sys.stdin:
        cmd = cmd.strip()
        if cmd == 'recheck':
            pg.evaluate('location.hash = "#mo=*&mp=90"'); pg.wait_for_selector('#meetings .ltable')
            pg.evaluate('GtmRecheck()'); pg.wait_for_timeout(500)
            say({'updated': pg.get_attribute('[data-updated]', 'data-updated'), 'updatedClass': pg.get_attribute('[data-updated]', 'class'),
                 'listStill': pg.locator('#meetings .ltable').count(), 'hash': pg.evaluate('location.hash')})
        elif cmd == 'reload':
            pg.goto(url); pg.wait_for_selector('#pipeline')
            say({'updatedClass': pg.get_attribute('[data-updated]', 'class'), 'banner': pg.locator('.chip-alert').all_inner_texts()})
        elif cmd == 'error':
            pg.goto(url); pg.wait_for_selector('.sec.error'); say({'error': pg.inner_text('.sec.error')})
        elif cmd == 'retry':
            pg.click('[data-retry]'); pg.wait_for_selector('#pipeline'); say({'retried': True})
        elif cmd == 'withheld':
            pg.goto(url); pg.wait_for_selector('.sec.withheld'); say({'withheld': pg.inner_text('.sec.withheld')})
        elif cmd == 'sticky':
            pg.goto(url); pg.wait_for_selector('#leads'); pg.click('[data-set="lp=90"]'); pg.wait_for_timeout(200)
            hashAfter = pg.evaluate('location.hash')
            pg.goto(url + '?again'); pg.wait_for_selector('#leads')
            say({'hash': hashAfter, 'pressed': pg.get_attribute('[data-set="lp=90"]', 'aria-pressed'), 'stored': pg.evaluate('localStorage.getItem("gtm-range-lp")'),
                 'mp90': pg.get_attribute('[data-set="mp=90"]', 'aria-pressed'), 'cpWeek': pg.get_attribute('[data-set="cp=week"]', 'aria-pressed')})
        elif cmd == 'done':
            say({'errors': errors}); break
    b.close()
`;
  const dir = mkdtempSync(join(tmpdir(), 'onepage-browser-'));
  writeFileSync(join(dir, 'check.py'), script);
  const child = spawn(PY, [join(dir, 'check.py'), url, leadId], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
  let buf = '';
  let err = '';
  const lines = [];
  const waiters = [];
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (waiters.length) waiters.shift()(l); else lines.push(l); } });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const next = (cmd) => {
    if (cmd) child.stdin.write(cmd + '\n');
    return new Promise((resolve, reject) => {
      if (lines.length) return resolve(JSON.parse(lines.shift()));
      const to = setTimeout(() => reject(new Error(`browser step ${cmd || 'start'} timed out: ${err.slice(-500)}`)), 300000);
      exited.then((code) => { clearTimeout(to); reject(new Error(`browser exited (${code}): ${err.slice(-500)}`)); });
      waiters.push((l) => { clearTimeout(to); resolve(JSON.parse(l)); });
    });
  };
  const a = await next();
  assert.equal(a.open, '4');
  assert.equal(a.drawer, 'Orchid Retail');
  assert.match(a.updatedClass, /chip-ok/);
  assert.match(a.hash, /lead=/);
  assert.equal(a.closed, 0);
  assert.equal(a.lpDefault, 'true', 'This week is the default');
  // Same file, newer times in refresh.json (keyed to this file's sha256): the open tab updates in place.
  const fresh = new Date(Date.now() + 60e3).toISOString();
  files['/refresh.json'] = JSON.stringify({ refreshedAt: fresh, workspace: { status: 'unchanged', stamps: { forTextSha256: textHash(files['/workspace.json']), generatedAt: fresh, freshness: [] } } });
  const r = await next('recheck');
  assert.equal(r.updated, fresh);
  assert.match(r.updatedClass, /chip-ok/);
  assert.equal(r.listStill, 1, 'the open list stays');
  assert.equal(r.hash, '#mo=*&mp=90');
  // Old data and a refresh.json that says the latest snapshot had none: amber + last-good banner.
  files['/workspace.json'] = restamp(WS, '2026-01-01T00:00:00Z');
  files['/refresh.json'] = JSON.stringify({ refreshedAt: new Date().toISOString(), workspace: { status: 'kept-last-good', problem: PROBLEMS.missing } });
  const b = await next('reload');
  assert.match(b.updatedClass, /chip-warn/);
  assert.ok(b.banner.some((x) => /last good data/.test(x)));
  // workspace.json missing: a clear error, then recovery on retry.
  delete files['/workspace.json'];
  const c = await next('error');
  assert.match(c.error, /could not be loaded/);
  assert.match(c.error, /HTTP 404/);
  files['/workspace.json'] = WS;
  assert.equal((await next('retry')).retried, true);
  // A withheld document: a notice, no data.
  files['/workspace.json'] = withheldDoc();
  assert.match((await next('withheld')).withheld, /withheld/);
  // A chosen range is sticky: in the hash, and (without a hash) from localStorage, per section.
  files['/workspace.json'] = WS;
  const st = await next('sticky');
  assert.match(st.hash, /lp=90/);
  assert.deepEqual([st.pressed, st.stored], ['true', '90']);
  assert.equal(st.mp90, 'true', 'the meetings range chosen earlier in this session (mp=90) stuck too');
  assert.equal(st.cpWeek, 'true', 'a section never changed keeps This week');
  assert.deepEqual((await next('done')).errors, []);
});
