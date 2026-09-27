// Poll published/LATEST.json and swap out/data only after the new run validates.
// A bad publish leaves the last good files in place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export function loadRefreshConfig(appRoot) {
  const file = path.join(appRoot, 'refresh-config.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function fsRoot() {
  return process.env.REFRESH_FS_ROOT || '';
}

function readFs(root, key) {
  const file = path.join(root, key);
  if (!fs.existsSync(file)) throw new Error('missing ' + key);
  return fs.readFileSync(file);
}

function writeFs(root, key, body) {
  const file = path.join(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

async function imdsCreds() {
  const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
    signal: AbortSignal.timeout(500),
  });
  if (!tokenRes.ok) throw new Error('imds token');
  const token = await tokenRes.text();
  const roleRes = await fetch('http://169.254.169.254/latest/meta-data/iam/security-credentials/', {
    headers: { 'X-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(500),
  });
  const role = (await roleRes.text()).trim().split('\n')[0];
  const credRes = await fetch('http://169.254.169.254/latest/meta-data/iam/security-credentials/' + role, {
    headers: { 'X-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(500),
  });
  const body = await credRes.json();
  return { accessKeyId: body.AccessKeyId, secretAccessKey: body.SecretAccessKey, sessionToken: body.Token };
}

function s3Request({ region, bucket, key, method, body, creds }) {
  const host = bucket + '.s3.' + region + '.amazonaws.com';
  const payload = body ? Buffer.from(body) : Buffer.alloc(0);
  const payloadHash = sha256(payload);
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const datestamp = amzdate.slice(0, 8);
  const canonicalUri = '/' + key.split('/').map(encodeURIComponent).join('/');
  const tokenLine = creds.sessionToken ? 'x-amz-security-token:' + creds.sessionToken + '\n' : '';
  const canonicalHeaders = 'host:' + host + '\n' + 'x-amz-content-sha256:' + payloadHash + '\n' + 'x-amz-date:' + amzdate + '\n' + tokenLine;
  const signedHeaders = creds.sessionToken
    ? 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token'
    : 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = datestamp + '/' + region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256(canonicalRequest)].join('\n');
  let signing = hmac('AWS4' + creds.secretAccessKey, datestamp);
  signing = hmac(signing, region);
  signing = hmac(signing, 's3');
  signing = hmac(signing, 'aws4_request');
  const signature = crypto.createHmac('sha256', signing).update(stringToSign).digest('hex');
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + creds.accessKeyId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const headers = {
    host,
    'x-amz-date': amzdate,
    'x-amz-content-sha256': payloadHash,
    Authorization: authorization,
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  return new Promise((resolve, reject) => {
    const req = https.request({ method, host, path: canonicalUri, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf);
        else reject(new Error('s3 ' + res.statusCode + ' ' + buf.toString('utf8').slice(0, 240)));
      });
    });
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

async function getObject(cfg, key) {
  const root = fsRoot();
  if (root) return readFs(root, key);
  const creds = await imdsCreds();
  return s3Request({ region: cfg.region || 'us-east-2', bucket: cfg.dataBucket, key, method: 'GET', creds });
}

async function putObject(cfg, key, body) {
  const root = fsRoot();
  if (root) { writeFs(root, key, body); return; }
  const creds = await imdsCreds();
  await s3Request({ region: cfg.region || 'us-east-2', bucket: cfg.dataBucket, key, method: 'PUT', body, creds });
}

function headGeneratedAt(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 8192)).toString('utf8');
  const gen = head.match(/"generatedAt"\s*:\s*"([^"]*)"/);
  const snap = head.match(/"verifiedSnapshotId"\s*:\s*"([^"]*)"/) || head.match(/"snapshotId"\s*:\s*"([^"]*)"/);
  return { generatedAt: gen ? gen[1] : '', snapshotId: snap ? snap[1] : '' };
}

function validateIncoming(dir) {
  const recordsPath = path.join(dir, 'records.json');
  const verifiedPath = path.join(dir, 'verified.json');
  if (!fs.existsSync(recordsPath) || !fs.existsSync(verifiedPath)) throw new Error('publish missing records');
  const rec = fs.readFileSync(recordsPath);
  const ver = fs.readFileSync(verifiedPath);
  const recHead = headGeneratedAt(rec);
  const verHead = headGeneratedAt(ver);
  if (!recHead.generatedAt) throw new Error('publish has no generatedAt');
  if (/synthetic|demo/i.test(recHead.snapshotId) || /synthetic|demo/i.test(verHead.snapshotId)) {
    throw new Error('refusing synthetic publish');
  }
  if (recHead.snapshotId && verHead.snapshotId && recHead.snapshotId !== verHead.snapshotId) {
    throw new Error('publish snapshot ids disagree');
  }
  JSON.parse(fs.readFileSync(path.join(dir, 'hollie.json'), 'utf8'));
}

function swapDir(dataDir, incoming) {
  const backup = dataDir + '.last-good';
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(dataDir)) fs.renameSync(dataDir, backup);
  try {
    fs.renameSync(incoming, dataDir);
  } catch (err) {
    if (fs.existsSync(backup)) fs.renameSync(backup, dataDir);
    throw err;
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

export async function pollPublished({ appRoot, dataDir, onSwap }) {
  const cfg = loadRefreshConfig(appRoot);
  if (!cfg || !cfg.dataBucket) return { changed: false, reason: 'no config' };
  const prefix = (cfg.publishedPrefix || 'published').replace(/\/$/, '');
  let latest;
  try {
    latest = JSON.parse((await getObject(cfg, prefix + '/LATEST.json')).toString('utf8'));
  } catch (err) {
    return { changed: false, reason: 'latest unreadable', error: String(err.message || err) };
  }
  const stampPath = path.join(dataDir, '.published-run');
  const current = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : '';
  if (!latest.runId || latest.runId === current) return { changed: false, reason: 'same run' };
  const incoming = dataDir + '.incoming';
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.mkdirSync(incoming, { recursive: true });
  try {
    const manifest = (await getObject(cfg, (latest.prefix || (prefix + '/' + latest.runId + '/')) + 'MANIFEST.txt')).toString('utf8');
    const names = manifest.split('\n').map(s => s.trim()).filter(Boolean);
    if (!names.includes('records.json') || !names.includes('verified.json')) throw new Error('manifest incomplete');
    for (const name of names) {
      if (name.includes('..')) throw new Error('bad manifest path');
      const buf = await getObject(cfg, (latest.prefix || (prefix + '/' + latest.runId + '/')) + name);
      const dest = path.join(incoming, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    validateIncoming(incoming);
    swapDir(dataDir, incoming);
    fs.writeFileSync(path.join(dataDir, '.published-run'), latest.runId);
    if (onSwap) onSwap(latest);
    return { changed: true, runId: latest.runId };
  } catch (err) {
    fs.rmSync(incoming, { recursive: true, force: true });
    return { changed: false, reason: 'kept last good', error: String(err.message || err) };
  }
}

export async function persistStateFile(appRoot, name, body) {
  const cfg = loadRefreshConfig(appRoot);
  if (!cfg || !cfg.dataBucket) return;
  const key = (cfg.statePrefix || 'state').replace(/\/$/, '') + '/' + name;
  try { await putObject(cfg, key, Buffer.isBuffer(body) ? body : Buffer.from(body)); }
  catch (err) { console.error('[state] keep local copy; remote save failed: ' + (err.message || err)); }
}
