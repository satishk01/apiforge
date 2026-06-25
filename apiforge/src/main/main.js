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
