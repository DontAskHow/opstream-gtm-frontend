// GTM charts: a tiny hand-written SVG/HTML chart kit. No dependencies.
// Every chart returns a markup string. Interactive marks carry data-tip
// (tooltip text) and data-href (hash route to open on click); app.js wires
// both up with delegated listeners.
(function () {
  'use strict';

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // Clean axis ticks: 0, 1, 2, 2.5 or 5 x 10^n.
  function niceTicks(max, count) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const ticks = [];
    for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
    if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toPrecision(12));
    return ticks;
  }

  // Column whose data-end (top) is rounded and whose baseline is square.
  function colPath(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function attrs(item) {
    let a = '';
    if (item.tip) a += ` data-tip="${esc(item.tip)}"`;
    if (item.href) a += ` data-href="${esc(item.href)}" tabindex="0" role="link"`;
    if (item.tip) a += ` aria-label="${esc(String(item.tip).replace(/\n/g, ', '))}"`;
    return a;
  }

  /**
   * Vertical columns over an ordered x axis (months).
   * opts: { width, height, data: [{ label, values: [n...], colors?: [css...], tip, href }],
   *         series: [{ name, color }], stacked, yFormat, marker: { index, label }, minLabelGap }
   */
  function columns(opts) {
    const width = Math.max(260, Math.floor(opts.width || 600));
    const height = opts.height || 220;
    const data = opts.data || [];
    const series = opts.series || [{ color: 'var(--s1)' }];
    const k = series.length;
    const fmt = opts.yFormat || ((v) => v.toLocaleString('en-US'));
    const totals = data.map((d) => (opts.stacked ? d.values.reduce((a, v) => a + (isNum(v) ? v : 0), 0) : Math.max(0, ...d.values.filter(isNum))));
    const ticks = niceTicks(Math.max(0, ...totals), 4);
    const yMax = ticks[ticks.length - 1];
    const labelW = Math.max(...ticks.map((t) => fmt(t).length)) * 6.6 + 10;
    const m = { top: 18, right: 24, bottom: 26, left: Math.ceil(labelW) };
    const pw = width - m.left - m.right;
    const ph = height - m.top - m.bottom;
    const band = data.length ? pw / data.length : pw;
    const y = (v) => m.top + ph - (v / yMax) * ph;
    let s = `<svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.title || 'Column chart')}">`;

    for (const t of ticks) {
      const ty = Math.round(y(t)) + 0.5;
      s += `<line class="grid${t === 0 ? ' base' : ''}" x1="${m.left}" x2="${width - m.right}" y1="${ty}" y2="${ty}"/>`;
      s += `<text class="tick" x="${m.left - 6}" y="${ty + 4}" text-anchor="end">${esc(fmt(t))}</text>`;
    }

    if (opts.marker && opts.marker.index >= 0 && opts.marker.index < data.length) {
      const mx = Math.round(m.left + band * (opts.marker.index + 0.5)) + 0.5;
      s += `<line class="marker" x1="${mx}" x2="${mx}" y1="${m.top - 4}" y2="${m.top + ph}"/>`;
      s += `<text class="marker-label" x="${mx + 4}" y="${m.top - 6}">${esc(opts.marker.label || '')}</text>`;
    }

    const gap = 2;
    data.forEach((d, i) => {
      const x0 = m.left + band * i;
      if (opts.stacked) {
        const w = Math.max(2, Math.min(24, band * 0.7));
        const x = x0 + (band - w) / 2;
        let base = 0;
        const parts = d.values.map((v, si) => ({ v: isNum(v) ? v : 0, si })).filter((p) => p.v > 0);
        parts.forEach((p, pi) => {
          const yTop = y(base + p.v);
          const yBot = y(base) - (pi > 0 ? gap : 0);
          const h = Math.max(0, yBot - yTop);
          const top = pi === parts.length - 1;
          s += `<path class="mark" fill="${series[p.si].color}" d="${top ? colPath(x, yTop, w, h, 4) : `M${x},${yTop}h${w}v${h}h${-w}Z`}"/>`;
          base += p.v;
        });
      } else {
        const groupW = Math.min(band * 0.8, 24 * k + gap * (k - 1));
        const w = Math.max(1.5, (groupW - gap * (k - 1)) / k);
        const gx = x0 + (band - groupW) / 2;
        d.values.forEach((v, si) => {
          if (!isNum(v) || v <= 0) return;
          const yTop = y(v);
          const fill = (d.colors && d.colors[si]) || series[si].color;
          s += `<path class="mark" fill="${fill}" d="${colPath(gx + si * (w + gap), yTop, w, m.top + ph - yTop, 4)}"/>`;
        });
      }
    });

    // Thin out x labels so they never collide.
    const minGap = opts.minLabelGap || 44;
    const step = Math.max(1, Math.ceil(minGap / band));
    data.forEach((d, i) => {
      if (i % step) return;
      s += `<text class="tick" x="${m.left + band * (i + 0.5)}" y="${height - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    });

    // Hit targets: the whole band, taller than the mark.
    data.forEach((d, i) => {
      s += `<rect class="hit" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ph}"${attrs(d)}/>`;
    });
    return s + '</svg>';
  }

  /**
   * Bar table: rows of categories, each metric column drawn as its own
   * horizontal bar chart (independent scale unless opts.shared). Measures with
   * different units never share an axis.
   * opts: { labelHeader, rows: [{ label, sub, href, tip, muted, values: {key: n}, notes: {key: text} }],
   *         columns: [{ key, label, format, color }], shared }
   */
  function barTable(opts) {
    const rows = opts.rows || [];
    const cols = opts.columns || [];
    const maxOf = (key) => Math.max(0, ...rows.map((r) => r.values[key]).filter(isNum));
    const sharedMax = Math.max(0, ...cols.map((c) => maxOf(c.key)));
    let s = `<div class="table-wrap"><table class="bartable"><thead><tr><th>${esc(opts.labelHeader || '')}</th>`;
    for (const c of cols) s += `<th class="n">${esc(c.label)}</th>`;
    s += '</tr></thead><tbody>';
    for (const r of rows) {
      const cls = [r.href ? 'clickable' : '', r.muted ? 'muted-row' : ''].filter(Boolean).join(' ');
      s += `<tr${cls ? ` class="${cls}"` : ''}${r.href ? attrs({ href: r.href, tip: r.tip }) : ''}>`;
      s += `<td class="bt-label"><span class="bt-name">${esc(r.label)}</span>${r.sub ? `<span class="bt-sub">${esc(r.sub)}</span>` : ''}</td>`;
      for (const c of cols) {
        const v = r.values[c.key];
        const note = r.notes && r.notes[c.key];
        const max = opts.shared ? sharedMax : maxOf(c.key);
        const pct = isNum(v) && max > 0 ? Math.max(v > 0 ? 1.5 : 0, (v / max) * 100) : 0;
        const label = note || (isNum(v) ? (c.format ? c.format(v) : v.toLocaleString('en-US')) : '—');
        const fill = r.muted ? 'var(--muted-bar)' : c.color || 'var(--s1)';
        s += `<td class="bt-cell"><div class="bt-wrap"><svg class="bt-bar" width="100%" height="12" aria-hidden="true">`;
        if (pct > 0) {
          s += `<rect x="0" y="0" width="${pct.toFixed(2)}%" height="12" rx="4" fill="${fill}"/>`;
          s += `<rect x="0" y="0" width="${(pct / 2).toFixed(2)}%" height="12" fill="${fill}"/>`;
        }
        s += `</svg><span class="bt-val${note ? ' muted' : ''}">${esc(label)}</span></div></td>`;
      }
      s += '</tr>';
    }
    return s + '</tbody></table></div>';
  }

  function legend(series) {
    return `<div class="legend">${series
      .map((s) => `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`)
      .join('')}</div>`;
  }

  window.GtmCharts = { columns, barTable, legend, niceTicks };
})();
