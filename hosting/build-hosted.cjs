// Build a self-contained hosted HTML from the built dashboard (out/).
// Correct approach: precompile ONLY the DC logic (evalDcLogic's `new Function`)
// into window.__dcPrecompiled, and keep the runtime's real boot path intact.
// Also: vendor React/ReactDOM (CDN unreachable from the hosted browser),
// inline the design-system CSS+JS bundle, inline data/*.json behind a fetch shim,
// inline the evidence renderer, and disable the unused x-import dynamic loader.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function fail(m) { console.error('FATAL: ' + m); process.exit(1); }

function checkJs(src, label) {
  const f = '/tmp/hostchk-' + String(label).replace(/[^a-z0-9]+/gi, '-') + '.js';
  fs.writeFileSync(f, src);
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail('syntax error in ' + label + ': ' + (e.stderr || e.message).toString().slice(0, 500));
  }
}

const ORIG = process.argv[2] || fail('usage: node build-hosted.cjs <orig-dir>');
const OUT = path.join(ORIG, 'out');
const DS = path.join(ORIG, 'source', '_ds');
const HOSTDIR = path.join(ORIG, 'hosting');
fs.mkdirSync(HOSTDIR, { recursive: true });

const htmlPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

// ---- 1. extract the DC source from the x-dc block ----
const dcMatch = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
if (!dcMatch) fail('x-dc block not found');
const dcSrc = dcMatch[1];
console.log('DC source chars:', dcSrc.length);
if (dcSrc.includes('</script')) fail('DC source contains </script');
if (!/<x-dc[\s>]/.test(html)) fail('<x-dc> element not found');

// ---- 2. precompiled DC logic (replaces evalDcLogic's new Function) ----
const precompiledJs =
  'window.__dcPrecompiled=function(DCLogic,StreamableLogic,React){\n' +
  dcSrc +
  '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};\n';
checkJs(precompiledJs, 'precompiled-dc');

// ---- 3. transform support.js: swap evalDcLogic body, kill x-import loader ----
let support = fs.readFileSync(path.join(ORIG, 'source', 'support.js'), 'utf8');
const evalOld =
`  function evalDcLogic(src) {
    //! nosemgrep: eval-and-function-constructor
    const fn = new Function(
      "DCLogic",
      "StreamableLogic",
      "React",
      src + '\\n;return (typeof Component!=="undefined"&&Component)||undefined;'
    );
    return fn(StreamableLogic, StreamableLogic, getReact());
  }`;
const evalNew =
`  function evalDcLogic(src) {
    const fn = window.__dcPrecompiled;
    if (typeof fn !== "function") throw new Error("dc-runtime: precompiled DC logic missing");
    return fn(StreamableLogic, StreamableLogic, getReact());
  }`;
if (!support.includes(evalOld)) fail('evalDcLogic block not found in support.js');
support = support.replace(evalOld, () => evalNew);

const ximportOld = `        //! nosemgrep: eval-and-function-constructor
        new Function("React", "module", "exports", "require", code)(`;
const ximportNew = `        throw new Error("dc-runtime: x-import dynamic loading is disabled in this hosted build"); void (`;
if (!support.includes(ximportOld)) fail('x-import new Function block not found');
support = support.replace(ximportOld, () => ximportNew);
checkJs(support, 'support-transformed');
console.log('support.js transformed, chars:', support.length);

// ---- 4. gather data files for the fetch shim ----
function walk(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(walk(p, rel));
    else if (e.isFile() && /\.json$/i.test(e.name)) out.push({ rel, p });
  }
  return out;
}
const dataDir = path.join(OUT, 'data');
const files = walk(dataDir, '');
if (!files.length) fail('no data files found');
const entries = files.map(f => {
  const text = fs.readFileSync(f.p, 'utf8');
  JSON.parse(text); // validate
  return '  ' + JSON.stringify('data/' + f.rel) + ': ' + JSON.stringify(text);
});
console.log('data files inlined:', files.length);
const shimJs =
  '(function(){\n' +
  'var DATA = {\n' + entries.join(',\n') + '\n};\n' +
  'var nativeFetch = window.fetch.bind(window);\n' +
  'window.fetch = function(url, opts){\n' +
  '  try {\n' +
  '    var key = String(url);\n' +
  '    var q = key.indexOf("?"); if (q >= 0) key = key.slice(0, q);\n' +
  '    var h = key.indexOf("#"); if (h >= 0) key = key.slice(0, h);\n' +
  '    if (key.charAt(0) === "/") key = key.slice(1);\n' +
  '    if (key.indexOf("data/") === 0 && Object.prototype.hasOwnProperty.call(DATA, key)) {\n' +
  '      var body = DATA[key];\n' +
  '      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));\n' +
  '    }\n' +
  '  } catch (e) {}\n' +
  '  return nativeFetch(url, opts);\n' +
  '};\n' +
  '})();\n';
checkJs(shimJs, 'fetch-shim');

// ---- 5. design system CSS + bundle ----
const dsDirs = fs.readdirSync(DS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
if (!dsDirs.length) fail('no _ds bundle dir');
const dsDir = path.join(DS, dsDirs[0]);
const dsCssFiles = fs.readdirSync(dsDir).filter(f => /\.css$/i.test(f));
if (!dsCssFiles.length) fail('no ds css file');
const dsCss = fs.readFileSync(path.join(dsDir, dsCssFiles[0]), 'utf8');
const dsBundle = fs.readFileSync(path.join(dsDir, '_ds_bundle.js'), 'utf8');
checkJs(dsBundle, 'ds-bundle');

// ---- 6. evidence renderer + react ----
const evRenderer = fs.readFileSync(path.join(OUT, 'assets', 'evidence-renderer.js'), 'utf8');
checkJs(evRenderer, 'evidence-renderer');
// React UMD is loaded dynamically by support.js (loadReactUmd) from unpkg, which the
// hosted browser cannot reach. Vendored copies inlined BEFORE support.js set
// window.React/window.ReactDOM, so loadReactUmd() short-circuits and never hits CDN.
const reactJs = fs.readFileSync(path.join(HOSTDIR, 'vendor', 'react-18.3.1.min.js'), 'utf8');
const reactDomJs = fs.readFileSync(path.join(HOSTDIR, 'vendor', 'react-dom-18.3.1.min.js'), 'utf8');
for (const [nm, src] of [['react', reactJs], ['react-dom', reactDomJs]]) {
  if (src.includes('</script')) fail(nm + ' contains </script');
  checkJs(src, nm);
}

// ---- 7. assemble: replace external script tags, keep everything else ----
function scriptTag(src) { return '<script src="' + src + '">'; }
function inlineScript(js) { return '<script>\n' + js + '\n</script>'; }

if (!html.includes(scriptTag('/assets/evidence-renderer.js'))) fail('evidence-renderer tag missing');
html = html.replace(scriptTag('/assets/evidence-renderer.js'), () => inlineScript(evRenderer));

if (!html.includes(scriptTag('./support.js'))) fail('support.js tag missing');
html = html.replace(scriptTag('./support.js'), () =>
  inlineScript(reactJs) + '\n' +
  inlineScript(reactDomJs) + '\n' +
  inlineScript(shimJs) + '\n' +
  inlineScript(precompiledJs) + '\n' +
  inlineScript(support));

const dsTagRe = /<script src="_ds\/[^"]*\/_ds_bundle\.js"><\/script>/;
if (!dsTagRe.test(html)) fail('ds bundle tag missing');
html = html.replace(dsTagRe, () => inlineScript(dsBundle));
// inline the design-system stylesheet link as well (no external fetches on the host)
const dsCssLinkRe = /<link rel="stylesheet" href="_ds\/[^"]*\.css">/;
if (dsCssLinkRe.test(html)) {
  html = html.replace(dsCssLinkRe, () => '<style>\n' + dsCss + '\n</style>');
} else {
  html = html.replace('</head>', () => '<style>\n' + dsCss + '\n</style>\n</head>');
}

// ---- 8. final validation ----
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('inline script blocks:', blocks.length);
blocks.forEach((b, i) => { if (b.trim()) checkJs(b, 'final-block-' + i); });
const allScripts = blocks.join('\n');
if (/new Function/.test(allScripts)) fail('new Function still present');
if (/(^|[^\w$])eval\s*\(/.test(allScripts)) fail('eval( still present');
if (/<script[^>]*src=/.test(html)) fail('external script src remains');

const outPath = path.join(HOSTDIR, 'opstream-gtm-hosted.html');
fs.writeFileSync(outPath, html);
console.log('wrote', outPath, fs.statSync(outPath).size, 'bytes');
