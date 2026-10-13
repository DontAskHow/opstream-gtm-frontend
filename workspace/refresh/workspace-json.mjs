// workspace.json: the one-page workspace's data, written by scripts/workspace-data.py
// inside the sync job and published with each snapshot run. Every refresh run checks the
// published copy (including a trial render with the page's own code) and copies it to the
// preview bucket only when its content changed (timestamps aside). A missing or invalid copy
// keeps the last good one, except when a newly added scrub pattern matches: then the live
// copy is replaced by a small "withheld" document, because the name must not stay visible.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const WORKSPACE_FILE = 'workspace.json';
export const SCHEMA_VERSION = 1;
export const MAX_BYTES = 3 * 1048576;
export const PROBLEMS = {
  missing: 'snapshot-has-no-workspace-json',
  invalid: 'workspace-json-invalid',
  noPatterns: 'workspace-scrub-patterns-missing',
  withheld: 'workspace-withheld-scrub-match',
};
// What the page reads without a guard (onepage/page.cjs, view.cjs).
export const REQUIRED_KEYS = ['meta', 'freshness', 'flags', 'headline', 'deals', 'closed', 'leads', 'ads', 'meetings', 'calls', 'scope', 'rules'];

// Keys whose values say only *when* (the same set the sync job's content hash ignores,
// refresh/run.py VOLATILE_KEYS), plus a successful source's per-run detail.
export const VOLATILE_KEYS = new Set(['generatedAt', 'runId', 'collectedAt', 'publishedAt', 'carriedFrom',
  'at', 'lastOkAt', 'fetchedAt', 'channelsFetchedAt', 'capturedAt']);

export function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const okSource = value.ok === true && 'source' in value;
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(k) || (okSource && k === 'detail')) continue;
      out[k] = stripVolatile(value[k]);
    }
    return out;
  }
  return value;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const contentHash = (doc) => sha256(JSON.stringify(stripVolatile(doc)));
export const textHash = (text) => sha256(text);
// Identifies a pattern set in refresh.json without ever storing the patterns.
export const patternsHash = (patterns) => sha256([...patterns].sort().join('\n'));

// Scrub patterns come from the Lambda's environment (set by deploy.sh), never the repo.
export function scrubPatterns(env = process.env) {
  return [...new Set(String(env.WORKSPACE_SCRUB_PATTERNS || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

// Every string (keys too) after JSON decoding, so a \uXXXX-escaped name is caught as well.
function decodedHits(doc, patterns) {
  const hits = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { const low = v.toLowerCase(); patterns.forEach((p, i) => { if (low.includes(p)) hits.add(i); }); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k); walk(x); }
  };
  walk(doc);
  return [...hits];
}

// The page's own view and render code (pure): a file that would not render never replaces the live copy.
function renderCheck(doc) {
  const { buildView } = require('../../onepage/view.cjs');
  const page = require('../../onepage/page.cjs');
  const v = buildView(doc, null);
  const first = (xs) => (Array.isArray(xs) && xs.length ? xs[0] : null);
  const states = [{}, { src: first(v.leads.sources) || '', lead: (first(v.leads.items) || {}).id || '' },
    { mo: '*', mtg: (first(v.meetings.items) || {}).id || '' }, { co: (first(v.calls.items) || {}).recorder || '', call: (first(v.calls.items) || {}).id || '' },
    { deal: (first(v.deals) || {}).id || '', rv: '1', pd: Object.keys((v.paidDeals || {}).byPlatform || {})[0] || '' }];
  for (const s of states) page.renderPage(v, Object.fromEntries(Object.entries(s).filter(([, x]) => x)), { now: Date.now() });
}

// The checks a published workspace.json must pass before the page may show it. Errors never
// quote the file (a parse error message would) and never name a pattern, only its position.
export function validateWorkspace(text, patterns) {
  if (typeof text !== 'string') return { ok: false, errors: ['not text'] };
  const low = text.toLowerCase();
  const raw = patterns.map((p, i) => (low.includes(p) ? i : -1)).filter((i) => i >= 0);
  if (raw.length) return { ok: false, scrubHit: true, errors: raw.map((i) => `scrub check: pattern #${i + 1} appears`) };
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, errors: [`larger than ${MAX_BYTES} bytes`] };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, errors: ['not valid JSON'] }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['not a JSON object'] };
  const decoded = decodedHits(doc, patterns);
  if (decoded.length) return { ok: false, scrubHit: true, errors: decoded.map((i) => `scrub check: pattern #${i + 1} appears (escaped)`) };
  const errors = [];
  if (doc.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion is not ${SCHEMA_VERSION}`);
  for (const k of REQUIRED_KEYS) if (doc[k] == null || typeof doc[k] !== 'object') errors.push(`${k} missing`);
  const h = doc.headline;
  if (!h || !h.open || !Number.isFinite(h.open.count) || !Number.isFinite(h.open.amount)) errors.push('headline.open missing');
  if (!doc.meta || !Number.isFinite(Date.parse(doc.meta.generatedAt || doc.meta.asOf || ''))) errors.push('meta.generatedAt missing');
  if (!errors.length) {
    try { renderCheck(doc); } catch (e) { errors.push(`does not render (${e && e.name ? e.name : 'Error'})`); }
  }
  return { ok: errors.length === 0, errors, doc };
}

// The timestamps the page applies over the live copy when the content is unchanged
// (onepage/view.cjs applyStamps). Keyed to the sha256 of the live object's text.
export function workspaceStamps(doc, forTextSha256) {
  return {
    forTextSha256,
    generatedAt: doc.meta?.generatedAt ?? doc.meta?.asOf ?? null,
    hubspotFetchedAt: doc.meta?.hubspot?.fetchedAt ?? null,
    freshness: (doc.freshness || []).map((f) => ({ source: f.source, ok: f.ok, at: f.at ?? null, lastOkAt: f.lastOkAt ?? null, detail: f.detail ?? null })),
  };
}

// Served in place of the data when a newly matching scrub pattern is found. The page shows it as a notice.
export function withheldDocument(nowIso) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION, withheld: true, meta: { generatedAt: nowIso },
    notice: 'The workspace data is withheld: the latest snapshot contains a name that must not appear on this page. It comes back with the next clean snapshot.',
  });
}

const put = (deps, bucket, key, text, sha) => deps.put(bucket, key, text, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store', metadata: { sha256: sha } });

// One run: decide and (when needed) upload. prev = refresh.json's `workspace` block from the last run.
// Returns the new `workspace` block for refresh.json and the problem (if any) for the alarm.
export async function publishWorkspace({ deps, previewBucket, key = WORKSPACE_FILE, text, tooLarge = false, runId, prev = {}, patterns, nowIso }) {
  const pSha = patterns.length ? patternsHash(patterns) : null;
  const base = {
    publishedSha256: prev.publishedSha256 ?? null, publishedTextSha256: prev.publishedTextSha256 ?? null,
    publishedGeneratedAt: prev.publishedGeneratedAt ?? null, publishedRunId: prev.publishedRunId ?? null,
    publishedPatternsSha256: prev.publishedPatternsSha256 ?? null, withheld: !!prev.withheld, runId: runId ?? null, checkedAt: nowIso,
  };
  const keep = (problem, errors) => ({
    block: { ...base, status: base.withheld ? 'withheld' : 'kept-last-good', problem, errors: errors || [], sha256: null, stamps: base.withheld ? null : prev.stamps ?? null },
    problem, uploaded: false,
  });
  if (!patterns.length) return keep(PROBLEMS.noPatterns);
  if (tooLarge) return keep(PROBLEMS.invalid, ['too large to read']);
  if (text == null) return keep(PROBLEMS.missing);
  const v = validateWorkspace(text, patterns);
  if (!v.ok) {
    // A pattern that matches now, under a pattern set the live copy was never checked with:
    // the live copy may show the name too. Replace it rather than keep it.
    if (v.scrubHit && !base.withheld && base.publishedPatternsSha256 !== pSha) {
      const doc = withheldDocument(nowIso);
      const tSha = textHash(doc);
      await put(deps, previewBucket, key, doc, tSha);
      return {
        block: { ...base, status: 'withheld', problem: PROBLEMS.withheld, errors: v.errors, sha256: null, publishedSha256: null, publishedTextSha256: tSha,
          publishedGeneratedAt: nowIso, publishedRunId: null, publishedPatternsSha256: pSha, withheld: true, stamps: null },
        problem: PROBLEMS.withheld, uploaded: true,
      };
    }
    return keep(base.withheld ? PROBLEMS.withheld : PROBLEMS.invalid, v.errors);
  }
  const sha = contentHash(v.doc);
  if (sha === base.publishedSha256 && !base.withheld) {
    // Same content as the live copy, now also checked against the current patterns.
    return { block: { ...base, status: 'unchanged', problem: null, errors: [], sha256: sha, publishedPatternsSha256: pSha, stamps: workspaceStamps(v.doc, base.publishedTextSha256) }, problem: null, uploaded: false };
  }
  const tSha = textHash(text);
  await put(deps, previewBucket, key, text, tSha);
  return {
    block: { ...base, status: 'uploaded', problem: null, errors: [], sha256: sha, publishedSha256: sha, publishedTextSha256: tSha,
      publishedGeneratedAt: v.doc.meta?.generatedAt ?? v.doc.meta?.asOf ?? null, publishedRunId: runId ?? null, publishedPatternsSha256: pSha,
      withheld: false, stamps: workspaceStamps(v.doc, tSha) },
    problem: null, uploaded: true,
  };
}
