// Agent server for the Opstream GTM workspace demo.
// Serves out/ statically and exposes POST /api/ask, which grounds an
// OpenAI model in the workspace's real company-brain data and returns answers plus
// agentic actions (create_draft, navigate) for the frontend to execute.
// Auth goes through the vault-stored `custom.openai` connector via the
// openai skill CLI (~/workspace/skills/openai/bin/chat.py). The raw key
// never appears here: no env var, no file, no log.
//
// Gmail OAuth (per-user): Each user connects their OWN Gmail via Google OAuth.
// Tokens are stored server-side keyed by session cookie. Requires:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET env vars.
// The OAuth client must have the redirect URI registered in Google Cloud Console.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { DATA_TOOL_SCHEMAS, collectedLabel, computeFacts, dataRevision, needsReload, runAssistantTool } from './workspace-facts.mjs';

const CHAT_CLI = path.join(process.env.HOME || '/home/hatch', 'workspace/skills/openai/bin/chat.py');

// Per-user Gmail OAuth token storage: sessionId -> { accessToken, refreshToken, email, expiresAt }
const gmailSessions = new Map();

// OAuth state for CSRF: state -> { sessionId, createdAt }
const oauthStates = new Map();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
// Production fallback for OpenAI access. On this machine the vault-backed
// skill CLI is used (the raw key never appears anywhere). On Elastic
// Beanstalk there is no vault, so when OPENAI_API_KEY is set the server
// calls api.openai.com directly instead. The value is only ever sent as an
// Authorization header, never logged or written.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
// Public base URL of the production deployment (e.g. https://d1l47t29dh34cq.cloudfront.net).
// When set, the Gmail OAuth redirect URI is derived from it so it always matches
// the URI registered with Google. Otherwise fall back to the request's host/proto.
const OAUTH_PUBLIC_BASE_URL = (process.env.OAUTH_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const getOAuthRedirectUri = (req) => {
  if (OAUTH_PUBLIC_BASE_URL) return `${OAUTH_PUBLIC_BASE_URL}/api/gmail/oauth/callback`;
  // Use the request's host to build the redirect URI dynamically.
  // The OAuth client must have this URI registered.
  const host = req.headers.host || '127.0.0.1:4173';
  const proto = req.headers['x-forwarded-proto'] || req.headers['cloudfront-forwarded-proto'] || 'http';
  return `${proto}://${host}/api/gmail/oauth/callback`;
};

// Session management: get or create session ID from cookie
const getSessionId = (req, res) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, v.join('=')];
  }));
  let sid = cookies['gtm_sid'];
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    // Set cookie (append to existing Set-Cookie if any)
    const existing = res.getHeader('Set-Cookie');
    const cookie = `gtm_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
    res.setHeader('Set-Cookie', existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : cookie);
  }
  return sid;
};

// Refresh a user's Gmail access token if expired
const refreshGmailToken = async (session) => {
  if (!session.refreshToken) throw new Error('No refresh token');
  if (session.expiresAt > Date.now() + 60000) return session.accessToken; // Still valid
  
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: session.refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || 'Token refresh failed');
  session.accessToken = j.access_token;
  session.expiresAt = Date.now() + (j.expires_in * 1000);
  return session.accessToken;
};

// Send email via Gmail API using user's OAuth token
const sendGmailApi = async (accessToken, to, subject, body) => {
  // Build RFC 2822 message
  const msg = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  const raw = Buffer.from(msg).toString('base64url');
  
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Gmail API send failed');
  return j;
};

// Get user's email via Gmail API
const getGmailProfile = async (accessToken) => {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Profile fetch failed');
  return j.emailAddress;
};

const root = path.resolve('out');
const dataDir = path.join(root, 'data');
const PORT = Number(process.env.PORT || 4173);
const MODEL = process.env.OPENAI_MODEL || 'gpt-6-sol';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let CTX = '';
let FACTS = null;
let revision = '';
function clip(value, n) {
  const raw = String(value ?? '');
  return raw.length > n ? raw.slice(0, n) : raw;
}
function buildContext() {
  try {
    // Parse each file once. The facts object keeps the open-book lines, not the records.
    const verified = readJson(path.join(dataDir, 'verified.json'));
    const records = readJson(path.join(dataDir, 'records.json'));
    const trunc = (s, n) => clip(s, n).replace(/\s+/g, ' ');
    FACTS = computeFacts(verified, records);
    const lines = [FACTS.context];
    // Call summaries + action items (NOT full transcripts: too large for per-question context).
    for (const c of records.companies || []) {
      for (const r of c.recordings || []) {
        let summ = '';
        for (const part of r.summary || []) {
          if (summ.length >= 500) break;
          const piece = String(part && part.x != null ? part.x : part);
          summ += (summ ? ' ' : '') + piece.slice(0, 500 - summ.length);
        }
        const acts = (r.actions || []).slice(0, 6).map(a => clip(a, 80)).join('; ');
        lines.push(`- CALL "${clip(r.title, 120)}" (${String(r.date).slice(0, 10)}, ${clip(c.name, 120)}): ${trunc(summ, 500)}${acts ? ' Action items: ' + trunc(acts, 300) : ''}`);
      }
    }
    for (const p of verified.presentation?.priorities || []) {
      lines.push(`- PRIORITY: ${p.title}. Why: ${p.why} Next: ${p.next}`);
    }
    for (const d of verified.drafts || []) {
      lines.push(`- DRAFT: "${d.draft.title}" (${d.draft.purpose}, ${d.draft.status}) for ${d.draft.company}.`);
    }
    // Hollie operator output: brief + queue headlines so /api/ask can answer
    // "what should Hollie do today?" from the operator's own prioritization.
    try {
      const hop = readJson(path.join(dataDir, 'hollie.json'));
      const trunc = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
      lines.push(`HOLLIE OPERATOR BRIEF (generated ${hop.generatedAt || 'unknown'}):`);
      const b = hop.brief || {};
      const bc = hop.stats?.briefCounts || {};
      lines.push(`- BRIEF: ${bc.meetingsToday ?? '?'} meetings today/tomorrow, ${bc.quietDeals ?? '?'} deals gone quiet (14+ days), ${bc.followupsOwed ?? '?'} calls with open action items, ${bc.newLeads ?? '?'} unworked leads.`);
      for (const g of (hop.goals || [])) {
        lines.push(`- HOLLIE GOAL: ${g.title} — ${g.status}`);
      }
      for (const q of (hop.queue || []).slice(0, 20)) {
        lines.push(`- HOLLIE QUEUE [${q.kind}${q.goal ? '/' + q.goal : ''}]${q.isNew ? ' (new)' : ''}: ${trunc(q.title, 90)} — ${trunc(q.why, 160)}`);
      }
      for (const pr of (hop.prep || []).slice(0, 8)) {
        lines.push(`- HOLLIE PREP: "${trunc(pr.title, 70)}" ${String(pr.start).slice(0, 16)}${pr.company ? ' @ ' + pr.company : ''}. Agenda: ${trunc((pr.suggestedAgenda || []).join('; '), 160)}`);
      }
      lines.push(`- AUTONOMY: meeting_prep=${hop.autonomy?.meeting_prep}, draft_followups=${hop.autonomy?.draft_followups}, crm_updates=${hop.autonomy?.crm_updates}, send_anything=${hop.autonomy?.send_anything}, external_messages=${hop.autonomy?.external_messages}. The operator never sends anything.`);
    } catch {}
    // The agent's own proactive morning brief, so /api/ask can discuss it.
    try {
      const ab = readJson(path.join(dataDir, 'agent-brief.json'));
      if (ab && (ab.paragraphs || []).length) {
        lines.push(`AGENT MORNING BRIEF (written ${ab.generatedAt || 'unknown'}): ${(ab.greeting || '')} ${(ab.paragraphs || []).join(' ').slice(0, 900)}`);
        if ((ab.whatsNew || []).length) lines.push(`- BRIEF NEW: ${(ab.whatsNew || []).slice(0, 5).join(' | ')}`);
        if ((ab.watchOuts || []).length) lines.push(`- BRIEF WATCH: ${(ab.watchOuts || []).slice(0, 5).join(' | ')}`);
      }
    } catch {}
    // Pending CRM proposals (workspace-only; nothing written to HubSpot).
    try {
      const props = readJson(path.join(dataDir, 'crm-proposals.json'));
      const open = (Array.isArray(props) ? props : []).filter(p => p.status === 'proposed').slice(-8);
      for (const p of open) lines.push(`- CRM PROPOSAL (pending review): ${p.company}${p.deal ? ' / ' + p.deal : ''} — ${p.field}: "${p.currentValue}" → "${p.proposedValue}". Why: ${(p.rationale || '').slice(0, 160)}`);
    } catch {}
    CTX = lines.join('\n');
    try { fs.writeFileSync('/tmp/agent-ctx-size.txt', String(CTX.length)); } catch {}
    return true;
  } catch (e) {
    CTX = 'Workspace data unavailable: ' + e.message;
    FACTS = null;
    return false;
  }
}
// Read the files for this request. Keep the parsed context only while the
// watched files still have the same mtime and size they had when it was built.
function ensureContext() {
  const next = dataRevision(dataDir);
  if (!needsReload(revision, next) && FACTS) return FACTS;
  if (buildContext()) revision = next;
  return FACTS;
}
// Facts are built on the first ask, then kept until the watched files change.
// Building them at import time is what exhausted a 1 GB instance.

const SYSTEM = `You are the GTM Workspace assistant for Opstream — the marketing lead runs marketing and this workspace is their autonomous copilot.

All workspace data below is REAL: live records from the company brain (HubSpot, Fathom calls, Sheets, email). Never invent records, names, owners, dates, amounts, or meetings. If something is not in the data, say so plainly. Missing values are null, not zero.

AUTONOMY (hard rules — never break these):
- You may DRAFT follow-up emails and queue them in the workspace, PREPARE meeting briefs, and PROPOSE CRM updates for Hollie to review.
- You NEVER send anything, never message anyone externally, and never write to HubSpot or any source system. Drafts and proposals stay inside the workspace until a human acts.
- Say "drafted" or "proposed" — never "sent".

Answer using only the workspace data. Be concise and concrete: names, numbers, dates.
The open book is already computed in the OPEN BOOK METRICS lines and in get_pipeline_metrics. It excludes past close dates, renewals, current agreements, Disqualified, and On Hold. Repeat those figures. A larger renewal, current agreement, on-hold, disqualified, or past-close amount is not the largest open deal. If you mention one, name that reason and say it is not in the open book. Owner labels that start with "Owner #…" mean the name is not connected; do not invent a person's name. Quiet-day figures in the data are already computed; repeat them. The DATA COLLECTED line is the timestamp of the files on disk. Repeat it when you give current pipeline or lead figures.
Format your answer as a compact HTML fragment using only <p>, <ul>, <ol>, <li>, <strong>, <em>, <br>. Output raw HTML only, never markdown — markdown is displayed to the user as literal asterisks and dashes. No code fences, no <h1>.

You can also take actions with tools:
- get_pipeline_metrics: read the computed open-book totals, the largest open deal, and quarter leads, MQL, and SQL.
- lookup_deals: look up a company or deal. Results label renewals and other deals that are not in the open book.
- create_draft: write a follow-up email draft into the workspace (the app opens it in Drafts). Use it when the user asks to draft/write/email/follow up. The "company" argument must be an account name from the data. Write a real, specific email using the account's context (owner, contacts, deal stage, last interaction). Keep it under 180 words.
- propose_crm_update: propose a CRM field change for Hollie's review. It is stored as a proposal inside the workspace — nothing is written to HubSpot. Use when data looks stale or wrong (e.g. a deal sitting in a stage too long, a missing close date). Always include the current value (or "unknown") and your rationale.
- mark_queue_item: mark one of Hollie's operator queue items done or dismissed by its item id (ids look like q:<kind>:<id> and appear in the HOLLIE QUEUE context lines). Use when she says something is handled.
- read_briefing: read the latest proactive morning brief the assistant wrote for Hollie. Use when she asks what's new, what changed, or what to focus on today.
- navigate: jump the UI to a view (today, performance, accounts, meetings, drafts, data) or to a specific account/meeting by name.

Always include a brief text reply summarizing what you found or did, alongside any tool calls. Never claim to have sent an email — sending is disabled; drafts are only created.`;

const TOOLS = [
  ...DATA_TOOL_SCHEMAS,
  {
    type: 'function',
    function: {
      name: 'create_draft',
      description: 'Create a follow-up email draft in the workspace for an account.',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Account name, e.g. Northstar Labs' },
          title: { type: 'string', description: 'Draft title' },
          subject: { type: 'string', description: 'Email subject line' },
          text: { type: 'string', description: 'Full email body as plain text' },
          recipients: { type: 'string', description: 'Recipient email(s), comma-separated' }
        },
        required: ['company', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_crm_update',
      description: 'Propose a single CRM field change for Hollie to review. Stored as a proposal inside the workspace only — nothing is written to HubSpot or any source system. Only call when you can name a CONCRETE new value (a specific stage label, date, or owner from the data). Never use "unknown" as the proposed value — if you do not know what it should be, say so instead of proposing. Make at most one proposal per user request unless they explicitly ask for several.',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Account name from the data' },
          deal: { type: 'string', description: 'Deal name, if the proposal concerns a deal' },
          field: { type: 'string', description: 'Field to change, e.g. stage, close date, owner' },
          currentValue: { type: 'string', description: 'Current value in the data, or "unknown"' },
          proposedValue: { type: 'string', description: 'Proposed new value' },
          rationale: { type: 'string', description: 'Why this change makes sense, grounded in the data' }
        },
        required: ['company', 'field', 'proposedValue', 'rationale']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mark_queue_item',
      description: 'Mark one of Hollie\'s operator queue items done or dismissed. Item ids look like q:<kind>:<id>.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'Queue item id, e.g. q:stale_deal:12345' },
          action: { type: 'string', enum: ['done', 'dismiss'] }
        },
        required: ['itemId', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_briefing',
      description: 'Read the latest proactive morning brief written for Hollie (what changed, what is new, what to watch).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the workspace UI to a view, account, or meeting.',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['today', 'performance', 'accounts', 'meetings', 'drafts', 'data', 'account', 'meeting'] },
          account: { type: 'string', description: 'Account name (for view=account)' },
          meeting: { type: 'string', description: 'Meeting recording id (for view=meeting)' }
        },
        required: ['view']
      }
    }
  }
];

function runChatCli(args, payload) {
  // NOTE: do not use execFile's `input:` option here — in this environment
  // it reliably hangs the child. Write to stdin explicitly instead.
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [CHAT_CLI, ...args], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    if (payload !== undefined) child.stdin.write(payload);
    child.stdin.end();
  });
}

function callOpenAiDirect(payload) {
  // Direct api.openai.com call used only when the vault CLI is unavailable
  // (production) and OPENAI_API_KEY is set. The key travels solely in the
  // Authorization header.
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        } else {
          const err = new Error('The AI service returned an error.');
          err.status = (res.statusCode === 401 || res.statusCode === 403) ? 503 : 502;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('The AI service timed out.')); });
    req.write(body);
    req.end();
  });
}

async function callChatApi(payload) {
  // Calls OpenAI through the vault-backed skill CLI. The CLI prints the
  // OpenAI response JSON on stdout; errors go to stderr as JSON.
  // Falls back to a direct API call when the CLI is unavailable and
  // OPENAI_API_KEY is set (production on Elastic Beanstalk).
  try {
    const { stdout } = await runChatCli([], JSON.stringify(payload));
    return JSON.parse(stdout);
  } catch (e) {
    if (OPENAI_API_KEY) {
      try { return await callOpenAiDirect(payload); }
      catch (de) { throw de; }
    }
    let detail = '';
    try {
      const errJson = JSON.parse((e.stderr || '').trim().split('\n').pop() || '{}');
      detail = errJson.error || '';
    } catch {}
    const err = new Error(detail ? 'The AI service returned an error.' : 'The AI assistant is not configured on this server.');
    err.status = /credential/i.test(detail) ? 503 : 502;
    throw err;
  }
}

async function vaultHasKey() {
  if (OPENAI_API_KEY) return true;
  try {
    await runChatCli(['--check']);
    return true;
  } catch { return false; }
}

function appendJsonArray(file, entry, cap) {
  let arr = [];
  try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(cur)) arr = cur; } catch {}
  arr.push(entry);
  try { fs.writeFileSync(file, JSON.stringify(arr.slice(-(cap || 500)))); return true; }
  catch { return false; }
}

function readAgentBrief() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-brief.json'), 'utf8')); }
  catch { return null; }
}

function describeActions(actions) {
  const describe = a => a.type === 'create_draft'
    ? 'created the draft <strong>' + escapeHtml(a.title || (a.company || '') + ' follow-up') + '</strong>'
    : a.type === 'propose_crm_update'
      ? (a.ok ? 'queued a CRM proposal for <strong>' + escapeHtml(a.company || '') + '</strong> (' + escapeHtml(a.field || '') + ' → ' + escapeHtml(a.proposedValue || '') + ') — nothing was written to HubSpot' : 'could not save the CRM proposal')
      : a.type === 'mark_queue_item'
        ? (a.ok ? 'marked queue item <strong>' + escapeHtml(a.itemId || '') + '</strong> as ' + escapeHtml(a.action || '') : 'could not update that queue item')
        : 'opened <strong>' + escapeHtml(a.view) + '</strong>';
  return '<p>Done — ' + actions.map(describe).join(', ') + '.</p>';
}

function briefingToolContent() {
  const brief = readAgentBrief();
  if (!brief) return { content: 'No morning brief has been generated yet.', missing: true };
  const parts = [];
  if (brief.greeting) parts.push(brief.greeting);
  for (const p of brief.paragraphs || []) parts.push(p);
  return {
    missing: false,
    content: 'MORNING BRIEF (written ' + (brief.generatedAt || 'unknown') + '):\n' + parts.join('\n') + '\nNEW: ' + (brief.whatsNew || []).join(' | ') + '\nWATCH: ' + (brief.watchOuts || []).join(' | '),
  };
}

async function askOpenAI(message, history) {
  ensureContext();
  const messages = [
    { role: 'system', content: SYSTEM + '\n\n' + CTX },
    ...history.filter(m => m && m.role && m.content).slice(-8),
    { role: 'user', content: message }
  ];
  const data = await callChatApi({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', reasoning_effort: 'none', max_completion_tokens: 1200 });
  const choice = data.choices?.[0]?.message;
  const actions = [];
  const notes = [];
  const toolCalls = choice?.tool_calls || [];
  const toolMessages = [];
  let needsFollowUp = false;
  for (const tc of toolCalls) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
    const name = tc.function.name;
    if (name === 'get_pipeline_metrics' || name === 'lookup_deals') {
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: runAssistantTool(name, args, FACTS) });
      needsFollowUp = true;
    } else if (name === 'read_briefing') {
      const brief = briefingToolContent();
      if (brief.missing) notes.push('No morning brief has been generated yet.');
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: brief.content });
      needsFollowUp = true;
    } else if (name === 'create_draft') {
      actions.push({ type: 'create_draft', ...args });
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Draft queued in the workspace. It was not sent.' });
    } else if (name === 'navigate') {
      actions.push({ type: 'navigate', ...args });
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Navigation queued in the workspace.' });
    } else if (name === 'propose_crm_update') {
      const ok = appendJsonArray(path.join(dataDir, 'crm-proposals.json'), {
        company: String(args.company || ''), deal: String(args.deal || ''),
        field: String(args.field || ''), currentValue: String(args.currentValue || 'unknown'),
        proposedValue: String(args.proposedValue || ''), rationale: String(args.rationale || ''),
        status: 'proposed', at: new Date().toISOString(), by: 'assistant'
      }, 500);
      actions.push({ type: 'propose_crm_update', ok, ...args });
      if (!ok) notes.push('Could not save the CRM proposal.');
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: ok ? 'Proposal stored in the workspace. Nothing was written to HubSpot.' : 'Could not save the CRM proposal.' });
    } else if (name === 'mark_queue_item') {
      const itemId = String(args.itemId || '');
      const action = String(args.action || '');
      const valid = /^q:[a-z_]+:[A-Za-z0-9_-]+$/.test(itemId) && (action === 'done' || action === 'dismiss');
      const ok = valid && appendJsonArray(path.join(dataDir, 'hollie-feedback.json'), { itemId, action, at: new Date().toISOString(), by: 'assistant' }, 500);
      actions.push({ type: 'mark_queue_item', itemId, action, ok });
      if (!ok) notes.push('Could not update that queue item — check the item id.');
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: ok ? 'Queue item updated in the workspace.' : 'Could not update that queue item.' });
    } else {
      toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: runAssistantTool(name, args, FACTS) });
      needsFollowUp = true;
    }
  }
  if (needsFollowUp && toolCalls.length) {
    messages.push({ role: 'assistant', content: choice?.content || null, tool_calls: toolCalls });
    messages.push(...toolMessages);
    const follow = await callChatApi({ model: MODEL, messages, max_completion_tokens: 800 });
    let answer = htmlify((follow.choices?.[0]?.message?.content || '').trim());
    if (!answer && FACTS?.metrics?.largest) {
      const g = FACTS.metrics.largest;
      answer = '<p>Largest open deal: <strong>' + escapeHtml(g.company) + '</strong> — ' + escapeHtml(g.dealName || g.company) + ', ' + escapeHtml(g.amountLabel) + '. Open pipeline: ' + FACTS.metrics.openCount + ' deals, ' + escapeHtml(FACTS.metrics.openAmountLabel) + '.</p>';
    }
    if (actions.length) answer += describeActions(actions);
    for (const n of notes) answer += '<p><em>' + escapeHtml(n) + '</em></p>';
    const answerText = answer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { answer: answer || '<p>I could not produce an answer.</p>', answerText, actions };
  }
  let answer = htmlify((choice?.content || '').trim());
  if (!answer && actions.length) answer = describeActions(actions);
  for (const n of notes) answer += '<p><em>' + escapeHtml(n) + '</em></p>';
  const answerText = answer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { answer: answer || '<p>I could not produce an answer.</p>', answerText, actions };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Normalize the model's reply into the compact HTML fragment the client renders.
// The system prompt asks for HTML, but the model sometimes returns markdown
// anyway — without this the chat shows literal asterisks and dashes.
function htmlify(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // Already an HTML fragment? Trust it (the client injects it as HTML).
  if (/<\s*(p|ul|ol|li|strong|em|br|code|table|thead|tbody|tr|td|th|h[1-6])(\s|>|\/)/i.test(s)) return s;
  const esc = c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
  const inline = t => String(t)
    .replace(/[&<>"']/g, esc)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  const lines = s.split('\n');
  const out = [];
  let list = null;
  let para = [];
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const flushPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
  for (const line of lines) {
    const t = line.trim();
    let m;
    if (!t) { closeList(); flushPara(); continue; }
    if ((m = t.match(/^[-*\u2022]\s+(.*)$/))) { flushPara(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = t.match(/^#{1,6}\s+(.*)$/))) { closeList(); flushPara(); out.push('<p><strong>' + inline(m[1]) + '</strong></p>'); continue; }
    para.push(inline(t));
  }
  closeList(); flushPara();
  return out.join('\n') || '<p>I could not produce an answer.</p>';
}

// --- static file serving (same policy as scripts/preview.mjs) ---
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ttf': 'font/ttf' };
const compressible = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);
function serveStatic(req, res) {
  let file;
  try { file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)); }
  catch { res.writeHead(400).end(); return; }
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  const ext = path.extname(file);
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Accept-Encoding');
  if (ext === '.html' || ext === '.json') res.setHeader('Cache-Control', 'no-store');
  if (compressible.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.setHeader('Content-Encoding', 'gzip');
    fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
    return;
  }
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/data-stamp' && req.method === 'GET') {
      // generatedAt from the start of records.json. The page reloads when it changes.
      // Do not parse the whole extract for this poll.
      let generatedAt = null;
      try {
        const file = path.join(dataDir, 'records.json');
        const st = fs.statSync(file);
        const key = st.mtimeMs + ':' + st.size;
        if (!serveStatic.stamp || serveStatic.stamp.key !== key) {
          const fd = fs.openSync(file, 'r');
          try {
            const buf = Buffer.alloc(8192);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            const head = buf.toString('utf8', 0, n);
            const match = head.match(/"generatedAt"\s*:\s*"([^"]*)"/);
            generatedAt = match ? (match[1] || null) : null;
          } finally { fs.closeSync(fd); }
          if (generatedAt == null) {
            try { generatedAt = JSON.parse(fs.readFileSync(file, 'utf8')).generatedAt || null; } catch { generatedAt = null; }
          }
          serveStatic.stamp = { key, generatedAt };
        } else generatedAt = serveStatic.stamp.generatedAt;
      } catch { generatedAt = null; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ generatedAt, label: collectedLabel(generatedAt) }));
      return;
    }
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 200000) break; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON.' })); return; }
      const message = String(body.message || '').trim();
      if (!message) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Empty question.' })); return; }
      try {
        const out = await askOpenAI(message.slice(0, 2000), Array.isArray(body.history) ? body.history : []);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message || 'Assistant failed.' }));
      }
      return;
    }
    if (url.pathname === '/api/agent/brief' && req.method === 'GET') {
      const brief = readAgentBrief();
      if (!brief) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No brief yet.' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(brief));
      return;
    }
    if (url.pathname === '/api/hollie/feedback' && req.method === 'POST') {
      // Hollie operator feedback: Dismiss/Done on queue items. Append-only log
      // the operator reads on its next run (anti-nag). Minimal and safe:
      // itemId must look like q:<kind>:<id>, action is dismiss|done, body capped.
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 8192) break; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON.' })); return; }
      const itemId = String(body.itemId || '');
      const action = String(body.action || '');
      if (!/^q:[a-z_]+:[A-Za-z0-9_-]+$/.test(itemId) || (action !== 'dismiss' && action !== 'done')) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Bad feedback.' })); return;
      }
      const fp = path.join(dataDir, 'hollie-feedback.json');
      let arr = [];
      try { const cur = JSON.parse(fs.readFileSync(fp, 'utf8')); if (Array.isArray(cur)) arr = cur; } catch {}
      arr.push({ itemId, action, at: new Date().toISOString() });
      try { fs.writeFileSync(fp, JSON.stringify(arr.slice(-500))); }
      catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Could not save.' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/gmail/oauth/start' && req.method === 'GET') {
      // Starts per-user Gmail OAuth flow. Returns { authUrl } for the frontend
      // to open. User signs in as themselves (not the server owner).
      if (!GOOGLE_CLIENT_ID) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Gmail OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID.' }));
        return;
      }
      const sid = getSessionId(req, res);
      const state = crypto.randomBytes(16).toString('hex');
      oauthStates.set(state, { sessionId: sid, createdAt: Date.now() });
      // Clean old states
      for (const [k, v] of oauthStates) if (Date.now() - v.createdAt > 600000) oauthStates.delete(k);
      
      const redirectUri = getOAuthRedirectUri(req);
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/gmail.send',
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ authUrl }));
      return;
    }
    if (url.pathname === '/api/gmail/oauth/callback' && req.method === 'GET') {
      // Google redirects here after user signs in. Exchanges code for tokens.
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      
      if (error) {
        res.writeHead(302, { Location: '/?view=drafts&gmail=error' }).end();
        return;
      }
      const stateData = oauthStates.get(state);
      if (!code || !stateData) {
        res.writeHead(302, { Location: '/?view=drafts&gmail=error' }).end();
        return;
      }
      oauthStates.delete(state);
      
      try {
        const redirectUri = getOAuthRedirectUri(req);
        const params = new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        });
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error_description || 'Token exchange failed');
        
        const email = await getGmailProfile(j.access_token);
        gmailSessions.set(stateData.sessionId, {
          accessToken: j.access_token,
          refreshToken: j.refresh_token,
          email,
          expiresAt: Date.now() + (j.expires_in * 1000),
        });
        // Set session cookie and redirect back to drafts
        res.writeHead(302, {
          Location: '/?view=drafts&gmail=connected',
          'Set-Cookie': `gtm_sid=${stateData.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        }).end();
      } catch (e) {
        res.writeHead(302, { Location: '/?view=drafts&gmail=error' }).end();
      }
      return;
    }
    if (url.pathname === '/api/gmail/oauth/disconnect' && req.method === 'POST') {
      const sid = getSessionId(req, res);
      gmailSessions.delete(sid);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/gmail/status' && req.method === 'GET') {
      // Returns { connected, email } — the USER's own Gmail via OAuth.
      // No fallback: if the user hasn't connected, sending is unavailable.
      const sid = getSessionId(req, res);
      const userSession = gmailSessions.get(sid);
      if (userSession) {
        try {
          const token = await refreshGmailToken(userSession);
          const email = userSession.email || await getGmailProfile(token);
          userSession.email = email;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            connected: true, email,
            oauthConfigured: !!GOOGLE_CLIENT_ID,
          }));
          return;
        } catch (e) {
          gmailSessions.delete(sid); // Token invalid, clear it
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        connected: false, email: null,
        oauthConfigured: !!GOOGLE_CLIENT_ID,
      }));
      return;
    }
    if (url.pathname === '/api/gmail/send' && req.method === 'POST') {
      // Sends an email via the USER's own Gmail (OAuth). No fallback —
      // if the user hasn't connected, sending is unavailable.
      // The frontend MUST show the exact to/subject/body and get explicit
      // user confirmation before calling this. Body capped at 20k chars.
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 65536) break; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON.' })); return; }
      const to = String(body.to || '').trim();
      const subject = String(body.subject || '').trim();
      const text = String(body.body || '').trim();
      const confirmed = body.confirmed === true;
      if (!to || !subject || !text) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'To, subject, and body are required.' })); return; }
      if (!confirmed) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Confirmation required.' })); return; }
      if (text.length > 20000) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Body too long.' })); return; }
      
      const sid = getSessionId(req, res);
      const userSession = gmailSessions.get(sid);
      if (!userSession) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Gmail not connected. Connect your Gmail to send.' }));
        return;
      }
      try {
        const token = await refreshGmailToken(userSession);
        await sendGmailApi(token, to, subject, text);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, from: userSession.email }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === '/api/proposals/decide' && req.method === 'POST') {
      // Hollie approves/declines an assistant-proposed CRM change. Workspace-local
      // only: records the decision on the proposal, never writes to HubSpot.
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 8192) break; }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON.' })); return; }
      const idx = Number(body.idx);
      const decision = String(body.decision || '');
      if (!Number.isInteger(idx) || idx < 0 || (decision !== 'approved' && decision !== 'declined')) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Bad decision.' })); return;
      }
      const fp = path.join(dataDir, 'crm-proposals.json');
      let arr = [];
      try { const cur = JSON.parse(fs.readFileSync(fp, 'utf8')); if (Array.isArray(cur)) arr = cur; } catch {}
      if (idx >= arr.length || !arr[idx] || arr[idx].status !== 'proposed') {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Proposal not found or already decided.' })); return;
      }
      arr[idx] = { ...arr[idx], status: decision, decidedAt: new Date().toISOString() };
      try { fs.writeFileSync(fp, JSON.stringify(arr.slice(-500))); }
      catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Could not save.' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/health' && req.method === 'GET') {
      const key = await vaultHasKey();
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, key, model: MODEL }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    serveStatic(req, res);
  })().catch(() => { try { res.writeHead(500).end(); } catch {} });
});

server.listen(PORT, '127.0.0.1', () => console.log('GTM workspace + agent: http://127.0.0.1:' + server.address().port));
