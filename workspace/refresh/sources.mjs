// Live, read-only pulls for the preview refresh: HubSpot deals (every pipeline)
// with pipeline/stage metadata, lemlist campaigns with stats, and recent Fathom
// recordings. Ported from the refresh job's brain-sync scripts (common.py,
// lemlist_sync.py, fathom_sync.py). Credentials go only to the provider host
// that owns them and are never logged. Google (Sheets, GA4) is deliberately not
// here: those fields come from the published snapshot.

// The expected HubSpot portal, from the environment (LIVE_PULL only); every call checks it.
const portalFromEnv = () => String(process.env.HUBSPOT_PORTAL_ID || '').trim();
const HUBSPOT_HOST = 'api.hubapi.com';
const HUBSPOT_FIELDS = ['portal_id', 'client_id', 'client_secret', 'refresh_token', 'token_endpoint', 'api_base'];
// The deal properties workspace/lib/project.mjs reads (the live_deals.json export shape).
export const DEAL_PROPERTIES = [
  'amount', 'closedate', 'createdate', 'dealname', 'dealstage', 'hs_deal_stage_probability',
  'hs_forecast_probability', 'hs_is_closed', 'hs_is_closed_won', 'hubspot_owner_id', 'pipeline',
];
const LEMLIST_HOST = 'api.lemlist.com';
const FATHOM_HOST = 'api.fathom.ai';

export class SourceError extends Error {
  constructor(source, message) { super(`${source}: ${message}`); this.source = source; }
}

// Plain-text secrets or JSON with a token field, as common.materialize_token reads them.
export function tokenFromSecret(raw, source) {
  const text = String(raw ?? '').trim();
  if (!text) throw new SourceError(source, 'secret is empty');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  if (parsed && typeof parsed === 'object') {
    for (const k of ['token', 'access_token', 'api_key', 'apiKey', 'value']) {
      if (typeof parsed[k] === 'string' && parsed[k].trim()) return parsed[k].trim();
    }
  }
  throw new SourceError(source, 'secret JSON has no token field');
}

async function call(fetchImpl, source, url, init = {}, { timeoutMs = 30000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...init });
  } catch (e) {
    throw new SourceError(source, `${init.method || 'GET'} ${new URL(url).pathname} failed (${e.name})`);
  }
  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

// ---------- HubSpot ----------

// GET only (plus POST to the OAuth token endpoint, done separately). Mirrors
// common.assert_hubspot_read without the CRM-search POST, which is not used here.
export function assertHubspotRead(method, url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== HUBSPOT_HOST) throw new Error('refusing to send a HubSpot credential to this host');
  if (String(method).toUpperCase() !== 'GET') throw new Error(`refusing HubSpot ${method} ${u.pathname}; only GET is allowed`);
}

export function validateHubspotDoc(doc, portalId = portalFromEnv()) {
  if (!portalId) throw new SourceError('hubspot', 'HUBSPOT_PORTAL_ID is not set; refusing to call HubSpot');
  if (!doc || typeof doc !== 'object') throw new SourceError('hubspot', 'OAuth secret is not a JSON object');
  for (const k of HUBSPOT_FIELDS) {
    if (typeof doc[k] !== 'string' || !doc[k].trim()) throw new SourceError('hubspot', `OAuth secret is missing ${k}`);
  }
  if (String(doc.portal_id) !== portalId) throw new SourceError('hubspot', 'secret portal_id is not the expected portal');
  const t = new URL(doc.token_endpoint);
  const a = new URL(doc.api_base);
  if (t.protocol !== 'https:' || t.hostname !== HUBSPOT_HOST || !t.pathname.startsWith('/oauth/')) throw new SourceError('hubspot', 'token endpoint is not allowed');
  if (a.protocol !== 'https:' || a.hostname !== HUBSPOT_HOST) throw new SourceError('hubspot', 'API host is not allowed');
  return a.origin;
}

// Exchanges the stored refresh token for an access token, in memory only. The
// secret is never written back (the role has no PutSecretValue). If HubSpot ever
// returns a different refresh token, `rotated` is set so the caller can alarm.
export async function hubspotAccessToken(secretRaw, fetchImpl = fetch, portalId = portalFromEnv()) {
  let doc;
  try { doc = JSON.parse(secretRaw); } catch { throw new SourceError('hubspot', 'OAuth secret is not JSON'); }
  const apiBase = validateHubspotDoc(doc, portalId);
  const form = new URLSearchParams({
    grant_type: 'refresh_token', client_id: doc.client_id, client_secret: doc.client_secret, refresh_token: doc.refresh_token,
  });
  const r = await call(fetchImpl, 'hubspot', doc.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  if (r.status !== 200) throw new SourceError('hubspot', `token endpoint returned HTTP ${r.status}`);
  const access = r.json?.access_token;
  if (typeof access !== 'string' || !access) throw new SourceError('hubspot', 'token endpoint did not return an access token');
  if (r.json.hub_id != null && String(r.json.hub_id) !== portalId) throw new SourceError('hubspot', 'hub_id is not the expected portal');
  const next = r.json.refresh_token;
  const rotated = typeof next === 'string' && next !== '' && next !== doc.refresh_token;
  return { access, apiBase, rotated, checkedHub: r.json.hub_id != null };
}

async function hubspotGet(fetchImpl, token, url) {
  assertHubspotRead('GET', url);
  for (let attempt = 0; ; attempt++) {
    const r = await call(fetchImpl, 'hubspot', url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (r.status === 429 && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    if (r.status !== 200) throw new SourceError('hubspot', `GET ${new URL(url).pathname} returned HTTP ${r.status}`);
    return r.json;
  }
}

// Returns the live_deals.json shape workspace/lib/project.mjs reads:
// {pipes: id -> label, stages: id -> {pipe, label, closed, prob}, deals: [{id, properties}]},
// sorted so the same HubSpot state always gives the same bytes.
export async function fetchHubspot(secretRaw, { fetchImpl = fetch, maxPages = 50, portalId = portalFromEnv() } = {}) {
  const { access, apiBase, rotated, checkedHub } = await hubspotAccessToken(secretRaw, fetchImpl, portalId);
  if (!checkedHub) {
    const info = await hubspotGet(fetchImpl, access, apiBase + '/account-info/v3/details');
    if (String(info?.portalId) !== portalId) throw new SourceError('hubspot', 'portalId is not the expected portal');
  }
  const pj = await hubspotGet(fetchImpl, access, apiBase + '/crm/v3/pipelines/deals');
  const pipes = {};
  const stages = {};
  for (const p of [...(pj?.results || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    pipes[String(p.id)] = String(p.label ?? '');
    for (const s of p.stages || []) {
      const md = s.metadata || {};
      const prob = md.probability;
      stages[String(s.id)] = {
        pipe: String(p.label ?? ''), label: String(s.label ?? ''),
        closed: md.isClosed === true || md.isClosed === 'true',
        prob: prob == null || prob === '' ? null : String(prob),
      };
    }
  }
  const deals = [];
  let after = null;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new SourceError('hubspot', `more than ${maxPages} pages of deals`);
    const q = new URLSearchParams({ limit: '100', archived: 'false', properties: DEAL_PROPERTIES.join(',') });
    if (after) q.set('after', after);
    const r = await hubspotGet(fetchImpl, access, `${apiBase}/crm/v3/objects/deals?${q}`);
    for (const d of r?.results || []) {
      const props = {};
      for (const k of DEAL_PROPERTIES) props[k] = d.properties?.[k] ?? null;
      deals.push({ id: String(d.id), properties: props });
    }
    after = r?.paging?.next?.after || null;
    if (!after) break;
  }
  deals.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (!Object.keys(stages).length) throw new SourceError('hubspot', 'no deal pipelines returned');
  return { live: { pipes, stages, deals }, rotated, detail: `${deals.length} deals, ${Object.keys(pipes).length} pipelines, ${Object.keys(stages).length} stages` };
}

// ---------- lemlist ----------

// The same projection as marketing-data.py outbound(), from live API rows.
export function outboundFromCampaigns(rows) {
  const stat = (src, ...keys) => {
    for (const k of keys) { const v = src[k]; if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v); }
    return null;
  };
  const withStats = [];
  const codes = {};
  const byStatus = {};
  for (const r of rows) {
    for (const a of r.statsAttempts || []) { const k = String(a.http ?? a.error ?? 'no answer'); codes[k] = (codes[k] || 0) + 1; }
    const key = String(r.status || 'unknown');
    byStatus[key] = (byStatus[key] || 0) + 1;
    const src = r.stats && typeof r.stats === 'object' ? r.stats : null;
    if (!src) continue;
    withStats.push({
      name: String(r.name || ''), status: r.status ?? null, campaignId: String(r._id || r.id || '') || null,
      sent: stat(src, 'messagesSent', 'emailsSent', 'sent'), delivered: stat(src, 'delivered'),
      opened: stat(src, 'opened', 'nbLeadsOpened'), replied: stat(src, 'replied', 'nbLeadsAnswered', 'messagesReplied'),
      bounced: stat(src, 'messagesBounced', 'bounced'), meetings: stat(src, 'meetingBooked'),
    });
  }
  withStats.sort((a, b) => (b.sent || 0) - (a.sent || 0) || String(a.campaignId).localeCompare(String(b.campaignId)));
  return {
    campaigns: rows.length, byStatus,
    names: rows.filter((r) => r.status === 'running').map((r) => String(r.name || '')).sort(),
    statsRoute: 'GET /api/v2/campaigns/{campaignId}/stats', statsResponses: codes,
    statsConnected: withStats.length > 0, connected: withStats.length > 0, campaignStats: withStats,
  };
}

export async function fetchLemlist(secretRaw, { fetchImpl = fetch, now = new Date(), concurrency = 2, retryMs = 1500 } = {}) {
  const key = tokenFromSecret(secretRaw, 'lemlist');
  const basic = 'Basic ' + Buffer.from(':' + key).toString('base64');
  // lemlist rate-limits bursts (429); back off and retry so a busy second doesn't drop a campaign's stats.
  const get = async (path) => {
    for (let attempt = 0; ; attempt++) {
      const r = await call(fetchImpl, 'lemlist', `https://${LEMLIST_HOST}${path}`, { headers: { Accept: 'application/json', Authorization: basic } });
      if (r.status !== 429 || attempt >= 3) return r;
      await sleep(retryMs * (attempt + 1));
    }
  };
  // The refresh job lists campaigns with ?access_token=; Basic auth is tried first so the key stays out of the URL.
  let list = await get('/api/campaigns');
  if (list.status === 401 || list.status === 403) {
    list = await call(fetchImpl, 'lemlist', `https://${LEMLIST_HOST}/api/campaigns?access_token=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } });
  }
  const campaigns = Array.isArray(list.json) ? list.json : Array.isArray(list.json?.campaigns) ? list.json.campaigns : null;
  if (list.status !== 200 || !campaigns) throw new SourceError('lemlist', `GET /api/campaigns returned HTTP ${list.status}`);
  const end = now.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const rows = campaigns.filter((c) => c && (c._id || c.id)).sort((a, b) => String(a._id || a.id).localeCompare(String(b._id || b.id)));
  await mapLimit(rows, concurrency, async (c) => {
    const cid = encodeURIComponent(String(c._id || c.id));
    const start = String(c.createdAt || '2024-01-01T00:00:00.000Z');
    const r = await get(`/api/v2/campaigns/${cid}/stats?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`).catch((e) => ({ status: null, error: e.name }));
    c.statsAttempts = [{ route: '/api/v2/campaigns/{campaignId}/stats', auth: 'basic', ...(r.status == null ? { error: r.error } : { http: r.status }) }];
    if (r.status === 200 && r.json && typeof r.json === 'object' && !Array.isArray(r.json)) c.stats = r.json;
  });
  const outbound = outboundFromCampaigns(rows);
  if (rows.length && !outbound.statsConnected) throw new SourceError('lemlist', `stats unavailable for every campaign (${JSON.stringify(outbound.statsResponses)})`);
  return { outbound, detail: `${rows.length} campaigns, stats for ${outbound.campaignStats.length} (HTTP ${JSON.stringify(outbound.statsResponses)})` };
}

// ---------- Fathom ----------

const cleanDomain = (d) => (d ? String(d).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '') || null : null);
const cleanName = (n) => String(n || '').toLowerCase()
  .replace(/\b(inc|llc|ltd|co|corp|corporation|company|group|technologies|technology|systems)\b\.?/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const personName = (v) => {
  const raw = String(v || '').split(/\s+/).filter(Boolean).join(' ');
  return raw && raw === raw.toLowerCase() && !raw.includes('@') ? raw.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : raw;
};
// gtm_metrics.customer_facing_action
const BLOCKED_ACTIONS = ['building maintenance', 'pest control', 'office cleanliness', 'report intake', 'validation bug', 'to engineers', 'internal only'];
const customerFacing = (t) => { const low = String(t || '').toLowerCase(); return !!low.trim() && !BLOCKED_ACTIONS.some((b) => low.includes(b)); };

function summaryBlocks(md) {
  const out = [];
  for (const para of String(md || '').split('\n\n')) {
    if (!para.trim()) continue;
    for (const raw of para.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('### ')) out.push({ t: 'h3', x: line.slice(4).trim() });
      else if (line.startsWith('## ')) out.push({ t: 'h2', x: line.slice(3).trim() });
      else if (line.startsWith('- ')) out.push({ t: 'li', x: line.slice(2).trim() });
      else out.push({ t: 'p', x: line });
    }
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

// One Fathom meeting -> the records.json recording shape brain-data.py writes.
// Transcripts are not fetched (the refresh never uploads transcript files).
export function recordingFromFathom(m) {
  const rid = String(m.recording_id);
  const mins = m.recording_start_time && m.recording_end_time
    ? Math.floor((Date.parse(m.recording_end_time) - Date.parse(m.recording_start_time)) / 60000) : null;
  const cleaned = (Array.isArray(m.action_items) ? m.action_items : [])
    .map((a) => (a && typeof a === 'object' ? a.description : null)).filter(Boolean)
    .map((a) => String(a).replace(/[*_`#]+/g, '').split(/\s+/).filter(Boolean).join(' '));
  const invitees = (Array.isArray(m.calendar_invitees) ? m.calendar_invitees : []).filter((i) => i && typeof i === 'object');
  return {
    id: `recording-${rid}`, nativeId: rid, title: m.title || m.meeting_title || '', date: m.recording_start_time || null,
    minutes: Number.isFinite(mins) ? mins : null,
    recordedBy: personName(m.recorded_by?.name) || m.recorded_by?.email || null,
    invitees: invitees.map((i) => ({ name: i.name ?? null, email: i.email ?? null })),
    _inviteeDomains: invitees.filter((i) => i.is_external && i.email_domain).map((i) => cleanDomain(i.email_domain)),
    summary: summaryBlocks(m.default_summary?.markdown_formatted),
    actions: cleaned.filter(customerFacing), internalActions: cleaned.filter((a) => a && !customerFacing(a)),
    hasTranscript: false, transcriptLines: null, live: true,
  };
}

// Matches recordings to companies the way brain-data.py does: external invitee
// domain first, then a company name contained in the title (or vice versa).
export function matchRecording(rec, companies) {
  const byDomain = new Map();
  for (const c of companies) { const d = cleanDomain(c.domain); if (d && !byDomain.has(d)) byDomain.set(d, c.id); }
  for (const d of rec._inviteeDomains || []) if (d && byDomain.has(d)) return byDomain.get(d);
  const t = cleanName(rec.title);
  for (const c of companies) {
    const cn = cleanName(c.name);
    if (cn.length >= 4 && (t.includes(cn) || (t && cn.includes(t)))) return c.id;
  }
  return null;
}

export async function fetchFathom(secretRaw, { fetchImpl = fetch, since, maxPages = 5 } = {}) {
  const key = tokenFromSecret(secretRaw, 'fathom');
  const items = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ created_after: since, include_summary: 'true', include_action_items: 'true' });
    if (cursor) q.set('cursor', cursor);
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await call(fetchImpl, 'fathom', `https://${FATHOM_HOST}/external/v1/meetings?${q}`, { headers: { Accept: 'application/json', 'X-Api-Key': key } });
      if (r.status === 429 && attempt < 1) { await sleep(5000); continue; }
      break;
    }
    if (r.status !== 200 || !Array.isArray(r.json?.items)) throw new SourceError('fathom', `GET /external/v1/meetings returned HTTP ${r.status}`);
    items.push(...r.json.items.filter((m) => m && m.recording_id != null));
    cursor = r.json.next_cursor || null;
    if (!cursor) break;
  }
  const recordings = items.map(recordingFromFathom).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.nativeId.localeCompare(b.nativeId));
  return { recordings, detail: `${recordings.length} recordings created since ${since}` };
}

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
