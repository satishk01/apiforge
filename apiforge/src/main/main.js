const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const STORE_DIR = path.join(app.getPath('userData'), 'apiforge-data');
const STORE_FILE = path.join(STORE_DIR, 'store.json');

function ensureStore() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ collections: [], history: [], environments: [], activeEnv: null }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return { collections: [], history: [], environments: [], activeEnv: null }; }
}

function writeStore(data) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'APIForge',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools();
}

// ---- HTTP request engine ----
function doRequest({ method, url, headers, body, timeout = 30000 }) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { return resolve({ error: 'Invalid URL: ' + e.message }); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      method: method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: headers || {},
      timeout
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        const time = Date.now() - startTime;
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          body: buf.toString('utf8'),
          size: buf.length,
          time
        });
      });
      stream.on('error', (e) => resolve({ error: e.message }));
    });

    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timed out' }); });
    req.on('error', (e) => resolve({ error: e.message }));
    if (body && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

// ============ PERFORMANCE / LOAD TEST ENGINE ============
const perfRuns = new Map(); // runId -> { cancelled }

// Virtual-user count at a given time, matching Postman's load-profile phases.
// baseLoad applies to spike/peak; initialLoad applies to rampup.
function vuCountAt(elapsedMs, totalMs, vus, profile, opts = {}) {
  const t = Math.min(1, elapsedMs / totalMs);
  const base = Math.max(1, Math.min(vus, opts.baseLoad || Math.max(1, Math.round(vus * 0.2))));
  const initial = Math.max(1, Math.min(vus, opts.initialLoad || Math.max(1, Math.round(vus * 0.25))));
  const lerp = (a, b, f) => Math.round(a + (b - a) * f);
  switch (profile) {
    case 'rampup': {
      // initial for 25%, ramp initial->max over 25%, hold max for 50%
      if (t < 0.25) return initial;
      if (t < 0.50) return lerp(initial, vus, (t - 0.25) / 0.25);
      return vus;
    }
    case 'spike': {
      // base for 40%, spike base->max over 10%, drop max->base over 10%, hold base 40%
      if (t < 0.40) return base;
      if (t < 0.50) return lerp(base, vus, (t - 0.40) / 0.10);
      if (t < 0.60) return lerp(vus, base, (t - 0.50) / 0.10);
      return base;
    }
    case 'peak': {
      // base 20%, ramp base->max 20%, hold max 20%, ramp max->base 20%, hold base 20%
      if (t < 0.20) return base;
      if (t < 0.40) return lerp(base, vus, (t - 0.20) / 0.20);
      if (t < 0.60) return vus;
      if (t < 0.80) return lerp(vus, base, (t - 0.60) / 0.20);
      return base;
    }
    case 'fixed':
    default: return vus;
  }
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(sortedArr.length - 1, idx))];
}

function classifyError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('timed out') || m.includes('timeout')) return 'Timeout';
  if (m.includes('econnrefused') || m.includes('connect')) return 'Connection refused';
  if (m.includes('enotfound') || m.includes('getaddrinfo')) return 'DNS / host not found';
  if (m.includes('tls') || m.includes('ssl') || m.includes('certificate')) return 'TLS / certificate';
  if (m.includes('socket hang up') || m.includes('econnreset')) return 'Connection reset';
  return 'Other error';
}

async function runPerfTest(event, cfg) {
  const { runId, requests, vus, durationSec, profile } = cfg;
  const perfOpts = { baseLoad: cfg.baseLoad, initialLoad: cfg.initialLoad };
  const dataRows = Array.isArray(cfg.dataRows) ? cfg.dataRows : [];
  const dataMapping = cfg.dataMapping || 'ordered'; // 'ordered' | 'randomized'
  const totalMs = durationSec * 1000;
  const state = { cancelled: false };
  perfRuns.set(runId, state);

  const startedAt = Date.now();
  const perReq = {};
  requests.forEach(r => { perReq[r.id] = { name: r.name, method: r.method, url: r.url, count: 0, errors: 0, times: [], statusCounts: {}, errorResponses: {} }; });
  const allTimes = [];
  let totalRequests = 0, totalErrors = 0;
  const errorSamples = [];
  const timeline = [];
  // per-second buckets per request, for request-filtered graphs
  const reqTimeline = {}; // reqId -> [{t, rps, avg, errRate, count, errors, times:[]}]
  requests.forEach(r => { reqTimeline[r.id] = []; });
  const secBuckets = {}; // current-second accumulation: reqId -> {count, errors, times[]}
  requests.forEach(r => { secBuckets[r.id] = { count: 0, errors: 0, times: [] }; });

  const vcur = { active: vuCountAt(0, totalMs, vus, profile, perfOpts) };
  const getActive = () => vcur.active;

  // Resolve {{var}} placeholders against a data row for a given VU.
  function applyData(str, row) {
    if (!str || !row) return str;
    return String(str).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k) => (k in row ? row[k] : m));
  }
  function rowForVU(vuIndex) {
    if (!dataRows.length) return null;
    if (dataMapping === 'randomized') return dataRows[Math.floor(Math.random() * dataRows.length)];
    return dataRows[vuIndex % dataRows.length];
  }
  function resolveReq(rq, row) {
    if (!row) return rq;
    const headers = {};
    Object.entries(rq.headers || {}).forEach(([k, v]) => { headers[applyData(k, row)] = applyData(v, row); });
    return { method: rq.method, url: applyData(rq.url, row), headers, body: applyData(rq.body, row) };
  }

  async function virtualUser(vuIndex) {
    const row = rowForVU(vuIndex);
    // Warm-up: only the first VU sends one uncounted request per endpoint to
    // absorb cold-start costs (DNS, TCP, TLS handshake) that would otherwise
    // show up as a huge one-off max and skew the report.
    if (vuIndex === 0 && !cfg.skipWarmup) {
      for (const rq of requests) {
        if (state.cancelled) break;
        const rr = resolveReq(rq, row);
        await doRequest({ method: rr.method, url: rr.url, headers: rr.headers, body: rr.body, timeout: 30000 });
      }
    }
    while (!state.cancelled && (Date.now() - startedAt) < totalMs) {
      if (vuIndex >= getActive()) { await new Promise(r => setTimeout(r, 100)); continue; }
      for (const rq of requests) {
        if (state.cancelled || (Date.now() - startedAt) >= totalMs) break;
        const rr = resolveReq(rq, row);
        const res = await doRequest({ method: rr.method, url: rr.url, headers: rr.headers, body: rr.body, timeout: 30000 });
        const agg = perReq[rq.id];
        const bucket = secBuckets[rq.id];
        totalRequests++; agg.count++; bucket.count++;
        if (res.error) {
          totalErrors++; agg.errors++; bucket.errors++;
          const ek = 'Error: ' + res.error;
          agg.errorResponses[ek] = (agg.errorResponses[ek] || 0) + 1;
          if (errorSamples.length < 500) errorSamples.push({ request: rq.name, error: res.error, errorClass: classifyError(res.error), at: Date.now() - startedAt });
        } else {
          const sc = res.status;
          agg.statusCounts[sc] = (agg.statusCounts[sc] || 0) + 1;
          if (sc < 200 || sc >= 300) {
            totalErrors++; agg.errors++; bucket.errors++;
            const ek = 'HTTP ' + sc;
            agg.errorResponses[ek] = (agg.errorResponses[ek] || 0) + 1;
            if (errorSamples.length < 500) errorSamples.push({ request: rq.name, error: 'HTTP ' + sc, errorClass: 'HTTP ' + sc, at: Date.now() - startedAt, bodySample: (res.body || '').slice(0, 200) });
          }
          agg.times.push(res.time); allTimes.push(res.time); bucket.times.push(res.time);
        }
      }
    }
  }

  let lastTotal = 0, lastTime = startedAt;
  const tickInterval = setInterval(() => {
    if (state.cancelled) return;
    const now = Date.now();
    const elapsed = now - startedAt;
    vcur.active = vuCountAt(elapsed, totalMs, vus, profile, perfOpts);
    const dt = (now - lastTime) / 1000 || 1;
    const rps = (totalRequests - lastTotal) / dt;
    lastTotal = totalRequests; lastTime = now;
    const recent = allTimes.slice(-200);
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    const errRate = totalRequests ? (totalErrors / totalRequests) * 100 : 0;
    const tsec = Math.round(elapsed / 1000);
    // flush per-request second buckets
    const perReqSnap = {};
    requests.forEach(r => {
      const b = secBuckets[r.id];
      const s = [...b.times].sort((x, y) => x - y);
      const point = {
        t: tsec, rps: +(b.count / dt).toFixed(1),
        avg: s.length ? +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(0) : 0,
        min: s.length ? s[0] : 0, max: s.length ? s[s.length - 1] : 0,
        p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99),
        errRate: b.count ? +((b.errors / b.count) * 100).toFixed(1) : 0
      };
      reqTimeline[r.id].push(point);
      perReqSnap[r.id] = point;
      secBuckets[r.id] = { count: 0, errors: 0, times: [] };
    });
    const sortedRecent = [...recent].sort((a, b) => a - b);
    const snap = {
      t: tsec, clock: now, vus: vcur.active, rps: +rps.toFixed(1), avg: +avg.toFixed(0),
      min: sortedRecent.length ? sortedRecent[0] : 0, max: sortedRecent.length ? sortedRecent[sortedRecent.length - 1] : 0,
      p90: percentile(sortedRecent, 90), p95: percentile(sortedRecent, 95), p99: percentile(sortedRecent, 99),
      errRate: +errRate.toFixed(1), failRate: 0, totalRequests
    };
    timeline.push(snap);
    try { event.sender.send('perf:tick', { runId, snap, perReqSnap }); } catch (e) {}
  }, 1000);

  const workers = [];
  for (let i = 0; i < vus; i++) workers.push(virtualUser(i));
  await Promise.all(workers);
  clearInterval(tickInterval);

  const sortedAll = [...allTimes].sort((a, b) => a - b);
  const finishedAt = Date.now();
  const wallSec = (finishedAt - startedAt) / 1000;
  const summary = {
    totalRequests, totalErrors, totalFailures: 0,
    errorRate: totalRequests ? +((totalErrors / totalRequests) * 100).toFixed(2) : 0,
    failureRate: 0,
    rps: +(totalRequests / wallSec).toFixed(2),
    avg: sortedAll.length ? +(sortedAll.reduce((a, b) => a + b, 0) / sortedAll.length).toFixed(0) : 0,
    min: sortedAll.length ? sortedAll[0] : 0,
    max: sortedAll.length ? sortedAll[sortedAll.length - 1] : 0,
    p90: percentile(sortedAll, 90), p95: percentile(sortedAll, 95), p99: percentile(sortedAll, 99),
    wallSec: +wallSec.toFixed(1)
  };
  const perRequest = Object.entries(perReq).map(([id, a]) => {
    const s = [...a.times].sort((x, y) => x - y);
    return {
      id, name: a.name, method: a.method, url: a.url,
      count: a.count, errors: a.errors, failures: 0,
      errorRate: a.count ? +((a.errors / a.count) * 100).toFixed(2) : 0,
      failureRate: 0,
      avg: s.length ? +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(0) : 0,
      min: s.length ? s[0] : 0, max: s.length ? s[s.length - 1] : 0,
      p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99),
      statusCounts: a.statusCounts,
      errorResponses: a.errorResponses
    };
  });
  // group errors by class for the Errors tab (Postman-style)
  const errorClasses = {};
  errorSamples.forEach(e => {
    const cls = e.errorClass || 'Other error';
    if (!errorClasses[cls]) errorClasses[cls] = { count: 0, byRequest: {} };
    errorClasses[cls].count++;
    errorClasses[cls].byRequest[e.request] = (errorClasses[cls].byRequest[e.request] || 0) + 1;
  });
  perfRuns.delete(runId);
  return { runId, startedAt, finishedAt, config: { vus, durationSec, profile, baseLoad: cfg.baseLoad, initialLoad: cfg.initialLoad, dataRows: dataRows.length }, summary, perRequest, timeline, reqTimeline, errorSamples, errorClasses };
}

ipcMain.handle('perf:run', async (event, cfg) => runPerfTest(event, cfg));
ipcMain.handle('perf:cancel', async (_e, runId) => { const s = perfRuns.get(runId); if (s) s.cancelled = true; return true; });

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('http:send', async (_e, payload) => doRequest(payload));
ipcMain.handle('store:read', async () => readStore());
ipcMain.handle('store:write', async (_e, data) => { writeStore(data); return true; });

// ---- Baseline / regression file handlers ----
ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose baselines folder' });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('baseline:write', async (_e, { dir, fileName, data }) => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, fileName);
    fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: full };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('baseline:read', async (_e, { dir, fileName }) => {
  try {
    const full = path.join(dir, fileName);
    if (!fs.existsSync(full)) return { ok: false, error: 'No baseline saved yet' };
    return { ok: true, data: JSON.parse(fs.readFileSync(full, 'utf8')) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('baseline:exists', async (_e, { dir, fileName }) => {
  try { return fs.existsSync(path.join(dir, fileName)); } catch { return false; }
});

// ---- PDF report generation (uses Electron's built-in printToPDF, no extra deps) ----
ipcMain.handle('report:savePdf', async (_e, { html, suggestedName }) => {
  // render the report HTML in a hidden window, print to PDF, then ask where to save
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // give layout/fonts a moment
    await new Promise(r => setTimeout(r, 300));
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    });
    const res = await dialog.showSaveDialog({
      title: 'Save Test Report',
      defaultPath: suggestedName || 'api-test-report.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, pdfBuffer);
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    pdfWin.destroy();
  }
});
