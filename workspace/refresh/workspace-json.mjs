// workspace.json: the one-page workspace's data, written by scripts/workspace-data.py
// inside the sync job and published with each snapshot run. Every refresh run checks the
// published copy (including a trial render with the page's own code) and copies it to the
// preview bucket when its content changed (timestamps aside), or when the live copy is older
// than WORKSPACE_MAX_AGE_MIN and the snapshot's copy is newer, so the times in the file (the
// fresh frontend reads fresh.*.fetchedAt from it) keep moving in a quiet period. A missing or invalid copy
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

// refresh.json `failing` entries for a live copy that has stopped moving. They alarm like the
// snapshot problems (daily reminder), and the page does not show them: it reads `workspace.status`
// and `workspace.problem`, which these leave alone.
export const STALE = { workspace: 'workspace-stale', fresh: 'fresh-stale' };
// Defaults (the Lambda's environment overrides them; handler.mjs CONFIG). The sync job republishes
// unchanged content every ~30 min (refresh/run.py PUBLISH_MAX_AGE_MIN=25) and this function runs
// every 15, so in a quiet period the live copy is rewritten every 30-45 min and, around the
// 6-hourly job's skip window, up to ~60 min; its fresh.*.fetchedAt run ~12 min older than that.
// The stale limits sit above those, so the normal cadence never flags.
export const MAX_AGE_MINUTES = 25;
export const WORKSPACE_STALE_MINUTES = 60;
export const FRESH_STALE_MINUTES = 75;

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

// fresh.<section>.fetchedAt of each available section (docs/workspace-fresh.md), or null without `fresh`.
export function freshTimes(doc) {
  const f = doc && doc.fresh;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = {};
  for (const [k, s] of Object.entries(f)) if (s && typeof s === 'object' && !Array.isArray(s) && s.available === true) out[k] = s.fetchedAt ?? null;
  return out;
}

// How old the live copy is: when this function last wrote it (before writtenAt was recorded: the
// build time of the file it wrote, which is earlier) and each fresh section's fetch time. Unknown
// or unparseable times are reported as null and never flag.
export function staleness(block, nowIso, { workspaceStaleMinutes = WORKSPACE_STALE_MINUTES, freshStaleMinutes = FRESH_STALE_MINUTES } = {}) {
  const now = Date.parse(nowIso);
  const ageMin = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? Math.round((now - t) / 60e3) : null; };
  const writtenAge = ageMin(block?.writtenAt ?? block?.publishedGeneratedAt);
  const freshAges = block?.freshAt ? Object.fromEntries(Object.entries(block.freshAt).map(([k, at]) => [k, ageMin(at)])) : null;
  const failing = [];
  if (writtenAge != null && writtenAge > workspaceStaleMinutes) failing.push(STALE.workspace);
  if (freshAges && Object.values(freshAges).some((a) => a != null && a > freshStaleMinutes)) failing.push(STALE.fresh);
  return { failing, writtenAgeMinutes: writtenAge, freshAges };
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
// Only the sync-only job (every 15 minutes) writes workspace.json; the 6-hourly full job's
// snapshot (LATEST.json mode other than 'sync-only') has none, and the next sync-only run
// brings it back. Such a snapshot is not a problem unless no sync-only snapshot with a good
// workspace.json has been seen for longer than this.
export const MISSING_GRACE_MINUTES = 60;

export async function publishWorkspace({ deps, previewBucket, key = WORKSPACE_FILE, text, tooLarge = false, runId, prev = {}, patterns, nowIso, snapshotMode = 'sync-only', graceMinutes = MISSING_GRACE_MINUTES, maxAgeMinutes = MAX_AGE_MINUTES }) {
  const pSha = patterns.length ? patternsHash(patterns) : null;
  // When a sync-only snapshot last brought a good workspace.json (a run before this field existed: its check time).
  const seenAt = prev.workspaceSeenAt ?? (['uploaded', 'unchanged'].includes(prev.status) ? prev.checkedAt ?? null : null);
  const base = {
    publishedSha256: prev.publishedSha256 ?? null, publishedTextSha256: prev.publishedTextSha256 ?? null,
    publishedGeneratedAt: prev.publishedGeneratedAt ?? null, publishedRunId: prev.publishedRunId ?? null,
    publishedPatternsSha256: prev.publishedPatternsSha256 ?? null, withheld: !!prev.withheld, runId: runId ?? null, checkedAt: nowIso,
    snapshotMode: snapshotMode ?? null, workspaceSeenAt: seenAt,
    // When this function last wrote the live copy, and that copy's fresh.<section>.fetchedAt.
    writtenAt: prev.writtenAt ?? null, freshAt: prev.freshAt ?? null,
  };
  const keep = (problem, errors, note) => ({
    block: { ...base, status: base.withheld ? 'withheld' : 'kept-last-good', problem, errors: errors || [], sha256: null, stamps: base.withheld ? null : prev.stamps ?? null, ...(note ? { note } : {}) },
    problem, uploaded: false,
  });
  if (!patterns.length) return keep(PROBLEMS.noPatterns);
  if (tooLarge) return keep(PROBLEMS.invalid, ['too large to read']);
  if (text == null) {
    const age = seenAt ? Date.parse(nowIso) - Date.parse(seenAt) : NaN;
    if (snapshotMode !== 'sync-only' && Number.isFinite(age) && age <= graceMinutes * 60e3) {
      // Expected: the 6-hourly snapshot. Keep the last good copy, no alarm, no banner.
      return keep(null, [], `the latest snapshot is from the ${snapshotMode || 'full'} job, which does not write workspace.json; the last sync-only snapshot with one was seen ${Math.round(age / 60e3)} min ago`);
    }
    return keep(PROBLEMS.missing);
  }
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
          publishedGeneratedAt: nowIso, publishedRunId: null, publishedPatternsSha256: pSha, withheld: true, stamps: null, writtenAt: nowIso, freshAt: null },
        problem: PROBLEMS.withheld, uploaded: true,
      };
    }
    return keep(base.withheld ? PROBLEMS.withheld : PROBLEMS.invalid, v.errors);
  }
  const sha = contentHash(v.doc);
  const tSha = textHash(text);
  const generatedAt = v.doc.meta?.generatedAt ?? v.doc.meta?.asOf ?? null;
  const sameContent = sha === base.publishedSha256 && !base.withheld;
  // Same content, but the live copy is older than maxAgeMinutes and this one is newer: upload it
  // anyway, so the times in the file move (an unknown live time counts as old).
  const liveAt = Date.parse(base.publishedGeneratedAt ?? '');
  const refreshAge = sameContent && tSha !== base.publishedTextSha256
    && !(Date.parse(nowIso) - liveAt <= maxAgeMinutes * 60e3) && !(Date.parse(generatedAt ?? '') <= liveAt);
  if (sameContent && !refreshAge) {
    // Same content as the live copy, now also checked against the current patterns.
    // The same text is the same file: its fresh times are the live copy's (fills them in after deploy).
    const freshAt = tSha === base.publishedTextSha256 ? freshTimes(v.doc) : base.freshAt;
    return { block: { ...base, status: 'unchanged', problem: null, errors: [], sha256: sha, publishedPatternsSha256: pSha, workspaceSeenAt: nowIso, freshAt, stamps: workspaceStamps(v.doc, base.publishedTextSha256) }, problem: null, uploaded: false };
  }
  await put(deps, previewBucket, key, text, tSha);
  return {
    block: { ...base, status: 'uploaded', reason: refreshAge ? 'refresh-age' : 'content', problem: null, errors: [], sha256: sha, publishedSha256: sha, publishedTextSha256: tSha,
      publishedGeneratedAt: generatedAt, publishedRunId: runId ?? null, publishedPatternsSha256: pSha,
      withheld: false, workspaceSeenAt: nowIso, writtenAt: nowIso, freshAt: freshTimes(v.doc), stamps: workspaceStamps(v.doc, tSha) },
    problem: null, uploaded: true,
  };
}
