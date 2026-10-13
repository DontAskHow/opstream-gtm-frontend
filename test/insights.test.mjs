// The Analysis file (insights.json): the validator the page and the publish
// script share, its agreement with docs/insights.schema.json, and the
// publish-only-on-change rule. Synthetic content only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkText, decide } from '../workspace/refresh/publish-insights.mjs';

const require = createRequire(import.meta.url);
const { validate, parse, flagText } = require('../workspace/src/insights.js');
const schema = JSON.parse(readFileSync(new URL('../docs/insights.schema.json', import.meta.url), 'utf8'));

const item = () => ({
  title: 'Example title', evidence: 'Figures from the example data.', citations: ['data.js headline.active'],
  why_it_matters: 'Because.', recommended_play: 'Do the thing.', owner: 'Avery Example', confidence: 'medium',
});
const good = () => ({
  generated_at: '2026-01-16T12:00:00-07:00', headline: 'One line.', insights: [item()],
  data_quality_flags: ['a flag', { deal: 'Example', missing: 'amount', count: 2 }], changed_since_last: 'First version.',
});
const errs = (doc) => validate(doc).errors.join('\n');

test('a well-formed file passes, with or without citations, string or array changes', () => {
  assert.deepEqual(validate(good()).errors, []);
  const d = good();
  delete d.insights[0].citations;
  d.changed_since_last = ['one', 'two'];
  d.data_quality_flags = [];
  d.generated_at = '2026-01-16T19:00:00Z';
  assert.equal(validate(d).ok, true);
});

test('each rule rejects', () => {
  const cases = [
    [(d) => delete d.headline, /headline/],
    [(d) => { d.generated_at = '2026-01-16T12:00:00'; }, /generated_at/],
    [(d) => { d.generated_at = '2026-01-16'; }, /generated_at/],
    [(d) => { d.insights = []; }, /insights: must be an array of 1–20/],
    [(d) => { d.insights = Array.from({ length: 21 }, item); }, /insights: must be an array/],
    [(d) => { d.insights[0].confidence = 'certain'; }, /confidence/],
    [(d) => { d.insights[0].owner = ''; }, /owner: must be a non-empty string/],
    [(d) => { d.insights[0].evidence = 'x'.repeat(2001); }, /evidence: longer than 2000/],
    [(d) => { d.insights[0].why_it_maters = 'typo'; }, /why_it_maters: unknown field/],
    [(d) => { d.extra = 1; }, /extra: unknown field/],
    [(d) => { d.data_quality_flags = [{ nested: { a: 1 } }]; }, /data_quality_flags\[0\]/],
    [(d) => { d.data_quality_flags = [7]; }, /data_quality_flags\[0\]/],
    [(d) => { d.changed_since_last = 3; }, /changed_since_last/],
    [(d) => { d.insights[0].citations = 'one'; }, /citations/],
  ];
  for (const [mutate, re] of cases) {
    const d = good();
    mutate(d);
    assert.match(errs(d), re);
  }
  assert.equal(parse('{not json').ok, false);
  assert.equal(parse('[]').ok, false);
  assert.equal(parse('x'.repeat(300000)).ok, false);
});

test('flags render as plain text', () => {
  assert.equal(flagText({ deal: 'Example', count: 2, ok: null }), 'deal: Example · count: 2 · ok: —');
  assert.equal(flagText('<b>not html</b>'), '<b>not html</b>');
});

test('the JSON schema mirrors the validator', () => {
  assert.deepEqual(schema.required.sort(), ['changed_since_last', 'data_quality_flags', 'generated_at', 'headline', 'insights']);
  assert.equal(schema.additionalProperties, false);
  const it = schema.properties.insights.items;
  assert.deepEqual(Object.keys(it.properties).sort(), Object.keys(item()).sort());
  assert.deepEqual(it.required.sort(), Object.keys(item()).filter((k) => k !== 'citations').sort());
  assert.deepEqual(it.properties.confidence.enum, ['low', 'medium', 'high']);
  assert.equal(schema.properties.insights.maxItems, 20);
  const re = new RegExp(schema.properties.generated_at.pattern);
  assert.ok(re.test(good().generated_at));
  assert.ok(!re.test('2026-01-16T12:00:00'));
});

test('publish uploads only when the content hash changed', () => {
  const text = JSON.stringify(good());
  const r = checkText(text);
  assert.equal(r.ok, true);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(decide(r.sha256, null), 'upload');
  assert.equal(decide(r.sha256, r.sha256), 'unchanged');
  assert.equal(decide(r.sha256, 'f'.repeat(64)), 'upload');
  assert.equal(checkText('{"headline":"x"}').ok, false);
});
