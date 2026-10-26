import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { BackendManager, ensureDir } from './backend';
import { IPC, type BackendStatus } from './ipc-channels';
import { Logger } from './logger';

const repoRoot = path.join(__dirname, '..');
const isPackaged = app.isPackaged;
const dataDir =
  process.env.VL_DATA_DIR ??
  path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'VideoLessons');
const logsDir = path.join(dataDir, 'logs');
const resourcesDir = process.env.VL_RESOURCES_DIR
  ? path.resolve(process.env.VL_RESOURCES_DIR)
  : isPackaged
    ? process.resourcesPath
    : path.join(repoRoot, 'resources');
const packagedApp = isPackaged || process.env.VL_PACKAGED === '1';

// userData не должен зависеть от прав на ~/.config (и от чужого экземпляра)
if (process.env.VL_DATA_DIR) {
  app.setPath('userData', path.join(dataDir, 'electron'));
}

ensureDir(logsDir);
ensureDir(dataDir);
const logger = new Logger(logsDir);
logger.info(`VideoLessons starting packaged=${packagedApp} dataDir=${dataDir}`);

let mainWindow: BrowserWindow | null = null;
let backend: BackendManager | null = null;
let backendStatus: BackendStatus = 'starting';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function sendStatus(status: BackendStatus): void {
  backendStatus = status;
  mainWindow?.webContents.send(IPC.backendStatus, status);
}

function hardenSession(): void {
  const devUrl = process.env.VL_DEV_URL;
  const csp = devUrl
    ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:; media-src 'self' blob: http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:*; font-src 'self' data:; object-src 'none'; frame-src 'none'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'Referrer-Policy': ['no-referrer'],
      },
    });
  });
}

function createWindow(baseUrl: string): void {
  const devUrl = process.env.VL_DEV_URL;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#111827',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const target = devUrl ?? baseUrl;
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    logger.info(`startup.window_visible elapsedMs=${Date.now() - startedAt}`);
  });
  const capturePath = process.env.VL_CAPTURE_PATH;
  if (capturePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void mainWindow?.webContents
          .capturePage()
          .then((image) => {
            fs.writeFileSync(capturePath, image.toPNG());
            logger.info(`screenshot saved: ${capturePath}`);
          })
          .finally(() => app.quit());
      }, 1500);
    });
  }
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    logger.error(`Failed to load ${target}: ${code} ${description}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`Renderer gone: ${details.reason}`);
  });
  void mainWindow.loadURL(target);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const startedAt = Date.now();

app.whenReady().then(async () => {
  hardenSession();
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const allowed = url.startsWith('http://127.0.0.1');
      if (!allowed && !url.startsWith('http://localhost')) {
        event.preventDefault();
        if (/^https?:/i.test(url)) void shell.openExternal(url);
      }
    });
  });

  registerIpc();

  backend = new BackendManager({
    isPackaged: packagedApp,
    resourcesDir,
    dataDir,
    repoRoot,
    logger,
    onStatus: sendStatus,
  });

  try {
    const info = await backend.start();
    logger.info(`Backend ready at ${info.baseUrl}`);
    createWindow(info.baseUrl);
  } catch (error) {
    logger.error(`Backend failed to start: ${String(error)}`);
    await dialog.showMessageBox({
      type: 'error',
      title: 'VideoLessons',
      message: 'Не удалось запустить backend',
      detail: String(error),
    });
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backend) {
      try {
        createWindow(backend.getInfo().baseUrl);
      } catch {
        /* backend not ready */
      }
    }
  });
});

function registerIpc(): void {
  ipcMain.handle(IPC.backendGet, () => {
    if (!backend) throw new Error('Backend manager is not initialised');
    try {
      return backend.getInfo();
    } catch (error) {
      throw new Error(`Backend is not ready (status=${backendStatus}): ${String(error)}`);
    }
  });

  ipcMain.handle(IPC.openFiles, async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Добавить видео в анализ',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(IPC.openFolder, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выбрать папку',
      properties: ['openDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.reveal, (_event, filePath: string) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle(IPC.openExternal, async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    dataDir,
    logsDir,
  }));

  ipcMain.on(IPC.log, (_event, level: string, message: string) => {
    const text = `[renderer] ${String(message)}`;
    if (level === 'error') logger.error(text);
    else if (level === 'warn') logger.warn(text);
    else logger.info(text);
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (!backend) return;
  event.preventDefault();
  const current = backend;
  backend = null;
  logger.info('Shutting down backend before quit');
  void current.stop().finally(() => app.quit());
});

process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
