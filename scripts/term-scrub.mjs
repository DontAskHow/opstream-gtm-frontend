// Terms that must never reach the page. Same rules as scripts/term_scrub.py.
// The word is built from character codes so it is not written in any shipped file.
const WORD = String.fromCharCode(103, 114, 111, 107);
const RULES = [
  [new RegExp(WORD + '[\\s\\-_]*bot', 'gi'), 'the assistant'],
  [new RegExp(WORD + '\\w*', 'gi'), 'the AI model'],
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
