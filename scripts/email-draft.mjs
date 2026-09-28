// Generate with AI for the Drafts editor: one completion, no tools, that must
// come back as {subject, body}. The reply never replaces a draft with nothing.

const COMMENTARY = /^(i can(?:'|’)?t|i cannot|i'm unable|i am unable|here(?:'|’)?s|here is|sure[,!.]|certainly[,!.]|of course[,!.]|note:|let me know|i've |i have (?:written|drafted|kept)|this (?:draft|email|version) )/i;
const GREETING = /\b(Hi|Hello|Dear|Hey|Good (?:morning|afternoon))\b[^,\n]{0,40},/;

function stripCommentary(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  while (lines.length && (!lines[0].trim() || COMMENTARY.test(lines[0].trim()))) lines.shift();
  while (lines.length && (!lines[lines.length - 1].trim() || COMMENTARY.test(lines[lines.length - 1].trim()) || /^-{3,}$/.test(lines[lines.length - 1].trim()))) lines.pop();
  return lines.join('\n').trim();
}

function fromJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1));
    if (j && typeof j === 'object' && (typeof j.body === 'string' || typeof j.subject === 'string')) {
      return { subject: String(j.subject || '').trim(), body: String(j.body || '').replace(/\\n/g, '\n').trim() };
    }
  } catch {}
  return null;
}

// Plain-text replies: "Subject: …" then the body. When the model puts it all on
// one line, the subject ends where the greeting starts.
function fromText(text) {
  const raw = stripCommentary(text);
  const m = raw.match(/^\s*(?:\*\*)?Subject(?:\*\*)?:\s*/i);
  if (!m) return { subject: '', body: raw };
  const rest = raw.slice(m[0].length);
  const nl = rest.indexOf('\n');
  if (nl >= 0) return { subject: rest.slice(0, nl).trim(), body: rest.slice(nl + 1).trim() };
  const g = rest.match(GREETING);
  if (g && g.index > 0) return { subject: rest.slice(0, g.index).trim(), body: rest.slice(g.index).trim() };
  return { subject: rest.trim(), body: '' };
}

export function parseEmailReply(text) {
  const parsed = fromJson(text) || fromText(text);
  const subject = parsed.subject.replace(/^(?:\*\*)?Subject(?:\*\*)?:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const body = stripCommentary(parsed.body.replace(/^(?:\*\*)?Subject(?:\*\*)?:.*\n/i, ''));
  return { subject, body };
}

const PURPOSE = {
  email: 'a follow-up email',
  event: 'an email to a prospect about an event or trade show',
  campaign: 'a LemList campaign email; keep merge tags such as {{firstName}} and {{companyName}} exactly as written',
  linkedin: 'a LinkedIn post (the subject is the post title)',
  'internal-note': 'an internal note to colleagues',
};

export function emailPrompt(draft, userName) {
  const d = draft || {};
  const signer = String(userName || '').trim() || 'Hollie';
  return [
    'Write ' + (PURPOSE[d.purpose] || PURPOSE.email) + ' for Opstream.',
    'Company: ' + (d.company && d.company !== 'No company linked' ? d.company : 'not linked to one company'),
    'To: ' + (d.recipients || 'not filled in yet'),
    d.subject ? 'Current subject: ' + String(d.subject).slice(0, 200) : '',
    d.rationale ? 'Context from the workspace: ' + String(d.rationale).slice(0, 1500) : '',
    d.text ? 'Current draft (improve it; keep facts, names, dates, links and placeholders in [brackets]):\n' + String(d.text).slice(0, 3000) : 'There is no draft text yet; write it from the context.',
    'Keep any signature already in the draft. If there is none, sign as ' + signer + '.',
    'Do not invent meeting times, prices, booth numbers or links; leave a [placeholder] instead.',
  ].filter(Boolean).join('\n');
}

export async function generateEmail({ draft, userName, chat, model }) {
  const data = await chat({
    model,
    messages: [
      { role: 'system', content: 'You write short, specific business emails. Reply with only a JSON object {"subject": string, "body": string}. The body uses \\n line breaks. No commentary, no markdown.' },
      { role: 'user', content: emailPrompt(draft, userName) },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: 4000,
  });
  const content = String(data?.choices?.[0]?.message?.content || '');
  const out = parseEmailReply(content);
  if (!out.body) {
    const err = new Error('The AI reply had no message text. Your draft is unchanged.');
    err.status = 502;
    throw err;
  }
  return out;
}
