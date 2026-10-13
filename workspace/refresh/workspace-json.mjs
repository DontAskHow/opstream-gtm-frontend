// workspace.json: the one-page workspace's data, written by scripts/workspace-data.py
// inside the sync job and published with each snapshot run. Every refresh run checks the
// published copy and copies it to the preview bucket only when its content changed
// (timestamps aside). A missing or invalid copy keeps the last good one in place.
import { createHash } from 'node:crypto';

export const WORKSPACE_FILE = 'workspace.json';
export const SCHEMA_VERSION = 1;
export const MAX_BYTES = 3 * 1048576;
export const PROBLEMS = {
  missing: 'snapshot-has-no-workspace-json',
  invalid: 'workspace-json-invalid',
  noPatterns: 'workspace-scrub-patterns-missing',
};

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

export const contentHash = (doc) => createHash('sha256').update(JSON.stringify(stripVolatile(doc))).digest('hex');

// Scrub patterns come from the Lambda's environment (set by deploy.sh), never the repo.
export function scrubPatterns(env = process.env) {
  return [...new Set(String(env.WORKSPACE_SCRUB_PATTERNS || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

// The checks a published workspace.json must pass before the page may show it.
export function validateWorkspace(text, patterns) {
  const errors = [];
  if (typeof text !== 'string') return { ok: false, errors: ['not text'] };
  if (Buffer.byteLength(text) > MAX_BYTES) errors.push(`larger than ${MAX_BYTES} bytes`);
  let doc = null;
  try { doc = JSON.parse(text); } catch (e) { return { ok: false, errors: ['not valid JSON: ' + e.message] }; }
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['not a JSON object'] };
  if (doc.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion ${JSON.stringify(doc.schemaVersion)}, expected ${SCHEMA_VERSION}`);
  const h = doc.headline;
  if (!h || !h.open || !Number.isFinite(h.open.count) || !Number.isFinite(h.open.amount)) errors.push('headline.open missing');
  if (!doc.meta || !Number.isFinite(Date.parse(doc.meta.generatedAt || doc.meta.asOf || ''))) errors.push('meta.generatedAt missing');
  const low = text.toLowerCase();
  // Never echo the pattern itself into logs or alarms.
  patterns.forEach((p, i) => { if (low.includes(p)) errors.push(`scrub check: pattern #${i + 1} appears`); });
  return { ok: errors.length === 0, errors, doc };
}

// The timestamps the page applies over an unchanged copy (onepage/view.cjs applyStamps).
export function workspaceStamps(doc) {
  return {
    generatedAt: doc.meta?.generatedAt ?? doc.meta?.asOf ?? null,
    hubspotFetchedAt: doc.meta?.hubspot?.fetchedAt ?? null,
    freshness: (doc.freshness || []).map((f) => ({ source: f.source, ok: f.ok, at: f.at ?? null, lastOkAt: f.lastOkAt ?? null, detail: f.detail ?? null })),
  };
}

// One run: decide and (when needed) upload. prev = refresh.json's `workspace` block from the last run.
// Returns the new `workspace` block for refresh.json and the problem (if any) for the alarm.
export async function publishWorkspace({ deps, previewBucket, key = WORKSPACE_FILE, text, tooLarge = false, runId, prev = {}, patterns, nowIso }) {
  const base = { publishedSha256: prev.publishedSha256 ?? null, publishedGeneratedAt: prev.publishedGeneratedAt ?? null, publishedRunId: prev.publishedRunId ?? null, runId: runId ?? null, checkedAt: nowIso };
  const keep = (status, problem, errors) => ({ block: { ...base, status, problem, errors: errors || [], sha256: null, stamps: prev.stamps ?? null }, problem, uploaded: false });
  if (!patterns.length) return keep('kept-last-good', PROBLEMS.noPatterns);
  if (tooLarge) return keep('kept-last-good', PROBLEMS.invalid, ['too large to read']);
  if (text == null) return keep('kept-last-good', PROBLEMS.missing);
  const v = validateWorkspace(text, patterns);
  if (!v.ok) return keep('kept-last-good', PROBLEMS.invalid, v.errors);
  const sha = contentHash(v.doc);
  const stamps = workspaceStamps(v.doc);
  if (sha === prev.publishedSha256) {
    return { block: { ...base, status: 'unchanged', problem: null, errors: [], sha256: sha, stamps }, problem: null, uploaded: false };
  }
  await deps.put(previewBucket, key, text, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store', metadata: { sha256: sha } });
  return {
    block: { ...base, status: 'uploaded', problem: null, errors: [], sha256: sha, publishedSha256: sha, publishedGeneratedAt: stamps.generatedAt, publishedRunId: runId ?? null, stamps },
    problem: null, uploaded: true,
  };
}
