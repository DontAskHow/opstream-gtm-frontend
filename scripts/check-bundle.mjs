// Unzip a deploy bundle into an empty directory and boot only what is inside it.
// /api/health must return ok. This fails when workspace-model.cjs is missing,
// because scripts/workspace-facts.mjs requires it at startup.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_REQUIRED } from './package-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zipPath = path.resolve(process.argv[2] || '/opt/cursor/artifacts/opstream-gtm-v9.zip');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-unzip-'));
const port = 4317;

execFileSync('unzip', ['-q', zipPath, '-d', dir]);
const missing = BUNDLE_REQUIRED.filter(rel => !fs.existsSync(path.join(dir, rel)));
if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }));
  process.exit(1);
}

function hwm(pid) {
  try {
    const text = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
    const m = text.match(/VmHWM:\s+(\d+)\s+kB/);
    const r = text.match(/VmRSS:\s+(\d+)\s+kB/);
    return { hwmKb: m ? Number(m[1]) : 0, rssKb: r ? Number(r[1]) : 0 };
  } catch {
    return { hwmKb: 0, rssKb: 0 };
  }
}

const child = spawn(process.execPath, ['scripts/agent-server.mjs'], {
  cwd: dir,
  env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', c => { log += c; });
child.stderr.on('data', c => { log += c; });

const fail = (msg) => {
  try { child.kill('SIGKILL'); } catch {}
  console.error(JSON.stringify({ ok: false, error: msg, log: log.slice(-1500) }, null, 2));
  process.exit(1);
};

const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  if (child.exitCode != null) fail('server exited ' + child.exitCode);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/health');
    const body = await res.json();
    if (!res.ok || body.ok !== true) fail('health ' + res.status + ' ' + JSON.stringify(body));
    const before = hwm(child.pid);
    const ask = fetch('http://127.0.0.1:' + port + '/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What is the largest open deal and its amount?' }),
    }).catch(() => null);
    const until = Date.now() + 8000;
    let peak = before;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 200));
      const now = hwm(child.pid);
      if (now.hwmKb > peak.hwmKb) peak = now;
    }
    try { child.kill('SIGKILL'); } catch {}
    await ask;
    const mb = kb => Math.round(kb / 1024);
    const report = {
      ok: true,
      health: body,
      rssBeforeAskMb: mb(before.rssKb),
      peakRssMb: mb(peak.hwmKb),
      required: BUNDLE_REQUIRED,
    };
    console.log(JSON.stringify(report, null, 2));
    if (peak.hwmKb >= 250 * 1024) process.exit(1);
    process.exit(0);
  } catch {
    await new Promise(r => setTimeout(r, 200));
  }
}
fail('health did not respond');
