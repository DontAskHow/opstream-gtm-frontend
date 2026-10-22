// gtm-preview-refresh: every 15 minutes, rebuild the private preview's data.js
// from the newest published snapshot (written by the sync-only refresh job) and
// upload it only when its content changed. No AI, no provider APIs, no secrets.
// LIVE_PULL=1 additionally pulls HubSpot, lemlist and Fathom directly; it is off
// by default and its permissions are not granted (see README.md).
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readInputs } from '../build.mjs';
import { compose, stamp, sha256, refreshDoc, alarmDecision, problems, isHubspotExport, hubspotLive } from './compose.mjs';
import { publishWorkspace, scrubPatterns, staleness, WORKSPACE_FILE, PROBLEMS as WORKSPACE_PROBLEMS, MAX_AGE_MINUTES, WORKSPACE_STALE_MINUTES, FRESH_STALE_MINUTES } from './workspace-json.mjs';

// A minutes setting from the environment; unset, empty, negative or not a number: the default.
const envMinutes = (name, dflt) => { const n = Number(process.env[name] ?? ''); return process.env[name]?.trim() && Number.isFinite(n) && n >= 0 ? n : dflt; };

export const CONFIG = {
  region: process.env.AWS_REGION || 'us-east-2',
  dataBucket: process.env.DATA_BUCKET || 'opstream-gtm-data-{accountId}',
  latestKey: 'published/LATEST.json',
  previewBucket: process.env.PREVIEW_BUCKET || 'opstream-gtm-preview-db5553a4',
  dataKey: 'data.js',
  refreshKey: 'refresh.json',
  // The one-page workspace's data (onepage/), copied from the snapshot run when its content changes.
  workspaceKey: WORKSPACE_FILE,
  scrubPatterns: scrubPatterns(),
  // Unchanged workspace.json is copied again once the live copy is this old (and the snapshot's is newer).
  workspaceMaxAgeMinutes: envMinutes('WORKSPACE_MAX_AGE_MIN', MAX_AGE_MINUTES),
  // refresh.json `failing` gets workspace-stale / fresh-stale past these (workspace-json.mjs STALE).
  workspaceStaleMinutes: envMinutes('WORKSPACE_STALE_MIN', WORKSPACE_STALE_MINUTES),
  freshStaleMinutes: envMinutes('FRESH_STALE_MIN', FRESH_STALE_MINUTES),
  topicArn: process.env.TOPIC_ARN || 'arn:aws:sns:us-east-2:{accountId}:opstream-gtm-refresh-failures',
  // The sync job publishes every 15 minutes; an older pointer than this alarms.
  staleMinutes: Number(process.env.SNAPSHOT_STALE_MINUTES || 60),
  maxSnapshotFileBytes: 5e6,
  tmp: process.env.SNAPSHOT_TMP || '/tmp/gtm-snapshot',
  livePull: process.env.LIVE_PULL === '1',
  // LIVE_PULL only:
  hubspotCacheKey: '_state/hubspot-live.json',
  secrets: { hubspot: 'opstream-gtm/hubspot-oauth', lemlist: 'opstream-gtm/lemlist-token', fathom: 'opstream-gtm/fathom-token' },
};

// Fills {accountId} in the bucket and topic defaults from the invoked function's ARN
// (arn:aws:lambda:<region>:<account>:function:<name>).
export function configFor(context, cfg = CONFIG) {
  if (![cfg.dataBucket, cfg.topicArn].some((v) => String(v).includes('{accountId}'))) return cfg;
  const account = String(context?.invokedFunctionArn ?? '').split(':')[4] ?? '';
  if (!/^\d{12}$/.test(account)) throw new Error('no account id in context.invokedFunctionArn');
  const fill = (v) => String(v).replace('{accountId}', account);
  return { ...cfg, dataBucket: fill(cfg.dataBucket), topicArn: fill(cfg.topicArn) };
}

// AWS SDK v3 ships with the nodejs20.x runtime; loaded lazily so tests run without it.
export async function awsDeps(cfg = CONFIG) {
  const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
  const s3 = new S3Client({ region: cfg.region });
  const sns = new SNSClient({ region: cfg.region });
  const missing = (e) => e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
  const deps = {
    async getText(bucket, key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return await r.Body.transformToString('utf8');
      } catch (e) { if (missing(e)) return null; throw e; }
    },
    async put(bucket, key, body, { contentType, cacheControl, metadata } = {}) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl, Metadata: metadata }));
    },
    async list(bucket, prefix) {
      const out = [];
      let token;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async notify(subject, message) {
      await sns.send(new PublishCommand({ TopicArn: cfg.topicArn, Subject: subject.slice(0, 99), Message: message }));
    },
  };
  if (cfg.livePull) {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const sm = new SecretsManagerClient({ region: cfg.region });
    deps.secret = async (id) => (await sm.send(new GetSecretValueCommand({ SecretId: id }))).SecretString ?? '';
    deps.fetch = globalThis.fetch;
  }
  return deps;
}

// The snapshot is cached in /tmp per run id, so a warm container reads it once.
let cache = null;
export async function loadSnapshot(deps, cfg = CONFIG) {
  const latestText = await deps.getText(cfg.dataBucket, cfg.latestKey);
  if (!latestText) throw new Error(`${cfg.latestKey} not found`);
  const meta = JSON.parse(latestText);
  const prefix = String(meta.prefix || '');
  if (!/^published\/[A-Za-z0-9._-]+\/$/.test(prefix)) throw new Error('LATEST.json has an unexpected prefix');
  if (cache?.runId === meta.runId && cache?.tmp === cfg.tmp) return cache;
  const objects = await deps.list(cfg.dataBucket, prefix);
  const dir = join(cfg.tmp, String(meta.runId).replace(/[^A-Za-z0-9._-]/g, '_'));
  if (existsSync(cfg.tmp)) for (const d of readdirSync(cfg.tmp)) if (join(cfg.tmp, d) !== dir) rmSync(join(cfg.tmp, d), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Top-level JSON files only (the prep file and the HubSpot export are found by
  // shape), skipping the multi-MB evidence files build.mjs would skip anyway.
  const files = objects.filter((o) => /^[^/]+\.json$/.test(o.key.slice(prefix.length)) && o.size <= cfg.maxSnapshotFileBytes);
  if (!files.some((o) => o.key === prefix + 'records.json')) throw new Error(`snapshot ${meta.runId} has no records.json`);
  let workspaceText = null;
  for (const o of files) {
    const text = await deps.getText(cfg.dataBucket, o.key);
    if (o.key === prefix + WORKSPACE_FILE) { workspaceText = text; continue; }
    writeFileSync(join(dir, o.key.slice(prefix.length)), text);
  }
  const workspaceTooLarge = objects.some((o) => o.key === prefix + WORKSPACE_FILE && o.size > cfg.maxSnapshotFileBytes);
  const snapshot = readInputs(dir);
  for (const f of readdirSync(dir).sort()) {
    if (f === 'records.json') continue;
    let j;
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (isHubspotExport(j)) {
      // deals pass through whole (companyIds, ownerHistory, closed_lost_reason); companies and owners resolve them.
      snapshot.hubspotExport = { live: hubspotLive(j), fetchedAt: j.fetchedAt ?? j.generatedAt ?? meta.publishedAt ?? null };
      break;
    }
  }
  // build.mjs only lists transcripts that records.json links to; same here.
  const ids = objects.map((o) => /^transcripts\/([A-Za-z0-9_-]+)\.json$/.exec(o.key.slice(prefix.length))?.[1]).filter(Boolean).sort();
  const wanted = new Set((snapshot.records?.companies || []).flatMap((c) => (c.recordings || []).filter((r) => r.hasTranscript).map((r) => r.id)));
  cache = { runId: meta.runId, tmp: cfg.tmp, meta, snapshot, transcripts: ids.filter((t) => wanted.has(t)), workspaceText, workspaceTooLarge };
  return cache;
}

const errText = (e) => String(e?.message || e).replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]').slice(0, 300);

// LIVE_PULL=1 only. The provider code is imported here so the default build never loads it.
async function pullLive(deps, cfg, { since, now }) {
  const { fetchHubspot, fetchLemlist, fetchFathom } = await import('./sources.mjs');
  const run = async (key, fn) => {
    const t0 = Date.now();
    try {
      const raw = await deps.secret(cfg.secrets[key]);
      return { ok: true, ...(await fn(raw)), ms: Date.now() - t0 };
    } catch (e) { return { ok: false, error: errText(e), ms: Date.now() - t0 }; }
  };
  const [hubspot, lemlist, fathom] = await Promise.all([
    run('hubspot', (raw) => fetchHubspot(raw, { fetchImpl: deps.fetch })),
    run('lemlist', (raw) => fetchLemlist(raw, { fetchImpl: deps.fetch, now })),
    run('fathom', (raw) => fetchFathom(raw, { fetchImpl: deps.fetch, since })),
  ]);
  const live = { hubspot, lemlist, fathom };
  if (!hubspot.ok) {
    const t = await deps.getText(cfg.previewBucket, cfg.hubspotCacheKey).catch(() => null);
    try { const c = t ? JSON.parse(t) : null; if (c?.live) hubspot.fallback = c; } catch { /* no usable cache */ }
  }
  return live;
}

export async function refresh(deps, { cfg = CONFIG, now = () => new Date(), log = console.log } = {}) {
  const started = now();
  const prevText = await deps.getText(cfg.previewBucket, cfg.refreshKey);
  let prev = {};
  try { prev = prevText ? JSON.parse(prevText) : {}; } catch { prev = {}; }

  const snap = await loadSnapshot(deps, cfg);
  // The one-page workspace first, so a problem in the older data.js build never holds it back.
  const ws = cfg.workspaceKey
    ? await publishWorkspace({
      deps, previewBucket: cfg.previewBucket, key: cfg.workspaceKey, runId: snap.runId, prev: prev.workspace || {},
      text: snap.workspaceText, tooLarge: snap.workspaceTooLarge, patterns: cfg.scrubPatterns || [], nowIso: now().toISOString(),
      // LATEST.json's mode: 'sync-only' runs write workspace.json; the 6-hourly full run (no mode) does not.
      snapshotMode: snap.meta.mode ?? null,
      maxAgeMinutes: cfg.workspaceMaxAgeMinutes ?? MAX_AGE_MINUTES,
    })
    : { block: null, problem: null, uploaded: false };
  let live = null;
  if (cfg.livePull) {
    const gen = Date.parse(snap.snapshot.records?.generatedAt ?? '');
    const since = new Date((Number.isFinite(gen) ? gen : started.getTime()) - 3 * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    live = await pullLive(deps, cfg, { since, now: started });
  }

  // Last good HubSpot export, persisted in the preview bucket, used when the snapshot has none.
  let lastGood = null;
  if (!snap.snapshot.hubspotExport?.live) {
    const t = await deps.getText(cfg.previewBucket, cfg.hubspotCacheKey).catch(() => null);
    try { const c = t ? JSON.parse(t) : null; if (c?.live) lastGood = c; } catch { /* no usable cache */ }
  }
  const { text, hash, data, vols } = compose({ snapshot: snap.snapshot, meta: snap.meta, transcripts: snap.transcripts, live, prev, lastGood });
  const changed = hash !== prev.dataSha256;
  const nowIso = now().toISOString();
  if (changed) {
    await deps.put(cfg.previewBucket, cfg.dataKey, stamp(text, nowIso, vols), { contentType: 'application/javascript; charset=utf-8', cacheControl: 'no-store', metadata: { sha256: hash } });
  }
  let hubspotSha256 = prev.hubspotSha256;
  if (!live?.hubspot.ok && snap.snapshot.hubspotExport?.live) {
    const hsHash = sha256(JSON.stringify(snap.snapshot.hubspotExport.live));
    if (hsHash !== prev.hubspotSha256) await deps.put(cfg.previewBucket, cfg.hubspotCacheKey, JSON.stringify({ fetchedAt: snap.snapshot.hubspotExport.fetchedAt ?? nowIso, live: snap.snapshot.hubspotExport.live }), { contentType: 'application/json', cacheControl: 'no-store' });
    hubspotSha256 = hsHash;
  }
  if (live?.hubspot.ok) {
    const hsHash = sha256(JSON.stringify(live.hubspot.live));
    if (hsHash !== prev.hubspotSha256) await deps.put(cfg.previewBucket, cfg.hubspotCacheKey, JSON.stringify({ fetchedAt: nowIso, live: live.hubspot.live }), { contentType: 'application/json', cacheControl: 'no-store' });
    hubspotSha256 = hsHash;
  }

  const failing = problems({ live, hubspotMode: data.refresh.hubspot, snapshotPublishedAt: snap.meta.publishedAt, nowMs: Date.parse(nowIso), staleMinutes: cfg.staleMinutes });
  if (ws.problem) failing.push(ws.problem);
  // The live copy's own age, after this run's upload (if any).
  const age = ws.block ? staleness(ws.block, nowIso, { workspaceStaleMinutes: cfg.workspaceStaleMinutes ?? WORKSPACE_STALE_MINUTES, freshStaleMinutes: cfg.freshStaleMinutes ?? FRESH_STALE_MINUTES }) : null;
  if (age) {
    failing.push(...age.failing);
    ws.block.writtenAgeMinutes = age.writtenAgeMinutes;
    ws.block.freshAges = age.freshAges;
  }
  // Workspace problems alarm once when they start (and when they clear), with no daily reminder.
  // workspace-stale and fresh-stale are not among them: they remind daily, like snapshot-stale.
  const alarm = alarmDecision({ failing, prev, nowMs: Date.parse(nowIso), quiet: Object.values(WORKSPACE_PROBLEMS) });
  let lastAlarmAt = prev.lastAlarmAt ?? null;
  if (alarm.send) {
    const lines = [
      `snapshot ${snap.runId}, published ${snap.meta.publishedAt ?? 'unknown'}`,
      `HubSpot figures: ${{ live: 'live pull', snapshot: 'the snapshot’s HubSpot export', 'last-good': 'the last good live pull', records: 'records.json only (the snapshot has no HubSpot pipeline export; shown as unreconciled)' }[data.refresh.hubspot]}`,
    ];
    if (failing.includes('snapshot-stale')) lines.push(`LATEST.json is older than ${cfg.staleMinutes} minutes: is the sync job running?`);
    if (ws.block) lines.push(`workspace.json: ${ws.block.status}${ws.problem ? ' (' + ws.problem + (ws.block.errors.length ? ': ' + ws.block.errors.join('; ') : '') + '); the page keeps the last good copy from ' + (ws.block.publishedGeneratedAt || 'never') : ''}`);
    if (age?.failing.length) lines.push(`workspace.json on the page: last written ${ws.block.writtenAt || ws.block.publishedGeneratedAt || 'never'} (${age.writtenAgeMinutes ?? '?'} min ago); fresh section ages (min): ${age.freshAges ? Object.entries(age.freshAges).map(([k, a]) => `${k} ${a ?? '?'}`).join(', ') || 'none' : 'unknown'}. Is the sync job publishing?`);
    if (live) for (const k of ['hubspot', 'lemlist', 'fathom']) lines.push(`${k}: ${live[k].ok ? 'ok' : 'FAILED - ' + live[k].error}`);
    if (live?.hubspot.rotated) lines.push('HubSpot returned a new refresh token. It was NOT saved (this function cannot write secrets); check opstream-gtm/hubspot-oauth.');
    await deps.notify(
      failing.length ? `GTM preview refresh: ${failing.join(', ')}` : 'GTM preview refresh: problems cleared',
      `${alarm.reason}. The preview keeps serving the best data it has, labelled on the page.\n${lines.join('\n')}`,
    );
    lastAlarmAt = nowIso;
  }

  const doc = refreshDoc({ nowIso, hash, changed, prev, live, runId: snap.runId, snapshotPublishedAt: snap.meta.publishedAt, failing, lastAlarmAt, vols });
  if (hubspotSha256) doc.hubspotSha256 = hubspotSha256;
  if (ws.block) doc.workspace = ws.block;
  await deps.put(cfg.previewBucket, cfg.refreshKey, JSON.stringify(doc), { contentType: 'application/json', cacheControl: 'no-store' });

  const summary = {
    changed, sha256: hash, snapshot: snap.runId, snapshotPublishedAt: snap.meta.publishedAt ?? null, livePull: !!live,
    failing, alarm: alarm.send ? alarm.reason : null, hubspotMode: data.refresh.hubspot, deals: data.deals.length,
    workspace: ws.block ? { status: ws.block.status, ...(ws.block.reason ? { reason: ws.block.reason } : {}), uploaded: ws.uploaded, sha256: ws.block.sha256, problem: ws.problem, writtenAgeMinutes: ws.block.writtenAgeMinutes ?? null, freshAges: ws.block.freshAges ?? null } : null,
    ...(live ? { sources: Object.fromEntries(Object.entries(live).map(([k, r]) => [k, { ok: r.ok, ms: r.ms, ...(r.ok ? { detail: r.detail } : { error: r.error }) }])) } : {}),
    ms: Date.now() - started.getTime(),
  };
  log(JSON.stringify(summary));
  return summary;
}

// Event {"dryRun": true}: read everything, write nothing, publish nothing.
// Any error: alarm, then rethrow so the invocation fails (Errors metric -> CloudWatch alarm).
// makeDeps is for tests; Lambda passes no third argument (or a callback, which has no makeDeps).
export async function handler(event = {}, context = {}, { makeDeps = awsDeps } = {}) {
  let deps;
  try {
    const cfg = configFor(context);
    deps = await makeDeps(cfg);
    if (event?.dryRun === true) {
      return { dryRun: true, ...(await refresh({ ...deps, put: async () => {}, notify: async () => {} }, { cfg })) };
    }
    return await refresh(deps, { cfg });
  } catch (e) {
    console.error('gtm-preview-refresh failed:', errText(e));
    try { await deps?.notify('GTM preview refresh FAILED', `The refresh did not complete; the preview still serves the previous data.js.\n${errText(e)}`); } catch (n) { console.error('SNS publish failed:', errText(n)); }
    throw e;
  }
}
