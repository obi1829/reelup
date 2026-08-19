'use strict';

// Backend contract: test/createSession/uploadFile/closeSession — see
// src/backends/immich.js's header comment and CLAUDE.md for the full writeup.

const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { buildRemotePath } = require('../lib/remote-path');

function pickHttpModule(protocol) {
  return protocol === 'http:' ? http : https;
}

// A stalled/unresponsive Nextcloud server would otherwise hang an upload
// worker indefinitely — bound every WebDAV request to a generous timeout.
// Unlike node-fetch's `timeout` option (see immich.js), Node's own
// req.setTimeout() is a true idle timeout that resets on socket activity, so
// this doesn't risk killing a slow-but-healthy large-file PUT.
const DAV_REQUEST_TIMEOUT_MS = 30000;

function armRequestTimeout(req, reject) {
  req.setTimeout(DAV_REQUEST_TIMEOUT_MS, () => {
    req.destroy(new Error(`WebDAV request timed out after ${DAV_REQUEST_TIMEOUT_MS / 1000}s`));
  });
}

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

// Shared low-level request builder — every WebDAV call (PROPFIND/HEAD/PUT/MKCOL)
// wants the same hostname/port/timeout/error wiring and just collects the
// response into a Buffer; `body` may be a Buffer, a Readable stream, or
// omitted entirely. `allowSelfSigned` is per-service opt-in (off by default)
// for home-lab instances on a self-signed/internal-CA certificate.
function davRequest(urlString, method, headers, body, allowSelfSigned) {
  const u = new URL(urlString);
  const mod = pickHttpModule(u.protocol);
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: !allowSelfSigned
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    armRequestTimeout(req, reject);
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') {
      body.on('error', reject);
      body.pipe(req);
    } else if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

async function test(config) {
  const c = config || {};
  const serverUrl = String(c.serverUrl || '').replace(/\/$/, '');
  const user = String(c.username || '');
  const pass = String(c.password || '');
  if (!serverUrl || !user) {
    return { success: false, error: 'Server URL and username are required' };
  }
  const base = `${serverUrl}/remote.php/dav/files/${encodeURIComponent(user)}`;
  const auth = basicAuthHeader(user, pass);
  const res = await davRequest(base + '/', 'PROPFIND', {
    Authorization: auth,
    Depth: '0',
    'Content-Type': 'application/xml'
  }, Buffer.from(
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    'utf8'
  ), c.allowSelfSigned);
  if (res.statusCode >= 200 && res.statusCode < 300) return { success: true };
  if (res.statusCode === 401 || res.statusCode === 403) {
    return { success: false, error: `Authentication failed (HTTP ${res.statusCode})` };
  }
  return {
    success: false,
    error: `WebDAV check failed (HTTP ${res.statusCode})`
  };
}

function normalizeNextcloudUploadPath(p) {
  let s = String(p || '/Photos').trim();
  if (!s) s = '/Photos';
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s || '/Photos';
}

function nextcloudDavUserRoot(serverUrl, username) {
  const base = String(serverUrl || '').replace(/\/$/, '');
  return `${base}/remote.php/dav/files/${encodeURIComponent(username)}`;
}

async function davHeadRequest(urlString, authHeader, allowSelfSigned) {
  const { statusCode, headers } = await davRequest(urlString, 'HEAD', { Authorization: authHeader }, null, allowSelfSigned);
  return { statusCode, headers };
}

async function davPutStream(urlString, authHeader, filePath, contentLength, allowSelfSigned) {
  const stream = fs.createReadStream(filePath);
  const { statusCode, body } = await davRequest(urlString, 'PUT', {
    Authorization: authHeader,
    'Content-Type': 'application/octet-stream',
    'Content-Length': contentLength
  }, stream, allowSelfSigned);
  if (statusCode >= 200 && statusCode < 300) return;
  throw new Error(`WebDAV PUT failed: HTTP ${statusCode} ${body.toString().slice(0, 300)}`);
}

function createWebDavDirEnsurer(davUserRoot, authHeader, allowSelfSigned) {
  const createdDirs = new Set();
  const dirLocks = new Map();

  async function mkcol(urlString) {
    const { statusCode } = await davRequest(urlString, 'MKCOL', { Authorization: authHeader }, null, allowSelfSigned);
    return statusCode;
  }

  async function ensure(relativeDir) {
    if (!relativeDir || createdDirs.has(relativeDir)) return;
    if (dirLocks.has(relativeDir)) {
      await dirLocks.get(relativeDir);
      return;
    }
    const promise = (async () => {
      const segments = relativeDir.split('/').filter(Boolean);
      let cur = davUserRoot.replace(/\/$/, '');
      for (const seg of segments) {
        cur += '/' + encodeURIComponent(seg);
        const code = await mkcol(cur);
        if (code === 401 || code === 403) {
          throw new Error(`WebDAV MKCOL forbidden (HTTP ${code})`);
        }
        if (code >= 400 && ![405, 409].includes(code)) {
          throw new Error(`WebDAV MKCOL failed (HTTP ${code})`);
        }
      }
      createdDirs.add(relativeDir);
    })();
    dirLocks.set(relativeDir, promise);
    try {
      await promise;
    } finally {
      dirLocks.delete(relativeDir);
    }
  }
  return { ensure };
}

async function createSession(config) {
  const c = config || {};
  const serverUrl = String(c.serverUrl || '').replace(/\/$/, '');
  const user = String(c.username || '');
  const davRoot = nextcloudDavUserRoot(serverUrl, user);
  const auth = basicAuthHeader(user, c.password || '');
  return {
    cfg: c,
    dirEnsurer: createWebDavDirEnsurer(davRoot, auth, c.allowSelfSigned)
  };
}

async function uploadFile(session, file) {
  const cfg = session.cfg;
  const serverUrl = String(cfg.serverUrl || '').replace(/\/$/, '');
  const user = String(cfg.username || '');
  const pass = String(cfg.password || '');
  const uploadBase = normalizeNextcloudUploadPath(cfg.uploadPath);
  const trimmedBase = uploadBase.replace(/^\//, '');
  const relFile = buildRemotePath('/' + trimmedBase, file).replace(/^\//, '');
  const davRoot = nextcloudDavUserRoot(serverUrl, user);
  const auth = basicAuthHeader(user, pass);
  const targetUrl = `${davRoot}/${relFile.split('/').map(encodeURIComponent).join('/')}`;

  const headRes = await davHeadRequest(targetUrl, auth, cfg.allowSelfSigned);
  if (headRes.statusCode === 200) {
    const cl = parseInt(headRes.headers['content-length'], 10);
    if (!Number.isNaN(cl) && cl === file.size) {
      return { duplicate: true, remotePath: relFile };
    }
  }

  const dirRel = relFile.includes('/') ? relFile.slice(0, relFile.lastIndexOf('/')) : '';
  if (dirRel) await session.dirEnsurer.ensure(dirRel);

  const st = await fs.promises.stat(file.path);
  await davPutStream(targetUrl, auth, file.path, st.size, cfg.allowSelfSigned);
  return { duplicate: false, remotePath: relFile };
}

async function closeSession() { /* stateless HTTP — nothing to close */ }

module.exports = {
  test,
  createSession,
  uploadFile,
  closeSession
};
