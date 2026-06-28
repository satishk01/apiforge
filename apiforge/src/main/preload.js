const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (payload) => ipcRenderer.invoke('http:send', payload),
  readStore: () => ipcRenderer.invoke('store:read'),
  writeStore: (data) => ipcRenderer.invoke('store:write', data),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  baselineWrite: (args) => ipcRenderer.invoke('baseline:write', args),
  baselineRead: (args) => ipcRenderer.invoke('baseline:read', args),
  baselineExists: (args) => ipcRenderer.invoke('baseline:exists', args),
  savePdf: (args) => ipcRenderer.invoke('report:savePdf', args),
  perfRun: (cfg) => ipcRenderer.invoke('perf:run', cfg),
  perfCancel: (runId) => ipcRenderer.invoke('perf:cancel', runId),
  onPerfTick: (cb) => { ipcRenderer.on('perf:tick', (_e, data) => cb(data)); },
  exportCollection: (args) => ipcRenderer.invoke('collection:export', args),
  importCollection: () => ipcRenderer.invoke('collection:import')
});
