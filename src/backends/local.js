'use strict';

// Backend contract: test/createSession/uploadFile/closeSession — see
// src/backends/immich.js's header comment and CLAUDE.md for the full writeup.

const fs = require('fs');
const path = require('path');
const { buildRemotePath } = require('../lib/remote-path');

// Verify the destination folder exists and is writable.
async function test(config) {
  const c = config || {};
  const dest = String(c.destPath || '').trim();
  if (!dest) return { success: false, error: 'Destination folder is required' };
  try {
    const stat = await fs.promises.stat(dest);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Destination is not a folder' };
    }
    await fs.promises.access(dest, fs.constants.W_OK);
    return { success: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { success: false, error: 'Folder does not exist' };
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return { success: false, error: 'Folder is not writable' };
    }
    return { success: false, error: e.message };
  }
}

// Per-upload-session directory creator: mkdir -p once per unique date folder,
// mirroring the SFTP/WebDAV ensurers so concurrent copies into the same folder
// don't race.
function createLocalDirEnsurer() {
  const created = new Set();
  const locks = new Map();

  async function ensure(dir) {
    if (created.has(dir)) return;
    if (locks.has(dir)) {
      await locks.get(dir);
      return;
    }
    const promise = fs.promises.mkdir(dir, { recursive: true });
    locks.set(dir, promise);
    try {
      await promise;
      created.add(dir);
    } finally {
      locks.delete(dir);
    }
  }

  return { ensure };
}

async function createSession(config) {
  return { cfg: config || {}, dirEnsurer: createLocalDirEnsurer() };
}

async function uploadFile(session, file) {
  const base = String(session.cfg.destPath || '').trim().replace(/[\\/]+$/, '');
  if (!base) throw new Error('Destination folder is not set');

  // Reuse the shared YYYY/YYYY-MM-DD/name layout (forward slashes), then map it
  // onto the OS path separator for the local filesystem.
  const rel = buildRemotePath('', file).replace(/^\/+/, '');
  const destPath = path.join(base, ...rel.split('/'));
  const destDir = path.dirname(destPath);

  // Duplicate detection: same destination path + same size already present.
  try {
    const stat = await fs.promises.stat(destPath);
    if (stat.size === file.size) {
      return { duplicate: true, remotePath: destPath };
    }
  } catch (e) {
    // Not there yet — proceed with the copy.
  }

  await session.dirEnsurer.ensure(destDir);
  await fs.promises.copyFile(file.path, destPath);
  return { duplicate: false, remotePath: destPath };
}

async function closeSession() { /* nothing to close — plain fs.copyFile calls */ }

module.exports = { test, createSession, uploadFile, closeSession };
