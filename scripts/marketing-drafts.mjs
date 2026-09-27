// LinkedIn post drafts for a show. Reads the show calendar row and, when the
// person is signed in, their own Gmail, Calendar and Drive. Returns text only;
// nothing is posted or sent.
import { searchEmail, listCalendar, searchDrive } from './google-workspace.mjs';

function addDays(day, n) {
  const t = new Date(day + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function number(n) {
  return n == null ? null : Math.round(Number(n)).toLocaleString('en-US');
}

export function showFacts(show) {
  const lines = ['Show: ' + show.name];
  if (show.dateLabel) lines.push('Dates: ' + show.dateLabel + (show.start ? ' (' + show.start + ' to ' + (show.end || show.start) + ')' : ''));
  if (show.location) lines.push('Location: ' + show.location);
  if (show.package) lines.push('Opstream package: ' + show.package);
  if (show.organizer) lines.push('Organizer: ' + show.organizer);
  lines.push('Opstream attendees on the show calendar: ' + ((show.attendees || []).join(', ') || 'none listed'));
  const leads = show.leads || {};
  if (leads.count) lines.push('Lead Tracker rows from the show (contact details given or badge scanned): ' + leads.count);
  const phase = show.phase === 'past' ? 'past' : 'upcoming';
  lines.push('Timing: ' + (phase === 'past' ? 'the show is over' : 'the show has not ended yet'));
  return { lines, phase };
}

const cut = (text, n) => String(text || '').slice(0, n);

export async function googleSources(fetchImpl, token, show) {
  const lines = [];
  const citations = [];
  let expired = false;
  const safe = async (fn) => {
    try { return await fn(); }
    catch (err) { if (err && err.code === 'invalid_grant') expired = true; return ''; }
  };
  const mail = await safe(() => searchEmail(fetchImpl, token, '"' + show.name.replace(/"/g, '') + '" newer_than:120d'));
  for (const row of String(mail || '').split('\n')) {
    const subject = (row.match(/Subject: (.*?) \|/) || [])[1];
    if (!subject) continue;
    lines.push('Email: ' + cut(row.replace(/^id=\S+ \| /, ''), 400));
    citations.push('Gmail: “' + cut(subject, 120) + '”');
    if (citations.length >= 3) break;
  }
  if (show.start) {
    const events = await safe(() => listCalendar(fetchImpl, token, addDays(show.start, -1), addDays(show.end || show.start, 2)));
    let n = 0;
    for (const row of String(events || '').split('\n')) {
      const parts = row.split(' | ');
      if (parts.length < 2) continue;
      lines.push('Calendar: ' + cut(row, 300));
      citations.push('Calendar: “' + cut(parts[1], 120) + '” (' + cut(parts[0], 10) + ')');
      if (++n >= 3) break;
    }
  }
  const files = await safe(() => searchDrive(fetchImpl, token, show.name));
  let f = 0;
  for (const row of String(files || '').split('\n')) {
    const parts = row.split(' | ');
    if (parts.length < 2) continue;
    lines.push('Drive file: ' + cut(parts[1], 160));
    citations.push('Drive: “' + cut(parts[1], 120) + '”');
    if (++f >= 3) break;
  }
  return { lines, citations, expired };
}

export function templatePost(show, phase) {
  const where = show.location ? ' in ' + show.location : '';
  const booth = /booth/i.test(show.package || '');
  const tag = '#' + show.name.replace(/[^A-Za-z0-9]/g, '');
  if (phase === 'past') {
    const leads = (show.leads || {}).count;
    return [
      'Thank you to everyone we met at ' + show.name + where + '.',
      leads ? number(leads) + ' people shared their details with the Opstream team, and we are following up with each of them this week.' : 'We are following up with the people we met this week.',
      'If we did not get to talk and you want to compare notes on how procurement teams are using AI, send me a message.',
      '',
      tag + ' #procurement',
    ].join('\n');
  }
  return [
    'Opstream will be at ' + show.name + where + (show.dateLabel ? ', ' + show.dateLabel : '') + '.',
    booth ? 'Come and find us at our booth.' : 'Let us know if you will be there too.',
    'If you are thinking about how procurement teams work with AI, we would like to hear what you are working on. Send me a message to set up a time.',
    '',
    tag + ' #procurement',
  ].join('\n');
}

export async function linkedInDraft({ show, user, token, fetchImpl, chat, model }) {
  const { lines, phase } = showFacts(show);
  const citations = ['Dashboard: ' + show.name + ' on the show calendar (budget workbook)'];
  let sourceLines = [];
  let usedGoogle = false;
  let expired = false;
  if (user && token) {
    const found = await googleSources(fetchImpl, token, show);
    expired = found.expired;
    sourceLines = found.lines;
    citations.push(...found.citations);
    usedGoogle = true;
  }
  let text = '';
  if (chat) {
    try {
      const data = await chat({
        model,
        messages: [
          { role: 'system', content: 'You write LinkedIn posts for Opstream\'s marketing lead. Use only the facts and sources given. Do not invent people, numbers, sessions, quotes, or meetings. Plain text, under 120 words, at most three hashtags. Write in first person plural for Opstream. Return only the post.' },
          { role: 'user', content: 'Write one LinkedIn post about this show.\n\nFACTS\n' + lines.join('\n') + (sourceLines.length ? '\n\nFROM THE MARKETING LEAD\'S OWN GOOGLE WORKSPACE\n' + sourceLines.join('\n') : '') },
        ],
        max_completion_tokens: 400,
      });
      text = String(data?.choices?.[0]?.message?.content || '').trim();
    } catch { text = ''; }
  }
  if (!text) text = templatePost(show, phase);
  return {
    title: 'LinkedIn post · ' + show.name,
    text,
    citations,
    usedGoogle,
    expired,
  };
}
