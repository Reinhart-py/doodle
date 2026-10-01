const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { verifyKey, checkSavedLicense, saveKey, removeKey } = require('./src/license');
const { getHistory, getActiveCheckpoint, clearActiveCheckpoint } = require('./src/storage');
const { runGmaps } = require('./src/scraper-gmaps');
const { runTwoGis } = require('./src/scraper-2gis');

let mainWindow = null;
let activeTasks = [];

function resolveAppIcon() {
  const pngPath = path.join(__dirname, 'images', 'logo.png');
  const icoPath = path.join(__dirname, 'images', 'icon.ico');
  if (fs.existsSync(pngPath)) return pngPath;
  if (fs.existsSync(icoPath)) return icoPath;
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#061c12',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0C1412',
      symbolColor: '#ffffff',
      height: 32
    },
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('license:check-saved', async () => {
  return await checkSavedLicense();
});

ipcMain.handle('license:verify', async (event, key) => {
  return await verifyKey(key);
});

ipcMain.handle('license:logout', async () => {
  removeKey();
  return true;
});

ipcMain.handle('storage:get-history', async () => {
  return getHistory();
});

ipcMain.handle('storage:get-active-checkpoint', async () => {
  return getActiveCheckpoint();
});

ipcMain.handle('storage:dismiss-checkpoint', async () => {
  clearActiveCheckpoint();
  return true;
});

ipcMain.handle('dialog:open-file', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Spreadsheets & Text', extensions: ['csv', 'xlsx', 'xls', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!res.canceled && res.filePaths.length > 0) {
    return res.filePaths[0];
  }
  return null;
});

ipcMain.handle('shell:open-link', async (event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('shell:open-history', async (event, item) => {
  const { getExportsDir } = require('./src/storage');
  let safeName;
  if (item.engine === '2gis') {
    const parts = (item.target || '').split(':');
    const city = parts[0] || 'Dubai';
    const queryPath = parts.slice(1).join(':') || '';
    const qName = path.basename(queryPath);
    safeName = `${city}:${qName}`.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  } else {
    safeName = path.basename(item.target || '').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 24);
  }
  const csvPath = path.join(getExportsDir(), `${item.engine}_${safeName}.csv`);
  if (fs.existsSync(csvPath)) {
    await shell.openPath(csvPath);
  }
});

ipcMain.handle('scraper:start-gmaps', async (event, config) => {
  const task = { id: Date.now(), isRunning: true, cancelled: false };
  activeTasks.push(task);

  const logger = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:log', msg);
    }
  };

  runGmaps(config, task, logger)
    .catch((err) => {
      logger(`Error: ${err.message}`);
    })
    .finally(() => {
      task.isRunning = false;
      activeTasks = activeTasks.filter(t => t.id !== task.id);
      if (activeTasks.length === 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:done');
      }
    });

  return { success: true };
});

ipcMain.handle('scraper:start-twogis', async (event, config) => {
  const task = { id: Date.now(), isRunning: true, cancelled: false };
  activeTasks.push(task);

  const logger = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:log', msg);
    }
  };

  runTwoGis(config, task, logger)
    .catch((err) => {
      logger(`Error: ${err.message}`);
    })
    .finally(() => {
      task.isRunning = false;
      activeTasks = activeTasks.filter(t => t.id !== task.id);
      if (activeTasks.length === 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:done');
      }
    });

  return { success: true };
});

ipcMain.handle('scraper:stop', async () => {
  activeTasks.forEach(t => t.cancelled = true);
  return true;
});
