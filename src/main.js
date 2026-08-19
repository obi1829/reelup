// Electron main-process entry point: window/protocol bootstrap and IPC
// handler registration. Business logic lives in dedicated modules —
// src/lib/store.js (encrypted settings/history), src/lib/thumbnails.js (RAW
// preview extraction), src/upload-orchestrator.js (drives an upload run),
// src/backends/*.js (per-destination test/upload logic). See CLAUDE.md for
// the overall architecture and the contract new backends must follow.

const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const store = require('./lib/store');
const thumbnails = require('./lib/thumbnails');
const uploadOrchestrator = require('./upload-orchestrator');
// Requiring sftp.js also registers its sftp-browse-* IPC handlers (the
// "browse remote folder" modal) as a side effect of module load.
require('./backends/sftp');

let mainWindow;

// Last-resort net: most async paths already try/catch around network/FS
// calls, but this stops a genuinely unexpected error from silently killing
// the main process (which would take the whole app down) rather than just
// logging it.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

/** Taskbar / window icon: `assets/icon.ico` (Windows) from `npm run icons` → `assets/icon.svg`. */
function resolveAppIcon() {
  const base = path.join(__dirname, '../assets');
  const icoPath = path.join(base, 'icon.ico');
  const pngPath = path.join(base, 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(icoPath)) return icoPath;
  return fs.existsSync(pngPath) ? pngPath : icoPath;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: resolveAppIcon()
  });

  // Maximize before the first paint so there's no flash of the small
  // (900x680) window before it snaps to full size.
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // protocol.registerFileProtocol was removed for Windows-path custom
  // protocols as of Electron 33; protocol.handle + net.fetch is the
  // supported replacement.
  protocol.handle('localfile', (request) => {
    try {
      let filePath = decodeURIComponent(request.url.replace(/^localfile:\/\//i, ''));
      // Renderer uses `localfile:///C:/...`; strip leading slash so Windows gets `C:\...`
      if (process.platform === 'win32' && /^\/[a-z]:/i.test(filePath)) {
        filePath = filePath.slice(1);
      }
      return net.fetch(pathToFileURL(path.normalize(filePath)).toString());
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });

  thumbnails.initTempDir();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => thumbnails.cleanupTempDir());

// ─── Window controls ────────────────────────────────────────────────────────
ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('maximize-window', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('close-window', () => mainWindow.close());

// ─── Settings ─────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => store.getSettings());
ipcMain.handle('save-settings', (event, settings) => store.saveSettings(settings));

// Folder picker. Optional `title` lets callers relabel the dialog (e.g. the
// Local-folder destination picker vs. the source-folder picker).
ipcMain.handle('pick-folder', async (event, opts) => {
  const title = opts && typeof opts.title === 'string' ? opts.title : 'Select folder to upload';
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// ─── Folder scanning ──────────────────────────────────────────────────────
// Fully async (uses fs.promises) so the main process event loop stays
// responsive on huge folders, and yields back to the loop after each
// directory + every N files so other IPC traffic isn't starved. Emits
// a `scan-progress` event every ~120ms with running totals so the
// renderer can display live progress.
const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
  '.tiff', '.tif', '.raw', '.nef', '.cr2', '.cr3', '.arw',
  '.dng', '.orf', '.rw2', '.pef', '.srw',
  '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.3gp'
]);

const SCAN_PROGRESS_INTERVAL_MS = 120;
const SCAN_YIELD_EVERY = 200; // yield to event loop every N entries processed
// stat() calls for one directory's media files run with this many in
// flight at once — still one directory at a time (not fanned out across
// the whole tree, so a slow SD card isn't seeking all over the place), but
// no longer fully serialized within a directory, which matters for a flat
// folder with thousands of files in one place (the common DCIM layout).
const SCAN_STAT_CONCURRENCY = 8;

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function scanFolder(folderPath, onProgress) {
  const files = [];
  let scannedEntries = 0;
  let lastProgressAt = 0;

  const maybeReportProgress = (currentDir, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < SCAN_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    onProgress && onProgress({
      foundFiles: files.length,
      scannedEntries,
      currentDir
    });
  };

  async function statMediaEntries(dir, mediaEntries) {
    let idx = 0;
    async function worker() {
      while (idx < mediaEntries.length) {
        const { entry, ext } = mediaEntries[idx++];
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          files.push({
            path: fullPath,
            name: entry.name,
            size: stat.size,
            ext,
            mtime: stat.mtime
          });
        } catch (e) {
          // Skip files we can't stat (permissions, broken symlinks, …)
        }
        maybeReportProgress(dir);
        if (files.length % SCAN_YIELD_EVERY === 0) {
          await yieldToEventLoop();
        }
      }
    }
    const workerCount = Math.min(SCAN_STAT_CONCURRENCY, mediaEntries.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    const mediaEntries = [];
    for (const entry of entries) {
      scannedEntries++;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        maybeReportProgress(dir);
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(ext)) continue;
      mediaEntries.push({ entry, ext });

      if (scannedEntries % SCAN_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }

    await statMediaEntries(dir, mediaEntries);
  }

  await walk(folderPath);
  maybeReportProgress(folderPath, true);
  return files;
}

ipcMain.handle('scan-folder', async (event, folderPath) => {
  const onProgress = (payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scan-progress', payload);
    }
  };
  const files = await scanFolder(folderPath, onProgress);
  return files;
});

// ─── Upload backends ──────────────────────────────────────────────────────
// This handler just dispatches the unified "test whichever service the user
// configured" flow to the matching backend module (same BACKENDS map the
// orchestrator uses for uploads — see src/upload-orchestrator.js).
ipcMain.handle('test-service', async (event, service) => {
  if (!service || typeof service !== 'object' || !service.type) {
    return { success: false, error: 'Invalid service' };
  }
  const backend = Object.hasOwn(uploadOrchestrator.BACKENDS, service.type)
    ? uploadOrchestrator.BACKENDS[service.type]
    : undefined;
  if (!backend) return { success: false, error: `Unknown service type: ${service.type}` };
  const c = service.config && typeof service.config === 'object' ? service.config : {};
  try {
    return await backend.test(c);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-sftp-pending-session', () => store.getSftpPendingSession());

ipcMain.handle('dismiss-sftp-pending-session', () => {
  store.clearSftpPendingSession();
  return { success: true };
});

// ─── Main upload handler ────────────────────────────────────────────────────
ipcMain.handle('start-upload', (event, payload) => uploadOrchestrator.runUpload(payload, mainWindow));
ipcMain.on('abort-upload', () => uploadOrchestrator.abortUpload());

// ─── RAW thumbnail extraction ───────────────────────────────────────────────
ipcMain.handle('get-raw-thumbnail', (event, filePath) => thumbnails.getRawThumbnail(filePath));
ipcMain.handle('get-raw-thumbnail-large', (event, filePath) => thumbnails.getRawThumbnailLarge(filePath));
ipcMain.handle('get-media-metadata', (event, filePath) => thumbnails.getMediaMetadata(filePath));

// ─── Upload history ───────────────────────────────────────────────────────
ipcMain.handle('get-upload-history', () => store.getUploadHistory());

ipcMain.handle('save-upload-session', (event, session) => {
  try {
    const entry = store.saveUploadSession(session);
    return { success: true, entry };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clear-upload-history', () => {
  store.clearUploadHistory();
  return { success: true };
});
