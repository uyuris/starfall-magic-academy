import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog } from 'electron';

import { createServer } from '../app/src/server.mjs';
import { loadLmStudioConfig } from '../app/src/llm/lmStudioClient.mjs';
import { ensureElectronRuntimeWorkspace } from '../app/src/electron/runtimeWorkspace.mjs';
import { listenInternalServer } from '../app/src/electron/runtimeServer.mjs';
import { attachWindowLifecycle, resolveMainWindowEntryUrl, shouldCreateMainWindowOnActivate } from '../app/src/electron/windowLifecycle.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..');
const internalHost = '127.0.0.1';
const internalPort = 41731;

let runtimeServer = null;
let runtimeUrl = null;
let mainWindow = null;
let quitting = false;

function resolveResourceRoot() {
  return app.isPackaged ? app.getAppPath() : repoRoot;
}

function shouldOpenDevTools() {
  return !app.isPackaged || process.env.MAGIC_ACADEMY_ELECTRON_DEVTOOLS === '1';
}

function isSmokeMode() {
  return process.env.MAGIC_ACADEMY_ELECTRON_SMOKE === '1';
}

function createMainWindow(url) {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  attachWindowLifecycle(window, {
    onClosed() {
      if (mainWindow === window) mainWindow = null;
    }
  });
  window.once('ready-to-show', () => window.show());
  window.loadURL(url);
  if (shouldOpenDevTools()) window.webContents.openDevTools({ mode: 'detach' });
  return window;
}

async function stopRuntimeServer() {
  if (!runtimeServer) return;
  const server = runtimeServer;
  runtimeServer = null;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function bootElectronRuntime() {
  const workspace = await ensureElectronRuntimeWorkspace({
    resourceRoot: resolveResourceRoot(),
    userDataRoot: app.getPath('userData')
  });
  const lmStudioConfig = await loadLmStudioConfig(workspace.lmStudioConfigPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  const started = await listenInternalServer({
    server: createServer({
      root: workspace.projectRoot,
      publicRoot: workspace.publicRoot,
      canonicalAssetsRoot: workspace.canonicalAssetsRoot,
      canonicalVisualSetsRoot: workspace.canonicalVisualSetsRoot,
      worldSettingsWriteTarget: 'config',
      characterAuthoringEnabled: false,
      characterAuthoringDisabledReason: 'desktop_runtime_read_only',
      lmStudioConfig,
      lmStudioConfigPath: workspace.lmStudioConfigPath
    }),
    host: internalHost,
    port: internalPort
  });
  runtimeServer = started.server;
  runtimeUrl = started.url;
  return started;
}

async function launch() {
  try {
    const started = await bootElectronRuntime();
    console.log(`STARFALL MAGIC ACADEMY Electron runtime listening on ${started.url}`);
    if (isSmokeMode()) {
      app.quit();
      return;
    }
    const mainWindowEntryUrl = resolveMainWindowEntryUrl({ runtimeUrl: started.url, isPackaged: app.isPackaged });
    mainWindow = createMainWindow(mainWindowEntryUrl);
  } catch (error) {
    console.error(error);
    dialog.showErrorBox('STARFALL MAGIC ACADEMY を起動できません', error?.message ?? String(error));
    await stopRuntimeServer();
    app.exit(1);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (shouldCreateMainWindowOnActivate({ mainWindow, runtimeUrl })) {
    const mainWindowEntryUrl = resolveMainWindowEntryUrl({ runtimeUrl, isPackaged: app.isPackaged });
    mainWindow = createMainWindow(mainWindowEntryUrl);
  }
});

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  stopRuntimeServer()
    .catch((error) => console.error(error))
    .finally(() => app.exit(0));
});

app.whenReady().then(launch);
