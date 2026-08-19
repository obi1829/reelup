'use strict';

// Backend contract: test/createSession/uploadFile/closeSession — see
// src/backends/immich.js's header comment and CLAUDE.md for the full writeup.

const fs = require('fs');
const fetch = require('node-fetch');
const { buildRemotePath } = require('../lib/remote-path');

const DROPBOX_UPLOAD_LIMIT = 150 * 1024 * 1024;
const DROPBOX_SESSION_CHUNK = 8 * 1024 * 1024;
// node-fetch v2's `timeout` option is a single fixed-duration timer that
// never resets on data activity (see immich.js's comment for the full
// explanation) — a ceiling against a genuinely hung connection, not a stall
// detector. Keep generous so a large file over a slow connection can still
// finish.
const DROPBOX_METADATA_TIMEOUT_MS = 30000;
const DROPBOX_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

async function test(config) {
  const token = String((config && config.accessToken) || '').trim();
  if (!token) return { success: false, error: 'Access token is required' };
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: 'null',
    timeout: DROPBOX_METADATA_TIMEOUT_MS
  });
  if (res.ok) return { success: true };
  const text = await res.text().catch(() => '');
  return { success: false, error: `Dropbox API ${res.status}: ${text.slice(0, 200)}` };
}

function normalizeDropboxBasePath(rawPath) {
  let base = String(rawPath != null ? rawPath : '/Photos').trim();
  if (!base.startsWith('/')) base = '/' + base;
  base = base.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return base || '/Photos';
}

// Delegates the actual basePath/YYYY/YYYY-MM-DD/filename layout to the
// shared helper (also used by SFTP/Nextcloud) so the folder structure can't
// drift between destinations.
function buildDropboxStoragePath(cfg, file) {
  const base = normalizeDropboxBasePath(cfg.uploadPath);
  return buildRemotePath(base, file).replace(/\/+/g, '/');
}

async function dropboxSimpleUpload(token, dropboxPath, filePath) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: { '.tag': 'add' },
        autorename: false,
        mute: false
      })
    },
    body: fs.createReadStream(filePath),
    timeout: DROPBOX_UPLOAD_TIMEOUT_MS
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dropbox upload ${res.status}: ${text.slice(0, 400)}`);
  }
}

async function dropboxSessionUpload(token, dropboxPath, filePath, size) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let uploaded = 0;
    const chunkSize = DROPBOX_SESSION_CHUNK;
    let sessionId = null;

    while (uploaded < size) {
      const len = Math.min(chunkSize, size - uploaded);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, uploaded);
      const after = uploaded + len;

      if (uploaded === 0) {
        const res = await fetch('https://content.dropboxapi.com/2/upload_session/start', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ close: false })
          },
          body: buf,
          timeout: DROPBOX_UPLOAD_TIMEOUT_MS
        });
        const j = await res.json();
        if (!res.ok) {
          throw new Error(`Dropbox session start ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
        }
        sessionId = j.session_id;
        uploaded = after;
        continue;
      }

      if (after >= size) {
        const finishArg = {
          cursor: { session_id: sessionId, offset: uploaded },
          commit: {
            path: dropboxPath,
            mode: { '.tag': 'add' },
            autorename: false,
            mute: false
          }
        };
        const res = await fetch('https://content.dropboxapi.com/2/upload_session/finish', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify(finishArg)
          },
          body: buf,
          timeout: DROPBOX_UPLOAD_TIMEOUT_MS
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Dropbox session finish ${res.status}: ${text.slice(0, 400)}`);
        }
        uploaded = after;
        return;
      }

      const appendArg = { cursor: { session_id: sessionId, offset: uploaded } };
      const res = await fetch('https://content.dropboxapi.com/2/upload_session/append_v2', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify(appendArg)
        },
        body: buf,
        timeout: DROPBOX_UPLOAD_TIMEOUT_MS
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Dropbox session append ${res.status}: ${text.slice(0, 400)}`);
      }
      uploaded = after;
    }
  } finally {
    await fh.close();
  }
}

// Stateless per-request — the "session" is just the config, wrapped for a
// uniform shape across backends.
async function createSession(config) {
  return { cfg: config || {} };
}

async function uploadFile(session, file) {
  const cfg = session.cfg;
  const token = String(cfg.accessToken || '').trim();
  const dropboxPath = buildDropboxStoragePath(cfg, file);

  const metaRes = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: dropboxPath }),
    timeout: DROPBOX_METADATA_TIMEOUT_MS
  });
  if (metaRes.ok) {
    const meta = await metaRes.json();
    if (meta.size === file.size) {
      return { duplicate: true, remotePath: dropboxPath };
    }
  }

  const st = await fs.promises.stat(file.path);
  const size = st.size;
  if (size <= DROPBOX_UPLOAD_LIMIT) {
    await dropboxSimpleUpload(token, dropboxPath, file.path);
  } else {
    await dropboxSessionUpload(token, dropboxPath, file.path, size);
  }
  return { duplicate: false, remotePath: dropboxPath };
}

async function closeSession() { /* stateless — nothing to close */ }

module.exports = { test, createSession, uploadFile, closeSession };
