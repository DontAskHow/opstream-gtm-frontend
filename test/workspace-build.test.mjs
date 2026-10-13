// node --test test/
// End-to-end: synthetic snapshot + HubSpot export -> workspace/build.mjs ->
// output files -> serve.mjs. Every name, id and amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { build, parseArgs } from '../workspace/build.mjs';
import { startServer } from '../workspace/serve.mjs';

const GEN = '2026-10-12T19:00:00+00:00';

function stage(pipe, label, closed, prob) { return { pipe, label, closed, prob: String(prob) }; }
const STAGES = {
  101: stage('Sales Pipeline', 'SQL', false, 0.05),
  102: stage('Sales Pipeline', 'Demo meeting', false, 0.25),
  103: stage('Sales Pipeline', 'On Hold', false, 0.1),
  104: stage('Sales Pipeline', 'Closed lost', true, 0),
  105: stage('Sales Pipeline', 'Disqualified', true, 0),
  201: stage('Renewal Pipeline', 'Negotiations', false, 0.9),
  301: stage('Customer Success Pipeline', 'Negotiation', false, 0.8),
  401: stage('Partnerships Pipeline', 'Exploration', false, 0.4),
};
const deal = (id, name, stageId, amount, prob, close, owner = '9001') => ({
  id, properties: { dealname: name, dealstage: stageId, amount, hs_deal_stage_probability: prob, closedate: close + 'T00:00:00Z', hubspot_owner_id: owner },
});
const LIVE = {
  pipes: { default: 'Sales Pipeline', p2: 'Renewal Pipeline', p3: 'Customer Success Pipeline', p4: 'Partnerships Pipeline' },
  stages: STAGES,
  deals: [
    deal('1', 'Acme Widgets - New Deal', '101', '100000', '0.05', '2026-12-31'),
    deal('2', 'Globex - New Deal', '102', '50000', '0.25', '2026-09-30'),
    deal('3', 'Hooli - New Deal', '101', '40000', null, '2026-11-30'),          // no probability, not on Sheet
    deal('4', 'Umbrella - New Deal', '103', '30000', '0.1', '2027-01-31'),    // On Hold
    deal('5', 'Initech - New Deal', '104', '80000', '0', '2026-08-01'),       // closed lost, Sheet says active
    deal('6', 'Vandelay - New Deal', '105', '70000', '0', '2026-07-01'),
    deal('7', 'Acme Widgets - Renewal', '201', '20000', '0.9', '2026-11-01'),
    deal('8', 'Globex - Expansion', '301', '15000', '0.8', '2026-12-01'),
    deal('9', 'Initech - Partnership', '401', null, '0.4', '2026-12-15'),
  ],
};

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), 'gtm-ws-test-'));
  const data = join(root, 'data'), recon = join(root, 'recon'), brand = join(root, 'brand');
  for (const d of [data, recon, brand, join(data, 'transcripts')]) mkdirSync(d, { recursive: true });
  const companies = [
    { id: 'c1', name: 'Acme Widgets', industry: 'COMPUTER_SOFTWARE', lifecycle: 'opportunity', owner: 'Pat Example',
      deals: [{ id: 'deal-1', name: 'Acme Widgets - New Deal', stage: '101', stageLabel: 'SQL', amount: 100000, probability: 5, close: '2026-12-31', owner: 'Pat Example', closed: false, history: [], amountHistory: [], closeHistory: [] }],
      contacts: [{ name: 'Jane Doe', email: 'jane@acme.example' }], notes: [{ id: 'n1', date: '2026-10-01', text: '<p>Asked for <b>pricing</b></p>', owner: 'Pat Example' }],
      meetings: [{ id: 'm1', title: 'Acme intro', start: '2026-10-14T16:00:00Z', outcome: 'SCHEDULED', owner: 'Pat Example', invitees: [] }],
      recordings: [{ id: 'recording-1', title: 'Acme call', date: '2026-10-01T16:00:00Z', minutes: 30, summary: [{ t: 'h2', x: 'Purpose' }, { t: 'li', x: 'Scope the pilot' }], actions: ['Send the security questionnaire'], hasTranscript: true, transcriptLines: 1 }],
      emails: { count: 2, items: [] }, calls: [], tasks: [] },
    { id: 'c2', name: 'Globex', industry: null, lifecycle: 'lead', owner: 'Sam Sample', deals: [], contacts: [], notes: [], meetings: [], recordings: [], emails: { count: 0, items: [] } },
  ];
  const files = {
    'records.json': { generatedAt: GEN, owners: { 9001: 'Pat Example' }, companies, unmatchedRecordings: [] },
    'sheet-review.json': { generatedAt: GEN, deals: [
      { id: '1', name: 'Acme Widgets - New Deal', stage: 'SQL', amount: 100000, probability: 5 },
      { id: '2', name: 'Globex - New Deal', stage: 'Demo meeting', amount: 50000, probability: 25 },
      { id: '5', name: 'Initech - New Deal', stage: 'Demo meeting', amount: 80000, probability: 25 },
    ] },
    'marketing.json': { generatedAt: GEN, outbound: { fetchedAt: GEN, campaignStats: [{ campaignId: 'cam1', name: 'Example sequence', status: 'running', sent: 10, delivered: 10, opened: 0, replied: 1, meetings: 0 }] },
      ads: [{ name: 'Example Ads', spend: 100, clicks: 10, conversions: 1 }], sources: [{ source: 'hubspot', label: 'HubSpot', ok: true, at: GEN }] },
    'agent-brief.json': { generatedAt: GEN, whatsNew: ['One', 'Two'], topActions: [{ title: 'Three' }], watchOuts: ['Four', 'Five', 'Six'] },
    'operator-prep.json': { generatedAt: GEN, brief: { meetings: { items: [] } }, prep: [{ meetingId: 'm1', companyId: 'c1', title: 'Acme intro', start: '2026-10-14T16:00:00Z', attendees: [], unresolvedActions: [], suggestedAgenda: [] }] },
  };
  for (const [f, v] of Object.entries(files)) writeFileSync(join(data, f), JSON.stringify(v));
  writeFileSync(join(data, 'transcripts', 'recording-1.json'), JSON.stringify([{ speaker: 'Jane Doe', timestamp: '00:00:01', text: 'Hello </script>' }]));
  writeFileSync(join(recon, 'live_deals.json'), JSON.stringify(LIVE));
  writeFileSync(join(brand, 'logo-main.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return { root, data, recon, brand, out: join(root, 'out') };
}

const loadData = (out) => {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(join(out, 'data.js'), 'utf8'), ctx);
  return JSON.parse(JSON.stringify(ctx.window.GTM_DATA)); // into this realm, for deepStrictEqual
};
const EXPECT = { count: 3, amount: 190000, weighted: 17500, holdCount: 1, holdAmount: 30000 };

test('HubSpot export drives the pipeline; pipelines never mix; expected figures verified', () => {
  const fx = fixtures();
  try {
    build({ ...fx, expect: EXPECT, quiet: true });
    const data = loadData(fx.out);
    assert.equal(data.pipelineSource, 'hubspot');
    // HubSpot is the only headline: no run-facts figure reaches the page.
    assert.equal('runFacts' in data, false);
    assert.equal('runFacts' in data.times, false);
    assert.match(data.definition, /isClosed/);
    const h = data.headline;
    assert.equal(h.pipeline, 'Sales Pipeline');
    // 1 (SQL) + 2 (Demo, past close) + 3 (no probability). 5 is closed lost, 4 On Hold.
    assert.deepEqual([h.active.count, h.active.openAmount, h.active.weighted, h.active.noProbabilityCount], [3, 190000, 17500, 1]);
    assert.deepEqual([h.onHold.count, h.onHold.openAmount], [1, 30000]);
    assert.equal(data.expect.matches, true);
    const by = Object.fromEntries(data.figures.map((f) => [f.label, f]));
    assert.equal(by['Renewal Pipeline'].active.openAmount, 20000);
    assert.equal(by['Customer Success Pipeline'].active.openAmount, 15000);
    assert.equal(by['Partnerships Pipeline'].active.noAmountCount, 1);
    assert.equal(by['Partnerships Pipeline'].kind, 'partnership');
    // Data quality: 5 is closed in HubSpot but Sheet-active; 3 is open but not on the Sheet.
    assert.deepEqual(data.quality.closedButActive.map((r) => r.id), ['deal-5']);
    assert.deepEqual(data.quality.missingFromSheet.map((r) => r.id), ['deal-3']);
    assert.equal(data.bridge, 3);
    // Probabilities are fractions; stages ordered by HubSpot probability.
    assert.equal(data.deals.find((d) => d.id === 'deal-1').probability, 0.05);
    assert.deepEqual(data.pipelines.find((p) => p.label === 'Sales Pipeline').stages.map((s) => s.label),
      ['SQL', 'On Hold', 'Demo meeting', 'Closed lost', 'Disqualified']);
    // Notes are plain text; segment is industry.
    assert.equal(data.companies[0].notes[0].text, 'Asked for pricing');
    assert.equal(data.companies[1].segment, 'Industry not set');
    assert.equal(data.operator.prep.length, 1);
    // Output files, and no way to talk to the network.
    for (const f of ['index.html', 'app.js', 'styles.css', 'vendor/gtm-charts.js', 'logo.svg', 'transcripts/recording-1.js', '.gtm-workspace-build']) {
      assert.ok(existsSync(join(fx.out, f)), f);
    }
    assert.ok(!readFileSync(join(fx.out, 'transcripts/recording-1.js'), 'utf8').includes('</script>'));
    const app = readFileSync(join(fx.out, 'app.js'), 'utf8') + readFileSync(join(fx.out, 'vendor/gtm-charts.js'), 'utf8');
    assert.doesNotMatch(app, /run-facts|runFacts|Sheet-based/i);
    // The only network reads are the two same-origin status files, never an absolute URL.
    assert.doesNotMatch(app, /XMLHttpRequest|WebSocket|sendBeacon|https?:\/\/(?!www\.w3\.org)/);
    assert.deepEqual([...app.matchAll(/\bfetch\(([^,)]*)/g)].map((m) => m[1]).sort(), ["'insights.json'", "'refresh.json'"]);
    assert.match(readFileSync(join(fx.out, 'index.html'), 'utf8'), /connect-src 'self'/);
    assert.ok(existsSync(join(fx.out, 'vendor', 'insights.js')));
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('a mismatch keeps the caveat; no --recon is refused', () => {
  const fx = fixtures();
  try {
    build({ ...fx, expect: { ...EXPECT, weighted: 17501 }, quiet: true });
    let data = loadData(fx.out);
    assert.equal(data.expect.matches, false);
    assert.deepEqual(data.expect.rows.filter((r) => !r.ok).map((r) => r.key), ['weighted']);
    assert.throws(() => build({ ...fx, recon: null, expect: null, quiet: true }), /--recon .* is required/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('refuses to clear an output directory it did not create', () => {
  const fx = fixtures();
  try {
    mkdirSync(fx.out);
    writeFileSync(join(fx.out, 'precious.txt'), 'keep me');
    assert.throws(() => build({ ...fx, quiet: true }), /refusing to clear/);
    assert.ok(existsSync(join(fx.out, 'precious.txt')));
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('argument parsing', () => {
  assert.throws(() => parseArgs(['--data', 'x']), /Usage/);
  assert.throws(() => parseArgs(['--data', 'x', '--brand', 'y', '--out', 'z', '--expect', 'count=abc']), /bad --expect/);
  const a = parseArgs(['--data=x', '--brand', 'y', '--out', 'z', '--expect', 'count=37,amount=1']);
  assert.deepEqual(a.expect, { count: 37, amount: 1 });
});

test('serve.mjs serves the build on 127.0.0.1 and nothing outside it', async () => {
  const fx = fixtures();
  build({ ...fx, quiet: true });
  const server = await startServer({ dir: fx.out, port: 0 });
  try {
    const { port, address } = server.address();
    assert.equal(address, '127.0.0.1');
    const get = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
    assert.equal((await get('/')).status, 200);
    assert.equal((await get('/data.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await get('/%2e%2e/%2e%2e/etc/passwd')).status, 404);
    assert.equal((await get('/.gtm-workspace-build')).status, 404);
    assert.equal((await get('/', { method: 'POST' })).status, 405);
  } finally {
    server.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});
