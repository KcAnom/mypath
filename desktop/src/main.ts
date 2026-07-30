/**
 * MyPath Desktop — Electron main process (local solo)
 */
import { app, BrowserWindow, shell } from 'electron';
import { resolve } from 'node:path';

const APP_URL = process.env.MYPATH_APP_ORIGIN || 'http://127.0.0.1:8787/';

let mainWindow: BrowserWindow | null = null;

function desktopInfoArgument(): string {
  const info = {
    channel: 'local',
    platform: process.platform,
    version: app.getVersion(),
  };
  return `--mypath-desktop-info=${JSON.stringify(info)}`;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    title: 'MyPath',
    center: true,
    show: false,
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      additionalArguments: [desktopInfoArgument()],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
      shell.openExternal(url).catch(console.error);
    }
    return { action: 'deny' };
  });

  window.loadURL(process.env.MYPATH_DESKTOP_URL || APP_URL);
  return window;
}

app.setName('MyPath');

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    mainWindow = createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    mainWindow = null;
    if (process.platform !== 'darwin') app.quit();
  });
}
