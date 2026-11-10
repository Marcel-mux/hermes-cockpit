import { execFile } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const NINEROUTER_HOME = process.env.NINEROUTER_HOME || path.join(os.homedir(), '.9router');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8088;
const HOST = process.env.HOST || '0.0.0.0';
const BACKEND_PORT = process.env.HERMES_PORT ? parseInt(process.env.HERMES_PORT, 10) : 9119;
const BACKEND_HOST = process.env.HERMES_HOST || '127.0.0.1';
const DEFAULT_COCKPIT_PROFILE = process.env.HERMES_PROFILE || 'hermes-cockpit';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

const COMPRESSIBLE_EXTS = new Set(['.html', '.js', '.json', '.css', '.svg', '.txt', '.map']);

// Encoding yang dipakai buat respons API yang di-proxy (lihat handler proxy di bawah).
function pickEncoding(acceptEncoding) {
  const ae = String(acceptEncoding || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

// Not content-hashed and change on deploy: always revalidate.
const NO_CACHE_FILES = new Set(['sw.js', 'manifest.json', 'index.html']);
// Ikon ganti desain tanpa ganti nama file: jangan di-cache 24 jam, biar browser
// langsung ambil versi baru (OS-level install tetap perlu reinstall).
const NO_CACHE_ICON_RE = /^(icon|apple-touch-icon|favicon)/;
// Content-hashed by the bundler: safe to pin forever.
const IMMUTABLE_RE = /[\/\\]_expo[\/\\]static[\/\\]|[\/\\]assets[\/\\]|-[0-9a-f]{16,}\.(js|css|woff2?)$/;

const baseHeaders = () => ({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
});

function cacheControlFor(filePath) {
  const base = path.basename(filePath);
  // APK: jangan pernah di-cache — tiap rebuild versionCode berubah, dan HP bakal
  // ambil file lama dari cache 24 jam kalau dibiarin. no-store = selalu fresh.
  if (base.endsWith('.apk')) return 'no-store';
  if (NO_CACHE_FILES.has(base) || NO_CACHE_ICON_RE.test(base)) return 'no-cache';
  if (IMMUTABLE_RE.test(filePath)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=86400';
}

const etagFor = (stats) => `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

// ---------------------------------------------------------------------------
// Precompress gzip + brotli siblings next to each asset so a cold request never
// pays zlib CPU. Regenerated whenever the source file is newer.
// ---------------------------------------------------------------------------
function precompressAssets() {
  let entries;
  try {
    entries = fs.readdirSync(DIST_DIR, { recursive: true, withFileTypes: true });
  } catch {
    return;
  }
  let made = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!COMPRESSIBLE_EXTS.has(ext)) continue;
    const dir = entry.parentPath || entry.path;
    if (!dir) continue;
    const full = path.join(dir, entry.name);
    let stats;
    try { stats = fs.statSync(full); } catch { continue; }
    if (stats.size < 1024) continue;
    const variants = [
      ['.gz', (buf) => zlib.gzipSync(buf, { level: 9 })],
      ['.br', (buf) => zlib.brotliCompressSync(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 10,
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: stats.size
        }
      })]
    ];
    for (const [suffix, pack] of variants) {
      const target = `${full}${suffix}`;
      try {
        if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= stats.mtimeMs) continue;
        fs.writeFileSync(target, pack(fs.readFileSync(full)));
        made++;
      } catch (err) {
        console.error(`precompress failed ${target}:`, err.message);
      }
    }
  }
  if (made) console.log(`precompressed ${made} asset variants`);
}

precompressAssets();

// ---------------------------------------------------------------------------
// /api/active-sessions: reuse one read-only handle + 1s TTL cache so the client
// poll does not reopen SQLite on every hit.
// ---------------------------------------------------------------------------
let activeDb = null;
let activeDbPath = '';

let router9Cache = { timestamp: 0, payload: '' };

async function get9RouterTelemetryPayload() {
  const now = Date.now();
  if (router9Cache.payload && (now - router9Cache.timestamp < 5000)) {
    return router9Cache.payload;
  }
  const dbPath = path.join(NINEROUTER_HOME, 'db/data.sqlite');
  if (!fs.existsSync(dbPath)) {
    return JSON.stringify({ available: false });
  }

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });

    // 1. Today usage from usageDaily
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRow = db.prepare('SELECT data FROM usageDaily WHERE dateKey = ?').get(todayStr);
    let today = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    if (todayRow && todayRow.data) {
      try {
        const d = JSON.parse(todayRow.data);
        today.requests = d.requests || 0;
        today.promptTokens = d.promptTokens || 0;
        today.completionTokens = d.completionTokens || 0;
        today.cost = d.cost || 0;
      } catch {}
    }

    // 2. Recent requests from usageHistory
    const recentRows = db.prepare(`
      SELECT id, timestamp, provider, model, promptTokens, completionTokens, cost, status
      FROM usageHistory
      WHERE id IN (
        SELECT MAX(id)
        FROM usageHistory
        GROUP BY model
      )
      ORDER BY id DESC
      LIMIT 3
    `).all();
    const recentRequests = recentRows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      provider: r.provider || '',
      model: r.model || '',
      promptTokens: r.promptTokens || 0,
      completionTokens: r.completionTokens || 0,
      cost: r.cost || 0,
      status: r.status || 'ok'
    }));

    // 3. Provider Connections
    const allConns = db.prepare('SELECT id, provider, name, email, isActive FROM providerConnections').all();
    db.close();

    // Compute CLI token for 9Router API
    let cliToken = '';
    const machineIdPath = path.join(NINEROUTER_HOME, 'machine-id');
    const cliSecretPath = path.join(NINEROUTER_HOME, 'auth/cli-secret');
    if (fs.existsSync(machineIdPath) && fs.existsSync(cliSecretPath)) {
      try {
        const machineId = fs.readFileSync(machineIdPath, 'utf8').trim();
        const cliSecret = fs.readFileSync(cliSecretPath, 'utf8').trim();
        cliToken = crypto.createHash('sha256').update(machineId + '9r-cli-auth' + cliSecret).digest('hex').substring(0, 16);
      } catch {}
    }

    const quotaMap = {};
    if (cliToken) {
      const targetActive = allConns.filter(c => c.isActive === 1 && (
        c.provider === 'antigravity' ||
        c.provider.startsWith('codebuddy') ||
        c.provider.startsWith('qoder')
      ));

      await Promise.allSettled(targetActive.map(async c => {
        try {
          const res = await fetch('http://127.0.0.1:20128/api/usage/' + c.id, {
            headers: { 'x-9r-cli-token': cliToken },
            signal: AbortSignal.timeout(3500)
          });
          if (res.ok) {
            quotaMap[c.id] = await res.json();
          }
        } catch {}
      }));
    }

    function minDate(d1, d2) {
      if (!d1) return d2 || null;
      if (!d2) return d1 || null;
      try {
        return new Date(d1) < new Date(d2) ? d1 : d2;
      } catch {
        return d1;
      }
    }

    // Antigravity (5hr and weekly)
    const agAll = allConns.filter(c => c.provider === 'antigravity');
    const agActive = agAll.filter(c => c.isActive === 1);
    let ag5hSum = 0, agWeeklySum = 0, agCount = 0;
    let ag5hReset = null, agWeeklyReset = null;
    for (const c of agActive) {
      const q = quotaMap[c.id]?.quotas;
      if (!q) continue;
      agCount++;
      const s5 = q.gemini_session?.remainingPercentage ?? q.claude_gpt_session?.remainingPercentage ?? 100;
      const sw = q.gemini_weekly?.remainingPercentage ?? q.claude_gpt_weekly?.remainingPercentage ?? 100;
      ag5hSum += s5;
      agWeeklySum += sw;
      const r5 = q.gemini_session?.resetAt || q.claude_gpt_session?.resetAt;
      const rw = q.gemini_weekly?.resetAt || q.claude_gpt_weekly?.resetAt;
      ag5hReset = minDate(ag5hReset, r5);
      agWeeklyReset = minDate(agWeeklyReset, rw);
    }
    const antigravity = {
      total: agAll.length,
      active: agActive.length,
      limit5h: agCount > 0 ? Math.round(ag5hSum / agCount) : 100,
      limit5hReset: ag5hReset,
      limitWeekly: agCount > 0 ? Math.round(agWeeklySum / agCount) : 100,
      limitWeeklyReset: agWeeklyReset
    };

    // Codebuddy (Monthly, Bonus 1 & 2 combined)
    const cbAll = allConns.filter(c => c.provider.startsWith('codebuddy'));
    const cbActive = cbAll.filter(c => c.isActive === 1);
    let cbMonthlyUsed = 0, cbMonthlyTotal = 0;
    let cbBonusUsed = 0, cbBonusTotal = 0;
    let cbMonthlyReset = null, cbBonusReset = null;
    for (const c of cbActive) {
      const q = quotaMap[c.id]?.quotas;
      if (!q) continue;
      if (q.Monthly) {
        cbMonthlyUsed += (q.Monthly.used || 0);
        cbMonthlyTotal += (q.Monthly.total || 0);
        if (q.Monthly.resetAt) {
          cbMonthlyReset = minDate(cbMonthlyReset, q.Monthly.resetAt);
        }
      }
      for (const [k, v] of Object.entries(q)) {
        if (k.toLowerCase().startsWith('bonus') && v) {
          cbBonusUsed += (v.used || 0);
          cbBonusTotal += (v.total || 0);
          if (v.resetAt) {
            cbBonusReset = minDate(cbBonusReset, v.resetAt);
          }
        }
      }
    }
    const codebuddy = {
      total: cbAll.length,
      active: cbActive.length,
      monthly: {
        used: Math.round(cbMonthlyUsed),
        total: Math.round(cbMonthlyTotal),
        remainingPct: cbMonthlyTotal > 0 ? Math.round(((cbMonthlyTotal - cbMonthlyUsed) / cbMonthlyTotal) * 100) : 100,
        resetAt: cbMonthlyReset
      },
      bonus: {
        used: Math.round(cbBonusUsed),
        total: Math.round(cbBonusTotal),
        remainingPct: cbBonusTotal > 0 ? Math.round(((cbBonusTotal - cbBonusUsed) / cbBonusTotal) * 100) : 100,
        resetAt: cbBonusReset
      }
    };

    // Qoder (1 line)
    const qoderAll = allConns.filter(c => c.provider.startsWith('qoder'));
    const qoderActive = qoderAll.filter(c => c.isActive === 1);
    let qoderUsed = 0, qoderTotal = 0;
    let qoderReset = null;
    for (const c of qoderActive) {
      const q = quotaMap[c.id]?.quotas?.user;
      if (q) {
        qoderUsed += (q.used || 0);
        qoderTotal += (q.total || 0);
        if (q.resetAt) {
          qoderReset = minDate(qoderReset, q.resetAt);
        }
      }
    }
    const qoder = {
      total: qoderAll.length,
      active: qoderActive.length,
      credits: {
        used: qoderUsed,
        total: qoderTotal,
        remainingPct: qoderTotal > 0 ? Math.round(((qoderTotal - qoderUsed) / qoderTotal) * 100) : 100,
        resetAt: qoderReset
      }
    };

    const data = {
      available: true,
      port: 20128,
      today,
      recentRequests,
      quotas: {
        antigravity,
        codebuddy,
        qoder
      }
    };

    const jsonStr = JSON.stringify(data);
    router9Cache = { timestamp: now, payload: jsonStr };
    return jsonStr;
  } catch (e) {
    return JSON.stringify({ available: false, error: e.message });
  }
}

function activeSessionsPayload(prof = DEFAULT_COCKPIT_PROFILE) {
  const now = Date.now();
  const dbPath = prof === 'default'
    ? path.join(HERMES_HOME, 'state.db')
    : (fs.existsSync(path.join(HERMES_HOME, `profiles/${prof}/state.db`))
        ? path.join(HERMES_HOME, `profiles/${prof}/state.db`)
        : path.join(HERMES_HOME, 'state.db'));
  if (!fs.existsSync(dbPath)) {
    return '{"active":[],"leases":[]}';
  }
  try {
    if (!activeDb || activeDbPath !== dbPath) {
      try { activeDb?.close(); } catch {}
      activeDb = new DatabaseSync(dbPath, { readOnly: true });
      activeDbPath = dbPath;
    }
    const rows = activeDb.prepare('SELECT conversation_id, acquired_at FROM session_turn_leases WHERE expires_at > ?').all(now / 1000);
    return JSON.stringify({
      active: rows.map((r) => r.conversation_id).filter(Boolean),
      leases: rows.map((r) => ({
        session_id: r.conversation_id,
        acquired_at: Math.round(Number(r.acquired_at || 0) * 1000)
      })).filter(l => l.session_id && l.acquired_at > 0)
    });
  } catch {
    return '{"active":[],"leases":[]}';
  }
}

function sendStatic(req, res, filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const etag = etagFor(stats);
  const headers = {
    ...baseHeaders(),
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': cacheControlFor(filePath),
    ETag: etag
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const accept = String(req.headers['accept-encoding'] || '');
  let body = filePath;

  if (COMPRESSIBLE_EXTS.has(ext) && stats.size >= 1024) {
    const br = `${filePath}.br`;
    const gz = `${filePath}.gz`;
    if (/\bbr\b/.test(accept) && fs.existsSync(br)) {
      body = br;
      headers['Content-Encoding'] = 'br';
      headers.Vary = 'Accept-Encoding';
    } else if (/\bgzip\b/.test(accept) && fs.existsSync(gz)) {
      body = gz;
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    } else if (/\bgzip\b/.test(accept)) {
      const packed = zlib.gzipSync(fs.readFileSync(filePath), { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      headers['Content-Length'] = packed.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : packed);
      return;
    }
  }

  headers['Content-Length'] = fs.statSync(body).size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(body);
  stream.on('error', () => { try { res.destroy(); } catch {} });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  // A dead client must never take the proxy down with an unhandled EPIPE.
  res.on('error', () => {});
  req.on('error', () => {});

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/') {
    const ua = String(req.headers['user-agent'] || '');
    const m = ua.match(/HermesCockpit\/[\d.]+/);
    if (m) console.log(new Date().toISOString(), 'APP-UA', m[0]);
  }

  if (pathname === '/__crash' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const logDir = path.join(HERMES_HOME, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'app-crash.log'),
          new Date().toISOString() + ' ' + String(req.headers['user-agent'] || '').slice(0, 80) + '\n' + body.slice(0, 40000) + '\n-----\n');
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    return;
  }

  if (pathname === '/api/session-context') {
    let prof = url.searchParams.get('profile') || DEFAULT_COCKPIT_PROFILE;
    if (prof === 'undefined' || prof === 'null' || !prof) {
      prof = DEFAULT_COCKPIT_PROFILE;
    }
    const sid = (url.searchParams.get('session_id') || '').trim();
    
    const resolveDbPaths = () => {
      const paths = [];
      if (prof !== 'default' && fs.existsSync(path.join(HERMES_HOME, `profiles/${prof}/state.db`))) {
        paths.push(path.join(HERMES_HOME, `profiles/${prof}/state.db`));
      }
      if (fs.existsSync(path.join(HERMES_HOME, `profiles/${DEFAULT_COCKPIT_PROFILE}/state.db`))) {
        const p = path.join(HERMES_HOME, `profiles/${DEFAULT_COCKPIT_PROFILE}/state.db`);
        if (!paths.includes(p)) paths.push(p);
      }
      if (fs.existsSync(path.join(HERMES_HOME, 'state.db'))) {
        const p = path.join(HERMES_HOME, 'state.db');
        if (!paths.includes(p)) paths.push(p);
      }
      return paths;
    };

    const dbs = resolveDbPaths();
    if (!dbs.length || !sid) {
      const emptyPayload = JSON.stringify({ used: 0, total: 1048576, pct: 0, model: '' });
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(emptyPayload),
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : emptyPayload);
      return;
    }

    try {
      let row = null;
      for (const p of dbs) {
        try {
          const db = new DatabaseSync(p, { readOnly: true });
          row = db.prepare('SELECT model, model_config FROM sessions WHERE id = ? OR session_key = ?').get(sid, sid);
          db.close();
          if (row) break;
        } catch {}
      }
      let used = 0;
      let model = '';
      if (row) {
        model = row.model || '';
        try {
          const cfg = JSON.parse(row.model_config || '{}');
          used = Number(cfg._usage_anchor?.prompt_tokens || 0);
        } catch {}
      }
      // Calculate context limit based on model family
      let total = 1000000;
      const mLower = model.toLowerCase();
      if (mLower.includes('gemini')) total = 1048576;
      else if (mLower.includes('glm-5') || mLower.includes('glm-4')) total = 1310720;
      else if (mLower.includes('claude') || mLower.includes('sonnet') || mLower.includes('opus')) total = 200000;
      else if (mLower.includes('gpt-4o') || mLower.includes('gpt-4')) total = 128000;
      else if (mLower.includes('qwen')) total = 131072;
      else total = 1000000;

      const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
      const payload = JSON.stringify({ used, total, pct, model });
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : payload);
    } catch (err) {
      const errPayload = JSON.stringify({ used: 0, total: 1048576, pct: 0, error: err.message });
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errPayload),
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : errPayload);
    }
    return;
  }

  if (pathname === '/api/active-sessions') {
    const prof = url.searchParams.get('profile') || DEFAULT_COCKPIT_PROFILE;
    const payload = activeSessionsPayload(prof);
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : payload);
    return;
  }


  // Dynamic Cyberpunk Voice Alert generation: /api/voice/announce?provider=...&model=...&reasoning=...
  if (pathname === '/api/voice/announce') {
    const provider = (url.searchParams.get('provider') || '').trim();
    const model = (url.searchParams.get('model') || '').trim();
    const reasoning = (url.searchParams.get('reasoning') || '').trim();
    
    // Clean text: strip prefixes like '9router-', 'custom:', 'ag/', 'cbai/', 'cf/', 'oc/', 'bt/', 'clv/', 'or/', 'tokenharbor/'
    let cleanProvider = provider
      .replace(/^(custom:|9router-?)/i, '')
      .replace(/[-_]/g, ' ')
      .trim() || 'default provider';

    let cleanModel = model;
    if (cleanModel.includes('/')) {
      cleanModel = cleanModel.split('/').pop();
    }
    // Also remove tag like ':free'
    cleanModel = cleanModel.replace(/:free$/i, '');
    cleanModel = cleanModel.replace(/[-_]/g, ' ').trim() || 'default model';

    // Reasoning level text
    let reasoningText = '';
    if (reasoning && reasoning !== 'none' && reasoning !== 'auto' && reasoning !== '') {
      reasoningText = `, reasoning ${reasoning}`;
    }

    const spokenText = `Processing your request, using ${cleanProvider}, ${cleanModel}${reasoningText}.`;
    
    const hash = crypto.createHash('md5').update(spokenText).digest('hex').slice(0, 12);
    const cacheFile = path.join(DIST_DIR, 'sounds', `ann_${hash}.mp3`);
    
    const sendAudioFile = (file) => {
      try {
        const data = fs.readFileSync(file);
        res.writeHead(200, {
          ...baseHeaders(),
          'Content-Type': 'audio/mpeg',
          'Content-Length': Buffer.byteLength(data),
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { ...baseHeaders(), 'Content-Type': 'text/plain' });
        res.end('Audio read error');
      }
    };

    if (fs.existsSync(cacheFile)) {
      sendAudioFile(cacheFile);
      return;
    }

    // Generate with python script
    execFile('python3', [path.join(__dirname, 'scripts', 'gen_tts_endpoint.py'), spokenText, cacheFile], (err) => {
      if (err || !fs.existsSync(cacheFile)) {
        console.error('Failed to generate dynamic voice:', err);
        // Fallback to static processing.mp3
        const fallback = path.join(DIST_DIR, 'sounds', 'processing.mp3');
        sendAudioFile(fallback);
      } else {
        sendAudioFile(cacheFile);
      }
    });
    return;
  }

  if (pathname === '/api/9router/telemetry') {
    get9RouterTelemetryPayload().then(payload => {
      res.writeHead(200, {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : payload);
    }).catch(err => {
      const errPayload = JSON.stringify({ available: false, error: err.message });
      res.writeHead(500, {
        ...baseHeaders(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errPayload),
        'Cache-Control': 'no-store'
      });
      res.end(errPayload);
    });
    return;
  }

  // Reverse proxy API & Auth calls directly to Hermes backend on 9119
  if (pathname.startsWith('/api') || pathname.startsWith('/auth') || pathname === '/login') {
    const proxyHeaders = { ...req.headers };
    proxyHeaders.host = `${BACKEND_HOST}:${BACKEND_PORT}`;


    // Auto-scope API calls from Cockpit to hermes-cockpit profile if not explicitly set
    let targetPath = req.url;
    const profileAppended = pathname.startsWith('/api') && !url.searchParams.has('profile');
    if (profileAppended) {
      const sep = targetPath.includes('?') ? '&' : '?';
      targetPath = `${targetPath}${sep}profile=${DEFAULT_COCKPIT_PROFILE}`;
    }

    // PATCH /api/sessions/{id} (rename) baca profile dari BODY, bukan query — jadi
    // auto-scope di atas nggak kepakai dan backend balas 404 not_found. Sisipkan juga
    // ke body biar rename (dan flag sidebar lain) jalan dari Cockpit.
    const needsBodyProfile = profileAppended && req.method === 'PATCH' && /^\/api\/sessions\/[^/]+\/?$/.test(pathname);

    const onProxyResponse = (proxyRes) => {
      proxyRes.on('error', () => { try { res.destroy(); } catch {} });
      const status = proxyRes.statusCode || 200;
      const ctype = String(proxyRes.headers['content-type'] || '');
      const enc = pickEncoding(req.headers['accept-encoding']);
      // Backend (uvicorn) tidak kompres apa pun: /api/sessions/…/messages bisa 800 KB+
      // JSON mentah. Kompres di sini — hemat ~10x di wire, CPU cuma sekali per request.
      const compressible = !!enc
        && !proxyRes.headers['content-encoding']
        && status !== 204 && status !== 304
        && req.method !== 'HEAD'
        && !/event-stream/i.test(ctype)
        && (ctype === '' || /(json|javascript|text|xml|svg|graphql)/i.test(ctype));

      if (!compressible) {
        res.writeHead(status, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      const headers = { ...proxyRes.headers };
      delete headers['content-length'];
      headers['content-encoding'] = enc;
      headers['vary'] = headers['vary'] ? `${headers['vary']}, Accept-Encoding` : 'Accept-Encoding';
      res.writeHead(status, headers);
      const zip = enc === 'br'
        ? zlib.createBrotliCompress({
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
              [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT
            }
          })
        : zlib.createGzip({ level: 6 });
      zip.on('error', () => { try { res.destroy(); } catch {} });
      proxyRes.pipe(zip).pipe(res);
    };

    // Request dibuat di dalam fungsi supaya body (yang mungkin disisipi profile)
    // sudah final sebelum header content-length dikirim.
    const startProxy = (headers, bodyBuf) => {
      const proxyReq = http.request({
        host: BACKEND_HOST,
        port: BACKEND_PORT,
        path: targetPath,
        method: req.method,
        headers
      }, onProxyResponse);

      proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backend unreachable', details: err.message }));
      } else {
        try { res.destroy(); } catch {}
      }
    });
      proxyReq.setTimeout(120000, () => {
        console.error('Proxy timeout:', targetPath);
        proxyReq.destroy(new Error('backend timeout'));
      });

      req.on('aborted', () => { try { proxyReq.destroy(); } catch {} });

      if (bodyBuf) proxyReq.end(bodyBuf);
      else req.pipe(proxyReq);
    };

    if (needsBodyProfile) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed && typeof parsed === 'object' && !parsed.profile) {
            parsed.profile = DEFAULT_COCKPIT_PROFILE;
            body = JSON.stringify(parsed);
          }
        } catch { /* body bukan JSON: kirim apa adanya */ }
        const buf = Buffer.from(body, 'utf8');
        startProxy({ ...proxyHeaders, 'content-length': String(buf.length) }, buf);
      });
      return;
    }

    startProxy(proxyHeaders, null);
    return;
  }

  const filePath = path.join(DIST_DIR, pathname);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403, baseHeaders());
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    sendStatic(req, res, filePath);
    return;
  }

  // SPA fallback
  sendStatic(req, res, path.join(DIST_DIR, 'index.html'));
});

// Proxy WebSocket upgrade for /api/ws
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {
    try { socket.destroy(); } catch {}
  });

  let wsUrl = req.url;
  if (!wsUrl.includes('profile=')) {
    const sep = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${sep}profile=${DEFAULT_COCKPIT_PROFILE}`;
  }

  const proxySocket = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const headers = [`${req.method} ${wsUrl} HTTP/${req.httpVersion}`];
    for (const [key, val] of Object.entries(req.headers)) {
      if (Array.isArray(val)) {
        for (const v of val) headers.push(`${key}: ${v}`);
      } else if (val !== undefined) {
        if (key.toLowerCase() === 'host') {
          headers.push(`Host: ${BACKEND_HOST}:${BACKEND_PORT}`);
        } else if (key.toLowerCase() === 'origin') {
          headers.push(`Origin: http://${BACKEND_HOST}:${BACKEND_PORT}`);
        } else {
          headers.push(`${key}: ${val}`);
        }
      }
    }
    proxySocket.write(headers.join('\r\n') + '\r\n\r\n');
    if (head && head.length > 0) proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });

  proxySocket.on('error', (err) => {
    console.error('WS Proxy socket error:', err.message);
    try { socket.destroy(); } catch {}
  });
  proxySocket.setTimeout(0);
  socket.setNoDelay(true);
  proxySocket.setNoDelay(true);
});

server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch {}
});

// A stray socket error must never take the whole cockpit offline.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (kept alive):', err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (kept alive):', err?.message || err);
});

server.listen(PORT, HOST, () => {
  console.log(`Hermes Mobile Cockpit running at http://${HOST}:${PORT}`);
});
