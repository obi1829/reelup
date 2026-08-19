  // ─── Log helpers ─────────────────────────────────────
  // We never write log entries to the DOM individually while an upload is
  // running — instead the upload event handler calls queueLog() and a
  // rAF/100ms-throttled flusher appends them all in one batch. addLog
  // remains for one-off entries (folder loaded, aborting, etc.) and
  // immediately flushes too.
  const pendingLogEntries = [];
  function queueLog(type, name, status) {
    pendingLogEntries.push({ type, name, status });
  }
  function addLog(type, name, status) {
    queueLog(type, name, status);
    flushLogs();
  }

  function flushLogs() {
    if (!pendingLogEntries.length) return;
    const scroll = document.getElementById('logScroll');
    const frag = document.createDocumentFragment();
    for (const { type, name, status } of pendingLogEntries) {
      const entry = document.createElement('div');
      entry.className = `log-entry ${type}`;
      const dot = document.createElement('div'); dot.className = 'log-dot';
      const nm  = document.createElement('div'); nm.className = 'log-name'; nm.textContent = name;
      const st  = document.createElement('div'); st.className = 'log-status'; st.textContent = status;
      entry.append(dot, nm, st);
      frag.appendChild(entry);
    }
    pendingLogEntries.length = 0;
    scroll.appendChild(frag);
    scroll.style.display = 'flex';
    scroll.scrollTop = scroll.scrollHeight;
  }

  function clearLog() {
    pendingLogEntries.length = 0;
    const scroll = document.getElementById('logScroll');
    const entries = scroll.querySelectorAll('.log-entry');
    entries.forEach(e => e.remove());
    scroll.style.display = 'none';
  }

  function updateBadges() {
    document.getElementById('badgeSuccess').textContent = `${stats.success} uploaded`;
    document.getElementById('badgeDuplicate').textContent = `${stats.duplicate} skipped`;
    document.getElementById('badgeError').textContent = `${stats.error} failed`;
  }

  // ─── Progress fill helper (transform-based) ──────────
  // Drives the .progress-fill bar via scaleX so the browser keeps animation
  // work on the compositor instead of triggering layout each frame.
  function setProgressFill(pct) {
    const fill = document.getElementById('progressFill');
    if (!fill) return;
    const clamped = Math.max(0, Math.min(100, pct));
    fill.style.transform = `scaleX(${clamped / 100})`;
  }

  // ─── Throttled upload progress flusher ──────────────
  // upload-file-done and upload-progress events can fire dozens of times
  // per second at high concurrency. Instead of writing to the DOM on
  // every event we buffer state in JS and flush at most once every
  // PROGRESS_FLUSH_MS (or sooner on rAF). This keeps badges, progress
  // bar, summary card, and log entry batches all coherent.
  const PROGRESS_FLUSH_MS = 100;
  let progressFlushTimer = 0;
  let progressFlushScheduled = false;
  let lastProgressFlushAt = 0;
  let currentUploadingFile = '';

  function scheduleProgressFlush() {
    if (progressFlushScheduled) return;
    progressFlushScheduled = true;
    const now = performance.now();
    const elapsed = now - lastProgressFlushAt;
    const delay = elapsed >= PROGRESS_FLUSH_MS ? 0 : (PROGRESS_FLUSH_MS - elapsed);
    progressFlushTimer = setTimeout(() => {
      progressFlushTimer = 0;
      requestAnimationFrame(performProgressFlush);
    }, delay);
  }

  function flushProgressNow() {
    if (progressFlushTimer) {
      clearTimeout(progressFlushTimer);
      progressFlushTimer = 0;
    }
    progressFlushScheduled = true;
    performProgressFlush();
  }

  function performProgressFlush() {
    progressFlushScheduled = false;
    lastProgressFlushAt = performance.now();

    flushLogs();
    updateBadges();

    if (stats.total > 0) {
      const done = stats.success + stats.error + stats.duplicate;
      const pct = Math.round((done / stats.total) * 100);
      setProgressFill(pct);
      document.getElementById('progressLabel').textContent = currentUploadingFile
        ? `Uploading: ${currentUploadingFile}`
        : 'Uploading…';
      document.getElementById('progressPct').textContent = `${done} / ${stats.total} (${pct}%)`;
    }

    refreshLiveThroughput();
  }

  // ─── Upload history ──────────────────────────────────
  let uploadHistory = [];
  const expandedHistoryIds = new Set();

  async function loadUploadHistory() {
    try {
      const list = await window.api.getUploadHistory();
      uploadHistory = Array.isArray(list) ? list : [];
    } catch (e) {
      uploadHistory = [];
    }
    renderHistory();
  }

  function renderHistory() {
    const list = document.getElementById('historyList');
    const empty = document.getElementById('historyEmpty');
    const title = document.getElementById('historySectionTitle');
    const count = document.getElementById('historyCount');
    const clearBtn = document.getElementById('historyClearBtn');

    if (!list || !empty || !title) return;

    if (!uploadHistory.length) {
      list.style.display = 'none';
      list.innerHTML = '';
      title.style.display = 'none';
      empty.style.display = 'flex';
      clearBtn.disabled = true;
      return;
    }

    empty.style.display = 'none';
    title.style.display = 'flex';
    list.style.display = 'flex';
    clearBtn.disabled = false;

    count.textContent = `${uploadHistory.length} session${uploadHistory.length === 1 ? '' : 's'}`;

    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const entry of uploadHistory) {
      frag.appendChild(buildHistoryCard(entry));
    }
    list.appendChild(frag);
  }

  function buildHistoryCard(entry) {
    const card = document.createElement('div');
    card.className = 'history-card';
    card.dataset.id = entry.id;
    if (expandedHistoryIds.has(entry.id)) card.classList.add('expanded');

    const finishedDate = entry.finishedAt ? new Date(entry.finishedAt) : null;
    const when = finishedDate ? formatHistoryDate(finishedDate) : '';
    const modeLabel = (function historyModeLabel(m) {
      switch (m) {
        case 'sftp': return 'SFTP';
        case 'immich': return 'Immich';
        case 'nextcloud': return 'Nextcloud';
        case 'dropbox': return 'Dropbox';
        case 'local': return 'Local folder';
        default: return m || 'Upload';
      }
    })(entry.mode);
    const filesLabel = `${entry.totalCount || 0} ${entry.totalCount === 1 ? 'file' : 'files'} · ${formatBytes(entry.totalBytes || 0)}`;

    const stats = [];
    if (entry.successCount > 0) stats.push(`<span class="history-stat success">${entry.successCount} uploaded</span>`);
    if (entry.skipCount > 0) stats.push(`<span class="history-stat duplicate">${entry.skipCount} skipped</span>`);
    if (entry.failCount > 0) stats.push(`<span class="history-stat error">${entry.failCount} failed</span>`);
    if (!stats.length) stats.push(`<span class="history-stat muted">0 uploaded</span>`);

    // Interpolated values here are counts/formatted numbers and modeLabel
    // (mapped from a fixed internal enum) — no file names or server text.
    // eslint-disable-next-line no-unsanitized/property
    card.innerHTML = `
      <div class="history-card-header" data-action="toggle">
        <svg class="history-card-chev" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        <div class="history-card-main">
          <div class="history-card-top">
            <span class="history-card-mode ${entry.mode !== 'immich' ? 'sftp' : ''}">${modeLabel}</span>
            <span class="history-card-time"></span>
            <span class="history-card-time" style="opacity:0.6">·</span>
            <span class="history-card-time">${filesLabel}</span>
          </div>
          <div class="history-card-dest"></div>
        </div>
        <div class="history-card-stats">${stats.join('')}</div>
      </div>
      <div class="history-card-body" data-body></div>
    `;

    card.querySelectorAll('.history-card-time')[0].textContent = when;
    card.querySelector('.history-card-dest').textContent = entry.destination || '';

    const header = card.querySelector('.history-card-header');
    header.addEventListener('click', () => toggleHistoryCard(entry.id));

    return card;
  }

  function toggleHistoryCard(id) {
    const card = document.querySelector(`.history-card[data-id="${id}"]`);
    if (!card) return;

    const isExpanded = card.classList.toggle('expanded');
    const body = card.querySelector('[data-body]');

    if (isExpanded) {
      expandedHistoryIds.add(id);
      if (body && !body.dataset.populated) {
        const entry = uploadHistory.find(e => e.id === id);
        if (entry) populateHistoryBody(body, entry);
        body.dataset.populated = '1';
      }
    } else {
      expandedHistoryIds.delete(id);
    }
  }

  function populateHistoryBody(body, entry) {
    body.innerHTML = '';
    if (!entry.files || !entry.files.length) {
      body.innerHTML = `<div class="history-card-empty">No file-level details were recorded for this session.</div>`;
      return;
    }
    // Sort: failures first, then duplicates, then successes
    const order = { failed: 0, duplicate: 1, success: 2 };
    const sorted = [...entry.files].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

    const frag = document.createDocumentFragment();
    for (const f of sorted) {
      const row = document.createElement('div');
      row.className = `history-file ${f.status}`;
      const meta = f.status === 'failed'
        ? (f.error || 'failed')
        : f.status === 'duplicate'
          ? 'skipped'
          : (f.detail || 'uploaded');
      row.innerHTML = `
        <span class="history-file-dot"></span>
        <span class="history-file-name"></span>
        <span class="history-file-meta"></span>
      `;
      row.querySelector('.history-file-name').textContent = f.name;
      row.querySelector('.history-file-meta').textContent = meta;
      frag.appendChild(row);
    }
    body.appendChild(frag);
  }

  function formatHistoryDate(d) {
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Today ${time}`;
    if (isYesterday) return `Yesterday ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ' ' + time;
  }

  async function clearUploadHistory() {
    if (!uploadHistory.length) return;
    const confirmed = await confirmAction(
      `Clear all ${uploadHistory.length} upload session${uploadHistory.length === 1 ? '' : 's'} from history? This cannot be undone.`,
      { okLabel: 'Clear History' }
    );
    if (!confirmed) return;
    try {
      await window.api.clearUploadHistory();
    } catch (e) { /* local list is cleared below regardless */ }
    expandedHistoryIds.clear();
    uploadHistory = [];
    renderHistory();
  }

  // ─── Utils ───────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

