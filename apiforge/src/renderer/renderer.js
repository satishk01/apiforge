// ============ APIForge Renderer ============
let store = { collections: [], history: [], environments: [], activeEnv: null, baselinesDir: null };
let tabs = [];
let activeTabId = null;
let tabSeq = 1;

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- In-app dialogs (Electron blocks native prompt/confirm) ----------
function dialogPrompt(title, defaultValue = '', label = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('dialogModal');
    document.getElementById('dialogTitle').textContent = title;
    const content = document.getElementById('dialogContent');
    content.innerHTML = label ? `<label class="dialog-label">${label}</label>` : '';
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'dialog-input'; inp.value = defaultValue;
    content.appendChild(inp);
    const ok = document.getElementById('dialogOk'); const cancel = document.getElementById('dialogCancel'); const close = document.getElementById('dialogClose');
    document.getElementById('dialogCancel').textContent = 'Cancel'; ok.textContent = 'OK'; ok.style.display = '';
    const done = (val) => { modal.classList.add('hidden'); cleanup(); resolve(val); };
    const onOk = () => done(inp.value);
    const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    function cleanup() { ok.onclick = null; cancel.onclick = null; close.onclick = null; inp.onkeydown = null; }
    ok.onclick = onOk; cancel.onclick = onCancel; close.onclick = onCancel; inp.onkeydown = onKey;
    modal.classList.remove('hidden'); inp.focus(); inp.select();
  });
}
function dialogSelect(title, options, label = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('dialogModal');
    document.getElementById('dialogTitle').textContent = title;
    const content = document.getElementById('dialogContent');
    content.innerHTML = label ? `<label class="dialog-label">${label}</label>` : '';
    const sel = document.createElement('select'); sel.className = 'dialog-input';
    options.forEach(o => { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; sel.appendChild(opt); });
    content.appendChild(sel);
    const ok = document.getElementById('dialogOk'); const cancel = document.getElementById('dialogCancel'); const close = document.getElementById('dialogClose');
    document.getElementById('dialogCancel').textContent = 'Cancel'; ok.textContent = 'OK'; ok.style.display = '';
    const done = (val) => { modal.classList.add('hidden'); cleanup(); resolve(val); };
    function cleanup() { ok.onclick = null; cancel.onclick = null; close.onclick = null; }
    ok.onclick = () => done(sel.value); cancel.onclick = () => done(null); close.onclick = () => done(null);
    modal.classList.remove('hidden'); sel.focus();
  });
}
function dialogConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('dialogModal');
    document.getElementById('dialogTitle').textContent = title;
    document.getElementById('dialogContent').innerHTML = `<div class="dialog-message">${message}</div>`;
    const ok = document.getElementById('dialogOk'); const cancel = document.getElementById('dialogCancel'); const close = document.getElementById('dialogClose');
    document.getElementById('dialogCancel').textContent = 'Cancel'; ok.textContent = 'Yes'; ok.style.display = '';
    const done = (val) => { modal.classList.add('hidden'); cleanup(); resolve(val); };
    function cleanup() { ok.onclick = null; cancel.onclick = null; close.onclick = null; }
    ok.onclick = () => done(true); cancel.onclick = () => done(false); close.onclick = () => done(false);
    modal.classList.remove('hidden');
  });
}

async function loadStore() {
  store = await window.api.readStore();
  if (!store.collections) store.collections = [];
  if (!store.history) store.history = [];
  if (!store.environments) store.environments = [];
}
async function persist() { await window.api.writeStore(store); }

// ---------- Variable substitution ----------
function activeEnvVars() {
  const env = store.environments.find(e => e.id === store.activeEnv);
  if (!env) return {};
  const map = {};
  (env.vars || []).forEach(v => { if (v.enabled !== false && v.key) map[v.key] = v.value; });
  return map;
}
function substitute(str) {
  if (!str) return str;
  const vars = activeEnvVars();
  return str.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ---------- Tab model ----------
function blankRequest() {
  return {
    name: 'Untitled Request', method: 'GET', url: '',
    params: [{ key: '', value: '', enabled: true }],
    headers: [{ key: '', value: '', enabled: true }],
    bodyType: 'none', body: '',
    auth: { type: 'none', token: '', username: '', password: '', key: '', value: '' },
    response: null, savedTo: null,
    // regression test config
    test: { hasBaseline: false, ignoreFields: '', compareStatus: true, compareBody: true }
  };
}
function newTab(req) {
  const t = { id: tabSeq++, req: req || blankRequest(), activeReqTab: 'params', activeRespTab: 'body' };
  tabs.push(t); activeTabId = t.id; render();
}
function activeTab() { return tabs.find(t => t.id === activeTabId); }
function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (activeTabId === id) activeTabId = tabs.length ? tabs[Math.max(0, i - 1)].id : null;
  if (!tabs.length) newTab(); else render();
}

// ---------- Build & send ----------
function buildUrl(req) {
  let url = substitute(req.url.trim());
  const enabled = req.params.filter(p => p.enabled && p.key);
  if (enabled.length) {
    const qs = enabled.map(p => `${encodeURIComponent(substitute(p.key))}=${encodeURIComponent(substitute(p.value))}`).join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}
function buildHeaders(req) {
  const h = {};
  req.headers.filter(x => x.enabled && x.key).forEach(x => { h[substitute(x.key)] = substitute(x.value); });
  const a = req.auth;
  if (a.type === 'bearer' && a.token) h['Authorization'] = 'Bearer ' + substitute(a.token);
  else if (a.type === 'basic') h['Authorization'] = 'Basic ' + btoa(substitute(a.username) + ':' + substitute(a.password));
  else if (a.type === 'apikey' && a.key) h[substitute(a.key)] = substitute(a.value);
  if (req.bodyType === 'json' && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
  if (req.bodyType === 'form' && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/x-www-form-urlencoded';
  return h;
}
function buildBody(req) {
  if (req.bodyType === 'none' || req.method === 'GET' || req.method === 'HEAD') return null;
  if (req.bodyType === 'json' || req.bodyType === 'raw') return substitute(req.body);
  if (req.bodyType === 'form') {
    try { const o = JSON.parse(req.body || '{}'); return Object.entries(o).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
    catch { return substitute(req.body); }
  }
  return null;
}

async function sendRequest() {
  const t = activeTab(); if (!t) return;
  const req = t.req;
  if (!req.url.trim()) return;
  req.response = { loading: true };
  render();
  const payload = { method: req.method, url: buildUrl(req), headers: buildHeaders(req), body: buildBody(req) };
  const res = await window.api.send(payload);
  req.response = res;
  // history
  store.history.unshift({ id: uid(), method: req.method, url: payload.url, status: res.status, at: Date.now(),
    snapshot: JSON.parse(JSON.stringify({ ...req, response: null })) });
  store.history = store.history.slice(0, 100);
  await persist();
  render();
}

// ---------- JSON highlight ----------
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
function highlightJson(obj) {
  const json = escapeHtml(JSON.stringify(obj, null, 2));
  return json.replace(/("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, m => {
    let cls = 'json-num';
    if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-str';
    else if (/true|false/.test(m)) cls = 'json-bool';
    else if (/null/.test(m)) cls = 'json-null';
    return `<span class="${cls}">${m}</span>`;
  });
}
function formatResponseBody(res) {
  const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '';
  if (ct.includes('json') || /^\s*[\[{]/.test(res.body)) {
    try { return highlightJson(JSON.parse(res.body)); } catch { /* fall */ }
  }
  return escapeHtml(res.body || '');
}

// ============ REGRESSION TEST ENGINE ============
// Parse "user.id, *.createdAt, items[*].token" style ignore patterns.
function parseIgnoreList(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}
// Does a dot-path match an ignore pattern? Supports * as a wildcard segment.
function pathMatches(path, pattern) {
  const pp = pattern.replace(/\[\*\]/g, '.*').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  const ap = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (pp.length !== ap.length) {
    // allow trailing wildcard like "*.createdAt" to match any depth ending in createdAt
    if (pp[0] === '*' && pp.length === 2) return ap[ap.length - 1] === pp[1];
    return false;
  }
  return pp.every((seg, i) => seg === '*' || seg === ap[i]);
}
function isIgnored(path, patterns) {
  return patterns.some(p => pathMatches(path, p));
}

// Deep-compare two JSON values, collecting field-level differences. Ignored paths skipped.
function deepDiff(expected, actual, patterns, path = '', diffs = []) {
  if (isIgnored(path, patterns)) return diffs;
  const te = typeof expected, ta = typeof actual;
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      diffs.push({ path: path || '(root)', type: 'type', expected, actual }); return diffs;
    }
    if (expected.length !== actual.length) {
      diffs.push({ path: (path || '(root)') + '.length', type: 'length', expected: expected.length, actual: actual.length });
    }
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i++) deepDiff(expected[i], actual[i], patterns, `${path}[${i}]`, diffs);
    return diffs;
  }
  if (isObj(expected) || isObj(actual)) {
    if (!isObj(expected) || !isObj(actual)) {
      diffs.push({ path: path || '(root)', type: 'type', expected, actual }); return diffs;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      const child = path ? `${path}.${k}` : k;
      if (isIgnored(child, patterns)) continue;
      if (!(k in expected)) { diffs.push({ path: child, type: 'added', actual: actual[k] }); continue; }
      if (!(k in actual)) { diffs.push({ path: child, type: 'missing', expected: expected[k] }); continue; }
      deepDiff(expected[k], actual[k], patterns, child, diffs);
    }
    return diffs;
  }
  // primitives
  if (expected !== actual) diffs.push({ path: path || '(root)', type: 'value', expected, actual });
  return diffs;
}

function tryParseJson(str) { try { return { ok: true, value: JSON.parse(str) }; } catch { return { ok: false }; } }

// Compare a live response against a saved baseline. Returns { pass, reasons[], diffs[] }
function compareToBaseline(baseline, live, cfg) {
  const reasons = [];
  let diffs = [];
  const patterns = parseIgnoreList(cfg.ignoreFields);

  if (live.error) return { pass: false, reasons: ['Request failed: ' + live.error], diffs: [] };

  if (cfg.compareStatus !== false) {
    if (baseline.status !== live.status) reasons.push(`Status ${baseline.status} → ${live.status}`);
  }
  if (cfg.compareBody !== false) {
    const eb = tryParseJson(baseline.body), ab = tryParseJson(live.body);
    if (eb.ok && ab.ok) {
      diffs = deepDiff(eb.value, ab.value, patterns);
      if (diffs.length) reasons.push(`${diffs.length} field difference${diffs.length > 1 ? 's' : ''}`);
    } else {
      // non-JSON: plain string compare
      if ((baseline.body || '') !== (live.body || '')) reasons.push('Response body differs (non-JSON)');
    }
  }
  return { pass: reasons.length === 0, reasons, diffs };
}

// Build a baseline filename for a saved request.
function baselineFileName(savedId) { return `baseline_${savedId}.json`; }

// Save current response as baseline for a saved request.
async function saveBaseline(req) {
  if (!store.baselinesDir) { await ensureBaselinesDir(); if (!store.baselinesDir) return; }
  if (!req.savedTo) { await dialogConfirm('Save Request First', 'Save this request to a collection before setting a baseline.'); return; }
  if (!req.response || req.response.error || req.response.loading) { await dialogConfirm('No Response', 'Send the request successfully first, then save its response as the baseline.'); return; }
  const data = { status: req.response.status, statusText: req.response.statusText, headers: req.response.headers, body: req.response.body, savedAt: Date.now() };
  const res = await window.api.baselineWrite({ dir: store.baselinesDir, fileName: baselineFileName(req.savedTo), data });
  if (!res.ok) { await dialogConfirm('Error', 'Could not save baseline: ' + res.error); return; }
  req.test = req.test || {}; req.test.hasBaseline = true;
  // also persist flag onto the saved collection copy
  syncTestConfigToCollection(req);
  await persist(); render();
}

// Run a regression test for a single saved request (sends + compares). Returns result object.
async function runTest(reqSnapshot) {
  const cfg = reqSnapshot.test || {};
  const bl = await window.api.baselineRead({ dir: store.baselinesDir, fileName: baselineFileName(reqSnapshot.savedTo || reqSnapshot.id) });
  if (!bl.ok) return { name: reqSnapshot.name, status: 'no-baseline', reasons: [bl.error], diffs: [] };
  const payload = { method: reqSnapshot.method, url: buildUrl(reqSnapshot), headers: buildHeaders(reqSnapshot), body: buildBody(reqSnapshot) };
  const live = await window.api.send(payload);
  const cmp = compareToBaseline(bl.data, live, cfg);
  return { name: reqSnapshot.name, status: cmp.pass ? 'pass' : 'fail', reasons: cmp.reasons, diffs: cmp.diffs, live, baseline: bl.data };
}

async function ensureBaselinesDir() {
  if (store.baselinesDir) return store.baselinesDir;
  await dialogConfirm('Choose Baselines Folder', 'Pick a folder where expected responses will be stored. You only do this once.');
  const dir = await window.api.pickFolder();
  if (dir) { store.baselinesDir = dir; await persist(); }
  return store.baselinesDir;
}

// keep test config + savedTo mirrored into the stored collection request
function syncTestConfigToCollection(req) {
  if (!req.savedTo) return;
  for (const col of store.collections) {
    const idx = col.requests.findIndex(r => r.id === req.savedTo);
    if (idx >= 0) {
      col.requests[idx].test = JSON.parse(JSON.stringify(req.test || {}));
      return;
    }
  }
}

let lastSuiteRun = null; // { collectionName, startedAt, results, env }

// Run every baseline-backed request in a collection, sequentially. The regression sweep.
async function runCollectionTests(col) {
  const targets = (col.requests || []).filter(r => r.test && r.test.hasBaseline);
  if (!targets.length) { await dialogConfirm('No Tests', 'No requests in this collection have a saved baseline yet.'); return; }
  openSuiteModal(col.name, targets.length);
  const startedAt = Date.now();
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    updateSuiteProgress(i, targets.length, targets[i].name);
    const snap = JSON.parse(JSON.stringify(targets[i]));
    snap.savedTo = targets[i].id;
    const t0 = Date.now();
    const res = await runTest(snap);
    res.durationMs = Date.now() - t0;
    res.method = targets[i].method;
    res.url = buildUrl(snap);
    res.ignoreFields = (targets[i].test && targets[i].test.ignoreFields) || '';
    results.push(res);
    renderSuiteResults(results, targets.length);
  }
  const envName = (store.environments.find(e => e.id === store.activeEnv) || {}).name || 'None';
  lastSuiteRun = { collectionName: col.name, startedAt, finishedAt: Date.now(), results, env: envName };
  finalizeSuite(results);
}


function resolvedRequest(req) {
  return { method: req.method, url: buildUrl(req), headers: buildHeaders(req), body: buildBody(req), bodyType: req.bodyType };
}
function hdrEntries(r) { return Object.entries(r.headers); }
function jsonBodyLiteral(r) {
  if (r.body == null) return null;
  if (r.bodyType === 'json') { try { return JSON.stringify(JSON.parse(r.body), null, 2); } catch { return r.body; } }
  return null;
}
function pyStr(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
function shStr(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// ---- cURL ----
function genCurl(req) {
  const r = resolvedRequest(req);
  let out = `curl --location --request ${r.method} ${shStr(r.url)}`;
  hdrEntries(r).forEach(([k, v]) => { out += ` \\\n  --header ${shStr(k + ': ' + v)}`; });
  if (r.body != null) out += ` \\\n  --data ${shStr(r.body)}`;
  return out + '\n';
}

// ---- Node.js: native fetch ----
function genNodeFetch(req) {
  const r = resolvedRequest(req);
  const headers = JSON.stringify(r.headers, null, 2).replace(/\n/g, '\n  ');
  let bodyLine = '', optsBody = '';
  if (r.body != null) {
    if (r.bodyType === 'json') { bodyLine = `const body = ${jsonBodyLiteral(r) || '{}'};\n\n`; optsBody = '\n  body: JSON.stringify(body),'; }
    else { bodyLine = `const body = ${JSON.stringify(r.body)};\n\n`; optsBody = '\n  body,'; }
  }
  return `// Node.js — native fetch (Node 18+)
${bodyLine}const options = {
  method: ${JSON.stringify(r.method)},
  headers: ${headers},${optsBody}
};

const res = await fetch(${JSON.stringify(r.url)}, options);
console.log('Status:', res.status);
console.log(await res.text());
`;
}

// ---- Node.js: Axios ----
function genNodeAxios(req) {
  const r = resolvedRequest(req);
  const headers = JSON.stringify(r.headers, null, 2).replace(/\n/g, '\n  ');
  let dataLine = '';
  if (r.body != null) dataLine = r.bodyType === 'json' ? `\n  data: ${jsonBodyLiteral(r) || '{}'},` : `\n  data: ${JSON.stringify(r.body)},`;
  return `// Node.js — Axios   (npm install axios)
import axios from 'axios';

const config = {
  method: ${JSON.stringify(r.method.toLowerCase())},
  url: ${JSON.stringify(r.url)},
  headers: ${headers},${dataLine}
};

const res = await axios(config);
console.log('Status:', res.status);
console.log(res.data);
`;
}

// ---- TypeScript: fetch ----
function genTsFetch(req) {
  const r = resolvedRequest(req);
  const headers = JSON.stringify(r.headers, null, 2).replace(/\n/g, '\n  ');
  let bodyLine = '', optsBody = '';
  if (r.body != null) {
    if (r.bodyType === 'json') { bodyLine = `const body = ${jsonBodyLiteral(r) || '{}'};\n\n`; optsBody = '\n  body: JSON.stringify(body),'; }
    else { bodyLine = `const body = ${JSON.stringify(r.body)};\n\n`; optsBody = '\n  body,'; }
  }
  return `// TypeScript — fetch (Node 18+ or browser)
${bodyLine}const options: RequestInit = {
  method: ${JSON.stringify(r.method)},
  headers: ${headers} as Record<string, string>,${optsBody}
};

const res: Response = await fetch(${JSON.stringify(r.url)}, options);
console.log('Status:', res.status);
console.log(await res.text());
`;
}

// ---- TypeScript: Axios ----
function genTsAxios(req) {
  const r = resolvedRequest(req);
  const headers = JSON.stringify(r.headers, null, 2).replace(/\n/g, '\n  ');
  let dataLine = '';
  if (r.body != null) dataLine = r.bodyType === 'json' ? `\n  data: ${jsonBodyLiteral(r) || '{}'},` : `\n  data: ${JSON.stringify(r.body)},`;
  return `// TypeScript — Axios   (npm install axios)
import axios, { AxiosRequestConfig } from 'axios';

const config: AxiosRequestConfig = {
  method: ${JSON.stringify(r.method.toLowerCase())},
  url: ${JSON.stringify(r.url)},
  headers: ${headers},${dataLine}
};

const res = await axios(config);
console.log('Status:', res.status);
console.log(res.data);
`;
}

// ---- Python: requests ----
function genPyRequests(req) {
  const r = resolvedRequest(req);
  const hdrLines = hdrEntries(r).map(([k, v]) => `    ${pyStr(k)}: ${pyStr(v)},`).join('\n');
  let bodyVar = '', bodyArg = '';
  if (r.body != null) {
    if (r.bodyType === 'json') { bodyVar = `payload = ${jsonBodyLiteral(r) || '{}'}\n\n`; bodyArg = ', json=payload'; }
    else { bodyVar = `payload = ${pyStr(r.body)}\n\n`; bodyArg = ', data=payload'; }
  }
  return `# Python — requests   (pip install requests)
import requests

url = ${pyStr(r.url)}
headers = {
${hdrLines}
}
${bodyVar}response = requests.request(${pyStr(r.method)}, url, headers=headers${bodyArg})
print('Status:', response.status_code)
print(response.text)
`;
}

// ---- Python: http.client (stdlib) ----
function genPyHttpClient(req) {
  const r = resolvedRequest(req);
  let host = '', path = '/', scheme = 'https';
  try { const u = new URL(r.url); host = u.host; path = (u.pathname + u.search) || '/'; scheme = u.protocol.replace(':',''); } catch {}
  const conn = scheme === 'https' ? 'HTTPSConnection' : 'HTTPConnection';
  const hdrLines = hdrEntries(r).map(([k, v]) => `    ${pyStr(k)}: ${pyStr(v)},`).join('\n');
  let payload = 'None';
  if (r.body != null) payload = pyStr(r.body);
  return `# Python — http.client (standard library, no install)
import http.client

conn = http.client.${conn}(${pyStr(host)})
payload = ${payload}
headers = {
${hdrLines}
}
conn.request(${pyStr(r.method)}, ${pyStr(path)}, payload, headers)
res = conn.getresponse()
print('Status:', res.status)
print(res.read().decode('utf-8'))
`;
}

// language -> list of {label, fn}
const CODE_GENS = {
  curl:       { label: 'cURL',       variants: [ { label: 'cURL', fn: genCurl } ] },
  nodejs:     { label: 'Node.js',    variants: [ { label: 'Native fetch', fn: genNodeFetch }, { label: 'Axios', fn: genNodeAxios } ] },
  typescript: { label: 'TypeScript', variants: [ { label: 'fetch', fn: genTsFetch }, { label: 'Axios', fn: genTsAxios } ] },
  python:     { label: 'Python',     variants: [ { label: 'Requests', fn: genPyRequests }, { label: 'http.client', fn: genPyHttpClient } ] }
};

function openCodeModal(req) {
  if (!req.url.trim()) { alert('Enter a URL first.'); return; }
  let lang = 'curl', variantIdx = 0;
  const modal = document.getElementById('codeModal');
  const langBar = document.getElementById('codeLangBar');
  const variantBar = document.getElementById('codeVariantBar');
  const codeEl = document.getElementById('codeOutput');
  const renderCode = () => {
    langBar.querySelectorAll('.rtab').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
    const variants = CODE_GENS[lang].variants;
    if (variantIdx >= variants.length) variantIdx = 0;
    variantBar.innerHTML = '';
    if (variants.length > 1) {
      variants.forEach((v, i) => {
        const b = document.createElement('button'); b.className = 'chip' + (i === variantIdx ? ' active' : ''); b.textContent = v.label;
        b.onclick = () => { variantIdx = i; renderCode(); };
        variantBar.appendChild(b);
      });
      variantBar.style.display = 'flex';
    } else { variantBar.style.display = 'none'; }
    codeEl.textContent = variants[variantIdx].fn(req);
  };
  langBar.innerHTML = '';
  Object.entries(CODE_GENS).forEach(([key, def]) => {
    const b = document.createElement('button'); b.className = 'rtab'; b.dataset.lang = key; b.textContent = def.label;
    b.onclick = () => { lang = key; variantIdx = 0; renderCode(); };
    langBar.appendChild(b);
  });
  document.getElementById('copyCodeBtn').onclick = () => navigator.clipboard.writeText(codeEl.textContent);
  renderCode();
  modal.classList.remove('hidden');
}



// ---------- Suite (Run All) modal ----------
function openSuiteModal(colName, total) {
  const modal = document.getElementById('suiteModal');
  document.getElementById('suiteTitle').textContent = `Regression: ${colName}`;
  document.getElementById('suiteSummary').innerHTML = `<span class="muted2">Running ${total} test${total>1?'s':''}…</span>`;
  document.getElementById('suiteList').innerHTML = '';
  document.getElementById('suiteProgress').style.width = '0%';
  const pdfBtn = document.getElementById('suitePdfBtn');
  if (pdfBtn) pdfBtn.style.display = 'none';
  modal.classList.remove('hidden');
}
function updateSuiteProgress(done, total, currentName) {
  document.getElementById('suiteSummary').innerHTML = `<span class="muted2">Running ${done+1}/${total}: ${escapeHtml(currentName)}…</span>`;
  document.getElementById('suiteProgress').style.width = `${Math.round((done/total)*100)}%`;
}
function renderSuiteResults(results, total) {
  document.getElementById('suiteProgress').style.width = `${Math.round((results.length/total)*100)}%`;
  const list = document.getElementById('suiteList');
  list.innerHTML = results.map((r, idx) => {
    const cls = r.status === 'pass' ? 'pass' : (r.status === 'fail' ? 'fail' : 'warn');
    const icon = r.status === 'pass' ? '✓' : (r.status === 'fail' ? '✗' : '○');
    const reason = r.reasons && r.reasons.length ? escapeHtml(r.reasons.join('; ')) : '';
    const detail = (r.status === 'fail' && r.diffs && r.diffs.length)
      ? `<div class="suite-diff" id="sd${idx}" style="display:none">${diffRowsHtml(r.diffs)}</div>` : '';
    const toggle = (r.status === 'fail' && r.diffs && r.diffs.length) ? `<span class="suite-toggle" data-idx="${idx}">view diff ▾</span>` : '';
    return `<div class="suite-item suite-${cls}">
        <span class="suite-icon">${icon}</span>
        <span class="suite-name">${escapeHtml(r.name)}</span>
        <span class="suite-reason">${reason}</span>${toggle}
      </div>${detail}`;
  }).join('');
  list.querySelectorAll('.suite-toggle').forEach(tg => tg.onclick = () => {
    const el = document.getElementById('sd' + tg.dataset.idx);
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    tg.textContent = open ? 'view diff ▾' : 'hide diff ▴';
  });
}
function finalizeSuite(results) {
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const warn = results.filter(r => r.status === 'no-baseline').length;
  const allPass = fail === 0 && warn === 0;
  document.getElementById('suiteProgress').style.width = '100%';
  document.getElementById('suiteSummary').innerHTML =
    `<span class="suite-summary-badge ${allPass ? 'all-pass' : 'has-fail'}">${allPass ? '✓ ALL PASSED' : '✗ ' + fail + ' FAILED'}</span>
     <span class="muted2">${pass} passed${fail ? ', ' + fail + ' failed' : ''}${warn ? ', ' + warn + ' skipped' : ''} of ${results.length}</span>`;
  const btn = document.getElementById('suitePdfBtn');
  if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = '⬇ Download PDF Report'; }
}

// ---------- PDF report ----------
function fmtDateTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function buildReportHtml(run) {
  const { collectionName, startedAt, finishedAt, results, env } = run;
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const skip = results.filter(r => r.status === 'no-baseline').length;
  const total = results.length;
  const allPass = fail === 0 && skip === 0;
  const durationS = ((finishedAt - startedAt) / 1000).toFixed(1);
  const passRate = total ? Math.round((pass / total) * 100) : 0;

  const rows = results.map((r, i) => {
    const statusLabel = r.status === 'pass' ? 'PASS' : (r.status === 'fail' ? 'FAIL' : 'SKIP');
    const statusClass = r.status === 'pass' ? 'p' : (r.status === 'fail' ? 'f' : 's');
    const reason = (r.reasons && r.reasons.length) ? esc(r.reasons.join('; ')) : (r.status === 'pass' ? 'Matches baseline' : '');
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td class="nm">${esc(r.name)}</td>
      <td><span class="method">${esc(r.method || '')}</span></td>
      <td class="url">${esc(r.url || '')}</td>
      <td class="num">${r.durationMs != null ? r.durationMs + ' ms' : ''}</td>
      <td class="rsn">${reason}</td>
    </tr>`;
  }).join('');

  // detailed diffs for failures
  const failDetails = results.filter(r => r.status === 'fail' && r.diffs && r.diffs.length).map(r => {
    const diffRows = r.diffs.slice(0, 200).map(d => {
      const fmt = v => v === undefined ? '—' : esc(typeof v === 'object' ? JSON.stringify(v) : String(v));
      return `<tr><td class="dp">${esc(d.path)}</td><td class="dt dt-${d.type}">${esc(d.type)}</td><td class="de">${fmt(d.expected)}</td><td class="da">${fmt(d.actual)}</td></tr>`;
    }).join('');
    return `<div class="fail-block">
      <div class="fail-head">✗ ${esc(r.name)} <span class="fail-sub">${esc(r.method || '')} ${esc(r.url || '')}</span></div>
      ${r.ignoreFields ? `<div class="ignored">Ignored fields: ${esc(r.ignoreFields)}</div>` : ''}
      <table class="diff"><thead><tr><th>Field</th><th>Change</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${diffRows}</tbody></table>
    </div>`;
  }).join('');

  // pretty-print a response body (JSON beautified, else raw), truncated for the PDF
  const MAX_BODY = 12000;
  const prettyBody = (body) => {
    if (body == null || body === '') return '(empty)';
    let out = body;
    try { out = JSON.stringify(JSON.parse(body), null, 2); } catch { /* keep raw */ }
    let truncated = false;
    if (out.length > MAX_BODY) { out = out.slice(0, MAX_BODY); truncated = true; }
    return esc(out) + (truncated ? '\n… (truncated for report)' : '');
  };
  const statusLine = (resp) => {
    if (!resp) return '(no response captured)';
    if (resp.error) return 'ERROR: ' + esc(resp.error);
    return `HTTP ${esc(resp.status)} ${esc(resp.statusText || '')}`;
  };

  // full baseline vs actual response for EVERY endpoint, so the user can verify manually
  const responseDetails = results.map((r, i) => {
    const statusClass = r.status === 'pass' ? 'p' : (r.status === 'fail' ? 'f' : 's');
    const statusLabel = r.status === 'pass' ? 'PASS' : (r.status === 'fail' ? 'FAIL' : 'SKIP');
    const baselineBody = r.baseline ? prettyBody(r.baseline.body) : '(no baseline)';
    const liveBody = r.live ? prettyBody(r.live.body) : '(not run)';
    const baselineStatus = r.baseline ? `HTTP ${esc(r.baseline.status)} ${esc(r.baseline.statusText || '')}` : '—';
    return `<div class="resp-block">
      <div class="resp-head"><span class="badge ${statusClass}">${statusLabel}</span> ${i + 1}. ${esc(r.name)}
        <span class="resp-sub">${esc(r.method || '')} ${esc(r.url || '')}</span></div>
      ${r.ignoreFields ? `<div class="ignored">Ignored fields (excluded from comparison): ${esc(r.ignoreFields)}</div>` : ''}
      <div class="resp-cols">
        <div class="resp-col">
          <div class="resp-col-title baseline">Expected (Baseline) &nbsp;<span class="resp-status">${baselineStatus}</span></div>
          <pre class="resp-body">${baselineBody}</pre>
        </div>
        <div class="resp-col">
          <div class="resp-col-title actual">Actual (This Run) &nbsp;<span class="resp-status">${statusLine(r.live)}</span></div>
          <pre class="resp-body">${liveBody}</pre>
        </div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 0; padding: 32px 36px; font-size: 12px; }
    .header { border-bottom: 3px solid #2563eb; padding-bottom: 14px; margin-bottom: 20px; }
    .brand { color: #2563eb; font-size: 20px; font-weight: 700; }
    .title { font-size: 16px; margin-top: 4px; color: #0f172a; }
    .meta { color: #64748b; font-size: 11px; margin-top: 6px; line-height: 1.7; }
    .verdict { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: 700; font-size: 13px; margin: 14px 0; }
    .verdict.pass { background: #dcfce7; color: #15803d; border: 1px solid #15803d; }
    .verdict.fail { background: #fee2e2; color: #b91c1c; border: 1px solid #b91c1c; }
    .cards { display: flex; gap: 10px; margin: 14px 0 22px; }
    .card { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: center; }
    .card .n { font-size: 22px; font-weight: 700; }
    .card .l { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .card.total .n { color: #0f172a; } .card.pass .n { color: #15803d; }
    .card.fail .n { color: #b91c1c; } .card.rate .n { color: #2563eb; }
    h2 { font-size: 13px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin: 24px 0 10px; }
    table.summary { width: 100%; border-collapse: collapse; }
    table.summary th { text-align: left; background: #f1f5f9; padding: 7px 8px; font-size: 10px; text-transform: uppercase; color: #475569; border-bottom: 2px solid #e2e8f0; }
    table.summary td { padding: 7px 8px; border-bottom: 1px solid #eef2f6; vertical-align: top; }
    td.num { text-align: right; color: #64748b; white-space: nowrap; }
    td.nm { font-weight: 600; }
    td.url { color: #475569; word-break: break-all; max-width: 200px; }
    td.rsn { color: #475569; }
    .method { font-weight: 700; font-size: 10px; color: #7c3aed; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-weight: 700; font-size: 10px; }
    .badge.p { background: #dcfce7; color: #15803d; } .badge.f { background: #fee2e2; color: #b91c1c; } .badge.s { background: #fef3c7; color: #b45309; }
    .fail-block { border: 1px solid #fecaca; border-radius: 8px; padding: 12px; margin-bottom: 14px; page-break-inside: avoid; }
    .fail-head { font-weight: 700; color: #b91c1c; margin-bottom: 4px; }
    .fail-sub { font-weight: 400; color: #64748b; font-size: 10px; }
    .ignored { font-size: 10px; color: #64748b; margin-bottom: 8px; }
    table.diff { width: 100%; border-collapse: collapse; font-family: 'Consolas', monospace; font-size: 10px; }
    table.diff th { text-align: left; background: #f8fafc; padding: 5px 7px; color: #475569; border-bottom: 1px solid #e2e8f0; }
    table.diff td { padding: 4px 7px; border-bottom: 1px solid #f1f5f9; word-break: break-all; }
    .dp { color: #2563eb; } .de { color: #15803d; } .da { color: #b91c1c; }
    .dt { font-weight: 600; color: #b45309; }
    .footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #94a3b8; }
    .resp-intro { color: #475569; font-size: 11px; margin-bottom: 14px; }
    .resp-block { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 14px; page-break-inside: avoid; }
    .resp-head { font-weight: 700; color: #0f172a; margin-bottom: 6px; }
    .resp-sub { font-weight: 400; color: #64748b; font-size: 10px; }
    .resp-cols { display: flex; gap: 10px; }
    .resp-col { flex: 1; min-width: 0; }
    .resp-col-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 8px; border-radius: 4px 4px 0 0; }
    .resp-col-title.baseline { background: #dcfce7; color: #15803d; }
    .resp-col-title.actual { background: #dbeafe; color: #1d4ed8; }
    .resp-status { font-weight: 600; text-transform: none; letter-spacing: 0; }
    .resp-body { margin: 0; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 4px 4px; padding: 8px; font-family: 'Consolas', monospace; font-size: 9px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: hidden; }
  </style></head><body>
    <div class="header">
      <div class="brand">⚡ APIForge</div>
      <div class="title">API Regression Test Report</div>
      <div class="meta">
        <b>Collection:</b> ${esc(collectionName)} &nbsp;•&nbsp; <b>Environment:</b> ${esc(env)}<br>
        <b>Run started:</b> ${esc(fmtDateTime(startedAt))} &nbsp;•&nbsp; <b>Duration:</b> ${durationS}s
      </div>
    </div>

    <div class="verdict ${allPass ? 'pass' : 'fail'}">${allPass ? '✓ ALL TESTS PASSED' : '✗ ' + fail + ' TEST' + (fail === 1 ? '' : 'S') + ' FAILED'}</div>

    <div class="cards">
      <div class="card total"><div class="n">${total}</div><div class="l">Total</div></div>
      <div class="card pass"><div class="n">${pass}</div><div class="l">Passed</div></div>
      <div class="card fail"><div class="n">${fail}</div><div class="l">Failed</div></div>
      ${skip ? `<div class="card"><div class="n">${skip}</div><div class="l">Skipped</div></div>` : ''}
      <div class="card rate"><div class="n">${passRate}%</div><div class="l">Pass Rate</div></div>
    </div>

    <h2>Summary</h2>
    <table class="summary">
      <thead><tr><th>#</th><th>Result</th><th>Endpoint</th><th>Method</th><th>URL</th><th>Time</th><th>Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    ${failDetails ? `<h2>Failure Details</h2>${failDetails}` : ''}

    <h2>Response Comparison &mdash; Baseline vs Actual</h2>
    <div class="resp-intro">For full transparency, the saved baseline (expected) response and the actual response captured during this run are shown below for every endpoint, so results can be verified independently.</div>
    ${responseDetails}

    <div class="footer">Generated by APIForge on ${esc(fmtDateTime(Date.now()))}. Baselines compared field-by-field; ignored fields excluded from comparison.</div>
  </body></html>`;
}

async function downloadPdfReport() {
  if (!lastSuiteRun) { await dialogConfirm('No Results', 'Run the collection tests first, then download the report.'); return; }
  const btn = document.getElementById('suitePdfBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  const html = buildReportHtml(lastSuiteRun);
  const safe = lastSuiteRun.collectionName.replace(/[^\w-]+/g, '_');
  const stamp = new Date(lastSuiteRun.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const res = await window.api.savePdf({ html, suggestedName: `APIForge_${safe}_${stamp}.pdf` });
  if (btn) { btn.disabled = false; btn.textContent = '⬇ Download PDF Report'; }
  if (res && res.ok) { await dialogConfirm('Report Saved', `Saved to:\n${esc(res.path)}`); }
  else if (res && res.canceled) { /* user cancelled */ }
  else { await dialogConfirm('Error', 'Could not generate PDF: ' + (res && res.error ? res.error : 'unknown')); }
}


function render() {
  renderSidebar();
  renderTabBar();
  renderWorkspace();
}

function renderTabBar() {
  const bar = document.getElementById('tabBar');
  bar.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    el.innerHTML = `<span class="tab-method m-${t.req.method}">${t.req.method}</span>
      <span>${escapeHtml(t.req.name || 'Untitled')}</span>
      <span class="tab-close">✕</span>`;
    el.onclick = (e) => { if (e.target.classList.contains('tab-close')) closeTab(t.id); else { activeTabId = t.id; render(); } };
    bar.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'new-tab'; add.textContent = '+';
  add.onclick = () => newTab();
  bar.appendChild(add);
}

function kvEditor(rows, onChange) {
  const wrap = document.createElement('div'); wrap.className = 'kv-table';
  const draw = () => {
    wrap.innerHTML = '';
    rows.forEach((r, i) => {
      const row = document.createElement('div'); row.className = 'kv-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = r.enabled !== false;
      cb.onchange = () => { r.enabled = cb.checked; onChange(); };
      const k = document.createElement('input'); k.type = 'text'; k.placeholder = 'key'; k.value = r.key || '';
      k.dataset.idx = i; k.dataset.col = 'k';
      k.oninput = () => {
        r.key = k.value; const added = ensureTrailing(); onChange();
        if (added) { const pos = k.selectionStart; draw(); restoreFocus(i, 'k', pos); }
      };
      const v = document.createElement('input'); v.type = 'text'; v.placeholder = 'value'; v.value = r.value || '';
      v.dataset.idx = i; v.dataset.col = 'v';
      v.oninput = () => {
        r.value = v.value; const added = ensureTrailing(); onChange();
        if (added) { const pos = v.selectionStart; draw(); restoreFocus(i, 'v', pos); }
      };
      const del = document.createElement('button'); del.className = 'kv-del'; del.textContent = '✕';
      del.onclick = () => { rows.splice(i, 1); ensureTrailing(); onChange(); draw(); };
      row.append(cb, k, v, del); wrap.appendChild(row);
    });
  };
  const restoreFocus = (idx, col, pos) => {
    const sel = wrap.querySelector(`input[data-idx="${idx}"][data-col="${col}"]`);
    if (sel) { sel.focus(); try { sel.setSelectionRange(pos, pos); } catch {} }
  };
  const ensureTrailing = () => {
    const last = rows[rows.length - 1];
    if (!last || last.key || last.value) { rows.push({ key: '', value: '', enabled: true }); return true; }
    return false;
  };
  ensureTrailing(); draw();
  wrap._redraw = draw;
  return wrap;
}

function renderWorkspace() {
  const ws = document.getElementById('workspace');
  ws.innerHTML = '';
  const t = activeTab();
  if (!t) return;
  const req = t.req;

  const view = document.createElement('div'); view.className = 'req-view';

  // URL bar
  const urlBar = document.createElement('div'); urlBar.className = 'url-bar';
  const methodSel = document.createElement('select'); methodSel.className = 'method-select';
  ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].forEach(m => {
    const o = document.createElement('option'); o.value = m; o.textContent = m; if (m === req.method) o.selected = true; methodSel.appendChild(o);
  });
  methodSel.onchange = () => { req.method = methodSel.value; render(); };
  const urlInput = document.createElement('input'); urlInput.className = 'url-input';
  urlInput.placeholder = 'https://api.example.com/endpoint  (use {{var}} for env vars)';
  urlInput.value = req.url;
  urlInput.oninput = () => { req.url = urlInput.value; };
  urlInput.onkeydown = (e) => { if (e.key === 'Enter') sendRequest(); };
  const sendBtn = document.createElement('button'); sendBtn.className = 'send-btn'; sendBtn.textContent = 'Send';
  sendBtn.onclick = sendRequest;
  const saveBtn = document.createElement('button'); saveBtn.className = 'save-btn'; saveBtn.textContent = 'Save';
  saveBtn.onclick = () => saveRequest(t);
  const codeBtn = document.createElement('button'); codeBtn.className = 'save-btn'; codeBtn.textContent = '</> Code';
  codeBtn.title = 'Generate code (Node.js / TypeScript / Python)';
  codeBtn.onclick = () => openCodeModal(req);
  urlBar.append(methodSel, urlInput, sendBtn, saveBtn, codeBtn);
  view.appendChild(urlBar);

  // Request tabs
  const rtabs = document.createElement('div'); rtabs.className = 'req-tabs';
  const rtabDefs = ['params','headers','body','auth','tests'];
  rtabDefs.forEach(name => {
    const b = document.createElement('button'); b.className = 'rtab' + (t.activeReqTab === name ? ' active' : '');
    b.textContent = name[0].toUpperCase() + name.slice(1);
    b.onclick = () => { t.activeReqTab = name; renderWorkspace(); };
    rtabs.appendChild(b);
  });
  view.appendChild(rtabs);

  const content = document.createElement('div');
  if (t.activeReqTab === 'params') content.appendChild(kvEditor(req.params, () => {}));
  else if (t.activeReqTab === 'headers') content.appendChild(kvEditor(req.headers, () => {}));
  else if (t.activeReqTab === 'body') content.appendChild(bodyEditor(req));
  else if (t.activeReqTab === 'auth') content.appendChild(authEditor(req));
  else if (t.activeReqTab === 'tests') content.appendChild(testEditor(req, t));
  view.appendChild(content);

  // Response
  view.appendChild(responseArea(req));
  ws.appendChild(view);
}

function bodyEditor(req) {
  const wrap = document.createElement('div');
  const bar = document.createElement('div'); bar.className = 'body-type-bar';
  [['none','None'],['json','JSON'],['form','Form URL-Encoded'],['raw','Raw']].forEach(([val,label]) => {
    const l = document.createElement('label');
    const r = document.createElement('input'); r.type = 'radio'; r.name = 'bodytype'; r.value = val; r.checked = req.bodyType === val;
    r.onchange = () => { req.bodyType = val; renderWorkspace(); };
    l.append(r, document.createTextNode(' ' + label)); bar.appendChild(l);
  });
  wrap.appendChild(bar);
  if (req.bodyType !== 'none') {
    const ta = document.createElement('textarea'); ta.className = 'body-textarea';
    ta.placeholder = req.bodyType === 'json' ? '{\n  "key": "value"\n}' : (req.bodyType === 'form' ? '{ "field": "value" }  (JSON object)' : 'raw body');
    ta.value = req.body; ta.oninput = () => { req.body = ta.value; };
    wrap.appendChild(ta);
    if (req.bodyType === 'json') {
      const fmt = document.createElement('button'); fmt.className = 'save-btn'; fmt.textContent = 'Beautify'; fmt.style.marginTop = '8px';
      fmt.onclick = () => { try { req.body = JSON.stringify(JSON.parse(req.body), null, 2); renderWorkspace(); } catch {} };
      wrap.appendChild(fmt);
    }
  }
  return wrap;
}

function authEditor(req) {
  const wrap = document.createElement('div'); const a = req.auth;
  const r1 = document.createElement('div'); r1.className = 'auth-row';
  r1.innerHTML = '<label>Type</label>';
  const sel = document.createElement('select');
  [['none','No Auth'],['bearer','Bearer Token'],['basic','Basic Auth'],['apikey','API Key (header)']].forEach(([v,l]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = l; if (a.type === v) o.selected = true; sel.appendChild(o);
  });
  sel.onchange = () => { a.type = sel.value; renderWorkspace(); };
  r1.appendChild(sel); wrap.appendChild(r1);
  const field = (label, key, type='text') => {
    const d = document.createElement('div'); d.className = 'auth-row';
    d.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement('input'); inp.type = type; inp.value = a[key] || '';
    inp.oninput = () => { a[key] = inp.value; };
    d.appendChild(inp); wrap.appendChild(d);
  };
  if (a.type === 'bearer') field('Token', 'token');
  else if (a.type === 'basic') { field('Username', 'username'); field('Password', 'password', 'password'); }
  else if (a.type === 'apikey') { field('Header Name', 'key'); field('Value', 'value'); }
  return wrap;
}

function testEditor(req, t) {
  if (!req.test) req.test = { hasBaseline: false, ignoreFields: '', compareStatus: true, compareBody: true };
  const cfg = req.test;
  const wrap = document.createElement('div'); wrap.className = 'test-editor';

  // status line
  const statusBox = document.createElement('div'); statusBox.className = 'test-status-box';
  const saved = !!req.savedTo;
  const hasBl = cfg.hasBaseline;
  statusBox.innerHTML = `<div class="test-hint">
    Save a baseline from a good response, then re-run after code changes to detect regressions.
    ${saved ? '' : '<br><b style="color:var(--orange)">⚠ Save this request to a collection first (top-right Save button).</b>'}
    ${store.baselinesDir ? `<br><span class="muted2">Baselines folder: ${escapeHtml(store.baselinesDir)}</span>` : '<br><span class="muted2">No baselines folder set yet — you\'ll be asked to pick one.</span>'}
  </div>`;
  wrap.appendChild(statusBox);

  // baseline status + actions
  const blRow = document.createElement('div'); blRow.className = 'test-bl-row';
  const badge = document.createElement('span');
  badge.className = 'test-badge ' + (hasBl ? 'has' : 'none');
  badge.textContent = hasBl ? '✓ Baseline saved' : '○ No baseline yet';
  blRow.appendChild(badge);

  const saveBlBtn = document.createElement('button'); saveBlBtn.className = 'send-btn'; saveBlBtn.textContent = hasBl ? 'Update Baseline' : 'Save Current Response as Baseline';
  saveBlBtn.onclick = () => saveBaseline(req);
  blRow.appendChild(saveBlBtn);

  const runBtn = document.createElement('button'); runBtn.className = 'save-btn'; runBtn.textContent = '▶ Run This Test';
  runBtn.disabled = !hasBl;
  runBtn.onclick = async () => {
    runBtn.textContent = 'Running…'; runBtn.disabled = true;
    syncTestConfigToCollection(req);
    const snap = JSON.parse(JSON.stringify({ ...req, response: null }));
    snap.savedTo = req.savedTo;
    const result = await runTest(snap);
    showSingleTestResult(wrap, result);
    runBtn.textContent = '▶ Run This Test'; runBtn.disabled = false;
  };
  blRow.appendChild(runBtn);
  wrap.appendChild(blRow);

  // compare options
  const opts = document.createElement('div'); opts.className = 'test-opts';
  const mkCheck = (label, key) => {
    const l = document.createElement('label'); l.className = 'test-check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = cfg[key] !== false;
    cb.onchange = () => { cfg[key] = cb.checked; syncTestConfigToCollection(req); persist(); };
    l.append(cb, document.createTextNode(' ' + label)); return l;
  };
  opts.append(mkCheck('Compare status code', 'compareStatus'), mkCheck('Compare response body', 'compareBody'));
  wrap.appendChild(opts);

  // ignore fields
  const igWrap = document.createElement('div'); igWrap.className = 'test-ignore';
  igWrap.innerHTML = `<label>Ignore these fields (comma-separated, supports wildcards)</label>`;
  const ig = document.createElement('input'); ig.type = 'text'; ig.className = 'dialog-input';
  ig.placeholder = 'e.g. id, createdAt, user.token, items[*].timestamp, *.updatedAt';
  ig.value = cfg.ignoreFields || '';
  ig.oninput = () => { cfg.ignoreFields = ig.value; };
  ig.onblur = () => { syncTestConfigToCollection(req); persist(); };
  igWrap.appendChild(ig);
  const ex = document.createElement('div'); ex.className = 'muted2'; ex.style.marginTop = '6px';
  ex.innerHTML = 'Fields that change every call (timestamps, generated IDs) should go here so they don\'t cause false failures. Leave empty for an exact match.';
  igWrap.appendChild(ex);
  wrap.appendChild(igWrap);

  // result container
  const rc = document.createElement('div'); rc.id = 'singleTestResult'; rc.className = 'test-result-area';
  wrap.appendChild(rc);
  return wrap;
}

function diffRowsHtml(diffs) {
  if (!diffs || !diffs.length) return '';
  const rows = diffs.slice(0, 100).map(d => {
    const fmt = v => v === undefined ? '—' : escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v));
    let label = d.type;
    return `<tr><td class="diff-path">${escapeHtml(d.path)}</td><td class="diff-type diff-${d.type}">${label}</td><td class="diff-exp">${fmt(d.expected)}</td><td class="diff-act">${fmt(d.actual)}</td></tr>`;
  }).join('');
  return `<table class="diff-table"><thead><tr><th>Field</th><th>Change</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function showSingleTestResult(wrap, result) {
  const rc = wrap.querySelector('#singleTestResult');
  if (!rc) return;
  if (result.status === 'no-baseline') {
    rc.innerHTML = `<div class="result-banner banner-warn">No baseline — ${escapeHtml(result.reasons[0] || '')}</div>`;
    return;
  }
  const pass = result.status === 'pass';
  rc.innerHTML = `<div class="result-banner ${pass ? 'banner-pass' : 'banner-fail'}">
      ${pass ? '✓ PASS' : '✗ FAIL'} ${result.reasons.length ? '— ' + escapeHtml(result.reasons.join('; ')) : ''}
    </div>` + (pass ? '' : diffRowsHtml(result.diffs));
}


function responseArea(req) {
  const area = document.createElement('div'); area.className = 'response-area';
  const res = req.response;
  if (!res) { area.innerHTML = '<div class="placeholder">Send a request to see the response</div>'; return area; }
  if (res.loading) { area.innerHTML = '<div class="placeholder">Sending…</div>'; return area; }
  if (res.error) { area.innerHTML = `<div class="placeholder" style="color:var(--red)">⚠ ${escapeHtml(res.error)}</div>`; return area; }

  const meta = document.createElement('div'); meta.className = 'resp-meta';
  const sc = Math.floor(res.status / 100);
  meta.innerHTML = `<span class="resp-status status-${sc}">${res.status} ${escapeHtml(res.statusText||'')}</span>
    <span>⏱ ${res.time} ms</span><span>📦 ${(res.size/1024).toFixed(2)} KB</span>`;
  area.appendChild(meta);

  const tabId = activeTab().id;
  const tabsRow = document.createElement('div'); tabsRow.className = 'resp-tabs';
  ['body','headers'].forEach(name => {
    const b = document.createElement('button'); b.className = 'rtab' + (activeTab().activeRespTab === name ? ' active' : '');
    b.textContent = name === 'body' ? 'Body' : 'Headers';
    b.onclick = () => { activeTab().activeRespTab = name; renderWorkspace(); };
    tabsRow.appendChild(b);
  });
  const copyBtn = document.createElement('button'); copyBtn.className = 'save-btn'; copyBtn.textContent = 'Copy'; copyBtn.style.marginLeft = 'auto';
  copyBtn.onclick = () => navigator.clipboard.writeText(res.body || '');
  tabsRow.appendChild(copyBtn);
  area.appendChild(tabsRow);

  const bodyEl = document.createElement('div'); bodyEl.className = 'resp-body';
  if (activeTab().activeRespTab === 'headers') {
    bodyEl.innerHTML = Object.entries(res.headers || {}).map(([k,v]) =>
      `<span class="json-key">${escapeHtml(k)}</span>: ${escapeHtml(String(v))}`).join('\n');
  } else {
    bodyEl.innerHTML = formatResponseBody(res);
  }
  area.appendChild(bodyEl);
  return area;
}

// ---------- Save request to collection ----------
async function saveRequest(t) {
  const req = t.req;
  const name = await dialogPrompt('Save Request', req.name || 'Untitled Request', 'Request name:');
  if (name === null) return;
  req.name = name;

  // Decide first: update the linked existing request, or create a new one.
  let mode = 'new';
  let targetId = uid();
  let col = null;

  if (req.savedTo) {
    let linked = null, linkedCol = null;
    for (const c of store.collections) {
      const found = (c.requests || []).find(r => r.id === req.savedTo);
      if (found) { linked = found; linkedCol = c; break; }
    }
    if (linked) {
      const choice = await dialogSelect('Save Request',
        [{ value: 'update', label: `Update existing "${linked.name}"` }, { value: 'new', label: 'Save as a new endpoint' }],
        'This request is linked to a saved endpoint. What do you want to do?');
      if (choice === null) return;
      if (choice === 'update') { mode = 'update'; targetId = req.savedTo; col = linkedCol; }
    }
  }

  // For a new endpoint, pick the destination collection (creating one if needed).
  if (mode === 'new') {
    if (store.collections.length === 0) {
      const colName = await dialogPrompt('New Collection', 'My Collection', 'No collections yet. Name your first collection:');
      if (colName === null) return;
      store.collections.push({ id: uid(), name: colName, requests: [] });
      col = store.collections[0];
    } else if (store.collections.length === 1) {
      col = store.collections[0];
    } else {
      const choice = await dialogSelect('Save To', store.collections.map(c => ({ value: c.id, label: c.name })), 'Choose a collection:');
      if (choice === null) return;
      col = store.collections.find(c => c.id === choice) || store.collections[0];
    }
  }

  const snapshot = JSON.parse(JSON.stringify({ ...req, response: null }));
  snapshot.id = targetId;
  // a brand-new endpoint starts without inheriting the old baseline link
  if (mode === 'new' && snapshot.test) snapshot.test = { ...snapshot.test, hasBaseline: false };

  const existingIdx = col.requests.findIndex(r => r.id === snapshot.id);
  if (existingIdx >= 0) col.requests[existingIdx] = snapshot; else col.requests.push(snapshot);
  req.savedTo = snapshot.id;
  if (mode === 'new' && req.test) req.test.hasBaseline = snapshot.test ? snapshot.test.hasBaseline : false;
  await persist(); render();
}

// ---------- Sidebar ----------
function renderSidebar() {
  // env select
  const envSel = document.getElementById('envSelect');
  envSel.innerHTML = '<option value="">No Environment</option>';
  store.environments.forEach(e => {
    const o = document.createElement('option'); o.value = e.id; o.textContent = e.name;
    if (e.id === store.activeEnv) o.selected = true; envSel.appendChild(o);
  });

  // collections
  const cl = document.getElementById('collectionsList'); cl.innerHTML = '';
  store.collections.forEach(col => {
    const c = document.createElement('div'); c.className = 'collection';
    const head = document.createElement('div'); head.className = 'collection-head';
    const testable = (col.requests || []).filter(r => r.test && r.test.hasBaseline).length;
    head.innerHTML = `<span>📁</span><span class="collection-name">${escapeHtml(col.name)}</span>` +
      (testable ? `<span class="run-tests-btn" title="Run all ${testable} regression test${testable>1?'s':''}">▶ Test</span>` : '') +
      `<span class="tiny-x">✕</span>`;
    head.querySelector('.tiny-x').onclick = async (e) => { e.stopPropagation(); if (await dialogConfirm('Delete Collection', `Delete "${escapeHtml(col.name)}" and all its requests?`)) { store.collections = store.collections.filter(x => x.id !== col.id); persist(); render(); } };
    const rtBtn = head.querySelector('.run-tests-btn');
    if (rtBtn) rtBtn.onclick = (e) => { e.stopPropagation(); runCollectionTests(col); };
    c.appendChild(head);
    (col.requests || []).forEach(r => {
      const rq = document.createElement('div'); rq.className = 'col-req';
      const blDot = (r.test && r.test.hasBaseline) ? '<span class="bl-dot" title="Has test baseline">●</span>' : '';
      rq.innerHTML = `<span class="req-method m-${r.method}">${r.method}</span><span class="req-name">${escapeHtml(r.name)}</span>${blDot}<span class="tiny-x">✕</span>`;
      rq.onclick = async (e) => {
        if (e.target.classList.contains('tiny-x')) { e.stopPropagation(); if (await dialogConfirm('Delete Request', `Delete "${escapeHtml(r.name)}"?`)) { col.requests = col.requests.filter(x => x.id !== r.id); persist(); render(); } return; }
        const copy = JSON.parse(JSON.stringify(r)); copy.savedTo = r.id; copy.response = null;
        newTab(copy);
      };
      c.appendChild(rq);
    });
    cl.appendChild(c);
  });

  // history
  const hl = document.getElementById('historyList'); hl.innerHTML = '';
  store.history.forEach(h => {
    const el = document.createElement('div'); el.className = 'history-item';
    el.innerHTML = `<span class="req-method m-${h.method}">${h.method}</span><span class="history-url">${escapeHtml(h.url)}</span>`;
    el.onclick = () => { const copy = JSON.parse(JSON.stringify(h.snapshot)); copy.response = null; newTab(copy); };
    hl.appendChild(el);
  });
}

// ---------- Environment modal ----------
function renderEnvModal() {
  const list = document.getElementById('envEditorList'); list.innerHTML = '';
  store.environments.forEach(env => {
    const block = document.createElement('div'); block.className = 'env-block';
    const head = document.createElement('div'); head.className = 'env-block-head';
    const nameInp = document.createElement('input'); nameInp.value = env.name;
    nameInp.oninput = () => { env.name = nameInp.value; };
    const del = document.createElement('button'); del.className = 'save-btn'; del.textContent = 'Delete';
    del.onclick = () => { store.environments = store.environments.filter(e => e.id !== env.id); if (store.activeEnv === env.id) store.activeEnv = null; persist(); renderEnvModal(); render(); };
    head.append(nameInp, del); block.appendChild(head);
    if (!env.vars) env.vars = [];
    block.appendChild(kvEditor(env.vars, () => {}));
    list.appendChild(block);
  });
}

// ---------- Wire up ----------
document.querySelectorAll('.stab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.stab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  document.getElementById('collectionsPanel').classList.toggle('hidden', b.dataset.stab !== 'collections');
  document.getElementById('historyPanel').classList.toggle('hidden', b.dataset.stab !== 'history');
});
document.getElementById('newCollectionBtn').onclick = async () => {
  const n = await dialogPrompt('New Collection', 'New Collection', 'Collection name:'); if (!n) return;
  store.collections.push({ id: uid(), name: n, requests: [] }); persist(); render();
};
document.getElementById('clearHistoryBtn').onclick = async () => { if (await dialogConfirm('Clear History', 'Remove all request history?')) { store.history = []; persist(); render(); } };
document.getElementById('envSelect').onchange = (e) => { store.activeEnv = e.target.value || null; persist(); };
document.getElementById('manageEnvBtn').onclick = () => { renderEnvModal(); document.getElementById('envModal').classList.remove('hidden'); };
document.getElementById('closeEnvModal').onclick = () => { document.getElementById('envModal').classList.add('hidden'); persist(); render(); };
document.getElementById('addEnvBtn').onclick = () => { store.environments.push({ id: uid(), name: 'New Env', vars: [] }); persist(); renderEnvModal(); render(); };
document.getElementById('closeCodeModal').onclick = () => document.getElementById('codeModal').classList.add('hidden');
document.getElementById('closeSuiteModal').onclick = () => document.getElementById('suiteModal').classList.add('hidden');
document.getElementById('suitePdfBtn').onclick = () => downloadPdfReport();

// ---------- Init ----------
(async () => { await loadStore(); newTab(); })();
