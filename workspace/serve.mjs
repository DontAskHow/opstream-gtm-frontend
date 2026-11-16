#!/usr/bin/env node
// Serves the built workspace on 127.0.0.1 only. Static files, GET/HEAD, no
// directory listings, nothing outside the output directory.
//   node workspace/serve.mjs [--dir <built-workspace-dir>] [--port 8787]
// The directory defaults to $GTM_WORKSPACE_OUT, then /workspace/gtm-onepage-out/workspace.
import { createServer } from 'node:http';
import { createReadStream, statSync, realpathSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';

const HOST = '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
};

function parseArgs(argv) {
  const args = { dir: process.env.GTM_WORKSPACE_OUT || '/workspace/gtm-onepage-out/workspace', port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(dir|port)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument ${argv[i]}`);
    args[m[1]] = m[2] ?? argv[++i];
  }
  return { dir: resolve(args.dir), port: Number(args.port) };
}

export function startServer({ dir, port }) {
  const root = realpathSync(dir);
  const server = createServer((req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
      return;
    }
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400, headers).end();
      return;
    }
    if (path.endsWith('/')) path += 'index.html';
    let file;
    try {
      file = realpathSync(join(root, path));
    } catch {
      res.writeHead(404, headers).end('Not found');
      return;
    }
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404, headers).end('Not found');
      return;
    }
    const st = statSync(file);
    if (!st.isFile() || file.split(sep).some((p) => p.startsWith('.') && p.length > 1)) {
      res.writeHead(404, headers).end('Not found');
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, HOST, () => ok(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const server = await startServer(opts);
    console.log(`Serving ${opts.dir} at http://${HOST}:${server.address().port}/`);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
