// The page's view model: workspace.json (scripts/workspace-data.py) plus the
// lost-reason categories and the validated Analysis file. One copy for Node
// (onepage/build.mjs, tests) and the browser (inlined; window.GtmView), so a page
// that fetches /workspace.json shows exactly what a built page shows.
(function (root) {
  'use strict';

  const libs = () => (typeof module === 'object' && module.exports
    ? { lost: require('../workspace/src/lost-reasons.js'), insights: require('../workspace/src/insights.js'), sources: require('../config/freshness-sources.json') }
    : { lost: root.GtmLostReasons, insights: root.GtmInsights, sources: root.GtmFreshnessSources });
  const SALES = 'default';
  const TZ = 'America/Phoenix';
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const pt = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '—' : fmt.format(t) + ' PT'; };

  // Lost reasons: lost-reasons.json decides the deals it lists; HubSpot's reason
  // auto-maps the rest (workspace/src/lost-reasons.js, the one categorizer).
  function lostView(closed, lostReasons) {
    const doc = closed.reasonsDoc;
    const checked = doc ? lostReasons.validate(doc) : null;
    const valid = checked && checked.ok ? doc : null;
    // New business only: a loss created after the company's first win is an expansion at a customer.
    const deals = closed.lost.filter((d) => !d.postWin).map((d) => ({ id: lostReasons.dealKey(d.id), lost: true, pipeline: SALES, name: d.name, amount: d.amount, lostReason: d.lostReason }));
    const cat = lostReasons.categorize({ closedLost: { pipeline: SALES }, deals }, valid);
    const stageOf = Object.fromEntries(closed.lost.map((d) => [d.id, d.stage]));
    const rows = cat.rows.map((r) => ({
      key: r.key, label: r.label, count: r.count, amount: r.amount, competitors: r.competitors, unnamed: r.unnamed,
      byStage: r.deals.reduce((a, d) => { const st = stageOf[d.id.replace(/^deal-/, '')]; a[st] = (a[st] || 0) + 1; return a; }, {}),
      deals: r.deals.map((d) => ({ ...d, id: d.id.replace(/^deal-/, ''), stage: stageOf[d.id.replace(/^deal-/, '')] })),
    }));
    const basis = !doc ? 'No lost-reasons.json given: every deal is auto-mapped from HubSpot\'s lost reason.'
      : !valid ? `lost-reasons.json did not pass validation (${checked.errors[0]}), so every deal is auto-mapped from HubSpot's lost reason.`
        : `${cat.fromFile} of ${cat.count} deals categorized by lost-reasons.json (generated ${pt(doc.generated_at)}); ${cat.auto} auto-mapped from HubSpot's lost reason.`;
    return { rows, basis, fromFile: cat.fromFile, count: cat.count };
  }

  function insightsView(doc, insights) {
    if (!doc) return null;
    const r = insights.validate(doc);
    return r.ok ? { ok: true, errors: [], doc } : { ok: false, errors: r.errors || ['invalid'], doc: null };
  }

  // refresh.json (written by the preview refresh Lambda every run) carries the newest
  // timestamps of a workspace.json whose content is unchanged, so the page's "Updated" time
  // stays current without re-uploading the file (workspace/refresh/workspace-json.mjs). They
  // apply only to the exact file they were recorded for: textSha256 is the sha256 of the text
  // the page fetched, and must equal stamps.forTextSha256.
  function applyStamps(data, refresh, textSha256) {
    const w = refresh && refresh.workspace;
    const s = w && w.stamps;
    if (!s || !s.forTextSha256 || !textSha256 || s.forTextSha256 !== textSha256) return data;
    if (s.generatedAt) data.meta.generatedAt = s.generatedAt;
    if (s.hubspotFetchedAt) data.meta.hubspot = { ...(data.meta.hubspot || {}), fetchedAt: s.hubspotFetchedAt };
    if (Array.isArray(s.freshness) && Array.isArray(data.freshness)) {
      const by = Object.fromEntries(s.freshness.map((f) => [f.source, f]));
      data.freshness = data.freshness.map((f) => (by[f.source] ? { ...f, ...by[f.source] } : f));
    }
    return data;
  }

  // Freshness chips (config/freshness-sources.json): one per listed source, in config order.
  // Internal sync steps roll up into their parent: a failing child turns an ok parent amber
  // ('warn') and is named in the chip's tooltip; a failing parent is red ('alert'). Unlisted
  // rows named '<parent>_…' roll up too; any other unlisted row shows only while it fails.
  function freshnessChips(rows, cfg) {
    const list = (cfg && cfg.sources) || [];
    const parentOf = {};
    for (const p of list) for (const c of Object.keys(p.children || {})) parentOf[c] = p.source;
    const listed = new Set(list.map((p) => p.source));
    const byParent = {};
    const out = [];
    for (const r of rows || []) {
      if (listed.has(r.source)) continue;
      const parent = parentOf[r.source] || list.map((p) => p.source).find((p) => r.source.startsWith(p + '_'));
      if (parent) (byParent[parent] = byParent[parent] || []).push(r);
      else if (!r.ok) out.push({ ...r, level: 'alert', failing: [] });
    }
    const chips = [];
    for (const p of list) {
      const own = (rows || []).find((r) => r.source === p.source);
      const kids = byParent[p.source] || [];
      if (!own && !kids.length) continue;
      const failing = kids.filter((k) => !k.ok).map((k) => ({ source: k.source, label: (p.children || {})[k.source] || k.label || k.source, at: k.at ?? null, lastOkAt: k.lastOkAt ?? null, detail: k.detail ?? null }));
      // A parent with no row of its own stands for its children: ok only if all are, last good the oldest.
      const base = own || { source: p.source, ok: kids.every((k) => k.ok), at: null, detail: null,
        lastOkAt: kids.map((k) => k.lastOkAt).filter(Boolean).sort()[0] || null };
      chips.push({ ...base, label: p.label, level: !base.ok ? 'alert' : failing.length ? 'warn' : 'ok', failing });
    }
    return chips.concat(out);
  }

  // The view model the page renders.
  function buildView(data, refresh, textSha256) {
    const { lost, insights, sources } = libs();
    const v = applyStamps(structuredClone(data), refresh, textSha256);
    v.freshness = freshnessChips(v.freshness, sources);
    v.meta.asOf = v.meta.asOf || v.meta.generatedAt;
    v.closed.reasons = v.closed.lost.length ? lostView(v.closed, lost) : null;
    const cat = {};
    for (const r of (v.closed.reasons && v.closed.reasons.rows) || []) for (const d of r.deals) cat[d.id] = { label: r.label, basis: d.basis };
    for (const d of v.closed.lost) if (cat[d.id]) { d.lostCategory = cat[d.id].label; d.lostBasis = cat[d.id].basis; }
    delete v.closed.reasonsDoc;
    v.insights = insightsView(v.insights, insights);
    const c = v.headline.change;
    if (c) c.key = `chg:${c.since}:${c.to.count}:${c.to.amount}`;
    const w = refresh && refresh.workspace;
    v.live = w ? { status: w.status || null, problem: w.problem || null, checkedAt: refresh.refreshedAt || null, publishedGeneratedAt: w.publishedGeneratedAt || null } : null;
    return v;
  }

  const api = { buildView, applyStamps, freshnessChips };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GtmView = api;
})(typeof window !== 'undefined' ? window : this);
