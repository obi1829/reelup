'use strict';

// ─── Backend contract ───────────────────────────────────────────────────────
// Every module in src/backends/*.js implements the same four functions so
// src/upload-orchestrator.js can drive any destination identically:
//   test(config)                    -> { success, error? }
//   createSession(config, hooks?)   -> session (opaque; passed back into uploadFile/closeSession)
//   uploadFile(session, file)       -> { duplicate, remotePath }
//   closeSession(session)           -> void (best-effort cleanup, e.g. closing a connection)
// `hooks.onInfo(message)` is optional and lets a backend surface a one-off
// status line (e.g. "Connected to host") to the activity log during
// createSession. Backends that are fully stateless per-request (Immich,
// Dropbox) just wrap `config` in `{ cfg: config }` as their "session".
// See CLAUDE.md for the full contract writeup and how to add a 6th backend.

const fs = require('fs');
const https = require('https');
const FormData = require('form-data');
const fetch = require('node-fetch');

// node-fetch v2's `timeout` option is a single fixed-duration timer started
// at request time and never reset on data activity (confirmed by reading
// node_modules/node-fetch/lib/index.js) — it's a ceiling against a
// genuinely hung connection, not a stall detector. A large RAW/video file
// over a slow home-upload or public-internet link can legitimately take
// several minutes; keep this generous so healthy-but-slow transfers don't
// get killed mid-upload.
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const TEST_TIMEOUT_MS = 8000;

// Only built when a service opts in via `allowSelfSigned` — off by default.
// Scoped to that one fetch call, never touches Node's global TLS behavior.
function buildAgent(serverUrl, allowSelfSigned) {
  if (!allowSelfSigned || !String(serverUrl).startsWith('https:')) return undefined;
  return new https.Agent({ rejectUnauthorized: false });
}

async function test(config) {
  const serverUrl = String((config && config.serverUrl) || '');
  const apiKey = String((config && config.apiKey) || '');
  try {
    const url = `${serverUrl.replace(/\/$/, '')}/api/auth/validateToken`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout: TEST_TIMEOUT_MS,
      agent: buildAgent(serverUrl, config && config.allowSelfSigned)
    });
    if (res.ok) return { success: true };
    return { success: false, error: `Server returned ${res.status}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Stateless per-request — the "session" is just the config, wrapped for a
// uniform shape across backends.
async function createSession(config) {
  return { cfg: config || {} };
}

async function uploadFile(session, file) {
  const { serverUrl, apiKey, allowSelfSigned } = session.cfg;
  const url = `${String(serverUrl).replace(/\/$/, '')}/api/assets`;
  const stat = await fs.promises.stat(file.path);
  const mtime = stat.mtime.toISOString();

  const form = new FormData();
  form.append('deviceAssetId', `${file.name}-${stat.size}-${stat.mtimeMs}`);
  form.append('deviceId', 'reelup-desktop');
  form.append('fileCreatedAt', mtime);
  form.append('fileModifiedAt', mtime);
  form.append('isFavorite', 'false');
  form.append('assetData', fs.createReadStream(file.path), {
    filename: file.name,
    contentType: 'application/octet-stream'
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, ...form.getHeaders() },
    body: form,
    timeout: UPLOAD_TIMEOUT_MS,
    agent: buildAgent(serverUrl, allowSelfSigned)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  // Immich manages its own library layout server-side, so there's no
  // meaningful "remote path" to report back (unlike SFTP/Nextcloud/Dropbox/
  // local, which report the destination path they wrote to).
  const data = await res.json();
  return { duplicate: data.status === 'duplicate' };
}

async function closeSession() { /* stateless — nothing to close */ }

module.exports = { test, createSession, uploadFile, closeSession };
