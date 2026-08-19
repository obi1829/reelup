  // ─── SFTP remote folder browser ──────────────────────
  const browser = {
    sessionId: null,
    home: '/',
    path: '/',
    loading: false
  };

  function normalizePath(p) {
    if (!p) return '/';
    let out = String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!out.startsWith('/')) out = '/' + out;
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  }

  function joinPath(base, name) {
    const b = normalizePath(base);
    return b === '/' ? `/${name}` : `${b}/${name}`;
  }

  function parentPath(p) {
    const n = normalizePath(p);
    if (n === '/') return '/';
    const idx = n.lastIndexOf('/');
    return idx <= 0 ? '/' : n.slice(0, idx);
  }

  async function openSftpBrowserForService(serviceId) {
    sftpBrowseServiceId = serviceId;
    syncServiceFromDom(serviceId);
    const svc = getServiceById(serviceId);
    if (!svc || svc.type !== 'sftp') return;
    const c = svc.config || {};
    const host = (c.host || '').trim();
    const port = c.port != null ? String(c.port) : '22';
    const username = (c.user || '').trim();
    const password = c.password || '';

    // Open the modal first (rather than a blocking alert()) so the error
    // shows in the same inline status area every other browse failure uses.
    const modal = document.getElementById('sftpBrowserModal');
    modal.classList.add('visible');
    cancelNewFolder();
    document.getElementById('browseUpBtn').disabled = true;
    document.getElementById('browseHomeBtn').disabled = true;
    document.getElementById('newFolderToggleBtn').disabled = true;

    if (!host || !username) {
      setBrowserState('Fill in Host and Username on the service card first, then try again.', true);
      return;
    }

    setBrowserState('Connecting to ' + host + '…');

    const result = await window.api.sftpBrowseOpen({
      host,
      port,
      username,
      password
    });
    if (!result.success) {
      setBrowserState('Could not connect: ' + result.error, true);
      return;
    }

    browser.sessionId = result.sessionId;
    browser.home = normalizePath(result.home || '/');

    document.getElementById('browseHomeBtn').disabled = false;
    document.getElementById('newFolderToggleBtn').disabled = false;

    const typed = normalizePath((c.basePath || '').trim());
    const startPath = typed && typed !== '/' ? typed : browser.home;
    await navigateTo(startPath, true);
  }

  async function closeSftpBrowser() {
    const modal = document.getElementById('sftpBrowserModal');
    modal.classList.remove('visible');
    cancelNewFolder();
    sftpBrowseServiceId = null;
    if (browser.sessionId) {
      const id = browser.sessionId;
      browser.sessionId = null;
      try { await window.api.sftpBrowseClose({ sessionId: id }); } catch (e) { /* session is being discarded either way */ }
    }
  }

  function onBrowserOverlayClick(e) {
    if (e.target.id === 'sftpBrowserModal') closeSftpBrowser();
  }

  async function navigateTo(targetPath, fallbackOnError = false) {
    if (!browser.sessionId || browser.loading) return;
    const target = normalizePath(targetPath);
    browser.loading = true;
    setBrowserState('Loading ' + target + '…');

    const res = await window.api.sftpBrowseList({ sessionId: browser.sessionId, path: target });
    browser.loading = false;

    if (!res.success) {
      if (fallbackOnError && target !== browser.home) {
        await navigateTo(browser.home, false);
        return;
      }
      setBrowserState('Error: ' + res.error, true);
      return;
    }

    browser.path = res.path;
    renderBrowser(res.entries);
  }

  function renderBrowser(entries) {
    document.getElementById('browseSelected').textContent = browser.path;
    document.getElementById('browseUpBtn').disabled = browser.path === '/';
    renderCrumbs(browser.path);

    const list = document.getElementById('browseList');
    const state = document.getElementById('browseState');
    list.innerHTML = '';

    if (entries.length === 0) {
      state.textContent = 'No subfolders here. Use "Select Folder" to choose this path, or create a new one.';
      state.classList.remove('error');
      state.style.display = 'block';
      list.style.display = 'none';
      return;
    }

    state.style.display = 'none';
    list.style.display = 'block';

    if (browser.path !== '/') {
      const up = document.createElement('div');
      up.className = 'dir-item parent';
      up.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" opacity=".4"/><path d="M12 14l-4-4h3V6h2v4h3z" transform="rotate(180 12 12)"/></svg>
        <span class="dir-item-name">..</span>
      `;
      up.onclick = () => navigateTo(parentPath(browser.path));
      list.appendChild(up);
    }

    for (const name of entries) {
      const item = document.createElement('div');
      item.className = 'dir-item';
      item.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
        <span class="dir-item-name"></span>
      `;
      item.querySelector('.dir-item-name').textContent = name;
      item.onclick = () => navigateTo(joinPath(browser.path, name));
      list.appendChild(item);
    }
  }

  function renderCrumbs(path) {
    const wrap = document.getElementById('browseCrumbs');
    wrap.innerHTML = '';

    const rootLink = document.createElement('a');
    rootLink.className = 'crumb';
    rootLink.textContent = '/';
    rootLink.onclick = () => navigateTo('/');
    wrap.appendChild(rootLink);

    if (path === '/') {
      rootLink.classList.add('crumb-current');
      return;
    }

    const parts = path.split('/').filter(Boolean);
    let acc = '';
    parts.forEach((part, i) => {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      wrap.appendChild(sep);

      acc += '/' + part;
      const isLast = i === parts.length - 1;
      const seg = document.createElement(isLast ? 'span' : 'a');
      seg.className = isLast ? 'crumb crumb-current' : 'crumb';
      seg.textContent = part;
      if (!isLast) {
        const here = acc;
        seg.onclick = () => navigateTo(here);
      }
      wrap.appendChild(seg);
    });
  }

  function setBrowserState(msg, isError = false) {
    const list = document.getElementById('browseList');
    const state = document.getElementById('browseState');
    list.style.display = 'none';
    state.style.display = 'block';
    state.textContent = msg;
    state.classList.toggle('error', isError);
  }

  function browseGoUp() {
    if (browser.path === '/') return;
    navigateTo(parentPath(browser.path));
  }

  function browseGoHome() {
    navigateTo(browser.home);
  }

  function selectCurrentFolder() {
    if (sftpBrowseServiceId) {
      const svc = getServiceById(sftpBrowseServiceId);
      if (svc && svc.type === 'sftp') {
        svc.config.basePath = browser.path;
        markServiceUnchecked(sftpBrowseServiceId);
        renderServiceCards();
        saveServicesDebounced();
      }
    }
    sftpBrowseServiceId = null;
    closeSftpBrowser();
  }

  function toggleNewFolder() {
    const row = document.getElementById('newFolderRow');
    const visible = row.classList.toggle('visible');
    if (visible) {
      const input = document.getElementById('newFolderInput');
      input.value = '';
      input.focus();
    }
  }

  function cancelNewFolder() {
    document.getElementById('newFolderRow').classList.remove('visible');
    document.getElementById('newFolderInput').value = '';
  }

  function onNewFolderKey(e) {
    if (e.key === 'Enter') confirmNewFolder();
    else if (e.key === 'Escape') cancelNewFolder();
  }

  async function confirmNewFolder() {
    const input = document.getElementById('newFolderInput');
    const raw = input.value.trim();
    if (!raw || !browser.sessionId) return;
    // Disallow slashes to keep things predictable.
    if (/[\\/]/.test(raw)) {
      input.focus();
      input.select();
      return;
    }
    const target = joinPath(browser.path, raw);
    setBrowserState('Creating ' + target + '…');
    const res = await window.api.sftpBrowseMkdir({ sessionId: browser.sessionId, path: target });
    if (!res.success) {
      setBrowserState('Could not create folder: ' + res.error, true);
      return;
    }
    cancelNewFolder();
    await navigateTo(target);
  }

  // Escape closes the modal
  // Escape ordering: lightbox → detail pane → modal/settings → side drawer → popovers
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The confirm modal takes priority over everything, including the
    // onboarding-overlay guard below — it's the topmost thing on screen
    // whenever it's open, same as a native confirm() would have been.
    if (document.getElementById('confirmModal').classList.contains('visible')) {
      resolveConfirmModal(false);
      return;
    }
    if (
      isOnboardingOverlayVisible() &&
      !document.getElementById('settingsDrawer').classList.contains('visible') &&
      !document.getElementById('sftpBrowserModal').classList.contains('visible') &&
      !document.getElementById('addServiceModal').classList.contains('visible')
    ) {
      return;
    }
    const lb = document.getElementById('photoLightbox');
    if (lb && !lb.hidden) {
      closePhotoLightbox();
      return;
    }
    if (detailFocusedIdx !== null) {
      clearDetailTileFocus();
      return;
    }
    if (document.getElementById('sftpBrowserModal').classList.contains('visible')) {
      closeSftpBrowser();
    } else if (document.getElementById('addServiceModal').classList.contains('visible')) {
      closeAddServicePicker();
    } else if (document.getElementById('settingsDrawer').classList.contains('visible')) {
      closeSettings();
    } else if (document.getElementById('sideDrawer').classList.contains('visible')) {
      closeSideDrawer();
    } else {
      hideUploadErrorPopover();
    }
  });

