// The scheduled preview refresh (workspace/refresh): change detection on the
// published snapshot, the "as of" labels, alarms, and (behind LIVE_PULL) the
// live pulls and the read-only HubSpot guard. Synthetic data and fake AWS/HTTP
// only: no network, no real snapshot.
import test from 'node:test';

process.env.HUBSPOT_PORTAL_ID = '90000001'; // synthetic portal for the LIVE_PULL tests
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refresh } from '../workspace/refresh/handler.mjs';
import { compose, stamp, NOW_TOKEN, alarmDecision, problems, isHubspotExport, hubspotLive } from '../workspace/refresh/compose.mjs';
import {
  assertHubspotRead, fetchHubspot, outboundFromCampaigns, recordingFromFathom, matchRecording, tokenFromSecret, validateHubspotDoc,
} from '../workspace/refresh/sources.mjs';

const GEN = '2026-01-15T18:00:00+00:00';
const RUN = 'run-test-1';
const PREFIX = `published/${RUN}/`;

function snapshotFiles() {
  return {
    'records.json': {
      generatedAt: GEN, owners: { 1: 'Avery Example' },
      companies: [
        { id: 'c1', name: 'Example Corp', domain: 'example.com', industry: 'COMPUTER_SOFTWARE', deals: [{ id: '101', name: 'Example Corp - New', stage: 's1', amount: 1000 }],
          recordings: [{ id: 'recording-1', nativeId: '1', title: 'Kickoff', date: GEN, summary: [], actions: [], hasTranscript: true }] },
        { id: 'c2', name: 'Sample Holdings', domain: 'sample.org', deals: [] },
      ],
    },
    'marketing.json': {
      generatedAt: GEN,
      outbound: { fetchedAt: GEN, campaignStats: [{ campaignId: 'cam0', name: 'Old', status: 'running', sent: 1 }] },
      sources: [{ source: 'sheets', label: 'Google Sheets', ok: false, at: GEN, lastOkAt: GEN }, { source: 'hubspot', label: 'HubSpot', ok: true, at: GEN, lastOkAt: GEN }],
    },
    'sheet-review.json': { generatedAt: GEN, deals: [{ id: '101', name: 'Example Corp - New', stage: 'Wider stakeholders', amount: 1500 }, { id: '102', name: 'Gone Deal', stage: 'Wider stakeholders', amount: 50 }] },
    'agent-brief.json': { generatedAt: GEN, whatsNew: ['w'], topActions: [], watchOuts: [] },
    'prep-file.json': { generatedAt: GEN, prep: [], brief: { meetings: { items: [] } } },
  };
}

const PIPELINES = { results: [{ id: 'default', label: 'Sales Pipeline', stages: [
  { id: 's1', label: 'Discovery', metadata: { isClosed: 'false', probability: '0.2' } },
  { id: 's9', label: 'Closed lost', metadata: { isClosed: 'true', probability: '0.0' } },
] }, { id: 'p2', label: 'Renewals', stages: [{ id: 'r1', label: 'Renewal due', metadata: { isClosed: 'false', probability: '0.5' } }] }] };

function hubspotDeals(amount101 = '1000') {
  return [
    { id: '101', properties: { dealname: 'Example Corp - New', dealstage: 's1', pipeline: 'default', amount: amount101, hs_deal_stage_probability: '0.2', hs_lastmodifieddate: String(Math.random()) } },
    { id: '102', properties: { dealname: 'Gone Deal', dealstage: 's9', pipeline: 'default', amount: '50', hs_is_closed: 'true' } },
    { id: '103', properties: { dealname: 'HubSpot only', dealstage: 's1', pipeline: 'default', amount: '700', hs_deal_stage_probability: '0.2' } },
    { id: '201', properties: { dealname: 'Renewal', dealstage: 'r1', pipeline: 'p2', amount: '300', hs_deal_stage_probability: '0.5' } },
  ];
}

// The snapshot's HubSpot export (the live_deals.json shape), as the sync job publishes it.
function hubspotExport(deals = hubspotDeals()) {
  const pipes = {}; const stages = {};
  for (const p of PIPELINES.results) {
    pipes[p.id] = p.label;
    for (const st of p.stages) stages[st.id] = { pipe: p.label, label: st.label, closed: st.metadata.isClosed === 'true', prob: st.metadata.probability };
  }
  return { fetchedAt: '2026-01-16T19:50:00Z', pipes, stages, deals: deals.map((d) => ({ id: d.id, properties: Object.fromEntries(Object.entries(d.properties).filter(([k]) => k !== 'hs_lastmodifieddate')) })) };
}

const HUBSPOT_SECRET = JSON.stringify({
  portal_id: '90000001', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rt-1',
  token_endpoint: 'https://api.hubapi.com/oauth/v1/token', api_base: 'https://api.hubapi.com',
});

// A fake world: S3 objects, secrets, and HTTP answers by host/path.
function world({ livePull = false, withExport = true } = {}) {
  const s3 = new Map();
  // Publishes a snapshot run the way the sync job does: files, then LATEST.json.
  const publish = (runId, files, publishedAt) => {
    const prefix = `published/${runId}/`;
    for (const [k, v] of Object.entries(files)) s3.set(`data/${prefix}${k}`, JSON.stringify(v));
    s3.set(`data/${prefix}transcripts/recording-1.json`, '[]');
    s3.set(`data/${prefix}transcripts/recording-999.json`, '[]');
    s3.set('data/published/LATEST.json', JSON.stringify({ runId, prefix, publishedAt }));
  };
  const files = snapshotFiles();
  if (withExport) files['hubspot-deals.json'] = hubspotExport();
  publish(RUN, files, '2026-01-16T20:00:00Z');
  const w = {
    publish, files,
    s3, puts: [], notes: [], calls: [], tmp: mkdtempSync(join(tmpdir(), 'gtm-refresh-test-')),
    deals: hubspotDeals(), fail: {}, rotate: false, pages: 2,
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  w.deps = {
    async getText(bucket, key) { return s3.get(`${bucket === 'B-data' ? 'data' : 'preview'}/${key}`) ?? null; },
    async put(bucket, key, body, opts) { w.puts.push({ key, opts, body }); s3.set(`preview/${key}`, body); },
    async list(bucket, prefix) {
      return [...s3.keys()].filter((k) => k.startsWith('data/' + prefix)).map((k) => ({ key: k.slice(5), size: s3.get(k).length }));
    },
    async secret(id) { if (w.fail.secret === id) throw new Error('AccessDenied'); return id.endsWith('hubspot-oauth') ? HUBSPOT_SECRET : 'key-' + id; },
    async notify(subject, message) { w.notes.push({ subject, message }); },
    async fetch(url, init = {}) {
      const u = new URL(url);
      w.calls.push(`${init.method || 'GET'} ${u.hostname}${u.pathname}`);
      if (u.hostname === 'api.hubapi.com') {
        if (w.fail.hubspot) return json(500, {});
        if (u.pathname === '/oauth/v1/token') return json(200, { access_token: 'at', expires_in: 1800, refresh_token: w.rotate ? 'rt-2' : 'rt-1', hub_id: 90000001 });
        if (u.pathname === '/crm/v3/pipelines/deals') return json(200, PIPELINES);
        if (u.pathname === '/crm/v3/objects/deals') {
          const per = Math.ceil(w.deals.length / w.pages);
          const start = Number(u.searchParams.get('after') || 0);
          const next = start + per < w.deals.length ? { next: { after: String(start + per) } } : undefined;
          return json(200, { results: w.deals.slice(start, start + per), paging: next });
        }
      }
      if (u.hostname === 'api.lemlist.com') {
        if (w.fail.lemlist) return json(503, {});
        if (u.pathname === '/api/campaigns') return json(200, [{ _id: 'cam2', name: 'B', status: 'paused' }, { _id: 'cam1', name: 'A', status: 'running' }]);
        return json(200, { messagesSent: u.pathname.includes('cam1') ? 20 : 5, delivered: 4, opened: 0, replied: 1 });
      }
      if (u.hostname === 'api.fathom.ai') {
        if (w.fail.fathom) return json(401, {});
        return json(200, { items: [
          { recording_id: 1, title: 'Kickoff', recording_start_time: GEN },
          { recording_id: 2, title: 'Call', recording_start_time: '2026-01-16T17:00:00Z', recording_end_time: '2026-01-16T17:30:00Z',
            calendar_invitees: [{ name: 'Pat', email: 'pat@sample.org', email_domain: 'sample.org', is_external: true }],
            default_summary: { markdown_formatted: '## Notes\n- point one' }, action_items: [{ description: 'Send **pricing**' }, { description: 'internal only: fix' }] },
        ], next_cursor: null });
      }
      throw new Error('unexpected host ' + u.hostname);
    },
  };
  w.cfg = {
    dataBucket: 'B-data', latestKey: 'published/LATEST.json', previewBucket: 'B-preview', dataKey: 'data.js', refreshKey: 'refresh.json',
    hubspotCacheKey: '_state/hubspot-live.json', secrets: { hubspot: 'opstream-gtm/hubspot-oauth', lemlist: 'opstream-gtm/lemlist-token', fathom: 'opstream-gtm/fathom-token' },
    maxSnapshotFileBytes: 5e6, tmp: w.tmp, livePull, staleMinutes: 1e6,
  };
  if (!livePull) { delete w.deps.secret; delete w.deps.fetch; }
  let t = Date.parse('2026-01-16T20:00:00Z');
  w.run = () => { t += 15 * 60e3; return refresh(w.deps, { cfg: w.cfg, now: () => new Date(t), log: () => {} }); };
  w.keys = () => w.puts.map((p) => p.key);
  w.data = () => {
    const text = w.s3.get('preview/data.js');
    return JSON.parse(text.replace(/^window\.GTM_DATA=/, '').replace(/;\n$/, ''));
  };
  return w;
}

test('first run uploads data.js; an identical second run writes only refresh.json', async (t) => {
  const w = world();
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  const a = await w.run();
  assert.equal(a.changed, true);
  assert.equal(a.livePull, false);
  assert.deepEqual(w.keys().sort(), ['_state/hubspot-live.json', 'data.js', 'refresh.json']);
  const put = w.puts.find((p) => p.key === 'data.js');
  assert.equal(put.opts.metadata.sha256, a.sha256);
  assert.equal(put.opts.cacheControl, 'no-store');
  assert.ok(!put.body.includes(NOW_TOKEN) && !put.body.includes('@@GTM_V'), 'placeholders are stamped before upload');
  const d = w.data();
  assert.equal(d.refreshedAt, d.dataChangedAt);
  assert.equal(d.refresh.hubspot, 'snapshot');

  w.puts.length = 0;
  const b = await w.run();
  assert.equal(b.changed, false);
  assert.equal(b.sha256, a.sha256);
  assert.deepEqual(w.keys(), ['refresh.json'], 'no data.js upload when nothing changed');
  const doc = JSON.parse(w.s3.get('preview/refresh.json'));
  assert.equal(doc.dataSha256, a.sha256);
  assert.notEqual(doc.refreshedAt, doc.dataChangedAt, 'refreshedAt moves on every check; dataChangedAt only on a change');
  assert.equal(doc.dataChangedAt, d.dataChangedAt);
  assert.equal(doc.snapshotRunId, RUN);
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) < 2000);
  assert.equal(doc.stamps['times.recon'], '2026-01-16T19:50:00Z');
  assert.equal(doc.stamps['refresh.snapshot.runId'], RUN);
  assert.equal(doc.stamps['refresh.sheetAsOf'], GEN);
});

test('no provider calls and no secrets without LIVE_PULL', async (t) => {
  const w = world();
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  assert.equal(w.deps.secret, undefined);
  assert.equal(w.deps.fetch, undefined);
  await w.run();
  assert.deepEqual(w.calls, []);
});

test('a new snapshot with different HubSpot data uploads; a new snapshot with the same content does not', async (t) => {
  const w = world();
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  await w.run();
  w.puts.length = 0;
  w.publish('run-test-2', w.files, '2026-01-16T20:30:00Z');
  const same = await w.run();
  assert.equal(same.changed, false, 'only the run id moved');
  assert.deepEqual(w.keys(), ['refresh.json']);
  // Re-synced with identical content but new fetch times: still no upload; refresh.json carries the new times.
  const resynced = JSON.parse(JSON.stringify(w.files));
  resynced['hubspot-deals.json'].fetchedAt = '2026-01-16T20:40:00Z';
  resynced['records.json'].generatedAt = '2026-01-15T18:30:00+00:00';
  resynced['sheet-review.json'].generatedAt = '2026-01-16T20:40:00Z';
  resynced['marketing.json'].sources[0].at = '2026-01-16T20:40:00Z';
  w.publish('run-test-2b', resynced, '2026-01-16T20:40:00Z');
  const re = await w.run();
  assert.equal(re.changed, false, 'new fetch times alone are not a change');
  const doc = JSON.parse(w.s3.get('preview/refresh.json'));
  assert.equal(doc.stamps['times.recon'], '2026-01-16T20:40:00Z');
  assert.equal(doc.stamps['refresh.snapshot.runId'], 'run-test-2b');
  assert.equal(doc.stamps['sources.sheets.at'], '2026-01-16T20:40:00Z');
  w.puts.length = 0;

  const deals = hubspotDeals('2000');
  w.publish('run-test-3', { ...w.files, 'hubspot-deals.json': hubspotExport(deals) }, '2026-01-16T20:45:00Z');
  const c = await w.run();
  assert.equal(c.changed, true);
  assert.deepEqual(w.keys().sort(), ['_state/hubspot-live.json', 'data.js', 'refresh.json']);
  assert.equal(w.data().deals.find((x) => x.id === 'deal-101').amount, 2000);
});

test('removing the stored hash forces an upload', async (t) => {
  const w = world();
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  await w.run();
  w.puts.length = 0;
  w.s3.delete('preview/refresh.json');
  const d = await w.run();
  assert.equal(d.changed, true);
  assert.ok(w.keys().includes('data.js'));
});

test('the snapshot’s HubSpot export decides amount, status and the deal list; Sheet fields stay as of the snapshot', async (t) => {
  const w = world();
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  await w.run();
  const d = w.data();
  const deal = (id) => d.deals.find((x) => x.id === id);
  assert.equal(deal('deal-101').amount, 1000, 'HubSpot amount, not the Sheet’s 1500');
  assert.equal(deal('deal-101').sheet.amount, 1500, 'the Sheet value is kept as a Sheet field');
  assert.equal(deal('deal-102').open, false, 'closed in HubSpot is never open');
  assert.ok(deal('deal-103'), 'HubSpot-only deals appear');
  assert.equal(deal('deal-201').pipeline, 'Renewals', 'pipelines never mix');
  assert.deepEqual(d.quality.closedButActive.map((r) => r.id), ['deal-102']);
  assert.deepEqual(d.quality.missingFromSheet.map((r) => r.id), ['deal-103']);
  assert.equal(d.headline.pipeline, 'Sales Pipeline');
  assert.equal(d.headline.active.count, 2);
  assert.equal(d.times.recon, '2026-01-16T19:50:00Z', 'HubSpot time is the export’s own');
  assert.equal(d.refresh.sheetAsOf, GEN);
  assert.equal(d.refresh.snapshot.publishedAt, '2026-01-16T20:00:00Z');
  assert.deepEqual(d.outbound.campaigns.map((c) => c.id), ['cam0'], 'lemlist as published');
  assert.deepEqual(d.transcripts, ['recording-1'], 'only transcripts the records link to');
  assert.ok(d.sources.every((s) => s.fromSnapshot && !s.live));
});

test('a snapshot without a HubSpot export uses the last good copy; with none it refuses to build', async (t) => {
  const w = world({ withExport: false });
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  await assert.rejects(w.run(), /no HubSpot deal export/);
  w.publish('run-test-2', { ...w.files, 'hubspot-deals.json': hubspotExport() }, '2026-01-16T20:30:00Z');
  await w.run();
  assert.equal(w.data().pipelineSource, 'hubspot');
  w.publish('run-test-3', { ...w.files }, '2026-01-16T20:45:00Z');
  await w.run();
  assert.equal(w.data().refresh.hubspot, 'last-good');
  assert.equal(w.data().pipelineSource, 'hubspot');
});

test('companies, owners, ownerHistory, companyIds and closed_lost_reason survive the snapshot export and the last good copy', async (t) => {
  const w = world({ withExport: false });
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  const ex = hubspotExport();
  const lost = ex.deals.find((d) => d.id === '102');
  lost.properties.closed_lost_reason = 'Went with a competitor';
  lost.properties.closedate = '2026-01-10T00:00:00Z';
  lost.companyIds = ['c77'];
  lost.ownerHistory = [{ value: '2', timestamp: '2026-01-12T00:00:00Z', sourceType: 'CRM_UI' }, { value: '3', timestamp: '2025-12-01T00:00:00Z', sourceType: 'CRM_UI' }];
  ex.companies = { c77: { name: 'Gone Corp', domain: 'gone.example' } };
  ex.owners = { 2: { name: 'Now Owner' }, 3: { name: 'Closing Owner', archived: true } };
  const check = (d, mode) => {
    const deal = d.deals.find((x) => x.id === 'deal-102');
    assert.equal(d.refresh.hubspot, mode);
    assert.equal(deal.lostReason, 'Went with a competitor', mode);
    assert.equal(deal.account, 'Gone Corp', mode);
    assert.equal(deal.ownerAtClose, 'Closing Owner', mode);
    assert.deepEqual(deal.ownerHistory.map((h) => h.owner), ['Now Owner', 'Closing Owner'], mode);
    assert.deepEqual([d.closedLost.count, d.closedLost.reasons[0].reason], [1, 'Went with a competitor'], mode);
  };
  w.publish('run-test-2', { ...w.files, 'hubspot-deals.json': ex }, '2026-01-16T20:30:00Z');
  await w.run();
  check(w.data(), 'snapshot');
  const cache = JSON.parse(w.s3.get('preview/_state/hubspot-live.json'));
  assert.deepEqual(Object.keys(cache.live).sort(), ['companies', 'deals', 'owners', 'pipes', 'stages']);
  w.publish('run-test-3', { ...w.files }, '2026-01-16T20:45:00Z');
  await w.run();
  check(w.data(), 'last-good');
  assert.deepEqual(Object.keys(hubspotLive({ pipes: {}, stages: {}, deals: [] })).sort(), ['deals', 'pipes', 'stages']);
});

test('a stale LATEST.json alarms', async (t) => {
  const w = world();
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  w.cfg.staleMinutes = 60;
  await w.run();
  assert.equal(w.notes.length, 0);
  for (let i = 0; i < 4; i++) await w.run();
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].message, /sync job/);
});

test('isHubspotExport recognises the export by shape only', () => {
  assert.equal(isHubspotExport(hubspotExport()), true);
  assert.equal(isHubspotExport({ pipes: {}, stages: {}, deals: [{ id: 1 }] }), false);
  assert.equal(isHubspotExport({ prep: [], brief: {} }), false);
  assert.deepEqual(problems({ live: null, hubspotMode: 'snapshot', snapshotPublishedAt: '2026-01-16T20:00:00Z', nowMs: Date.parse('2026-01-16T20:30:00Z'), staleMinutes: 60 }), []);
});

// ---------- LIVE_PULL=1 (off by default, not granted in IAM) ----------

test('LIVE_PULL: live HubSpot, lemlist and Fathom replace the snapshot values', async (t) => {
  const w = world({ livePull: true, withExport: false });
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  const a = await w.run();
  assert.equal(a.changed, true);
  assert.deepEqual(w.keys().sort(), ['_state/hubspot-live.json', 'data.js', 'refresh.json']);
  const d = w.data();
  assert.equal(d.refresh.hubspot, 'live');
  assert.deepEqual(d.outbound.campaigns.map((c) => c.id), ['cam1', 'cam2']);
  const c2 = d.companies.find((c) => c.id === 'c2');
  assert.deepEqual(c2.recordings[0].actions, ['Send pricing']);
  assert.equal(d.companies.find((c) => c.id === 'c1').recordings.length, 1, 'a recording already in the snapshot is not duplicated');
  assert.ok(!w.calls.some((c) => /google/.test(c)), 'no Google calls');
  w.puts.length = 0;
  w.deals[0].properties.hs_lastmodifieddate = 'changed but not a field the page uses';
  const b = await w.run();
  assert.equal(b.changed, false);
  assert.deepEqual(w.keys(), ['refresh.json']);
});

test('LIVE_PULL: a failing source falls back, is marked stale, and alarms once per change', async (t) => {
  const w = world({ livePull: true, withExport: false });
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  await w.run();
  assert.equal(w.notes.length, 0);
  w.fail.hubspot = true;
  w.fail.fathom = true;
  const r = await w.run();
  assert.deepEqual(r.failing, ['hubspot', 'fathom']);
  assert.equal(w.notes.length, 1);
  const d = w.data();
  assert.equal(d.refresh.hubspot, 'last-good');
  assert.equal(d.sources.find((s) => s.source === 'hubspot').ok, false);
  await w.run();
  assert.equal(w.notes.length, 1);
  w.fail = {};
  await w.run();
  assert.match(w.notes[1].subject, /cleared/);
});

test('LIVE_PULL: a rotated HubSpot refresh token is not saved and raises an alarm', async (t) => {
  const w = world({ livePull: true });
  t.after(() => rmSync(w.tmp, { recursive: true, force: true }));
  w.rotate = true;
  const r = await w.run();
  assert.ok(r.failing.includes('hubspot-refresh-token-rotated'));
  assert.match(w.notes[0].message, /NOT saved/);
});

test('compose: the hash ignores the clock and follows the content', () => {
  const files = snapshotFiles();
  const snapshot = { records: files['records.json'], marketing: files['marketing.json'], sheetReview: files['sheet-review.json'], brief: files['agent-brief.json'], operator: files['prep-file.json'] };
  const pipes = { default: 'Sales Pipeline' };
  const stages = { s1: { pipe: 'Sales Pipeline', label: 'Discovery', closed: false, prob: '0.2' } };
  const live = (amount) => ({ hubspot: { ok: true, live: { pipes, stages, deals: [{ id: '101', properties: { dealstage: 's1', pipeline: 'default', amount } }] } }, lemlist: { ok: false, error: 'x' }, fathom: { ok: false, error: 'y' } });
  const a = compose({ snapshot, meta: { runId: RUN }, live: live('1') });
  const b = compose({ snapshot, meta: { runId: RUN }, live: live('1') });
  const c = compose({ snapshot, meta: { runId: RUN }, live: live('2') });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.ok(a.text.includes(NOW_TOKEN));
  const s = stamp(a.text, '2026-01-16T20:00:00.000Z', a.vols);
  assert.ok(!s.includes(NOW_TOKEN) && !s.includes('@@GTM_V'));
  const d = JSON.parse(s.replace(/^window\.GTM_DATA=/, '').replace(/;\n$/, ''));
  assert.equal(d.times.sheet, GEN);
  assert.equal(d.refresh.snapshot.runId, RUN);
  assert.match(s, /"refreshedAt":"2026-01-16T20:00:00.000Z"/);
});

test('alarmDecision: on change, on recovery, daily reminder, otherwise quiet', () => {
  const now = Date.parse('2026-01-16T20:00:00Z');
  assert.equal(alarmDecision({ failing: [], prev: {}, nowMs: now }).send, false);
  assert.equal(alarmDecision({ failing: ['fathom'], prev: {}, nowMs: now }).reason, 'changed');
  assert.equal(alarmDecision({ failing: ['fathom'], prev: { failing: ['fathom'], lastAlarmAt: new Date(now - 3600e3).toISOString() }, nowMs: now }).send, false);
  assert.equal(alarmDecision({ failing: ['fathom'], prev: { failing: ['fathom'], lastAlarmAt: new Date(now - 25 * 3600e3).toISOString() }, nowMs: now }).reason, 'reminder');
  assert.equal(alarmDecision({ failing: [], prev: { failing: ['fathom'] }, nowMs: now }).reason, 'recovered');
});

test('HubSpot calls are read-only and stay on api.hubapi.com', async () => {
  assert.throws(() => assertHubspotRead('POST', 'https://api.hubapi.com/crm/v3/objects/deals'), /only GET/);
  assert.throws(() => assertHubspotRead('PATCH', 'https://api.hubapi.com/crm/v3/objects/deals/1'), /only GET/);
  assert.throws(() => assertHubspotRead('GET', 'https://evil.example/crm'), /host/);
  assert.throws(() => validateHubspotDoc({ ...JSON.parse(HUBSPOT_SECRET), portal_id: '1' }), /portal_id/);
  assert.throws(() => validateHubspotDoc(JSON.parse(HUBSPOT_SECRET), ''), /HUBSPOT_PORTAL_ID is not set/);
  assert.throws(() => validateHubspotDoc({ ...JSON.parse(HUBSPOT_SECRET), token_endpoint: 'https://evil.example/oauth/v1/token' }), /token endpoint/);
  const seen = [];
  const fake = async (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${new URL(url).pathname}`);
    const u = new URL(url);
    const body = u.pathname.includes('oauth') ? { access_token: 'at', expires_in: 1800 }
      : u.pathname === '/account-info/v3/details' ? { portalId: 90000001 }
        : u.pathname.endsWith('/pipelines/deals') ? PIPELINES : { results: hubspotDeals() };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await fetchHubspot(HUBSPOT_SECRET, { fetchImpl: fake });
  assert.equal(r.rotated, false);
  assert.deepEqual(seen, ['POST /oauth/v1/token', 'GET /account-info/v3/details', 'GET /crm/v3/pipelines/deals', 'GET /crm/v3/objects/deals']);
  assert.equal(r.live.stages.s9.closed, true);
  assert.equal(r.live.stages.s1.prob, '0.2');
  assert.ok(!('hs_lastmodifieddate' in r.live.deals[0].properties), 'volatile properties are dropped');
});

test('lemlist and Fathom projections match the refresh job', () => {
  const out = outboundFromCampaigns([
    { _id: 'a', name: 'A', status: 'running', stats: { messagesSent: 3, nbLeadsOpened: 1 }, statsAttempts: [{ http: 200 }] },
    { _id: 'b', name: 'B', status: 'draft', statsAttempts: [{ http: 403 }] },
  ]);
  assert.deepEqual(out.byStatus, { running: 1, draft: 1 });
  assert.deepEqual(out.statsResponses, { 200: 1, 403: 1 });
  assert.equal(out.campaignStats[0].opened, 1);
  assert.deepEqual(out.names, ['A']);
  const rec = recordingFromFathom({ recording_id: 7, title: 'example corp sync', recorded_by: { name: 'maya graff' }, recording_start_time: '2026-01-01T10:00:00Z', recording_end_time: '2026-01-01T10:45:30Z' });
  assert.equal(rec.minutes, 45);
  assert.equal(rec.recordedBy, 'Maya Graff');
  assert.equal(matchRecording(rec, [{ id: 'c1', name: 'Example Corp', domain: null }]), 'c1');
  assert.equal(tokenFromSecret('{"api_key":" k "}', 'x'), 'k');
  assert.equal(tokenFromSecret(' plain ', 'x'), 'plain');
});
