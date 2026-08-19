'use strict';

// Backend contract: test/createSession/uploadFile/closeSession — see
// src/backends/immich.js's header comment and CLAUDE.md for the full writeup.

const { ipcMain } = require('electron');
const SftpClient = require('ssh2-sftp-client');
const Store = require('electron-store');
const { buildRemotePath } = require('../lib/remote-path');

// ─── HOST KEY VERIFICATION (trust-on-first-use) ────────────────────────────
// ssh2 accepts any host key unless a hostVerifier is supplied, which makes
// every connection MITM-able. We pin the key hash the first time we connect
// to a given host:port and reject silent changes afterward — the same model
// SSH clients use for known_hosts. Kept in its own store file (not the main
// encrypted settings store) since a host key hash isn't a secret.
const knownHostsStore = new Store({ name: 'sftp-known-hosts' });

function hostId(host, port) {
  return `${host}:${port}`;
}

// Wraps a base sftp.connect() config with a hostVerifier. Returns the config
// to pass to sftp.connect() plus a wasHostKeyMismatch() check to call from
// the catch block so callers can surface a clear MITM-suspicion message
// instead of ssh2's generic "Host verification failed".
function withHostVerification(connectOpts) {
  const id = hostId(connectOpts.host, connectOpts.port);
  let mismatch = false;
  const hostVerifier = (keyHash) => {
    const stored = knownHostsStore.get(id);
    if (!stored) {
      knownHostsStore.set(id, keyHash);
      return true;
    }
    if (stored !== keyHash) {
      mismatch = true;
      return false;
    }
    return true;
  };
  return {
    connectOpts: { ...connectOpts, hostHash: 'sha256', hostVerifier },
    wasHostKeyMismatch: () => mismatch
  };
}

function hostKeyMismatchMessage(host, port) {
  return `SFTP host key for ${host}:${port} does not match the key trusted on first connection — refusing to connect, this could mean the server was reinstalled or your connection is being intercepted. If you trust this change, delete the "sftp-known-hosts.json" file in the app's settings folder to re-trust it.`;
}

// Drops a previously-trusted host key fingerprint so the next connection is
// re-trusted (TOFU). Exposed for a future "forget host" UI action.
function forgetSftpHostKey(host, port) {
  knownHostsStore.delete(hostId(host, port));
}

async function connectWithVerification({ host, port, username, password }) {
  const sftp = new SftpClient();
  const portNum = parseInt(port, 10) || 22;
  const { connectOpts, wasHostKeyMismatch } = withHostVerification({
    host, port: portNum, username, password, readyTimeout: 8000
  });
  try {
    await sftp.connect(connectOpts);
    return sftp;
  } catch (e) {
    const message = wasHostKeyMismatch() ? hostKeyMismatchMessage(host, portNum) : e.message;
    throw new Error(message, { cause: e });
  }
}

async function test(config) {
  const c = config || {};
  try {
    const sftp = await connectWithVerification({
      host: c.host, port: c.port, username: c.user, password: c.password
    });
    await sftp.end();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Per-upload-session SFTP directory creation: avoids concurrent mkdir races on the
 * same date folder while skipping redundant mkdir once a path is known good.
 */
function createSftpDirEnsurer(sftp) {
  const createdDirs = new Set();
  const dirLocks = new Map();

  async function ensure(remoteDir) {
    if (createdDirs.has(remoteDir)) return;

    if (dirLocks.has(remoteDir)) {
      await dirLocks.get(remoteDir);
    } else {
      const mkdirPromise = sftp.mkdir(remoteDir, true).catch(() => {});
      dirLocks.set(remoteDir, mkdirPromise);
      await mkdirPromise;
    }
    createdDirs.add(remoteDir);
    // Once a dir is confirmed, `createdDirs` short-circuits future calls —
    // the lock entry is dead weight from here on.
    dirLocks.delete(remoteDir);
  }

  return { ensure };
}

// Connects once per upload session (SFTP is the one backend that needs a
// persistent connection rather than a per-request call) and hands back
// everything uploadFile()/closeSession() need.
async function createSession(config, hooks = {}) {
  const c = config || {};
  const sftp = await connectWithVerification({
    host: c.host, port: c.port, username: c.user, password: c.password
  });
  if (hooks.onInfo) hooks.onInfo(`Connected to ${c.host}`);
  return { sftp, dirEnsurer: createSftpDirEnsurer(sftp), basePath: c.basePath };
}

async function uploadFile(session, file) {
  const { sftp, basePath, dirEnsurer } = session;
  const remotePath = buildRemotePath(basePath, file);
  const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));

  // Duplicate detection: same filename + same size
  try {
    const stat = await sftp.stat(remotePath);
    if (stat.size === file.size) {
      return { duplicate: true, remotePath };
    }
  } catch (e) {
    // File doesn't exist — proceed with upload
  }

  await dirEnsurer.ensure(remoteDir);
  await sftp.put(file.path, remotePath);
  return { duplicate: false, remotePath };
}

async function closeSession(session) {
  if (session && session.sftp) {
    try { await session.sftp.end(); } catch (e) { /* upload run is already finished either way */ }
  }
}

// ─── SFTP REMOTE FOLDER BROWSING ─────────────────────────────────────────────
// A short-lived SFTP session, identified by a sessionId, that the renderer
// keeps open while the "Browse remote folder" modal is in use. Distinct from
// the upload-session connect above: this is a standalone feature (its own
// IPC channels), not part of the backend test/upload contract.
const sftpBrowseSessions = new Map();

function normalizeRemotePath(p) {
  if (!p || p === '') return '/';
  let out = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!out.startsWith('/')) out = '/' + out;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

ipcMain.handle('sftp-browse-open', async (event, { host, port, username, password }) => {
  let sftp;
  try {
    sftp = await connectWithVerification({ host, port, username, password });

    let home = '/';
    try {
      const cwd = await sftp.cwd();
      if (cwd) home = normalizeRemotePath(cwd);
    } catch (e) { /* fall back to '/' as home */ }

    const sessionId = `sftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sftpBrowseSessions.set(sessionId, sftp);
    return { success: true, sessionId, home };
  } catch (e) {
    if (sftp) { try { await sftp.end(); } catch (_) { /* connection never fully opened */ } }
    return { success: false, error: e.message };
  }
});

ipcMain.handle('sftp-browse-list', async (event, { sessionId, path: dirPath }) => {
  const sftp = sftpBrowseSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'Browse session not active. Reopen the picker.' };
  const target = normalizeRemotePath(dirPath || '/');
  try {
    const list = await sftp.list(target);
    const entries = list
      .filter(e => e.type === 'd' && e.name !== '.' && e.name !== '..')
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return { success: true, path: target, entries };
  } catch (e) {
    return { success: false, error: e.message, path: target };
  }
});

ipcMain.handle('sftp-browse-mkdir', async (event, { sessionId, path: dirPath }) => {
  const sftp = sftpBrowseSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'Browse session not active.' };
  try {
    await sftp.mkdir(normalizeRemotePath(dirPath), true);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('sftp-browse-close', async (event, { sessionId }) => {
  const sftp = sftpBrowseSessions.get(sessionId);
  if (sftp) {
    try { await sftp.end(); } catch (e) { /* session is being discarded either way */ }
    sftpBrowseSessions.delete(sessionId);
  }
  return { success: true };
});

// User-facing recovery action for the host-key-mismatch error message from
// hostKeyMismatchMessage() above — previously the only way to clear a
// mismatched fingerprint was manually deleting sftp-known-hosts.json.
ipcMain.handle('sftp-forget-host-key', (event, { host, port }) => {
  forgetSftpHostKey(host, parseInt(port, 10) || 22);
  return { success: true };
});

module.exports = {
  test,
  createSession,
  uploadFile,
  closeSession,
  forgetSftpHostKey
};
