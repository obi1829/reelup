  // ─── Summary card (left sidebar, pinned to bottom) ──
  let liveUploadMbps = null; // set during an active upload, reset after

  // ─── Rolling throughput window ────────────────────────
  // We keep a sliding 5-second window of `(timestamp, cumulativeBytes)`
  // samples so the displayed MB/s reflects current network speed, not
  // the session-average. Samples are pushed every time bytes complete
  // and the speed is recomputed inside the throttled progress flusher.
  const SPEED_WINDOW_MS = 5000;
  const speedSamples = []; // [{ at: ms, bytes: cumulativeBytes }]

  function resetSpeedSamples() {
    speedSamples.length = 0;
  }

  function recordSpeedSample() {
    const now = performance.now();
    speedSamples.push({ at: now, bytes: uploadBytesDone });
    // Bound memory — keep at most one stale sample (the anchor just before
    // the window starts) plus everything inside the window.
    const cutoff = now - SPEED_WINDOW_MS;
    while (speedSamples.length > 2 && speedSamples[1].at < cutoff) {
      speedSamples.shift();
    }
  }

  // MB/s over the rolling window. Returns 0 when we don't have enough
  // signal yet (need ≥0.5s of activity and ≥2 samples).
  function rollingMbps() {
    if (speedSamples.length < 2) return 0;
    const now = performance.now();
    const windowStart = now - SPEED_WINDOW_MS;

    // Anchor sample: the most recent one at or before the window's start.
    // Falls back to the oldest sample we have if the entire history is
    // still inside the window (just after upload begins).
    let anchor = speedSamples[0];
    for (let i = 0; i < speedSamples.length; i++) {
      if (speedSamples[i].at <= windowStart) anchor = speedSamples[i];
      else break;
    }
    const last = speedSamples[speedSamples.length - 1];
    const elapsed = (last.at - anchor.at) / 1000;
    if (elapsed < 0.5) return 0;
    const bytes = Math.max(0, last.bytes - anchor.bytes);
    return (bytes / (1024 * 1024)) / elapsed;
  }

  function formatMbps(mbps) {
    if (!isFinite(mbps) || mbps <= 0) return '—';
    if (mbps < 1) return `${(mbps * 1024).toFixed(0)} KB/s`;
    if (mbps < 10) return `${mbps.toFixed(1)} MB/s`;
    return `${Math.round(mbps)} MB/s`;
  }

  let tileErrorPopoverCleanup = null;

  function hideUploadErrorPopover() {
    const el = document.getElementById('tileErrorPopover');
    if (el) el.setAttribute('hidden', '');
    if (tileErrorPopoverCleanup) {
      tileErrorPopoverCleanup();
      tileErrorPopoverCleanup = null;
    }
  }

  function showUploadErrorPopover(anchorTile, message) {
    const el = document.getElementById('tileErrorPopover');
    if (!el) return;
    hideUploadErrorPopover();
    el.textContent = message;
    el.removeAttribute('hidden');

    const place = () => {
      const r = anchorTile.getBoundingClientRect();
      const pr = el.getBoundingClientRect();
      let top = r.bottom + 8;
      if (top + pr.height > window.innerHeight - 12) {
        top = Math.max(8, r.top - pr.height - 8);
      }
      let left = Math.min(Math.max(8, r.left), window.innerWidth - pr.width - 8);
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
    };

    requestAnimationFrame(() => {
      place();
      requestAnimationFrame(place);
    });

    const onDoc = (ev) => {
      if (el.contains(ev.target) || anchorTile.contains(ev.target)) return;
      hideUploadErrorPopover();
    };
    setTimeout(() => {
      document.addEventListener('click', onDoc, true);
      tileErrorPopoverCleanup = () => document.removeEventListener('click', onDoc, true);
    }, 0);
  }

  function formatSelectedTypeBreakdown() {
    const counts = new Map();
    for (const f of scannedFiles) {
      if (!f.selected) continue;
      const raw = (f.ext || '').replace(/^\./, '');
      const label = raw ? raw.toUpperCase() : 'FILE';
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    if (counts.size === 0) return '—';
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([ext, n]) => `${n} ${ext}`)
      .join(' · ');
  }

  function updateSummaryCard() {
    const filesEl = document.getElementById('summaryFiles');
    const sizeEl = document.getElementById('summarySize');
    const typesEl = document.getElementById('summaryTypes');
    const timeRow = document.getElementById('summaryTimeRow');
    if (!filesEl) return;

    const sel = selectedCount;
    const total = scannedFiles.length;
    const bytes = selectedBytes;

    if (total === 0) {
      filesEl.textContent = '—';
      sizeEl.textContent = '—';
      if (typesEl) typesEl.textContent = '—';
      if (timeRow) timeRow.hidden = true;
      return;
    }

    filesEl.textContent = sel === total ? `${total}` : `${sel} of ${total}`;
    sizeEl.textContent = formatBytes(bytes);
    if (typesEl) typesEl.textContent = sel === 0 ? '—' : formatSelectedTypeBreakdown();

    if (!isUploading) {
      if (timeRow) timeRow.hidden = true;
      return;
    }

    if (timeRow) timeRow.hidden = false;
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '—';
    if (sec < 1) return '<1 sec';
    if (sec < 60) return `~${Math.round(sec)} sec`;
    const totalMin = Math.round(sec / 60);
    if (totalMin < 60) {
      const rs = Math.round(sec % 60);
      const m = Math.floor(sec / 60);
      return rs > 0 && m < 10 ? `~${m} min ${rs} sec` : `~${totalMin} min`;
    }
    const hr = Math.floor(totalMin / 60);
    const rm = totalMin % 60;
    return rm > 0 ? `~${hr} hr ${rm} min` : `~${hr} hr`;
  }

  // Lookup a scanned file's size by name (uses the first non-finalised match
  // to mirror setTileStatus's behaviour for duplicate filenames). O(1) via
  // the nameToIdx map.
  function fileSizeByName(name) {
    const bucket = nameToIdx.get(name);
    if (!bucket) return 0;
    for (const idx of bucket) {
      const f = scannedFiles[idx];
      if (f) return f.size || 0;
    }
    return 0;
  }

  function registerUploadedBytes(name) {
    uploadBytesDone += fileSizeByName(name);
    recordSpeedSample();
  }

  function refreshLiveThroughput() {
    if (!isUploading || !uploadStartTime) return;

    // Drive both the summary card and the progress-bar speed/ETA from
    // the same rolling-window measurement so the numbers stay coherent.
    const mbps = rollingMbps();
    liveUploadMbps = mbps > 0 ? mbps : liveUploadMbps;

    const bytesRemaining = Math.max(0, uploadTotalBytes - uploadBytesDone);
    const effectiveMbps = mbps > 0
      ? mbps
      : (liveUploadMbps && liveUploadMbps > 0 ? liveUploadMbps : 0);
    const etaSec = effectiveMbps > 0
      ? bytesRemaining / (effectiveMbps * 1024 * 1024)
      : Infinity;

    // ─── Progress bar speed + ETA ───
    const speedEl = document.getElementById('progressSpeed');
    const etaEl   = document.getElementById('progressEta');
    if (speedEl) {
      const display = formatMbps(mbps);
      speedEl.textContent = display;
      speedEl.classList.toggle('idle', display === '—');
    }
    if (etaEl) {
      etaEl.textContent = effectiveMbps > 0 && isFinite(etaSec)
        ? `${formatDuration(etaSec)} remaining`
        : '';
    }

    // ─── Summary card ───
    const filesEl = document.getElementById('summaryFiles');
    const sizeEl = document.getElementById('summarySize');
    const timeEl = document.getElementById('summaryTime');
    const timeLabel = document.getElementById('summaryTimeLabel');
    if (!filesEl) return;

    const remaining = stats.total - (stats.success + stats.error + stats.duplicate);
    filesEl.textContent = `${remaining} left`;
    sizeEl.textContent = formatBytes(bytesRemaining);
    if (effectiveMbps > 0 && isFinite(etaSec)) {
      timeEl.textContent = formatDuration(etaSec);
      timeLabel.textContent = 'Est. remaining';
    } else {
      timeEl.textContent = '—';
      timeLabel.textContent = 'Est. remaining';
    }
  }

  // Update the first not-yet-finalised file with this name. O(1) lookup +
  // we only touch the DOM if the tile is currently in the visible window.
  function setTileStatus(name, status, extra = {}) {
    const bucket = nameToIdx.get(name);
    if (!bucket) return -1;
    for (const i of bucket) {
      const f = scannedFiles[i];
      if (!f) continue;
      if (f.status === 'success' || f.status === 'failed' || f.status === 'duplicate-status') continue;
      f.status = status;
      if (status === 'failed' && extra.error != null) {
        f.uploadError = String(extra.error);
      } else if (status !== 'failed') {
        delete f.uploadError;
      }
      const tile = tilesByIdx.get(i);
      if (tile) {
        applyTileUploadStatusClass(tile, status);
        const statusEl = tile.querySelector('[data-tile-status]');
        // statusIconForTile looks up a fixed STATUS_ICONS table — never echoes its argument.
        // eslint-disable-next-line no-unsanitized/property
        if (statusEl) statusEl.innerHTML = status ? statusIconForTile(status) : '';
        syncTileAria(tile, f);
      }
      refreshFocusedDetailsPaneIfStale(i);
      return i;
    }
    return -1;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function resetTileStatuses() {
    for (let i = 0; i < scannedFiles.length; i++) {
      scannedFiles[i].status = null;
      delete scannedFiles[i].uploadError;
    }
    for (const [, tile] of tilesByIdx) {
      applyTileUploadStatusClass(tile, '');
      const statusEl = tile.querySelector('[data-tile-status]');
      if (statusEl) statusEl.innerHTML = '';
    }
    if (detailFocusedIdx !== null) {
      const f = scannedFiles[detailFocusedIdx];
      if (f) updatePhotoDetailsUploadSection(f);
    }
  }

  // ─── Drag and drop on drop zone ──────────────────────
  const dropZone = document.getElementById('dropZone');

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (isUploading) return;
    const items = [...e.dataTransfer.items];
    for (const item of items) {
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry && entry.isDirectory) {
          await loadFolder(entry.fullPath || e.dataTransfer.files[0].path);
          break;
        }
      }
    }
  });

  // ─── Upload ──────────────────────────────────────────
  // Tracks the in-flight upload's per-file outcomes so we can persist them
  // to history when the session ends. Cleared at the start of each upload.
  let currentSession = null;
  let lastAbortRequested = false;

  function destinationLabelFromService(svc) {
    if (!svc) return '—';
    const c = svc.config || {};
    switch (svc.type) {
      case 'immich':
        return (c.serverUrl || 'Immich').replace(/\/$/, '');
      case 'sftp':
        return `${c.host || 'sftp'}${c.basePath ? ':' + c.basePath : ''}`;
      case 'nextcloud':
        return (c.serverUrl || 'Nextcloud').replace(/\/$/, '');
      case 'dropbox':
        return 'Dropbox';
      case 'local':
        return c.destPath || 'Local folder';
      default:
        return svc.label || svc.type;
    }
  }

  function sessionModeLabel(svc) {
    if (!svc) return 'Service';
    switch (svc.type) {
      case 'immich': return 'Immich Library';
      case 'sftp': return 'SFTP';
      case 'nextcloud': return 'Nextcloud (WebDAV)';
      case 'dropbox': return 'Dropbox';
      case 'local': return 'Local folder';
      default: return svc.label || 'Service';
    }
  }

  function serviceConfigured(svc) {
    if (!svc || svc.enabled === false) return false;
    const c = svc.config || {};
    switch (svc.type) {
      case 'immich':
        return !!(c.serverUrl && c.apiKey);
      case 'sftp':
        return !!(c.host && c.user);
      case 'nextcloud':
        return !!(c.serverUrl && c.username);
      case 'dropbox':
        return !!(c.accessToken && String(c.accessToken).trim());
      case 'local':
        return !!(c.destPath && String(c.destPath).trim());
      default:
        return false;
    }
  }

  function recordSessionFile(name, status, extra = {}) {
    if (!currentSession) return;
    const size = fileSizeByName(name) || 0;
    currentSession.files.push({
      name,
      size,
      status,
      detail: extra.detail || '',
      error: extra.error || ''
    });
  }

  // Retry / resume upload support
  let lastUploadBatchFiles = [];
  let failedFilesForRetry = [];
  let lastRetryCandidates = [];
  let pendingResumePayload = null;

  function revivePendingFile(raw) {
    return {
      path: String(raw.path || ''),
      name: String(raw.name || ''),
      size: Number(raw.size) || 0,
      ext: String(raw.ext || ''),
      mtime: raw.mtime ? new Date(raw.mtime) : new Date(),
      selected: !!raw.selected,
      status: null
    };
  }

  function findScannedByPath(p) {
    if (!p) return null;
    return scannedFiles.find(sf => sf.path === p) || null;
  }

  function dedupeFilesByPath(list) {
    const m = new Map();
    for (const f of list) {
      if (f && f.path) m.set(f.path, f);
    }
    return [...m.values()];
  }

  function fileRefFromUploadPayload(data) {
    if (data.path) return findScannedByPath(data.path);
    const bucket = nameToIdx.get(data.file);
    if (!bucket) return null;
    for (const idx of bucket) {
      const f = scannedFiles[idx];
      if (f) return f;
    }
    return null;
  }

  function buildRetryCandidatesFromFinish(data) {
    const fromEvents = dedupeFilesByPath(failedFilesForRetry);
    if (fromEvents.length > 0) return fromEvents;
    if ((data.failed > 0 || data.error) && lastUploadBatchFiles.length > 0) {
      return lastUploadBatchFiles.slice();
    }
    return [];
  }

  function hydrateGridFromResumeSession(session) {
    thumbnailCache.clear();
    mediaDimensionsCache.clear();
    clearDetailTileFocus();
    selectionCircleAnchorIdx = null;
    scannedFiles = (session.files || []).map(raw => revivePendingFile(raw));
    for (const f of scannedFiles) f.selected = true;
    rebuildNameIndex();
    rebuildPhotoDateGroups();
    selectionCircleAnchorIdx = flattenedDisplayOrder.length
      ? flattenedDisplayOrder[flattenedDisplayOrder.length - 1]
      : null;
    recomputeSelectionCounters();
    const folder = session.sourceFolder || '';
    if (folder) selectedFolder = folder;
    document.getElementById('folderPath').textContent = folder || '—';
    document.getElementById('folderInfo').classList.add('visible');
    document.getElementById('totalCount').textContent = scannedFiles.length;
    document.getElementById('completeBanner').classList.remove('visible', 'has-errors');
    renderPhotoGrid();
    updateSummaryCard();
    updateSelectionUi();
    setView('photos');
  }

  async function checkPendingResumeOnLaunch() {
    try {
      const p = await window.api.getSftpPendingSession();
      if (!p || !Array.isArray(p.files) || !p.files.length) return;
      const total = Number(p.totalCount) || p.files.length;
      const done = Math.min(Number(p.processedCount) || 0, total);
      pendingResumePayload = p;
      const bn = document.getElementById('resumeBanner');
      const tx = document.getElementById('resumeBannerText');
      const folder = p.sourceFolder || '(unknown folder)';
      tx.textContent = `Incomplete upload found — ${done} of ${total} files from ${folder}. Resume?`;
      bn.classList.add('is-visible');
    } catch (e) {
      pendingResumePayload = null;
    }
  }

  async function dismissPendingUpload() {
    pendingResumePayload = null;
    const bn = document.getElementById('resumeBanner');
    if (bn) bn.classList.remove('is-visible');
    try {
      await window.api.dismissSftpPendingSession();
    } catch (e) { /* banner is already hidden; persistence is best-effort */ }
  }

  async function resumePendingUpload() {
    const p = pendingResumePayload;
    if (!p || isUploading) return;
    const bn = document.getElementById('resumeBanner');
    if (bn) bn.classList.remove('is-visible');
    pendingResumePayload = null;

    const del = !!p.deleteAfterUpload;
    const delEl = document.getElementById('deleteAfterUpload');
    if (delEl) delEl.checked = del;

    if (p.serviceId && localServices.some((s) => s.id === p.serviceId)) {
      activeServiceId = p.serviceId;
    } else {
      const sf = localServices.find((s) => s.type === 'sftp');
      if (sf) activeServiceId = sf.id;
    }
    renderUploadDestinationButtons();

    hydrateGridFromResumeSession(p);

    await beginUploadSession(scannedFiles.slice(), {
      retryWithBackoff: false,
      sourceFolderOverride: p.sourceFolder ?? '',
      sftpOverride: {
        sftpHost: p.sftpHost,
        sftpPort: p.sftpPort,
        sftpUser: p.sftpUser,
        sftpPassword: p.sftpPassword,
        sftpBasePath: p.sftpBasePath
      },
      deleteAfterOverride: del
    });
  }

  async function retryFailedUpload() {
    if (isUploading) return;
    const raw = dedupeFilesByPath(lastRetryCandidates);
    if (raw.length === 0) return;
    const files = raw.map(f => revivePendingFile(f));
    const rb = document.getElementById('retryFailedBtn');
    if (rb) rb.style.display = 'none';
    await beginUploadSession(files, { retryWithBackoff: true });
  }

  async function startUpload() {
    if (isUploading) return;
    const filesToUpload = scannedFiles.filter(f => f.selected);
    if (filesToUpload.length === 0) return;
    await beginUploadSession(filesToUpload, { retryWithBackoff: false });
  }

  async function beginUploadSession(filesToUpload, opts = {}) {
    if (isUploading) return;
    const {
      retryWithBackoff = false,
      sourceFolderOverride = null,
      sftpOverride = null,
      deleteAfterOverride = null
    } = opts;

    if (filesToUpload.length === 0) return;

    const settings = await window.api.getSettings();

    let uploadService;
    if (sftpOverride && sftpOverride.sftpHost) {
      uploadService = {
        id: 'resume',
        type: 'sftp',
        label: 'SFTP',
        enabled: true,
        connectionVerified: true,
        config: {
          host: sftpOverride.sftpHost,
          port: sftpOverride.sftpPort ?? 22,
          user: sftpOverride.sftpUser,
          password: sftpOverride.sftpPassword,
          basePath: sftpOverride.sftpBasePath
        }
      };
    } else {
      for (const x of localServices) syncServiceFromDom(x.id);
      const svc = getServiceById(activeServiceId);
      if (!svc || !svc.enabled) {
        addLog('error', 'No upload destination', 'Pick a service under Upload To or open Settings');
        openSettings('section-services');
        return;
      }
      if (!serviceConfigured(svc)) {
        addLog('error', 'Service not configured', 'Complete connection details in Settings → Services');
        openSettings('section-services');
        return;
      }
      uploadService = cloneService(svc);
    }

    failedFilesForRetry = [];
    lastRetryCandidates = [];
    lastUploadBatchFiles = filesToUpload.map(f => ({
      path: f.path,
      name: f.name,
      size: f.size || 0,
      ext: f.ext || '',
      mtime: f.mtime instanceof Date ? f.mtime : new Date(f.mtime || Date.now())
    }));

    isUploading = true;
    lastAbortRequested = false;
    stats = { success: 0, error: 0, duplicate: 0, total: filesToUpload.length };

    const summaryTimeRowEl = document.getElementById('summaryTimeRow');
    if (summaryTimeRowEl) summaryTimeRowEl.hidden = false;

    uploadStartTime = Date.now();
    uploadBytesDone = 0;
    uploadTotalBytes = filesToUpload.reduce((n, f) => n + (f.size || 0), 0);
    liveUploadMbps = null;
    resetSpeedSamples();
    recordSpeedSample();

    const folderLabel = sourceFolderOverride !== null && sourceFolderOverride !== undefined
      ? sourceFolderOverride
      : (selectedFolder || '');

    currentSession = {
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      mode: uploadService.type,
      destination: destinationLabelFromService(uploadService),
      sourceFolder: folderLabel,
      totalBytes: uploadTotalBytes,
      files: []
    };

    document.getElementById('uploadBtn').style.display = 'none';
    document.getElementById('abortBtn').style.display = 'block';
    document.getElementById('abortBtn').disabled = false;
    document.getElementById('completeBanner').classList.remove('visible', 'has-errors');
    const retryBtn0 = document.getElementById('retryFailedBtn');
    if (retryBtn0) retryBtn0.style.display = 'none';
    document.getElementById('progressWrap').style.display = 'block';
    setProgressFill(0);
    document.getElementById('progressLabel').textContent = 'Preparing…';
    document.getElementById('progressPct').textContent = `0 / ${stats.total}`;
    const speedEl0 = document.getElementById('progressSpeed');
    if (speedEl0) { speedEl0.textContent = '—'; speedEl0.classList.add('idle'); }
    document.getElementById('progressEta').textContent = '';
    clearLog();
    updateBadges();
    resetTileStatuses();

    const uploadSet = new Set(filesToUpload.map(f => f.path));
    for (let i = 0; i < scannedFiles.length; i++) {
      const f = scannedFiles[i];
      if (!uploadSet.has(f.path)) continue;
      f.status = 'queued';
      const tile = tilesByIdx.get(i);
      if (tile) {
        applyTileUploadStatusClass(tile, 'queued');
        const statusEl = tile.querySelector('[data-tile-status]');
        // statusIconForTile looks up a fixed STATUS_ICONS table — never echoes its argument.
        // eslint-disable-next-line no-unsanitized/property
        if (statusEl) statusEl.innerHTML = statusIconForTile('queued');
      }
    }

    const modeLabel = sessionModeLabel(uploadService);
    const startMsg = retryWithBackoff
      ? `Retry with backoff (${filesToUpload.length} file${filesToUpload.length === 1 ? '' : 's'}) via ${modeLabel}`
      : `Starting upload of ${filesToUpload.length} files via ${modeLabel}`;
    addLog('info', startMsg, '');

    window.api.on('upload-file-done', (data) => {
      if (data.status === 'success') {
        stats.success++;
        queueLog('success', data.file, data.detail || 'uploaded');
        setTileStatus(data.file, 'success');
        registerUploadedBytes(data.file);
        recordSessionFile(data.file, 'success', { detail: data.detail || '' });
      } else if (data.status === 'duplicate') {
        stats.duplicate++;
        queueLog('duplicate', data.file, 'already exists');
        setTileStatus(data.file, 'duplicate-status');
        registerUploadedBytes(data.file);
        recordSessionFile(data.file, 'duplicate', { detail: 'already exists' });
      } else if (data.status === 'info') {
        queueLog('info', data.file, data.detail || '');
      } else {
        stats.error++;
        const errLine = data.exhaustedRetries
          ? `Failed after 3 retries: ${data.error || 'unknown error'}`
          : (data.error || 'failed');
        queueLog('error', data.file, errLine);
        setTileStatus(data.file, 'failed', { error: data.error || 'failed' });
        recordSessionFile(data.file, 'failed', { error: data.error || 'failed' });
        const ref = fileRefFromUploadPayload(data);
        if (ref) {
          failedFilesForRetry.push({
            path: ref.path,
            name: ref.name,
            size: ref.size || 0,
            ext: ref.ext || '',
            mtime: ref.mtime instanceof Date ? ref.mtime : new Date(ref.mtime || Date.now())
          });
        }
      }
      scheduleProgressFlush();
    });

    window.api.on('upload-progress', (data) => {
      currentUploadingFile = data.file;
      setTileStatus(data.file, 'uploading');
      scheduleProgressFlush();
    });

    window.api.on('upload-complete', (data) => {
      flushProgressNow();
      finishUpload(data);
    });

    const deleteAfter = deleteAfterOverride !== null && deleteAfterOverride !== undefined
      ? !!deleteAfterOverride
      : document.getElementById('deleteAfterUpload').checked;

    await window.api.startUpload({
      files: filesToUpload,
      uploadMode: uploadService.type,
      service: uploadService,
      serverUrl: settings.serverUrl,
      apiKey: settings.apiKey,
      sftpHost: settings.sftpHost,
      sftpPort: settings.sftpPort,
      sftpUser: settings.sftpUser,
      sftpPassword: settings.sftpPassword,
      sftpBasePath: settings.sftpBasePath,
      concurrency: parseInt(document.getElementById('concurrency').value) || 4,
      deleteAfterUpload: deleteAfter,
      sourceFolder: folderLabel,
      retryWithBackoff
    });
  }

  async function finishUpload(data) {
    isUploading = false;
    window.api.off('upload-file-done');
    window.api.off('upload-progress');
    window.api.off('upload-complete');

    // Clear any tiles still stuck in "queued" / "uploading" (aborted or skipped paths)
    for (let i = 0; i < scannedFiles.length; i++) {
      const f = scannedFiles[i];
      if (f.status !== 'queued' && f.status !== 'uploading') continue;
      f.status = null;
      const tile = tilesByIdx.get(i);
      if (!tile) continue;
      applyTileUploadStatusClass(tile, '');
      const statusEl = tile.querySelector('[data-tile-status]');
      if (statusEl) statusEl.innerHTML = '';
    }

    document.getElementById('uploadBtn').style.display = 'block';
    document.getElementById('abortBtn').style.display = 'none';
    setProgressFill(100);
    document.getElementById('progressLabel').textContent = 'Upload complete';
    document.getElementById('progressPct').textContent = `${data.total} files processed`;
    const speedElDone = document.getElementById('progressSpeed');
    if (speedElDone) { speedElDone.textContent = '—'; speedElDone.classList.add('idle'); }
    document.getElementById('progressEta').textContent = '';
    resetSpeedSamples();

    liveUploadMbps = null;
    updateSelectionUi();

    const banner = document.getElementById('completeBanner');
    banner.classList.add('visible');
    const hasErrors = data.failed > 0 || !!data.error;
    banner.classList.toggle('has-errors', hasErrors);
    document.getElementById('bannerTitle').textContent = hasErrors ? 'Upload Finished with Errors' : 'Upload Complete!';
    let bannerSubText =
      `${data.completed} uploaded · ${data.duplicates} skipped · ${data.failed} failed` +
      (data.deleted > 0 ? ` · ${data.deleted} deleted from source` : '');
    if (data.error) bannerSubText += ` — ${data.error}`;
    document.getElementById('bannerSub').textContent = bannerSubText;

    lastRetryCandidates = buildRetryCandidatesFromFinish(data);
    const retryBtn = document.getElementById('retryFailedBtn');
    if (retryBtn) {
      const showRetry = lastRetryCandidates.length > 0 && (data.failed > 0 || !!data.error);
      retryBtn.style.display = showRetry ? 'inline-flex' : 'none';
    }

    // Persist this session to upload history (unless nothing was attempted)
    if (currentSession && (data.completed + data.failed + data.duplicates) > 0) {
      currentSession.finishedAt = new Date().toISOString();
      currentSession.successCount = data.completed || 0;
      currentSession.failCount = data.failed || 0;
      currentSession.skipCount = data.duplicates || 0;
      currentSession.deletedCount = data.deleted || 0;
      currentSession.totalCount = data.total || currentSession.files.length;
      currentSession.aborted = lastAbortRequested;
      try {
        await window.api.saveUploadSession(currentSession);
        await loadUploadHistory();
      } catch (e) { /* non-fatal */ }
    }
    currentSession = null;
    lastAbortRequested = false;
  }

  function abortUpload() {
    lastAbortRequested = true;
    window.api.abortUpload();
    addLog('info', 'Aborting...', '');
    document.getElementById('abortBtn').disabled = true;
  }

  // ─── Reset / Start New Import ─────────────────────────
  // Wipes the in-app state (grid, banner, progress, badges, live log) but
  // leaves all saved settings and upload history alone.
  function resetUploadState() {
    if (isUploading) return;

    selectedFolder = null;
    scannedFiles = [];
    nameToIdx.clear();
    photoGroups = [];
    flattenedDisplayOrder = [];
    flatPosByIdx = [];
    tileGridPosition = [];
    photoLightboxFlatPos = -1;
    selectedCount = 0;
    selectedBytes = 0;

    closePhotoLightbox();
    document.getElementById('photoTimelineAnchors')?.replaceChildren?.();
    const stackR = getPhotoGridStack();
    if (stackR) stackR.style.display = 'none';

    clearDetailTileFocus();
    mediaDimensionsCache.clear();
    selectionCircleAnchorIdx = null;
    releaseAllTiles();

    const grid = getGrid();
    if (grid) {
      grid.style.display = 'none';
      grid.style.height = '0px';
    }

    const photoEmpty = document.getElementById('photoEmpty');
    if (photoEmpty) {
      photoEmpty.style.display = 'flex';
      photoEmpty.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
        <p>Select a folder to view your photos</p>
        <p class="hint">Thumbnails will appear here in a grid</p>
      `;
    }

    document.getElementById('folderInfo').classList.remove('visible');
    document.getElementById('folderPath').textContent = '—';
    document.getElementById('fileCount').textContent = '0';
    document.getElementById('totalCount').textContent = '0';
    document.getElementById('totalSize').textContent = '0 MB';

    document.getElementById('completeBanner').classList.remove('visible', 'has-errors');
    const rf = document.getElementById('retryFailedBtn');
    if (rf) rf.style.display = 'none';

    document.getElementById('progressWrap').style.display = 'none';
    setProgressFill(0);
    document.getElementById('progressLabel').textContent = 'No upload in progress';
    document.getElementById('progressPct').textContent = '';
    const speedElReset = document.getElementById('progressSpeed');
    if (speedElReset) { speedElReset.textContent = '—'; speedElReset.classList.add('idle'); }
    document.getElementById('progressEta').textContent = '';
    resetSpeedSamples();

    document.getElementById('selectionBar').style.display = 'none';

    stats = { success: 0, error: 0, duplicate: 0, total: 0 };
    updateBadges();
    clearLog();

    lastRetryCandidates = [];
    failedFilesForRetry = [];
    lastUploadBatchFiles = [];

    uploadStartTime = 0;
    uploadBytesDone = 0;
    uploadTotalBytes = 0;
    liveUploadMbps = null;

    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.style.display = 'block';
    uploadBtn.disabled = true;
    const uploadLabel = uploadBtn.querySelector('.btn-label');
    if (uploadLabel) uploadLabel.textContent = 'Upload 0 photos';
    document.getElementById('abortBtn').style.display = 'none';

    updateSummaryCard();
    setView('photos');
  }

