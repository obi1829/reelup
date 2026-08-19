  // ─── Static event wiring ──────────────────────────────
  // Every element below used to carry an onclick="..."/onkeydown="..."
  // attribute in index.html; those count as inline script for CSP purposes,
  // which forced script-src to allow 'unsafe-inline'. Wiring them here
  // instead lets the CSP drop that and block real inline-script injection.
  // This file loads last (see index.html's closing <script> tags), so every
  // handler function referenced below is already defined in global scope,
  // and the DOM above it is already fully parsed.
  //
  // NOT everything lives here: the photo lightbox (close/prev/next) and the
  // details-pane close button were already wired via addEventListener
  // *before* this migration, inside setupPhotoLightboxInteractions() /
  // setupPhotoGridInteractions() in photo-grid.js, called at grid-setup
  // time rather than at startup — look there first if a grid/lightbox
  // button seems unwired.
  function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  }

  function wireStaticEventHandlers() {
    // Titlebar
    on('hamburgerBtn', 'click', toggleSideDrawer);
    on('settingsBtn', 'click', () => openSettings());
    on('winMinimizeBtn', 'click', () => window.api.minimize());
    on('winMaximizeBtn', 'click', () => window.api.maximize());
    on('winCloseBtn', 'click', () => window.api.close());

    // Onboarding
    on('onboardingStep1CtaBtn', 'click', () => onboardingGoToStep(2));
    on('onboardingDestImmichBtn', 'click', () => onboardingConfigureService('immich'));
    on('onboardingDestSftpBtn', 'click', () => onboardingConfigureService('sftp'));
    on('onboardingAltNextcloudBtn', 'click', () => onboardingConfigureService('nextcloud'));
    on('onboardingAltDropboxBtn', 'click', () => onboardingConfigureService('dropbox'));
    on('onboardingAltLocalBtn', 'click', () => onboardingConfigureService('local'));
    on('onboardingStep2ContinueBtn', 'click', () => onboardingGoToStep(3));
    on('onboardingStep2SkipBtn', 'click', () => onboardingGoToStep(3));
    on('onboardingCompleteBtn', 'click', completeOnboarding);

    // Upload panel
    on('dropZone', 'click', pickFolder);
    on('modeConfigureLink', 'click', goToModeSettings);
    on('uploadDestEmptyLink', 'click', (e) => { e.preventDefault(); openSettings('section-services'); });
    on('uploadBtn', 'click', startUpload);
    on('abortBtn', 'click', abortUpload);
    on('resumeBannerBtn', 'click', resumePendingUpload);
    on('resumeDismissBtn', 'click', dismissPendingUpload);
    on('viewTab-photos', 'click', () => setView('photos'));
    on('viewTab-activity', 'click', () => setView('activity'));
    on('selectAllBtn', 'click', selectAllPhotos);
    on('deselectAllBtn', 'click', deselectAllPhotos);
    on('retryFailedBtn', 'click', retryFailedUpload);
    on('resetBtn', 'click', resetUploadState);
    on('historyClearBtn', 'click', clearUploadHistory);

    // Side drawer
    on('sideDrawerOverlay', 'click', closeSideDrawer);
    on('navLink-upload', 'click', closeSideDrawer);
    on('themeQuickBtn', 'click', toggleTheme);

    // Settings drawer
    on('settingsDrawerOverlay', 'click', closeSettings);
    on('settingsCloseBtn', 'click', closeSettings);
    on('paletteOpt-midnight', 'click', () => setPalette('midnight'));
    on('paletteOpt-ember', 'click', () => setPalette('ember'));
    on('paletteOpt-forest', 'click', () => setPalette('forest'));
    on('paletteOpt-dusk', 'click', () => setPalette('dusk'));
    on('themeOpt-dark', 'click', () => setTheme('dark'));
    on('themeOpt-light', 'click', () => setTheme('light'));
    on('addServiceBtn', 'click', openAddServicePicker);
    on('relaunchOnboardingBtn', 'click', relaunchOnboarding);
    on('saveSettingsBtn', 'click', saveSettings);

    // SFTP remote folder browser modal
    on('sftpBrowserModal', 'click', onBrowserOverlayClick);
    on('sftpBrowserCloseBtn', 'click', closeSftpBrowser);
    on('browseUpBtn', 'click', browseGoUp);
    on('browseHomeBtn', 'click', browseGoHome);
    on('newFolderInput', 'keydown', onNewFolderKey);
    on('newFolderCreateBtn', 'click', confirmNewFolder);
    on('newFolderCancelBtn', 'click', cancelNewFolder);
    on('newFolderToggleBtn', 'click', toggleNewFolder);
    on('sftpBrowserFooterCancelBtn', 'click', closeSftpBrowser);
    on('sftpBrowserSelectBtn', 'click', selectCurrentFolder);

    // Add-service picker modal
    on('addServiceModal', 'click', onAddServiceOverlayClick);
    on('addServiceModalCloseBtn', 'click', closeAddServicePicker);
    on('addServiceImmichBtn', 'click', () => { addServiceOfType('immich'); closeAddServicePicker(); });
    on('addServiceSftpBtn', 'click', () => { addServiceOfType('sftp'); closeAddServicePicker(); });
    on('addServiceNextcloudBtn', 'click', () => { addServiceOfType('nextcloud'); closeAddServicePicker(); });
    on('addServiceDropboxBtn', 'click', () => { addServiceOfType('dropbox'); closeAddServicePicker(); });
    on('addServiceLocalBtn', 'click', () => { addServiceOfType('local'); closeAddServicePicker(); });

    // Confirm modal (replaces native confirm())
    on('confirmModalOkBtn', 'click', () => resolveConfirmModal(true));
    on('confirmModalCancelBtn', 'click', () => resolveConfirmModal(false));
    on('confirmModal', 'click', (e) => { if (e.target.id === 'confirmModal') resolveConfirmModal(false); });
  }

  wireStaticEventHandlers();

  // ─── Init ────────────────────────────────────────────
  loadSettings();
  updateSummaryCard();
  loadUploadHistory();
  checkPendingResumeOnLaunch();
