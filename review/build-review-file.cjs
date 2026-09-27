// Builds a single self-contained HTML review snapshot of the dashboard.
// Inlines scripts/CSS and embeds the runtime JSON data behind a fetch shim,
// so the file works from any static host (no live /api server).
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out');
const REVIEW_DIR = __dirname;
fs.mkdirSync(REVIEW_DIR, { recursive: true });

function read(p) { return fs.readFileSync(path.join(OUT, p), 'utf8'); }
function readBin(p) { return fs.readFileSync(path.join(OUT, p)); }
// Make JS/CSS safe to inline inside <script>/<style>: break out of closing tags.
function safeInline(s) { return s.replace(/<\/(script|style)/gi, '<\\/$1'); }

let html = read('index.html');

// 1. Inline the three external scripts.
const scripts = {
  '<script src="/assets/evidence-renderer.js"></script>': 'assets/evidence-renderer.js',
  '<script src="./support.js"></script>': 'support.js',
  '<script src="_ds/modernist-b33a3025-c7ab-4acb-99c2-5c4275b50711/_ds_bundle.js"></script>':
    '_ds/modernist-b33a3025-c7ab-4acb-99c2-5c4275b50711/_ds_bundle.js',
};
for (const [tag, file] of Object.entries(scripts)) {
  if (!html.includes(tag)) throw new Error('script tag not found: ' + tag);
  let inline = '<script>\n' + safeInline(read(file)) + '\n</script>';
  if (file === 'support.js') {
    // React/ReactDOM UMD must load BEFORE support.js: its loadReactUmd() sees
    // window.React && window.ReactDOM and resolves immediately instead of
    // fetching from a CDN (unreachable in hosted sandboxes -> blank page).
    inline =
      '<script>\n// React 18.3.1 UMD (inlined for offline hosted snapshot)\n' +
      safeInline(fs.readFileSync(path.join(__dirname, 'vendor', 'react.production.min.js'), 'utf8')) +
      '\n</script>\n<script>\n// ReactDOM 18.3.1 UMD (inlined for offline hosted snapshot)\n' +
      safeInline(fs.readFileSync(path.join(__dirname, 'vendor', 'react-dom.production.min.js'), 'utf8')) +
      '\n</script>\n' + inline;
  }
  html = html.replace(tag, () => inline);
}

// 2. Inline the design-system stylesheet.
const cssTag = '<link rel="stylesheet" href="_ds/modernist-b33a3025-c7ab-4acb-99c2-5c4275b50711/styles.css">';
const cssTagAlt = html.match(/<link[^>]*modernist[^>]*styles\.css[^>]*>/);
if (!cssTagAlt) throw new Error('ds css link not found');
html = html.replace(cssTagAlt[0], () =>
  '<style>\n' + safeInline(read('_ds/modernist-b33a3025-c7ab-4acb-99c2-5c4275b50711/styles.css')) + '\n</style>');

// 3. Drop <base href="/"> so relative resolution can't escape the file context.
html = html.replace('<base href="/">', '');

// 4. Gather embedded data.
const embedded = {};
function addJson(key, file) {
  const raw = read(file).trim();
  JSON.parse(raw); // validate
  embedded[key] = raw;
}
addJson('data/bootstrap.json', 'data/bootstrap.json');
addJson('data/hollie.json', 'data/hollie.json');
addJson('data/records.json', 'data/records.json');
addJson('data/transcripts.json', 'data/transcripts.json');
for (const f of fs.readdirSync(path.join(OUT, 'data', 'transcripts')).sort()) {
  if (f.endsWith('.json')) addJson('data/transcripts/' + f, 'data/transcripts/' + f);
}

// 5. Fetch shim: serve embedded data, stub /api (no live server in a static file).
const entries = Object.entries(embedded)
  .map(([k, v]) => '  ' + JSON.stringify(k) + ': ' + v.replace(/<\/(script)/gi, '<\\/$1'))
  .join(',\n');
const shim = `<script>
(function(){
  var EMBEDDED = {
${entries}
  };
  var origFetch = window.fetch.bind(window);
  window.fetch = function(url, opts){
    var u = String(url);
    var key = u.replace(/^\\//, '');
    if (Object.prototype.hasOwnProperty.call(EMBEDDED, key)) {
      return Promise.resolve(new Response(EMBEDDED[key], {status:200, headers:{'Content-Type':'application/json'}}));
    }
    if (u === 'data/' || u === '/data/' || u === 'data' || u === '/data') {
      return Promise.resolve(new Response('[]', {status:200, headers:{'Content-Type':'application/json'}}));
    }
    if (u.indexOf('/api') === 0 || u === '/api') {
      return Promise.resolve(new Response(JSON.stringify({ok:false, offline:true, note:'static review snapshot: live server unavailable'}), {status:200, headers:{'Content-Type':'application/json'}}));
    }
    return origFetch(url, opts);
  };
  window.__REVIEW_SNAPSHOT__ = { generatedAt: ${JSON.stringify(new Date().toISOString())}, embeddedFiles: Object.keys(EMBEDDED).length };
})();
</script>`;

// Insert shim as the first thing in <head>.
html = html.replace(/<head[^>]*>/i, m => m + '\n' + shim);

const outPath = path.join(REVIEW_DIR, 'opstream-dashboard-review-2026-09-25.html');
fs.writeFileSync(outPath, html);
const mb = (fs.statSync(outPath).size / 1048576).toFixed(1);
console.log('wrote', outPath, mb + 'MB', '| embedded files:', Object.keys(embedded).length);
