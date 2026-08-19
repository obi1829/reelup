  // ─── State ───────────────────────────────────────────
  // This is app-chrome/settings/upload-summary state only — NOT every piece
  // of renderer state. Each view owns and declares its own view-specific
  // state in its own file instead: the photo grid's tile pool, thumbnail
  // cache, and selection state live in photo-grid.js; live upload
  // throughput samples and the error popover live in upload.js; history
  // list state lives in history-and-utils.js; the SFTP browse-modal session
  // lives in sftp-browser.js. All of it is still plain global `let`/`const`
  // (no modules, see CLAUDE.md) — this comment exists so "where does X
  // live" has one answer instead of an assumption that it's all here.
  let selectedFolder = null;
  let scannedFiles = [];
  /** 1=largest thumbnails (fewest columns) … 5=smallest (most cols) — slider UI is inverted left↔right. */
  let gridZoomLevel = 3;
  let photoGroups = [];
  /** File indices (into scannedFiles) in date-group grid order — used by lightbox. */
  let flattenedDisplayOrder = [];
  /** Per file index `{x,y}` in pixels inside #photoGrid (stack coords). */
  let tileGridPosition = [];
  /** `scannedFiles` index → index in flattenedDisplayOrder, or −1 */
  let flatPosByIdx = [];
  /** Index inside `flattenedDisplayOrder`, or −1 when the lightbox is closed. */
  let photoLightboxFlatPos = -1;
  /** Debounce persisting zoom after slider movement. */
  let gridZoomSaveTimer = 0;
  let isUploading = false;
  /** Configured upload services (mirrors `settings.services`). */
  let localServices = [];
  /** Selected destination UUID, or null. */
  let activeServiceId = null;
  const expandedServiceIds = new Set();
  let sftpBrowseServiceId = null;
  let servicesSaveTimer = 0;
  let stats = { success: 0, error: 0, duplicate: 0, total: 0 };

  // Live throughput state (updated as uploads complete)
  let uploadStartTime = 0;
  let uploadBytesDone = 0;
  let uploadTotalBytes = 0;

  // ─── Theme & palette ──────────────────────────────────
  let currentTheme = 'dark';
  let currentPalette = 'midnight';

  const VALID_PALETTES = new Set(['midnight', 'ember', 'forest', 'dusk']);

  function applyPalette(palette) {
    if (!VALID_PALETTES.has(palette)) palette = 'midnight';
    currentPalette = palette;
    document.documentElement.setAttribute('data-palette', palette);
    try { localStorage.setItem('reelup-palette', palette); } catch (e) { /* localStorage unavailable; setting still saved via saveSettings */ }

    document.getElementById('paletteOpt-midnight')?.classList.toggle('active', palette === 'midnight');
    document.getElementById('paletteOpt-ember')?.classList.toggle('active', palette === 'ember');
    document.getElementById('paletteOpt-forest')?.classList.toggle('active', palette === 'forest');
    document.getElementById('paletteOpt-dusk')?.classList.toggle('active', palette === 'dusk');
  }

  async function setPalette(palette) {
    applyPalette(palette);
    try {
      const s = await window.api.getSettings();
      s.palette = currentPalette;
      s.theme = currentTheme;
      await window.api.saveSettings(s);
    } catch (e) { /* UI already reflects the change; persistence is best-effort */ }
  }

  function applyTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') theme = 'dark';
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('reelup-theme', theme); } catch (e) { /* localStorage unavailable; setting still saved via saveSettings */ }

    document.getElementById('themeOpt-dark')?.classList.toggle('active', theme === 'dark');
    document.getElementById('themeOpt-light')?.classList.toggle('active', theme === 'light');

    const quickLabel = document.getElementById('themeQuickLabel');
    if (quickLabel) quickLabel.textContent = theme === 'dark' ? 'Dark' : 'Light';

    const quickIcon = document.getElementById('themeQuickIcon');
    if (quickIcon) {
      // Both branches are hardcoded SVG path literals — no interpolated data.
      // eslint-disable-next-line no-unsanitized/property
      quickIcon.innerHTML = theme === 'dark'
        ? '<path d="M9.37 5.51c-.18.64-.27 1.31-.27 1.99 0 4.08 3.32 7.4 7.4 7.4.68 0 1.35-.09 1.99-.27C17.45 17.19 14.93 19 12 19c-3.86 0-7-3.14-7-7 0-2.93 1.81-5.45 4.37-6.49zM12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.4-9.6c-.44-.06-.9-.1-1.36-.1z"/>'
        : '<path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/>';
    }
  }

  async function setTheme(theme) {
    applyTheme(theme);
    try {
      const s = await window.api.getSettings();
      s.theme = theme;
      s.palette = currentPalette;
      await window.api.saveSettings(s);
    } catch (e) { /* UI already reflects the change; persistence is best-effort */ }
  }

  function toggleTheme() {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }

  // ─── Side drawer (left, hamburger) ───────────────────
  function openSideDrawer() {
    document.getElementById('sideDrawer').classList.add('visible');
    document.getElementById('sideDrawerOverlay').classList.add('visible');
    document.getElementById('hamburgerBtn').classList.add('active');
  }

  function closeSideDrawer() {
    document.getElementById('sideDrawer').classList.remove('visible');
    document.getElementById('sideDrawerOverlay').classList.remove('visible');
    document.getElementById('hamburgerBtn').classList.remove('active');
  }

  function toggleSideDrawer() {
    const open = document.getElementById('sideDrawer').classList.contains('visible');
    if (open) closeSideDrawer(); else openSideDrawer();
  }

  // ─── Settings drawer (right, gear icon) ──────────────
  function openSettings(scrollToId) {
    document.getElementById('settingsDrawer').classList.add('visible');
    document.getElementById('settingsDrawerOverlay').classList.add('visible');
    document.getElementById('settingsBtn').classList.add('active');
    if (scrollToId) {
      setTimeout(() => highlightSettingsSection(scrollToId), 240);
    }
  }

  function closeSettings() {
    document.getElementById('settingsDrawer').classList.remove('visible');
    document.getElementById('settingsDrawerOverlay').classList.remove('visible');
    document.getElementById('settingsBtn').classList.remove('active');
  }

  function highlightSettingsSection(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.style.transition = 'box-shadow 0.4s';
    el.style.borderRadius = 'var(--radius)';
    el.style.boxShadow = '0 0 0 1px var(--accent), 0 0 18px var(--accent-glow)';
    setTimeout(() => { el.style.boxShadow = 'none'; }, 1300);
  }

  // ─── Confirm modal (shared UI primitive) ─────────────
  // Replaces native confirm() for destructive actions (remove service,
  // clear history) with the same custom-modal look the rest of the app
  // uses, instead of a blocking OS dialog. Only one confirm can be pending
  // at a time — that's the same constraint confirm() itself had.
  let confirmModalResolve = null;

  function confirmAction(message, options = {}) {
    return new Promise((resolve) => {
      confirmModalResolve = resolve;
      document.getElementById('confirmModalMessage').textContent = message;
      document.getElementById('confirmModalOkBtn').textContent = options.okLabel || 'Confirm';
      document.getElementById('confirmModal').classList.add('visible');
    });
  }

  function resolveConfirmModal(result) {
    const modal = document.getElementById('confirmModal');
    if (!modal.classList.contains('visible')) return;
    modal.classList.remove('visible');
    const resolve = confirmModalResolve;
    confirmModalResolve = null;
    if (resolve) resolve(result);
  }

