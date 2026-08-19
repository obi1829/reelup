  // ─── Upload services (settings + destination buttons) ─
  // Despite the filename, this file also owns folder selection and scan
  // orchestration (see pickFolder()/loadFolder() near the bottom) — that
  // logic ended up here rather than in a differently-named file during the
  // main.js split. Noting it here rather than relocating working code for a
  // purely organizational reason.
  function cloneService(s) {
    return {
      id: s.id,
      type: s.type,
      label: s.label || s.type,
      enabled: s.enabled !== false,
      config: { ...(s.config || {}) },
      connectionVerified: !!s.connectionVerified,
      lastTestFailed: !!s.lastTestFailed,
      lastTestError: s.lastTestError ? String(s.lastTestError) : ''
    };
  }

  /** Status dot only (green / yellow / red) — shown next to type label. */
  function getServiceStatusDotClass(svc) {
    if (!svc) return 'is-warn';
    if (svc.connectionVerified) return 'is-ok';
    if (svc.lastTestFailed) return 'is-fail';
    return 'is-warn';
  }

  function getServiceConnectionTitle(svc) {
    if (!svc) return 'Not tested';
    if (svc.connectionVerified) return 'Connected';
    if (svc.lastTestFailed) return svc.lastTestError ? `Connection failed: ${svc.lastTestError}` : 'Connection failed';
    return 'Not tested';
  }

  function updateServiceCardFooter(id) {
    const card = document.querySelector(`.service-card[data-service-id="${id}"]`);
    if (!card) return;
    const dot = card.querySelector('.service-card-type-row .svc-status-dot');
    if (!dot) return;
    const svc = getServiceById(id);
    dot.className = 'svc-status-dot ' + getServiceStatusDotClass(svc);
    const tip = getServiceConnectionTitle(svc);
    dot.title = tip;
    dot.setAttribute('aria-label', 'Connection: ' + tip);
  }

  function serviceTypeLabel(type) {
    switch (type) {
      case 'immich': return 'Immich API';
      case 'sftp': return 'SFTP / SSH';
      case 'nextcloud': return 'Nextcloud';
      case 'dropbox': return 'Dropbox';
      case 'local': return 'Local folder';
      default: return type;
    }
  }

  function defaultServiceLabel(type) {
    switch (type) {
      case 'immich': return 'Immich';
      case 'sftp': return 'SFTP';
      case 'nextcloud': return 'Nextcloud';
      case 'dropbox': return 'Dropbox';
      case 'local': return 'Local folder';
      default: return 'Service';
    }
  }

  function defaultServiceConfig(type) {
    switch (type) {
      case 'immich': return { serverUrl: '', apiKey: '', allowSelfSigned: false };
      case 'sftp':
        return {
          host: '',
          port: 22,
          user: '',
          password: '',
          basePath: '/Photos/RAW_Photos'
        };
      case 'nextcloud':
        return { serverUrl: '', username: '', password: '', uploadPath: '/Photos', allowSelfSigned: false };
      case 'dropbox':
        return { accessToken: '', uploadPath: '/Photos' };
      case 'local':
        return { destPath: '' };
      default: return {};
    }
  }

  function serviceIconSvg(type) {
    switch (type) {
      case 'immich':
        return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
      case 'sftp':
        return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-2.18c.11-.31.18-.65.18-1a2.996 2.996 0 0 0-5.5-1.65l-.5.67-.5-.68C11.01 2.51 10.03 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2z"/></svg>';
      case 'nextcloud':
        return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
      case 'dropbox':
        return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2l6 3.75L18 2 24 5.75 18 9.5l-6-3.5L6 9.5 0 5.75zm12 10.25L24 16 18 19.75 12 16.25 6 20 0 16.25l6-3.5 6 3.5 6-3.75z"/></svg>';
      case 'local':
        return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>';
      default:
        return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.77 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    }
  }

  function getServiceById(id) {
    return localServices.find((x) => x.id === id) || null;
  }

  function enabledUploadServices() {
    return localServices.filter((s) => s.enabled);
  }

  function pickInitialActiveId(list, previousId) {
    const en = list.filter((s) => s.enabled);
    if (en.length === 1) return en[0].id;
    if (previousId && en.some((s) => s.id === previousId)) return previousId;
    return en[0] ? en[0].id : null;
  }

  function renderUploadDestinationButtons() {
    const grid = document.getElementById('uploadDestGrid');
    const empty = document.getElementById('uploadDestEmpty');
    if (!grid || !empty) return;

    grid.innerHTML = '';
    const enabled = enabledUploadServices();

    if (enabled.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    if (!enabled.some((s) => s.id === activeServiceId)) {
      activeServiceId = pickInitialActiveId(localServices, null);
    }

    for (const svc of enabled) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'upload-dest-btn' + (svc.id === activeServiceId ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.dataset.serviceId = svc.id;
      btn.onclick = () => selectUploadDestination(svc.id);

      const inner = document.createElement('div');
      inner.className = 'ud-inner';

      const icoWrap = document.createElement('span');
      // serviceIconSvg is a switch over a fixed set of hardcoded SVG strings.
      // eslint-disable-next-line no-unsanitized/property
      icoWrap.innerHTML = serviceIconSvg(svc.type);
      const ico = icoWrap.firstElementChild;
      if (ico) {
        ico.classList.add('ud-ico');
        ico.setAttribute('aria-hidden', 'true');
      }

      const lab = document.createElement('span');
      lab.className = 'ud-label';
      lab.textContent = svc.label || serviceTypeLabel(svc.type);

      const dot = document.createElement('span');
      dot.className = 'conn-dot' + (svc.connectionVerified ? ' ok' : '');
      dot.title = svc.connectionVerified ? 'Connection tested' : 'Not tested yet';

      inner.append(ico || document.createTextNode(''), lab, dot);
      btn.append(inner);
      grid.append(btn);
    }
  }

  async function selectUploadDestination(id) {
    for (const x of localServices) syncServiceFromDom(x.id);
    activeServiceId = id;
    renderUploadDestinationButtons();
    try {
      const prev = await window.api.getSettings();
      prev.activeServiceId = activeServiceId;
      prev.services = localServices.map(cloneService);
      await window.api.saveSettings(prev);
    } catch (e) { /* ignore */ }
  }

  function syncServiceFromDom(id) {
    const card = document.querySelector(`.service-card[data-service-id="${id}"]`);
    const svc = getServiceById(id);
    if (!card || !svc) return;

    const labelInp = card.querySelector(`[data-field="label"]`);
    if (labelInp) svc.label = labelInp.value.trim() || defaultServiceLabel(svc.type);

    const enabledEl = card.querySelector(`[data-field="enabled"]`);
    if (enabledEl) svc.enabled = !!enabledEl.checked;

    const c = svc.config;
    if (svc.type === 'immich') {
      c.serverUrl = (card.querySelector('[data-k="serverUrl"]')?.value || '').trim();
      c.apiKey = (card.querySelector('[data-k="apiKey"]')?.value || '').trim();
      c.allowSelfSigned = !!card.querySelector('[data-k="allowSelfSigned"]')?.checked;
    } else if (svc.type === 'sftp') {
      c.host = (card.querySelector('[data-k="host"]')?.value || '').trim();
      c.port = parseInt(card.querySelector('[data-k="port"]')?.value, 10) || 22;
      c.user = (card.querySelector('[data-k="user"]')?.value || '').trim();
      c.password = card.querySelector('[data-k="password"]')?.value || '';
      c.basePath = (card.querySelector('[data-k="basePath"]')?.value || '').trim();
    } else if (svc.type === 'nextcloud') {
      c.serverUrl = (card.querySelector('[data-k="serverUrl"]')?.value || '').trim();
      c.username = (card.querySelector('[data-k="username"]')?.value || '').trim();
      c.password = card.querySelector('[data-k="password"]')?.value || '';
      c.uploadPath = (card.querySelector('[data-k="uploadPath"]')?.value || '').trim() || '/Photos';
      c.allowSelfSigned = !!card.querySelector('[data-k="allowSelfSigned"]')?.checked;
    } else if (svc.type === 'dropbox') {
      c.accessToken = (card.querySelector('[data-k="accessToken"]')?.value || '').trim();
      c.uploadPath = (card.querySelector('[data-k="uploadPath"]')?.value || '').trim() || '/Photos';
    } else if (svc.type === 'local') {
      c.destPath = (card.querySelector('[data-k="destPath"]')?.value || '').trim();
    }
  }

  function renderServiceCards() {
    const root = document.getElementById('servicesListContainer');
    if (!root) return;
    root.innerHTML = '';

    for (const svc of localServices) {
      const card = document.createElement('div');
      card.className = 'service-card' + (expandedServiceIds.has(svc.id) ? ' expanded' : '');
      card.dataset.serviceId = svc.id;

      const head = document.createElement('div');
      head.className = 'service-card-head';

      const ic = document.createElement('div');
      ic.className = 'service-card-icon';
      // serviceIconSvg is a switch over a fixed set of hardcoded SVG strings.
      // eslint-disable-next-line no-unsanitized/property
      ic.innerHTML = serviceIconSvg(svc.type);

      const meta = document.createElement('div');
      meta.className = 'service-card-meta';

      const labelInp = document.createElement('input');
      labelInp.type = 'text';
      labelInp.className = 'service-label-input';
      labelInp.dataset.field = 'label';
      labelInp.value = svc.label || '';
      labelInp.placeholder = 'Display name';
      labelInp.addEventListener('input', () => {
        saveServicesDebounced();
        renderUploadDestinationButtons();
      });

      const dotClass = getServiceStatusDotClass(svc);
      const typeRowWrap = document.createElement('div');
      typeRowWrap.className = 'service-card-type-row';
      const statusDot = document.createElement('span');
      statusDot.className = 'svc-status-dot ' + dotClass;
      statusDot.setAttribute('role', 'img');
      statusDot.setAttribute('aria-label', 'Connection: ' + getServiceConnectionTitle(svc));
      statusDot.title = getServiceConnectionTitle(svc);
      const typeText = document.createElement('span');
      typeText.className = 'service-card-type';
      typeText.textContent = serviceTypeLabel(svc.type);
      typeRowWrap.append(statusDot, typeText);

      meta.append(labelInp, typeRowWrap);

      const enWrap = document.createElement('div');
      enWrap.className = 'service-card-enabled-wrap';
      const enCap = document.createElement('span');
      enCap.className = 'service-enabled-caption';
      enCap.textContent = 'Enabled';
      const enLabel = document.createElement('label');
      enLabel.className = 'toggle';
      const enCb = document.createElement('input');
      enCb.type = 'checkbox';
      enCb.dataset.field = 'enabled';
      enCb.checked = svc.enabled !== false;
      enCb.addEventListener('change', () => {
        syncServiceFromDom(svc.id);
        saveServicesDebounced();
        renderUploadDestinationButtons();
      });
      const enSlider = document.createElement('span');
      enSlider.className = 'toggle-slider';
      enLabel.append(enCb, enSlider);
      enWrap.append(enCap, enLabel);

      const actions = document.createElement('div');
      actions.className = 'service-card-actions';

      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.className = 'btn-edit-card';
      btnEdit.textContent = expandedServiceIds.has(svc.id) ? 'Collapse' : 'Edit';
      btnEdit.onclick = () => toggleServiceExpand(svc.id);

      const btnRm = document.createElement('button');
      btnRm.type = 'button';
      btnRm.className = 'btn-remove-ghost';
      btnRm.setAttribute('aria-label', 'Remove service');
      btnRm.title = 'Remove service';
      btnRm.onclick = () => removeService(svc.id);
      btnRm.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg><span class="btn-remove-label">Remove</span>';

      actions.append(btnEdit, btnRm);

      const headRight = document.createElement('div');
      headRight.className = 'service-card-head-right';
      headRight.append(enWrap, actions);

      head.append(ic, meta, headRight);

      const body = document.createElement('div');
      body.className = 'service-card-body';
      const configEl = buildServiceConfigFields(svc);
      body.append(configEl);

      const testRow = document.createElement('div');
      testRow.className = 'connection-test';
      const btnTest = document.createElement('button');
      btnTest.type = 'button';
      btnTest.className = 'btn-test';
      btnTest.textContent = 'Test Connection';
      btnTest.onclick = () => testServiceConnection(svc.id);
      testRow.append(btnTest);

      // SFTP-only recovery action for the host-key-mismatch error (see
      // hostKeyMismatchMessage() in backends/sftp.js) — previously the only
      // fix was manually deleting sftp-known-hosts.json.
      if (svc.type === 'sftp') {
        const btnForget = document.createElement('button');
        btnForget.type = 'button';
        btnForget.className = 'btn-test';
        btnForget.textContent = 'Forget trusted host key';
        btnForget.title = 'If the server was reinstalled and its key changed, clear the previously trusted key so you can reconnect.';
        btnForget.onclick = () => forgetSftpTrustedHostKey(svc.id);
        testRow.append(btnForget);
      }

      const statusEl = document.createElement('div');
      statusEl.className = 'connection-status';
      statusEl.dataset.testStatus = svc.id;
      statusEl.textContent = '—';
      testRow.append(statusEl);
      body.append(testRow);

      card.append(head, body);
      root.append(card);
    }
  }

  function buildServiceConfigFields(svc) {
    const wrap = document.createElement('div');

    const field = (label, inputEl, hint) => {
      const block = document.createElement('div');
      block.className = 'settings-field';
      const lab = document.createElement('div');
      lab.className = 'settings-label';
      lab.textContent = label;
      block.append(lab, inputEl);
      if (hint) {
        const h = document.createElement('div');
        h.className = 'settings-hint';
        h.textContent = hint;
        block.append(h);
      }
      return block;
    };

    const textInput = (k, val, ph, type = 'text') => {
      const inp = document.createElement('input');
      inp.type = type;
      inp.className = 'settings-input';
      inp.dataset.k = k;
      inp.value = val != null ? val : '';
      inp.placeholder = ph;
      inp.addEventListener('input', () => {
        markServiceUnchecked(svc.id);
        saveServicesDebounced();
      });
      return inp;
    };

    // Reuses the same .toggle/.toggle-slider switch used for "Enabled"/
    // "Delete after upload" elsewhere, so it looks native to this UI rather
    // than a plain browser checkbox.
    const toggleField = (k, label, checked, hint) => {
      const row = document.createElement('div');
      row.className = 'settings-field';
      const rowInner = document.createElement('div');
      rowInner.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
      const lab = document.createElement('div');
      lab.className = 'settings-label';
      lab.textContent = label;
      const toggle = document.createElement('label');
      toggle.className = 'toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.k = k;
      cb.checked = !!checked;
      cb.addEventListener('change', () => {
        markServiceUnchecked(svc.id);
        saveServicesDebounced();
      });
      const slider = document.createElement('span');
      slider.className = 'toggle-slider';
      toggle.append(cb, slider);
      rowInner.append(lab, toggle);
      row.append(rowInner);
      if (hint) {
        const h = document.createElement('div');
        h.className = 'settings-hint';
        h.textContent = hint;
        row.append(h);
      }
      return row;
    };

    const c = svc.config || {};

    if (svc.type === 'immich') {
      wrap.append(
        field('Server URL', textInput('serverUrl', c.serverUrl, 'http://192.168.1.x:2283'), 'No trailing slash'),
        field('API Key', textInput('apiKey', c.apiKey, 'Paste your Immich API key', 'password'), 'Requires: asset.upload, asset.read, asset.view'),
        toggleField('allowSelfSigned', 'Allow self-signed certificate', c.allowSelfSigned,
          'Only for a private/home server using a self-signed or internal-CA HTTPS certificate. Leave off for normal setups.')
      );
    } else if (svc.type === 'sftp') {
      const grid1 = document.createElement('div');
      grid1.style.cssText = 'display:grid;grid-template-columns:1fr 80px;gap:10px;';
      const hostF = document.createElement('div');
      hostF.className = 'settings-field';
      hostF.innerHTML = '<div class="settings-label">Host</div>';
      hostF.append(textInput('host', c.host, 'host or IP'));
      const portF = document.createElement('div');
      portF.className = 'settings-field';
      portF.innerHTML = '<div class="settings-label">Port</div>';
      portF.append(textInput('port', c.port != null ? String(c.port) : '22', '22'));
      grid1.append(hostF, portF);
      const grid2 = document.createElement('div');
      grid2.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;';
      const uF = document.createElement('div');
      uF.className = 'settings-field';
      uF.innerHTML = '<div class="settings-label">Username</div>';
      uF.append(textInput('user', c.user, 'user'));
      const pF = document.createElement('div');
      pF.className = 'settings-field';
      pF.innerHTML = '<div class="settings-label">Password</div>';
      pF.append(textInput('password', c.password, 'Password', 'password'));
      grid2.append(uF, pF);
      wrap.append(grid1, grid2);

      const baseInp = textInput('basePath', c.basePath, '/path/on/server');
      const browseWrap = document.createElement('div');
      browseWrap.className = 'input-with-btn';
      browseWrap.append(baseInp);
      const bBtn = document.createElement('button');
      bBtn.type = 'button';
      bBtn.className = 'btn-input';
      bBtn.title = 'Browse remote folders over SFTP';
      bBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg> Browse';
      bBtn.onclick = () => openSftpBrowserForService(svc.id);
      browseWrap.append(bBtn);
      wrap.append(field('Destination base path', browseWrap, 'Files go to BasePath/YYYY/YYYY-MM-DD/'));
    } else if (svc.type === 'nextcloud') {
      wrap.append(
        field('Server URL', textInput('serverUrl', c.serverUrl, 'https://cloud.example.com'), 'Nextcloud root URL'),
        field('Username', textInput('username', c.username, 'account name')),
        field('Password', textInput('password', c.password, 'Password', 'password')),
        field('Upload path', textInput('uploadPath', c.uploadPath || '/Photos', '/Photos'), 'Appended under your WebDAV files root'),
        toggleField('allowSelfSigned', 'Allow self-signed certificate', c.allowSelfSigned,
          'Only for a private/home server using a self-signed or internal-CA HTTPS certificate. Leave off for normal setups.')
      );
    } else if (svc.type === 'dropbox') {
      const tokenRow = textInput('accessToken', c.accessToken, 'Dropbox access token', 'password');
      const tokBlock = field('Access token', tokenRow);
      const link = document.createElement('a');
      link.href = 'https://www.dropbox.com/developers/apps';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.cssText = 'font-size:11px;color:var(--accent);margin-top:4px;display:inline-block;';
      link.textContent = 'Get token (Dropbox App Console)';
      tokBlock.append(link);
      wrap.append(
        tokBlock,
        field('Upload path', textInput('uploadPath', c.uploadPath || '/Photos', '/Photos'), 'Folder in your Dropbox (date subfolders are created automatically)')
      );
    } else if (svc.type === 'local') {
      const destInp = textInput('destPath', c.destPath, 'C:\\Users\\you\\Pictures\\Archive');
      const browseWrap = document.createElement('div');
      browseWrap.className = 'input-with-btn';
      browseWrap.append(destInp);
      const bBtn = document.createElement('button');
      bBtn.type = 'button';
      bBtn.className = 'btn-input';
      bBtn.title = 'Choose destination folder';
      bBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg> Browse';
      bBtn.onclick = async () => {
        const picked = await window.api.pickFolder({ title: 'Select destination folder' });
        if (picked) {
          destInp.value = picked;
          markServiceUnchecked(svc.id);
          saveServicesDebounced();
        }
      };
      browseWrap.append(bBtn);
      wrap.append(field('Destination folder', browseWrap, 'Files are copied to DestinationFolder/YYYY/YYYY-MM-DD/'));
    }

    return wrap;
  }

  function markServiceUnchecked(id) {
    const svc = getServiceById(id);
    if (svc) {
      svc.connectionVerified = false;
      svc.lastTestFailed = false;
      updateServiceCardFooter(id);
    }
    renderUploadDestinationButtons();
  }

  function saveServicesDebounced() {
    if (servicesSaveTimer) clearTimeout(servicesSaveTimer);
    servicesSaveTimer = setTimeout(async () => {
      servicesSaveTimer = 0;
      for (const s of localServices) syncServiceFromDom(s.id);
      try {
        const prev = await window.api.getSettings();
        prev.services = localServices.map(cloneService);
        prev.activeServiceId = activeServiceId;
        await window.api.saveSettings(prev);
      } catch (e) { /* ignore */ }
    }, 400);
  }

  function toggleServiceExpand(id) {
    if (expandedServiceIds.has(id)) expandedServiceIds.delete(id);
    else expandedServiceIds.add(id);
    renderServiceCards();
  }

  async function removeService(id) {
    const svc = getServiceById(id);
    if (!svc) return;
    const confirmed = await confirmAction(`Remove service "${svc.label}"?`, { okLabel: 'Remove' });
    if (!confirmed) return;
    localServices = localServices.filter((s) => s.id !== id);
    expandedServiceIds.delete(id);
    if (activeServiceId === id) activeServiceId = pickInitialActiveId(localServices, null);
    renderServiceCards();
    renderUploadDestinationButtons();
    try {
      const prev = await window.api.getSettings();
      prev.services = localServices.map(cloneService);
      prev.activeServiceId = activeServiceId;
      await window.api.saveSettings(prev);
    } catch (e) { /* ignore */ }
  }

  function addServiceOfType(type) {
    const svc = {
      id: crypto.randomUUID(),
      type,
      label: defaultServiceLabel(type),
      enabled: true,
      config: defaultServiceConfig(type),
      connectionVerified: false,
      lastTestFailed: false
    };
    localServices.push(svc);
    expandedServiceIds.add(svc.id);
    activeServiceId = svc.id;
    renderServiceCards();
    renderUploadDestinationButtons();
    saveServicesDebounced();
  }

  function openAddServicePicker() {
    document.getElementById('addServiceModal').classList.add('visible');
  }

  function closeAddServicePicker() {
    document.getElementById('addServiceModal').classList.remove('visible');
  }

  function onAddServiceOverlayClick(e) {
    if (e.target.id === 'addServiceModal') closeAddServicePicker();
  }

  async function testServiceConnection(id) {
    syncServiceFromDom(id);
    const svc = cloneService(getServiceById(id));
    if (!svc) return;
    const statusEl = document.querySelector(`[data-test-status="${id}"]`);
    if (statusEl) {
      statusEl.className = 'connection-status';
      statusEl.textContent = 'Testing…';
    }
    const result = await window.api.testService(svc);
    const real = getServiceById(id);
    if (real) {
      real.connectionVerified = !!result.success;
      real.lastTestFailed = !result.success;
      // Persisted (not just shown in the ephemeral status line below) so the
      // service card's tooltip still explains *why* — e.g. an SFTP host-key
      // mismatch warning — after the user navigates away and comes back.
      real.lastTestError = result.success ? '' : String(result.error || 'Connection failed');
    }
    if (statusEl) {
      statusEl.className = 'connection-status ' + (result.success ? 'ok' : 'err');
      statusEl.textContent = result.success ? '✓ Connected' : ('✗ ' + (result.error || 'Failed'));
    }
    try {
      const prev = await window.api.getSettings();
      prev.services = localServices.map(cloneService);
      await window.api.saveSettings(prev);
    } catch (e) { /* ignore */ }
    renderServiceCards();
    renderUploadDestinationButtons();
  }

  async function forgetSftpTrustedHostKey(id) {
    syncServiceFromDom(id);
    const svc = getServiceById(id);
    if (!svc || svc.type !== 'sftp') return;
    const host = (svc.config.host || '').trim();
    if (!host) return;
    const port = svc.config.port != null ? svc.config.port : 22;
    await window.api.sftpForgetHostKey({ host, port });
    svc.connectionVerified = false;
    svc.lastTestFailed = false;
    svc.lastTestError = '';
    const statusEl = document.querySelector(`[data-test-status="${id}"]`);
    if (statusEl) {
      statusEl.className = 'connection-status';
      statusEl.textContent = 'Trusted host key cleared — Test Connection will now trust whatever key the server presents.';
    }
    updateServiceCardFooter(id);
  }

  // Jump to services in Settings
  function goToModeSettings() {
    openSettings('section-services');
  }

  function isOnboardingOverlayVisible() {
    const el = document.getElementById('onboardingOverlay');
    return !!(el && !el.hasAttribute('hidden'));
  }

  function onboardingGoToStep(n) {
    document.querySelectorAll('[data-onboard-step]').forEach((el) => {
      const step = parseInt(el.getAttribute('data-onboard-step'), 10);
      const on = step === n;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
    if (n === 3) refreshOnboardingSummary();
  }

  function refreshOnboardingSummary() {
    const box = document.getElementById('onboardingSummary');
    if (!box) return;
    if (!localServices.length) {
      box.innerHTML =
        '<p>No upload destination yet. You can add Immich, SFTP, or cloud services in <strong>Settings → Services</strong> anytime.</p>';
      return;
    }
    // Reuses serviceTypeLabel() (defined above) rather than its own copy —
    // a second inline map here previously drifted out of sync and was
    // missing the 'local' case.
    const items = localServices
      .map((s) => {
        const kind = escapeHtml(serviceTypeLabel(s.type));
        const name = escapeHtml((s.label && String(s.label).trim()) || serviceTypeLabel(s.type));
        return `<li><strong>${name}</strong> — ${kind}</li>`;
      })
      .join('');
    // localServices.length is a number; items' name/kind are pre-escaped via escapeHtml above.
    // eslint-disable-next-line no-unsanitized/property
    box.innerHTML = `<p><strong>${localServices.length} destination(s) ready:</strong></p><ul>${items}</ul>`;
  }

  // Same "create a stub service, then let the user fill it in" pattern as
  // the normal "+ Add Service" flow in Settings (addServiceImmichBtn etc. in
  // init.js) — intentionally consistent, not onboarding-specific behavior.
  function onboardingConfigureService(type) {
    addServiceOfType(type);
    openSettings('section-services');
  }

  function showOnboardingOverlay() {
    onboardingGoToStep(1);
    const ov = document.getElementById('onboardingOverlay');
    if (ov) {
      ov.removeAttribute('hidden');
      ov.setAttribute('aria-hidden', 'false');
    }
  }

  async function completeOnboarding() {
    try {
      const p = await window.api.getSettings();
      await window.api.saveSettings({ ...p, onboardingComplete: true });
    } catch (e) { /* ignore */ }
    const ov = document.getElementById('onboardingOverlay');
    if (ov) {
      ov.setAttribute('hidden', '');
      ov.setAttribute('aria-hidden', 'true');
    }
  }

  async function syncOnboardingFromSettings(settings) {
    if (settings.onboardingComplete === true) {
      const ov = document.getElementById('onboardingOverlay');
      if (ov) {
        ov.setAttribute('hidden', '');
        ov.setAttribute('aria-hidden', 'true');
      }
      return;
    }
    showOnboardingOverlay();
  }

  async function relaunchOnboarding() {
    try {
      const p = await window.api.getSettings();
      await window.api.saveSettings({ ...p, onboardingComplete: false });
    } catch (e) { /* ignore */ }
    closeSettings();
    showOnboardingOverlay();
  }

  // ─── Settings ────────────────────────────────────────
  async function loadSettings() {
    const s = await window.api.getSettings();
    localServices = Array.isArray(s.services) ? s.services.map(cloneService) : [];
    const prevActive = s.activeServiceId || null;
    activeServiceId = pickInitialActiveId(localServices, prevActive);

    document.getElementById('concurrency').value = s.concurrency || 4;
    document.getElementById('deleteAfterUpload').checked = s.deleteAfterUpload || false;
    applyPalette(s.palette || 'midnight');
    applyTheme(s.theme || 'dark');
    gridZoomLevel = Math.min(5, Math.max(1, Math.round(Number(s.gridZoomLevel) || 3)));
    const zs = document.getElementById('gridZoomSlider');
    if (zs) zs.value = String(6 - gridZoomLevel);

    renderServiceCards();
    renderUploadDestinationButtons();
    wireGridZoomSlider();
    await syncOnboardingFromSettings(s);
    if (scannedFiles.length > 0) {
      requestAnimationFrame(() => {
        if (computeLayout()) scheduleRender();
      });
    }
  }

  async function saveSettings() {
    for (const x of localServices) syncServiceFromDom(x.id);
    const prev = await window.api.getSettings();
    const s = {
      ...prev,
      services: localServices.map(cloneService),
      activeServiceId,
      concurrency: parseInt(document.getElementById('concurrency').value) || 4,
      deleteAfterUpload: document.getElementById('deleteAfterUpload').checked,
      theme: currentTheme,
      palette: currentPalette,
      gridZoomLevel: Math.min(5, Math.max(1, Math.round(Number(gridZoomLevel) || 3)))
    };
    await window.api.saveSettings(s);
    renderUploadDestinationButtons();
    const el = document.getElementById('saveConfirm');
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 2000);
  }

  let gridZoomSliderWired = false;
  function persistGridZoomToStoreSoon() {
    if (gridZoomSaveTimer) clearTimeout(gridZoomSaveTimer);
    gridZoomSaveTimer = setTimeout(async () => {
      gridZoomSaveTimer = 0;
      try {
        const prev = await window.api.getSettings();
        prev.gridZoomLevel = Math.min(
          5,
          Math.max(1, Math.round(Number(gridZoomLevel) || 3))
        );
        await window.api.saveSettings(prev);
      } catch (e) { /* ignore */ }
    }, 420);
  }

  function wireGridZoomSlider() {
    const zs = document.getElementById('gridZoomSlider');
    if (!zs || gridZoomSliderWired) return;
    gridZoomSliderWired = true;
    zs.addEventListener('input', () => {
      const sv = Math.min(
        5,
        Math.max(1, Math.round(Number(zs.value) || 3))
      );
      gridZoomLevel = 6 - sv;
      if (!computeLayout()) return;
      for (const [idx, tile] of tilesByIdx) {
        tile.style.width = vGrid.tileSize + 'px';
        tile.style.height = vGrid.tileSize + 'px';
        positionTile(tile, idx);
      }
      scheduleRender();
      persistGridZoomToStoreSoon();
    });
  }

  // ─── Folder selection ────────────────────────────────
  async function pickFolder() {
    if (isUploading) return;
    const folder = await window.api.pickFolder();
    if (!folder) return;
    await loadFolder(folder);
  }

  async function loadFolder(folder) {
    selectedFolder = folder;
    document.getElementById('folderPath').textContent = folder;
    document.getElementById('folderInfo').classList.add('visible');
    document.getElementById('fileCount').textContent = '...';
    document.getElementById('totalCount').textContent = '...';
    document.getElementById('totalSize').textContent = 'scanning';

    const photoEmpty = document.getElementById('photoEmpty');
    photoEmpty.style.display = 'flex';
    photoEmpty.innerHTML = `
      <svg class="scan-spinner" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg>
      <p data-scan-msg>Scanning…</p>
      <p class="hint" data-scan-detail></p>
    `;
    const scanMsg = photoEmpty.querySelector('[data-scan-msg]');
    const scanDetail = photoEmpty.querySelector('[data-scan-detail]');
    scanMsg.textContent = `Scanning ${folder}…`;

    // Release the grid before we kick off the new scan so old folder data
    // doesn't linger if the user re-scans.
    releaseAllTiles();
    clearDetailTileFocus();
    mediaDimensionsCache.clear();
    // Otherwise every RAW/HEIC thumbnail ever resolved stays resident for
    // the app's lifetime across folder/SD-card reloads within one session.
    thumbnailCache.clear();
    pendingThumbJobs.clear();
    selectionCircleAnchorIdx = null;
    scannedFiles = [];
    nameToIdx.clear();
    selectedCount = 0;
    selectedBytes = 0;
    photoGroups = [];
    flattenedDisplayOrder = [];
    flatPosByIdx = [];
    tileGridPosition = [];
    photoLightboxFlatPos = -1;
    const tlEarly = document.getElementById('photoTimelineAnchors');
    if (tlEarly) tlEarly.replaceChildren();
    const stackEarly = getPhotoGridStack();
    if (stackEarly) stackEarly.style.display = 'none';
    const grid = getGrid();
    if (grid) { grid.style.display = 'none'; grid.style.height = '0px'; }

    // Live updates from the main process during the walk.
    let progressPending = false;
    let latestProgress = null;
    const onScanProgress = (payload) => {
      latestProgress = payload;
      if (progressPending) return;
      progressPending = true;
      requestAnimationFrame(() => {
        progressPending = false;
        if (!latestProgress) return;
        const { foundFiles, scannedEntries, currentDir } = latestProgress;
        scanMsg.textContent = `Scanning… ${foundFiles} media file${foundFiles === 1 ? '' : 's'} found`;
        scanDetail.textContent = currentDir
          ? `${scannedEntries} entries · ${currentDir}`
          : `${scannedEntries} entries scanned`;
        document.getElementById('totalCount').textContent = foundFiles;
      });
    };
    window.api.on('scan-progress', onScanProgress);

    let found;
    try {
      found = await window.api.scanFolder(folder);
    } finally {
      window.api.off('scan-progress');
    }

    scannedFiles = found.map(f => ({ ...f, selected: false, status: null }));
    rebuildNameIndex();
    rebuildPhotoDateGroups();
    recomputeSelectionCounters();

    const totalBytes = selectedBytes;
    document.getElementById('totalCount').textContent = scannedFiles.length;
    document.getElementById('totalSize').textContent = formatBytes(totalBytes);

    // Reset upload-related UI from any previous run
    document.getElementById('completeBanner').classList.remove('visible');
    document.getElementById('progressWrap').style.display = 'none';
    setProgressFill(0);
    stats = { success: 0, error: 0, duplicate: 0, total: 0 };
    updateBadges();
    clearLog();

    renderPhotoGrid();
    updateSelectionUi();
    setView('photos');

    addLog('info', `Found ${scannedFiles.length} media files`, formatBytes(totalBytes));
  }

