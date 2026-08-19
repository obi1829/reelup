'use strict';

// Drives an upload run against whichever backend the renderer selected. See
// src/backends/immich.js's header comment (and CLAUDE.md) for the
// test/createSession/uploadFile/closeSession contract every backend in
// BACKENDS implements — this file never branches on backend type beyond
// looking it up in that map, so adding a 6th destination only means adding
// a new backends/*.js module and one line here.

const fs = require('fs');
const immichBackend = require('./backends/immich');
const sftpBackend = require('./backends/sftp');
const nextcloudBackend = require('./backends/nextcloud');
const dropboxBackend = require('./backends/dropbox');
const localBackend = require('./backends/local');
const store = require('./lib/store');

const BACKENDS = {
  immich: immichBackend,
  sftp: sftpBackend,
  nextcloud: nextcloudBackend,
  dropbox: dropboxBackend,
  local: localBackend
};

const RETRY_DELAYS_MS = [2000, 4000, 8000];
// Non-SFTP concurrency has no UI-enforced ceiling (the number input's
// max="10" is a hint, not a guarantee) — a corrupted/hand-edited settings
// value could otherwise spin up an unbounded worker pool.
const CONCURRENCY_CEILING = 20;

let uploadAborted = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortUpload() {
  uploadAborted = true;
}

// Normalizes the payload into { uploadMode, config, serviceIdForPending }.
// Modern callers always send `service`; the direct top-level fields
// (serverUrl/apiKey/sftpHost/...) are a legacy shape kept for backward
// compatibility with any caller that predates the services-array model.
// Nextcloud/Dropbox/Local never had a legacy top-level shape — they've
// always been service-object-only.
function resolveUploadTarget(payload) {
  const {
    service, uploadMode: legacyUploadMode,
    serverUrl, apiKey,
    sftpHost, sftpPort, sftpUser, sftpPassword, sftpBasePath
  } = payload;

  if (service && service.type) {
    return {
      uploadMode: service.type,
      config: service.config && typeof service.config === 'object' ? service.config : {},
      serviceIdForPending: service.id || null
    };
  }

  let config = {};
  if (legacyUploadMode === 'immich') {
    config = { serverUrl, apiKey };
  } else if (legacyUploadMode === 'sftp') {
    config = { host: sftpHost, port: sftpPort, user: sftpUser, password: sftpPassword, basePath: sftpBasePath };
  }
  return { uploadMode: legacyUploadMode, config, serviceIdForPending: null };
}

// Windows taskbar progress bar — purely cosmetic, every call is best-effort.
function createTaskbarProgress(mainWindow) {
  function usable() {
    return process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed();
  }
  return {
    start() {
      if (!usable()) return;
      try { mainWindow.setProgressBar(0); } catch (e) { /* cosmetic taskbar integration only */ }
    },
    update(done, total) {
      if (!usable()) return;
      try { mainWindow.setProgressBar(Math.min(done / Math.max(total, 1), 1)); } catch (e) { /* cosmetic taskbar integration only */ }
    },
    clear() {
      if (!usable()) return;
      try { mainWindow.setProgressBar(-1); } catch (e) { /* cosmetic taskbar integration only */ }
    },
    error() {
      if (!usable()) return;
      try {
        mainWindow.setProgressBar(2, { mode: 'error' });
      } catch (e1) {
        // Older Windows/Electron combos reject mode 2 (indeterminate); fall back to mode 1.
        try { mainWindow.setProgressBar(1, { mode: 'error' }); } catch (e2) { /* cosmetic taskbar integration only */ }
      }
    }
  };
}

async function runUpload(payload, mainWindow) {
  const {
    files, deleteAfterUpload, sourceFolder, concurrency,
    retryWithBackoff = false
  } = payload;

  const { uploadMode, config, serviceIdForPending } = resolveUploadTarget(payload);
  // Object.hasOwn guard: an unexpected uploadMode value (e.g. "constructor")
  // would otherwise resolve an inherited Object.prototype value instead of
  // undefined, and fail confusingly instead of the clear "Unsupported
  // upload destination" error below.
  const backend = Object.hasOwn(BACKENDS, uploadMode) ? BACKENDS[uploadMode] : undefined;

  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(type, data);
  };
  const taskbar = createTaskbarProgress(mainWindow);

  uploadAborted = false;
  let completed = 0;
  let failed = 0;
  let duplicates = 0;
  let deleted = 0;

  taskbar.start();

  if (!backend) {
    taskbar.error();
    send('upload-complete', {
      completed: 0, failed: files.length, duplicates: 0, deleted: 0, total: files.length,
      error: `Unsupported upload destination: ${uploadMode}`
    });
    return;
  }

  let session;
  try {
    session = await backend.createSession(config, {
      onInfo: (message) => send('upload-file-done', { file: message, status: 'info' })
    });
  } catch (e) {
    taskbar.error();
    send('upload-complete', {
      completed: 0, failed: files.length, duplicates: 0, deleted: 0, total: files.length,
      error: `Connection failed: ${e.message}`
    });
    return;
  }

  // Only SFTP supports resuming a killed session (it needs a live
  // reconnect + the file list to pick up where it left off).
  if (uploadMode === 'sftp') {
    store.writeSftpPendingSession({
      sessionId: `sftp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: Date.now(),
      sourceFolder: typeof sourceFolder === 'string' ? sourceFolder : '',
      files: files.map(store.serializePendingFile),
      serviceId: serviceIdForPending,
      sftpHost: config.host,
      sftpPort: parseInt(config.port, 10) || 22,
      sftpUser: config.user,
      sftpPassword: config.password,
      sftpBasePath: config.basePath,
      totalCount: files.length,
      processedCount: 0,
      deleteAfterUpload: !!deleteAfterUpload
    });
    store.updateSftpPendingProcessed(0);
  }

  // electron-store's .set() re-serializes and re-encrypts the *entire*
  // store (settings + this blob + upload history) and writes it to disk
  // synchronously — doing that after every single file on a large SFTP run
  // measurably stalls the main thread. Throttle to ~1/s; pass `force` for
  // the final write so the persisted resume state is never more than one
  // throttle window stale.
  const SFTP_PENDING_WRITE_INTERVAL_MS = 1000;
  let lastPendingWriteAt = 0;
  const persistSftpProgressCounters = (force = false) => {
    if (uploadMode !== 'sftp') return;
    const now = Date.now();
    if (!force && now - lastPendingWriteAt < SFTP_PENDING_WRITE_INTERVAL_MS) return;
    lastPendingWriteAt = now;
    store.updateSftpPendingProcessed(completed + duplicates + failed);
  };

  async function applyResult(file, result) {
    if (result.duplicate) {
      duplicates++;
      send('upload-file-done', { file: file.name, path: file.path, status: 'duplicate' });
      return;
    }
    completed++;
    const detail = result.remotePath
      ? String(result.remotePath).split('/').slice(-3).join('/')
      : '';
    send('upload-file-done', { file: file.name, path: file.path, status: 'success', detail });

    if (deleteAfterUpload) {
      try {
        await fs.promises.unlink(file.path);
        deleted++;
      } catch (err) { /* best effort */ }
    }
  }

  function reportProgress(file) {
    send('upload-progress', {
      file: file.name, path: file.path, completed, failed, duplicates, total: files.length
    });
  }

  async function attemptOnce(file) {
    const result = await backend.uploadFile(session, file);
    await applyResult(file, result);
  }

  async function processFileOnce(file) {
    try {
      await attemptOnce(file);
    } catch (e) {
      failed++;
      send('upload-file-done', { file: file.name, path: file.path, status: 'error', error: e.message });
    }
  }

  async function processFileWithRetry(file) {
    let lastError = null;
    let ok = false;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (uploadAborted) return;
      if (attempt > 0) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        send('upload-file-done', {
          file: file.name, path: file.path, status: 'info',
          detail: `Retry ${attempt}/3 after ${RETRY_DELAYS_MS[attempt - 1] / 1000}s backoff…`
        });
      }
      try {
        await attemptOnce(file);
        ok = true;
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!ok) {
      failed++;
      const msg = lastError && lastError.message ? lastError.message : 'Upload failed after 3 retries';
      send('upload-file-done', { file: file.name, path: file.path, status: 'error', error: msg, exhaustedRetries: true });
    }
  }

  async function processFile(file) {
    if (uploadAborted) return;
    reportProgress(file);

    if (retryWithBackoff) {
      await processFileWithRetry(file);
    } else {
      await processFileOnce(file);
    }

    reportProgress(file);
    persistSftpProgressCounters();
    taskbar.update(completed + duplicates + failed, files.length);
  }

  const requestedConcurrency = Number(concurrency) || 1;
  const actualConcurrency = Math.max(1, Math.min(
    uploadMode === 'sftp' ? Math.min(requestedConcurrency, 4) : requestedConcurrency,
    CONCURRENCY_CEILING
  ));

  const queue = [...files];
  async function runPool() {
    const workers = Array.from({ length: actualConcurrency }, async () => {
      while (queue.length > 0 && !uploadAborted) {
        const file = queue.shift();
        if (file) await processFile(file);
      }
    });
    // allSettled (not all) so a single worker throwing — e.g. a disk-full
    // store.set() inside persistSftpProgressCounters — can't leave the other
    // workers still silently uploading files in the background after this
    // function has already returned/thrown.
    const results = await Promise.allSettled(workers);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  // Every file-level failure is already caught inside processFile — a throw
  // here means something broke outside that (most likely a disk write
  // failing inside persistSftpProgressCounters). Cleanup and upload-complete
  // must still happen so the renderer's isUploading flag always clears
  // instead of leaving the UI stuck mid-upload with no way to retry/abort.
  let runError = null;
  try {
    await runPool();
  } catch (e) {
    runError = e;
  } finally {
    try {
      await backend.closeSession(session);
    } catch (e) {
      // Best-effort cleanup — don't let a close failure mask runError or
      // block upload-complete from firing below.
    }
  }

  // Only clear resume state on a genuinely clean finish — if the run itself
  // errored out, keep the pending session so the user can still resume, but
  // force one final (un-throttled) write first so the resume count reflects
  // exactly how far the run actually got.
  if (uploadMode === 'sftp') {
    if (!uploadAborted && !runError) {
      store.clearSftpPendingSession();
    } else {
      persistSftpProgressCounters(true);
    }
  }

  if (runError || (!uploadAborted && failed > 0)) taskbar.error();
  else taskbar.clear();

  send('upload-complete', {
    completed, failed, duplicates, deleted, total: files.length,
    ...(runError ? { error: `Upload run failed: ${runError.message}` } : {})
  });
  return { completed, failed, duplicates, deleted };
}

module.exports = { runUpload, abortUpload, BACKENDS };
