// Freshness chips: only user-facing sources (config/freshness-sources.json) get a chip;
// internal sync steps roll up into their parent, which turns amber when one of them fails
// (red when the parent itself failed) and names it in the tooltip. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { renderAppHtml } from '../onepage/build.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildView, freshnessChips } = require('../onepage/view.cjs');
const page = require('../onepage/page.cjs');
const CONFIG = require('../config/freshness-sources.json');
const { brainFixture, SYNTHETIC_SCRUB } = require('../scripts/synthetic-data.cjs');

const T = '2026-10-13T20:03:00Z';
const row = (source, ok = true, extra = {}) => ({ source, label: source, ok, at: T, lastOkAt: ok ? T : '2026-10-12T20:00:00Z', detail: ok ? 'fine' : 'HTTP 500', ...extra });
const INTERNAL = ['hubspot_contact_backfill', 'hubspot_meeting_backfill', 'hubspot_forms', 'hubspot_lists', 'hubspot_imports', 'lemlist_activities', 'lemlist_leads', 'hubspot_extras'];

test('config: every internal row named in the request rolls up into a parent; parents are the user-facing sources', () => {
  const parents = CONFIG.sources.map((s) => s.source);
  assert.deepEqual(parents, ['hubspot', 'sheets', 'fathom', 'ga4', 'lemlist', 'otterly', 'reddit', 'spend']);
  const children = Object.fromEntries(CONFIG.sources.flatMap((s) => Object.keys(s.children || {}).map((c) => [c, s.source])));
  for (const c of INTERNAL) assert.ok(children[c], `${c} has a parent`);
  assert.equal(children.lemlist_leads, 'lemlist');
  assert.equal(children.hubspot_extras, 'hubspot');
});

test('roll-up: all ok -> one ok chip per user-facing source, in config order, no internal rows', () => {
  const rows = ['otterly', 'hubspot', 'sheets', 'fathom', 'ga4', 'lemlist', ...INTERNAL].map((s) => row(s));
  const chips = freshnessChips(rows, CONFIG);
  assert.deepEqual(chips.map((c) => c.source), ['hubspot', 'sheets', 'fathom', 'ga4', 'lemlist', 'otterly']);
  assert.ok(chips.every((c) => c.level === 'ok' && c.failing.length === 0));
  assert.deepEqual(chips.map((c) => c.label), ['HubSpot', 'Sheets', 'Fathom', 'GA4', 'Lemlist', 'Otterly']);
});

test('roll-up: a failing child turns its ok parent amber and is named; a failing parent is red', () => {
  const rows = [row('hubspot'), row('hubspot_forms', false, { detail: 'forms API 502' }), row('lemlist', false), row('lemlist_leads', false), row('sheets')];
  const chips = Object.fromEntries(freshnessChips(rows, CONFIG).map((c) => [c.source, c]));
  assert.equal(chips.hubspot.level, 'warn');
  assert.deepEqual(chips.hubspot.failing.map((k) => [k.source, k.label, k.detail]), [['hubspot_forms', 'forms', 'forms API 502']]);
  assert.equal(chips.lemlist.level, 'alert', 'the parent itself failed');
  assert.deepEqual(chips.lemlist.failing.map((k) => k.label), ['leads']);
  assert.equal(chips.sheets.level, 'ok');
  const html = page.header({ meta: { generatedAt: T }, freshness: Object.values(chips), flags: [], live: null }, { now: Date.parse(T) });
  assert.match(html, /<span class="chip chip-warn" title="HubSpot: last good [^"]*HubSpot forms failed at [^"]*forms API 502[^"]*">HubSpot [^<]*· forms down<\/span>/);
  assert.match(html, /<span class="chip chip-alert" title="Lemlist failed at [^"]*Lemlist leads failed at [^"]*">Lemlist down · last good/);
  assert.doesNotMatch(html, /hubspot_forms|Hubspot Forms|lemlist_leads/, 'no internal row names, no chips of their own');
});

test('roll-up: unlisted rows: "<parent>_…" joins the parent; others hidden while ok, shown red when failing', () => {
  const rows = [row('hubspot'), row('hubspot_new_step', false), row('mystery_job'), row('broken_job', false)];
  const chips = freshnessChips(rows, CONFIG);
  assert.deepEqual(chips.map((c) => [c.source, c.level]), [['hubspot', 'warn'], ['broken_job', 'alert']]);
  assert.equal(chips[0].failing[0].source, 'hubspot_new_step');
  // A parent with no row of its own stands for its children.
  const orphan = freshnessChips([row('lemlist_activities'), row('lemlist_leads', true, { lastOkAt: '2026-10-13T10:00:00Z' })], CONFIG);
  assert.deepEqual(orphan.map((c) => [c.source, c.label, c.level, c.lastOkAt]), [['lemlist', 'Lemlist', 'ok', '2026-10-13T10:00:00Z']]);
});

test('roll-up applies after refresh.json stamps, so an open tab sees a child fail without a new file', () => {
  const data = { meta: { generatedAt: T }, freshness: [row('hubspot'), row('hubspot_lists')], headline: {}, closed: { lost: [] }, insights: null };
  const sha = 'abc';
  const refresh = { workspace: { stamps: { forTextSha256: sha, freshness: [{ source: 'hubspot_lists', ok: false, at: T, lastOkAt: T, detail: 'timeout' }] } } };
  const v = buildView(data, refresh, sha);
  assert.deepEqual(v.freshness.map((c) => [c.source, c.level, c.failing.map((k) => k.label).join()]), [['hubspot', 'warn', 'lists']]);
});

test('end to end (synthetic brain.db): the data step keeps every row, the page shows only user-facing chips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-fresh-'));
  try {
    const fx = brainFixture({});
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fx));
    execFileSync('python3', [join(ROOT, 'scripts', 'fixture-db.py'), join(dir, 'fixture.json'), join(dir, 'brain.db')]);
    const ind = join(dir, 'in');
    mkdirSync(ind);
    writeFileSync(join(ind, 'lead-sources.json'), JSON.stringify(fx.inputs.leadSources));
    writeFileSync(join(ind, 'scrub-patterns.txt'), SYNTHETIC_SCRUB + '\n');
    const env = { ...process.env, WORKSPACE_SCRUB_PATTERNS: '', WORKSPACE_SCRUB_PATTERNS_FILE: '', CALL_CLASSIFICATION: '', LEAD_SOURCE_REVIEW: '', PAID_EXPORT: '' };
    execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', join(dir, 'brain.db'), '--inputs-dir', ind, '--out', join(dir, 'w.json'), '--quiet'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const d = JSON.parse(readFileSync(join(dir, 'w.json'), 'utf8'));
    assert.ok(d.freshness.some((f) => f.source === 'hubspot_forms'), 'workspace.json keeps the internal rows (the Lambda stamps them by source)');
    const v = buildView(d, null);
    assert.deepEqual(v.freshness.map((c) => [c.source, c.level]), [['hubspot', 'ok'], ['sheets', 'ok'], ['fathom', 'ok'], ['ga4', 'ok'], ['lemlist', 'ok'], ['otterly', 'alert']]);
    const html = page.header(v, { now: Date.parse(d.meta.generatedAt) });
    assert.doesNotMatch(html, /backfill|Backfill|Hubspot Forms|Lemlist Leads/, "no chip for an internal row (the data step titles them like these)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the deployed page carries the config (the browser rolls up with the same rules)', () => {
  const app = renderAppHtml();
  assert.match(app, /window\.GtmFreshnessSources = \{/);
  assert.ok(app.indexOf('GtmFreshnessSources') < app.indexOf('function freshnessChips'), 'config before view.cjs');
});
