// Peak RSS of the agent server with a synthetic extract the same size as production.
// Real records are not in git. The shape is: records ~5.2 MB, verified ~217 KB,
// evidence ~5.6 MB, and thousands of timestamps so the open-book walk runs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-mem-'));
const port = 4319;
const LIMIT_KB = 250 * 1024;

fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(dir, 'out', 'data'), { recursive: true });
for (const rel of ['workspace-model.cjs', 'scripts/agent-server.mjs', 'scripts/workspace-facts.mjs', 'scripts/published-swap.mjs', 'scripts/sheets-connect.mjs']) {
  fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
}
fs.writeFileSync(path.join(dir, 'out', 'index.html'), '<!doctype html><title>memory</title>');

function iso(i) {
  return new Date(Date.UTC(2025, 0, 1) + (i % 9000) * 3600000).toISOString();
}

const companies = [];
let stamp = 0;
for (let c = 0; c < 180; c++) {
  const notes = [];
  const meetings = [];
  const emails = [];
  const recordings = [];
  for (let n = 0; n < 45; n++) notes.push({ id: 'n' + c + '-' + n, date: iso(stamp++), body: 'Note text '.repeat(12) });
  for (let n = 0; n < 12; n++) meetings.push({ id: 'm' + c + '-' + n, start: iso(stamp++), booked: iso(stamp++), title: 'Meeting ' + n, outcome: n % 4 === 0 ? 'COMPLETED' : '' });
  for (let n = 0; n < 12; n++) emails.push({ date: iso(stamp++), subject: 'Email ' + n });
  for (let n = 0; n < 4; n++) recordings.push({ id: 'r' + c + '-' + n, date: iso(stamp++), title: 'Call ' + n, summary: [{ x: 'Summary words '.repeat(20) }], actions: ['Follow up'] });
  companies.push({
    id: 'co-' + c,
    name: 'Company ' + c,
    owner: 'Owner ' + (100000 + (c % 40)),
    industry: 'Industry',
    domain: 'example' + c + '.test',
    lastContact: iso(stamp++),
    deals: [{ id: 'deal-' + c, name: 'Company ' + c + ' - New Deal', stageLabel: 'Discovery (Deal)', amount: 1000 + c, close: '2027-03-31', owner: 'Owner ' + (100000 + (c % 40)), closed: false }],
    contacts: [{ name: 'Pat ' + c, title: 'Buyer', email: 'pat' + c + '@example.test' }],
    notes, meetings, emails: { items: emails }, recordings,
    completedInteractions: [{ date: iso(stamp++) }],
    calls: [{ date: iso(stamp++) }],
  });
}
const opportunities = companies.map((c, i) => ({
  id: c.deals[0].id,
  name: c.name,
  companyId: 'company:' + c.id,
  owner: c.owner,
  stage: i % 17 === 0 ? null : 'Discovery/RFP received (Deal)',
  amount: 1000 + i,
  probability: 0.01,
  close: '2027-03-31',
  days: 10,
  note: '',
}));
// One larger open deal so the metrics call has a stable winner.
opportunities[0].amount = 500000;
opportunities[0].name = 'NXP';
companies[0].name = 'NXP';
companies[0].deals[0].name = 'NXP - New Deal';
companies[0].deals[0].amount = 500000;
const leads = [];
for (let i = 0; i < 500; i++) leads.push({ id: 'lead-' + i, name: 'Lead ' + i, source: 'HubSpot', owner: 'Owner ' + (100000 + (i % 40)), lead: '2026-08-01', note: 'Lead note '.repeat(8) });
const records = { verifiedSnapshotId: 'synthetic-mem', generatedAt: '2026-09-27T03:28:59.000Z', companies, unmatchedRecordings: [], coverage: { contacts: 180, notes: 180 * 45, fathomTotal: 180 * 4, transcripts: 0 } };
const verified = { snapshotId: 'synthetic-mem', meta: { owners: [] }, opportunities, leads, drafts: [], presentation: { priorities: [] }, quick: {}, report: {} };
let recordsJson = JSON.stringify(records);
if (recordsJson.length < 5_200_000) recordsJson += '';
// Pad inside the JSON by extending the last note body so the file matches production size.
if (recordsJson.length < 5_200_000) {
  companies[179].notes[0].body += 'y'.repeat(5_200_000 - recordsJson.length + 64);
  recordsJson = JSON.stringify(records);
}
const verifiedJson = JSON.stringify(verified);
const evidenceJson = JSON.stringify({ pad: 'z'.repeat(5_600_000) });
fs.writeFileSync(path.join(dir, 'out', 'data', 'records.json'), recordsJson);
fs.writeFileSync(path.join(dir, 'out', 'data', 'verified.json'), verifiedJson.length < 217_000 ? verifiedJson + '' : verifiedJson);
if (fs.statSync(path.join(dir, 'out', 'data', 'verified.json')).size < 200_000) {
  verified.presentation.priorities = [{ title: 'p', why: 'w'.repeat(220_000), next: 'n' }];
  fs.writeFileSync(path.join(dir, 'out', 'data', 'verified.json'), JSON.stringify(verified));
}
fs.writeFileSync(path.join(dir, 'out', 'data', 'evidence.json'), evidenceJson);
const sizes = {
  records: fs.statSync(path.join(dir, 'out', 'data', 'records.json')).size,
  verified: fs.statSync(path.join(dir, 'out', 'data', 'verified.json')).size,
  evidence: fs.statSync(path.join(dir, 'out', 'data', 'evidence.json')).size,
};
if (sizes.records < 5_000_000 || sizes.verified < 200_000 || sizes.evidence < 5_500_000) {
  console.error(JSON.stringify({ ok: false, error: 'synthetic files are smaller than production', sizes }));
  process.exit(1);
}

function hwm(pid) {
  const text = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
  const m = text.match(/VmHWM:\s+(\d+)\s+kB/);
  const r = text.match(/VmRSS:\s+(\d+)\s+kB/);
  return { hwmKb: m ? Number(m[1]) : 0, rssKb: r ? Number(r[1]) : 0 };
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
  console.error(JSON.stringify({ ok: false, error: msg, sizes, log: log.slice(-800) }, null, 2));
  process.exit(1);
};

const deadline = Date.now() + 20000;
let ready = false;
while (Date.now() < deadline) {
  if (child.exitCode != null) fail('server exited before health');
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/health');
    const body = await res.json();
    if (res.ok && body.ok === true) { ready = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 150));
}
if (!ready) fail('health did not respond');
const boot = hwm(child.pid);
const ask = fetch('http://127.0.0.1:' + port + '/api/ask', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: 'What is the largest open deal and its amount?' }),
}).catch(() => null);
let peak = boot;
const until = Date.now() + 10000;
while (Date.now() < until) {
  await new Promise(r => setTimeout(r, 200));
  if (child.exitCode != null) fail('server exited during ask');
  const now = hwm(child.pid);
  if (now.hwmKb > peak.hwmKb) peak = now;
}
try { child.kill('SIGKILL'); } catch {}
await ask;
const mb = kb => Math.round(kb / 1024);
const report = {
  ok: peak.hwmKb < LIMIT_KB,
  sizes,
  timestamps: stamp,
  rssAtHealthMb: mb(boot.rssKb),
  peakRssMb: mb(peak.hwmKb),
  limitMb: 250,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
