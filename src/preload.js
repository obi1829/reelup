const { contextBridge, ipcRenderer } = require('electron');

const VALID_EVENT_CHANNELS = ['upload-progress', 'upload-file-done', 'upload-complete', 'scan-progress'];

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('minimize-window'),
  maximize: () => ipcRenderer.send('maximize-window'),
  close: () => ipcRenderer.send('close-window'),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts),
  scanFolder: (path) => ipcRenderer.invoke('scan-folder', path),

  testService: (service) => ipcRenderer.invoke('test-service', service),

  sftpBrowseOpen: (config) => ipcRenderer.invoke('sftp-browse-open', config),
  sftpBrowseList: (req) => ipcRenderer.invoke('sftp-browse-list', req),
  sftpBrowseMkdir: (req) => ipcRenderer.invoke('sftp-browse-mkdir', req),
  sftpBrowseClose: (req) => ipcRenderer.invoke('sftp-browse-close', req),
  sftpForgetHostKey: (req) => ipcRenderer.invoke('sftp-forget-host-key', req),

  startUpload: (config) => ipcRenderer.invoke('start-upload', config),
  abortUpload: () => ipcRenderer.send('abort-upload'),

  getSftpPendingSession: () => ipcRenderer.invoke('get-sftp-pending-session'),
  dismissSftpPendingSession: () => ipcRenderer.invoke('dismiss-sftp-pending-session'),

  getRawThumbnail: (filePath) => ipcRenderer.invoke('get-raw-thumbnail', filePath),
  getRawThumbnailLarge: (filePath) =>
    ipcRenderer.invoke('get-raw-thumbnail-large', filePath),

  getMediaMetadata: (filePath) => ipcRenderer.invoke('get-media-metadata', filePath),

  getUploadHistory: () => ipcRenderer.invoke('get-upload-history'),
  saveUploadSession: (session) => ipcRenderer.invoke('save-upload-session', session),
  clearUploadHistory: () => ipcRenderer.invoke('clear-upload-history'),

  on: (channel, callback) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  off: (channel) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  }
});
