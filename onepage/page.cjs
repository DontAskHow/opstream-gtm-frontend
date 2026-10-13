// The one-page GTM workspace: render functions (view model -> HTML) and the
// browser behaviour (hash state, expand rows, lists, drawer). The same file runs
// in Node (onepage/build.mjs renders the first paint) and in the page (inlined),
// so every component exists once: tile, chip, table, expand row, list, drawer, bar.
// No data lives here; everything comes from the view model.
(function (root) {
  'use strict';

  const TZ = 'America/Phoenix';
  const DASH = '—';
  const PAGE_SIZE = 25;

  // ---------- formatting ----------
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const int = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : DASH);
  const usd = (v) => (isNum(v) ? (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US') : DASH);
  const pct = (v, digits = 1) => (isNum(v) ? (v * 100).toFixed(digits) + '%' : DASH);
  const plural = (n, one, many) => `${int(n)} ${n === 1 ? one : many || one + 's'}`;
  const parseT = (s) => {
    if (!s) return null;
    const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00-07:00' : s);
    return Number.isNaN(t.getTime()) ? null : t;
  };
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
  const F_DATE = fmt({ month: 'short', day: 'numeric', year: 'numeric' });
  const F_DAY = fmt({ month: 'short', day: 'numeric' });
  const F_TIME = fmt({ hour: 'numeric', minute: '2-digit' });
  const F_YM = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' });
  const F_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const date = (s) => { const t = parseT(s); return t ? F_DATE.format(t) : DASH; };
  const dateTime = (s) => { const t = parseT(s); return t ? `${F_DAY.format(t)}, ${F_TIME.format(t)} PT` : DASH; };
  const ymd = (s) => { const t = parseT(s); return t ? F_YMD.format(t) : null; };

  // ---------- hash state ----------
  function parseState(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const s = {};
    for (const [k, v] of p) if (v !== '') s[k] = v;
    return s;
  }
  function stateHash(s) {
    const p = new URLSearchParams();
    for (const k of Object.keys(s).sort()) if (s[k] != null && s[k] !== '') p.set(k, s[k]);
    const h = p.toString();
    return h ? '#' + h : '';
  }
  const DRAWERS = ['lead', 'mtg', 'call', 'deal'];
  // A data-set / data-toggle value applied to a state.
  function applyChange(state, spec, toggle) {
    const next = { ...state };
    const p = new URLSearchParams(spec);
    if (DRAWERS.some((k) => p.has(k) && p.get(k))) for (const k of DRAWERS) delete next[k];
    for (const [k, v] of p) {
      if (toggle && next[k] === v) delete next[k];
      else if (v === '') delete next[k];
      else next[k] = v;
    }
    return next;
  }

  // ---------- components ----------
  const attrs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` ${k}="${esc(v === true ? '' : v)}"`).join('');
  const link = (label, spec, cls) => `<button type="button" class="${cls || 'lnk'}" data-set="${esc(spec)}">${label}</button>`;

  function chip(text, level, title) {
    return `<span class="chip chip-${level || 'neutral'}"${title ? ` title="${esc(title)}"` : ''}>${level === 'ok' ? '<i class="dot" aria-hidden="true"></i>' : ''}${esc(text)}</span>`;
  }

  function tile(label, value, sub, extra) {
    return `<div class="tile"${extra || ''}><div class="tile-l">${esc(label)}</div><div class="tile-v num">${value}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;
  }

  // The one bar: a magnitude next to its own label. Muted for de-emphasised rows.
  function bar(value, max, muted) {
    const w = isNum(value) && max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
    return `<span class="bar${muted ? ' bar-muted' : ''}" aria-hidden="true"><span style="width:${w}%"></span></span>`;
  }

  // The one table. cols: [{label, num, opt}]; rows: [{cells, toggle, expanded, expand, cls}].
  function table(cols, rows, opts = {}) {
    const head = cols.map((c) => `<th${attrs({ class: [c.num && 'num', c.opt && 'opt'].filter(Boolean).join(' ') || null, scope: 'col' })}>${c.label}</th>`).join('');
    const body = rows.map((r) => {
      const cls = [r.cls, r.toggle && 'rowbtn', r.expanded && 'open'].filter(Boolean).join(' ');
      const tr = `<tr${attrs({ class: cls || null, 'data-toggle': r.toggle || null, tabindex: r.toggle ? 0 : null, 'aria-expanded': r.toggle ? String(!!r.expanded) : null })}>` +
        r.cells.map((v, i) => `<td${attrs({ class: [cols[i].num && 'num', cols[i].opt && 'opt', i === 0 && r.toggle && 'caret'].filter(Boolean).join(' ') || null })}>${v}</td>`).join('') + '</tr>';
      return tr + (r.expanded && r.expand ? `<tr class="xrow"><td colspan="${cols.length}"><div class="xbox">${r.expand}</div></td></tr>` : '');
    }).join('');
    const foot = opts.foot ? `<tfoot><tr>${opts.foot.map((v, i) => `<td${attrs({ class: [cols[i].num && 'num', cols[i].opt && 'opt'].filter(Boolean).join(' ') || null })}>${v}</td>`).join('')}</tr></tfoot>` : '';
    return `<div class="tablewrap"><table${opts.id ? ` id="${esc(opts.id)}"` : ''}><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
  }

  // The one list (inside an expand row): search, sort, 25 per page, row -> drawer.
  // Its search/sort/page live in LISTS (memory) so typing does not re-render the page.
  const LISTS = {};
  function list(id, cols, items, opts) {
    const st = LISTS[id] || (LISTS[id] = { q: '', sort: opts.sort || null, dir: opts.dir || 'desc', page: 0 });
    LISTS[id].def = { cols, items, opts };
    return `<div class="list" data-list="${esc(id)}"><div class="list-bar"><input type="search" class="search" placeholder="Search ${esc(opts.noun || 'rows')}" aria-label="Search ${esc(opts.noun || 'rows')}" value="${esc(st.q)}" data-q="${esc(id)}"><span class="muted list-count"></span></div><div class="list-body">${listBody(id)}</div></div>`;
  }
  function listRows(id) {
    const st = LISTS[id], { cols, items, opts } = st.def;
    const q = st.q.trim().toLowerCase();
    let xs = q ? items.filter((x) => (opts.text(x) || '').toLowerCase().includes(q)) : items.slice();
    const col = cols.find((c) => c.key === st.sort);
    if (col) {
      const k = col.sortVal || ((x) => x[col.key]);
      const dir = st.dir === 'asc' ? 1 : -1;
      xs.sort((a, b) => { const va = k(a), vb = k(b); return (va == null) - (vb == null) || (va < vb ? -dir : va > vb ? dir : 0); });
    }
    return xs;
  }
  function listBody(id) {
    const st = LISTS[id], { cols, opts } = st.def;
    const xs = listRows(id);
    const pages = Math.max(1, Math.ceil(xs.length / PAGE_SIZE));
    st.page = Math.min(st.page, pages - 1);
    const shown = xs.slice(st.page * PAGE_SIZE, (st.page + 1) * PAGE_SIZE);
    const head = cols.map((c) => `<th${attrs({ class: [c.num && 'num', c.opt && 'opt'].filter(Boolean).join(' ') || null, scope: 'col', 'aria-sort': st.sort === c.key ? (st.dir === 'asc' ? 'ascending' : 'descending') : null })}><button type="button" class="sort" data-sort="${esc(id)}:${esc(c.key)}">${esc(c.label)}${st.sort === c.key ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`).join('');
    const body = shown.map((x) => `<tr class="rowbtn${opts.active && opts.active(x) ? ' active' : ''}" data-set="${esc(opts.target(x))}" tabindex="0">${cols.map((c) => `<td${attrs({ class: [c.num && 'num', c.opt && 'opt'].filter(Boolean).join(' ') || null })}>${c.cell(x)}</td>`).join('')}</tr>`).join('');
    const pager = pages > 1 ? `<div class="pager"><button type="button" data-page="${esc(id)}:-1"${st.page === 0 ? ' disabled' : ''}>Previous</button><span class="muted">Page ${st.page + 1} of ${pages}</span><button type="button" data-page="${esc(id)}:1"${st.page >= pages - 1 ? ' disabled' : ''}>Next</button></div>` : '';
    const empty = xs.length ? '' : `<p class="empty">${esc(opts.empty || 'Nothing to list.')}</p>`;
    return `<div class="tablewrap"><table class="ltable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${empty}${pager}<p class="muted small list-n">${plural(xs.length, opts.noun1 || 'row', opts.noun || 'rows')}</p>`;
  }

  // The one drawer: title, chips, then labelled sections (each [label, html]).
  function drawer(title, chips, sections) {
    return `<div class="scrim" data-set="lead=&mtg=&call=&deal="></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1">
<header class="drawer-head"><h2 id="drawer-title">${title}</h2><button type="button" class="close" data-set="lead=&mtg=&call=&deal=" aria-label="Close">×</button></header>
${chips ? `<div class="chips">${chips}</div>` : ''}
${sections.filter((s) => s && s[1]).map(([label, html]) => `<section class="dsec"><h3>${esc(label)}</h3>${html}</section>`).join('')}
</aside>`;
  }
  const kv = (pairs) => `<dl class="kv">${pairs.filter((p) => p && p[1] != null && p[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

  function section(id, title, sub, body, right) {
    return `<section class="sec" id="${id}" aria-labelledby="${id}-h"><header class="sec-head"><div><h2 id="${id}-h">${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${right || ''}</header>${body}</section>`;
  }

  // Each section's ranges; "This week" (with its dates) is the default everywhere.
  const RANGES = {
    lp: [['week'], ['month', 'This month'], ['90', '90 days'], ['ytd', 'This year'], ['all', 'All time']],
    mp: [['week'], ['month', 'This month'], ['upcoming', 'Upcoming'], ['30', '30 days'], ['90', '90 days']],
    cp: [['week'], ['month', 'This month'], ['30', '30 days'], ['90', '90 days']],
  };
  const DEFAULT_RANGE = 'week';
  const rangeOf = (s, key) => (RANGES[key].some(([k]) => k === s[key]) ? s[key] : DEFAULT_RANGE);
  const rangeOptions = (key, v) => RANGES[key].map(([k, l]) => [k, k === 'week' ? `This week · ${weekWindow(v.meta.asOf).label}` : l]);

  // "+2 vs last week (Oct 5–6: 3)"; a percentage only when both weeks have at least 5.
  function weekDelta(cur, prev, label) {
    const d = cur - prev;
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    const p = cur >= 5 && prev >= 5 ? ` · ${d >= 0 ? '+' : '−'}${Math.round((Math.abs(d) / prev) * 100)}%` : '';
    const small = cur < 5 || prev < 5 ? ' <span class="muted">(n&lt;5: no %)</span>' : '';
    return `<span class="delta">${sign}${int(Math.abs(d))} vs last week (${esc(label)}: ${int(prev)})${p}</span>${small}`;
  }

  function periodPicker(key, value, options) {
    return `<div class="seg" role="group" aria-label="Period">${options.map(([v, label]) => `<button type="button" data-set="${esc(key)}=${esc(v)}" aria-pressed="${String(value === v)}">${esc(label)}</button>`).join('')}</div>`;
  }

  // ---------- periods ----------
  // ---------- the week: Monday 00:00 to the end of today, America/Phoenix (no DST: UTC-7) ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ymdParts = (d) => d.split('-').map(Number);
  const ymdShift = (d, days) => { const [y, m, dd] = ymdParts(d); return new Date(Date.UTC(y, m - 1, dd + days)).toISOString().slice(0, 10); };
  const ymdLabel = (d) => { const [, m, dd] = ymdParts(d); return `${MONTHS[m - 1]} ${dd}`; };
  function rangeLabel(a, b) {
    if (a === b) return ymdLabel(a);
    return a.slice(0, 7) === b.slice(0, 7) ? `${ymdLabel(a)}–${ymdParts(b)[2]}` : `${ymdLabel(a)} – ${ymdLabel(b)}`;
  }
  // back = 0: this week (Monday to today); back = 1: last week, Monday to the same weekday.
  function weekWindow(asOf, back = 0) {
    const today = F_YMD.format(parseT(asOf));
    const [y, m, d] = ymdParts(today);
    const sinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const startYmd = ymdShift(today, -sinceMonday - 7 * back);
    const endYmd = ymdShift(today, -7 * back);
    return { startYmd, endYmd, start: Date.parse(startYmd + 'T00:00:00-07:00'), end: Date.parse(endYmd + 'T23:59:59.999-07:00'), label: rangeLabel(startYmd, endYmd) };
  }

  function inPeriod(iso, period, asOf) {
    const t = parseT(iso);
    if (!t) return false;
    if (period === 'week' || period === 'lastweek') {
      const w = weekWindow(asOf, period === 'lastweek' ? 1 : 0);
      // A date (no time) belongs to its own day; a time is compared as an instant.
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso >= w.startYmd && iso <= w.endYmd;
      return t.getTime() >= w.start && t.getTime() <= w.end;
    }
    const now = parseT(asOf);
    const ym = F_YM.format(now);
    switch (period) {
      case 'month': return F_YM.format(t) === ym;
      case 'upcoming': return t >= now;
      case 'ytd': return F_YM.format(t).slice(0, 4) === ym.slice(0, 4) && t <= now;
      case 'all': return true;
      default: { const days = Number(period); return t <= now && t >= new Date(now.getTime() - days * 864e5); }
    }
  }

  const hsUrl = (v, type, id) => (v.meta.portalId ? `https://app.hubspot.com/contacts/${encodeURIComponent(v.meta.portalId)}/record/${type}/${encodeURIComponent(id)}` : null);
  const ext = (href, label) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : '');

  // ---------- header ----------
  const STALE_MS = 45 * 60e3;
  const NAV = `<nav class="jump" aria-label="Sections">${[['pipeline', 'Pipeline'], ['leads', 'Leads'], ['meetings', 'Meetings'], ['calls', 'Calls'], ['analysis', 'Analysis']].map(([id, l]) => `<button type="button" data-jump="${id}">${l}</button>`).join('')}</nav>`;
  const LIVE_PROBLEMS = {
    'snapshot-has-no-workspace-json': 'the latest snapshot has no workspace.json',
    'workspace-json-invalid': 'the latest workspace.json did not pass its checks',
    'workspace-scrub-patterns-missing': 'the refresh has no scrub patterns configured',
    'workspace-withheld-scrub-match': 'the data is withheld (a name that must not appear was found)',
  };

  // "Updated <time> PT" from the data's own build time; amber once it is older than 45 minutes.
  function updatedChip(v, now) {
    const u = v.meta.generatedAt || v.meta.asOf;
    const t = parseT(u);
    const old = !t || now - t.getTime() > STALE_MS;
    return `<span class="chip chip-${old ? 'warn' : 'ok'}" data-updated="${esc(u || '')}"${old ? ' title="The data is more than 45 minutes old: the sync or the refresh may be behind."' : ''}>${old ? '' : '<i class="dot" aria-hidden="true"></i>'}Updated ${esc(dateTime(u))}${old ? ' · over 45 min ago' : ''}</span>`;
  }

  function header(v, opts = {}) {
    const now = opts.now != null ? opts.now : Date.now();
    const fresh = v.freshness.map((f) => f.ok
      ? chip(`${f.label} ${f.lastOkAt ? dateTime(f.lastOkAt).replace(/^.*?, /, '') : DASH}`, 'ok', `${f.label}: last good ${dateTime(f.lastOkAt)}. ${f.detail || ''}`)
      : chip(`${f.label} down · last good ${dateTime(f.lastOkAt)}`, 'alert', `${f.label} failed at ${dateTime(f.at)}: ${f.detail || ''}. The page shows its last good data.`)).join('');
    const flags = v.flags.filter((f) => f.level !== 'alert').map((f) => chip(f.label, f.level, f.text)).join('');
    const live = v.live && v.live.problem ? chip(`Showing the last good data: ${LIVE_PROBLEMS[v.live.problem] || v.live.problem}`, 'alert', `Checked ${dateTime(v.live.checkedAt)}`) : '';
    return `<header class="top"><div class="top-in">
<div class="brand"><h1>GTM workspace</h1><p class="sub">Sales Pipeline · ${updatedChip(v, now)}</p></div>
${NAV}
</div><div class="top-in chips" aria-label="Data freshness">${live}${fresh}${flags}</div></header>`;
  }

  function loadingHeader(note) {
    return `<header class="top"><div class="top-in"><div class="brand"><h1>GTM workspace</h1><p class="sub">${esc(note || 'Loading…')}</p></div>${NAV}</div></header>`;
  }

  function errorView(message) {
    return `<section class="sec error" role="alert"><h2>The workspace data could not be loaded</h2><p>${esc(message)}</p>
<p class="muted small">The page reads workspace.json from this site. If this keeps happening, the scheduled refresh may not have published it yet.</p>
<p><button type="button" class="btn" data-retry="1">Try again</button></p></section>`;
  }

  // ---------- pipeline ----------
  function headlineBlock(v, s) {
    const h = v.headline;
    const c = h.change;
    let note = '';
    if (c && c.changed) {
      const kinds = { new: 'new', in: 'moved in', out: 'moved out', amount: 'amount changed', stage: 'stage' };
      const rows = c.deals.map((d) => `<li><span class="tag">${esc(kinds[d.kind])}</span> ${link(esc(d.name), 'deal=' + d.id)} · ${d.fromStage ? esc(d.fromStage) + ' → ' : ''}${esc(d.toStage || 'not open')} · <span class="num">${usd(d.amount)}</span>${d.kind === 'new' && d.created ? ` <span class="muted">created ${esc(dateTime(d.created))}</span>` : ''}</li>`).join('');
      note = `<div class="note" data-note="${esc(c.key)}" role="status"><button type="button" class="close" data-dismiss="${esc(c.key)}" aria-label="Dismiss">×</button>
<p><strong>What changed:</strong> open deals went from <span class="num">${int(c.from.count)}</span> / <span class="num">${usd(c.from.amount)}</span> to <span class="num">${int(c.to.count)}</span> / <span class="num">${usd(c.to.amount)}</span> since ${esc(dateTime(c.since))}.</p><ul class="moved">${rows}</ul><p class="muted small">${esc(c.basis)}</p></div>`;
    }
    return `<div class="tiles">${tile('Open deals', int(h.open.count), 'Sales Pipeline, On Hold excluded', ' data-fig="open-count"')}${tile('Open amount', usd(h.open.amount), '', ' data-fig="open-amount"')}${tile('Weighted', usd(h.open.weighted), 'amount × HubSpot stage probability', ' data-fig="weighted"')}${tile('On Hold', int(h.onHold.count), `<span class="num">${usd(h.onHold.amount)}</span>${h.onHold.noAmount ? ` · ${int(h.onHold.noAmount)} without amount` : ''}`, ' data-fig="on-hold"')}</div>${note}`;
  }

  function pipelineSection(v, s) {
    const h = v.headline;
    const max = Math.max(...h.stages.map((x) => x.amount || 0));
    const stageRows = h.stages.map((x) => ({
      cls: x.onHold ? 'muted-row' : null,
      cells: [esc(x.label) + (x.onHold ? ' <span class="muted small">(not in open totals)</span>' : ''), int(x.count), `<span class="barcell">${bar(x.amount, max, x.onHold)}<span class="num">${usd(x.amount)}</span></span>`, usd(x.weighted), isNum(x.probability) ? pct(x.probability, 0) : DASH],
    }));
    const stages = table([{ label: 'Stage' }, { label: 'Deals', num: true }, { label: 'Amount', num: true }, { label: 'Weighted', num: true, opt: true }, { label: 'Probability', num: true, opt: true }], stageRows,
      { foot: ['Open (excl. On Hold)', int(h.open.count), `<span class="num">${usd(h.open.amount)}</span>`, usd(h.open.weighted), ''] });
    const all = s.deals === 'all';
    const open = v.deals.filter((d) => !d.onHold);
    const shown = all ? v.deals : open.slice(0, 10);
    const now = parseT(v.meta.asOf);
    const dealRows = shown.map((d) => ({ cls: 'rowbtn' + (s.deal === d.id ? ' active' : ''), cells: [link(esc(d.name), 'deal=' + d.id), esc(d.stage), usd(d.amount), esc(d.owner), (parseT(d.close) && parseT(d.close) < now ? '<span class="warn-t" title="Close date has passed">' + esc(date(d.close)) + '</span>' : esc(date(d.close)))] }));
    const deals = table([{ label: 'Deal' }, { label: 'Stage', opt: true }, { label: 'Amount', num: true }, { label: 'Owner', opt: true }, { label: 'Close', opt: true }], dealRows);
    const more = link(all ? 'Show the top 10 only' : `Show all ${int(v.deals.length)} open deals (incl. On Hold)`, all ? 'deals=' : 'deals=all', 'btn');
    return section('pipeline', 'Pipeline', 'Sales Pipeline only. Renewal, Partnerships and Customer Success pipelines are not on this page.',
      `${headlineBlock(v, s)}<h3>Open deals by stage</h3>${stages}<h3>Largest open deals</h3>${deals}<p>${more}</p>${lostBlock(v, s)}`);
  }

  function lostBlock(v, s) {
    const c = v.closed;
    const by = Object.fromEntries(c.lostByStage.map((x) => [x.stage, x]));
    const tiles = c.lostByStage.map((x) => tile(x.stage, int(x.count), usd(x.amount), ` data-fig="lost-${esc(x.stage.toLowerCase().replace(/\W+/g, '-'))}"`)).join('') + tile('Closed won', int(c.won.count), usd(c.won.amount));
    const r = c.reasons;
    let body = '';
    if (r) {
      const stagesSeen = c.lostByStage.map((x) => x.stage);
      const max = Math.max(...r.rows.map((x) => x.count));
      const rows = r.rows.map((x) => ({
        toggle: 'lost=' + x.key, expanded: s.lost === x.key,
        cells: [esc(x.label) + (x.competitors.length ? `<div class="muted small">${x.competitors.slice(0, 4).map((k) => esc(k.name) + ' ' + k.count).join(' · ')}${x.unnamed ? ` · unnamed ${x.unnamed}` : ''}</div>` : ''),
          ...stagesSeen.map((st) => int(x.byStage[st] || 0)), `<span class="barcell">${bar(x.count, max)}<span class="num">${int(x.count)}</span></span>`, usd(x.amount)],
        expand: s.lost === x.key ? list('lost-' + x.key, [
          { key: 'name', label: 'Deal', cell: (d) => esc(d.name) },
          { key: 'stage', label: 'Stage', opt: true, cell: (d) => esc(d.stage) },
          { key: 'amount', label: 'Amount', num: true, cell: (d) => usd(d.amount) },
          { key: 'reason', label: 'HubSpot reason', opt: true, cell: (d) => (d.reason ? esc(d.reason) : '<span class="muted">none</span>') + (d.basis ? `<div class="muted small">${esc(d.basis)}${d.source === 'inferred' ? ' (inferred)' : ''}</div>` : '') },
        ], x.deals, { sort: 'amount', noun: 'deals', noun1: 'deal', target: (d) => 'deal=' + d.id, active: (d) => s.deal === d.id, text: (d) => [d.name, d.reason, d.basis, d.competitor].join(' ') }) : null,
      }));
      body = table([{ label: 'Why lost' }, ...stagesSeen.map((st) => ({ label: esc(st), num: true, opt: true })), { label: 'Deals', num: true }, { label: 'Amount', num: true }], rows) +
        `<p class="muted small">${esc(r.basis)} ${esc(c.reasonsNote)}${c.lost.some((d) => d.postWin) ? ` Expansion losses at customers (not categorized): ${c.lost.filter((d) => d.postWin).map((d) => link(esc(d.name), 'deal=' + d.id)).join(', ')}.` : ''}</p>`;
    }
    return `<h3>Closed</h3><div class="tiles">${tiles}</div>${body}`;
  }

  // ---------- leads ----------
  function leadsIn(v, period) { return v.leads.items.filter((l) => period === 'all' || inPeriod(l.leadDate, period, v.meta.asOf)); }

  function leadsSection(v, s) {
    const L = v.leads;
    if (!L.connected) return section('leads', 'Leads', esc(L.reason || 'The Lead Tracker is not in the data.'), '');
    const period = rangeOf(s, 'lp');
    const items = leadsIn(v, period);
    const mql = items.filter((l) => l.mql).length;
    const week = period === 'week' ? weekWindow(v.meta.asOf) : null;
    const last = week ? leadsIn(v, 'lastweek') : null;
    const lastLabel = week ? weekWindow(v.meta.asOf, 1).label : '';
    const f = v.mqlFunnel;
    // The r12 lead → MQL rate shows only when its inputs exist; otherwise there is no tile at all.
    const funnel = f && f.available ? tile(f.label, pct(f.rate), `<span class="num">${int(f.numerator)}</span> booked via book-a-demo ÷ <span class="num">${int(f.denominator)}</span> form-filling contacts`, ' data-fig="lead-mql-90"') : '';
    const tiles = `<div class="tiles">${tile('Leads', int(items.length), week ? weekDelta(items.length, last.length, lastLabel) : 'companies on the Lead Tracker', ' data-fig="leads"')}${tile('Source from HubSpot', int(items.filter((l) => l.sourceBasis === 'hubspot').length), `of ${int(items.length)}; the rest fall back to the Lead Tracker`, ' data-fig="hubspot-sourced"')}${tile('Sheet MQL (incl. SQL)', int(mql), week ? weekDelta(mql, last.filter((l) => l.mql).length, lastLabel) : `${int(items.filter((l) => l.sql).length)} SQL · Lead Tracker dates`, ' data-fig="mql"')}${funnel}</div>`;
    const max = Math.max(1, ...L.sources.map((src) => items.filter((l) => l.source === src).length));
    const rows = L.sources.map((src) => {
      const xs = items.filter((l) => l.source === src);
      const open = s.src === src;
      return {
        toggle: 'src=' + src + '&sub=', expanded: open,
        cells: [esc(src), `<span class="barcell">${bar(xs.length, max)}<span class="num">${int(xs.length)}</span></span>`, int(xs.filter((l) => l.sourceBasis === 'hubspot').length),
          int(xs.filter((l) => l.mql).length), int(xs.filter((l) => l.deals.length).length), usd(xs.reduce((a, l) => a + (l.openAmount || 0), 0)),
          xs.some((l) => l.review) ? `<span class="warn-t">${int(xs.filter((l) => l.review).length)}</span>` : ''],
        expand: open ? sourceDetail(v, s, src, xs) : null,
      };
    });
    const cols = [{ label: 'Source' }, { label: 'Leads', num: true }, { label: 'From HubSpot', num: true, opt: true }, { label: 'Sheet MQL', num: true }, { label: 'With a deal', num: true, opt: true }, { label: 'Open pipeline', num: true, opt: true }, { label: 'To review', num: true, opt: true }];
    if (week) {
      cols.splice(2, 0, { label: `Last week (${esc(lastLabel)})`, num: true, opt: true });
      rows.forEach((r, i) => r.cells.splice(2, 0, int(last.filter((l) => l.source === L.sources[i]).length)));
    }
    const foot = ['All sources', int(items.length), int(items.filter((l) => l.sourceBasis === 'hubspot').length), int(mql), int(items.filter((l) => l.deals.length).length), usd(items.reduce((a, l) => a + (l.openAmount || 0), 0)), int(items.filter((l) => l.review).length)];
    if (week) foot.splice(2, 0, int(last.length));
    const tbl = (items.length ? '' : `<p class="empty" data-empty="leads">No leads yet ${week ? `this week (${esc(week.label)})` : 'in this range'}.${week ? ` Last week (${esc(lastLabel)}): ${int(last.length)}.` : ''}</p>`) +
      (items.length || !week ? table(cols, rows, { foot }) : '');
    const ns = v.meta.notSynced.length ? `<p class="muted small">${chip('not yet synced', 'info')} ${esc(v.meta.notSynced.join(', '))}: until they sync, most leads fall back to the Lead Tracker Source. ${esc(L.definition)}</p>` : `<p class="muted small">${esc(L.definition)}</p>`;
    return section('leads', 'Leads', `${esc(L.sheet.tab)} companies; Source from HubSpot first (where the conversion happened), else the Lead Tracker. Rules: lead-sources.json + answers of ${esc(dateTime(v.rules.answeredAt))} ${chip(v.meta.provisional, 'warn')}`,
      `${tiles}${tbl}${ns}${reviewBlock(v, s)}${paidDealsBlock(v, s)}${platformBlock(v)}${outboundBlock(v, s)}`, periodPicker('lp', period, rangeOptions('lp', v)));
  }

  function sourceDetail(v, s, src, xs) {
    const subs = new Map();
    for (const l of xs) { const k = l.subSource || 'No sub-source'; subs.set(k, (subs.get(k) || 0) + 1); }
    const chips = [...subs].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<button type="button" class="chip chip-btn${s.sub === k ? ' on' : ''}" data-set="sub=${encodeURIComponent(s.sub === k ? '' : k)}" aria-pressed="${String(s.sub === k)}">${esc(k)} <b class="num">${int(n)}</b></button>`).join('');
    let callout = '';
    if (src === 'Paid' && v.leads.platforms.length) {
      callout = `<p class="small">${v.leads.platforms.map((p) => `<b>${esc(p.name)}</b>: ${int(p.confirmed)} named${p.confirmed !== p.trackerNamed ? ` (${int(p.trackerNamed)} by Lead Tracker notes alone)` : ''}${p.possible ? `, at most ${int(p.atMost)} <span class="muted">(+${int(p.possible)} with no platform named whose note matches a ${esc(p.name)} conversion event)</span>` : ''}`).join(' · ')}</p>`;
    }
    const rows = s.sub ? xs.filter((l) => (l.subSource || 'No sub-source') === s.sub) : xs;
    const lst = list('leads-' + src + '-' + (s.sub || ''), [
      { key: 'company', label: 'Company', cell: (l) => esc(l.company) + (l.tag ? ` <span class="tag">${esc(l.tag)}</span>` : '') + (l.predatesSpendWindow ? ' <span class="tag tag-warn">predates spend window</span>' : '') + (l.hold ? ` <span class="tag tag-warn">${esc(l.hold)}</span>` : '') },
      { key: 'leadDate', label: 'Lead date', cell: (l) => esc(date(l.leadDate)) },
      { key: 'basis', label: 'Source from', opt: true, sortVal: (l) => l.sourceBasis, cell: (l) => (l.sourceBasis === 'hubspot' ? 'HubSpot' : '<span class="muted">Lead Tracker</span>') },
      { key: 'subSource', label: 'Sub-source', opt: true, cell: (l) => esc(l.subSource || DASH) },
      { key: 'owner', label: 'Owner', opt: true, cell: (l) => esc(l.owner) },
      { key: 'openAmount', label: 'Open pipeline', num: true, opt: true, cell: (l) => (l.deals.length ? usd(l.openAmount) : '') },
      { key: 'flags', label: '', sortVal: (l) => l.flags.length, cell: (l) => (l.review ? '<span class="tag tag-warn">review</span>' : l.conflict ? '<span class="tag">check</span>' : '') },
    ], rows, { sort: 'leadDate', noun: 'leads', noun1: 'lead', target: (l) => 'lead=' + l.id, active: (l) => s.lead === l.id, text: (l) => [l.company, l.owner, l.subSource, l.notes.join(' ')].join(' ') });
    return `<div class="chips">${chips}</div>${callout}${lst}`;
  }

  // The data-side review list (lead-source-review.csv), as given: HubSpot is used, the Sheet is unchanged.
  function reviewBlock(v, s) {
    const r = v.reviewList;
    if (!r) return '';
    const open = s.rv === '1';
    const rows = [{
      toggle: 'rv=1', expanded: open,
      cells: [`Source disagreements to review <span class="muted small">(${esc(r.path)})</span>`, int(r.rows.length)],
      expand: open ? list('review', [
        { key: 'company', label: 'Company', cell: (x) => esc(x.company) },
        { key: 'sheet_source', label: 'Lead Tracker', cell: (x) => esc(x.sheet_source) },
        { key: 'hubspot_sources', label: 'HubSpot', cell: (x) => esc(x.hubspot_sources) },
        { key: 'status', label: 'Status', cell: (x) => (x.hold ? `<span class="tag tag-warn">${esc(x.hold)}</span>` : esc((x.status || '').replace(/_/g, ' '))) + (x.mql_channel && x.mql_channel !== 'undetermined' ? `<div class="small">MQL touch: ${esc(x.mql_channel)}</div>` : '') + (x.different_first_touch ? `<div class="muted small">first touch: ${esc(x.different_first_touch)}</div>` : '') },
        { key: 'evidence', label: 'Evidence', opt: true, cell: (x) => `<span class="small">${esc(x.evidence)}</span>${x.attribution_evidence ? `<div class="muted small">${esc(x.attribution_evidence)}</div>` : ''}` },
      ], r.rows, { sort: 'company', dir: 'asc', noun: 'rows', noun1: 'row', target: (x) => (r.leadIds[x.row] ? 'lead=' + r.leadIds[x.row] : 'rv=1'), active: (x) => s.lead && r.leadIds[x.row] === s.lead, text: (x) => [x.company, x.sheet_source, x.hubspot_sources, x.evidence].join(' ') }) +
        `<p class="muted small">Resolved rows are credited to the touch at the MQL booking; undetermined rows (no MQL yet) keep the HubSpot-primary source; rows on hold keep their current source. Nothing is written to the Sheet or HubSpot.</p>` : null,
    }];
    return `<h3>Review list</h3>` + table([{ label: 'List' }, { label: 'Rows', num: true }], rows);
  }

  function paidDealsBlock(v, s) {
    const p = v.paidDeals;
    if (!p) return '';
    const plats = Object.keys(p.byPlatform).sort((a, b) => p.byPlatform[b] - p.byPlatform[a]);
    const rows = plats.map((name) => {
      const xs = p.sales.filter((d) => d.platform === name);
      const open = s.pd === name;
      return {
        toggle: 'pd=' + encodeURIComponent(name), expanded: open,
        cells: [esc(name), int(xs.length), int(xs.filter((d) => d.branded).length), int(xs.filter((d) => d.level === 'company').length), usd(xs.filter((d) => d.open).reduce((a, d) => a + (d.amount || 0), 0))],
        expand: open ? list('paid-' + name, [
          { key: 'name', label: 'Deal', cell: (d) => esc(d.name) + (d.branded ? ` <span class="tag">${esc(v.rules.brandedFlag)}</span>` : '') },
          { key: 'stage', label: 'Stage', opt: true, cell: (d) => esc(d.stage) },
          { key: 'amount', label: 'Amount', num: true, cell: (d) => usd(d.amount) },
          { key: 'conversionDate', label: 'Conversion', opt: true, cell: (d) => esc(date(d.conversionDate)) + (d.predatesSpendWindow ? ' <span class="tag tag-warn">predates spend window</span>' : '') },
          { key: 'via', label: 'Evidence', opt: true, cell: (d) => esc(d.via || DASH) + (d.level === 'company' ? ' <span class="muted small">(company-level)</span>' : '') },
        ], xs, { sort: 'amount', noun: 'deals', noun1: 'deal', target: (d) => 'deal=' + d.id, active: (d) => s.deal === d.id, text: (d) => [d.name, d.company, d.via].join(' ') }) : null,
      };
    });
    return `<h3>Paid-attributed deals</h3>` + table([{ label: 'Platform' }, { label: 'Sales deals', num: true }, { label: v.rules.brandedFlag, num: true, opt: true }, { label: 'Company-level', num: true, opt: true }, { label: 'Open amount', num: true, opt: true }], rows,
      { foot: ['All platforms', int(p.sales.length), int(p.branded), int(p.companyLevel), usd(p.sales.filter((d) => d.open).reduce((a, d) => a + (d.amount || 0), 0))] }) +
      `<p class="muted small">${esc(p.basis)}${p.generatedAt ? ', ' + esc(dateTime(p.generatedAt)) : ''}: ${int(p.total)} paid deals in all${p.predates ? ` (${int(p.predates)} converted before its platform's spend window: flagged, still counted)` : ''}, ${int(p.sales.length)} in the Sales Pipeline${p.otherPipelines ? ` (${int(p.otherPipelines)} in Renewal / Customer Success, not shown)` : ''}. A deal counts when one of its contacts has a paid signal (paid form, UTM with a paid medium or click id, paid_touch_campaign, original source); "company-level" means the signal is on another contact at the deal's company.</p>`;
  }

  function platformBlock(v) {
    if (!v.ads.length) return '';
    const rows = v.ads.map((a) => {
      const check = a.check ? `<div class="small" title="${esc(a.check)}">Pipeline check: ${esc(a.check.split(/\.\s/)[0].replace(/\.$/, ''))}.</div>` : '';
      if (!a.connected) return { cells: [esc(a.name), DASH, DASH, '<span class="muted">no report in the data</span>' + check, `<span class="muted small">${esc(a.how)}</span>`] };
      const win = a.window ? `${esc(date(a.window.start))} – ${esc(date(a.window.end))}` : DASH;
      const ev = a.events && a.events.length ? `<div class="muted small">${a.events.some((e) => isNum(e.count)) ? a.events.filter((e) => isNum(e.count) && e.count > 0).slice(0, 8).map((e) => `${esc(e.name)} ${int(e.count)}`).join(' · ') : `${plural(a.events.length, 'configured event')}: ${a.events.map((e) => esc(e.name.split(' - ')[0])).join(', ')}`}</div>` : '';
      const lp = a.landingPages && a.landingPages.length ? `<div class="muted small">${int(a.landingPages[0].conversions)} on ${esc(a.landingPages[0].url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</div>` : '';
      const conv = `<span class="num">${int(a.conversions)}</span> ${esc(a.conversionType || 'conversions')}${isNum(a.allConversions) ? ` · <span class="num">${int(a.allConversions)}</span> all conversions` : ''}${ev}${lp}${check}`;
      return { cells: [esc(a.name) + (a.stale ? ' ' + chip('data ends ' + date(a.dataThrough), 'warn') : ''), usd(a.spend), `<span class="num">${int(a.spendDays)}</span> days<div class="muted small">${win}${a.window && a.window.basis === 'report window' ? ' (report window)' : ''}</div>`, conv, `<span class="small">${esc(a.how)}</span>`] };
    });
    return `<h3>Ad platforms: platform-reported events, not leads</h3><p class="muted small">Each platform counts its own conversion events. They are not companies or contacts and are not added to the lead counts above.</p>` +
      table([{ label: 'Platform' }, { label: 'Spend', num: true }, { label: 'Days with spend', num: true, opt: true }, { label: 'Reported events' }, { label: 'How the platform counts', opt: true }], rows);
  }

  function outboundBlock(v, s) {
    const o = v.outbound;
    if (!o || !o.campaigns) return '';
    const tag = s.ot || '';
    const xs = tag ? o.campaigns.filter((c) => c.tags.includes(tag)) : o.campaigns;
    const counts = {};
    for (const c of o.campaigns) for (const t of c.tags) counts[t] = (counts[t] || 0) + 1;
    const chips = Object.keys(counts).map((t) => `<button type="button" class="chip chip-btn${tag === t ? ' on' : ''}" data-set="ot=${esc(tag === t ? '' : t)}" aria-pressed="${String(tag === t)}">${esc(o.tagLabels[t] || t)} <b class="num">${int(counts[t])}</b></button>`).join('');
    const sends = xs.reduce((a, c) => a + (c.sent || 0), 0), replies = xs.reduce((a, c) => a + (c.replies || 0), 0);
    const rows = xs.map((c) => ({ cells: [esc(c.name) + c.flags.map((f) => ` <span class="tag tag-warn">${esc(f)}</span>`).join('') + (c.mostlyInvite ? ` <span class="tag tag-warn" title="${esc(`${int(c.inviteReplies)} of ${int(c.replies)} replies came on the LinkedIn invite step`)}">replies look automatic</span>` : ''),
      `<span class="small">${c.tags.map((t) => esc(o.tagLabels[t] || t)).join(', ')}</span>`, esc(c.status), int(c.sent), int(c.replies), pct(c.rate), '<span class="muted">not tracked</span>'] }));
    return `<h3>Outbound (Lemlist)</h3><div class="tiles">${tile('Outbound reply rate', pct(o.rate), `<span class="num">${int(o.replies)}</span> replies ÷ <span class="num">${int(o.sends)}</span> sends, all ${int(o.count)} campaigns`, ' data-fig="reply-rate"')}</div><div class="chips">${chips}</div>` +
      table([{ label: 'Campaign' }, { label: 'Tags', opt: true }, { label: 'Status', opt: true }, { label: 'Sends', num: true }, { label: 'Replies', num: true }, { label: 'Reply rate', num: true }, { label: 'Opens / meetings', opt: true }], rows,
        { foot: [tag ? `Tagged ${esc(o.tagLabels[tag] || tag)}` : 'All campaigns', '', '', int(sends), int(replies), pct(sends ? replies / sends : null), ''] }) +
      `<p class="muted small">${esc(o.definition)} Opens and meetings are not tracked in Lemlist (open tracking is off; meetings are booked in HubSpot).</p>`;
  }

  // ---------- meetings ----------
  const BUCKETS = [['matched', 'Matched', (m) => m.matched], ['unmatched', 'Unmatched', (m) => !m.matched && m.linked], ['nolink', 'No contact linked', (m) => !m.linked]];
  const bucketOf = (m) => BUCKETS.find((b) => b[2](m))[0];
  function meetingsSection(v, s) {
    const M = v.meetings;
    const period = rangeOf(s, 'mp');
    const xs = M.items.filter((m) => inPeriod(m.start, period, v.meta.asOf));
    const sub = (c) => `matched · +${int(c.unmatched)} unmatched · +${int(c.noContact)} no contact`;
    const week = period === 'week' ? weekWindow(v.meta.asOf) : null;
    let weekTile = '';
    if (week) {
      const lw = weekWindow(v.meta.asOf, 1);
      const prev = M.items.filter((m) => inPeriod(m.start, 'lastweek', v.meta.asOf));
      const n = xs.filter((m) => m.matched).length;
      weekTile = tile(`This week · ${week.label}`, int(n), `matched · ${weekDelta(n, prev.filter((m) => m.matched).length, lw.label)}`, ' data-fig="meetings-week"');
    }
    const tiles = `<div class="tiles">${weekTile}${tile('This month', int(M.thisMonth.matched), sub(M.thisMonth), ' data-fig="meetings-month"')}${tile('Upcoming', int(M.upcoming.matched), sub(M.upcoming), ' data-fig="meetings-upcoming"')}</div>`;
    const owners = [...new Set(xs.map((m) => m.owner))].sort((a, b) => xs.filter((m) => m.owner === b).length - xs.filter((m) => m.owner === a).length || a.localeCompare(b));
    const max = Math.max(1, ...owners.map((o) => xs.filter((m) => m.owner === o).length));
    const cellBtn = (n, spec, label) => (n ? `<button type="button" class="lnk num" data-set="${esc(spec)}" aria-label="${esc(label)}">${int(n)}</button>` : '0');
    const mkRow = (o, ms) => {
      const key = o == null ? '*' : o;
      const open = s.mo === key;
      return {
        toggle: `mo=${encodeURIComponent(key)}&mb=`, expanded: open, cls: o == null ? 'total-row' : null,
        cells: [o == null ? 'All owners' : esc(o), `<span class="barcell">${o == null ? '' : bar(ms.length, max)}<span class="num">${int(ms.length)}</span></span>`,
          ...BUCKETS.map(([k, label, f]) => cellBtn(ms.filter(f).length, `mo=${encodeURIComponent(key)}&mb=${k}`, `${o || 'All owners'}: ${label.toLowerCase()} meetings`))],
        expand: open ? meetingList(v, s, ms) : null,
      };
    };
    const rows = owners.map((o) => mkRow(o, xs.filter((m) => m.owner === o)));
    rows.push(mkRow(null, xs));
    const sc = M.scope;
    const scope = `<p class="muted small">${esc(M.definition)} Not counted: ${int(sc.cs)} CS-owner meetings, ${int(sc.customer)} customer meetings, ${int(sc.internal)} internal-only, of ${int(sc.total)} HubSpot meetings. Lists cover ${esc(date(M.windowStart))} onward.</p>`;
    return section('meetings', 'Meetings', 'Sales owners only. Matched = the contact\'s company has a Sales Pipeline deal.',
      tiles + (xs.length ? table([{ label: 'Owner' }, { label: 'Meetings', num: true }, { label: 'Matched', num: true }, { label: 'Unmatched', num: true }, { label: 'No contact', num: true }], rows)
        : `<p class="empty" data-empty="meetings">No meetings ${week ? `this week (${esc(week.label)})` : 'in this range'}.</p>`) + scope,
      periodPicker('mp', period, rangeOptions('mp', v)));
  }

  const when = (iso) => { const t = parseT(iso); return t ? `${esc(F_DAY.format(t))}<div class="muted small">${esc(F_TIME.format(t))} PT</div>` : DASH; };

  function meetingList(v, s, ms) {
    const b = s.mb || 'all';
    const xs = b === 'all' ? ms : ms.filter((m) => bucketOf(m) === b);
    const seg = `<div class="seg" role="group" aria-label="Matched or unmatched">${[['all', 'All', () => true], ...BUCKETS].map(([k, l, f]) => `<button type="button" data-set="mb=${k === 'all' ? '' : k}" aria-pressed="${String(b === k)}">${l} <b class="num">${int(ms.filter(f).length)}</b></button>`).join('')}</div>`;
    return seg + list('mtg-' + (s.mo || '') + '-' + b + '-' + rangeOf(s, 'mp'), [
      { key: 'start', label: 'When', cell: (m) => when(m.start) },
      { key: 'title', label: 'Meeting', cell: (m) => esc(m.title) + (m.companies[0] ? `<div class="muted small">${esc(m.companies[0].name)}</div>` : '') },
      { key: 'owner', label: 'Owner', opt: true, cell: (m) => esc(m.owner) },
      { key: 'matched', label: 'Match', sortVal: (m) => (m.matched ? 2 : m.linked ? 1 : 0), cell: (m) => (m.matched ? '<span class="tag tag-ok">matched</span>' : `<span class="tag">${m.linked ? 'unmatched' : 'no contact'}</span><div class="muted small opt">${esc(m.reason || '')}</div>`) },
    ], xs, { sort: 'start', dir: rangeOf(s, 'mp') === 'upcoming' ? 'asc' : 'desc', noun: 'meetings', noun1: 'meeting', target: (m) => 'mtg=' + m.id, active: (m) => s.mtg === m.id, text: (m) => [m.title, m.owner, m.companies.map((c) => c.name).join(' '), m.contacts.map((c) => c.name).join(' ')].join(' ') });
  }

  // ---------- calls ----------
  function callsSection(v, s) {
    const C = v.calls;
    const period = rangeOf(s, 'cp');
    const xs = C.items.filter((c) => inPeriod(c.start, period, v.meta.asOf));
    const week = period === 'week' ? weekWindow(v.meta.asOf) : null;
    const prevCalls = week ? C.items.filter((c) => inPeriod(c.start, 'lastweek', v.meta.asOf)) : null;
    const tiles = `<div class="tiles">${tile(week ? `Prospect calls · ${week.label}` : 'Prospect calls', int(xs.length), week ? weekDelta(xs.length, prevCalls.length, weekWindow(v.meta.asOf, 1).label) : 'Fathom, sales and prospect only', ' data-fig="calls"')}${tile('At a Sales Pipeline company', int(xs.filter((c) => c.matched).length))}${tile('With a summary', int(xs.filter((c) => c.summary).length))}</div>`;
    const recs = [...new Set(xs.map((c) => c.recorder))].sort((a, b) => xs.filter((c) => c.recorder === b).length - xs.filter((c) => c.recorder === a).length || a.localeCompare(b));
    const max = Math.max(1, ...recs.map((r) => xs.filter((c) => c.recorder === r).length));
    const rows = recs.map((r) => {
      const cs = xs.filter((c) => c.recorder === r);
      const open = s.co === r;
      return {
        toggle: 'co=' + encodeURIComponent(r), expanded: open,
        cells: [esc(r), `<span class="barcell">${bar(cs.length, max)}<span class="num">${int(cs.length)}</span></span>`, int(cs.filter((c) => c.matched).length), int(cs.filter((c) => c.summary).length)],
        expand: open ? list('calls-' + r + '-' + period, [
          { key: 'start', label: 'When', cell: (c) => when(c.start) },
          { key: 'title', label: 'Call', cell: (c) => esc(c.title) },
          { key: 'company', label: 'Company', opt: true, sortVal: (c) => (c.companies[0] || {}).name || '', cell: (c) => esc((c.companies[0] || {}).name || DASH) },
          { key: 'matched', label: 'Match', sortVal: (c) => (c.matched ? 1 : 0), cell: (c) => (c.matched ? '<span class="tag tag-ok">matched</span>' : `<span class="tag">unmatched</span>`) },
        ], cs, { sort: 'start', noun: 'calls', noun1: 'call', target: (c) => 'call=' + c.id, active: (c) => s.call === c.id, text: (c) => [c.title, c.companies.map((x) => x.name).join(' '), c.contacts.map((x) => x.name).join(' ')].join(' ') }) : null,
      };
    });
    const sc = C.scope;
    return section('calls', 'Calls', 'Fathom recordings, sales and prospect calls only.',
      tiles + (xs.length ? table([{ label: 'Recorded by' }, { label: 'Calls', num: true }, { label: 'Sales Pipeline company', num: true, opt: true }, { label: 'With summary', num: true, opt: true }], rows)
        : `<p class="empty" data-empty="calls">No prospect calls yet ${week ? `this week (${esc(week.label)})` : 'in this range'}.</p>`) +
      (C.classification === 'strategy'
        ? `<p class="muted small">${esc(C.definition)} Of ${int(sc.total)} recordings: <span data-fig="calls-prospect">${int(sc.prospect)}</span> prospect, ${int(sc.customer)} customer, ${int(sc.internal)} internal, ${int(sc.partner_other)} partner/other${sc.unclassified ? `, ${int(sc.unclassified)} not in the classification` : ''}.</p>`
        : `<p class="small">${chip('call classification unavailable', 'warn')} ${esc(C.classificationNote || '')}</p><p class="muted small">${esc(C.definition)} Not counted: ${int(sc.internal)} internal-only, ${int(sc.cs)} recorded by CS owners, ${int(sc.customer)} customer calls, of ${int(sc.total)} recordings.</p>`),
      periodPicker('cp', period, rangeOptions('cp', v)));
  }

  // ---------- analysis ----------
  function analysisSection(v, s) {
    const a = v.insights;
    if (!a) return section('analysis', 'Analysis', 'No analysis file was given.', '');
    if (!a.ok) return section('analysis', 'Analysis', 'The analysis file did not pass validation, so it is not shown.', `<ul class="small">${a.errors.slice(0, 5).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`);
    const rows = a.doc.insights.map((x, i) => ({
      toggle: 'ins=' + i, expanded: s.ins === String(i),
      cells: [esc(x.title), esc(x.owner), esc(x.confidence)],
      expand: s.ins === String(i) ? kv([['Evidence', esc(x.evidence)], ['Why it matters', esc(x.why_it_matters)], ['Recommended play', esc(x.recommended_play)]]) : null,
    }));
    return section('analysis', 'Analysis', `Strategy's analysis, generated ${esc(dateTime(a.doc.generated_at))}.`,
      `<p>${esc(a.doc.headline)}</p>` + table([{ label: 'Insight' }, { label: 'Owner', opt: true }, { label: 'Confidence', opt: true }], rows));
  }

  function scopeFooter(v) {
    const cp = v.scope.currentPage;
    return `<footer class="foot small muted"><p><b>Scope.</b> Sales Pipeline only; ${esc(v.scope.droppedPipelines.join(', '))} pipelines dropped. Closed Won Sales Pipeline deals stay in pipeline figures. Customer companies (${int(v.scope.customerCompanies)} in HubSpot: lifecycle customer, a Closed Won deal, or a Renewal / Customer Success deal) are excluded from meetings only, with the call rule in the Meetings section. Calls follow ${v.calls.classification === 'strategy' ? 'Strategy\'s per-call classification' : 'the call rule (call classification unavailable)'}.${cp ? ` Compared with the current page (built ${esc(dateTime(cp.builtAt))}), this removes ${int(cp.companies)} customer companies, their ${int(cp.meetings)} meetings and ${int(cp.recordings)} of ${int(cp.recordingsTotal)} recordings.` : ''}</p>
<p><b>Times</b> are America/Phoenix, labelled PT. <b>Lead-source mapping</b> is ${esc(v.meta.provisional)} (lead-sources.json${v.meta.leadSourcesAt ? ', ' + esc(dateTime(v.meta.leadSourcesAt)) : ''}). <b>Open pipeline:</b> ${esc(v.headline.definition)}</p></footer>`;
  }

  // ---------- drawers ----------
  function dealDrawer(v, id) {
    const d = v.dealIndex[id];
    if (!d) return drawer('Deal not found', '', [['', '<p>This deal is not in the data.</p>']]);
    const now = parseT(v.meta.asOf);
    return drawer(esc(d.name), chip(d.stage, d.won ? 'ok' : d.lost ? 'neutral' : 'info') + (d.onHold ? chip('On Hold', 'warn') : ''), [
      ['Deal', kv([['Company', esc(d.company || DASH)], ['Amount', usd(d.amount)], ['Weighted', d.open ? usd(d.weighted) : null], ['Owner', esc(d.owner)],
        ['Close date', esc(date(d.close)) + (d.open && parseT(d.close) && parseT(d.close) < now ? ' <span class="warn-t">passed</span>' : '')], ['Created', esc(date(d.created))],
        ['Lost reason', d.lost ? esc(d.lostReason || 'none recorded') : null], ['Lost category', d.lostCategory ? esc(d.lostCategory) + (d.lostBasis ? `<div class="muted small">${esc(d.lostBasis)}</div>` : '') : (d.postWin ? '<span class="muted">expansion at a customer (created after the first win): not categorized</span>' : null)],
        ['Paid', d.paid ? `${esc(d.paid.platform)}${d.paid.branded ? ` <span class="tag">${esc(v.rules.brandedFlag)}</span>` : ''}${d.paid.conversionDate ? ` · converted ${esc(date(d.paid.conversionDate))}` : ''}${d.paid.predatesSpendWindow ? ' <span class="tag tag-warn">predates spend window</span>' : ''} <span class="muted small">${esc(d.paid.via || '')}${d.paid.level === 'company' ? ', company-level' : ''} (${esc(v.paidDeals.basis)})</span>` : null]])],
      ['HubSpot', ext(hsUrl(v, '0-3', d.id), 'Open the deal in HubSpot') || '<span class="muted">No portal id given, so no link.</span>'],
    ]);
  }

  function leadDrawer(v, id) {
    const l = v.leadIndex[id];
    if (!l) return drawer('Lead not found', '', [['', '<p>This lead is not in the data.</p>']]);
    const ev = l.evidence.length ? `<ul class="plain">${l.evidence.map((e) => `<li><b>${esc(e.rule)}</b>${e.decides ? '' : ' <span class="muted small">(evidence only)</span>'}${e.superseded ? ` <span class="tag">superseded: ${esc(e.superseded)}</span>` : ''}: ${esc(e.source || 'no source')}${e.platform ? ' · ' + esc(e.platform) : ''}${e.branded ? ` <span class="tag">${esc(v.rules.brandedFlag)}</span>` : ''} <span class="muted">${esc(e.detail || '')}</span>${e.at ? ` <span class="muted small">${esc(date(e.at))}</span>` : ''}</li>`).join('')}</ul>` : `<p class="muted">No HubSpot or Lemlist evidence${v.meta.notSynced.length ? ' (form, list, campaign and source fields are not yet synced)' : ''}.</p>`;
    const ins = l.insight;
    const insight = ins ? kv([['Last call', esc(date(ins.lastCall)) + (ins.calls ? ` · ${plural(ins.calls, 'call')}` : '')], ['Summary', ins.text ? esc(ins.text) : null], ['Pains', ins.pains.length ? ins.pains.map(esc).join('<br>') : null], ['Objections', ins.objections.length ? esc(ins.objections.join(', ')) : null], ['Competitors', ins.competitors.length ? esc(ins.competitors.join(', ')) : null], ['Next step', ins.nextStep ? esc(ins.nextStep) : null], ['Risk', ins.risk.length ? ins.risk.map(esc).join('<br>') : null], ['Basis', ins.basis ? `<span class="muted">${esc(ins.basis)}</span>` : null]]) : '';
    const deals = l.deals.length ? `<ul class="plain">${l.deals.map((d) => `<li>${link(esc(d.name), 'deal=' + d.id)} · ${esc(d.stage)} · <span class="num">${usd(d.amount)}</span></li>`).join('')}</ul>` : '<p class="muted">No Sales Pipeline deal at this company.</p>';
    const meetings = l.meetings.length ? `<ul class="plain">${l.meetings.map((m) => `<li>${m.inList ? link(esc(m.title), 'mtg=' + m.id) : esc(m.title)} <span class="muted small">${esc(dateTime(m.start))} · ${esc(m.owner)}</span></li>`).join('')}</ul>` : '';
    const contacts = l.contacts.length ? `<ul class="plain">${l.contacts.map((c) => `<li>${esc(c.name || 'Unnamed contact')}${c.title ? ` <span class="muted">${esc(c.title)}</span>` : ''} <span class="muted small">${esc(c.lifecycle || '')}</span></li>`).join('')}</ul>${l.contactCount > l.contacts.length ? `<p class="muted small">${int(l.contactCount)} contacts in HubSpot</p>` : ''}` : '';
    const co = l.hubspot.companyIds[0];
    return drawer(esc(l.company), chip(l.source, 'info') + (l.subSource ? chip(l.subSource, 'neutral') : '') + (l.tag ? chip(l.tag, 'neutral') : '') + (l.review ? chip('review', 'warn') : ''), [
      ['Source', kv([['Source', esc(l.source) + ` <span class="muted small">${l.sourceBasis === 'hubspot' ? 'from HubSpot (primary)' : 'Lead Tracker fallback: no HubSpot evidence'}</span>`],
        ['Rule that fired', esc(l.rule)], ['Lead Tracker Source', esc(l.sheetSource) + (l.sheetSource !== l.source ? ' <span class="tag tag-warn">differs: on the review list</span>' : '')],
        ['Sub-source', l.subSource ? esc(l.subSource) + (l.tag ? ` <span class="tag">${esc(l.tag)}</span>` : '') + ` <span class="muted small">${esc(v.meta.provisional)}</span>` : null],
        ['Paid conversion', l.conversionDate ? esc(date(l.conversionDate)) + (l.predatesSpendWindow ? ' <span class="tag tag-warn">predates spend window</span>' : '') : null],
        ['First touch', l.firstTouch ? esc(l.firstTouch) + ' <span class="muted small">(differs from the MQL touch)</span>' : null],
        ['MQL channel', l.mqlChannel === 'undetermined' ? 'undetermined: no MQL booking yet' : null],
        ['Review', l.hold ? `<span class="tag tag-warn">${esc(l.hold)}</span> <span class="muted small">current source kept</span>` : null],
        ['Possible platforms', l.possiblePlatforms ? esc(l.possiblePlatforms.join(', ')) + ' <span class="muted small">(note matches a configured conversion event)</span>' : null]])],
      ['Evidence', ev + (l.flags.length ? `<ul class="plain">${l.flags.map((f) => `<li><span class="tag tag-warn">${f.kind === 'review' ? 'review' : f.kind === 'conflict' ? 'other evidence' : 'check'}</span> ${esc(f.text)}</li>`).join('')}</ul><p class="muted small">Flagged, not resolved: nothing is written to the Sheet.</p>` : '')],
      ['Dates', kv([['Lead', esc(date(l.leadDate))], ['MQL', esc(date(l.mqlDate))], ['SQL', esc(date(l.sqlDate))]])],
      ['Company', kv([['Owner (Sheet)', esc(l.owner)], ['HubSpot owner', l.companyOwner ? esc(l.companyOwner) : null], ['Lifecycle', l.lifecycle ? esc(l.lifecycle) : null], ['HubSpot match', esc(l.hubspot.matchRule || 'not matched to a HubSpot company')], ['HubSpot', co ? ext(hsUrl(v, '0-2', co), 'Open the company') || null : null]])],
      ['Deals', deals], ['Meetings', meetings], ['Contacts', contacts], ['Insight', insight],
      ['Lead Tracker', `${l.notes.map((n) => `<p>${esc(n)}</p>`).join('')}<p class="muted small">Sheet row${l.rows.length > 1 ? 's' : ''} ${esc(l.rows.join(', '))}</p>`],
    ]);
  }

  function meetingDrawer(v, id, kind) {
    const m = kind === 'call' ? v.callIndex[id] : v.meetingIndex[id];
    if (!m) return drawer('Not found', '', [['', '<p>This item is not in the data.</p>']]);
    const rec = kind === 'call' ? m : m.recordingId ? v.callIndex[m.recordingId] : null;
    const comps = m.companies.length ? `<ul class="plain">${m.companies.map((c) => `<li>${esc(c.name)}${c.deal ? ` · ${link(esc(c.deal.name), 'deal=' + c.deal.id)} <span class="muted small">${esc(c.deal.stage)} · ${usd(c.deal.amount)}</span>` : ' <span class="muted small">no Sales Pipeline deal</span>'}</li>`).join('')}</ul>` : '<p class="muted">No company linked.</p>';
    const people = m.contacts.length ? `<ul class="plain">${m.contacts.map((c) => `<li>${esc(c.name || 'Unnamed')}${c.title ? ` <span class="muted">${esc(c.title)}</span>` : ''}${c.company ? ` <span class="muted small">${esc(c.company)}</span>` : ''}</li>`).join('')}</ul>` : '';
    return drawer(esc(m.title), (m.matched ? chip('matched', 'ok') : chip(m.linked === false ? 'no contact linked' : 'unmatched', 'neutral')) + (kind === 'call' ? chip('Fathom', 'neutral') : ''), [
      [kind === 'call' ? 'Call' : 'Meeting', kv([['When', esc(dateTime(m.start))], [kind === 'call' ? 'Recorded by' : 'Owner', esc(kind === 'call' ? m.recorder : m.owner)], ['Outcome', m.outcome ? esc(m.outcome.toLowerCase()) : null], ['Why unmatched', m.matched ? null : esc(m.reason || DASH)], ['HubSpot', kind === 'call' ? null : ext(hsUrl(v, '0-47', m.id), 'Open the meeting') || null]])],
      ['Companies and deals', comps], ['Guests', people],
      ['Strategy', m.strategy ? kv([['Classified', esc((m.strategy.reason || '').replace(/_/g, ' '))], ['Call type', m.strategy.callType ? esc(m.strategy.callType.replace(/_/g, ' ')) : null],
        ['Deal at call time', m.strategy.deal ? link(esc(m.strategy.deal.name), 'deal=' + m.strategy.deal.id) + ` <span class="muted small">${esc(m.strategy.deal.stage || '')}</span>` : null],
        ['Buyer roles', m.strategy.buyerRoles.length ? esc(m.strategy.buyerRoles.join(', ').replace(/_/g, ' ')) : null],
        ['Competitors', m.strategy.competitors.length ? esc(m.strategy.competitors.join(', ')) : null],
        ['Objections', m.strategy.objections.length ? m.strategy.objections.map((o) => `<b>${esc(o.category)}</b> <span class="muted">${esc(o.quote || '')}</span>`).join('<br>') : null],
        ['Next steps', m.strategy.nextSteps.length ? m.strategy.nextSteps.map(esc).join('<br>') : null]]) : ''],
      ['Fathom summary', rec && rec.summary ? `<div class="summary">${esc(rec.summary).replace(/\n/g, '<br>')}</div>${rec.transcript ? '<p class="muted small">Transcript in Fathom.</p>' : ''}` : (kind === 'call' ? '<p class="muted">No summary.</p>' : '')],
    ]);
  }

  function renderDrawer(v, s) {
    if (s.lead) return leadDrawer(v, s.lead);
    if (s.mtg) return meetingDrawer(v, s.mtg, 'meeting');
    if (s.call) return meetingDrawer(v, s.call, 'call');
    if (s.deal) return dealDrawer(v, s.deal);
    return '';
  }

  // ---------- the page ----------
  function index(v) {
    if (v.leadIndex) return v;
    const by = (xs, k = 'id') => Object.fromEntries((xs || []).map((x) => [x[k], x]));
    v.leadIndex = by(v.leads.items);
    v.meetingIndex = by(v.meetings.items);
    v.callIndex = by(v.calls.items);
    v.dealIndex = by([...v.deals, ...v.closed.lost]);
    return v;
  }

  function renderMain(v, s) {
    index(v);
    return pipelineSection(v, s) + leadsSection(v, s) + meetingsSection(v, s) + callsSection(v, s) + analysisSection(v, s) + scopeFooter(v);
  }

  function renderPage(v, s, opts = {}) {
    index(v);
    return { header: header(v, opts), main: renderMain(v, s), drawer: renderDrawer(v, s) };
  }

  function withheldView(doc) {
    return `<section class="sec withheld" role="status"><h2>The workspace data is withheld</h2><p>${esc(doc.notice || '')}</p>
<p class="muted small">Withheld ${esc(dateTime(doc.meta && doc.meta.generatedAt))}. The page checks again every few minutes.</p></section>`;
  }

  const api = { renderPage, renderMain, renderDrawer, header, loadingHeader, errorView, withheldView, STALE_MS, parseState, stateHash, applyChange, inPeriod, weekWindow, weekDelta, RANGES, DEFAULT_RANGE, esc, usd, int, pct, dateTime, date, ymd };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GtmPage = api;

  // ---------- browser behaviour ----------
  if (typeof document === 'undefined' || typeof module === 'object') return;
  const DATA_URL = 'workspace.json';
  const REFRESH_URL = 'refresh.json';
  const RECHECK_MS = 5 * 60e3;
  let V = null;
  let dataText = null;
  // The chosen range per section is sticky: the hash wins, else the last choice (localStorage), else "This week".
  const RANGE_KEYS = Object.keys(RANGES);
  function withStoredRanges(st) {
    const out = { ...st };
    for (const k of RANGE_KEYS) {
      if (out[k]) continue;
      let saved = null;
      try { saved = localStorage.getItem('gtm-range-' + k); } catch { /* private mode */ }
      if (saved && RANGES[k].some(([x]) => x === saved)) out[k] = saved;
    }
    return out;
  }
  function storeRanges(st) {
    for (const k of RANGE_KEYS) if (st[k]) { try { localStorage.setItem('gtm-range-' + k, st[k]); } catch { /* private mode */ } }
  }
  let state = withStoredRanges(parseState(location.hash));
  const main = document.getElementById('main');
  const droot = document.getElementById('drawer-root');
  let lastFocus = null;

  function dismissed() {
    try { return JSON.parse(localStorage.getItem('gtm-dismissed') || '[]'); } catch { return []; }
  }
  function hideDismissed() {
    const d = dismissed();
    for (const el of document.querySelectorAll('[data-note]')) if (d.includes(el.getAttribute('data-note'))) el.hidden = true;
  }
  function setHeader(html) {
    const h = document.querySelector('header.top');
    if (h) h.outerHTML = html; else document.body.insertAdjacentHTML('afterbegin', html);
  }
  function render(focusDrawer, withHeader) {
    if (!V) return;
    const y = window.scrollY;
    if (withHeader) setHeader(header(V, { now: Date.now() }));
    main.innerHTML = renderMain(V, state);
    droot.innerHTML = renderDrawer(V, state);
    document.body.classList.toggle('has-drawer', !!droot.innerHTML);
    hideDismissed();
    window.scrollTo(0, y);
    const dr = droot.querySelector('.drawer');
    if (dr && focusDrawer) dr.focus();
  }
  function go(next) {
    const opening = DRAWERS.some((k) => next[k] && next[k] !== state[k]);
    if (opening && !droot.innerHTML) lastFocus = document.activeElement;
    state = next;
    storeRanges(state);
    const h = stateHash(state);
    if (h !== location.hash) history.replaceState(null, '', h || location.pathname + location.search);
    render(opening);
    if (!DRAWERS.some((k) => state[k]) && lastFocus && document.contains(lastFocus)) { lastFocus.focus(); lastFocus = null; }
  }
  // sha256 of the fetched text, to match refresh.json's timestamps to this exact file.
  async function textSha256(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; } // no WebCrypto (non-secure context): the timestamps are not applied
  }
  // Fetch mode: workspace.json (required) and refresh.json (optional: newer timestamps, last-good status).
  async function load(quiet) {
    try {
      const r = await fetch(DATA_URL, { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) throw new Error(`${DATA_URL} answered HTTP ${r.status}.`);
      const text = await r.text();
      let refresh = null;
      try { const rr = await fetch(REFRESH_URL, { cache: 'no-store', credentials: 'same-origin' }); if (rr.ok) refresh = await rr.json(); } catch { /* optional */ }
      const data = JSON.parse(text);
      if (data && data.withheld === true) {
        V = null; dataText = text;
        setHeader(loadingHeader('Data withheld'));
        main.innerHTML = withheldView(data);
        droot.innerHTML = '';
        return;
      }
      if (!data || !data.headline || !data.meta) throw new Error(`${DATA_URL} is not a workspace file.`);
      const sha = await textSha256(text);
      if (quiet && text === dataText && V) {
        // Same file: only the times and the status move (refresh.json). Update the header in place,
        // so lists, scroll position and an open drawer stay as they are.
        const next = root.GtmView.buildView(data, refresh, sha);
        V.meta.generatedAt = next.meta.generatedAt;
        V.meta.hubspot = next.meta.hubspot;
        V.freshness = next.freshness;
        V.live = next.live;
        setHeader(header(V, { now: Date.now() }));
        return;
      }
      dataText = text;
      V = root.GtmView.buildView(data, refresh, sha);
      index(V);
      render(!quiet && !!location.hash, true);
    } catch (e) {
      if (quiet && V) return; // keep showing what we have; the header turns amber as it ages
      V = null;
      setHeader(loadingHeader('Not loaded'));
      main.innerHTML = errorView(String((e && e.message) || e));
      droot.innerHTML = '';
    }
  }
  // For tests and the console: run the periodic re-check now.
  root.GtmRecheck = () => load(true);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-set],[data-toggle],[data-sort],[data-page],[data-dismiss],[data-jump],[data-retry]');
    if (!t || e.target.closest('a')) return;
    if (t.dataset.retry) { main.innerHTML = '<p class="loading">Loading the workspace…</p>'; load(false); return; }
    if (!V) return;
    if (t.dataset.jump) { const el = document.getElementById(t.dataset.jump); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (t.dataset.dismiss) {
      const d = dismissed(); d.push(t.dataset.dismiss);
      try { localStorage.setItem('gtm-dismissed', JSON.stringify(d.slice(-20))); } catch { /* private mode */ }
      hideDismissed(); return;
    }
    if (t.dataset.sort) {
      const [id, key] = t.dataset.sort.split(':');
      const st = LISTS[id];
      if (st.sort === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = key; st.dir = 'desc'; }
      st.page = 0;
      t.closest('.list').querySelector('.list-body').innerHTML = listBody(id);
      return;
    }
    if (t.dataset.page) {
      const [id, d] = t.dataset.page.split(':');
      LISTS[id].page += Number(d);
      t.closest('.list').querySelector('.list-body').innerHTML = listBody(id);
      return;
    }
    e.preventDefault();
    if (t.dataset.set != null) go(applyChange(state, t.dataset.set, false));
    else go(applyChange(state, t.dataset.toggle, true));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && DRAWERS.some((k) => state[k])) { go(applyChange(state, 'lead=&mtg=&call=&deal=', false)); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-toggle],tr[data-set]')) { e.preventDefault(); e.target.click(); }
  });
  document.addEventListener('input', (e) => {
    const id = e.target.dataset && e.target.dataset.q;
    if (!id) return;
    LISTS[id].q = e.target.value; LISTS[id].page = 0;
    e.target.closest('.list').querySelector('.list-body').innerHTML = listBody(id);
  });
  window.addEventListener('hashchange', () => { state = withStoredRanges(parseState(location.hash)); storeRanges(state); render(true); });
  const baked = document.getElementById('gtm-data');
  if (baked) {
    V = JSON.parse(baked.textContent);
    index(V);
    if (location.hash || RANGE_KEYS.some((k) => state[k])) render(!!location.hash); else hideDismissed();
  } else {
    load(false);
    setInterval(() => { if (!document.hidden) load(true); }, RECHECK_MS);
  }
})(typeof window !== 'undefined' ? window : this);
