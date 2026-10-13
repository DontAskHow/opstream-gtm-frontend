// Published snapshot (+ optional live sources) -> the data.js text and its
// content hash. Pure: no network, no clock. Every value that only says *when*
// something was fetched or published (source times, the snapshot run id, the
// check time) is written as a placeholder, so the hash changes only when the
// content does; the sync job re-publishing identical data every 15 minutes
// uploads nothing. stamp() puts the real values back just before an upload,
// and refresh.json carries the current ones on every check.
import { createHash } from 'node:crypto';
import { buildData } from '../lib/project.mjs';
import { dataJsText } from '../build.mjs';
import { matchRecording } from './sources.mjs';

export const NOW_TOKEN = '@@GTM_REFRESHED_AT@@';
export const LIVE_SOURCES = ['hubspot', 'lemlist', 'fathom'];
const LABELS = { hubspot: 'HubSpot', lemlist: 'LemList', fathom: 'Fathom' };

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const VOL = /"@@GTM_V\d+@@"/g;
const jsonValue = (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c');
// Fills the placeholders: each volatile value, and NOW_TOKEN (also inside them) with the check time.
export function stamp(text, iso, vols = {}) {
  const now = (v) => (v === NOW_TOKEN ? iso : v);
  return text.replace(VOL, (m) => jsonValue(now(vols[m.slice(1, -1)]))).split(NOW_TOKEN).join(iso);
}
// The current volatile values, resolved, for refresh.json (the page applies them over data.js).
export function stamps(vols, iso) {
  const out = {};
  for (const [path, token] of Object.entries(vols.paths || {})) out[path] = vols[token] === NOW_TOKEN ? iso : vols[token] ?? null;
  return out;
}

// The snapshot's HubSpot deal export, found by shape (like the prep file), so
// no file name is written into this repo: {pipes, stages, deals[{id, properties}]}.
export function isHubspotExport(j) {
  return !!(j && typeof j === 'object' && j.pipes && typeof j.pipes === 'object' && j.stages && typeof j.stages === 'object'
    && Array.isArray(j.deals) && j.deals.every((d) => d && d.id != null && d.properties && typeof d.properties === 'object'));
}

// The parts of an export (or last-good copy) the build reads: the deals unchanged, plus the
// optional companies (account names) and owners (owner names, archived included) catalogs.
export function hubspotLive(j) {
  const out = { pipes: j.pipes, stages: j.stages, deals: j.deals };
  for (const k of ['companies', 'owners']) if (j[k] && typeof j[k] === 'object') out[k] = j[k];
  return out;
}

// New live Fathom recordings are added to the snapshot's accounts (LIVE_PULL
// only); recordings already in the snapshot are left exactly as published.
export function mergeRecordings(records, recordings) {
  const companies = (records?.companies || []).map((c) => ({ ...c, recordings: [...(c.recordings || [])] }));
  const unmatched = [...(records?.unmatchedRecordings || [])];
  const known = new Set([...companies.flatMap((c) => c.recordings), ...unmatched].map((r) => String(r.nativeId ?? r.id)));
  const byId = new Map(companies.map((c) => [c.id, c]));
  let added = 0;
  for (const r of recordings || []) {
    if (known.has(r.nativeId)) continue;
    known.add(r.nativeId);
    const { _inviteeDomains, ...rec } = r;
    const cid = matchRecording(r, companies);
    if (cid && byId.has(cid)) byId.get(cid).recordings.push(rec); else unmatched.push(rec);
    added++;
  }
  return { records: { ...records, companies, unmatchedRecordings: unmatched }, added };
}

// snapshot: readInputs() of the published run, plus hubspotExport ({live, fetchedAt}) when the run has one.
// live (LIVE_PULL=1 only): { hubspot|lemlist|fathom: {ok, live?|outbound?|recordings?, detail?, error?, fallback?} }.
// Without live, every source is as published by the sync job.
export function compose({ snapshot, meta, transcripts = [], live = null, prev = {}, lastGood = null }) {
  const hs = live?.hubspot || {};
  const lm = live?.lemlist || {};
  const fa = live?.fathom || {};

  let recon = null;
  let hubspotMode = 'records';
  if (live && hs.ok) { recon = { live: hs.live, fetchedAt: NOW_TOKEN }; hubspotMode = 'live'; }
  else if (snapshot.hubspotExport?.live) { recon = snapshot.hubspotExport; hubspotMode = 'snapshot'; }
  else if (live && hs.fallback?.live) { recon = { live: hs.fallback.live, fetchedAt: hs.fallback.fetchedAt ?? null }; hubspotMode = 'last-good'; }
  else if (lastGood?.live) { recon = { live: lastGood.live, fetchedAt: lastGood.fetchedAt ?? null }; hubspotMode = 'last-good'; }
  // HubSpot is mandatory: never build pipeline figures from records.json.
  if (!recon) throw new Error('no HubSpot deal export (snapshot live_deals.json or last-good copy); keeping the previous data.js');

  const { records, added } = live && fa.ok ? mergeRecordings(snapshot.records, fa.recordings) : { records: snapshot.records, added: 0 };
  const mk = snapshot.marketing || {};
  const outbound = live && lm.ok ? { ...lm.outbound, fetchedAt: NOW_TOKEN } : mk.outbound;

  const snapSources = Array.isArray(mk.sources) ? mk.sources : [];
  let sources = snapSources.map((s) => ({ ...s, fromSnapshot: true }));
  if (live) {
    const fallbackText = {
      hubspot: hubspotMode === 'snapshot' ? 'showing the snapshot’s HubSpot export' : hubspotMode === 'last-good' ? 'showing the last successful HubSpot pull' : 'showing the CRM snapshot (unreconciled)',
      lemlist: 'showing the snapshot', fathom: 'showing the snapshot',
    };
    sources = sources.filter((s) => !LIVE_SOURCES.includes(s.source));
    for (const key of LIVE_SOURCES) {
      const r = live[key] || {};
      const snapRow = snapSources.find((s) => s.source === key);
      sources.push({
        source: key, label: LABELS[key], ok: !!r.ok, at: NOW_TOKEN, live: true,
        lastOkAt: r.ok ? NOW_TOKEN : (prev.sources?.[key]?.lastOkAt ?? snapRow?.lastOkAt ?? null),
        detail: r.ok ? `live: ${r.detail || 'ok'}` : `live pull failed (${r.error || 'unknown error'}); ${fallbackText[key]}`,
      });
    }
  }

  const data = buildData({ ...snapshot, records, marketing: { ...mk, outbound, sources }, recon, transcripts, expect: null });
  data.builtAt = NOW_TOKEN;
  data.refreshedAt = NOW_TOKEN;
  data.dataChangedAt = NOW_TOKEN;
  data.times.recordings = live && fa.ok ? NOW_TOKEN : data.times.records;
  data.refresh = {
    snapshot: { runId: meta.runId ?? null, publishedAt: meta.publishedAt ?? null, generatedAt: snapshot.records?.generatedAt ?? null },
    // Sheet and GA4 values are always as of the snapshot.
    sheetAsOf: snapshot.sheetReview?.generatedAt ?? null,
    hubspot: hubspotMode,
    lemlist: live && lm.ok ? 'live' : 'snapshot', fathom: live && fa.ok ? 'live' : 'snapshot',
    liveRecordingsAdded: added,
  };
  // Volatile values -> placeholders, in a fixed order. vols.paths names each one for refresh.json.
  const vols = { paths: {} };
  let n = 0;
  const vol = (path, v) => { const k = `@@GTM_V${n++}@@`; vols[k] = v ?? null; vols.paths[path] = k; return k; };
  for (const k of Object.keys(data.times)) data.times[k] = vol(`times.${k}`, data.times[k]);
  for (const src of data.sources) { src.at = vol(`sources.${src.source}.at`, src.at); src.lastOkAt = vol(`sources.${src.source}.lastOkAt`, src.lastOkAt); }
  data.quality.sheetGeneratedAt = vol('quality.sheetGeneratedAt', data.quality.sheetGeneratedAt);
  for (const k of ['runId', 'publishedAt', 'generatedAt']) data.refresh.snapshot[k] = vol(`refresh.snapshot.${k}`, data.refresh.snapshot[k]);
  data.refresh.sheetAsOf = vol('refresh.sheetAsOf', data.refresh.sheetAsOf);
  const text = dataJsText(data);
  return { data, text, hash: sha256(text), vols };
}

// Problems worth an alarm. Without LIVE_PULL the function only watches the
// snapshot it was handed: a stale pointer or a missing HubSpot export.
export function problems({ live, hubspotMode, snapshotPublishedAt, nowMs, staleMinutes }) {
  const out = [];
  if (live) {
    for (const k of LIVE_SOURCES) if (!live[k]?.ok) out.push(k);
    if (live.hubspot?.rotated) out.push('hubspot-refresh-token-rotated');
  }
  if (hubspotMode === 'records') out.push('snapshot-has-no-hubspot-export');
  const pub = Date.parse(snapshotPublishedAt ?? '');
  if (!Number.isFinite(pub) || nowMs - pub > staleMinutes * 60e3) out.push('snapshot-stale');
  return out;
}

// refresh.json: written on every successful check. The page reads refreshedAt;
// the next run reads dataSha256 and the alarm fields.
export function refreshDoc({ nowIso, hash, changed, prev = {}, live, runId, snapshotPublishedAt, failing, lastAlarmAt, vols }) {
  const doc = {
    refreshedAt: nowIso,
    dataChangedAt: changed ? nowIso : (prev.dataChangedAt ?? null),
    dataSha256: hash, snapshotRunId: runId ?? null, snapshotPublishedAt: snapshotPublishedAt ?? null,
    failing, lastAlarmAt: lastAlarmAt ?? null,
    stamps: vols ? stamps(vols, nowIso) : {},
  };
  if (live) {
    doc.sources = {};
    for (const key of LIVE_SOURCES) {
      const ok = !!live[key]?.ok;
      doc.sources[key] = { ok, lastOkAt: ok ? nowIso : (prev.sources?.[key]?.lastOkAt ?? null) };
    }
  }
  return doc;
}

// Alarm when the set of problems changes (including recovery), and again once
// a day while something keeps failing. Hard errors alarm separately.
export function alarmDecision({ failing, prev = {}, nowMs, remindMs = 24 * 3600e3, quiet = [] }) {
  const before = Array.isArray(prev.failing) ? prev.failing : [];
  const same = before.length === failing.length && before.every((f, i) => f === failing[i]);
  const last = Date.parse(prev.lastAlarmAt ?? '') || 0;
  if (!same) return { send: true, reason: failing.length ? 'changed' : 'recovered' };
  // `quiet` problems alarm once when they start or clear, never as a daily reminder.
  if (failing.some((f) => !quiet.includes(f)) && nowMs - last >= remindMs) return { send: true, reason: 'reminder' };
  return { send: false };
}
