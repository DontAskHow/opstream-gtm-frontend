// The lost-reasons file (lost-reasons.json): the validator the page and the
// publish script share, its agreement with docs/lost-reasons.schema.json, the
// keyword fallback and its precedence, file entries overriding it per deal, and
// the invariant that the six categories cover every closed-lost deal of the
// headline pipeline exactly once. Synthetic content only; the real file (and a
// local data.js) are read only when present, and nothing from them is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { closedLost } from '../workspace/lib/project.mjs';
import { checkText, KEY } from '../workspace/refresh/publish-lost-reasons.mjs';
import { decide } from '../workspace/refresh/publish-insights.mjs';

const require = createRequire(import.meta.url);
const { validate, parse, classify, categorize, dealKey, CATEGORIES, LIMITS } = require('../workspace/src/lost-reasons.js');
const schema = JSON.parse(readFileSync(new URL('../docs/lost-reasons.schema.json', import.meta.url), 'utf8'));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const entry = (o = {}) => ({ deal_id: '1001', category: 'went_dark', inferred: true, basis: 'No reply after the proposal.', ...o });
const good = () => ({
  generated_at: '2026-01-16T12:00:00-07:00',
  deals: [
    entry(),
    entry({ deal_id: '1002', category: 'competitor', competitor: 'VendorX', inferred: false, basis: 'Reason names VendorX.' }),
    entry({ deal_id: '1003', category: 'competitor', basis: 'A cheaper tool, not named.' }),
  ],
});
const errs = (doc) => validate(doc).errors.join('\n');

test('categories are the six keys, in display order', () => {
  assert.deepEqual(CATEGORIES.map((c) => c.key), ['went_dark', 'competitor', 'not_a_fit', 'no_budget_timing', 'status_quo', 'unknown']);
  assert.deepEqual(CATEGORIES.map((c) => c.label), [
    'Went dark / no response', 'Chose a competitor', 'Not a fit / disqualified', 'No budget or timing', 'Stayed with the status quo', 'Unknown',
  ]);
});

test('a well-formed file passes: competitor name optional, competitors list optional, either id form', () => {
  assert.deepEqual(validate(good()).errors, []);
  const d = good();
  d.competitors = ['VendorX', 'VendorY'];
  d.deals.push(entry({ deal_id: 'deal-1004', category: 'competitor', competitor: null }), entry({ deal_id: '1005', category: 'unknown', competitor: null }));
  d.generated_at = '2026-01-16T19:00:00.123Z';
  assert.deepEqual(validate(d).errors, []);
  assert.equal(validate({ generated_at: d.generated_at, deals: [] }).ok, true);
  const p = parse(JSON.stringify(d));
  assert.equal(p.ok, true);
  assert.equal(p.doc.deals.length, 5);
});

test('each rule rejects', () => {
  const cases = [
    [(d) => delete d.generated_at, /generated_at/],
    [(d) => { d.generated_at = '2026-01-16T12:00:00'; }, /generated_at/],
    [(d) => { d.generated_at = '2026-01-16'; }, /generated_at/],
    [(d) => delete d.deals, /deals: must be an array/],
    [(d) => { d.entries = d.deals; delete d.deals; }, /entries: unknown field[\s\S]*deals: must be an array/],
    [(d) => { d.deals = Array.from({ length: LIMITS.deals + 1 }, (_, i) => entry({ deal_id: String(i) })); }, /deals: must be an array of at most 2000/],
    [(d) => { d.deals[0] = 'x'; }, /deals\[0\]: must be an object/],
    [(d) => { d.deals[0].deal_id = 1001; }, /deals\[0\]\.deal_id/],
    [(d) => { d.deals[0].deal_id = '10 01'; }, /deals\[0\]\.deal_id/],
    [(d) => { d.deals[0].deal_id = 'x'.repeat(101); }, /deals\[0\]\.deal_id/],
    [(d) => { d.deals[1].deal_id = 'deal-1001'; }, /deals\[1\]\.deal_id: deal-1001 is already in deals\[0\]/],
    [(d) => { d.deals[0].category = 'pricing'; }, /deals\[0\]\.category: must be one of went_dark/],
    [(d) => { d.deals[0].category = 'toString'; }, /deals\[0\]\.category/],
    [(d) => { d.deals[0].competitor = 'VendorX'; }, /deals\[0\]\.competitor: must be null or absent unless category is competitor/],
    [(d) => { d.deals[1].competitor = ' '; }, /deals\[1\]\.competitor: must be a non-empty string/],
    [(d) => { d.deals[1].competitor = 'x'.repeat(101); }, /deals\[1\]\.competitor: longer than 100/],
    [(d) => { d.deals[1].competitor = 7; }, /deals\[1\]\.competitor/],
    [(d) => { d.deals[0].inferred = 'yes'; }, /deals\[0\]\.inferred: must be true or false/],
    [(d) => delete d.deals[0].inferred, /deals\[0\]\.inferred/],
    [(d) => delete d.deals[0].basis, /deals\[0\]\.basis: must be a non-empty string/],
    [(d) => { d.deals[0].basis = 'x'.repeat(501); }, /deals\[0\]\.basis: longer than 500/],
    [(d) => { d.deals[0].reason = 'typo'; }, /deals\[0\]\.reason: unknown field/],
    [(d) => { d.extra = 1; }, /extra: unknown field/],
    [(d) => { d.competitors = 'VendorX'; }, /competitors: must be an array of at most 50/],
    [(d) => { d.competitors = Array.from({ length: 51 }, (_, i) => `Vendor${i}`); }, /competitors: must be an array of at most 50/],
    [(d) => { d.competitors = ['']; }, /competitors\[0\]: must be a non-empty string/],
    [(d) => { d.competitors = ['x'.repeat(101)]; }, /competitors\[0\]: longer than 100/],
  ];
  for (const [mutate, re] of cases) {
    const d = good();
    mutate(d);
    assert.match(errs(d), re, String(mutate));
  }
  assert.equal(parse('{not json').ok, false);
  assert.equal(parse('[]').ok, false);
  assert.equal(parse(null).ok, false);
  assert.match(parse(' '.repeat(LIMITS.fileBytes + 1)).errors[0], /larger than/);
  // The cap counts UTF-8 bytes, not characters.
  assert.match(parse('é'.repeat(LIMITS.fileBytes / 2 + 1)).errors[0], /larger than/);
});

test('the JSON schema mirrors the validator', () => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['competitors', 'deals', 'generated_at']);
  assert.deepEqual(schema.required.sort(), ['deals', 'generated_at']);
  const it = schema.properties.deals.items;
  assert.equal(schema.properties.deals.maxItems, LIMITS.deals);
  assert.equal(it.additionalProperties, false);
  assert.deepEqual(Object.keys(it.properties).sort(), ['basis', 'category', 'competitor', 'deal_id', 'inferred']);
  assert.deepEqual(it.required.sort(), ['basis', 'category', 'deal_id', 'inferred']);
  assert.deepEqual(it.properties.category.enum, CATEGORIES.map((c) => c.key));
  assert.equal(it.properties.basis.maxLength, LIMITS.basis);
  assert.equal(it.properties.competitor.maxLength, LIMITS.competitor);
  assert.equal(it.if.properties.category.const, 'competitor');
  assert.equal(it.else.properties.competitor.type, 'null');
  assert.equal(schema.properties.competitors.maxItems, LIMITS.competitors);
  const id = new RegExp(it.properties.deal_id.pattern);
  assert.ok(id.test('1001') && id.test('deal-1001') && !id.test('10 01'));
  const re = new RegExp(schema.properties.generated_at.pattern);
  assert.ok(re.test(good().generated_at));
  assert.ok(!re.test('2026-01-16T12:00:00'));
});

test('fallback keyword rules, case-insensitive, whole words where it matters', () => {
  const cat = (reason, names) => classify(reason, names).category;
  for (const r of [null, undefined, '', '   ', 'na', 'NA', 'n/a', 'N/A', ' n/a ', 'Other', 'Pricing', 'Champion left'])
    assert.equal(cat(r), 'unknown', String(r));
  for (const r of ['Ghosted', 'ghost', 'No response after demo', 'UNRESPONSIVE', 'Went dark'])
    assert.equal(cat(r), 'went_dark', r);
  for (const r of ['Chose a competitor', 'Went with another tool', 'chose another option', 'Selected another vendor'])
    assert.equal(cat(r), 'competitor', r);
  for (const r of ['Irrelevant', 'Not a fit', 'Disqualified', 'disqualification - too small'])
    assert.equal(cat(r), 'not_a_fit', r);
  for (const r of ['No budget', 'Budgets frozen', 'Bad timing', 'Maybe later', 'Revisit next year'])
    assert.equal(cat(r), 'no_budget_timing', r);
  for (const r of ['Status quo', 'Building in-house', 'Keeping it in house', 'No change for now'])
    assert.equal(cat(r), 'status_quo', r);
  // Keywords start a word; "dark" and "later" only as whole words.
  assert.equal(cat('Darker pricing tier'), 'unknown');
  assert.equal(cat('Collateral'), 'unknown');
  assert.equal(cat('Translater issue'), 'unknown');
  assert.equal(cat('Unbudgeted'), 'unknown');
});

test('fallback precedence: listed name > status quo > generic competitor > not a fit > budget/timing > went dark', () => {
  const names = ['VendorX', 'Vendor X Cloud'];
  const c = (reason, n) => classify(reason, n);
  assert.deepEqual(c('Went with VendorX, went dark after', names), { category: 'competitor', competitor: 'VendorX' });
  assert.deepEqual(c('vendorx in-house build', names), { category: 'competitor', competitor: 'VendorX' }, 'listed name beats status quo, any case');
  assert.deepEqual(c('Moved to vendor x cloud', names), { category: 'competitor', competitor: 'Vendor X Cloud' }, 'longest name first');
  assert.deepEqual(c('VendorXL chosen', names), { category: 'unknown', competitor: null }, 'names match whole words only');
  assert.deepEqual(c('Went with VendorY'), { category: 'competitor', competitor: null }, 'unlisted name: generic phrase, unnamed');
  assert.deepEqual(c('VendorY'), { category: 'unknown', competitor: null }, 'no list: a bare name is unknown');
  assert.equal(c('Went with an in-house build').category, 'status_quo');
  assert.equal(c('Chose a competitor, not a fit').category, 'competitor');
  assert.equal(c('Not a fit, no budget').category, 'not_a_fit');
  assert.equal(c('No budget, then went dark').category, 'no_budget_timing');
  assert.equal(c('Ghosted - status quo').category, 'status_quo');
  assert.equal(c('n/a', names).category, 'unknown', 'blank and n/a come first');
});

// GTM_DATA-shaped deals: the headline pipeline's closed-lost set, plus deals that must not count.
const D_HEAD = 'Sales Pipeline';
const deal = (n, o) => ({ id: `deal-${n}`, name: `Acme ${n}`, pipeline: D_HEAD, closed: true, won: false, lost: true, open: false, amount: 1000 * n, lostReason: null, ...o });
function data() {
  const deals = [
    deal(1, { lostReason: 'Ghosted' }),
    deal(2, { lostReason: 'Went with VendorX' }),
    deal(3, { lostReason: 'not a fit' }),
    deal(4, { lostReason: 'No budget' }),
    deal(5, { lostReason: 'In-house' }),
    deal(6, { lostReason: '', amount: null }),
    deal(7, { lostReason: 'N/A' }),
    deal(8, { lostReason: 'Picked vendorx' }),
    deal(9, { lostReason: 'Something else' }),
    deal(20, { pipeline: 'Renewals', lostReason: 'Ghosted' }),
    deal(21, { won: true, lost: false, lostReason: null }),
    deal(22, { closed: false, lost: false, open: true }),
  ];
  return { deals, closedLost: closedLost({ label: D_HEAD }, deals) };
}
const total = (r) => r.rows.reduce((a, x) => a + x.count, 0);
const row = (r, key) => r.rows.find((x) => x.key === key);

test('rules only: every closed-lost headline deal lands in exactly one category', () => {
  const D = data();
  assert.equal(D.closedLost.count, 9);
  const r = categorize(D, null);
  assert.deepEqual(r.rows.map((x) => x.key), CATEGORIES.map((c) => c.key));
  assert.equal(total(r), D.closedLost.count);
  assert.equal(r.count, D.closedLost.count);
  const ids = r.rows.flatMap((x) => x.deals.map((d) => d.id)).sort();
  assert.deepEqual(ids, D.deals.filter((d) => d.lost && d.pipeline === D_HEAD).map((d) => d.id).sort(), 'each once');
  assert.deepEqual(r.rows.map((x) => [x.key, x.count]), [
    ['went_dark', 1], ['competitor', 1], ['not_a_fit', 1], ['no_budget_timing', 1], ['status_quo', 1], ['unknown', 4],
  ]);
  assert.deepEqual([r.fromFile, r.auto], [0, 9]);
  assert.ok(r.rows.every((x) => x.deals.every((d) => d.source === 'auto' && d.basis === null)));
  const unk = row(r, 'unknown');
  assert.deepEqual([unk.amount, unk.noAmount], [7000 + 8000 + 9000, 1], 'deals without an amount are counted, not summed');
  assert.equal(unk.deals.find((d) => d.id === 'deal-6').reason, null, 'blank reason is null (shown as —)');
  assert.equal(unk.deals.find((d) => d.id === 'deal-7').reason, 'N/A', 'reason kept verbatim');
  assert.deepEqual(row(r, 'competitor').competitors, [], 'generic phrase: unnamed');
  assert.equal(row(r, 'competitor').unnamed, 1);
  assert.equal(categorize({ deals: [] }, null), null, 'no closedLost, no panel');
});

test('file entries override the rules per deal; prefix normalized; the rest auto-mapped with the file\'s names', () => {
  const D = data();
  const doc = parse(JSON.stringify({
    generated_at: '2026-01-16T12:00:00Z',
    deals: [
      entry({ deal_id: '1', category: 'no_budget_timing', inferred: true, basis: 'Budget cut mentioned in notes.' }),
      entry({ deal_id: 'deal-9', category: 'competitor', competitor: 'VendorY', inferred: false, basis: 'Reason names VendorY.' }),
      entry({ deal_id: '3', category: 'competitor', basis: 'Lost to an unnamed tool.' }),
      entry({ deal_id: '20', category: 'status_quo', basis: 'Other pipeline: ignored.' }),
      entry({ deal_id: '999', category: 'unknown', basis: 'Not in the data: ignored.' }),
    ],
    competitors: ['VendorX'],
  }));
  assert.equal(doc.ok, true);
  const r = categorize(D, doc.doc);
  assert.equal(total(r), D.closedLost.count);
  assert.deepEqual([r.fromFile, r.auto], [3, 6]);
  const where = (id) => { for (const x of r.rows) { const d = x.deals.find((y) => y.id === id); if (d) return [x.key, d]; } return null; };
  const [k1, d1] = where('deal-1');
  assert.deepEqual([k1, d1.source, d1.basis, d1.reason], ['no_budget_timing', 'inferred', 'Budget cut mentioned in notes.', 'Ghosted']);
  const [k9, d9] = where('deal-9');
  assert.deepEqual([k9, d9.source, d9.competitor], ['competitor', 'file', 'VendorY']);
  const [k3, d3] = where('deal-3');
  assert.deepEqual([k3, d3.source, d3.competitor], ['competitor', 'inferred', null]);
  // Not in the file: the file's competitors list now names deal 8's "vendorx" (and deal 2's).
  const [k8, d8] = where('deal-8');
  assert.deepEqual([k8, d8.source, d8.competitor], ['competitor', 'auto', 'VendorX']);
  assert.equal(where('deal-20'), null);
  const comp = row(r, 'competitor');
  assert.deepEqual(comp.competitors, [{ name: 'VendorX', count: 2 }, { name: 'VendorY', count: 1 }]);
  assert.equal(comp.unnamed, 1);
  assert.equal(comp.count, 4);
  // Largest amount first, deals without one last.
  assert.deepEqual(comp.deals.map((d) => d.id), ['deal-9', 'deal-8', 'deal-3', 'deal-2']);
});

test('competitor names group case-insensitively under the most common spelling', () => {
  const deals = [1, 2, 3].map((n) => deal(n));
  const D = { deals, closedLost: closedLost({ label: D_HEAD }, deals) };
  const r = categorize(D, { generated_at: 'x', deals: [
    entry({ deal_id: '1', category: 'competitor', competitor: 'VendorX' }),
    entry({ deal_id: '2', category: 'competitor', competitor: 'vendorx ' }),
    entry({ deal_id: '3', category: 'competitor', competitor: 'VendorX' }),
  ] });
  assert.deepEqual(row(r, 'competitor').competitors, [{ name: 'VendorX', count: 3 }]);
  assert.equal(dealKey('1001'), 'deal-1001');
  assert.equal(dealKey('deal-1001'), 'deal-1001');
});

test('publish uploads only when the content hash changed', () => {
  assert.equal(KEY, 'lost-reasons.json');
  const r = checkText(JSON.stringify(good()));
  assert.equal(r.ok, true);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(decide(r.sha256, null), 'upload');
  assert.equal(decide(r.sha256, r.sha256), 'unchanged');
  assert.equal(checkText('{"generated_at":"2026-01-16T12:00:00Z","entries":[]}').ok, false);
});

test('shipped with the page and the deploy; the scheduled refresh never writes it', () => {
  const deploy = read('../workspace/refresh/deploy.sh');
  assert.match(deploy, /up lost-reasons\.js vendor\/lost-reasons\.js "application\/javascript; charset=utf-8"/);
  // The Lambda's only S3 writes are data.js, refresh.json, workspace.json (the one-page workspace) and its state file.
  const puts = [...deploy.matchAll(/"Action":\[?[^\]}]*s3:PutObject[^\]}]*\]?,\s*"Resource":\[([^\]]*)\]/g)].map((m) => m[1]);
  const keys = puts.flatMap((r) => r.split(',').map((x) => x.trim().replace(/^"arn:aws:s3:::\$PREVIEW_BUCKET\/|"$/g, '')));
  assert.deepEqual(keys.sort(), ['_state/hubspot-live.json', 'data.js', 'refresh.json', 'workspace.json']);
  for (const f of ['handler.mjs', 'compose.mjs', 'sources.mjs']) assert.doesNotMatch(read(`../workspace/refresh/${f}`), /lost-reasons/, f);
  assert.match(read('../workspace/src/index.html'), /<script src="vendor\/lost-reasons\.js"><\/script>\s*<script src="app\.js">/);
});

// Local-only checks against the Strategy seat's real file (and a local build's
// data.js). Skipped when absent, e.g. in CI. Only pass/fail is reported.
const REAL = process.env.GTM_LOST_REASONS || '/workspace/gtm-insights/lost-reasons.json';
const REAL_DATA = process.env.GTM_DATA_JS || '/workspace/analysis-review/site/data.js';

test('the real lost-reasons.json passes the validator', { skip: !existsSync(REAL) && 'no local lost-reasons.json' }, () => {
  const r = checkText(readFileSync(REAL, 'utf8'));
  assert.ok(r.ok, `${r.errors.length} problem(s), first: ${r.errors[0]}`);
});

test('the real file merged with a local data.js covers closedLost.count exactly', { skip: !(existsSync(REAL) && existsSync(REAL_DATA)) && 'no local file or data.js' }, () => {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(REAL_DATA, 'utf8'), ctx);
  const D = ctx.window.GTM_DATA;
  const r = categorize(D, parse(readFileSync(REAL, 'utf8')).doc);
  assert.equal(total(r), D.closedLost.count);
  assert.equal(new Set(r.rows.flatMap((x) => x.deals.map((d) => d.id))).size, D.closedLost.count);
});
