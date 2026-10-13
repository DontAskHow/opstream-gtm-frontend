// The page's view model: workspace.json (scripts/workspace-data.py) plus the
// lost-reason categories and the validated Analysis file. One copy for Node
// (onepage/build.mjs, tests) and the browser (inlined; window.GtmView), so a page
// that fetches /workspace.json shows exactly what a built page shows.
(function (root) {
  'use strict';

  const libs = () => (typeof module === 'object' && module.exports
    ? { lost: require('../workspace/src/lost-reasons.js'), insights: require('../workspace/src/insights.js') }
    : { lost: root.GtmLostReasons, insights: root.GtmInsights });
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

  // The view model the page renders.
  function buildView(data, refresh, textSha256) {
    const { lost, insights } = libs();
    const v = applyStamps(structuredClone(data), refresh, textSha256);
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

  const api = { buildView, applyStamps };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GtmView = api;
})(typeof window !== 'undefined' ? window : this);
