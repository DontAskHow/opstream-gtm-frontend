// Google Workspace reads, personal briefs, and one confirmed Gmail send.
// sendGmailMessage is not an assistant tool. Nothing here writes HubSpot or Sheets.
const PHOENIX = 'America/Phoenix';
const TEXT_CAP = 4000;
const DOC_CAP = 8000;

function clip(value, n) {
  const raw = String(value ?? '');
  return raw.length > n ? raw.slice(0, n) : raw;
}

async function readJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

async function googleGet(fetchImpl, token, url) {
  const response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token } });
  const body = await readJson(response);
  if (response.status === 401) {
    const err = new Error('invalid_grant');
    err.code = 'invalid_grant';
    throw err;
  }
  if (!response.ok) {
    const err = new Error('GoogleApi');
    err.code = 'GoogleApi';
    throw err;
  }
  return body;
}

function header(message, name) {
  const headers = message && message.payload && message.payload.headers || [];
  const found = headers.find(item => String(item.name || '').toLowerCase() === name.toLowerCase());
  return found ? String(found.value || '') : '';
}

export async function searchEmail(fetchImpl, token, query) {
  const q = clip(query || 'newer_than:14d', 200);
  const listed = await googleGet(
    fetchImpl,
    token,
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=6&q=' + encodeURIComponent(q),
  );
  const lines = [];
  for (const item of (listed.messages || []).slice(0, 6)) {
    const message = await googleGet(
      fetchImpl,
      token,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(item.id)
        + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date',
    );
    lines.push(
      'id=' + clip(message.id, 64)
      + ' | ' + clip(header(message, 'Date'), 40)
      + ' | From: ' + clip(header(message, 'From'), 120)
      + ' | Subject: ' + clip(header(message, 'Subject'), 180)
      + ' | ' + clip(message.snippet, 240),
    );
    if (lines.join('\n').length > TEXT_CAP) break;
  }
  return lines.length ? lines.join('\n').slice(0, TEXT_CAP) : 'No matching email.';
}

export async function readThread(fetchImpl, token, threadId) {
  const id = clip(threadId, 128);
  if (!id) return 'Missing thread id.';
  const thread = await googleGet(
    fetchImpl,
    token,
    'https://gmail.googleapis.com/gmail/v1/users/me/threads/' + encodeURIComponent(id)
      + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-Id&metadataHeaders=References',
  );
  const lines = ['threadId=' + clip(thread.id || id, 128)];
  for (const message of (thread.messages || []).slice(0, 8)) {
    lines.push(
      'messageId=' + clip(header(message, 'Message-Id'), 180)
      + ' | references=' + clip(header(message, 'References'), 300)
      + ' | From: ' + clip(header(message, 'From'), 120)
      + ' | Subject: ' + clip(header(message, 'Subject'), 180)
      + ' | ' + clip(message.snippet, 300),
    );
  }
  return (lines.join('\n') || 'Empty thread.').slice(0, TEXT_CAP);
}

function phoenixDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PHOENIX, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(day, n) {
  const t = new Date(day + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export async function calendarEvents(fetchImpl, token, start, end) {
  const today = phoenixDay(new Date());
  const timeMin = (start || today) + 'T00:00:00-07:00';
  const timeMax = (end || addDays(today, 2)) + 'T00:00:00-07:00';
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=20'
    + '&timeMin=' + encodeURIComponent(timeMin) + '&timeMax=' + encodeURIComponent(timeMax);
  const body = await googleGet(fetchImpl, token, url);
  return (body.items || []).slice(0, 20);
}

export async function listCalendar(fetchImpl, token, start, end) {
  const items = await calendarEvents(fetchImpl, token, start, end);
  const lines = [];
  for (const event of items) {
    const when = event.start && (event.start.dateTime || event.start.date) || '';
    const who = (event.attendees || []).slice(0, 6).map(a => a.email || a.displayName || '').filter(Boolean).join(', ');
    lines.push(clip(when, 32) + ' | ' + clip(event.summary, 140) + (who ? ' | ' + clip(who, 180) : ''));
  }
  return lines.length ? lines.join('\n').slice(0, TEXT_CAP) : 'No events in that range.';
}

export async function searchDrive(fetchImpl, token, query) {
  const q = clip(query || '', 180);
  const driveQ = q ? "name contains '" + q.replace(/'/g, '') + "' and trashed = false" : 'trashed = false';
  const url = 'https://www.googleapis.com/drive/v3/files?pageSize=8&fields=files(id,name,mimeType)&q=' + encodeURIComponent(driveQ);
  const body = await googleGet(fetchImpl, token, url);
  const lines = (body.files || []).slice(0, 8).map(file => file.id + ' | ' + clip(file.name, 140) + ' | ' + clip(file.mimeType, 80));
  return lines.length ? lines.join('\n') : 'No matching files.';
}

export async function readDoc(fetchImpl, token, fileId, mimeType) {
  const id = clip(fileId, 128);
  if (!id) return 'Missing file id.';
  const mime = String(mimeType || '');
  const exportMime = mime.includes('spreadsheet') ? 'text/csv' : 'text/plain';
  const response = await fetchImpl(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent(exportMime),
    { headers: { Authorization: 'Bearer ' + token } },
  );
  if (!response.ok) {
    const err = new Error('GoogleApi');
    err.code = 'GoogleApi';
    throw err;
  }
  const text = typeof response.text === 'function' ? await response.text() : '';
  return clip(text, DOC_CAP) || 'Empty document.';
}

export async function createGmailDraft(fetchImpl, token, { to, subject, body }) {
  const msg = [
    'To: ' + String(to || '').replace(/[\r\n]/g, ''),
    'Subject: ' + String(subject || '').replace(/[\r\n]/g, ''),
    'Content-Type: text/plain; charset=utf-8',
    '',
    String(body || ''),
  ].join('\r\n');
  const raw = Buffer.from(msg).toString('base64url');
  const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  });
  const parsed = await readJson(response);
  if (!response.ok) {
    const err = new Error('GoogleApi');
    err.code = 'GoogleApi';
    throw err;
  }
  return { id: String(parsed.id || '') };
}

function mailHeader(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim();
}

// Called only after the signed-in user confirms one draft. Not registered as a tool.
export async function sendGmailMessage(fetchImpl, token, { to, cc, subject, body, threadId, inReplyTo, references }) {
  const headers = ['To: ' + mailHeader(to)];
  const ccValue = mailHeader(cc);
  if (ccValue) headers.push('Cc: ' + ccValue);
  headers.push('Subject: ' + mailHeader(subject));
  const replyTo = mailHeader(inReplyTo);
  const refs = mailHeader(references);
  if (replyTo) headers.push('In-Reply-To: ' + replyTo);
  if (refs) headers.push('References: ' + refs);
  headers.push('Content-Type: text/plain; charset=utf-8');
  const msg = headers.join('\r\n') + '\r\n\r\n' + String(body || '');
  const payload = { raw: Buffer.from(msg).toString('base64url') };
  const tid = mailHeader(threadId);
  if (tid) payload.threadId = tid;
  const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await readJson(response);
  if (!response.ok || !parsed.id) {
    const err = new Error('GoogleApi');
    err.code = 'GoogleApi';
    throw err;
  }
  return { id: String(parsed.id) };
}

export const GOOGLE_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_email',
      description: 'Search the signed-in user\'s Gmail. Read-only. Cite the subject you used.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Gmail search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_thread',
      description: 'Read one Gmail thread by id. Read-only.',
      parameters: {
        type: 'object',
        properties: { threadId: { type: 'string' } },
        required: ['threadId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_calendar',
      description: 'List the signed-in user\'s calendar events. Dates are America/Phoenix YYYY-MM-DD.',
      parameters: {
        type: 'object',
        properties: { start: { type: 'string' }, end: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_drive',
      description: 'Search the signed-in user\'s Drive by file name. Read-only.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description: 'Export a Google Doc or Sheet as text. Size-capped. Read-only.',
      parameters: {
        type: 'object',
        properties: { fileId: { type: 'string' }, mimeType: { type: 'string' } },
        required: ['fileId'],
      },
    },
  },
];

const GOOGLE_TOOLS = {
  search_email: (fetchImpl, token, args) => searchEmail(fetchImpl, token, args.query),
  read_thread: (fetchImpl, token, args) => readThread(fetchImpl, token, args.threadId || args.id),
  list_calendar: (fetchImpl, token, args) => listCalendar(fetchImpl, token, args.start, args.end),
  search_drive: (fetchImpl, token, args) => searchDrive(fetchImpl, token, args.query),
  read_doc: (fetchImpl, token, args) => readDoc(fetchImpl, token, args.fileId, args.mimeType),
};

export function isGoogleTool(name) {
  return Object.prototype.hasOwnProperty.call(GOOGLE_TOOLS, name);
}

export async function runGoogleTool(name, args, { fetchImpl, token }) {
  const fn = GOOGLE_TOOLS[name];
  if (!fn) return 'Unknown tool.';
  try {
    return await fn(fetchImpl, token, args || {});
  } catch (err) {
    if (err && err.code === 'invalid_grant') return 'Google access expired, reconnect';
    return 'Google could not be read (' + (err && err.code ? err.code : 'Error') + ').';
  }
}

function domainOf(value) {
  const text = String(value || '').toLowerCase();
  const match = text.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
  return match ? match[1] : '';
}

// A HubSpot owner id is not a name: use the owners list, or Unassigned.
function ownerName(value, catalog) {
  const raw = String(value || '').replace(/^(owner\s+)+/i, '').trim();
  if (!raw) return 'Unassigned';
  if (/^\d+$/.test(raw)) return (catalog && catalog[raw]) || 'Unassigned';
  return raw;
}

export function gtmIndex(records, sheetReview) {
  const companies = [];
  const byDomain = new Map();
  for (const company of (records && records.companies) || []) {
    if (companies.length >= 500) break;
    const deal = (company.deals || []).find(item => item && (item.isOpen || item.stage));
    const row = {
      name: String(company.name || ''),
      domain: String(company.domain || '').toLowerCase(),
      owner: ownerName(company.owner, records && records.owners),
      deal: deal ? String(deal.name || deal.stage || '') : '',
      stage: deal ? String(deal.stageLabel || deal.stage || '') : '',
    };
    companies.push(row);
    if (row.domain) byDomain.set(row.domain, row);
  }
  const onSheet = new Set();
  for (const deal of (sheetReview && sheetReview.deals) || []) {
    if (deal.company) onSheet.add(String(deal.company).trim().toLowerCase());
    if (deal.name) onSheet.add(String(deal.name).trim().toLowerCase());
  }
  return { companies, byDomain, onSheet };
}

export async function buildPersonalBrief({ fetchImpl, token, email, index, now }) {
  const today = phoenixDay(now || new Date());
  const tomorrow = addDays(today, 2);
  let calendar = '';
  let mail = '';
  let expired = false;
  try {
    calendar = await listCalendar(fetchImpl, token, today, tomorrow);
    mail = await searchEmail(fetchImpl, token, 'in:inbox newer_than:21d');
  } catch (err) {
    if (err && err.code === 'invalid_grant') expired = true;
  }
  if (calendar === 'Google access expired, reconnect' || mail === 'Google access expired, reconnect') expired = true;
  const meetings = [];
  if (!expired) {
    for (const line of calendar.split('\n').filter(Boolean).slice(0, 8)) {
      const bits = line.split(' | ');
      const who = bits[2] || '';
      const dom = domainOf(who);
      const company = dom && index && index.byDomain ? index.byDomain.get(dom) : null;
      const prep = company
        ? 'HubSpot: ' + company.name + (company.stage ? ', ' + company.stage : '') + (company.owner ? ', owner ' + company.owner : '')
        : 'No HubSpot company matched this guest domain.';
      meetings.push({ title: bits[1] || line, when: bits[0] || '', detail: prep });
    }
  }
  const followUps = [];
  const notOnSheet = [];
  const seenOff = new Set();
  if (!expired) {
    for (const line of mail.split('\n').filter(Boolean).slice(0, 8)) {
      const subject = (line.split('Subject: ')[1] || '').split(' | ')[0] || 'Email';
      const from = (line.split('From: ')[1] || '').split(' | ')[0] || '';
      if (email && from.toLowerCase().includes(String(email).toLowerCase())) continue;
      followUps.push({ title: subject, detail: 'Awaiting your reply. From ' + from });
      const dom = domainOf(from);
      const company = dom && index && index.byDomain ? index.byDomain.get(dom) : null;
      const label = company ? company.name : dom;
      if (!label || seenOff.has(label.toLowerCase())) continue;
      const onSheet = index && index.onSheet && (index.onSheet.has(label.toLowerCase()) || (company && index.onSheet.has(company.name.toLowerCase())));
      if (!onSheet && label.includes('.')) {
        seenOff.add(label.toLowerCase());
        notOnSheet.push({ title: label, detail: 'Mentioned in mail, not on the master Sheet.' });
      }
    }
  }
  const drafts = followUps.slice(0, 3).map(item => ({
    title: 'Re: ' + item.title,
    detail: 'Draft only. Following up on ' + item.title + '. Nothing is sent until you send it yourself.',
  }));
  return {
    email: email || '',
    generatedAt: (now || new Date()).toISOString(),
    expired,
    meetings,
    followUps,
    notOnSheet,
    drafts,
  };
}
