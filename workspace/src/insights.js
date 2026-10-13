// Validator for the Analysis file (/insights.json) written by the Strategy seat.
// One copy for the browser (window.GtmInsights) and Node (require), so the page
// and workspace/refresh/publish-insights.mjs accept exactly the same files.
// The shape is documented in docs/insights-schema.md and docs/insights.schema.json.
(function (root) {
  'use strict';

  const LIMITS = {
    fileBytes: 262144, headline: 400, items: 20, title: 200, evidence: 2000, why: 1200, play: 1200,
    owner: 300, citations: 20, citation: 1000, flags: 50, flag: 1000, changes: 50, change: 2000,
  };
  const CONFIDENCE = ['low', 'medium', 'high'];
  const TOP_KEYS = ['generated_at', 'headline', 'insights', 'data_quality_flags', 'changed_since_last'];
  const ITEM_KEYS = ['title', 'evidence', 'citations', 'why_it_matters', 'recommended_play', 'owner', 'confidence'];
  // ISO 8601 date-time with seconds and an explicit offset (Z or ±hh:mm).
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isPrim = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

  function validate(doc) {
    const errors = [];
    const str = (v, path, max, required = true) => {
      if (v === undefined && !required) return;
      if (typeof v !== 'string' || !v.trim()) errors.push(`${path}: must be a non-empty string`);
      else if (v.length > max) errors.push(`${path}: longer than ${max} characters (${v.length})`);
    };
    const unknown = (o, allowed, path) => {
      for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${path}${k}: unknown field`);
    };
    if (!isObj(doc)) return { ok: false, errors: ['top level: must be a JSON object'] };
    unknown(doc, TOP_KEYS, '');
    if (typeof doc.generated_at !== 'string' || !ISO.test(doc.generated_at) || !Number.isFinite(Date.parse(doc.generated_at))) {
      errors.push('generated_at: must be an ISO 8601 date-time with an offset, e.g. 2026-10-12T19:07:29-07:00');
    }
    str(doc.headline, 'headline', LIMITS.headline);
    if (!Array.isArray(doc.insights) || doc.insights.length < 1 || doc.insights.length > LIMITS.items) {
      errors.push(`insights: must be an array of 1–${LIMITS.items} items`);
    } else {
      doc.insights.forEach((it, i) => {
        const p = `insights[${i}].`;
        if (!isObj(it)) { errors.push(`insights[${i}]: must be an object`); return; }
        unknown(it, ITEM_KEYS, p);
        str(it.title, p + 'title', LIMITS.title);
        str(it.evidence, p + 'evidence', LIMITS.evidence);
        str(it.why_it_matters, p + 'why_it_matters', LIMITS.why);
        str(it.recommended_play, p + 'recommended_play', LIMITS.play);
        str(it.owner, p + 'owner', LIMITS.owner);
        if (!CONFIDENCE.includes(it.confidence)) errors.push(`${p}confidence: must be one of ${CONFIDENCE.join(', ')}`);
        if (it.citations !== undefined) {
          if (!Array.isArray(it.citations) || it.citations.length > LIMITS.citations) errors.push(`${p}citations: must be an array of at most ${LIMITS.citations} strings`);
          else it.citations.forEach((c, j) => str(c, `${p}citations[${j}]`, LIMITS.citation));
        }
      });
    }
    if (!Array.isArray(doc.data_quality_flags) || doc.data_quality_flags.length > LIMITS.flags) {
      errors.push(`data_quality_flags: must be an array of at most ${LIMITS.flags} entries`);
    } else {
      doc.data_quality_flags.forEach((f, i) => {
        const p = `data_quality_flags[${i}]`;
        if (typeof f === 'string') str(f, p, LIMITS.flag);
        else if (isObj(f) && Object.keys(f).length && Object.values(f).every(isPrim)) {
          if (flagText(f).length > LIMITS.flag) errors.push(`${p}: longer than ${LIMITS.flag} characters`);
        } else errors.push(`${p}: must be a string or an object of string/number/boolean values`);
      });
    }
    const ch = doc.changed_since_last;
    if (typeof ch === 'string') str(ch, 'changed_since_last', LIMITS.change);
    else if (Array.isArray(ch) && ch.length <= LIMITS.changes) ch.forEach((c, i) => str(c, `changed_since_last[${i}]`, LIMITS.change));
    else errors.push(`changed_since_last: must be a string or an array of at most ${LIMITS.changes} strings`);
    return { ok: errors.length === 0, errors };
  }

  // An object flag is shown as "key: value · key: value" (text only).
  function flagText(f) {
    return typeof f === 'string' ? f : Object.entries(f).map(([k, v]) => `${k}: ${v == null ? '—' : String(v)}`).join(' · ');
  }

  // Parse and validate raw text; size is checked before parsing.
  function parse(text) {
    if (typeof text !== 'string') return { ok: false, errors: ['not text'] };
    if (text.length > LIMITS.fileBytes) return { ok: false, errors: [`file larger than ${LIMITS.fileBytes} bytes`] };
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return { ok: false, errors: ['not valid JSON: ' + e.message] }; }
    const r = validate(doc);
    return r.ok ? { ok: true, errors: [], doc } : r;
  }

  const api = { validate, parse, flagText, LIMITS, CONFIDENCE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GtmInsights = api;
})(typeof window !== 'undefined' ? window : this);
