// Filesystem-mode refresh: publish, fail closed without brain.db, keep last good.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollPublished } from './published-swap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(name + ': ' + detail);
  else console.log('ok ' + name);
}

const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-fs-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-work-'));
const dbDir = path.join(fsRoot, 'data', 'brain');
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'brain.db');
execFileSync('python3', ['-c', `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
c = con.cursor()
c.execute("create table hubspot_objects (hs_id text, object_type text, properties_json text, fetched_at text)")
c.execute("create table hubspot_associations (from_type text, from_id text, to_type text, to_id text)")
c.execute("create table hubspot_owners (id text, first_name text, last_name text, email text)")
c.execute("create table sheets_data (spreadsheet_title text, tab text, row_num int, row_json text)")
c.execute("""create table meetings (recording_id text, title text, meeting_type text, created_at text,
 scheduled_start_time text, scheduled_end_time text, recording_start_time text, recording_end_time text,
 recorded_by_name text, recorded_by_email text, invitees_json text, summary_markdown text,
 action_items_json text, fetched_at text)""")
c.execute("create table transcripts (recording_id text, turns_json text)")
c.execute("create table lemlist_campaigns (campaign_id text, name text, status text, raw_json text)")
c.execute("create table ga4_reports (report_key text primary key, property_id text, params_json text, result_json text, fetched_at text)")
c.execute("create table findings (id text, kind text, claim text, confidence text, evidence_refs text, status text, created_at text)")
con.commit()
`, dbPath], { cwd: root });

const env = {
  ...process.env,
  REFRESH_MODE: 'fs',
  REFRESH_FS_ROOT: fsRoot,
  REFRESH_WORK: work,
  REFRESH_CONFIG: path.join(root, 'refresh-config.json'),
  GTM_FACTS_ONLY: '1',
};
const first = execFileSync('python3', ['refresh/run.py'], { cwd: root, env, encoding: 'utf8' });
console.log(first.slice(-800));
const expectedSkips = [
  ['sheets_sync.py', 'google-sheets-refresh-token'],
  ['hubspot_sync.py', 'hubspot-oauth'],
  ['fathom_sync.py', 'fathom-token'],
  ['ga4_sync.py', 'google-sheets-refresh-token'],
  ['lemlist_sync.py', 'lemlist-token'],
  ['otterly_sync.py', 'otterly-token'],
];
for (const [script, secret] of expectedSkips) {
  check('skipped ' + script, first.includes('skipping ' + script) && first.includes('opstream-gtm/' + secret), 'log did not name the skip');
}
check('sync summary ran none', first.includes('sync summary: ran none'), 'missing ran-none line');
check('brain.db left unchanged', first.includes('brain.db left unchanged'), 'missing unchanged line');
const latestPath = path.join(fsRoot, 'published', 'LATEST.json');
check('published latest', fs.existsSync(latestPath), 'missing LATEST.json');
const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
const publishedRecords = path.join(fsRoot, latest.prefix, 'records.json');
check('published records', fs.existsSync(publishedRecords), publishedRecords);
const snap = JSON.parse(fs.readFileSync(path.join(fsRoot, latest.prefix, 'verified.json'), 'utf8')).snapshotId;
check('not synthetic', snap && !/synthetic/i.test(snap), snap);

const tokenMarker = 'do-not-log-this-refresh-token';
fs.mkdirSync(path.join(fsRoot, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(fsRoot, 'secrets', 'google-sheets-refresh-token'), tokenMarker);
let exit3Log = '';
let exit3Failed = false;
try {
  exit3Log = execFileSync('python3', ['refresh/run.py'], {
    cwd: root,
    env: { ...env, AWS_EC2_METADATA_DISABLED: 'true' },
    encoding: 'utf8',
  });
} catch (err) {
  exit3Failed = true;
  exit3Log = String(err.stdout || '') + String(err.stderr || '');
}
check('exit 3 does not fail the job', !exit3Failed, exit3Log.slice(-400));
check('sheets needs connection', exit3Log.includes('skipping sheets_sync.py because it needs a connection (exit 3)'), 'sheets');
check('ga4 needs connection', exit3Log.includes('skipping ga4_sync.py because it needs a connection (exit 3)'), 'ga4');
check('refresh token not logged', !exit3Log.includes(tokenMarker), 'token appeared');
const latestPathAfter = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
const firstRun = latestPathAfter.runId;

fs.rmSync(dbPath);
let failed = false;
try {
  execFileSync('python3', ['refresh/run.py'], { cwd: root, env, encoding: 'utf8' });
} catch (err) {
  failed = err.status !== 0;
}
check('missing brain.db fails', failed, 'exit 0');
const latestAfter = JSON.parse(fs.readFileSync(latestPath, 'utf8')).runId;
check('missing brain.db publishes nothing', latestAfter === firstRun, latestAfter);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-serve-'));
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'records.json'), JSON.stringify({ verifiedSnapshotId: 'brain-keep', generatedAt: '2026-09-26T00:00:00+00:00', companies: [] }));
fs.writeFileSync(path.join(dataDir, 'verified.json'), JSON.stringify({ snapshotId: 'brain-keep' }));
fs.writeFileSync(path.join(dataDir, 'hollie.json'), JSON.stringify({ runId: 'keep', queue: [] }));
fs.writeFileSync(path.join(dataDir, '.published-run'), 'old');
const goodPrefix = 'published/good-run/';
const goodDir = path.join(fsRoot, 'published', 'good-run');
fs.mkdirSync(goodDir, { recursive: true });
fs.writeFileSync(path.join(goodDir, 'records.json'), JSON.stringify({ verifiedSnapshotId: 'brain-good', generatedAt: '2026-09-27T00:00:00+00:00', companies: [] }));
fs.writeFileSync(path.join(goodDir, 'verified.json'), JSON.stringify({ snapshotId: 'brain-good' }));
fs.writeFileSync(path.join(goodDir, 'hollie.json'), JSON.stringify({ runId: 'good', queue: [] }));
fs.writeFileSync(path.join(goodDir, 'MANIFEST.txt'), 'records.json\nverified.json\nhollie.json\n');
fs.writeFileSync(latestPath, JSON.stringify({ runId: 'good-run', prefix: goodPrefix, snapshotId: 'brain-good' }));
process.env.REFRESH_FS_ROOT = fsRoot;
const swapped = await pollPublished({ appRoot: root, dataDir });
check('swap', swapped.changed === true, JSON.stringify(swapped));
const served = JSON.parse(fs.readFileSync(path.join(dataDir, 'records.json'), 'utf8'));
check('served new run', served.verifiedSnapshotId === 'brain-good', served.verifiedSnapshotId);

const badDir = path.join(fsRoot, 'published', 'bad-run');
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, 'records.json'), '{ this is not json');
fs.writeFileSync(path.join(badDir, 'verified.json'), JSON.stringify({ snapshotId: 'synthetic-v1' }));
fs.writeFileSync(path.join(badDir, 'hollie.json'), '{}');
fs.writeFileSync(path.join(badDir, 'MANIFEST.txt'), 'records.json\nverified.json\nhollie.json\n');
fs.writeFileSync(latestPath, JSON.stringify({ runId: 'bad-run', prefix: 'published/bad-run/', snapshotId: 'synthetic-v1' }));
const kept = await pollPublished({ appRoot: root, dataDir });
check('corrupt publish kept last good', kept.changed === false, JSON.stringify(kept));
const still = JSON.parse(fs.readFileSync(path.join(dataDir, 'records.json'), 'utf8'));
check('still good snapshot', still.verifiedSnapshotId === 'brain-good', still.verifiedSnapshotId);

const report = { ok: failures.length === 0, failures };
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
