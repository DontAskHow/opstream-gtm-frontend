// Validator for the Analysis file (/insights.json) written by the Strategy seat,
// plus the pure helpers the Analysis panel uses: the page metrics a goal can
// track and the matcher that finds deals, accounts, stages, metrics and panels
// named in insight text. One copy for the browser (window.GtmInsights) and Node
// (require), so the page and workspace/refresh/publish-insights.mjs accept
// exactly the same files. The shape is documented in docs/insights-schema.md
// and docs/insights.schema.json.
(function (root) {
  'use strict';

  const LIMITS = {
    fileBytes: 262144, headline: 400, items: 20, title: 200, evidence: 2000, why: 1200, play: 1200,
    owner: 300, citations: 20, citation: 1000, flags: 50, flag: 1000, changes: 50, change: 2000,
    goals: 12, goalLabel: 200, goalNote: 400,
  };
  const CONFIDENCE = ['low', 'medium', 'high'];
  const TOP_KEYS = ['generated_at', 'headline', 'insights', 'data_quality_flags', 'changed_since_last', 'goals'];
  const ITEM_KEYS = ['title', 'evidence', 'citations', 'why_it_matters', 'recommended_play', 'owner', 'confidence'];
  const GOAL_KEYS = ['metric', 'target', 'label', 'by', 'note'];
  const TZ = 'America/Phoenix';

  // Page metrics a goal can track (goals[].metric), each computed from
  // GTM_DATA the way the overview shows it (metricValues). tile: the headline
  // tile it appears on; panel: the overview panel that shows it otherwise.
  // better: whether a goal is met at or above the target (up) or at or below it (down).
  const METRICS = {
    open_count: { label: 'Open deals', format: 'int', better: 'up', tile: 'Open deals' },
    open_amount: { label: 'Open amount', format: 'money', better: 'up', tile: 'Open amount' },
    weighted: { label: 'Weighted', format: 'money', better: 'up', tile: 'Weighted' },
    on_hold_count: { label: 'On Hold deals', format: 'int', better: 'down', tile: 'On Hold (separate)' },
    on_hold_amount: { label: 'On Hold amount', format: 'money', better: 'down', tile: 'On Hold (separate)' },
    closed_lost_count: { label: 'Closed lost', format: 'int', better: 'down', tile: 'Closed lost', panel: 'lost' },
    closed_won_count: { label: 'Closed won', format: 'int', better: 'up' },
    closed_won_amount: { label: 'Closed-won amount', format: 'money', better: 'up' },
    meetings_this_month: { label: 'Meetings this month', format: 'int', better: 'up', panel: 'meetings' },
    meetings_upcoming: { label: 'Upcoming meetings', format: 'int', better: 'up', panel: 'meetings' },
  };
  const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
  const validDay = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  };
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
    if (doc.goals !== undefined) {
      if (!Array.isArray(doc.goals) || doc.goals.length > LIMITS.goals) errors.push(`goals: must be an array of at most ${LIMITS.goals} items`);
      else doc.goals.forEach((g, i) => {
        const p = `goals[${i}].`;
        if (!isObj(g)) { errors.push(`goals[${i}]: must be an object`); return; }
        unknown(g, GOAL_KEYS, p);
        if (!has(METRICS, g.metric)) errors.push(`${p}metric: must be one of ${Object.keys(METRICS).join(', ')}`);
        if (typeof g.target !== 'number' || !Number.isFinite(g.target) || g.target < 0) errors.push(`${p}target: must be a number ≥ 0`);
        str(g.label, p + 'label', LIMITS.goalLabel);
        if (g.by !== undefined && !validDay(g.by)) errors.push(`${p}by: must be a calendar date YYYY-MM-DD`);
        str(g.note, p + 'note', LIMITS.goalNote, false);
      });
    }
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

  // ---------- page metrics and goals ----------
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const headPipe = (d) => (d.headline && d.headline.pipeline) || (arr(d.pipelines)[0] || {}).label || null;
  // A total over deals that all lack an amount is unknown, not 0 (as on the tiles).
  const total = (t, key) => (!t ? null : t.count > 0 && t.noAmountCount === t.count ? null : num(t[key]));

  // Current value of every METRICS key from GTM_DATA; null when the data can't say.
  function metricValues(data, now = new Date(), tz = TZ) {
    const d = data || {};
    const h = d.headline || null;
    const out = Object.fromEntries(Object.keys(METRICS).map((k) => [k, null]));
    if (h) {
      out.open_count = num(h.active && h.active.count);
      out.open_amount = total(h.active, 'openAmount');
      out.weighted = total(h.active, 'weighted');
      out.on_hold_count = num(h.onHold && h.onHold.count);
      out.on_hold_amount = total(h.onHold, 'openAmount');
    }
    if (d.closedLost) out.closed_lost_count = num(d.closedLost.count);
    if (h && d.pipelineSource === 'hubspot') {
      const won = arr(d.deals).filter((x) => x && x.won && x.pipeline === h.pipeline);
      const priced = won.filter((x) => num(x.amount) != null);
      out.closed_won_count = won.length;
      out.closed_won_amount = !won.length ? 0 : priced.length ? priced.reduce((a, x) => a + x.amount, 0) : null;
    }
    // One entry per meeting id (a meeting can sit on several accounts), as in the meetings panel.
    const starts = new Map();
    for (const c of arr(d.companies)) for (const m of arr(c && c.meetings)) if (m && m.id && m.start && !starts.has(m.id)) starts.set(m.id, m.start);
    const ymFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' });
    const ym = (t) => ymFmt.format(t);
    const month = ym(now);
    let thisMonth = 0, upcoming = 0;
    for (const s of starts.values()) {
      const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
      if (Number.isNaN(t.getTime())) continue;
      if (ym(t) === month) thisMonth++;
      if (t.getTime() >= now.getTime()) upcoming++;
    }
    if (Array.isArray(d.companies)) { out.meetings_this_month = thisMonth; out.meetings_upcoming = upcoming; }
    return out;
  }

  // Progress of one goal: ratio is the bar fill (0–1); over means a down goal
  // is past its limit. met is null when the current value is unknown.
  function goalProgress(goal, value) {
    const m = METRICS[goal && goal.metric];
    if (!m || num(value) == null) return { value: null, ratio: 0, met: null, over: false };
    const t = goal.target;
    const ratio = t > 0 ? Math.max(0, Math.min(1, value / t)) : value > 0 || m.better === 'up' ? 1 : 0;
    const met = m.better === 'down' ? value <= t : value >= t;
    return { value, ratio, met, over: m.better === 'down' && value > t };
  }

  // ---------- references in insight text ----------
  // Generic page vocabulary (never data): phrases that name a headline metric
  // or an overview panel. Panels are found on the page by their title.
  const METRIC_TERMS = {
    open_count: ['open deals', 'open deal count', 'active deals', 'deal count', 'headline.active.count'],
    open_amount: ['open amount', 'open pipeline', 'open value', 'pipeline value', 'headline.active.openAmount'],
    weighted: ['weighted', 'weighted pipeline', 'weighted amount', 'weighted value', 'headline.active.weighted'],
    on_hold_count: ['on hold', 'on-hold', 'headline.onHold.count'],
    on_hold_amount: ['on hold amount', 'on-hold amount', 'on hold value', 'on-hold value', 'headline.onHold.openAmount'],
    closed_lost_count: ['closed lost', 'closed-lost', 'lost deals', 'closedLost.count'],
    closed_won_count: ['closed won', 'closed-won', 'won deals'],
    closed_won_amount: ['closed won amount', 'closed-won amount', 'won amount'],
    meetings_this_month: ['meetings this month'],
  };
  const PANELS = {
    headline: { title: /^New-business pipeline$/, terms: ['new-business pipeline', 'new business pipeline'] },
    brief: { title: /^This week$/, terms: ['weekly brief', 'agent brief', 'top actions', 'watch-outs', 'watch outs'] },
    upcoming: { title: /^Upcoming meetings$/, terms: ['upcoming meetings', 'prep brief', 'meeting prep'] },
    pipelines: { title: /^All pipelines$/, terms: ['all pipelines'] },
    lost: { title: /^Why .+ deals were lost$/, terms: ['lost reasons', 'lost reason', 'loss reasons', 'closed lost reasons', 'closed-lost reasons'] },
    stages: { title: /open pipeline by stage$/, terms: ['open pipeline by stage', 'pipeline by stage', 'by stage', 'stage funnel', 'funnel'] },
    closeMonth: { title: /^Open value by close month$/, terms: ['close month', 'close months', 'by close month', 'close date', 'close dates', 'close-date'] },
    meetings: { title: /^Meetings over time$/, terms: ['meetings over time', 'meetings per month'] },
  };
  // Single words that start sentences too often to be read as a name.
  const STOP = new Set(['the', 'this', 'that', 'these', 'those', 'next', 'new', 'open', 'closed', 'won', 'lost', 'hold', 'data',
    'deal', 'deals', 'pipeline', 'meeting', 'meetings', 'demo', 'sales', 'renewal', 'partner', 'partners', 'customer',
    'customers', 'account', 'accounts', 'company', 'none', 'other', 'unknown', 'team', 'owner', 'total', 'weighted']);
  const LEGAL = /[\s,]+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|plc|s\.?a|ag|b\.?v|pty|llp)\.?$/i;
  const WORD = /[\p{L}\p{N}_]/u;
  // Lower-case without changing length, so match offsets stay valid.
  const fold = (s) => Array.from(s, (c) => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join('');
  const refKey = (r) => `${r.kind}:${r.id ?? r.key ?? r.stage ?? r.pipe}`;

  // Every term the matcher looks for, longest first. Names come from the data;
  // a one-word name or stage matches case-sensitively, anything longer does not.
  // A term that would point at two different things at the same priority is dropped.
  // opts.money: formatters whose output for a money metric's value also cites it.
  function refIndex(data, opts = {}) {
    const d = data || {};
    const best = new Map();
    const add = (term, ref, prio, cs) => {
      const t = String(term == null ? '' : term).trim().replace(/\s+/g, ' ');
      if (t.length < 3) return;
      const k = fold(t);
      const cur = best.get(k);
      const e = { t, f: k, cs: cs == null ? !/\s/.test(t) : cs, ref, prio, amb: false };
      if (!cur || prio > cur.prio) best.set(k, e);
      else if (prio === cur.prio && refKey(cur.ref) !== refKey(ref)) cur.amb = true;
    };
    const name = (n, ref, prio, aliases) => {
      if (typeof n !== 'string' || /^company not named$/i.test(n.trim())) return;
      const forms = [n.trim()];
      let a = forms[0];
      for (let i = 0; aliases && i < 2; i++) { const s = a.replace(LEGAL, '').trim(); if (s === a) break; a = s; if (a.length >= 4) forms.push(a); }
      for (const f of forms) if (!STOP.has(f.toLowerCase())) add(f, ref, prio);
    };
    for (const c of arr(d.companies)) if (c && c.id != null) name(c.name, { kind: 'account', id: String(c.id), label: c.name }, 4, true);
    for (const x of arr(d.deals)) if (x && x.id != null) name(x.name, { kind: 'deal', id: String(x.id), label: x.name }, 3, false);
    const head = headPipe(d);
    for (const p of arr(d.pipelines)) {
      if (!p || !p.label) continue;
      add(p.label, p.label === head ? { kind: 'panel', key: 'headline' } : { kind: 'pipeline', pipe: p.label, label: p.label }, 3);
    }
    // Stages of the headline pipeline: open ones filter the pipeline view; On Hold,
    // lost and won stages point at the metric that counts them.
    for (const x of arr(d.deals)) {
      if (!x || x.pipeline !== head || !x.stage) continue;
      const ref = x.lost ? { kind: 'metric', key: 'closed_lost_count' } : x.won ? { kind: 'metric', key: 'closed_won_count' }
        : x.open && x.onHold ? { kind: 'metric', key: 'on_hold_count' } : x.open ? { kind: 'stage', stage: x.stage, label: x.stage } : null;
      if (ref) add(x.stage, ref, 2);
    }
    for (const [key, terms] of Object.entries(METRIC_TERMS)) for (const t of terms) add(t, { kind: 'metric', key }, 1, /\./.test(t));
    for (const [key, p] of Object.entries(PANELS)) for (const t of p.terms) add(t, { kind: 'panel', key }, 1, false);
    const values = metricValues(d, opts.now);
    for (const [key, m] of Object.entries(METRICS)) {
      if (m.format !== 'money' || !values[key]) continue;
      for (const fmt of arr(opts.money)) add(fmt(values[key]), { kind: 'metric', key }, 5, true);
    }
    const terms = [...best.values()].filter((e) => !e.amb).sort((a, b) => b.t.length - a.t.length || b.prio - a.prio);
    return { terms };
  }

  // Non-overlapping references in text, in order: { start, end, text, ref }.
  // Longer terms win; a term must not continue into a neighbouring letter or digit.
  function findRefs(text, index) {
    if (typeof text !== 'string' || !text || !index) return [];
    const folded = fold(text);
    const taken = new Uint8Array(text.length);
    const out = [];
    for (const e of index.terms) {
      const hay = e.cs ? text : folded;
      const needle = e.cs ? e.t : e.f;
      const edgeL = WORD.test(needle[0]), edgeR = WORD.test(needle[needle.length - 1]);
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
        const j = i + needle.length;
        if (edgeL && i > 0 && WORD.test(text[i - 1])) continue;
        if (edgeR && j < text.length && WORD.test(text[j])) continue;
        if (taken.subarray(i, j).some(Boolean)) continue;
        taken.fill(1, i, j);
        out.push({ start: i, end: j, text: text.slice(i, j), ref: e.ref });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  const api = { validate, parse, flagText, LIMITS, CONFIDENCE, METRICS, PANELS, metricValues, goalProgress, refIndex, findRefs, refKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GtmInsights = api;
})(typeof window !== 'undefined' ? window : this);
