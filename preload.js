const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkSavedLicense: () => ipcRenderer.invoke('license:check-saved'),
  verifyLicense: (key) => ipcRenderer.invoke('license:verify', key),
  logoutLicense: () => ipcRenderer.invoke('license:logout'),
  getHistory: () => ipcRenderer.invoke('storage:get-history'),
  getActiveCheckpoint: () => ipcRenderer.invoke('storage:get-active-checkpoint'),
  dismissCheckpoint: () => ipcRenderer.invoke('storage:dismiss-checkpoint'),
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  openLink: (url) => ipcRenderer.invoke('shell:open-link', url),
  openHistoryData: (item) => ipcRenderer.invoke('shell:open-history', item),
  startGmaps: (config) => ipcRenderer.invoke('scraper:start-gmaps', config),
  startTwoGis: (config) => ipcRenderer.invoke('scraper:start-twogis', config),
  stopScraper: () => ipcRenderer.invoke('scraper:stop'),
  onLog: (callback) => ipcRenderer.on('scraper:log', (event, msg) => callback(msg)),
  onDone: (callback) => ipcRenderer.on('scraper:done', () => callback())
});
