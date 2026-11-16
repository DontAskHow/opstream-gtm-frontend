// "This week": Monday 00:00 to the end of today in America/Phoenix (UTC-7, no DST), the
// default range in every section that has one, compared with last week's Monday to the
// same weekday. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { renderAppHtml } from '../onepage/build.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = require('../onepage/page.cjs');
const { buildView } = require('../onepage/view.cjs');
const { brainFixture, SYNTHETIC_SCRUB } = require('../scripts/synthetic-data.cjs');

const MON_0000 = '2026-10-12T07:00:00Z'; // Monday Oct 12, 00:00 PT
const SUN_1300 = '2026-10-18T20:00:00Z'; // Sunday Oct 18, 1:00 PM PT

test('week window: Monday 00:00 PT boundary', () => {
  const w = page.weekWindow(MON_0000);
  assert.deepEqual([w.startYmd, w.endYmd, w.label], ['2026-10-12', '2026-10-12', 'Oct 12']);
  const lw = page.weekWindow(MON_0000, 1);
  assert.deepEqual([lw.startYmd, lw.endYmd, lw.label], ['2026-10-05', '2026-10-05', 'Oct 5'], 'last week: Monday to the same weekday');
  assert.equal(page.inPeriod('2026-10-12T06:59:59Z', 'week', MON_0000), false, 'Sunday 23:59:59 PT is last week');
  assert.equal(page.inPeriod('2026-10-12T07:00:00Z', 'week', MON_0000), true, 'Monday 00:00 PT is this week');
  assert.equal(page.inPeriod('2026-10-13T06:59:59Z', 'week', MON_0000), true, 'the rest of today counts');
  assert.equal(page.inPeriod('2026-10-13T07:00:00Z', 'week', MON_0000), false, 'tomorrow does not');
  assert.equal(page.inPeriod('2026-10-12', 'week', MON_0000), true, 'a date on Monday');
  assert.equal(page.inPeriod('2026-10-11', 'week', MON_0000), false, 'a date on Sunday');
  assert.equal(page.inPeriod('2026-10-11T23:00:00-07:00', 'lastweek', MON_0000), false, 'last Sunday is outside the same-weekday window');
  assert.equal(page.inPeriod('2026-10-05T12:00:00-07:00', 'lastweek', MON_0000), true);
});

test('week window: a Sunday belongs to the week that started the Monday before', () => {
  const w = page.weekWindow(SUN_1300);
  assert.deepEqual([w.startYmd, w.endYmd, w.label], ['2026-10-12', '2026-10-18', 'Oct 12–18']);
  assert.equal(page.weekWindow(SUN_1300, 1).label, 'Oct 5–11');
  assert.equal(page.inPeriod('2026-10-19T06:30:00Z', 'week', SUN_1300), true, 'Sunday 23:30 PT');
  assert.equal(page.inPeriod('2026-10-19T07:00:00Z', 'week', SUN_1300), false, 'Monday 00:00 PT starts the next week');
  assert.equal(page.inPeriod('2026-10-11', 'lastweek', SUN_1300), true);
  assert.equal(page.inPeriod('2026-10-11', 'week', SUN_1300), false);
  // Across a month boundary.
  assert.equal(page.weekWindow('2026-10-01T18:00:00Z').label, 'Sep 28 – Oct 1');
});

test('deltas: absolute always, a percentage only when both weeks have at least 5', () => {
  const small = page.weekDelta(3, 1, 'Oct 5–6');
  assert.match(small, /\+2 vs last week \(Oct 5–6: 1\)/);
  assert.doesNotMatch(small, /%<\/span>$|· [+−]\d+%/);
  assert.match(small, /n&lt;5: no %/);
  const big = page.weekDelta(10, 8, 'Oct 5–6');
  assert.match(big, /\+2 vs last week \(Oct 5–6: 8\) · \+25%/);
  assert.doesNotMatch(big, /n&lt;5/);
  assert.match(page.weekDelta(0, 0, 'x'), /±0 vs last week/);
  assert.match(page.weekDelta(4, 9, 'x'), /−5 vs last week/);
});

// The synthetic workspace (as of Tuesday Oct 13, 9:00 AM PT).
function syntheticView() {
  const dir = mkdtempSync(join(tmpdir(), 'onepage-week-'));
  try {
    const fx = brainFixture({});
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fx));
    execFileSync('python3', [join(ROOT, 'scripts', 'fixture-db.py'), join(dir, 'fixture.json'), join(dir, 'brain.db')]);
    mkdirSync(join(dir, 'in'));
    writeFileSync(join(dir, 'in', 'lead-sources.json'), JSON.stringify(fx.inputs.leadSources));
    writeFileSync(join(dir, 'in', 'records.jsonl'), fx.text['records.jsonl']);
    execFileSync('python3', [join(ROOT, 'scripts', 'workspace-data.py'), '--db', join(dir, 'brain.db'), '--inputs-dir', join(dir, 'in'),
      '--as-of', fx.expect.asOf, '--out', join(dir, 'w.json'), '--quiet'],
    { env: { ...process.env, WORKSPACE_SCRUB_PATTERNS: SYNTHETIC_SCRUB, CALL_CLASSIFICATION: '', LEAD_SOURCE_REVIEW: '', PAID_EXPORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(readFileSync(join(dir, 'w.json'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const DATA = syntheticView();
const view = (mutate) => { const d = structuredClone(DATA); if (mutate) mutate(d); return buildView(d, null); };
const section = (html, id) => { const i = html.indexOf(`<section class="sec" id="${id}"`); return html.slice(i, html.indexOf('</section>', i)); };

test('"This week" is the default range in every section, labelled with its dates', () => {
  const main = page.renderPage(view(), {}).main;
  for (const [id, key] of [['leads', 'lp'], ['meetings', 'mp'], ['calls', 'cp']]) {
    const sec = section(main, id);
    assert.match(sec, new RegExp(`data-set="${key}=week" aria-pressed="true">This week · Oct 12–13<`), id);
  }
  assert.deepEqual(page.RANGES.lp.map(([k]) => k), ['week', 'month', '90', 'ytd', 'all']);
  assert.equal(page.DEFAULT_RANGE, 'week');
});

test('an empty week says so, with last week for context; other ranges are unchanged', () => {
  const main = page.renderPage(view(), {}).main;
  assert.match(section(main, 'leads'), /data-empty="leads">No leads yet this week \(Oct 12–13\)\. Last week \(Oct 5–6\): 0\./);
  assert.match(section(main, 'meetings'), /data-empty="meetings">No meetings this week \(Oct 12–13\)\./);
  assert.match(section(main, 'calls'), /data-empty="calls">No prospect calls yet this week \(Oct 12–13\)\./);
  // The fixed tiles keep their own definitions.
  assert.match(section(main, 'meetings'), /data-fig="meetings-month"><div class="tile-l">This month<\/div><div class="tile-v num">4</);
  const all = page.renderPage(view(), { lp: 'all', mp: 'month', cp: '90' }).main;
  assert.match(section(all, 'leads'), /data-fig="leads"><div class="tile-l">Leads<\/div><div class="tile-v num">10</);
  assert.doesNotMatch(all, /data-empty=/);
});

test('a week with data: counts, last-week column and deltas, small numbers without %', () => {
  const v = view((d) => {
    d.leads.items[0].leadDate = '2026-10-12';
    d.leads.items[1].leadDate = '2026-10-13';
    d.leads.items[2].leadDate = '2026-10-06';
    d.leads.items[2].mql = false;
    d.meetings.items.push({ ...d.meetings.items.find((m) => m.matched), id: 'wk1', start: '2026-10-12T17:00:00Z' });
    d.meetings.items.push({ ...d.meetings.items.find((m) => m.matched), id: 'wk0', start: '2026-10-05T17:00:00Z' });
    d.calls.items.push({ ...d.calls.items[0], id: 'Rwk', start: '2026-10-13T15:00:00Z' });
  });
  const main = page.renderPage(v, {}).main;
  const leads = section(main, 'leads');
  assert.match(leads, /data-fig="leads"><div class="tile-l">Leads<\/div><div class="tile-v num">2<\/div><div class="tile-s"><span class="delta">\+1 vs last week \(Oct 5–6: 1\)<\/span> <span class="muted">\(n&lt;5: no %\)/);
  assert.match(leads, /Last week \(Oct 5–6\)/);
  assert.doesNotMatch(leads, /data-empty/);
  const mtg = section(main, 'meetings');
  assert.match(mtg, /data-fig="meetings-week"><div class="tile-l">This week · Oct 12–13<\/div><div class="tile-v num">1<\/div><div class="tile-s">matched · <span class="delta">−1 vs last week \(Oct 5–6: 2\)/, 'the fixture already has a matched meeting on Monday Oct 5');
  assert.match(mtg, /All owners/);
  const calls = section(main, 'calls');
  assert.match(calls, /data-fig="calls"><div class="tile-l">Prospect calls · Oct 12–13<\/div><div class="tile-v num">1<\/div><div class="tile-s"><span class="delta">±0 vs last week \(Oct 5–6: 1\)/, 'the fixture has a prospect call on Monday Oct 5');
});

test('a range in the hash wins; an unknown one falls back to This week', () => {
  const main = page.renderPage(view(), { lp: '90', mp: 'nonsense' }).main;
  assert.match(section(main, 'leads'), /data-set="lp=90" aria-pressed="true"/);
  assert.match(section(main, 'meetings'), /data-set="mp=week" aria-pressed="true"/);
});

test('the clock, not the data, decides "now": meta.clock (set by the open tab) moves every range', () => {
  // Data as of Tuesday Oct 13; the tab's clock says Monday Oct 19, 00:00:30 PT.
  const v = view((d) => {
    d.meetings.items.push({ ...d.meetings.items.find((m) => m.matched), id: 'mon19', start: '2026-10-19T07:00:10Z' });
    d.meta.clock = '2026-10-19T07:00:30Z';
  });
  const main = page.renderPage(v, {}).main;
  for (const key of ['lp', 'mp', 'cp']) assert.match(main, new RegExp(`data-set="${key}=week" aria-pressed="true">This week · Oct 19<`), key);
  assert.match(section(main, 'meetings'), /data-fig="meetings-week"><div class="tile-l">This week · Oct 19<\/div><div class="tile-v num">1<\/div><div class="tile-s">matched · <span class="delta">[^<]*\(Oct 12: /);
  assert.match(section(main, 'leads'), /No leads yet this week \(Oct 19\)\. Last week \(Oct 12\)/);
  // Without a clock the data's as-of time is "now" (Node renders, audits).
  assert.match(page.renderPage(view(), {}).main, /This week · Oct 12–13</);
});

// ---------- a real browser with a fake clock crossing Monday 00:00 PT ----------
const PY = process.env.PLAYWRIGHT_PYTHON || '/workspace/.venv-pw/bin/python';
const hasBrowser = existsSync(PY) && (() => { try { execFileSync(PY, ['-c', 'import playwright'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('browser: an open tab passing Monday 00:00 PT recomputes This week from its clock and keeps the drill-down', { skip: !hasBrowser && 'Python Playwright not available', timeout: 600000 }, async (t) => {
  // Data published Sunday Oct 18, 11:50 PM PT, with a matched meeting on Monday Oct 19, 1:00 AM PT.
  const d = structuredClone(DATA);
  delete d.meta.asOf;
  d.meta.generatedAt = '2026-10-19T06:50:00Z';
  const base = d.meetings.items.find((m) => m.matched);
  d.meetings.items.push({ ...base, id: 'mon19', start: '2026-10-19T08:00:00Z' });
  const files = { '/index.html': renderAppHtml(), '/workspace.json': JSON.stringify(d) };
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
  const script = `
import json, sys
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright
url, mtg = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.set_default_timeout(120000)
    errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
    # Sunday Oct 18, 11:58 PM PT (UTC-7).
    pg.clock.install(time=datetime(2026, 10, 19, 6, 58, tzinfo=timezone.utc))
    pg.goto(url + '#mo=*&mtg=' + mtg); pg.wait_for_selector('#meetings'); pg.wait_for_selector('.drawer')
    snap = lambda: {'mp': pg.inner_text('[data-set="mp=week"]'), 'lp': pg.inner_text('[data-set="lp=week"]'), 'cp': pg.inner_text('[data-set="cp=week"]'),
        'week': pg.inner_text('[data-fig="meetings-week"] .tile-v'), 'weekSub': pg.inner_text('[data-fig="meetings-week"] .tile-s'),
        'drawer': pg.inner_text('.drawer h2'), 'hash': pg.evaluate('location.hash'), 'now': pg.evaluate('new Date().toISOString()')}
    before = snap()
    pg.clock.run_for(3 * 60 * 1000)  # to 00:01 PT Monday: the one-minute day check fires
    pg.wait_for_function('(sel) => document.querySelector(sel).textContent.includes("Oct 19")', arg='[data-set="mp=week"]', timeout=60000)
    after = snap()
    print(json.dumps({'before': before, 'after': after, 'errors': errors}))
    b.close()
`;
  const dir = mkdtempSync(join(tmpdir(), 'onepage-clock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'clock.py'), script);
  const out = await new Promise((resolve, reject) => execFile(PY, [join(dir, 'clock.py'), url, base.id], { timeout: 300000 }, (e, so, se) => (e ? reject(new Error(`${e.message}\n${se.slice(-800)}`)) : resolve(so))));
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r.errors, []);
  assert.equal(r.before.mp, 'This week · Oct 12–18');
  assert.equal(r.before.week, String(view().meetings.items.filter((m) => m.matched && page.inPeriod(m.start, 'week', '2026-10-19T06:58:00Z')).length), 'Sunday: the week of Oct 12');
  assert.equal(r.after.mp, 'This week · Oct 19');
  assert.equal(r.after.lp, 'This week · Oct 19');
  assert.equal(r.after.cp, 'This week · Oct 19');
  assert.equal(r.after.week, '1', 'the Monday 1:00 AM meeting is this week now');
  assert.match(r.after.weekSub, /vs last week \(Oct 12: /);
  assert.equal(r.after.drawer, r.before.drawer, 'the open drawer stays');
  assert.equal(r.after.hash, r.before.hash, 'the hash (drill-down state) is unchanged');
  assert.ok(r.after.now >= '2026-10-19T07:00:00Z');
});
