const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { verifyKey, checkSavedLicense, saveKey, removeKey } = require('./src/license');
const { getHistory, getActiveCheckpoint, clearActiveCheckpoint } = require('./src/storage');
const { runGmaps } = require('./src/scraper-gmaps');
const { runTwoGis } = require('./src/scraper-2gis');

let mainWindow = null;
let activeTask = null;

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

ipcMain.handle('scraper:start-gmaps', async (event, config) => {
  if (activeTask && activeTask.isRunning) {
    return { success: false, message: 'A task is already running.' };
  }

  activeTask = { isRunning: true, cancelled: false };

  const logger = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:log', msg);
    }
  };

  runGmaps(config, activeTask, logger)
    .catch((err) => {
      logger(`Error: ${err.message}`);
    })
    .finally(() => {
      if (activeTask) activeTask.isRunning = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:done');
      }
    });

  return { success: true };
});

ipcMain.handle('scraper:start-twogis', async (event, config) => {
  if (activeTask && activeTask.isRunning) {
    return { success: false, message: 'A task is already running.' };
  }

  activeTask = { isRunning: true, cancelled: false };

  const logger = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraper:log', msg);
    }
  };

  runTwoGis(config, activeTask, logger)
    .catch((err) => {
      logger(`Error: ${err.message}`);
    })
    .finally(() => {
      if (activeTask) activeTask.isRunning = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scraper:done');
      }
    });

  return { success: true };
});

ipcMain.handle('scraper:stop', async () => {
  if (activeTask) {
    activeTask.cancelled = true;
  }
  return true;
});
