// Validator for the lost-reasons file (/lost-reasons.json) written by the
// Strategy seat, plus the categorizer the "Why … deals were lost" panel uses:
// every closed-lost deal of the headline pipeline lands in exactly one of six
// categories, from the file's entry for that deal or, failing that, from
// keyword rules on HubSpot's closed_lost_reason. One copy for the browser
// (window.GtmLostReasons) and Node (require), so the page and
// workspace/refresh/publish-lost-reasons.mjs accept exactly the same files.
// The shape is documented in docs/lost-reasons-schema.md and
// docs/lost-reasons.schema.json.
(function (root) {
  'use strict';

  const LIMITS = { fileBytes: 2097152, deals: 2000, dealId: 100, competitor: 100, basis: 500, competitors: 50 };
  // Display order is fixed.
  const CATEGORIES = [
    { key: 'went_dark', label: 'Went dark / no response' },
    { key: 'competitor', label: 'Chose a competitor' },
    { key: 'not_a_fit', label: 'Not a fit / disqualified' },
    { key: 'no_budget_timing', label: 'No budget or timing' },
    { key: 'status_quo', label: 'Stayed with the status quo' },
    { key: 'unknown', label: 'Unknown' },
  ];
  const KEYS = CATEGORIES.map((c) => c.key);
  const TOP_KEYS = ['generated_at', 'deals', 'competitors'];
  const ENTRY_KEYS = ['deal_id', 'category', 'competitor', 'inferred', 'basis'];
  // ISO 8601 date-time with seconds and an explicit offset (Z or ±hh:mm).
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
  const DEAL_ID = /^[A-Za-z0-9_-]{1,100}$/;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // GTM_DATA deal ids carry a "deal-" prefix (lib/project.mjs dealKey); the file uses HubSpot's bare id (either form is accepted).
  const dealKey = (id) => 'deal-' + String(id).replace(/^deal-/, '');

  function validate(doc) {
    const errors = [];
    const str = (v, path, max) => {
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
    if (!Array.isArray(doc.deals) || doc.deals.length > LIMITS.deals) {
      errors.push(`deals: must be an array of at most ${LIMITS.deals} items`);
    } else {
      const seen = new Map();
      doc.deals.forEach((e, i) => {
        const p = `deals[${i}].`;
        if (!isObj(e)) { errors.push(`deals[${i}]: must be an object`); return; }
        unknown(e, ENTRY_KEYS, p);
        if (typeof e.deal_id !== 'string' || !DEAL_ID.test(e.deal_id)) errors.push(`${p}deal_id: must be 1–${LIMITS.dealId} letters, digits, "-" or "_"`);
        else if (seen.has(dealKey(e.deal_id))) errors.push(`${p}deal_id: ${e.deal_id} is already in deals[${seen.get(dealKey(e.deal_id))}]`);
        else seen.set(dealKey(e.deal_id), i);
        if (!KEYS.includes(e.category)) errors.push(`${p}category: must be one of ${KEYS.join(', ')}`);
        // The competitor's name is optional (unnamed when absent or null), and only allowed on competitor entries.
        if (e.competitor != null) {
          if (e.category === 'competitor') str(e.competitor, p + 'competitor', LIMITS.competitor);
          else errors.push(`${p}competitor: must be null or absent unless category is competitor`);
        }
        if (typeof e.inferred !== 'boolean') errors.push(`${p}inferred: must be true or false`);
        str(e.basis, p + 'basis', LIMITS.basis);
      });
    }
    if (doc.competitors !== undefined) {
      if (!Array.isArray(doc.competitors) || doc.competitors.length > LIMITS.competitors) errors.push(`competitors: must be an array of at most ${LIMITS.competitors} strings`);
      else doc.competitors.forEach((c, i) => str(c, `competitors[${i}]`, LIMITS.competitor));
    }
    return { ok: errors.length === 0, errors };
  }

  const byteLength = (s) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : s.length);

  // Parse and validate raw text; size (UTF-8 bytes) is checked before parsing.
  function parse(text) {
    if (typeof text !== 'string') return { ok: false, errors: ['not text'] };
    if (byteLength(text) > LIMITS.fileBytes) return { ok: false, errors: [`file larger than ${LIMITS.fileBytes} bytes`] };
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return { ok: false, errors: ['not valid JSON: ' + e.message] }; }
    const r = validate(doc);
    return r.ok ? { ok: true, errors: [], doc } : r;
  }

  // ---------- fallback: keyword rules on the HubSpot reason ----------
  // Case-insensitive; a keyword matches at the start of a word, and "dark" and
  // "later" only as whole words. First match wins, in this order (after blank /
  // "na" / "n/a", then a competitor named in the file's competitors list):
  // a stated alternative (status quo, then a generic competitor phrase) beats a
  // disqualification, which beats budget or timing; "went dark" describes how a
  // deal ended rather than why, so it only applies when nothing else does.
  const RULES = [
    { category: 'status_quo', re: /\b(?:status quo|in-house|in house|no change)/i },
    { category: 'competitor', re: /\b(?:competitor|went with|chose another|selected another vendor)/i },
    { category: 'not_a_fit', re: /\b(?:irrelevant|not a fit|disqualif)/i },
    { category: 'no_budget_timing', re: /\b(?:budget|timing|later\b|next year)/i },
    { category: 'went_dark', re: /\b(?:ghost|no response|unresponsive|dark\b)/i },
  ];

  const WORD = /[\p{L}\p{N}_]/u;
  // Lower-case without changing length, so match offsets stay valid.
  const fold = (s) => Array.from(s, (c) => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join('');
  // Whole-word, case-insensitive: the term must not continue into a neighbouring letter or digit.
  function mentions(text, term) {
    const t = fold(String(term).trim().replace(/\s+/g, ' '));
    const hay = fold(text);
    if (!t) return false;
    const edgeL = WORD.test(t[0]), edgeR = WORD.test(t[t.length - 1]);
    for (let i = hay.indexOf(t); i !== -1; i = hay.indexOf(t, i + 1)) {
      const j = i + t.length;
      if (edgeL && i > 0 && WORD.test(hay[i - 1])) continue;
      if (edgeR && j < hay.length && WORD.test(hay[j])) continue;
      return true;
    }
    return false;
  }

  // { category, competitor } for one raw reason; competitors: names from a valid file (longest is tried first).
  function classify(reason, competitors) {
    const r = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '';
    if (!r || /^n\/?a$/i.test(r)) return { category: 'unknown', competitor: null };
    const names = arr(competitors).filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()).sort((a, b) => b.length - a.length);
    const named = names.find((c) => mentions(r, c));
    if (named) return { category: 'competitor', competitor: named };
    for (const x of RULES) if (x.re.test(r)) return { category: x.category, competitor: null };
    return { category: 'unknown', competitor: null };
  }

  // ---------- the panel's rows ----------
  // Every closed-lost deal of the headline pipeline (the set closedLost counts),
  // each in exactly one category. doc: a validated file, or null for rules only.
  // A file entry decides its deal (source 'inferred' or 'file'); other deals are
  // auto-mapped (source 'auto'). Entries for other deals are ignored. Competitor
  // rows count named competitors (grouped case-insensitively) and unnamed ones.
  function categorize(data, doc) {
    const d = data || {};
    const cl = d.closedLost;
    if (!cl) return null;
    const lost = arr(d.deals).filter((x) => x && x.lost && x.pipeline === cl.pipeline);
    const entries = new Map(arr(doc && doc.deals).map((e) => [dealKey(e.deal_id), e]));
    const names = arr(doc && doc.competitors);
    const rows = CATEGORIES.map((c) => ({ key: c.key, label: c.label, count: 0, amount: null, noAmount: 0, deals: [], competitors: [], unnamed: 0 }));
    const rowOf = new Map(rows.map((r) => [r.key, r]));
    let fromFile = 0;
    for (const x of lost) {
      const e = entries.get(x.id);
      const c = e ? { category: e.category, competitor: e.category === 'competitor' && e.competitor ? e.competitor.trim() : null } : classify(x.lostReason, names);
      if (e) fromFile++;
      rowOf.get(c.category).deals.push({
        id: x.id, name: x.name, amount: num(x.amount), reason: typeof x.lostReason === 'string' && x.lostReason ? x.lostReason : null,
        competitor: c.competitor, source: e ? (e.inferred ? 'inferred' : 'file') : 'auto', basis: e ? e.basis : null,
      });
    }
    for (const r of rows) {
      const priced = r.deals.filter((x) => x.amount != null);
      r.count = r.deals.length;
      r.amount = priced.length ? Math.round(priced.reduce((a, x) => a + x.amount, 0) * 100) / 100 : null;
      r.noAmount = r.count - priced.length;
      r.deals.sort((a, b) => (a.amount == null) - (b.amount == null) || (b.amount ?? 0) - (a.amount ?? 0) || String(a.name).localeCompare(String(b.name)));
      // Competitor names, grouped case-insensitively under the most common spelling.
      const by = new Map();
      for (const x of r.deals) {
        if (!x.competitor) { if (r.key === 'competitor') r.unnamed++; continue; }
        const k = fold(x.competitor);
        if (!by.has(k)) by.set(k, { count: 0, spellings: new Map() });
        const g = by.get(k);
        g.count++;
        g.spellings.set(x.competitor, (g.spellings.get(x.competitor) || 0) + 1);
      }
      r.competitors = [...by.values()].map((g) => ({ name: [...g.spellings].sort((a, b) => b[1] - a[1])[0][0], count: g.count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }
    return { pipeline: cl.pipeline, count: lost.length, rows, fromFile, auto: lost.length - fromFile };
  }

  const api = { validate, parse, classify, categorize, dealKey, LIMITS, CATEGORIES, RULES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GtmLostReasons = api;
})(typeof window !== 'undefined' ? window : this);
