'use strict';

// Encrypted settings store: bootstrap, first-run migration, credential
// encrypt/decrypt helpers, the SFTP resume-session blob, and upload history.
// See CLAUDE.md for the security invariants this file exists to preserve
// (encryption-at-rest for every credential field, no plaintext ever
// written even transiently).

const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');

// Raises the bar above plain-text storage for settings (API keys, SFTP/Nextcloud
// passwords, Dropbox tokens) — the key ships in the app itself so this is
// obfuscation against casual disk access, not protection against someone who
// can read the app's own source. See SECRET_ENC_PREFIX below for the actual
// protection layer.
const STORE_ENCRYPTION_KEY = 'reelup-v1-9f2a6c1e4b7d3a08';

// One-time migration for installs whose config.json predates encryption: a
// plain Store() can't read an encrypted file (and vice versa), so we sniff
// the raw file first and copy legacy plaintext data into the encrypted store
// rather than risk `conf` silently resetting it to defaults.
function createStore() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  let legacyData = null;
  try {
    legacyData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    // Missing file, or already encrypted (not valid JSON) — nothing to migrate.
  }

  try {
    const encrypted = new Store({ encryptionKey: STORE_ENCRYPTION_KEY });
    if (legacyData) {
      encrypted.store = legacyData;
    }
    return encrypted;
  } catch (e) {
    // config.json exists but can't be decrypted with the current key (e.g.
    // STORE_ENCRYPTION_KEY changed, or the file is corrupted) — `conf`
    // throws a raw JSON.parse SyntaxError in this case instead of failing
    // gracefully, which would otherwise crash the whole app on startup.
    // Preserve the unreadable file (rather than silently overwrite it) and
    // start fresh instead.
    try {
      if (fs.existsSync(configPath)) {
        const backupPath = path.join(app.getPath('userData'), `config.unreadable-${Date.now()}.json`);
        fs.renameSync(configPath, backupPath);
      }
    } catch (renameErr) {
      // Best effort — even if the rename fails, fall through and start
      // clean rather than crash the app over it.
    }
    return new Store({ encryptionKey: STORE_ENCRYPTION_KEY });
  }
}

const store = createStore();

const SERVICES_MIGRATION_KEY = 'servicesMigrationV1';
const DEFAULT_SFTP_BASE_PATH = '/Photos/RAW_Photos';

// ─── CREDENTIAL FIELD ENCRYPTION ───────────────────────────────────────────
// electron-store's own encryptionKey (above) only obfuscates config.json
// against casual reads — the key ships in the app itself. The actual secret
// fields (Immich API key, SFTP/Nextcloud passwords, Dropbox token) are
// additionally encrypted with the OS keychain (DPAPI on Windows, Keychain on
// macOS, libsecret on Linux) via safeStorage, so a copy of config.json alone
// can't be decrypted on another machine or by another OS user account.
//
// INVARIANT: every code path that writes `settings` to the store MUST run
// it through transformServiceSecrets(..., encryptSecret) /
// transformLegacyTopLevelSecrets(..., encryptSecret) first. There are
// exactly three such paths in this file (migrateServicesIfNeeded,
// getSettings's self-heal pass, saveSettings) — if you add a fourth, encrypt
// there too. encryptSecret() is idempotent (a no-op on an already-encrypted
// value), so it's always safe to call defensively.
const SECRET_ENC_PREFIX = 'safeStorage:v1:';
const SERVICE_SECRET_FIELDS = {
  immich: ['apiKey'],
  sftp: ['password'],
  nextcloud: ['password'],
  dropbox: ['accessToken']
};
const LEGACY_TOP_LEVEL_SECRET_FIELDS = ['apiKey', 'sftpPassword'];

function encryptSecret(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith(SECRET_ENC_PREFIX)) return value;
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return SECRET_ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch (e) {
    return value;
  }
}

function decryptSecret(value) {
  if (typeof value !== 'string' || !value.startsWith(SECRET_ENC_PREFIX)) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_ENC_PREFIX.length), 'base64'));
  } catch (e) {
    // Undecryptable (e.g. store copied to a different machine/OS user) — treat as cleared.
    return '';
  }
}

function transformServiceSecrets(services, transform) {
  if (!Array.isArray(services)) return services;
  return services.map((s) => {
    if (!s || typeof s !== 'object') return s;
    // Object.hasOwn guard: a corrupted/hand-edited config.json with e.g.
    // `"type": "constructor"` would otherwise resolve an inherited
    // Object.prototype value here instead of undefined, and crash the
    // `for (const f of fields)` below on the next line.
    const fields = Object.hasOwn(SERVICE_SECRET_FIELDS, s.type) ? SERVICE_SECRET_FIELDS[s.type] : undefined;
    if (!fields || !s.config || typeof s.config !== 'object') return s;
    const config = { ...s.config };
    for (const f of fields) {
      if (typeof config[f] === 'string') config[f] = transform(config[f]);
    }
    return { ...s, config };
  });
}

function transformLegacyTopLevelSecrets(settings, transform) {
  const out = { ...settings };
  for (const f of LEGACY_TOP_LEVEL_SECRET_FIELDS) {
    if (typeof out[f] === 'string') out[f] = transform(out[f]);
  }
  return out;
}

// ─── First-run services migration ──────────────────────────────────────────
function cloneServiceRecord(s) {
  if (!s || typeof s !== 'object') return s;
  return {
    id: s.id || crypto.randomUUID(),
    type: s.type,
    label: s.label || s.type,
    enabled: s.enabled !== false,
    config: s.config && typeof s.config === 'object' ? { ...s.config } : {},
    connectionVerified: !!s.connectionVerified,
    lastTestFailed: !!s.lastTestFailed,
    lastTestError: s.lastTestError ? String(s.lastTestError) : ''
  };
}

function migrateServicesIfNeeded() {
  if (store.get(SERVICES_MIGRATION_KEY)) return;

  const prev = store.get('settings');
  const settings = prev && typeof prev === 'object' ? { ...prev } : {};

  let services = Array.isArray(settings.services) ? settings.services.map(cloneServiceRecord) : [];
  if (services.length === 0) {
    if (settings.serverUrl && settings.apiKey) {
      services.push({
        id: crypto.randomUUID(),
        type: 'immich',
        label: 'Immich',
        enabled: true,
        config: { serverUrl: settings.serverUrl, apiKey: settings.apiKey },
        connectionVerified: false,
        lastTestFailed: false
      });
    }
    if (settings.sftpHost && settings.sftpUser) {
      services.push({
        id: crypto.randomUUID(),
        type: 'sftp',
        label: 'SFTP',
        enabled: true,
        config: {
          host: settings.sftpHost,
          port: settings.sftpPort || 22,
          user: settings.sftpUser,
          password: settings.sftpPassword || '',
          basePath: settings.sftpBasePath || DEFAULT_SFTP_BASE_PATH
        },
        connectionVerified: false,
        lastTestFailed: false
      });
    }
  }

  let activeServiceId = settings.activeServiceId || null;
  if (!activeServiceId || !services.some((s) => s && s.id === activeServiceId)) {
    if (services.length === 0) {
      activeServiceId = null;
    } else {
      const um = settings.uploadMode;
      if (um === 'sftp') {
        const sf = services.find((s) => s.type === 'sftp');
        activeServiceId = sf ? sf.id : services[0].id;
      } else {
        const im = services.find((s) => s.type === 'immich');
        activeServiceId = im ? im.id : services[0].id;
      }
    }
  }

  // Encrypt before this first write — services built above (from legacy
  // top-level fields) still hold a raw plaintext sftpPassword at this point.
  // Doing this here, rather than relying on getSettings()'s self-heal pass
  // to catch it on the next read, closes the window where a crash between
  // this store.set and that later pass could leave plaintext on disk.
  const encryptedServices = transformServiceSecrets(services, encryptSecret);

  store.set('settings', {
    ...settings,
    services: encryptedServices,
    activeServiceId
  });
  store.set(SERVICES_MIGRATION_KEY, true);
}

const DEFAULT_SETTINGS = {
  serverUrl: '',
  apiKey: '',
  sftpHost: '',
  sftpPort: 22,
  sftpUser: '',
  sftpPassword: '',
  sftpBasePath: DEFAULT_SFTP_BASE_PATH,
  concurrency: 4,
  deleteAfterUpload: false,
  uploadMode: 'immich',
  theme: 'dark',
  palette: 'midnight',
  gridZoomLevel: 3,
  onboardingComplete: false,
  services: [],
  activeServiceId: null
};

function getSettings() {
  migrateServicesIfNeeded();

  let base = store.get('settings');
  base = base && typeof base === 'object' ? base : {};

  // Idempotent upgrade: encrypts any plaintext secret left over from before
  // credential encryption existed, or from a hand-edited config.json.
  // encryptSecret() is a no-op for values already encrypted, so this is safe
  // to run on every load.
  const rewritten = {
    ...transformLegacyTopLevelSecrets(base, encryptSecret),
    services: transformServiceSecrets(base.services, encryptSecret)
  };
  if (JSON.stringify(rewritten) !== JSON.stringify(base)) {
    base = rewritten;
    store.set('settings', base);
  }

  /* Existing installs with services already set up should not see first-launch onboarding. */
  if (base.onboardingComplete !== true
      && Array.isArray(base.services)
      && base.services.length > 0) {
    base = { ...base, onboardingComplete: true };
    store.set('settings', base);
  }

  const merged = { ...DEFAULT_SETTINGS, ...base };
  return {
    ...transformLegacyTopLevelSecrets(merged, decryptSecret),
    services: transformServiceSecrets(merged.services, decryptSecret)
  };
}

function saveSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;

  const toStore = {
    ...transformLegacyTopLevelSecrets(settings, encryptSecret),
    services: transformServiceSecrets(settings.services, encryptSecret)
  };
  store.set('settings', toStore);
  return true;
}

// ─── SFTP resume-session blob ───────────────────────────────────────────────
// If the app is killed mid-SFTP-upload, this lets the next launch offer to
// resume where it left off. Kept in the same encrypted store as settings.

const SFTP_PENDING_KEY = 'sftpPendingUploadSession';

function serializePendingFile(f) {
  const m = f.mtime;
  const mtimeStr = m instanceof Date ? m.toISOString()
    : (typeof m === 'string' ? m : new Date(m || Date.now()).toISOString());
  return {
    path: String(f.path || ''),
    name: String(f.name || ''),
    size: Number(f.size) || 0,
    ext: String(f.ext || ''),
    mtime: mtimeStr
  };
}

function writeSftpPendingSession(payload) {
  const toStore = typeof payload.sftpPassword === 'string'
    ? { ...payload, sftpPassword: encryptSecret(payload.sftpPassword) }
    : payload;
  store.set(SFTP_PENDING_KEY, toStore);
}

function getSftpPendingSession() {
  const raw = store.get(SFTP_PENDING_KEY);
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.sftpPassword !== 'string') return raw;
  return { ...raw, sftpPassword: decryptSecret(raw.sftpPassword) };
}

function updateSftpPendingProcessed(processedCount) {
  const cur = store.get(SFTP_PENDING_KEY);
  if (cur && typeof cur === 'object') {
    writeSftpPendingSession({ ...cur, processedCount });
  }
}

function clearSftpPendingSession() {
  store.delete(SFTP_PENDING_KEY);
}

// ─── Upload history ──────────────────────────────────────────────────────────
// Persisted under a separate key so we never touch the `settings` blob.
// Newest first; capped to avoid unbounded growth.

const HISTORY_KEY = 'uploadHistory';
const HISTORY_MAX_ENTRIES = 100;
const HISTORY_MAX_FILES_PER_ENTRY = 5000;

function getUploadHistory() {
  const list = store.get(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

function saveUploadSession(session) {
  const current = store.get(HISTORY_KEY, []);
  const safe = Array.isArray(current) ? current : [];

  const entry = {
    id: session.id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: session.startedAt || new Date().toISOString(),
    finishedAt: session.finishedAt || new Date().toISOString(),
    mode: session.mode || 'immich',
    destination: session.destination || '',
    sourceFolder: session.sourceFolder || '',
    totalCount: session.totalCount || 0,
    totalBytes: session.totalBytes || 0,
    successCount: session.successCount || 0,
    failCount: session.failCount || 0,
    skipCount: session.skipCount || 0,
    deletedCount: session.deletedCount || 0,
    aborted: !!session.aborted,
    files: Array.isArray(session.files)
      ? session.files.slice(0, HISTORY_MAX_FILES_PER_ENTRY).map(f => ({
          name: String(f.name || ''),
          size: Number(f.size) || 0,
          status: f.status === 'duplicate' || f.status === 'failed' ? f.status : 'success',
          detail: f.detail ? String(f.detail).slice(0, 500) : '',
          error: f.error ? String(f.error).slice(0, 500) : ''
        }))
      : []
  };

  const next = [entry, ...safe].slice(0, HISTORY_MAX_ENTRIES);
  store.set(HISTORY_KEY, next);
  return entry;
}

function clearUploadHistory() {
  store.set(HISTORY_KEY, []);
}

module.exports = {
  DEFAULT_SFTP_BASE_PATH,
  getSettings,
  saveSettings,
  serializePendingFile,
  writeSftpPendingSession,
  getSftpPendingSession,
  updateSftpPendingProcessed,
  clearSftpPendingSession,
  getUploadHistory,
  saveUploadSession,
  clearUploadHistory
};
