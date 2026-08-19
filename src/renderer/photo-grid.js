  // ─── View tabs (Photos / Activity) ───────────────────
  let currentView = 'photos';

  function setView(view) {
    if (view !== 'photos' && view !== 'activity') return;
    currentView = view;
    document.getElementById('viewTab-photos').classList.toggle('active', view === 'photos');
    document.getElementById('viewTab-activity').classList.toggle('active', view === 'activity');
    document.getElementById('view-photos').classList.toggle('active', view === 'photos');
    document.getElementById('view-activity').classList.toggle('active', view === 'activity');

    // When the photos panel becomes visible the grid container finally has
    // a width, so the virtual scroller can measure itself and render. We
    // skip re-rendering when the grid was never set up (no scanned files).
    if (view === 'photos' && scannedFiles.length > 0) {
      requestAnimationFrame(() => {
        if (computeLayout()) scheduleRender();
      });
    }
  }

  // ─── Photo grid rendering & selection ────────────────
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.m4v', '.3gp', '.webm']);
  const RAW_EXTS   = new Set(['.raw', '.nef', '.cr2', '.cr3', '.arw', '.dng', '.orf', '.rw2', '.pef', '.srw', '.tiff', '.tif', '.heic', '.heif']);

  const MEDIA_TYPE_DESCRIPTIONS = {
    '.jpg': 'JPEG image', '.jpeg': 'JPEG image', '.png': 'PNG image', '.gif': 'GIF image',
    '.webp': 'WebP image', '.bmp': 'BMP image', '.svg': 'SVG image',
    '.mp4': 'MP4 video', '.mov': 'MOV video', '.avi': 'AVI video', '.mkv': 'MKV video',
    '.wmv': 'WMV video', '.m4v': 'M4V video', '.3gp': '3GP video', '.webm': 'WebM video',
    '.heic': 'HEIC (Apple)', '.heif': 'HEIF image',
    '.arw': 'ARW (Sony RAW)', '.nef': 'NEF (Nikon RAW)', '.cr2': 'CR2 (Canon RAW)',
    '.cr3': 'CR3 (Canon RAW)', '.orf': 'ORF (Olympus RAW)', '.rw2': 'RW2 (Panasonic RAW)',
    '.pef': 'PEF (Pentax RAW)', '.srw': 'SRW (Samsung RAW)', '.dng': 'DNG (Adobe RAW)',
    '.raw': 'RAW image', '.tiff': 'TIFF image', '.tif': 'TIFF image'
  };

  /** `localfile` custom protocol maps to filesystem paths via `protocol.registerFileProtocol` in main. */
  function localFileSrc(p) {
    let s = String(p).replace(/\\/g, '/');
    if (!s.startsWith('/')) s = '/' + s;
    return ('localfile://' + s)
      .replace(/%/g, '%25')
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F')
      .replace(/ /g, '%20');
  }

  // ─── RAW thumbnail pipeline ──────────────────────────
  // Raster formats use `localfile://` URLs (registered in main) so thumbnails
  // load without IPC/base64. RAW thumbnails (both the 360px grid and the large
  // lightbox preview) are extracted in main (sharp), written to a temp JPEG,
  // and shown via `localfile://` URLs — so the renderer holds short paths, not
  // multi-KB data URLs, for every tile.
  /** Cache: normalized path → `localfile://…` src string; fullscreen RAW uses the `:large` key. */
  const thumbnailCache = new Map();

  /** Stable key for thumbnailCache / pending RAW jobs — avoids duplicate IPC across path spellings. */
  function thumbCacheKey(p) {
    return String(p || '').replace(/\\/g, '/');
  }

  /** `thumbnailCache` key for fullscreen RAW upgrade (suffix avoids clashing with 360px grid cache). */
  function thumbLargeCacheKey(p) {
    return thumbCacheKey(p) + ':large';
  }

  const pendingThumbJobs = new Map();     // thumbCacheKey(path) → job
  const thumbQueue = [];                  // jobs waiting for a worker slot
  let thumbActive = 0;
  const THUMB_CONCURRENCY = 6;

  function enqueueRawThumb(file, onResult, { priority = false } = {}) {
    if (!file || !file.path) return;
    const key = thumbCacheKey(file.path);
    const cached = thumbnailCache.get(key);
    if (cached) { onResult(cached); return; }

    let job = pendingThumbJobs.get(key);
    if (job) {
      // De-dupe identical paths: stack the callback on the existing job.
      job.callbacks.push(onResult);
      if (priority && !job.started) moveJobToFront(job);
      return;
    }
    job = { file, key, callbacks: [onResult], started: false, cancelled: false };
    pendingThumbJobs.set(key, job);
    if (priority) thumbQueue.unshift(job); else thumbQueue.push(job);
    pumpThumbQueue();
  }

  function moveJobToFront(job) {
    const i = thumbQueue.indexOf(job);
    if (i > 0) {
      thumbQueue.splice(i, 1);
      thumbQueue.unshift(job);
    }
  }

  function pumpThumbQueue() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
      const job = thumbQueue.shift();
      job.started = true;
      thumbActive++;
      runThumbJob(job).finally(() => {
        thumbActive--;
        pumpThumbQueue();
      });
    }
  }

  async function runThumbJob(job) {
    const { file, key, callbacks } = job;

    const deliver = (dataUrl) => {
      pendingThumbJobs.delete(key);
      if (dataUrl) thumbnailCache.set(key, dataUrl);
      for (const cb of callbacks) {
        try { cb(dataUrl || null); } catch (e) { /* one bad callback shouldn't block the rest */ }
      }
      maybeRefreshPhotoLightboxThumbnail(file.path);
      const di = detailFocusedIdx;
      if (di !== null && scannedFiles[di] && thumbCacheKey(scannedFiles[di].path) === key) {
        populatePhotoDetailsPreview(scannedFiles[di], detailsRenderGen);
      }
    };

    const cachedNow = thumbnailCache.get(key);
    if (cachedNow) {
      deliver(cachedNow);
      return;
    }

    try {
      const res = await window.api.getRawThumbnail(file.path);
      if (res && res.success && res.filePath) {
        deliver(localFileSrc(res.filePath));
      } else {
        deliver(null);
      }
    } catch (e) {
      deliver(null);
    }
  }

  // ─── Virtual scrolling photo grid ────────────────────
  // Only the tiles inside (or just outside) the viewport are kept in the
  // DOM. The rest of the grid is represented by a single positioned host
  // whose height matches the total scroll extent. Tile DOM nodes are
  // recycled from a pool so scrolling never thrashes the heap.

  const TILE_GAP = 10;
  const GRID_PAD = 14;
  const TILE_MIN_WIDTHS = [
    { minWidth: 1400, tileMin: 170 },
    { minWidth: 1100, tileMin: 150 },
    { minWidth: 0,    tileMin: 130 }
  ];
  /** Multipliers on responsive min tile width — internal level 5 = smallest tiles; slider UI inverted. */
  const GRID_ZOOM_WIDTH_MUL = [
    1.95,
    1.45,
    1,
    0.72,
    0.52
  ];
  /** Must match `--photo-group-header-h` plus vertical header padding (~6px+8px). */
  const PHOTO_GROUP_HEADER_BLOCK_PX = 50;
  const BUFFER_ROWS = 2;

  const vGrid = {
    cols: 1,
    tileSize: 130,
    rowStride: 140,
    totalRows: 0,
    totalTileRows: 0,
    /** Total stacked height of date sections incl. sticky headers — scroll extent inside stack. */
    totalHeight: 0,
    gridWidth: 0,
    viewportH: 0,
    firstIdx: 0,
    lastIdx: -1,
    renderPending: false,
    resizeObserver: null,
    layoutValid: false
  };

  // Tiles that are currently bound to a file index (visible / buffer).
  const tilesByIdx = new Map();
  // Tiles available for reuse — same DOM nodes, just not currently shown.
  const tilePool = [];

  // Quick lookup from filename to file indices, rebuilt on each scan.
  // Used by setTileStatus / fileSizeByName so we don't scan the whole list
  // each time an upload event lands.
  const nameToIdx = new Map();

  // Running counters so updateSelectionUi() is O(1) instead of O(N).
  let selectedCount = 0;
  let selectedBytes = 0;

  let detailFocusedIdx = null;
  let detailsRenderGen = 0;
  const mediaDimensionsCache = new Map(); // path → 'W × H' or '__fail__'
  let photoGridInteractionsSetup = false;
  /** Last index used for Shift+click range selection on the circle. */
  let selectionCircleAnchorIdx = null;


  function getPhotoGridStack() {
    return document.getElementById('photoGridStack');
  }

  /** Local-calendar YYYY-MM-DD for grouping — uses `mtime` as wall-clock date. */
  function localCalendarDateKey(mtime) {
    const d = mtime instanceof Date ? mtime : new Date(mtime || 0);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '0000-00-00';
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  function formatPhotoGroupHeaderLabel(dayKey, count, sampleMtime) {
    const probe = `${dayKey}T12:00:00`;
    const parsed = Date.parse(sampleMtime instanceof Date ? sampleMtime : new Date(sampleMtime || probe));
    const d = new Date(Number.isNaN(parsed) ? probe : parsed);
    const line = new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(d);
    return `${line} · ${count} photo${count === 1 ? '' : 's'}`;
  }

  function rebuildFlatPosMaps() {
    flatPosByIdx = new Array(scannedFiles.length).fill(-1);
    for (let p = 0; p < flattenedDisplayOrder.length; p++) {
      const ix = flattenedDisplayOrder[p];
      if (typeof ix === 'number' && ix >= 0) flatPosByIdx[ix] = p;
    }
  }

  /**
   * Buckets `scannedFiles` into `photoGroups` (newest day first).
   * Each group `{ dateKey, label, representativeMtime, indices }` with indices
   * sorted by mtime desc (fallback path).
   */
  function rebuildPhotoDateGroups() {
    photoGroups = [];
    flattenedDisplayOrder = [];
    tileGridPosition = [];
    flatPosByIdx = [];
    const anchors = document.getElementById('photoTimelineAnchors');
    if (anchors) anchors.replaceChildren();

    if (!scannedFiles.length) return;

    const bucket = new Map();
    for (let i = 0; i < scannedFiles.length; i++) {
      const f = scannedFiles[i];
      const key = localCalendarDateKey(f.mtime);
      let g = bucket.get(key);
      if (!g) {
        g = { dateKey: key, indices: [] };
        bucket.set(key, g);
      }
      g.indices.push(i);
    }
    const sortedKeys = [...bucket.keys()].sort((a, b) => {
      if (a === '0000-00-00' && b !== '0000-00-00') return 1;
      if (b === '0000-00-00' && a !== '0000-00-00') return -1;
      return b.localeCompare(a);
    });

    photoGroups = sortedKeys.map((key) => {
      const raw = bucket.get(key);
      const indices = [...raw.indices].sort((ia, ib) => {
        const ta = +(scannedFiles[ia].mtime || 0);
        const tb = +(scannedFiles[ib].mtime || 0);
        return tb !== ta ? tb - ta : String(scannedFiles[ia].path).localeCompare(scannedFiles[ib].path);
      });
      const ref = scannedFiles[indices[0]];
      const m = ref?.mtime ?? new Date();
      return {
        dateKey: key,
        indices,
        representativeMtime: m,
        headerLabel: formatPhotoGroupHeaderLabel(key, indices.length, m)
      };
    });

    for (const g of photoGroups) {
      for (const ix of g.indices) flattenedDisplayOrder.push(ix);
    }
    rebuildFlatPosMaps();
  }

  function syncPhotoTimelineSections(totalStackPx, cols, rowStride, tileSize) {
    const root = document.getElementById('photoTimelineAnchors');
    const stack = getPhotoGridStack();
    if (!root || !stack) return;

    stack.style.minHeight =
      typeof totalStackPx === 'number' && totalStackPx > 0
        ? `${totalStackPx}px`
        : '';

    if (!photoGroups.length) {
      root.replaceChildren();
      return;
    }

    root.replaceChildren();
    const stride = tileSize + TILE_GAP;

    for (const g of photoGroups) {
      const sec = document.createElement('section');
      sec.className = 'photo-date-section';
      sec.dataset.dateKey = g.dateKey;

      const head = document.createElement('header');
      head.className = 'photo-group-header';

      const label = document.createElement('span');
      label.className = 'photo-group-header-label';
      label.textContent = g.headerLabel;

      const chkWrap = document.createElement('label');
      chkWrap.className = 'photo-group-select';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.dateSelect = g.dateKey;
      chkWrap.append(cb);
      head.append(label, chkWrap);

      head.addEventListener('click', (ev) => { ev.stopPropagation(); });
      chkWrap.addEventListener('click', (ev) => { ev.stopPropagation(); });
      chkWrap.addEventListener('dblclick', (ev) => { ev.stopPropagation(); });

      cb.addEventListener('change', () => {
        if (isUploading) { cb.checked = !cb.checked; return; }
        setPhotoGroupSelected(g.indices, !!cb.checked);
      });

      const gap = document.createElement('div');
      gap.className = 'photo-date-gap';
      const n = g.indices.length;
      const rows = Math.max(0, Math.ceil(n / cols));
      const gapH =
        rows > 0 ? rows * stride - TILE_GAP : 0;
      gap.style.height = `${gapH}px`;

      sec.append(head, gap);
      root.append(sec);

      cb.checked = photoGroupFullySelected(g.indices);
      cb.indeterminate =
        cb.checked ? false : photoGroupPartiallySelected(g.indices);
    }

    refreshTimelineGroupChecks();
  }

  function photoGroupFullySelected(indices) {
    let any = false;
    for (const i of indices) {
      const f = scannedFiles[i];
      if (!f) continue;
      any = true;
      if (!f.selected) return false;
    }
    return any;
  }

  function photoGroupPartiallySelected(indices) {
    let hi = false, lo = false;
    for (const i of indices) {
      const f = scannedFiles[i];
      if (!f) continue;
      if (f.selected) hi = true; else lo = true;
      if (hi && lo) return true;
    }
    return false;
  }

  let photoLightboxHooks = false;

  function closePhotoLightbox() {
    const lb = document.getElementById('photoLightbox');
    if (!lb || lb.hidden) return;
    lb.hidden = true;
    photoLightboxFlatPos = -1;
    const img = document.getElementById('photoLightboxImg');
    if (img) {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      img.classList.remove('is-loaded', 'is-superseded');
    }
    const hi = document.getElementById('photoLightboxImgHi');
    if (hi) {
      hi.onload = null;
      hi.onerror = null;
      hi.removeAttribute('src');
      hi.classList.remove('is-loaded', 'is-hi-visible');
      hi.hidden = true;
      hi.setAttribute('aria-hidden', 'true');
    }
    const sp = document.getElementById('photoLightboxSpinner');
    if (sp) sp.hidden = true;
    document.body.style.overflow = '';
  }

  function photoLightboxFileAtCursor() {
    if (photoLightboxFlatPos < 0 || photoLightboxFlatPos >= flattenedDisplayOrder.length) return null;
    const idx = flattenedDisplayOrder[photoLightboxFlatPos];
    return scannedFiles[idx] || null;
  }

  function setPhotoLightboxLoading(loading) {
    const spin = document.getElementById('photoLightboxSpinner');
    if (spin) spin.hidden = !loading;
  }

  function applyRawLightboxLargeSrc(imageSrc, expectedCacheKey) {
    const hi = document.getElementById('photoLightboxImgHi');
    const base = document.getElementById('photoLightboxImg');
    if (!hi || !base || !imageSrc) return;
    hi.hidden = false;
    let settled = false;
    const finalizeHi = () => {
      setPhotoLightboxLoading(false);
      if (settled) return;
      settled = true;
      hi.onload = null;
      hi.onerror = null;
      const c2 = photoLightboxFileAtCursor();
      if (
        photoLightboxFlatPos < 0 ||
        !c2 ||
        thumbCacheKey(c2.path) !== expectedCacheKey
      ) return;
      hi.classList.add('is-loaded', 'is-hi-visible');
      base.classList.add('is-superseded');
    };
    hi.onload = finalizeHi;
    hi.onerror = () => { setPhotoLightboxLoading(false); };
    hi.classList.remove('is-loaded', 'is-hi-visible');
    hi.removeAttribute('src');
    hi.src = imageSrc;
    if (typeof hi.decode === 'function') {
      hi.decode().then(finalizeHi).catch(() => { /* defer to onload */ });
    }
  }

  function upgradeRawLightboxToLargeCachedOrFetch(file, cacheKey) {
    if (!RAW_EXTS.has(file.ext)) return;
    const lk = thumbLargeCacheKey(file.path);
    const big = thumbnailCache.get(lk);
    if (big) {
      applyRawLightboxLargeSrc(big, cacheKey);
      return;
    }
    window.api.getRawThumbnailLarge(file.path).then((res) => {
      const cur = photoLightboxFileAtCursor();
      if (
        photoLightboxFlatPos < 0 ||
        !cur ||
        thumbCacheKey(cur.path) !== cacheKey
      ) {
        return;
      }
      if (!res || !res.success || !res.filePath) return;
      const srcLarge = localFileSrc(res.filePath);
      thumbnailCache.set(lk, srcLarge);
      applyRawLightboxLargeSrc(srcLarge, cacheKey);
    }).catch(() => {});
  }

  function hydratePhotoLightboxMeta(file) {
    const nameEl = document.getElementById('photoLightboxFileName');
    const metaEl = document.getElementById('photoLightboxMeta');
    if (nameEl) nameEl.textContent = file.name || '';
    if (metaEl) {
      const lines = [
        `${formatBytes(file.size || 0)} · Modified ${formatModifiedDateDetails(file.mtime)}`,
        humanizeMediaKind(file)
      ];
      metaEl.textContent = lines.join('\n');
    }
  }

  function hydratePhotoLightboxImage(file) {
    const imgEl = document.getElementById('photoLightboxImg');
    const hiEl = document.getElementById('photoLightboxImgHi');
    if (!imgEl || !hiEl) return;

    imgEl.onload = null;
    imgEl.onerror = null;
    imgEl.classList.remove('is-loaded', 'is-superseded');

    hiEl.onload = null;
    hiEl.onerror = null;
    hiEl.classList.remove('is-loaded', 'is-hi-visible');
    hiEl.removeAttribute('src');

    const cacheKey = thumbCacheKey(file.path);
    const isImg = IMAGE_EXTS.has(file.ext);
    const isRaw = RAW_EXTS.has(file.ext);
    const isVid = VIDEO_EXTS.has(file.ext);

    if (isRaw) {
      hiEl.hidden = false;
      hiEl.setAttribute('aria-hidden', 'true');
    } else {
      hiEl.hidden = true;
      hiEl.setAttribute('aria-hidden', 'true');
    }

    const finishFail = () => {
      imgEl.onload = null;
      imgEl.onerror = null;
      setPhotoLightboxLoading(false);
      imgEl.removeAttribute('src');
      imgEl.alt = 'Preview unavailable';
      imgEl.classList.remove('is-loaded', 'is-superseded');
    };

    const applySrc = (src, { keepSpinnerUntilDecoded = false } = {}) => {
      imgEl.alt = '';
      imgEl.classList.remove('is-loaded');
      let settled = false;
      const finalize = () => {
        if (settled) return;
        settled = true;
        imgEl.onload = null;
        imgEl.onerror = null;
        setPhotoLightboxLoading(false);
        imgEl.classList.add('is-loaded');
      };
      if (!keepSpinnerUntilDecoded) {
        setPhotoLightboxLoading(false);
      }
      imgEl.onload = finalize;
      imgEl.onerror = finishFail;
      imgEl.removeAttribute('src');
      imgEl.src = src;
      if (typeof imgEl.decode === 'function') {
        imgEl.decode().then(finalize).catch(() => { /* defer to onload */ });
      }
      requestAnimationFrame(() => {
        if (imgEl.complete && imgEl.naturalWidth > 0) finalize();
      });
    };

    if (isVid) {
      setPhotoLightboxLoading(false);
      imgEl.removeAttribute('src');
      imgEl.alt = 'Video preview — open file externally';
      imgEl.classList.remove('is-loaded', 'is-superseded');
      hiEl.hidden = true;
      return;
    }
    if (isImg) {
      applySrc(localFileSrc(file.path));
      return;
    }
    if (isRaw) {
      const du = thumbnailCache.get(cacheKey);
      if (du) {
        setPhotoLightboxLoading(false);
        applySrc(du);
        upgradeRawLightboxToLargeCachedOrFetch(file, cacheKey);
        return;
      }
      setPhotoLightboxLoading(true);
      enqueueRawThumb(file, (url) => {
        const cur = photoLightboxFileAtCursor();
        if (
          photoLightboxFlatPos < 0 ||
          !cur ||
          thumbCacheKey(cur.path) !== cacheKey
        ) {
          setPhotoLightboxLoading(false);
          return;
        }
        if (url) {
          applySrc(url, { keepSpinnerUntilDecoded: true });
          upgradeRawLightboxToLargeCachedOrFetch(file, cacheKey);
        } else finishFail();
      }, { priority: true });
      return;
    }
    finishFail();
  }

  function maybeRefreshPhotoLightboxThumbnail(path) {
    if (!path || photoLightboxFlatPos < 0) return;
    const cur = photoLightboxFileAtCursor();
    if (!cur || thumbCacheKey(cur.path) !== thumbCacheKey(path)) return;
    hydratePhotoLightboxImage(cur);
  }

  function openPhotoLightboxForFileIdx(idx) {
    const fp = flatPosByIdx[idx];
    if (typeof fp !== 'number' || fp < 0) return;
    openPhotoLightboxAtFlatPos(fp);
  }

  function openPhotoLightboxAtFlatPos(fp) {
    if (
      fp < 0 ||
      fp >= flattenedDisplayOrder.length ||
      !flattenedDisplayOrder.length
    ) return;
    const lb = document.getElementById('photoLightbox');
    if (!lb) return;

    setupPhotoLightboxInteractions();
    lb.hidden = false;
    photoLightboxFlatPos = fp;
    document.body.style.overflow = 'hidden';

    const idx = flattenedDisplayOrder[fp];
    const file = scannedFiles[idx];
    if (!file) return;
    hydratePhotoLightboxMeta(file);
    hydratePhotoLightboxImage(file);
  }

  function stepPhotoLightbox(delta) {
    if (photoLightboxFlatPos < 0) return;
    const n = photoLightboxFlatPos + delta;
    if (n < 0 || n >= flattenedDisplayOrder.length) return;
    photoLightboxFlatPos = n;
    const idx = flattenedDisplayOrder[n];
    const file = scannedFiles[idx];
    hydratePhotoLightboxMeta(file);
    hydratePhotoLightboxImage(file);
  }

  function onPhotoLightboxKeydown(ev) {
    const lb = document.getElementById('photoLightbox');
    if (!lb || lb.hidden) return;
    const k = ev.key;
    if (k === 'Escape') {
      ev.preventDefault();
      closePhotoLightbox();
      return;
    }
    if (k === 'ArrowRight') {
      ev.preventDefault();
      stepPhotoLightbox(1);
    } else if (k === 'ArrowLeft') {
      ev.preventDefault();
      stepPhotoLightbox(-1);
    }
  }

  function setupPhotoLightboxInteractions() {
    if (photoLightboxHooks) return;
    photoLightboxHooks = true;

    document.getElementById('photoLightboxBackdrop')?.addEventListener('click', () => closePhotoLightbox());
    document.getElementById('photoLightboxClose')?.addEventListener('click', () => closePhotoLightbox());
    document.getElementById('photoLightboxPrev')?.addEventListener('click', (e) => {
      e.stopPropagation();
      stepPhotoLightbox(-1);
    });
    document.getElementById('photoLightboxNext')?.addEventListener('click', (e) => {
      e.stopPropagation();
      stepPhotoLightbox(1);
    });

    document.addEventListener('keydown', onPhotoLightboxKeydown);
  }

  function setPhotoGroupSelected(indices, sel) {
    for (const i of indices) {
      const f = scannedFiles[i];
      if (!f) continue;
      f.selected = sel;
    }
    recomputeSelectionCounters();
    scheduleSelectionUiUpdate();
    for (const [, tile] of tilesByIdx) {
      const fi = scannedFiles[tile._idx];
      tile.classList.toggle('selected', !!(fi && fi.selected));
    }
    tilePool.forEach((t) => {
      const fi = scannedFiles[t._idx];
      if (typeof t._idx !== 'number' || fi == null) return;
      t.classList.toggle('selected', !!(fi.selected));
    });
    if (detailFocusedIdx != null) refreshTileDetailRing();
  }

  function refreshTimelineGroupChecks() {
    const root = document.getElementById('photoTimelineAnchors');
    if (!root || !photoGroups.length) return;
    for (const g of photoGroups) {
      let cb =
        Array.from(root.querySelectorAll(`input[data-date-select]`)).find(
          (n) => n.dataset.dateSelect === g.dateKey);
      if (!cb) continue;
      cb.checked = photoGroupFullySelected(g.indices);
      cb.indeterminate =
        cb.checked ? false : photoGroupPartiallySelected(g.indices);
    }
  }

  /** Recompute absolute tile XY within the stacking context (`#photoGrid` / `#photoGridStack`). */
  function computeTilePositionsAndSyncTimeline(cols, tileSize) {
    const stride = tileSize + TILE_GAP;
    tileGridPosition = scannedFiles.map(() => null);

    if (!scannedFiles.length) {
      vGrid.totalTileRows = 0;
      syncPhotoTimelineSections(0, cols, stride, tileSize);
      const gr = getGrid();
      if (gr) gr.style.height = '0px';
      vGrid.totalHeight = 0;
      return;
    }

    if (!photoGroups.length) rebuildPhotoDateGroups();

    let totalAccum = 0;
    let tileRowsApprox = 0;

    for (const g of photoGroups) {
      const tileY0 = totalAccum + PHOTO_GROUP_HEADER_BLOCK_PX;
      const n = g.indices.length;
      const rowsForGroup = Math.max(0, Math.ceil(n / cols));
      tileRowsApprox += rowsForGroup;

      for (let ri = 0; ri < n; ri++) {
        const idx = g.indices[ri];
        const rr = Math.floor(ri / cols);
        const cc = ri % cols;
        tileGridPosition[idx] = { x: cc * stride, y: tileY0 + rr * stride };
      }

      const bodyPx =
        rowsForGroup > 0 ? rowsForGroup * stride - TILE_GAP : 0;
      totalAccum += PHOTO_GROUP_HEADER_BLOCK_PX + bodyPx;
    }

    vGrid.totalTileRows = tileRowsApprox;
    vGrid.totalHeight = totalAccum;
    syncPhotoTimelineSections(totalAccum, cols, stride, tileSize);

    const gr = getGrid();
    if (gr) gr.style.height = `${totalAccum}px`;
  }

  function flatPosFor(idx) {
    const p = flatPosByIdx[idx];
    return typeof p === 'number' && p >= 0 ? p : 0;
  }

  /** Next / prev tile in Lightroom visual order (`flattenedDisplayOrder`). */
  function flatAdjacentFileIdx(idx, delta) {
    const p = flatPosByIdx[idx];
    if (typeof p !== 'number' || p < 0) return null;
    const q = p + delta;
    if (q < 0 || q >= flattenedDisplayOrder.length) return null;
    return flattenedDisplayOrder[q];
  }

  /** Neighbour in approximate screen column for arrow-up/down across date breaks. */
  function screenAxisNeighbor(idx, axis, dirSign) {
    const cur = tileGridPosition[idx];
    if (
      !cur ||
      dirSign === 0 ||
      flattenedDisplayOrder.length === 0
    ) return null;

    const tw = vGrid.tileSize + TILE_GAP;
    const half = tw * 0.45;
    const curCx = cur.x + vGrid.tileSize / 2;
    const curCy = cur.y + vGrid.tileSize / 2;

    let best = null;
    let bestDist = Infinity;

    for (let p = 0; p < flattenedDisplayOrder.length; p++) {
      const j = flattenedDisplayOrder[p];
      if (j === idx) continue;
      const o = tileGridPosition[j];
      if (!o) continue;
      const ocx = o.x + vGrid.tileSize / 2;
      const ocy = o.y + vGrid.tileSize / 2;

      if (axis === 'x') {
        const dx = ocx - curCx;
        if (dirSign > 0 && dx <= half) continue;
        if (dirSign < 0 && dx >= -half) continue;
        const dyGap = Math.abs(ocy - curCy);
        if (dyGap > vGrid.tileSize * 0.6) continue;
        const merit = dx * dx * 10 + dyGap * dyGap;
        if (merit < bestDist) {
          bestDist = merit;
          best = j;
        }
      } else {
        const dy = ocy - curCy;
        if (dirSign > 0 && dy <= half) continue;
        if (dirSign < 0 && dy >= -half) continue;
        const dxGap = Math.abs(ocx - curCx);
        if (dxGap > vGrid.tileSize * 0.6) continue;
        const merit = dy * dy * 10 + dxGap * dxGap;
        if (merit < bestDist) {
          bestDist = merit;
          best = j;
        }
      }
    }
    return best;
  }

  function setDetailsPaneOpen(open) {
    const pane = document.getElementById('photoDetailsPane');
    if (pane) {
      pane.setAttribute('aria-hidden', open ? 'false' : 'true');
      pane.classList.toggle('is-open', open);
    }
  }

  function refreshTileDetailRing() {
    const match = detailFocusedIdx;
    const toggle = (t) => {
      const ix = typeof t._idx === 'number' ? t._idx : -1;
      t.classList.toggle('tile-detail-focus', match !== null && ix === match);
    };
    tilesByIdx.forEach(toggle);
    tilePool.forEach(toggle);
  }

  function clearDetailTileFocus() {
    detailFocusedIdx = null;
    setDetailsPaneOpen(false);
    refreshTileDetailRing();
    document.getElementById('photoDetailsPreview')?.replaceChildren?.();
    const d2 = document.getElementById('photoDetailsDivider2');
    const ub = document.getElementById('photoDetailsUploadBlock');
    if (d2) d2.hidden = true;
    if (ub) ub.hidden = true;
  }

  function applyDetailTileFocus(idx) {
    if (!scannedFiles[idx]) return;
    detailFocusedIdx = idx;
    detailsRenderGen++;
    setDetailsPaneOpen(true);
    refreshTileDetailRing();
    hydrateDetailsPaneSide();
    getGridScroll()?.focus({ preventScroll: true });
  }

  function scrollDetailTargetIntoView(idx) {
    if (!vGrid.layoutValid || vGrid.cols < 1) return;
    const scroll = getGridScroll();
    if (!scroll) return;
    const pos = tileGridPosition[idx];
    if (!pos) return;
    const top = GRID_PAD + pos.y;
    const bot = top + vGrid.tileSize;
    const viewTop = scroll.scrollTop;
    const viewBot = scroll.scrollTop + scroll.clientHeight;
    const pad = 10;
    if (top < viewTop + pad) {
      scroll.scrollTop = Math.max(0, top - GRID_PAD - pad);
    } else if (bot > viewBot - pad) {
      scroll.scrollTop = bot - scroll.clientHeight + pad;
    }
    scheduleRender();
  }

  function formatModifiedDateDetails(mtime) {
    const d = mtime instanceof Date ? mtime : new Date(mtime);
    if (mtime == null || Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  function humanizeMediaKind(file) {
    const ext = (file.ext || '').toLowerCase();
    return MEDIA_TYPE_DESCRIPTIONS[ext]
      ? MEDIA_TYPE_DESCRIPTIONS[ext]
      : `${((ext.replace(/^\./, '')) || 'bin').toUpperCase()} file`;
  }

  function hydratePhotoDetailsDimensions(filePath, gen) {
    const el = document.getElementById('photoDetailsDimensions');
    if (!el) return;
    el.textContent = '…';
    if (mediaDimensionsCache.has(filePath)) {
      const v = mediaDimensionsCache.get(filePath);
      el.textContent = v === '__fail__' ? '—' : v;
      return;
    }
    window.api.getMediaMetadata(filePath).then((res) => {
      if (gen !== detailsRenderGen) return;
      if (!res || !res.success || res.width == null || res.height == null) {
        mediaDimensionsCache.set(filePath, '__fail__');
        el.textContent = '—';
        return;
      }
      const label = `${res.width} × ${res.height}`;
      mediaDimensionsCache.set(filePath, label);
      el.textContent = label;
    }).catch(() => {
      if (gen !== detailsRenderGen) return;
      mediaDimensionsCache.set(filePath, '__fail__');
      el.textContent = '—';
    });
  }

  function populatePhotoDetailsPreview(file, gen) {
    const wrap = document.getElementById('photoDetailsPreview');
    if (!wrap) return;
    const isImage = IMAGE_EXTS.has(file.ext);
    const isVideo = VIDEO_EXTS.has(file.ext);
    const isRaw = RAW_EXTS.has(file.ext);
    wrap.innerHTML = '';

    const showThumbUrl = (dataUrl) => {
      if (gen !== detailsRenderGen) return;
      wrap.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = dataUrl;
      wrap.appendChild(img);
    };

    // SVG_VIDEO/SVG_FILE/SVG_RAW below are hardcoded module-level constants
    // (see their definitions) — never derived from file names or server data.
    if (isVideo) {
      // eslint-disable-next-line no-unsanitized/property
      wrap.innerHTML = `<div class="photo-details-preview-ph">${SVG_VIDEO}</div>`;
      return;
    }
    if (isImage) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = localFileSrc(file.path);
      img.onerror = () => {
        if (gen !== detailsRenderGen) return;
        // eslint-disable-next-line no-unsanitized/property
        wrap.innerHTML = `<div class="photo-details-preview-ph">${SVG_FILE}</div>`;
      };
      wrap.appendChild(img);
      return;
    }
    if (isRaw) {
      const du = thumbnailCache.get(thumbCacheKey(file.path));
      if (du) {
        showThumbUrl(du);
        return;
      }
      wrap.innerHTML = '<span class="photo-details-preview-loading">Loading preview…</span>';
      enqueueRawThumb(file, (dataUrl) => {
        if (gen !== detailsRenderGen) return;
        if (dataUrl) showThumbUrl(dataUrl);
        // eslint-disable-next-line no-unsanitized/property
        else wrap.innerHTML = `<div class="photo-details-preview-ph">${SVG_RAW}</div>`;
      });
      return;
    }
    // eslint-disable-next-line no-unsanitized/property
    wrap.innerHTML = `<div class="photo-details-preview-ph">${SVG_FILE}</div>`;
  }

  function updatePhotoDetailsUploadSection(file) {
    const d2 = document.getElementById('photoDetailsDivider2');
    const block = document.getElementById('photoDetailsUploadBlock');
    const badge = document.getElementById('photoDetailsUploadBadge');
    const err = document.getElementById('photoDetailsUploadError');
    if (!d2 || !block || !badge || !err) return;

    const st = file.status;
    const showUpload = !!(st && ['queued', 'uploading', 'success', 'failed', 'duplicate-status'].includes(st));
    d2.hidden = !showUpload;
    block.hidden = !showUpload;
    badge.classList.remove('ok', 'err', 'skip');

    err.hidden = true;
    err.textContent = '';

    if (!showUpload) return;

    if (st === 'success') {
      badge.classList.add('ok');
      badge.textContent = '✓ Uploaded';
    } else if (st === 'failed') {
      badge.classList.add('err');
      badge.textContent = '✗ Failed';
      if (file.uploadError) {
        err.hidden = false;
        err.textContent = String(file.uploadError);
      }
    } else if (st === 'duplicate-status') {
      badge.classList.add('skip');
      badge.textContent = '↷ Skipped';
    } else if (st === 'uploading') {
      badge.textContent = '↑ Uploading…';
    } else if (st === 'queued') {
      badge.textContent = '◷ Queued';
    }
  }

  function hydrateDetailsPaneSide() {
    const idx = detailFocusedIdx;
    if (idx == null || !scannedFiles[idx]) return;
    const gen = detailsRenderGen;
    const file = scannedFiles[idx];
    document.getElementById('photoDetailsName').textContent = file.name;
    document.getElementById('photoDetailsSize').textContent = formatBytes(file.size || 0);
    document.getElementById('photoDetailsModified').textContent = formatModifiedDateDetails(file.mtime);
    document.getElementById('photoDetailsType').textContent = humanizeMediaKind(file);
    hydratePhotoDetailsDimensions(file.path, gen);
    populatePhotoDetailsPreview(file, gen);
    updatePhotoDetailsUploadSection(file);
  }

  function refreshFocusedDetailsPaneIfStale(fileIndexTouched) {
    if (detailFocusedIdx !== fileIndexTouched) return;
    const f = scannedFiles[detailFocusedIdx];
    if (!f) return;
    updatePhotoDetailsUploadSection(f);
  }

  /** Dismiss detail overlay on any grid click (capture) so tile / selection / lightbox handlers still run after. */
  function onPhotoGridDismissDetailCapture(ev) {
    if (detailFocusedIdx === null) return;
    const scroll = getGridScroll();
    if (!scroll || !scroll.contains(ev.target)) return;
    clearDetailTileFocus();
  }

  function onPhotoGridScrollClick(ev) {
    const scroll = getGridScroll();
    if (!scroll) return;
    if (ev.target.closest('#photoDetailsPane')) return;
    if (ev.target.closest('.photo-tile')) return;
    if (ev.target.closest('#photoTimelineAnchors')) return;
    clearDetailTileFocus();
  }

  function onPhotoGridKeydown(ev) {
    const lb = document.getElementById('photoLightbox');
    if (lb && !lb.hidden) return;

    if (!flattenedDisplayOrder.length) return;
    const firstIdx = flattenedDisplayOrder[0];
    const lastIdx = flattenedDisplayOrder[flattenedDisplayOrder.length - 1];

    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (detailFocusedIdx !== null) {
        clearDetailTileFocus();
        return;
      }
      deselectAllPhotos();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
      ev.preventDefault();
      selectAllPhotos();
      return;
    }

    const key = ev.key;
    let handled = false;
    let next = detailFocusedIdx;

    const startFrom = (candidateIdx) => {
      if (!scannedFiles[candidateIdx]) return;
      next = candidateIdx;
      handled = true;
    };

    if (detailFocusedIdx === null) {
      if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'Home') startFrom(firstIdx);
      else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'End') startFrom(lastIdx);
      if (handled) {
        applyDetailTileFocus(next);
        scrollDetailTargetIntoView(next);
        ev.preventDefault();
      }
      return;
    }

    const idx = detailFocusedIdx;
    if (key === 'ArrowRight') {
      const n = flatAdjacentFileIdx(idx, 1);
      if (n != null) startFrom(n);
    } else if (key === 'ArrowLeft') {
      const n = flatAdjacentFileIdx(idx, -1);
      if (n != null) startFrom(n);
    } else if (key === 'ArrowDown') {
      const n = screenAxisNeighbor(idx, 'y', 1);
      if (n != null) startFrom(n);
    } else if (key === 'ArrowUp') {
      const n = screenAxisNeighbor(idx, 'y', -1);
      if (n != null) startFrom(n);
    } else if (key === 'Home') {
      startFrom(firstIdx);
    } else if (key === 'End') {
      startFrom(lastIdx);
    }

    if (handled) {
      applyDetailTileFocus(next);
      scrollDetailTargetIntoView(next);
      ev.preventDefault();
    }
  }

  function setupPhotoGridInteractions() {
    const scroll = getGridScroll();
    if (!scroll || photoGridInteractionsSetup) return;
    photoGridInteractionsSetup = true;
    scroll.tabIndex = 0;
    scroll.addEventListener('click', onPhotoGridDismissDetailCapture, true);
    scroll.addEventListener('click', onPhotoGridScrollClick);
    scroll.addEventListener('keydown', onPhotoGridKeydown);

    document.getElementById('photoDetailsCloseBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearDetailTileFocus();
    });
  }

  function getGridScroll() { return document.getElementById('photoGridScroll'); }
  function getGrid() { return document.getElementById('photoGrid'); }

  function rebuildNameIndex() {
    nameToIdx.clear();
    for (let i = 0; i < scannedFiles.length; i++) {
      const name = scannedFiles[i].name;
      let bucket = nameToIdx.get(name);
      if (!bucket) { bucket = []; nameToIdx.set(name, bucket); }
      bucket.push(i);
    }
  }

  function recomputeSelectionCounters() {
    let count = 0, bytes = 0;
    for (const f of scannedFiles) {
      if (f.selected) { count++; bytes += f.size || 0; }
    }
    selectedCount = count;
    selectedBytes = bytes;
  }

  function getZoomWidthMul() {
    const lvl = Math.round(Number(gridZoomLevel) || 3);
    const i = Math.min(GRID_ZOOM_WIDTH_MUL.length - 1, Math.max(0, lvl - 1));
    return GRID_ZOOM_WIDTH_MUL[i] ?? 1;
  }

  function getTileMinWidth() {
    const w = window.innerWidth;
    for (const bp of TILE_MIN_WIDTHS) {
      if (w >= bp.minWidth) return bp.tileMin;
    }
    return 130;
  }

  /** Responsive minimum tile width scaled by persisted grid zoom slider. */
  function getTileMinWidthForGridZoom() {
    return Math.max(76, Math.round(getTileMinWidth() * getZoomWidthMul()));
  }

  function computeLayout() {
    const scroll = getGridScroll();
    const grid = getGrid();
    if (!scroll || !grid) return false;

    const fullWidth = scroll.clientWidth;
    if (fullWidth <= 0) { vGrid.layoutValid = false; return false; }

    const usableWidth = Math.max(0, fullWidth - GRID_PAD * 2);
    const minW = getTileMinWidthForGridZoom();

    let cols = Math.max(1, Math.floor((usableWidth + TILE_GAP) / (minW + TILE_GAP)));
    const tileSize = Math.floor((usableWidth - TILE_GAP * (cols - 1)) / cols);

    computeTilePositionsAndSyncTimeline(cols, tileSize);

    vGrid.cols = cols;
    vGrid.tileSize = tileSize;
    vGrid.rowStride = tileSize + TILE_GAP;
    vGrid.totalRows = Math.max(0, Math.ceil(scannedFiles.length / cols));
    vGrid.gridWidth = usableWidth;
    vGrid.viewportH = scroll.clientHeight;
    vGrid.layoutValid = true;

    return true;
  }

  function scheduleTileWillChangeCleanup(tile) {
    if (!tile) return;
    const gen = (tile._willChangeGen = (tile._willChangeGen || 0) + 1);
    requestAnimationFrame(() => {
      if (tile._willChangeGen !== gen) return;
      requestAnimationFrame(() => {
        if (tile._willChangeGen !== gen) return;
        tile.style.removeProperty('will-change');
      });
    });
  }

  function positionTile(tile, idx) {
    const p = tileGridPosition[idx];
    if (!p) return;
    tile.style.willChange = 'transform';
    tile.style.width = vGrid.tileSize + 'px';
    tile.style.height = vGrid.tileSize + 'px';
    tile.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    scheduleTileWillChangeCleanup(tile);
  }

  function buildTileNode() {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    tile.innerHTML = `
      <div class="tile-media" data-tile-media></div>
      <div class="tile-name" data-tile-name></div>
      <div class="tile-check">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
      </div>
      <div class="tile-status" data-tile-status></div>
    `;
    tile.addEventListener('click', (ev) => {
      const idx = tile._idx;
      if (typeof idx !== 'number') return;

      if (ev.target.closest('.tile-check')) {
        handleSelectionCircleClick(idx, ev);
        ev.stopPropagation();
        return;
      }

      applyDetailTileFocus(idx);
      const f = scannedFiles[idx];
      if (f && f.status === 'failed') {
        const msg = (f.uploadError && String(f.uploadError).trim()) || 'Upload failed';
        showUploadErrorPopover(tile, msg);
        ev.stopPropagation();
      }
    });
    tile.addEventListener('dblclick', (ev) => {
      const idx = tile._idx;
      if (typeof idx !== 'number') return;
      if (ev.target.closest('.tile-check')) return;
      ev.preventDefault();
      ev.stopPropagation();
      openPhotoLightboxForFileIdx(idx);
    });
    return tile;
  }

  // SVG snippets cached so we don't reparse them on every recycle.
  const SVG_VIDEO  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const SVG_RAW    = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';
  const SVG_FILE   = SVG_RAW;
  const STATUS_ICONS = {
    uploading: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    failed: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    'duplicate-status': '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
    queued: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3"/></svg>'
  };
  const ALL_STATUS_CLASSES = ['queued', 'uploading', 'success', 'failed', 'duplicate-status'];

  /** Always replace upload status classes on a tile — never stack them.
   * Removes: queued, uploading, success, failed, duplicate-status; then adds `status` if set.
   * Maps to the explicit transitions:
   *   success → strip queued/uploading/duplicate/failed + success
   *   failed → strip queued/uploading/duplicate/success + failed
   *   duplicate-status → strip queued/uploading/failed/success + duplicate-status */
  function applyTileUploadStatusClass(tile, status) {
    if (!tile) return;
    tile.classList.remove(...ALL_STATUS_CLASSES);
    if (status) tile.classList.add(status);
  }

  function statusIconForTile(status) { return STATUS_ICONS[status] || ''; }

  function syncTileAria(tile, file) {
    if (file.status === 'failed' && file.uploadError) {
      tile.setAttribute('aria-label', `${file.name}: ${file.uploadError}`);
    } else {
      tile.setAttribute('aria-label', file.name);
    }
    tile.removeAttribute('title');
  }

  function bindTileToIdx(tile, idx) {
    const file = scannedFiles[idx];
    if (!file) return;

    tile._idx = idx;
    tile.dataset.idx = String(idx);
    tile.querySelector('[data-tile-name]').textContent = file.name;

    // Classes
    tile.classList.remove('is-video', 'is-raw', ...ALL_STATUS_CLASSES);
    tile.classList.toggle('selected', !!file.selected);
    tile.classList.toggle('tile-detail-focus', detailFocusedIdx !== null && idx === detailFocusedIdx);

    const isImage = IMAGE_EXTS.has(file.ext);
    const isVideo = VIDEO_EXTS.has(file.ext);
    const isRaw   = RAW_EXTS.has(file.ext);
    if (isVideo) tile.classList.add('is-video');
    if (isRaw)   tile.classList.add('is-raw');

    if (file.status && ALL_STATUS_CLASSES.includes(file.status)) {
      tile.classList.add(file.status);
    }

    // Status overlay
    const statusEl = tile.querySelector('[data-tile-status]');
    // statusIconForTile looks up a fixed STATUS_ICONS table — never echoes its argument.
    // eslint-disable-next-line no-unsanitized/property
    statusEl.innerHTML = file.status ? statusIconForTile(file.status) : '';

    syncTileAria(tile, file);

    // Media (image, raw placeholder, or icon). We rebuild this part since the
    // previous tile content may have been for a different file type.
    const mediaEl = tile.querySelector('[data-tile-media]');
    const extLabel = (file.ext || '').replace('.', '') || 'file';
    if (isImage) {
      mediaEl.innerHTML = `<img alt="">`;
      const img = mediaEl.firstChild;
      img.addEventListener('error', () => {
        // Swap to placeholder if the image fails to decode.
        if (tile._idx !== idx) return;
        // eslint-disable-next-line no-unsanitized/property -- SVG_FILE is a hardcoded constant
        mediaEl.innerHTML = `
          <div class="tile-placeholder">
            ${SVG_FILE}
            <span class="tile-ext"></span>
          </div>
        `;
        mediaEl.querySelector('.tile-ext').textContent = extLabel;
      }, { once: true });
      img.src = localFileSrc(file.path);
    } else if (isRaw) {
      const key = thumbCacheKey(file.path);
      const cached = thumbnailCache.get(key);
      if (cached) {
        mediaEl.innerHTML = '<img alt="">';
        mediaEl.firstChild.src = cached;
      } else {
        // eslint-disable-next-line no-unsanitized/property -- SVG_RAW is a hardcoded constant
        mediaEl.innerHTML = `
          <div class="tile-placeholder">
            ${SVG_RAW}
            <span class="tile-ext"></span>
          </div>
        `;
        mediaEl.querySelector('.tile-ext').textContent = extLabel;
        enqueueRawThumb(file, (dataUrl) => {
          if (tile._idx !== idx) return;
          if (!dataUrl) return;
          mediaEl.innerHTML = '<img alt="">';
          mediaEl.firstChild.src = dataUrl;
        }, { priority: true });
      }
    } else {
      const icon = isVideo ? SVG_VIDEO : SVG_FILE;
      // eslint-disable-next-line no-unsanitized/property -- icon is always SVG_VIDEO or SVG_FILE, both hardcoded constants
      mediaEl.innerHTML = `
        <div class="tile-placeholder">
          ${icon}
          <span class="tile-ext"></span>
        </div>
      `;
      mediaEl.querySelector('.tile-ext').textContent = extLabel;
    }

    positionTile(tile, idx);
  }

  function unbindTile(tile) {
    const idx = tile._idx;
    tile._idx = undefined;
    tile.removeAttribute('data-idx');
    // Don't tear down DOM — the next bind will overwrite fields.
    tile.style.willChange = 'transform';
    tile.style.transform = 'translate3d(-9999px, -9999px, 0)';
    scheduleTileWillChangeCleanup(tile);
  }

  function getVisibleFlatRange() {
    if (
      !vGrid.layoutValid ||
      vGrid.cols < 1 ||
      !flattenedDisplayOrder.length
    ) return [0, -1];

    const scroll = getGridScroll();
    if (!scroll) return [0, -1];

    const viewportH = scroll.clientHeight;
    const scrollTop = scroll.scrollTop;

    const vTopRaw = scrollTop - GRID_PAD;
    const vBotRaw = scrollTop + viewportH - GRID_PAD;
    const buf = BUFFER_ROWS * vGrid.rowStride;
    const vTop = vTopRaw - buf;
    const vBot = vBotRaw + buf;

    let minFp = flattenedDisplayOrder.length;
    let maxFp = -1;

    for (let fp = 0; fp < flattenedDisplayOrder.length; fp++) {
      const idx = flattenedDisplayOrder[fp];
      const p = tileGridPosition[idx];
      if (!p) continue;
      const top = p.y;
      const bot = top + vGrid.tileSize;
      if (bot < vTop) continue;
      if (top > vBot) continue;
      if (fp < minFp) minFp = fp;
      if (fp > maxFp) maxFp = fp;
    }

    const rowBuf = BUFFER_ROWS + 3;
    const flatSpan =
      rowBuf * Math.max(vGrid.cols || 4, 1);

    let fp0 = 0;
    let fp1 = flattenedDisplayOrder.length - 1;

    if (maxFp >= minFp && maxFp >= 0) {
      fp0 = Math.max(0, minFp - flatSpan);
      fp1 = Math.min(flattenedDisplayOrder.length - 1, maxFp + flatSpan);
    }

    return [fp0, fp1];
  }

  function renderVisibleTiles() {
    vGrid.renderPending = false;
    if (!vGrid.layoutValid) return;
    if (!scannedFiles.length) {
      releaseAllTiles();
      return;
    }

    const [fp0, fp1] = getVisibleFlatRange();
    if (fp1 < fp0) {
      releaseAllTiles();
      return;
    }

    vGrid.firstFp = fp0;
    vGrid.lastFp = fp1;
    const firstSeen = flattenedDisplayOrder[fp0];
    const lastSeen = flattenedDisplayOrder[fp1];
    vGrid.firstIdx = firstSeen;
    vGrid.lastIdx = lastSeen;

    for (const [idx, tile] of tilesByIdx) {
      const fp = flatPosByIdx[idx];
      if (typeof fp !== 'number' || fp < fp0 || fp > fp1) {
        tilesByIdx.delete(idx);
        unbindTile(tile);
        tilePool.push(tile);
      }
    }

    const grid = getGrid();
    for (let fp = fp0; fp <= fp1; fp++) {
      const i = flattenedDisplayOrder[fp];
      if (tilesByIdx.has(i)) continue;
      let tile = tilePool.pop();
      if (!tile) {
        tile = buildTileNode();
        grid.appendChild(tile);
      }
      tilesByIdx.set(i, tile);
      bindTileToIdx(tile, i);
    }
  }

  function releaseAllTiles() {
    for (const [, tile] of tilesByIdx) {
      unbindTile(tile);
      tilePool.push(tile);
    }
    tilesByIdx.clear();
  }

  function scheduleRender() {
    if (vGrid.renderPending) return;
    vGrid.renderPending = true;
    requestAnimationFrame(renderVisibleTiles);
  }

  // Debounced layout recompute for resize events.
  let resizeDebounceId = 0;
  function onContainerResize() {
    if (resizeDebounceId) clearTimeout(resizeDebounceId);
    resizeDebounceId = setTimeout(() => {
      resizeDebounceId = 0;
      if (!computeLayout()) return;
      // Force every bound tile to refresh its position (size changed).
      for (const [idx, tile] of tilesByIdx) {
        tile.style.width = vGrid.tileSize + 'px';
        tile.style.height = vGrid.tileSize + 'px';
        positionTile(tile, idx);
      }
      scheduleRender();
    }, 80);
  }

  function setupGridObservers() {
    setupPhotoGridInteractions();
    if (vGrid.resizeObserver) return;
    const scroll = getGridScroll();
    if (!scroll) return;
    scroll.addEventListener('scroll', scheduleRender, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      vGrid.resizeObserver = new ResizeObserver(onContainerResize);
      vGrid.resizeObserver.observe(scroll);
    } else {
      window.addEventListener('resize', onContainerResize, { passive: true });
    }
  }

  function renderPhotoGrid() {
    const grid = getGrid();
    const stack = getPhotoGridStack();
    const empty = document.getElementById('photoEmpty');

    // Reset any tiles from a previous folder.
    releaseAllTiles();
    if (grid) grid.style.height = '0px';

    if (scannedFiles.length === 0) {
      clearDetailTileFocus();
      selectionCircleAnchorIdx = null;
      empty.style.display = 'flex';
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>
        <p>No media files found in this folder</p>
        <p class="hint">Supported: JPG, PNG, HEIC, RAW formats, and common video types</p>
      `;
      if (grid) grid.style.display = 'none';
      if (stack) stack.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    if (grid) grid.style.display = 'block';
    if (stack) stack.style.display = 'block';

    setupGridObservers();
    // Wait a frame so the panel has its final size before we measure.
    requestAnimationFrame(() => {
      if (!computeLayout()) {
        // Container has no width yet (panel hidden); render later.
        return;
      }
      renderVisibleTiles();
    });
  }

  function refreshVisibleTile(idx) {
    const tile = tilesByIdx.get(idx);
    if (!tile) return null;
    return tile;
  }

  function toggleTile(idx) {
    const file = scannedFiles[idx];
    if (!file) return;
    const wasSelected = !!file.selected;
    file.selected = !wasSelected;
    if (file.selected) { selectedCount++; selectedBytes += file.size || 0; }
    else                { selectedCount--; selectedBytes -= file.size || 0; }
    const tile = refreshVisibleTile(idx);
    if (tile) tile.classList.toggle('selected', file.selected);
    scheduleSelectionUiUpdate();
  }

  function handleSelectionCircleClick(idx, ev) {
    if (typeof idx !== 'number' || !scannedFiles[idx]) return;
    if (isUploading) return;

    if (ev.shiftKey) {
      const anchor = selectionCircleAnchorIdx != null ? selectionCircleAnchorIdx : idx;
      const pa = flatPosByIdx[anchor];
      const pb = flatPosByIdx[idx];
      if (
        typeof pa !== 'number' ||
        typeof pb !== 'number' ||
        pa < 0 ||
        pb < 0
      ) {
        toggleTile(idx);
        selectionCircleAnchorIdx = idx;
        return;
      }
      const lo = Math.min(pa, pb);
      const hi = Math.max(pa, pb);
      for (let fp = lo; fp <= hi; fp++) {
        const j = flattenedDisplayOrder[fp];
        const f = scannedFiles[j];
        if (f) f.selected = true;
        const tel = tilesByIdx.get(j);
        if (tel) tel.classList.add('selected');
      }
      recomputeSelectionCounters();
      selectionCircleAnchorIdx = idx;
      scheduleSelectionUiUpdate();
      return;
    }

    toggleTile(idx);
    selectionCircleAnchorIdx = idx;
  }

  function selectAllPhotos() {
    if (isUploading) return;
    for (const f of scannedFiles) f.selected = true;
    recomputeSelectionCounters();
    for (const [, tile] of tilesByIdx) tile.classList.add('selected');
    tilePool.forEach((t) => {
      if (typeof t._idx !== 'number') return;
      const f = scannedFiles[t._idx];
      if (f) t.classList.add('selected');
    });
    selectionCircleAnchorIdx = flattenedDisplayOrder.length
      ? flattenedDisplayOrder[flattenedDisplayOrder.length - 1]
      : null;
    scheduleSelectionUiUpdate();
  }

  function deselectAllPhotos() {
    if (isUploading) return;
    for (const f of scannedFiles) f.selected = false;
    recomputeSelectionCounters();
    for (const [, tile] of tilesByIdx) tile.classList.remove('selected');
    tilePool.forEach((t) => {
      if (typeof t._idx !== 'number') return;
      const f = scannedFiles[t._idx];
      if (f) t.classList.remove('selected');
    });
    selectionCircleAnchorIdx = null;
    scheduleSelectionUiUpdate();
  }

  // updateSelectionUi is the single place that pushes selection state to the
  // sidebar/summary card. It uses cached counters (selectedCount/selectedBytes)
  // so it's O(1) even with thousands of files.
  function updateSelectionUi() {
    const selBar = document.getElementById('selectionBar');
    const sel = selectedCount;
    const total = scannedFiles.length;

    if (total > 0) {
      selBar.style.display = 'flex';
      const selCountEl = document.getElementById('selCount');
      selCountEl.textContent = '';
      const s1 = document.createElement('strong'); s1.textContent = sel;
      const s2 = document.createElement('strong'); s2.textContent = total;
      const s3 = document.createElement('strong'); s3.textContent = formatBytes(selectedBytes);
      selCountEl.append(s1, ' of ', s2, ' selected · ', s3);
    } else {
      selBar.style.display = 'none';
    }

    document.getElementById('fileCount').textContent = sel;

    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.disabled = isUploading || sel === 0;
    const label = uploadBtn.querySelector('.btn-label');
    if (label) {
      label.textContent = sel === 0
        ? 'Upload 0 photos'
        : `Upload ${sel} ${sel === 1 ? 'photo' : 'photos'}`;
    }

    updateSummaryCard();
    refreshTimelineGroupChecks();
  }

  // rAF-coalesces rapid selection changes (e.g. selectAll on 5000 files) so
  // we only update the sidebar / summary card once per frame.
  let selectionUiPending = false;
  function scheduleSelectionUiUpdate() {
    if (selectionUiPending) return;
    selectionUiPending = true;
    requestAnimationFrame(() => {
      selectionUiPending = false;
      updateSelectionUi();
    });
  }

