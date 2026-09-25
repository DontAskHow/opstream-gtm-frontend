import { marked } from 'marked';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const date = value => {
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? String(value || '') : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
export function safeUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}
function appendInline(parent, tokens) {
  for (const token of tokens || []) {
    if (token.type === 'link') {
      const href = safeUrl(token.href);
      const node = el(href ? 'a' : 'span');
      if (href) { node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
      appendInline(node, token.tokens || [{ type: 'text', text: token.text }]); parent.append(node);
    } else if (['strong', 'em', 'del'].includes(token.type)) {
      const node = el(token.type); appendInline(node, token.tokens); parent.append(node);
    } else if (token.type === 'codespan') parent.append(el('code', token.text));
    else if (token.type === 'br') parent.append(el('br'));
    else if (token.type === 'image') parent.append(el('span', token.text || 'Image reference'));
    else if (token.tokens) appendInline(parent, token.tokens);
    else parent.append(document.createTextNode(token.text || token.raw || ''));
  }
}
function appendBlocks(parent, tokens) {
  for (const token of tokens) {
    let node;
    if (token.type === 'space') continue;
    if (token.type === 'heading') { node = el('h' + Math.min(6, token.depth + 2)); appendInline(node, token.tokens); }
    else if (token.type === 'list') {
      node = el(token.ordered ? 'ol' : 'ul'); if (token.ordered && token.start) node.start = token.start;
      for (const item of token.items) { const li = el('li'); if (item.task) li.append(el('span', item.checked ? '☑ ' : '☐ ')); appendBlocks(li, item.tokens); node.append(li); }
    } else if (token.type === 'blockquote') { node = el('blockquote'); appendBlocks(node, token.tokens); }
    else if (token.type === 'code') { node = el('pre'); node.append(el('code', token.text)); }
    else if (token.type === 'hr') node = el('hr');
    else if (token.type === 'table') {
      node = el('div', null, 'evidence-table-wrap'); const table = el('table', null, 'table');
      const head = el('thead'), tr = el('tr'); for (const cell of token.header) { const th = el('th'); appendInline(th, cell.tokens); tr.append(th); } head.append(tr); table.append(head);
      const body = el('tbody'); for (const row of token.rows) { const tr = el('tr'); for (const cell of row) { const td = el('td'); appendInline(td, cell.tokens); tr.append(td); } body.append(tr); } table.append(body); node.append(table);
    } else {
      node = el('p'); if (token.tokens) appendInline(node, token.tokens); else node.textContent = token.text || token.raw || '';
    }
    parent.append(node);
  }
}
export function markdown(parent, text) {
  // No HTML from a record is assigned to innerHTML. Raw HTML remains visible text.
  appendBlocks(parent, marked.lexer(String(text || ''), { gfm: true, breaks: false }));
}
const displayValue = value => typeof value === 'number' ? value.toLocaleString('en-US', { maximumFractionDigits: 6 }) : value == null || value === '' ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
function field(parent, label, value) {
  const block = el('div', null, 'evidence-field');
  block.append(el('dt', label)); const detail = el('dd');
  if (Array.isArray(value)) {
    const list = el('ul'); for (const entry of value) { const li = el('li'); markdown(li, typeof entry === 'object' ? entry.name || entry.email || JSON.stringify(entry) : displayValue(entry)); list.append(li); } detail.append(list);
  } else {
    if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value))value=date(value);
    else if(typeof value==='string' && /^-?\d+(\.\d+)?$/.test(value) && !/\bID\b|Deal Stage|Deal owner|HubSpot Deal #/i.test(label))value=Number(value);
    markdown(detail, displayValue(value));
  }
  block.append(detail); parent.append(block);
}
function originalDetails(article, record, headers) {
  const details = el('details', null, 'evidence-original');
  details.append(el('summary', 'Full original record'));
  const pre = el('pre'); pre.textContent = JSON.stringify(record, null, 2); details.append(pre);
  if (headers) { details.append(el('p', 'Worksheet labels from retained row ' + headers.row)); const original = el('pre', JSON.stringify(headers.originalHeader, null, 2)); details.append(original); }
  article.append(details);
}
function sourceRecord(record, labels) {
  const article = el('article', null, 'evidence-record');
  article.dataset.recordRef = record.ref || '';
  article.append(el('h4', record.title));
  article.append(el('p', record.source + (record.capturedAt ? ' · Collected ' + date(record.capturedAt) : ''), 'evidence-source'));
  const fields = record.fields || {}, facts = el('dl', null, 'evidence-facts');
  const header = labels?.[record.snapshotId + '|' + record.sourceId + '|' + fields.Worksheet];
  if (record.sourceId?.startsWith('sheets/')) {
    const rows = String(record.content || '').split('\n').map(line => line.match(/^([A-Z]+): ([\s\S]*)$/)).filter(Boolean);
    for (const row of rows) {
      const column = header?.columns.find(c => c.column === row[1]);
      let label = column?.label || 'Column ' + row[1], value = row[2];
      if (typeof label === 'number') label = date(new Date(Date.UTC(1899, 11, 30) + label * 86400000));
      if (value === '(blank)') value = 'Not recorded';
      else if (/\bDate\b/i.test(label) && /^\d{5}$/.test(value)) value = date(new Date(Date.UTC(1899, 11, 30) + Number(value) * 86400000));
      else if (/^-?\d+(\.\d+)?$/.test(value) && !/\bID\b|HubSpot Deal #/i.test(label)) value = displayValue(Number(value));
      field(facts, label, value);
    }
    article.append(facts); originalDetails(article, record, header); return article;
  }
  if (record.sourceId?.startsWith('lemlist/')) {
    let values = fields['Reported values']; if (!values) { try { values = JSON.parse(record.content); } catch { values = null; } }
    if (values) {
      for (const [key, label] of Object.entries({ state: 'Campaign state', createdBy: 'Created by', senderNames: 'Senders', emailsSent: 'Emails sent', emailsBounced: 'Bounced emails', emailsReplied: 'Email replies', linkedinSent: 'LinkedIn messages sent', linkedinReplied: 'LinkedIn replies' })) {
        if (Object.hasOwn(values, key)) {
          const value = key === 'senderNames' && typeof values[key] === 'string' ? values[key].split(',').map(name => name.trim()).filter(Boolean) : values[key];
          field(facts, label, value);
        }
      }
      article.append(facts, el('p', 'Email and LinkedIn outcomes are reported separately. All source counters remain in the original record.', 'evidence-source'));
      originalDetails(article, record); return article;
    }
  }
  const content = String(record.content || '');
  const normalize = value => String(value).replace(/\s+/g, ' ').trim();
  const seen = new Set([normalize(content)]);
  const long = [],additional=el('dl',null,'evidence-facts');
  const isCrm=record.sourceId?.startsWith('hubspot/');
  const keyFact=/^(Amount|Currency|Close Date|Last Contacted|Recording date|Date|Company|Contact|Email|Action items|Title|Important Features|Missing Features|Decision Success Criteria|Stakeholder Alignment Score|Additional Integrations Discussed)$/i;
  for (const [label, value] of Object.entries(fields)) {
    if (value == null || value === '' || /^(Source formulas|Reported values)$/i.test(label)) continue;
    if (typeof value === 'string' && (seen.has(normalize(value)) || (value.length > 120 && normalize(content).includes(normalize(value))))) continue;
    if (typeof value === 'string' && value.length > 180) long.push([label, value]);
    else field(isCrm&&!keyFact.test(label)?additional:facts, label, value);
    if (typeof value === 'string') seen.add(normalize(value));
  }
  if (facts.children.length) article.append(facts);
  if (content.trim()) { const body = el('div', null, 'evidence-prose'); markdown(body, content); article.append(body); }
  for (const [label, value] of long) { const section = el('section', null, 'evidence-prose'); section.append(el('h5', label)); markdown(section, value); article.append(section); }
  if(additional.children.length){const details=el('details',null,'evidence-original');details.append(el('summary','Additional source fields'),additional);article.append(details);}
  originalDetails(article, record); return article;
}
export function render(container, model, labels = {}) {
  const fragment = document.createDocumentFragment();
  if (model.records?.length) for (const record of model.records) fragment.append(sourceRecord(record, labels));
  else {
    const facts = el('dl', null, 'evidence-facts');
    for (const row of model.rows || []) field(facts, row.label, row.value);
    fragment.append(facts);
  }
  container.replaceChildren(fragment);
}
