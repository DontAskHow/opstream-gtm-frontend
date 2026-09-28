// Terms that must never reach the page. Same rules as scripts/term_scrub.py.
const RULES = [
  [/grok[\s\-_]*bot/gi, 'the assistant'],
  [/grok\w*/gi, 'the AI model'],
];

export function scrubText(text) {
  let out = String(text);
  for (const [pattern, word] of RULES) out = out.replace(pattern, word);
  return out;
}

export function scrubBuffer(buf) {
  const text = buf.toString('utf8');
  const next = scrubText(text);
  return next === text ? buf : Buffer.from(next, 'utf8');
}
