// GTM workspace app. Reads window.GTM_DATA (written by build.mjs, or by the
// scheduled refresh in workspace/refresh) and renders hash-routed views. The
// only network calls are two same-origin, no-store reads: refresh.json (when
// the data was last checked) and insights.json (the Analysis panel). Both are
// optional; from file:// they fail and the page says so.
(function () {
  'use strict';

  const D = window.GTM_DATA || {};
  const Charts = window.GtmCharts;
  const TZ = 'America/Phoenix';
  const TZ_LABEL = 'PT';
  const DASH = '—';
  const S1 = 'var(--s1)', S2 = 'var(--s2)', S3 = 'var(--s3)';
  const PREP_WINDOW_DAYS = 14;
  const SAFE_ID = /^[A-Za-z0-9_-]+$/;

  // ---------- indexes ----------
  const companies = D.companies || [];
  const deals = D.deals || [];
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const transcriptIds = new Set(D.transcripts || []);
  const times = D.times || {};
  // Set by the scheduled refresh (workspace/refresh); absent in a local build.
  const R = D.refresh || null;
  const sourceStatus = new Map((D.sources || []).map((s) => [s.source, s]));
  const fromHubspot = D.pipelineSource === 'hubspot';
  const pipelines = D.pipelines || [];
  const figures = D.figures || [];
  const pipelineByLabel = new Map(pipelines.map((p) => [p.label, p]));
  const defaultPipe = (D.headline && D.headline.pipeline) || (pipelines[0] && pipelines[0].label) || '';
  // Pipeline panels carry one compact "Updated" tag: the HubSpot export time.
  const pipeUpdated = () => (fromHubspot ? times.recon : [[null, times.records, isStale('hubspot')]]);

  // One entry per meeting id; a meeting can be linked to several accounts.
  const meetings = (() => {
    const map = new Map();
    for (const c of companies) {
      for (const m of c.meetings) {
        if (!m.id || !m.start) continue;
        let e = map.get(m.id);
        if (!e) map.set(m.id, (e = { ...m, companyIds: [] }));
        e.companyIds.push(c.id);
      }
    }
    return [...map.values()];
  })();

  // ---------- formatting ----------
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const text = (v) => (v == null || v === '' ? DASH : esc(v));
  const int = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : DASH);
  const pct = (n, d) => (isNum(n) && isNum(d) && d > 0 ? `${((n / d) * 100).toFixed(1)}%` : DASH);

  function money(v) {
    if (!isNum(v)) return DASH;
    const sign = v < 0 ? '-' : '';
    const n = Math.abs(v);
    const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    if (n >= 1e6) return `${sign}$${trim((n / 1e6).toFixed(2))}M`;
    if (n >= 1e3) return `${sign}$${trim((n / 1e3).toFixed(n >= 1e5 ? 0 : 1))}K`;
    return `${sign}$${Math.round(n).toLocaleString('en-US')}`;
  }
  const moneyFull = (v) => (isNum(v) ? `$${Math.round(v).toLocaleString('en-US')}` : DASH);

  const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const ymdInTz = (date) => ymdFmt.format(date);
  const todayYmd = () => ymdInTz(new Date());
  const isPlainDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  // Calendar dates (deal close etc.) carry no time zone; timestamps render in PT.
  function fmtDay(v) {
    if (!v) return DASH;
    if (isPlainDate(v)) {
      const [y, m, d] = v.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return DASH;
    return `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)} ${TZ_LABEL}`;
  }
  function fmtUpdated(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return DASH;
    return `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)} ${TZ_LABEL}`;
  }
  const dayKey = (v) => (!v ? null : isPlainDate(v) ? v : (() => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : ymdInTz(d); })());
  const monthKey = (v) => (dayKey(v) || '').slice(0, 7) || null;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthShort = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ’${k.slice(2, 4)}`;
  const monthLong = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
  function monthRange(a, b) {
    const out = [];
    let [y, m] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    while (y < by || (y === by && m <= bm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }
  const monthEnd = (k) => { const [y, m] = k.split('-').map(Number); return `${k}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
  const titleCase = (s) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : s);
  // records.json lastContact can be a scheduled (future) meeting date; it is shown as recorded, flagged.
  const lastContactText = (v) => `${fmtDay(v)}${dayKey(v) && dayKey(v) > todayYmd() ? ' <span class="flag">future date in the data</span>' : ''}`;
  const plural = (n, one, many) => `${int(n)} ${n === 1 ? one : many || one + 's'}`;

  // Recording summaries use light markdown. Links keep their text only (the
  // app never links out); bold is kept. Everything else is escaped.
  function inlineMd(x) {
    const noLinks = String(x ?? '').replace(/\[([^\]]*)\]\((?:https?:\/\/|mailto:)[^)\s]*\)/g, '$1');
    return esc(noLinks).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function renderSummary(items) {
    let s = '';
    let inList = false;
    for (const it of items || []) {
      if (it.t === 'li') { if (!inList) { s += '<ul>'; inList = true; } s += `<li>${inlineMd(it.x)}</li>`; continue; }
      if (inList) { s += '</ul>'; inList = false; }
      if (it.t === 'h2') s += `<h4>${inlineMd(it.x)}</h4>`;
      else if (it.t === 'h3') s += `<h5>${inlineMd(it.x)}</h5>`;
      else s += `<p>${inlineMd(it.x)}</p>`;
    }
    return s + (inList ? '</ul>' : '');
  }

  // ---------- domain ----------
  // Probabilities are 0–1 fractions in GTM_DATA; shown as percents.
  const probText = (p) => (isNum(p) ? `${Math.round(p * 1000) / 10}%` : DASH);
  const weightedOf = (d) => (isNum(d.amount) && isNum(d.probability) ? d.amount * d.probability : null);
  const companyName = (id) => (companyById.get(id) || {}).name || DASH;

  // With the HubSpot export, stages follow HubSpot's stage probability (see
  // lib/project.mjs). Without it there is no stage metadata, so stages are
  // ordered by the median probability of their deals, then by name.
  const stageOrderFor = (pipe) => {
    const p = pipelineByLabel.get(pipe);
    if (fromHubspot && p) return p.stages.map((s) => s.label);
    const probs = new Map();
    for (const d of deals) {
      if (d.pipeline !== pipe) continue;
      if (!probs.has(d.stage)) probs.set(d.stage, []);
      if (isNum(d.probability)) probs.get(d.stage).push(d.probability);
    }
    const median = (a) => { if (!a.length) return Infinity; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
    return [...probs.entries()].map(([k, a]) => ({ k, p: median(a) })).sort((a, b) => a.p - b.p || a.k.localeCompare(b.k)).map((x) => x.k);
  };
  const stageRankFor = (pipe) => new Map(stageOrderFor(pipe).map((k, i) => [k, i]));

  const FILTER_KEYS = ['pipe', 'owner', 'stage', 'seg', 'from', 'to'];
  const getFilters = (q) => {
    const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, q.get(k) || '']));
    if (!pipelineByLabel.has(f.pipe)) f.pipe = defaultPipe;
    return f;
  };
  const hasFilters = (f) => FILTER_KEYS.some((k) => k !== 'pipe' && f[k]);
  function qs(f, extra) {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (f[k] && !(k === 'pipe' && f[k] === defaultPipe)) p.set(k, f[k]);
    for (const [k, v] of Object.entries(extra || {})) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }
  // Open deals in the selected pipeline. With no stage filter, On Hold is
  // left out (it is reported on its own line); filtering to On Hold shows it.
  const pipeOpen = (f) => deals.filter((d) => d.open && d.pipeline === f.pipe);
  const inScope = (f) => pipeOpen(f).filter((d) => (f.stage ? true : !d.onHold) && dealMatches(d, f));
  function dealMatches(d, f, ignoreStage) {
    if (f.owner && d.owner !== f.owner) return false;
    if (!ignoreStage && f.stage && d.stage !== f.stage) return false;
    if (f.seg && d.segment !== f.seg) return false;
    if (f.from || f.to) {
      const day = dayKey(d.close);
      if (!day) return false;
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
    }
    return true;
  }
  function meetingMatches(m, f) {
    if (f.owner && m.owner !== f.owner) return false;
    if (f.seg && !m.companyIds.some((id) => (companyById.get(id) || {}).segment === f.seg)) return false;
    return true;
  }
  // Zero opens on a campaign that sent mail means open tracking is off. With
  // nothing sent, 0 is just 0.
  const trackingOff = (c) => c.opened === 0 && c.sent > 0;
  const sumAmount = (list) => { const p = list.filter((d) => isNum(d.amount)); return p.length ? p.reduce((a, d) => a + d.amount, 0) : null; };

  // ---------- shared UI ----------
  function updatedTag(parts) {
    const list = (Array.isArray(parts) ? parts : [[null, parts]]).filter(Boolean);
    return list
      .map(([label, iso, stale, asOf]) => `<span class="updated${stale ? ' stale' : ''}">${label ? esc(label) + ' · ' : ''}${asOf ? 'as of' : 'Updated'} ${esc(fmtUpdated(iso))}</span>`)
      .join(' ');
  }
  function panel({ title, sub, updated, span = 12, body, cls = '' }) {
    return `<section class="panel span-${span} ${cls}"><div class="panel-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div><div>${updatedTag(updated)}</div></div>${body}</section>`;
  }
  const empty = (title, detail) => `<div class="empty"><strong>${esc(title)}</strong>${detail ? esc(detail) : ''}</div>`;
  function sourceWarning(key) {
    const s = sourceStatus.get(key);
    if (!s || s.ok) return '';
    return `<p class="note warn">${esc(s.label || key)} not syncing; last OK ${esc(fmtUpdated(s.lastOkAt))}.</p>`;
  }
  const isStale = (key) => { const s = sourceStatus.get(key); return !!(s && !s.ok); };
  const tile = (label, value, foot, cls = '') =>
    `<div class="tile ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`;
  const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  const accountLink = (id) => (companyById.has(id) ? `<a href="#/account/${encodeURIComponent(id)}">${esc(companyName(id))}</a>` : DASH);
  // Accounts known only from the HubSpot export (no records.json page) show as plain text.
  const dealAccount = (d) => (companyById.has(d.companyId) ? accountLink(d.companyId) : text(d.account));
  const dealLink = (d) => `<a href="#/deal/${encodeURIComponent(d.id)}">${text(d.name)}</a>`;

  // Chart rendering is deferred until containers exist so widths are real.
  let chartJobs = [];
  let chartSeq = 0;
  function chartSlot(fn) {
    const id = `chart-${++chartSeq}`;
    chartJobs.push({ id, fn });
    return `<div class="chart" id="${id}"></div>`;
  }
  function drawCharts() {
    for (const job of chartJobs) {
      const el = document.getElementById(job.id);
      if (el) el.innerHTML = job.fn(el.clientWidth);
    }
  }

  // ---------- sortable tables ----------
  const sortState = {};
  const showAll = {};
  function table(id, cols, rows, opts = {}) {
    if (!rows.length) return empty(opts.emptyTitle || 'Nothing to show', opts.emptyDetail || '');
    const st = sortState[id] || opts.sort || null;
    let list = rows.slice();
    if (st) {
      const col = cols.find((c) => c.key === st.key);
      if (col) {
        const get = col.sort || ((r) => r[col.key]);
        list.sort((a, b) => {
          const va = get(a), vb = get(b);
          const na = va == null || va === '', nb = vb == null || vb === '';
          if (na || nb) return na === nb ? 0 : na ? 1 : -1; // missing always last
          const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
          return st.dir === 'asc' ? c : -c;
        });
      }
    }
    const limit = opts.limit && !showAll[id] ? opts.limit : Infinity;
    const shown = list.slice(0, limit);
    let s = `<div class="table-wrap"><table data-table="${esc(id)}"><thead><tr>`;
    for (const c of cols) {
      const sortable = c.sortable !== false;
      const aria = st && st.key === c.key ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      s += `<th class="${c.num ? 'n ' : ''}${sortable ? 'sortable' : ''}"${sortable ? ` data-sort-table="${esc(id)}" data-sort-key="${esc(c.key)}" data-sort-num="${c.num ? 1 : ''}" aria-sort="${aria}" tabindex="0"` : ''}>${esc(c.label)}${sortable ? '<span class="arrow"></span>' : ''}</th>`;
    }
    s += '</tr></thead><tbody>';
    for (const r of shown) {
      const href = opts.href && opts.href(r);
      const hl = opts.highlight && opts.highlight(r);
      s += `<tr class="${href ? 'clickable' : ''}${hl ? ' hl' : ''}"${href ? ` data-href="${esc(href)}"` : ''}>`;
      for (const c of cols) s += `<td class="${c.num ? 'n' : ''}">${c.render ? c.render(r) : text(r[c.key])}</td>`;
      s += '</tr>';
    }
    s += '</tbody></table></div>';
    if (list.length > shown.length || (opts.limit && showAll[id] && list.length > opts.limit)) {
      s += `<div class="table-foot">Showing ${int(shown.length)} of ${int(list.length)} · <button class="btn ghost" data-showall="${esc(id)}">${showAll[id] ? 'Show fewer' : 'Show all'}</button></div>`;
    } else if (opts.foot) s += `<div class="table-foot">${opts.foot}</div>`;
    return s;
  }

  // ---------- filter bar ----------
  let filtersOpen = false;
  function filterBar(route, f) {
    const open = pipeOpen(f);
    const ownerSet = new Set(open.map((d) => d.owner).filter(Boolean));
    if (route === 'overview') for (const m of meetings) if (m.owner) ownerSet.add(m.owner);
    const owners = [...ownerSet].sort((a, b) => a.localeCompare(b));
    const segs = [...new Set([...open.map((d) => d.segment), ...companies.map((c) => c.segment)].filter(Boolean))]
      .sort((a, b) => (/^(Industry not set|No account)/.test(a) ? 1 : /^(Industry not set|No account)/.test(b) ? -1 : a.localeCompare(b)));
    const openStages = stageOrderFor(f.pipe).filter((k) => open.some((d) => d.stage === k));
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const n = FILTER_KEYS.filter((k) => k !== 'pipe' && f[k]).length;
    return `<div class="filters${filtersOpen ? ' open' : ''}" data-route="${esc(route)}">
      <button class="filters-toggle" type="button" aria-expanded="${filtersOpen}">Filters${n ? ` (${n} active)` : ''}</button>
      <div class="filters-body">
        <div class="field"><label for="f-pipe">Pipeline</label><select id="f-pipe" data-filter="pipe">${pipelines.map((p) => opt(p.label, p.label, f.pipe)).join('')}</select></div>
        <div class="field"><label for="f-owner">Owner</label><select id="f-owner" data-filter="owner">${opt('', 'All owners', f.owner)}${owners.map((o) => opt(o, o, f.owner)).join('')}</select></div>
        <div class="field"><label for="f-stage">Stage (open only)</label><select id="f-stage" data-filter="stage">${opt('', 'Open stages (excl. On Hold)', f.stage)}${openStages.map((s) => opt(s, s, f.stage)).join('')}</select></div>
        <div class="field"><label for="f-seg">Segment (industry)</label><select id="f-seg" data-filter="seg">${opt('', 'All industries', f.seg)}${segs.map((s) => opt(s, s, f.seg)).join('')}</select></div>
        <div class="field"><label for="f-from">Close date from</label><input id="f-from" type="date" data-filter="from" value="${esc(f.from)}"></div>
        <div class="field"><label for="f-to">Close date to</label><input id="f-to" type="date" data-filter="to" value="${esc(f.to)}"></div>
        <button class="btn ghost" type="button" data-clear-filters ${n ? '' : 'disabled'}>Clear</button>
      </div></div>`;
  }

  // ---------- chart builders ----------
  // Funnel: every open stage of the selected pipeline in HubSpot order, On Hold
  // last and marked as outside the active pipeline. The stage filter highlights
  // its row instead of hiding the others.
  // The two largest deals in a stage, by account name.
  const keyDeals = (list) => list.filter((d) => isNum(d.amount)).sort((a, b) => b.amount - a.amount).slice(0, 2)
    .map((d) => `${d.account || d.name} ${money(d.amount)}`).join(', ');
  function stageBarTable(f) {
    const list = pipeOpen(f).filter((d) => dealMatches(d, f, true));
    const rank = stageRankFor(f.pipe);
    const by = new Map();
    for (const d of list) {
      const k = d.stage;
      const e = by.get(k) || { count: 0, amount: 0, priced: 0, deals: [] };
      e.count++;
      e.deals.push(d);
      if (isNum(d.amount)) { e.amount += d.amount; e.priced++; }
      by.set(k, e);
    }
    const hold = (k) => /^on\s*hold$/i.test(k);
    const rows = [...by.entries()]
      .sort((a, b) => hold(a[0]) - hold(b[0]) || (rank.get(a[0]) ?? 999) - (rank.get(b[0]) ?? 999))
      .map(([k, e]) => ({
        label: k,
        sub: [hold(k) ? 'Not in totals' : keyDeals(e.deals), f.stage === k ? 'Filtered' : ''].filter(Boolean).join(' · '),
        href: `#/pipeline${qs({ ...f, stage: f.stage === k ? '' : k })}`,
        tip: `${k}\n${plural(e.count, 'open deal')} · ${moneyFull(e.priced ? e.amount : null)}${e.priced < e.count ? `\n${e.count - e.priced} without an amount` : ''}\n${f.stage === k ? 'Click to clear the stage filter' : 'Click to filter'}`,
        values: { count: e.count, amount: e.priced ? e.amount : null },
        muted: hold(k) || (f.stage && f.stage !== k),
      }));
    if (!rows.length) return empty('No open deals in this pipeline match these filters', '');
    return Charts.barTable({
      labelHeader: 'Stage',
      rows,
      columns: [
        { key: 'count', label: 'Deals', format: (v) => int(v) },
        { key: 'amount', label: 'Value', format: money },
      ],
    });
  }

  function closeMonthChart(list, f) {
    const dated = list.filter((d) => monthKey(d.close));
    if (!dated.length) return empty('No open deals with a close date match these filters', '');
    const keys = dated.map((d) => monthKey(d.close)).sort();
    const months = monthRange(keys[0], keys[keys.length - 1]);
    const by = new Map(months.map((k) => [k, { amount: 0, count: 0, priced: 0 }]));
    for (const d of dated) {
      const e = by.get(monthKey(d.close));
      e.count++;
      if (isNum(d.amount)) { e.amount += d.amount; e.priced++; }
    }
    const today = todayYmd().slice(0, 7);
    const data = months.map((k) => {
      const e = by.get(k);
      return {
        label: monthShort(k),
        values: [e.priced ? e.amount : 0],
        colors: k < today ? ['var(--past)'] : null,
        tip: `${monthLong(k)}${k < today ? ' (past)' : ''}\n${plural(e.count, 'deal')} · ${moneyFull(e.priced ? e.amount : null)}${e.priced < e.count ? `\n${e.count - e.priced} without an amount` : ''}${e.count ? '\nClick to filter' : ''}`,
        href: e.count ? `#/pipeline${qs({ ...f, from: `${k}-01`, to: monthEnd(k) })}` : null,
      };
    });
    const undated = list.length - dated.length;
    return (dated.some((d) => monthKey(d.close) < today) ? Charts.legend([{ name: 'Close date not yet reached', color: S1 }, { name: 'Close date passed, still open', color: 'var(--past)' }]) : '') + chartSlot((w) => Charts.columns({
      width: Math.max(w, months.length * 16), height: 230, data, series: [{ name: 'Value', color: S1 }], yFormat: money,
      marker: { index: months.indexOf(today), label: 'This month' }, title: 'Open value by close month',
    })) + (undated ? `<p class="note">${plural(undated, 'deal')} without a close date not shown.</p>` : '');
  }

  function meetingsPanel(f, selMonth) {
    const list = meetings.filter((m) => meetingMatches(m, f));
    if (!list.length) return panel({ title: 'Meetings over time', updated: times.records, body: empty('No meetings match these filters', '') });
    const now = Date.now();
    const keys = list.map((m) => monthKey(m.start)).filter(Boolean).sort();
    const months = monthRange(keys[0], keys[keys.length - 1]);
    const by = new Map(months.map((k) => [k, { past: 0, up: 0, outcomes: {} }]));
    for (const m of list) {
      const e = by.get(monthKey(m.start));
      if (!e) continue;
      if (new Date(m.start).getTime() < now) e.past++; else e.up++;
      const o = m.outcome || 'No outcome set';
      e.outcomes[o] = (e.outcomes[o] || 0) + 1;
    }
    const today = todayYmd().slice(0, 7);
    const data = months.map((k) => {
      const e = by.get(k);
      const outs = Object.entries(e.outcomes).sort((a, b) => b[1] - a[1]).map(([o, n]) => `${titleCase(o)}: ${n}`).join('\n');
      return {
        label: monthShort(k), values: [e.past, e.up],
        tip: `${monthLong(k)}\n${plural(e.past + e.up, 'meeting')} (${e.past} past, ${e.up} upcoming)${outs ? '\n' + outs : ''}\nClick to list`,
        href: e.past + e.up ? `#/overview${qs(f, { mm: k })}#meetings` : null,
      };
    });
    const series = [{ name: 'Past', color: S1 }, { name: 'Upcoming', color: S2 }];
    let body = Charts.legend(series) + chartSlot((w) => Charts.columns({
      width: Math.max(w, months.length * 12), height: 220, data, series, stacked: true,
      marker: { index: months.indexOf(today), label: 'Now' }, title: 'Meetings per month', minLabelGap: 52,
    }));
    if (selMonth && by.has(selMonth)) {
      const rows = list.filter((m) => monthKey(m.start) === selMonth);
      body += `<h3 id="meetings">Meetings in ${esc(monthLong(selMonth))} <a class="source-tag" href="#/overview${qs(f)}">clear</a></h3>` +
        table('month-meetings', [
          { key: 'start', label: 'When', render: (m) => esc(fmtDateTime(m.start)) },
          { key: 'title', label: 'Meeting' },
          { key: 'acct', label: 'Account', sort: (m) => companyName(m.companyIds[0]), render: (m) => m.companyIds.map((id) => accountLink(id)).join(', ') },
          { key: 'owner', label: 'Owner' },
          { key: 'outcome', label: 'Outcome', render: (m) => text(titleCase(m.outcome)) },
        ], rows, { sort: { key: 'start', dir: 'asc' }, limit: 25 });
    }
    return panel({
      title: 'Meetings over time', span: 12, updated: times.records,
      sub: `${plural(list.length, 'meeting')}. Click a month to list them.`,
      body,
    });
  }

  // ---------- headline, pipelines, data quality ----------
  // A total over deals that all lack an amount is unknown, not $0.
  const sumOrDash = (t, v) => (t.count > 0 && t.noAmountCount === t.count ? DASH : moneyFull(v));
  const KIND_LABEL = { 'new business': 'New business', renewal: 'Renewal / customer-success book', partnership: 'Partnerships', unknown: 'Pipeline not recorded' };
  const figTiles = (fig, extra = '') => `<div class="tiles">
      ${tile('Open deals', int(fig.active.count), 'excl. On Hold', 'hero headline')}
      ${tile('Open amount', sumOrDash(fig.active, fig.active.openAmount), fig.active.noAmountCount ? `${plural(fig.active.noAmountCount, 'deal')} without amount` : '', 'headline')}
      ${tile('Weighted', sumOrDash(fig.active, fig.active.weighted), fig.active.noProbabilityCount ? `${plural(fig.active.noProbabilityCount, 'deal')} without probability` : '', 'headline')}
      ${tile('On Hold (separate)', int(fig.onHold.count), sumOrDash(fig.onHold, fig.onHold.openAmount))}${extra}
    </div>`;

  // HubSpot (--recon) is the only headline; builds without it are refused.
  // The panel's own tag says when the export was taken; a caveat appears only
  // when the figures fail the expected-figure check.
  function headlineBlock() {
    const h = D.headline;
    if (!fromHubspot || !h) return '<p class="note warn">HubSpot figures are not in this build.</p>';
    const e = D.expect || {};
    const bad = e.checked && !e.matches;
    const caveat = bad
      ? `<p class="note bad">Doesn’t match the expected figures: ${esc(e.rows.filter((r) => !r.ok).map((r) => `${r.key} ${r.got} vs ${r.want}`).join('; '))}.</p>`
      : '';
    const cl = D.closedLost;
    // Closed lost = closed and not won (lib/project.mjs closedLost); the sub-line is the stage split.
    const lostTile = cl ? tile('Closed lost', int(cl.count), esc(cl.byStage.map((s) => `${int(s.count)} ${s.stage}`).join(' · '))) : '';
    return `<div class="side"><h4>HubSpot · ${esc(h.pipeline)}${e.checked && e.matches ? ' <span class="pill green">verified</span>' : ''}</h4>${figTiles(h, lostTile)}</div>${caveat}`;
  }

  // closed_lost_reason is free text in HubSpot; the largest groups only.
  function lostReasonsPanel() {
    const cl = D.closedLost;
    if (!cl || !cl.count) return '';
    const top = cl.reasons.slice(0, 8);
    const rest = cl.reasons.length - top.length;
    const body = (top.length ? table('lost-reasons', [
      { key: 'reason', label: 'Lost reason' },
      { key: 'count', label: 'Deals', num: true, render: (r) => int(r.count) },
      { key: 'amount', label: 'Amount', num: true, render: (r) => moneyFull(r.amount) },
    ], top, { sort: { key: 'count', dir: 'desc' } }) : '') +
      `<p class="desc muted">${[rest > 0 ? `${plural(rest, 'other reason')}` : '', cl.noReason ? `${int(cl.noReason)} of ${int(cl.count)} without a reason` : ''].filter(Boolean).join(' · ')}</p>`;
    return panel({ title: `Why ${cl.pipeline} deals were lost`, span: 6, updated: pipeUpdated(), body });
  }

  function pipelinesTable() {
    if (!figures.length) return empty('No pipeline figures', '');
    return table('pipelines', [
      { key: 'label', label: 'Pipeline', render: (p) => `<a href="#/pipeline${qs({ pipe: p.label })}">${esc(p.label)}</a><span class="sub">${esc(KIND_LABEL[p.kind] || p.kind)}</span>` },
      { key: 'count', label: 'Open deals', num: true, sort: (p) => p.active.count, render: (p) => int(p.active.count) },
      { key: 'amount', label: 'Open amount', num: true, sort: (p) => p.active.openAmount, render: (p) => `${sumOrDash(p.active, p.active.openAmount)}${p.active.noAmountCount ? `<span class="sub">${int(p.active.noAmountCount)} without amount</span>` : ''}` },
      { key: 'weighted', label: 'Weighted', num: true, sort: (p) => p.active.weighted, render: (p) => sumOrDash(p.active, p.active.weighted) },
      { key: 'hold', label: 'On Hold', num: true, sort: (p) => p.onHold.count, render: (p) => (p.onHold.count ? `${int(p.onHold.count)}<span class="sub">${sumOrDash(p.onHold, p.onHold.openAmount)}</span>` : int(0)) },
    ], figures, { href: (p) => `#/pipeline${qs({ pipe: p.label })}` });
  }

  // ---------- views ----------
  function viewOverview(q) {
    const f = getFilters(q);
    const list = inScope(f);
    return `<div class="page-head"><div><h1>GTM overview</h1></div></div>
      <div class="grid">
        ${panel({ title: 'New-business pipeline', updated: pipeUpdated(), body: headlineBlock() })}
        <section class="panel span-12" id="analysis" aria-live="polite"></section>
        ${briefPanel(7)}
        ${upcomingPanel(5)}
        ${panel({ title: 'All pipelines', sub: 'Each pipeline separately; never added together.', updated: pipeUpdated(), body: pipelinesTable() })}
        ${lostReasonsPanel()}
      </div>
      <h2 class="section-title">Filtered view</h2>
      ${filterBar('overview', f)}
      <div class="grid">
        ${panel({ title: `${f.pipe}: open pipeline by stage`, span: 6, updated: pipeUpdated(), sub: 'Largest deals per stage. Click a row to filter.', body: stageBarTable(f) })}
        ${panel({ title: 'Open value by close month', span: 6, updated: pipeUpdated(), sub: 'Click a month to filter.', body: closeMonthChart(list, f) })}
        ${meetingsPanel(f, q.get('mm'))}
      </div>`;
  }

  function briefPanel(span) {
    const b = D.brief;
    if (!b) return panel({ title: 'This week', span, updated: times.brief, body: empty('No agent brief in the data', '') });
    const lines = [
      ...b.whatsNew.map((x) => ({ kind: 'What’s new', text: x })),
      ...b.topActions.filter((a) => a.title).map((a) => ({ kind: 'Top action', text: a.title, why: a.why })),
      ...b.watchOuts.map((x) => ({ kind: 'Watch out', text: x })),
    ];
    const seen = new Set();
    const uniq = lines.filter((l) => !seen.has(l.text) && seen.add(l.text));
    const li = (l) => `<li><span class="kind">${esc(l.kind)}</span>${esc(l.text)}${l.why ? `<span class="why">${esc(l.why)}</span>` : ''}</li>`;
    const top = uniq.slice(0, 5);
    const rest = uniq.slice(5);
    const body = top.length
      ? `<ol class="brief">${top.map(li).join('')}</ol>${rest.length ? `<details><summary class="source-tag">${int(rest.length)} more</summary><ol class="brief" start="6">${rest.map(li).join('')}</ol></details>` : ''}`
      : empty('The brief is empty', '');
    return panel({ title: 'This week', span, updated: times.brief, body });
  }

  function upcomingPanel(span) {
    const items = ((D.operator && D.operator.briefMeetings) || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const prepIds = new Set(((D.operator && D.operator.prep) || []).map((p) => p.companyId));
    const body = items.length
      ? `<ul class="status-list">${items.map((m) => `<li><span>${companyById.has(m.companyId) ? `<a href="#/prep/${encodeURIComponent(m.companyId)}">${text(companyName(m.companyId))}</a>` : text(m.company)}<span class="sub muted"> · ${text(m.title)}</span></span><span class="muted">${esc(fmtDateTime(m.start))}${prepIds.has(m.companyId) ? ' <span class="pill green">prep</span>' : ''}</span></li>`).join('')}</ul>`
      : empty('No meetings in the prep brief', '');
    return panel({ title: 'Upcoming meetings', span, updated: times.operator, body });
  }

  function viewPipeline(q) {
    const f = getFilters(q);
    const list = inScope(f);
    const today = todayYmd();
    const past = list.filter((d) => dayKey(d.close) && dayKey(d.close) < today).length;
    const t = { amount: 0, weighted: 0, noProb: 0, noAmount: 0 };
    for (const d of list) {
      if (isNum(d.amount)) t.amount += d.amount; else t.noAmount++;
      if (!isNum(d.probability)) t.noProb++; else if (isNum(d.amount)) t.weighted += d.amount * d.probability;
    }
    const fig = figures.find((x) => x.label === f.pipe);
    const tiles = `<div class="tiles">
      ${tile('Deals in view', int(list.length), hasFilters(f) ? `of ${int(fig ? fig.active.count : 0)} open (excl. On Hold)` : (f.stage ? '' : 'open, excl. On Hold'), 'hero')}
      ${tile('Open amount', list.length ? moneyFull(t.amount) : DASH, t.noAmount ? `${plural(t.noAmount, 'deal')} without amount` : '')}
      ${tile('Weighted', list.length ? moneyFull(t.weighted) : DASH, t.noProb ? `${plural(t.noProb, 'deal')} without probability` : '')}
      ${tile('Close date passed', int(past), 'still open')}
    </div>`;
    const rank = stageRankFor(f.pipe);
    const dealCols = [
      { key: 'name', label: 'Deal', render: (d) => `${dealLink(d)}<span class="sub">${text(d.account || 'No account in snapshot')}</span>` },
      { key: 'stage', label: 'Stage', sort: (d) => rank.get(d.stage), render: (d) => `${esc(d.stage)}${d.onHold ? ' <span class="pill">On Hold</span>' : ''}` },
      { key: 'owner', label: 'Owner' },
      { key: 'amount', label: 'Amount', num: true, render: (d) => moneyFull(d.amount) },
      { key: 'probability', label: 'Prob.', num: true, render: (d) => probText(d.probability) },
      { key: 'weighted', label: 'Weighted', num: true, sort: weightedOf, render: (d) => moneyFull(weightedOf(d)) },
      { key: 'close', label: 'Close', sort: (d) => dayKey(d.close), render: (d) => `${fmtDay(d.close)}${dayKey(d.close) && dayKey(d.close) < today ? ' <span class="flag">passed</span>' : ''}` },
      { key: 'segment', label: 'Segment' },
    ];
    const acctRows = companies.filter((c) => {
      if (f.seg && c.segment !== f.seg) return false;
      const cd = pipeOpen(f).filter((d) => d.companyId === c.id);
      if (f.owner && c.owner !== f.owner && !cd.some((d) => d.owner === f.owner)) return false;
      if ((f.stage || f.from || f.to) && !cd.some((d) => dealMatches(d, f))) return false;
      return true;
    }).map((c) => {
      const cd = list.filter((d) => d.companyId === c.id);
      return { c, openCount: cd.length, openValue: sumAmount(cd), meetings: c.meetings.length };
    });
    const acctCols = [
      { key: 'name', label: 'Account', sort: (r) => r.c.name, render: (r) => accountLink(r.c.id) },
      { key: 'segment', label: 'Industry', sort: (r) => r.c.segment, render: (r) => text(r.c.segment) },
      { key: 'lifecycle', label: 'Lifecycle', sort: (r) => r.c.lifecycle, render: (r) => text(r.c.lifecycle) },
      { key: 'owner', label: 'Owner', sort: (r) => r.c.owner, render: (r) => text(r.c.owner) },
      { key: 'openCount', label: `Open deals (${f.pipe})`, num: true, render: (r) => int(r.openCount) },
      { key: 'openValue', label: 'Open value', num: true, render: (r) => moneyFull(r.openValue) },
      { key: 'meetings', label: 'Meetings', num: true, render: (r) => int(r.meetings) },
      { key: 'lastContact', label: 'Last contact', sort: (r) => dayKey(r.c.lastContact), render: (r) => lastContactText(r.c.lastContact) },
    ];

    return `<div class="page-head"><div><h1>Pipeline</h1></div></div>
      ${filterBar('pipeline', f)}
      <div class="grid">
        ${panel({ title: `${f.pipe}: summary`, updated: pipeUpdated(), body: tiles })}
        ${panel({ title: 'Open pipeline by stage', span: 6, updated: pipeUpdated(), sub: 'Largest deals per stage. Click a row to filter.', body: stageBarTable(f) })}
        ${panel({ title: 'Open value by close month', span: 6, updated: pipeUpdated(), sub: 'Click a month to filter.', body: closeMonthChart(list, f) })}
        ${panel({ title: 'Deals', sub: plural(list.length, 'deal'), updated: pipeUpdated(), body: table('deals', dealCols, list, { sort: { key: 'amount', dir: 'desc' }, limit: 50, href: (d) => `#/deal/${encodeURIComponent(d.id)}`, emptyTitle: 'No open deals match these filters' }) })}
        ${panel({ title: 'Accounts', sub: plural(acctRows.length, 'account'), updated: times.records, body: table('accounts', acctCols, acctRows, { sort: { key: 'openValue', dir: 'desc' }, limit: 50, href: (r) => `#/account/${encodeURIComponent(r.c.id)}`, emptyTitle: 'No accounts match these filters' }) })}
      </div>`;
  }

  function viewCampaigns(q) {
    const sel = q.get('c') || '';
    const ob = D.outbound;
    let outboundPanels;
    if (!ob || !ob.campaigns.length) {
      outboundPanels = panel({ title: 'Outbound campaigns', updated: times.outbound, body: empty('No campaign stats in the data', '') });
    } else {
      const running = ob.campaigns.filter((c) => String(c.status).toLowerCase() === 'running').sort((a, b) => (b.sent || 0) - (a.sent || 0));
      const rows = running.map((c) => ({
        label: c.name || DASH,
        href: c.id ? `#/campaigns?c=${encodeURIComponent(c.id)}` : null,
        tip: `${c.name}\nSent ${int(c.sent)} · Delivered ${int(c.delivered)}\nOpened ${trackingOff(c) ? 'tracking off' : int(c.opened)} · Replied ${int(c.replied)} · Meetings ${int(c.meetings)}`,
        values: { sent: c.sent, opened: c.opened, replied: c.replied, meetings: c.meetings },
        notes: trackingOff(c) ? { opened: 'tracking off' } : null,
      }));
      const chart = rows.length
        ? Charts.barTable({
          labelHeader: 'Campaign', rows,
          columns: [
            { key: 'sent', label: 'Sent' }, { key: 'opened', label: 'Opened' },
            { key: 'replied', label: 'Replied' }, { key: 'meetings', label: 'Meetings' },
          ],
        })
        : empty('No running campaigns', '');
      const selected = ob.campaigns.find((c) => c.id === sel);
      const detail = selected ? panel({
        title: selected.name || 'Campaign', updated: times.outbound, sub: '<a href="#/campaigns">Close</a>',
        body: kv([
          ['Status', text(selected.status)], ['Sent', int(selected.sent)], ['Delivered', int(selected.delivered)],
          ['Opened', trackingOff(selected) ? 'tracking off' : int(selected.opened)], ['Replied', int(selected.replied)],
          ['Reply rate', pct(selected.replied, selected.delivered)], ['Bounced', int(selected.bounced)], ['Meetings', int(selected.meetings)],
        ]),
      }) : '';
      const cols = [
        { key: 'name', label: 'Campaign' },
        { key: 'status', label: 'Status', render: (c) => `<span class="pill${c.status === 'running' ? ' green' : ''}">${text(c.status)}</span>` },
        { key: 'sent', label: 'Sent', num: true, render: (c) => int(c.sent) },
        { key: 'delivered', label: 'Delivered', num: true, render: (c) => int(c.delivered) },
        { key: 'opened', label: 'Opened', num: true, render: (c) => (trackingOff(c) ? '<span class="muted">tracking off</span>' : int(c.opened)) },
        { key: 'replied', label: 'Replied', num: true, render: (c) => int(c.replied) },
        { key: 'rate', label: 'Reply rate', num: true, sort: (c) => (c.delivered > 0 && isNum(c.replied) ? c.replied / c.delivered : null), render: (c) => pct(c.replied, c.delivered) },
        { key: 'bounced', label: 'Bounced', num: true, render: (c) => int(c.bounced) },
        { key: 'meetings', label: 'Meetings', num: true, render: (c) => int(c.meetings) },
      ];
      outboundPanels = detail +
        panel({ title: 'Running campaigns', updated: [[null, times.outbound, isStale('lemlist')]], sub: 'Click a campaign for details.', body: chart + sourceWarning('lemlist') }) +
        panel({ title: 'All campaigns', updated: times.outbound, sub: plural(ob.campaigns.length, 'campaign'), body: table('campaigns', cols, ob.campaigns, { sort: { key: 'sent', dir: 'desc' }, href: (c) => (c.id ? `#/campaigns?c=${encodeURIComponent(c.id)}` : null), highlight: (c) => c.id && c.id === sel }) });
    }

    // Paid ads
    const ads = D.ads || [];
    const adsBody = ads.length
      ? Charts.barTable({
        labelHeader: 'Channel',
        rows: ads.map((a) => ({ label: a.name || DASH, sub: a.window || '', values: { spend: a.spend, clicks: a.clicks, conversions: a.conversions } })),
        columns: [{ key: 'spend', label: 'Spend', format: money }, { key: 'clicks', label: 'Clicks' }, { key: 'conversions', label: 'Conversions' }],
      }) + table('ads', [
        { key: 'name', label: 'Channel' },
        { key: 'impressions', label: 'Impressions', num: true, render: (a) => int(a.impressions) },
        { key: 'ctr', label: 'CTR', num: true, sort: (a) => (a.impressions > 0 && isNum(a.clicks) ? a.clicks / a.impressions : null), render: (a) => pct(a.clicks, a.impressions) },
        { key: 'cpc', label: 'Cost / click', num: true, sort: (a) => (a.clicks > 0 && isNum(a.spend) ? a.spend / a.clicks : null), render: (a) => (a.clicks > 0 && isNum(a.spend) ? `$${(a.spend / a.clicks).toFixed(2)}` : DASH) },
        { key: 'cpa', label: 'Cost / conversion', num: true, sort: (a) => (a.conversions > 0 && isNum(a.spend) ? a.spend / a.conversions : null), render: (a) => (a.conversions > 0 && isNum(a.spend) ? moneyFull(a.spend / a.conversions) : DASH) },
      ], ads, { sort: { key: 'name', dir: 'asc' } }) + '<p class="note">Each channel reports over its own window (under its name).</p>'
      : empty('No ad platform data in the snapshot', '');

    // Spend by month
    const sp = D.spend;
    let spendBody;
    if (!sp || !sp.months.length) spendBody = empty('No spend data in the snapshot', '');
    else {
      const series = [{ name: 'Planned', color: S2 }, { name: 'Actual', color: S1 }];
      const data = sp.months.map((m) => ({
        label: m.label || m.month, values: [m.planned, m.actual],
        tip: `${m.month ? monthLong(m.month) : m.label}\nPlanned ${moneyFull(m.planned)}\nActual ${isNum(m.actual) ? moneyFull(m.actual) : `${DASH} (not entered)`}`,
      }));
      const thisMonth = todayYmd().slice(0, 7);
      const noActual = sp.months.filter((m) => !isNum(m.actual));
      const missing = noActual.filter((m) => !m.month || m.month <= thisMonth).map((m) => (m.month ? monthLong(m.month) : m.label));
      spendBody = Charts.legend(series) + chartSlot((w) => Charts.columns({ width: w, height: 220, data, series, yFormat: money, title: 'Planned vs actual spend' })) +
        (missing.length ? `<p class="note warn">No actuals entered for ${esc(missing.join(', '))}.</p>` : '') +
        (sp.channels.length ? `<h3>Spend by budget channel</h3>${Charts.barTable({ labelHeader: 'Channel', rows: sp.channels.map((c) => ({ label: c.name || DASH, values: { amount: c.amount } })), columns: [{ key: 'amount', label: 'Amount', format: moneyFull }] })}` : '');
    }

    // Tradeshows
    const sh = D.shows;
    let showsBody;
    const roi = (sh && sh.eventRoi) || [];
    const hasFunnel = roi.some((r) => isNum(r.leads) || isNum(r.mql)) || (sh && sh.items.some((s) => isNum(s.leads.count)));
    if (!sh || !hasFunnel) {
      showsBody = empty('Tradeshow lead → MQL data isn’t in the snapshot', 'The snapshot has no lead or MQL fields for shows.');
    } else {
      const roiRows = roi.filter((r) => isNum(r.leads) || isNum(r.mql) || isNum(r.sql));
      showsBody = (roiRows.length ? Charts.barTable({
        labelHeader: 'Event (spend group)', shared: true,
        rows: roiRows.map((r) => ({
          label: r.name || DASH, sub: [r.shows > 1 ? `${r.shows} shows` : '', r.end ? `ended ${fmtDay(r.end)}` : ''].filter(Boolean).join(' · '),
          tip: `${r.name}\nLeads ${int(r.leads)} → MQL ${int(r.mql)} (${pct(r.mql, r.leads)}) → SQL ${int(r.sql)}\nPaid ${moneyFull(r.paid)} · cost per lead ${moneyFull(r.costPerLead)}`,
          values: { leads: r.leads, mql: r.mql, sql: r.sql },
        })),
        columns: [{ key: 'leads', label: 'Leads', color: S1 }, { key: 'mql', label: 'MQL', color: S1 }, { key: 'sql', label: 'SQL', color: S1 }],
      }) : '') +
        `<h3>Shows</h3>` + table('shows', [
        { key: 'name', label: 'Show', render: (s) => `${text(s.name)}<span class="sub">${text(s.location)}</span>` },
        { key: 'start', label: 'Dates', sort: (s) => s.start, render: (s) => text(s.dateLabel || fmtDay(s.start)) },
        { key: 'status', label: 'Status', render: (s) => `${text(s.status)}<span class="sub">${text(s.phase)}</span>` },
        { key: 'leads', label: 'Leads', num: true, sort: (s) => s.leads.count, render: (s) => int(s.leads.count) },
        { key: 'mql', label: 'MQL', num: true, sort: (s) => s.leads.mql, render: (s) => int(s.leads.mql) },
        { key: 'sql', label: 'SQL', num: true, sort: (s) => s.leads.sql, render: (s) => int(s.leads.sql) },
        { key: 'conv', label: 'Lead → MQL', num: true, sort: (s) => (s.leads.count > 0 && isNum(s.leads.mql) ? s.leads.mql / s.leads.count : null), render: (s) => pct(s.leads.mql, s.leads.count) },
        { key: 'req', label: 'Meeting requests', num: true, sort: (s) => s.meetingRequests.count, render: (s) => int(s.meetingRequests.count) },
      ], sh.items, { sort: { key: 'start', dir: 'desc' } });
    }

    return `<div class="page-head"><div><h1>Campaigns</h1></div></div>
      <div class="grid">
        ${outboundPanels}
        ${panel({ title: 'Ad spend vs results', span: 6, updated: times.marketing, body: adsBody })}
        ${panel({ title: 'Marketing spend by month', span: 6, updated: [[null, times.marketing, isStale('sheets')]], body: spendBody + sourceWarning('sheets') })}
        ${panel({ title: 'Tradeshows: lead → MQL → SQL', updated: [[null, times.marketing, isStale('sheets')]], sub: 'Hover for conversion and cost per lead.', body: showsBody })}
      </div>`;
  }

  // ---------- meetings / recordings helpers ----------
  function accountMeetings(c) {
    const now = Date.now();
    const valid = c.meetings.filter((m) => m.start && !Number.isNaN(new Date(m.start).getTime()));
    return {
      upcoming: valid.filter((m) => new Date(m.start).getTime() >= now).sort((a, b) => a.start.localeCompare(b.start)),
      recent: valid.filter((m) => new Date(m.start).getTime() < now).sort((a, b) => b.start.localeCompare(a.start)),
    };
  }
  function meetingList(list, emptyText, limit = 6) {
    if (!list.length) return empty(emptyText, '');
    return `<ul class="status-list">${list.slice(0, limit).map((m) => `<li><span>${text(m.title)}<span class="sub muted">${text(m.owner)}${m.outcome ? ` · ${esc(titleCase(m.outcome))}` : ''}</span></span><span class="muted">${esc(fmtDateTime(m.start))}</span></li>`).join('')}</ul>${list.length > limit ? `<p class="table-foot">+${int(list.length - limit)} more</p>` : ''}`;
  }

  const transcripts = new Map();
  const openTranscripts = new Set();
  const failedTranscripts = new Set();
  window.GTM_TRANSCRIPT = (id, lines) => { transcripts.set(id, lines); fillTranscript(id); };
  function transcriptHtml(id) {
    if (failedTranscripts.has(id)) return '<p class="muted">The transcript file is missing from this build.</p>';
    const lines = transcripts.get(id);
    if (!lines) return '<p class="muted">Loading…</p>';
    if (!lines.length) return '<p class="muted">The transcript is empty in the data.</p>';
    return lines.map((l) => `<p><span class="ts">${text(l.t)}</span><span class="sp">${text(l.s)}:</span> ${esc(l.x || '')}</p>`).join('');
  }
  function fillTranscript(id) {
    document.querySelectorAll('[data-transcript-body]').forEach((el) => {
      if (el.getAttribute('data-transcript-body') === id) el.innerHTML = transcriptHtml(id);
    });
  }
  function toggleTranscript(id) {
    if (!SAFE_ID.test(id) || !transcriptIds.has(id)) return;
    if (openTranscripts.has(id)) openTranscripts.delete(id); else openTranscripts.add(id);
    if (openTranscripts.has(id) && !transcripts.has(id) && !failedTranscripts.has(id)) {
      const s = document.createElement('script');
      s.src = `transcripts/${id}.js`;
      s.onerror = () => { failedTranscripts.add(id); fillTranscript(id); };
      document.head.appendChild(s);
    }
    render();
  }

  function recordingItem(r) {
    const hasT = r.hasTranscript && transcriptIds.has(r.id);
    const open = openTranscripts.has(r.id);
    return `<div class="item"><div class="item-head"><strong>${text(r.title)}</strong><span class="muted">${esc(fmtDateTime(r.date))}${isNum(r.minutes) ? ` · ${int(r.minutes)} min` : ''}${r.recordedBy ? ` · ${esc(r.recordedBy)}` : ''}</span></div>
      ${r.summary.length ? `<div class="summary">${renderSummary(r.summary)}</div>` : '<p class="muted">No recording summary in the data.</p>'}
      <h4 class="source-tag" style="margin-top:10px">Action items (verbatim)</h4>
      ${r.actions.length ? `<ul class="actions">${r.actions.map((a) => `<li>${inlineMd(a)}</li>`).join('')}</ul>` : '<p class="muted">No action items in the data.</p>'}
      ${hasT ? `<button class="btn ghost" type="button" data-transcript="${esc(r.id)}" aria-expanded="${open}">${open ? 'Hide transcript' : `Show transcript${isNum(r.transcriptLines) ? ` (${int(r.transcriptLines)} lines)` : ''}`}</button>${open ? `<div class="transcript" data-transcript-body="${esc(r.id)}">${transcriptHtml(r.id)}</div>` : ''}` : ''}
    </div>`;
  }
  function recordingsBlock(c, limit) {
    const recs = c.recordings.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!recs.length) return empty('No recording summary in the data', 'No call recordings are linked to this account.');
    const shown = limit ? recs.slice(0, limit) : recs;
    return `<div class="stack">${shown.map(recordingItem).join('')}</div>${recs.length > shown.length ? `<p class="table-foot">${int(recs.length - shown.length)} older recordings on the <a href="#/account/${encodeURIComponent(c.id)}">account page</a>.</p>` : ''}`;
  }
  function notesBlock(c, limit) {
    const notes = c.notes.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!notes.length) return empty('No notes in the data', '');
    const shown = limit ? notes.slice(0, limit) : notes;
    return `<div class="stack">${shown.map((n) => `<div class="item"><div class="item-head"><span>${text(n.owner)}</span><span class="muted">${fmtDay(n.date)}</span></div><p class="note-text">${text(n.text)}</p></div>`).join('')}</div>${notes.length > shown.length ? `<p class="table-foot">+${int(notes.length - shown.length)} older notes</p>` : ''}`;
  }

  function notFound(what) {
    return `<div class="page-head"><div><h1>${esc(what)} not found</h1><p>It isn’t in this data snapshot. <a href="#/overview">Back to overview</a></p></div></div>`;
  }

  function viewDeal(id) {
    const d = dealById.get(id);
    if (!d) return notFound('Deal');
    const c = companyById.get(d.companyId);
    const today = todayYmd();
    const passed = d.open && dayKey(d.close) && dayKey(d.close) < today;
    const q = D.quality || {};
    const flags = [
      (q.closedButActive || []).some((r) => r.id === d.id) ? 'Closed in HubSpot but still active on the master Sheet.' : '',
      (q.missingFromSheet || []).some((r) => r.id === d.id) ? 'Open in HubSpot but not on the master Sheet.' : '',
      (q.otherDiffs || []).some((r) => r.id === d.id) ? 'Active on the Sheet, but HubSpot has it On Hold or in another pipeline.' : '',
    ].filter(Boolean);
    const status = d.open ? (d.onHold ? '<span class="pill">On Hold (not in active totals)</span>' : '<span class="pill green">open</span>') : '<span class="pill">closed / not in open pipeline</span>';
    const fields = kv([
      ['Account', d.companyId ? dealAccount(d) : 'No account in snapshot'], ['Pipeline', text(d.pipeline)], ['Stage', text(d.stage)], ['Status', status],
      ['Owner', text(d.owner)], ['Amount', moneyFull(d.amount)], ['Probability', probText(d.probability)], ['Weighted', moneyFull(weightedOf(d))],
      ['Close date', `${fmtDay(d.close)}${passed ? ' <span class="flag">passed</span>' : ''}`], ['Created', fmtDay(d.created)], ['Segment (industry)', text(d.segment)],
      ...(d.lost ? [['Lost reason', text(d.lostReason)]] : []),
      ...(d.closed ? [['Owner at close', text(d.ownerAtClose)]] : []),
    ]) + ((d.ownerHistory || []).length ? `<h3>Owner history</h3><ul class="actions">${d.ownerHistory.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map((h) => `<li>${fmtDay(h.at)} · ${text(h.owner)}</li>`).join('')}</ul>` : '') + (d.sheet ? `<h3>On the master Sheet <span class="muted">(as of ${esc(fmtUpdated(times.sheet))})</span></h3>${kv([['Sheet stage', text(d.sheet.stage)], ['Sheet amount', moneyFull(d.sheet.amount)], ['Sheet close', fmtDay(d.sheet.close)], ['Sheet owner', text(d.sheet.owner)], ['Sheet probability', isNum(d.sheet.probability) ? `${d.sheet.probability}%` : DASH]])}` : '<p class="desc muted">Not among the master Sheet’s open rows.</p>') +
      (flags.length ? flags.map((x) => `<p class="note bad">${esc(x)}</p>`).join('') : '');
    const m = c ? accountMeetings(c) : { upcoming: [], recent: [] };
    const acctDeals = c ? c.dealIds.map((x) => dealById.get(x)).filter(Boolean) : [];
    return `<div class="crumbs"><a href="#/pipeline${qs({ pipe: d.pipeline })}">Pipeline</a> / ${d.companyId ? dealAccount(d) : 'Deal'}</div>
      <div class="page-head"><div><h1>${text(d.name)}</h1><p>${text(d.pipeline)} · ${text(d.stage)} · ${moneyFull(d.amount)}</p></div>${c ? `<a class="btn" href="#/prep/${encodeURIComponent(c.id)}">Meeting prep</a>` : ''}</div>
      <div class="grid">
        ${panel({ title: 'Deal fields', updated: pipeUpdated(), body: fields })}
        ${c ? panel({ title: 'Account', span: 6, updated: times.records, body: kv([
          ['Name', accountLink(c.id)], ['Industry', text(c.segment)], ['Lifecycle', text(c.lifecycle)], ['Account owner', text(c.owner)],
          ['Contacts', int(c.contactCount)], ['Deals at account', `${int(acctDeals.length)} (${int(acctDeals.filter((x) => x.open).length)} open)`],
          ['Last contact', lastContactText(c.lastContact)], ['Emails logged', int(c.emailCount)],
        ]) }) : panel({ title: 'Account', span: 6, updated: times.records, body: empty('No account for this deal in records.json', 'Meetings, notes and recordings are attached to accounts, so none are shown.') })}
        ${c ? panel({ title: 'Meetings', span: 6, updated: times.records, body: `<h3>Upcoming</h3>${meetingList(m.upcoming, 'No upcoming meetings', 3)}<h3>Recent</h3>${meetingList(m.recent, 'No past meetings', 5)}` }) : ''}
        ${c ? panel({ title: 'Notes', span: 6, updated: times.records, body: notesBlock(c, 3) }) : ''}
        ${c ? panel({ title: 'Recording summaries & action items', span: 6, updated: [['Recordings', times.recordings || times.records, isStale('fathom')]], body: recordingsBlock(c, 3) }) : ''}
      </div>`;
  }

  function viewAccount(id) {
    const c = companyById.get(id);
    if (!c) return notFound('Account');
    const m = accountMeetings(c);
    const acctDeals = c.dealIds.map((x) => dealById.get(x)).filter(Boolean);
    const today = todayYmd();
    const dealCols = [
      { key: 'name', label: 'Deal', render: dealLink },
      { key: 'pipeline', label: 'Pipeline' },
      { key: 'stage', label: 'Stage', render: (d) => `${esc(d.stage)}${d.open ? (d.onHold ? ' <span class="pill">On Hold</span>' : '') : ' <span class="pill">not open</span>'}` },
      { key: 'owner', label: 'Owner' },
      { key: 'amount', label: 'Amount', num: true, render: (d) => moneyFull(d.amount) },
      { key: 'probability', label: 'Prob.', num: true, render: (d) => probText(d.probability) },
      { key: 'close', label: 'Close', sort: (d) => dayKey(d.close), render: (d) => `${fmtDay(d.close)}${d.open && dayKey(d.close) && dayKey(d.close) < today ? ' <span class="flag">passed</span>' : ''}` },
    ];
    return `<div class="crumbs"><a href="#/pipeline">Pipeline</a> / Account</div>
      <div class="page-head"><div><h1>${text(c.name)}</h1><p>${[c.lifecycle, c.segment, c.domain].filter(Boolean).map(esc).join(' · ') || DASH}</p></div><a class="btn" href="#/prep/${encodeURIComponent(c.id)}">Meeting prep</a></div>
      <div class="grid">
        ${panel({ title: 'Account fields', updated: times.records, body: kv([
          ['Owner', text(c.owner)], ['Domain', text(c.domain)], ['Industry (segment)', text(c.segment)], ['Lifecycle', text(c.lifecycle)],
          ['Employees', int(c.employees)], ['Location', text([c.city, c.country].filter(Boolean).join(', '))], ['Created', fmtDay(c.created)],
          ['Last contact', lastContactText(c.lastContact)], ['Contacts', int(c.contactCount)], ['Emails logged', int(c.emailCount)],
          ['Calls logged', int(c.callCount)], ['Recordings', int(c.recordings.length)],
        ]) + (c.description ? `<p class="desc">${esc(c.description)}</p>` : '') })}
        ${panel({ title: 'Deals', sub: `${plural(acctDeals.length, 'deal')}, ${int(acctDeals.filter((d) => d.open).length)} open, across all pipelines`, updated: pipeUpdated(), body: table('acct-deals-' + c.id, dealCols, acctDeals, { sort: { key: 'close', dir: 'desc' }, href: (d) => `#/deal/${encodeURIComponent(d.id)}`, emptyTitle: 'No deals at this account' }) })}
        ${panel({ title: 'Meetings', span: 6, updated: times.records, sub: `${plural(c.meetings.length, 'meeting')} in the CRM`, body: `<h3>Upcoming</h3>${meetingList(m.upcoming, 'No upcoming meetings', 4)}<h3>Recent</h3>${meetingList(m.recent, 'No past meetings', 8)}` })}
        ${panel({ title: 'Notes', span: 6, updated: times.records, body: notesBlock(c, 5) })}
        ${panel({ title: 'Recording summaries & action items', span: 6, updated: [['Recordings', times.recordings || times.records, isStale('fathom')]], body: recordingsBlock(c) })}
      </div>`;
  }

  function prepAccounts() {
    const now = Date.now();
    const win = PREP_WINDOW_DAYS * 864e5;
    const prep = (D.operator && D.operator.prep) || [];
    const brief = (D.operator && D.operator.briefMeetings) || [];
    const ids = new Set([...prep.map((p) => p.companyId), ...brief.map((b) => b.companyId)].filter((id) => companyById.has(id)));
    for (const c of companies) {
      if (c.meetings.some((m) => { const t = new Date(m.start).getTime(); return t >= now - win && t <= now + win; })) ids.add(c.id);
    }
    return [...ids].map((id) => {
      const c = companyById.get(id);
      const { upcoming, recent } = accountMeetings(c);
      const fromBrief = [...prep, ...brief].filter((p) => p.companyId === id && p.start && new Date(p.start).getTime() >= now).map((p) => p.start).sort()[0];
      const next = [upcoming[0] && upcoming[0].start, fromBrief].filter(Boolean).sort()[0] || null;
      const nextTitle = (upcoming[0] && upcoming[0].start === next && upcoming[0].title) || ([...prep, ...brief].find((p) => p.companyId === id && p.start === next) || {}).title || null;
      return { c, next, nextTitle, last: recent[0] ? recent[0].start : null, lastTitle: recent[0] ? recent[0].title : null, recordings: c.recordings.length, prep: prep.some((p) => p.companyId === id) };
    });
  }

  function viewPrepList() {
    const rows = prepAccounts();
    const cols = [
      { key: 'name', label: 'Account', sort: (r) => r.c.name, render: (r) => `<a href="#/prep/${encodeURIComponent(r.c.id)}">${text(r.c.name)}</a><span class="sub">${text(r.c.owner)}</span>` },
      { key: 'next', label: 'Next meeting', render: (r) => (r.next ? `${esc(fmtDateTime(r.next))}<span class="sub">${text(r.nextTitle)}</span>` : DASH) },
      { key: 'last', label: 'Last meeting', render: (r) => (r.last ? `${esc(fmtDateTime(r.last))}<span class="sub">${text(r.lastTitle)}</span>` : DASH) },
      { key: 'recordings', label: 'Recordings', num: true, render: (r) => int(r.recordings) },
      { key: 'prep', label: 'Prep notes', sort: (r) => (r.prep ? 1 : 0), render: (r) => (r.prep ? '<span class="pill green">ready</span>' : DASH) },
    ];
    return `<div class="page-head"><div><h1>Meeting prep</h1><p>Accounts with a meeting in the last or next ${PREP_WINDOW_DAYS} days, plus every account in the prep brief.</p></div></div>
      <div class="grid">${panel({
        title: 'Accounts', updated: times.operator,
        sub: plural(rows.length, 'account'),
        body: table('prep', cols, rows, {
          sort: { key: 'next', dir: 'asc' }, href: (r) => `#/prep/${encodeURIComponent(r.c.id)}`, emptyTitle: 'No accounts with recent or upcoming meetings',
        }),
      })}</div>`;
  }

  function viewPrep(id) {
    const c = companyById.get(id);
    if (!c) return notFound('Account');
    const { upcoming, recent } = accountMeetings(c);
    const preps = ((D.operator && D.operator.prep) || []).filter((p) => p.companyId === id);
    const prepPanels = preps.map((p) => {
      const lc = p.lastCall;
      const body = kv([
        ['Meeting', text(p.title)], ['When', esc(fmtDateTime(p.start))], ['Last contact', lastContactText(c.lastContact)],
        ['Attendees', p.attendees.length ? p.attendees.map((a) => `${text(a.name)}${a.title ? ` <span class="muted">(${esc(a.title)})</span>` : ''}`).join('<br>') : DASH],
      ]) +
        (p.callGoal ? `<h3>Call goal <span class="source-tag">from the prep brief</span></h3><p>${esc(p.callGoal)}</p>` : '') +
        `<h3>Last call ${lc ? `<span class="source-tag">${text(lc.title)} · ${esc(fmtDateTime(lc.date))}</span>` : ''}</h3>` +
        (lc && lc.summary.length ? `<ul class="actions">${lc.summary.map((s) => `<li>${inlineMd(s)}</li>`).join('')}</ul>` : '<p class="muted">No recording summary in the data.</p>') +
        (lc && lc.takeaways.length ? `<h3>Takeaways</h3><ul class="actions">${lc.takeaways.map((s) => `<li>${inlineMd(s)}</li>`).join('')}</ul>` : '') +
        `<h3>Next steps from the last call</h3>` + (lc && lc.actions.length ? `<ul class="actions">${lc.actions.map((s) => `<li>${inlineMd(s)}</li>`).join('')}</ul>` : '<p class="muted">No next steps in the data.</p>') +
        (p.unresolvedActions.length ? `<h3>Unresolved action items</h3><ul class="actions">${p.unresolvedActions.map((a) => `<li>${inlineMd(a.action)} <span class="source-tag">${text(a.from)} · ${fmtDay(a.date)}</span></li>`).join('')}</ul>` : '') +
        (p.suggestedAgenda.length ? `<h3>Suggested agenda <span class="source-tag">from the prep brief</span></h3><ol class="actions">${p.suggestedAgenda.map((s) => `<li>${inlineMd(s)}</li>`).join('')}</ol>` : '');
      return panel({ title: 'Prep brief', sub: text(p.title), updated: times.operator, body });
    }).join('');
    return `<div class="crumbs"><a href="#/prep">Meeting prep</a> / Account</div>
      <div class="page-head"><div><h1>${text(c.name)}</h1><p>${[c.lifecycle, c.segment, c.owner].filter(Boolean).map(esc).join(' · ') || DASH}</p></div><a class="btn ghost" href="#/account/${encodeURIComponent(c.id)}">Open account</a></div>
      <div class="grid">
        ${panel({ title: 'Upcoming meetings', span: 6, updated: times.records, body: meetingList(upcoming, 'No upcoming meetings in the CRM', 5) })}
        ${panel({ title: 'Recent meetings', span: 6, updated: times.records, body: meetingList(recent, 'No past meetings in the CRM', 5) })}
        ${prepPanels}
        ${panel({ title: 'Open deals', updated: pipeUpdated(), body: (() => { const od = c.dealIds.map((x) => dealById.get(x)).filter((x) => x && x.open); return od.length ? `<ul class="actions">${od.map((x) => `<li><a href="#/deal/${encodeURIComponent(x.id)}">${text(x.name)}</a> · ${text(x.pipeline)} · ${text(x.stage)} · ${moneyFull(x.amount)}${x.close ? ` · close ${fmtDay(x.close)}` : ''}</li>`).join('')}</ul>` : empty('No open deals at this account', ''); })() })}
        ${panel({ title: 'Recording summaries & next steps', updated: [['Recordings', times.recordings || times.records, isStale('fathom')]], body: recordingsBlock(c, 3) })}
        ${panel({ title: 'Recent notes', updated: times.records, body: notesBlock(c, 3) })}
      </div>`;
  }

  // ---------- router ----------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [pathAndQuery] = h.split('#');
    const [path, query] = pathAndQuery.split('?');
    const parts = path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    return { parts, q: new URLSearchParams(query || ''), anchor: h.split('#')[1] || '' };
  }

  let lastRouteKey = '';
  function render() {
    const { parts, q, anchor } = parseHash();
    const [route = 'overview', id] = parts;
    chartJobs = [];
    let html;
    if (route === 'overview') html = viewOverview(q);
    else if (route === 'pipeline') html = viewPipeline(q);
    else if (route === 'campaigns') html = viewCampaigns(q);
    else if (route === 'prep') html = id ? viewPrep(id) : viewPrepList();
    else if (route === 'deal') html = viewDeal(id);
    else if (route === 'account') html = viewAccount(id);
    else html = notFound('Page');
    const main = document.getElementById('main');
    main.innerHTML = html;
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const navFor = { deal: 'pipeline', account: 'pipeline' }[route] || route;
      a.classList.toggle('active', a.getAttribute('data-nav') === navFor);
    });
    drawCharts();
    fillAnalysis();
    const key = `${route}/${id || ''}`;
    if (anchor) { const el = document.getElementById(anchor); if (el) el.scrollIntoView({ block: 'start' }); }
    else if (key !== lastRouteKey) window.scrollTo(0, 0);
    lastRouteKey = key;
  }

  function applyFilter(container, key, value) {
    const route = container.getAttribute('data-route');
    const { q } = parseHash();
    const f = getFilters(q);
    if (key === null) FILTER_KEYS.forEach((k) => (f[k] = ''));
    else f[key] = value;
    const extra = {};
    if (route === 'overview' && q.get('mm')) extra.mm = q.get('mm');
    history.replaceState(null, '', `#/${route}${qs(f, extra)}`);
    render();
  }

  function go(href) {
    if (!href) return;
    if (location.hash === href) render(); else location.hash = href;
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const th = t.closest('th[data-sort-key]');
    if (th) {
      const id = th.getAttribute('data-sort-table');
      const key = th.getAttribute('data-sort-key');
      const cur = sortState[id] || (th.getAttribute('aria-sort') !== 'none' ? { key, dir: th.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc' } : null);
      const first = th.getAttribute('data-sort-num') ? 'desc' : 'asc';
      sortState[id] = cur && cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: first };
      render();
      return;
    }
    const sa = t.closest('[data-showall]');
    if (sa) { const id = sa.getAttribute('data-showall'); showAll[id] = !showAll[id]; render(); return; }
    const tr = t.closest('[data-transcript]');
    if (tr) { toggleTranscript(tr.getAttribute('data-transcript')); return; }
    const ft = t.closest('.filters-toggle');
    if (ft) { filtersOpen = !filtersOpen; ft.closest('.filters').classList.toggle('open', filtersOpen); ft.setAttribute('aria-expanded', filtersOpen); return; }
    const clr = t.closest('[data-clear-filters]');
    if (clr) { applyFilter(clr.closest('.filters'), null); return; }
    if (t.closest('a, button, input, select, summary')) return;
    const link = t.closest('[data-href]');
    if (link) go(link.getAttribute('data-href'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = document.activeElement;
    if (!el || el.matches('a, button, input, select, textarea, summary')) return;
    // SVG marks have no .click(), so dispatch a synthetic click for both.
    if (el.matches('th[data-sort-key], [data-href]')) { e.preventDefault(); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-filter]');
    if (el) applyFilter(el.closest('.filters'), el.getAttribute('data-filter'), el.value);
  });

  // Tooltips
  const tip = document.getElementById('tip');
  function showTip(el, x, y) {
    tip.textContent = el.getAttribute('data-tip');
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } else tip.hidden = true;
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, true);

  // ---------- global search ----------
  const searchIndex = [
    ...companies.map((c) => ({ kind: 'Accounts', label: c.name || DASH, sub: [c.domain, c.segment, c.lifecycle].filter(Boolean).join(' · '), href: `#/account/${encodeURIComponent(c.id)}`, hay: `${c.name || ''} ${c.domain || ''}`.toLowerCase() })),
    ...deals.map((d) => ({ kind: 'Deals', label: d.name || DASH, sub: [d.account, d.pipeline, d.stage, isNum(d.amount) ? moneyFull(d.amount) : null].filter(Boolean).join(' · '), href: `#/deal/${encodeURIComponent(d.id)}`, hay: `${d.name || ''} ${d.account || ''}`.toLowerCase() })),
  ];
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');
  let hits = [];
  let sel = -1;
  function closeSearch() { results.hidden = true; input.setAttribute('aria-expanded', 'false'); sel = -1; }
  function drawSearch() {
    const q = input.value.trim().toLowerCase();
    if (!q) { closeSearch(); return; }
    const score = (h) => (h.label.toLowerCase().startsWith(q) ? 0 : h.hay.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2);
    const match = (kind) => searchIndex.filter((h) => h.kind === kind && h.hay.includes(q)).sort((a, b) => score(a) - score(b) || a.label.localeCompare(b.label)).slice(0, 7);
    const groups = [['Accounts', match('Accounts')], ['Deals', match('Deals')]];
    hits = groups.flatMap(([, list]) => list);
    let i = 0;
    results.innerHTML = hits.length
      ? groups.filter(([, l]) => l.length).map(([kind, list]) => `<div class="group">${esc(kind)}</div>${list.map((h) => `<a href="${esc(h.href)}" role="option" data-i="${i}" class="${i++ === sel ? 'sel' : ''}">${esc(h.label)}<span class="sub">${esc(h.sub)}</span></a>`).join('')}`).join('')
      : `<div class="none">No accounts or deals match “${esc(input.value.trim())}”</div>`;
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  input.addEventListener('input', () => { sel = -1; drawSearch(); });
  input.addEventListener('focus', () => { if (input.value.trim()) drawSearch(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      drawSearch();
    } else if (e.key === 'Enter') {
      const h = hits[sel >= 0 ? sel : 0];
      if (h) { go(h.href); input.value = ''; closeSearch(); input.blur(); }
    } else if (e.key === 'Escape') { closeSearch(); input.blur(); }
  });
  results.addEventListener('mousedown', (e) => e.preventDefault());
  results.addEventListener('click', (e) => { if (e.target.closest('a')) { input.value = ''; closeSearch(); input.blur(); } });
  input.addEventListener('blur', closeSearch);

  // ---------- refresh status (header) ----------
  // refresh.json is rewritten on every scheduled check (data.js only when the
  // data changed). Without it, data.js's own refreshedAt is shown.
  const LATE_MS = 45 * 60 * 1000;
  let refreshDoc = null;
  function showRefreshed() {
    const box = document.getElementById('refreshed');
    if (!box) return;
    const at = (refreshDoc && refreshDoc.refreshedAt) || D.refreshedAt || null;
    const changed = (refreshDoc && refreshDoc.dataChangedAt) || D.dataChangedAt || null;
    const ms = Date.parse(at || '');
    const late = Number.isFinite(ms) && Date.now() - ms > LATE_MS;
    box.className = `refreshed ${!at ? '' : late ? 'late' : 'ok'}`;
    box.firstElementChild.textContent = at ? `Last refreshed ${fmtUpdated(at)}` : `Built ${fmtUpdated(D.builtAt)}`;
    // Details stay in the tooltip; the sub line only speaks up when late.
    box.lastElementChild.textContent = late ? 'refresh is late' : '';
    box.title = [at && `Last check: ${fmtDateTime(at)}`, changed && `Data last changed: ${fmtDateTime(changed)}`,
      R && R.snapshot && `Snapshot published: ${fmtDateTime(R.snapshot.publishedAt)}`].filter(Boolean).join('\n');
  }
  function loadRefresh() {
    if (!window.fetch) return;
    fetch('refresh.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        if (!doc || typeof doc.refreshedAt !== 'string') return;
        refreshDoc = doc;
        // data.js is only re-uploaded when its content changes; the current
        // fetch/publish times of the data it holds come with every check.
        let moved = false;
        for (const [path, v] of Object.entries(doc.stamps || {})) {
          const [head, a, b] = path.split('.');
          if (head === 'times') { if (times[a] !== v) { times[a] = v; moved = true; } }
          else if (head === 'sources' && sourceStatus.has(a) && (b === 'at' || b === 'lastOkAt')) { sourceStatus.get(a)[b] = v; moved = true; }
          else if (head === 'quality' && D.quality && a === 'sheetGeneratedAt') D.quality.sheetGeneratedAt = v;
          else if (head === 'refresh' && R) { if (a === 'snapshot' && R.snapshot) R.snapshot[b] = v; else if (a === 'sheetAsOf') R.sheetAsOf = v; moved = true; }
        }
        if (moved) render();
      })
      .catch(() => {})
      .then(showRefreshed);
  }

  // ---------- Analysis (insights.json from the Strategy seat) ----------
  // Every string from the file is set with textContent: nothing is parsed as HTML.
  // Deals, accounts, stages, pipelines, headline metrics and overview panels the
  // text names are matched against GTM_DATA at runtime (GtmInsights.findRefs):
  // entities become links to their pages, metrics and panels scroll into view
  // and pulse. Goals sit beside the metric's current value, and the headline
  // tile they track gets a "Goal" line (added here, after the overview renders).
  const GI = window.GtmInsights;
  let analysis = { state: 'loading' };
  let refIdx = null;
  const refIndex = () => refIdx || (refIdx = GI.refIndex(D, { money: [money, moneyFull] }));
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  // Where a reference leads: a route for entities, an element on the overview for metrics and panels.
  function refHref(ref) {
    if (ref.kind === 'deal') return dealById.has(ref.id) ? `#/deal/${encodeURIComponent(ref.id)}` : null;
    if (ref.kind === 'account') return companyById.has(ref.id) ? `#/account/${encodeURIComponent(ref.id)}` : null;
    if (ref.kind === 'stage') return `#/pipeline${qs({ pipe: defaultPipe, stage: ref.stage })}`;
    if (ref.kind === 'pipeline') return pipelineByLabel.has(ref.pipe) ? `#/pipeline${qs({ pipe: ref.pipe })}` : null;
    if (ref.kind === 'metric') return (GI.METRICS[ref.key] && GI.METRICS[ref.key].route) || null;
    return null;
  }
  const panelEl = (key) => {
    const p = GI.PANELS[key];
    return p ? [...document.querySelectorAll('#main .panel')].find((s) => { const h = s.querySelector('.panel-head h2'); return h && p.title.test(h.textContent); }) || null : null;
  };
  const tileEl = (key) => {
    const m = GI.METRICS[key];
    const hp = m && m.tile && panelEl('headline');
    return (hp && [...hp.querySelectorAll('.tile')].find((t) => { const l = t.querySelector('.label'); return l && l.textContent === m.tile; })) || null;
  };
  function citeEl(ref) {
    if (ref.kind === 'panel') return panelEl(ref.key);
    if (ref.kind !== 'metric') return null;
    const m = GI.METRICS[ref.key];
    return tileEl(ref.key) || (m && m.panel ? panelEl(m.panel) : null);
  }
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const pulseTimers = new WeakMap();
  function pulse(t) {
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    t.classList.remove('cite-pulse');
    void t.offsetWidth; // restart the animation
    t.classList.add('cite-pulse');
    clearTimeout(pulseTimers.get(t));
    pulseTimers.set(t, setTimeout(() => t.classList.remove('cite-pulse'), 1600));
  }
  // Hovering or focusing a source outlines what it cites.
  function citeHover(node, refs) {
    const set = (on) => refs().forEach((r) => { const t = citeEl(r); if (t) t.classList.toggle('cite-hl', on); });
    node.addEventListener('mouseenter', () => set(true));
    node.addEventListener('mouseleave', () => set(false));
    node.addEventListener('focusin', () => set(true));
    node.addEventListener('focusout', () => set(false));
  }
  function refNode(ref, label) {
    const href = refHref(ref);
    if (href) { const a = el('a', 'ref', label); a.href = href; return a; }
    if (!citeEl(ref)) return null;
    const b = el('button', 'ref', label);
    b.type = 'button';
    b.title = 'Show on the overview';
    b.addEventListener('click', () => pulse(citeEl(ref)));
    return b;
  }
  // Text with its references linked (first mention of each per field); refs collects them.
  function withRefs(str, refs) {
    const frag = document.createDocumentFragment();
    const seen = new Set();
    let at = 0;
    for (const m of GI.findRefs(str, refIndex())) {
      const k = GI.refKey(m.ref);
      if (seen.has(k)) continue;
      const node = refNode(m.ref, m.text);
      if (!node) continue;
      seen.add(k);
      refs.set(k, m.ref);
      frag.append(str.slice(at, m.start), node);
      at = m.end;
    }
    frag.append(str.slice(at));
    return frag;
  }

  const goalValue = (key, v) => {
    const f = GI.METRICS[key].format;
    return f === 'money' ? moneyFull(v) : f === 'pct' ? (isNum(v) ? `${v.toFixed(1)}%` : DASH) : int(v);
  };
  const goalTarget = (g) => `${GI.METRICS[g.metric].better === 'down' ? 'at most ' : ''}${goalValue(g.metric, g.target)}`;
  // The metric line under a goal; a competitor goal names its competitor.
  const goalMetricLabel = (g) => (GI.METRICS[g.metric].competitor ? `Closed lost to ${g.competitor}` : GI.METRICS[g.metric].label);
  function goalTile(g, values) {
    const m = GI.METRICS[g.metric];
    const p = GI.goalProgress(g, GI.goalValue(g, D, values));
    const t = el('div', 'tile goal');
    t.append(el('div', 'label', g.label));
    const v = el('div', 'value', p.value == null ? DASH : goalValue(g.metric, p.value));
    v.append(el('span', 'goal-of', `${m.better === 'down' ? 'limit' : 'of'} ${goalValue(g.metric, g.target)}`));
    t.append(v);
    const bar = el('div', `goal-bar${p.over ? ' over' : ''}`);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', p.value == null ? 'Current value unknown' : `${Math.round(p.ratio * 100)}% of ${m.better === 'down' ? 'the limit' : 'the goal'}${p.met ? ', met' : ''}`);
    const fill = el('span');
    fill.style.width = `${(p.ratio * 100).toFixed(1)}%`;
    bar.append(fill);
    t.append(bar);
    const foot = el('div', 'foot');
    const ref = { kind: 'metric', key: g.metric };
    foot.append(refNode(ref, goalMetricLabel(g)) || el('span', null, goalMetricLabel(g)));
    if (g.by) {
      foot.append(` · by ${fmtDay(g.by)}`);
      if (g.by < todayYmd() && p.met === false) foot.append(' ', el('span', 'flag', 'passed'));
    }
    if (p.met) foot.append(' ', el('span', 'pill green', 'met'));
    t.append(foot);
    if (g.metric === 'commit_stage_amount') {
      const st = GI.commitStages(D).map((x) => x.label);
      if (st.length) t.append(el('div', 'foot muted', `${st.join(', ')} (≥ ${Math.round(GI.COMMIT_PROBABILITY * 100)}% probability)`));
    }
    if (g.note) t.append(el('div', 'foot muted', g.note));
    citeHover(t, () => [ref]);
    return t;
  }
  // The "Goal" line under a headline tile; cleared first, so repeated fills don't stack.
  function markTiles(goals) {
    document.querySelectorAll('#main .tile-goal').forEach((n) => n.remove());
    for (const g of goals) {
      const t = tileEl(g.metric);
      if (!t) continue;
      const line = el('div', 'foot tile-goal', `Goal: ${goalTarget(g)}${g.by ? ` by ${fmtDay(g.by)}` : ''}`);
      line.title = g.label;
      t.append(line);
    }
  }

  function insightItem(it) {
    const refs = new Map();
    const li = el('li', 'insight');
    const head = el('div', 'insight-head');
    const h = el('h3');
    h.append(withRefs(it.title, refs));
    const meta = el('span', 'insight-meta');
    meta.append(el('span', null, it.owner), el('span', `pill${it.confidence === 'high' ? ' green' : it.confidence === 'low' ? ' warn' : ''}`, `${it.confidence} confidence`));
    head.append(h, meta);
    const play = el('p', 'insight-play');
    play.append(el('span', 'kind', 'Play'), withRefs(it.recommended_play, refs));
    const more = el('details', 'insight-more');
    const cites = Array.isArray(it.citations) ? it.citations : [];
    more.append(el('summary', 'source-tag', `Evidence and why${cites.length ? ` · ${plural(cites.length, 'source')}` : ''}`));
    for (const [lbl, val] of [['Evidence', it.evidence], ['Why it matters', it.why_it_matters]]) {
      const p = el('p');
      p.append(el('span', 'kind', lbl), withRefs(val, refs));
      more.append(p);
    }
    if (cites.length) {
      const ul = el('ul');
      for (const c of cites) { const x = el('li'); x.append(withRefs(c, refs)); ul.append(x); }
      more.append(ul);
    }
    li.append(head, play, more);
    citeHover(li, () => [...refs.values()]);
    return li;
  }

  function fillAnalysis() {
    const box = document.getElementById('analysis');
    if (!box) return;
    box.replaceChildren();
    const head = el('div', 'panel-head');
    const left = el('div');
    left.append(el('h2', null, 'Analysis'));
    const right = el('div');
    if (analysis.state === 'ok') right.append(el('span', 'updated', `Generated ${fmtUpdated(analysis.doc.generated_at)}`));
    head.append(left, right);
    box.append(head);
    if (analysis.state !== 'ok') {
      markTiles([]);
      const e = el('div', 'empty');
      e.append(el('strong', null, analysis.state === 'loading' ? 'Loading analysis…' : 'No insights published yet'));
      if (analysis.state === 'invalid') e.append('A file was published but it does not match the expected format, so it is not shown.');
      if (analysis.state === 'unreachable') e.append('The analysis file could not be loaded.');
      box.append(e);
      return;
    }
    const doc = analysis.doc;
    const lead = el('p', 'analysis-lead');
    lead.append(withRefs(doc.headline, new Map()));
    box.append(lead);
    const goals = doc.goals || [];
    const list = el('ol', `brief analysis-list${goals.length ? '' : ' cols'}`);
    for (const it of doc.insights) list.append(insightItem(it));
    if (goals.length) {
      const values = GI.metricValues(D);
      const grid = el('div', 'grid analysis-grid');
      const main = el('div', 'span-8');
      main.append(list);
      const side = el('div', 'side span-4');
      side.append(el('h4', null, 'Goals'));
      const gl = el('div', 'goal-list');
      for (const g of goals) gl.append(goalTile(g, values));
      side.append(gl);
      grid.append(main, side);
      box.append(grid);
    } else box.append(list);
    markTiles(goals);
    // Changes and data caveats: one muted line each; the caveats open on click.
    const ch = [].concat(doc.changed_since_last);
    const foot = el('div', 'analysis-foot');
    if (ch.length) foot.append(el('p', null, `Since the last version: ${ch.join(' · ')}`));
    if (doc.data_quality_flags.length) {
      const d = el('details');
      d.append(el('summary', 'source-tag', plural(doc.data_quality_flags.length, 'data caveat')));
      const ul = el('ul');
      for (const f of doc.data_quality_flags) ul.append(el('li', null, GI.flagText(f)));
      d.append(ul);
      foot.append(d);
    }
    if (foot.childElementCount) box.append(foot);
  }
  function loadAnalysis() {
    if (!window.fetch || !GI) { analysis = { state: 'unreachable' }; fillAnalysis(); return; }
    fetch('insights.json', { cache: 'no-store' })
      .then((r) => {
        // S3 behind CloudFront answers 403 for a key that doesn't exist.
        if (r.status === 404 || r.status === 403) return { state: 'missing' };
        if (!r.ok) return { state: 'unreachable' };
        return r.text().then((t) => { const v = GI.parse(t); return v.ok ? { state: 'ok', doc: v.doc } : { state: 'invalid' }; });
      })
      .catch(() => ({ state: 'unreachable' }))
      .then((a) => { analysis = a; fillAnalysis(); });
  }

  // ---------- boot ----------
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 120); });
  window.addEventListener('hashchange', render);
  if (!location.hash || location.hash === '#' || location.hash === '#/') history.replaceState(null, '', '#/overview');
  render();
  showRefreshed();
  loadRefresh();
  loadAnalysis();
})();
