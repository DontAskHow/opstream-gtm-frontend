// Unzip a deploy bundle into an empty directory and boot only what is inside it.
// /api/health must return ok. This fails when workspace-model.cjs is missing,
// because scripts/workspace-facts.mjs requires it at startup.
//
// usage: node scripts/check-bundle.mjs <zip> <brain.db>
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_REQUIRED } from './package-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zipPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
const brainDb = process.argv[3] ? path.resolve(process.argv[3]) : '';
if (!zipPath || !brainDb) {
  console.error('usage: node scripts/check-bundle.mjs <zip> <brain.db>');
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-unzip-'));
const port = 4317;

execFileSync('unzip', ['-q', zipPath, '-d', dir]);
const missing = BUNDLE_REQUIRED.filter(rel => !fs.existsSync(path.join(dir, rel)));
if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }));
  process.exit(1);
}

function assertSnapshot(bundleDir, dbPath) {
  const dataDir = path.join(bundleDir, 'out', 'data');
  const facts = JSON.parse(fs.readFileSync(path.join(dataDir, 'run-facts.json'), 'utf8'));
  const ids = new Map();
  for (const name of fs.readdirSync(dataDir)) {
    if (!name.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
    if (Array.isArray(data)) {
      const nested = [...new Set(data.map(row => row && row.runId).filter(Boolean))];
      if (data.length && nested.length !== 1) failSnapshot(name + ' rows do not share one run id');
      if (nested[0]) ids.set(name, nested[0]);
      continue;
    }
    if (!data || typeof data !== 'object' || !data.runId) failSnapshot(name + ' has no run id');
    ids.set(name, data.runId);
  }
  const uniq = [...new Set(ids.values())];
  if (uniq.length !== 1) failSnapshot('run ids differ: ' + uniq.join(', '));
  const sheet = execFileSync('python3', ['-c', `
import json, sqlite3, sys
sys.path.insert(0, sys.argv[1])
from gtm_metrics import parse_money, sheet_class_name
con = sqlite3.connect(sys.argv[2])
cur = con.cursor()
count = 0
amount = 0.0
for row_json in cur.execute(
    "select row_json from sheets_data where spreadsheet_title=? and tab=? order by row_num",
    ("pipeline_meeting1_v2", "HS_Data")):
    try:
        row = json.loads(row_json[0])
    except Exception:
        continue
    if not isinstance(row, list) or not row:
        continue
    if str(row[0]).strip().lower().startswith("deal"):
        continue
    stage = str(row[4]).strip() if len(row) > 4 and row[4] else ""
    if sheet_class_name(stage) != "active":
        continue
    count += 1
    amount += parse_money(row[5] if len(row) > 5 else None) or 0
print(json.dumps({"count": count, "amount": round(amount)}))
`, path.join(bundleDir, 'scripts'), dbPath], { encoding: 'utf8' });
  const active = JSON.parse(sheet);
  if (facts.openCount !== active.count || facts.openAmount !== active.amount) {
    failSnapshot('run-facts ' + facts.openCount + '/' + facts.openAmount + ' != HS_Data ' + active.count + '/' + active.amount);
  }
  return { runId: uniq[0], openCount: facts.openCount, openAmount: facts.openAmount };
}

function failSnapshot(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

const snapshot = assertSnapshot(dir, brainDb);

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
      snapshot,
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
