// Post-processes the self-contained review HTML so it passes the artifact
// host's static scan, which rejects dynamic function construction
// (`new Function` / `eval`). Both occurrences live in the inlined support.js
// (the DC runtime) and are handled without changing runtime behavior:
//
// 1. evalDcLogic(src): the src is STATIC (the single text/x-dc block). We
//    pre-compile it into a top-level classic-script function whose scope
//    chain is exactly the global scope -- semantically identical to what
//    `new Function` produced. support.js then delegates to it.
// 2. The x-import dynamic module loader: dead in this snapshot (no x-import
//    URLs anywhere in the markup), so its `new Function` becomes a throw
//    on the unreachable path.
const fs = require('fs');
const path = require('path');

const REVIEW_DIR = __dirname;
const OUT_DIR = path.join(__dirname, '..', 'out');
const SRC_FILE = path.join(REVIEW_DIR, 'opstream-dashboard-review-2026-09-25.html');
const DST_FILE = path.join(REVIEW_DIR, 'opstream-dashboard-review-hosted.html');

let html = fs.readFileSync(SRC_FILE, 'utf8');
const origHtml = fs.readFileSync(path.join(OUT_DIR, 'index.html'), 'utf8');

// --- 1. Extract the exact dc block source (script content is raw text; no entity decoding).
const dcTagStart = origHtml.indexOf('<script type="text/x-dc"');
if (dcTagStart < 0) throw new Error('dc block not found');
const dcTagEnd = origHtml.indexOf('>', dcTagStart);
const dcClose = origHtml.indexOf('</script>', dcTagEnd);
const dcSrc = origHtml.slice(dcTagEnd + 1, dcClose);
if (dcSrc.includes('</script')) throw new Error('dc src contains closing tag?!');

// --- 2. Build the precompiled top-level script. Classic script, top-level
// function declaration => [[Scope]] is the global scope, exactly like new Function.
const precompiled =
  '<script>\n' +
  '// Precompiled replacement for evalDcLogic dynamic code construction.\n' +
  '// The dc source below is static (single text/x-dc block); this function is\n' +
  '// declared at top level of a classic script so its scope chain is the\n' +
  '// global scope -- identical semantics to constructing it from source at runtime.\n' +
  'window.__dcEvalPrecompiled = function(DCLogic, StreamableLogic, React) {\n' +
  dcSrc.replace(/<\/(script)/gi, '<\\/$1') +
  '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n' +
  '};\n' +
  '</script>\n';

// --- 3. Patch support.js site 1: delegate to the precompiled function.
const site1 =
  'function evalDcLogic(src) {\n' +
  '    //! nosemgrep: eval-and-function-constructor\n' +
  '    const fn = new Function(\n' +
  '      "DCLogic",\n' +
  '      "StreamableLogic",\n' +
  '      "React",\n' +
  '      src + \'\\n;return (typeof Component!=="undefined"&&Component)||undefined;\'\n' +
  '    );\n' +
  '    return fn(StreamableLogic, StreamableLogic, getReact());\n' +
  '  }';
const site1Replacement =
  'function evalDcLogic(src) {\n' +
  '    // Hosted-snapshot build: precompiled at build time (see window.__dcEvalPrecompiled).\n' +
  '    // The dc source is static, so this delegation is behavior-identical.\n' +
  '    return window.__dcEvalPrecompiled(StreamableLogic, StreamableLogic, getReact());\n' +
  '  }';
if (!html.includes(site1)) throw new Error('site1 not found');
html = html.replace(site1, () => site1Replacement);

// --- 4. Patch support.js site 2: dead x-import loader path -> explicit throw.
const site2 =
  '        //! nosemgrep: eval-and-function-constructor\n' +
  '        new Function("React", "module", "exports", "require", code)(\n' +
  '          getReact(),\n' +
  '          module,\n' +
  '          module.exports,\n' +
  '          () => ({})\n' +
  '        );';
const site2Replacement =
  '        throw new Error("[hosted snapshot] dynamic x-import module loading is disabled");';
if (!html.includes(site2)) throw new Error('site2 not found');
html = html.replace(site2, () => site2Replacement);

// --- 5. Insert the precompiled script immediately before the inlined support.js.
// support.js starts with its GENERATED marker; find the <script> tag before it.
const genMarker = '// GENERATED from dc-runtime/src/*.ts';
const genIdx = html.indexOf(genMarker);
if (genIdx < 0) throw new Error('support.js marker not found');
const scriptOpen = html.lastIndexOf('<script', genIdx);
if (scriptOpen < 0) throw new Error('script open not found');
html = html.slice(0, scriptOpen) + precompiled + html.slice(scriptOpen);

// --- 6. Verify no dynamic code construction remains.
for (const pat of ['new Function', 'eval(', 'Function(']) {
  const n = html.split(pat).length - 1;
  console.log(pat, '->', n);
  if (n > 0 && pat !== 'Function(') throw new Error('remaining dynamic construct: ' + pat);
}
// 'Function(' check is informational; the two real ones are gone.

fs.writeFileSync(DST_FILE, html);
console.log('wrote', DST_FILE, (fs.statSync(DST_FILE).size / 1048576).toFixed(1) + 'MB');
