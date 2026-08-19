'use strict';

// RAW thumbnail extraction: most camera RAW files (NEF, CR2, ARW, etc.)
// embed one or more JPEG previews inside the file. We scan the byte stream
// for the largest JPEG (SOI…EOI), hand it to sharp for a fast resize, write
// the result to a temp JPEG, and return its path (shown in the renderer via
// the `localfile://` protocol). If nothing usable is found we let sharp
// decode the file directly (works for TIFF/DNG).
// HEIC/HEIF: sharp decodes via libvips; skip embedded-JPEG scan (can pick
// wrong previews and wastes I/O).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// Disable sharp's internal cache so we don't pin big buffers between calls.
try { sharp.cache(false); } catch (e) { /* non-fatal, keep default cache behavior */ }

const RAW_THUMB_MAX_DIM = 360;
const RAW_THUMB_JPEG_QUALITY = 78;
const RAW_THUMB_LARGE_MAX_DIM = 1920;
const RAW_THUMB_LARGE_JPEG_QUALITY = 88;
// A RAW file can be 30–80 MB. Avoid scanning anything absurd.
const RAW_THUMB_MAX_READ_BYTES = 80 * 1024 * 1024;
// Most RAW files (ARW/NEF/CR2/…) embed a medium (~1600px) JPEG preview near
// the front of the file. For the 360px grid thumbnail we only need *a* preview
// ≥ 360px, so scan just this prefix first instead of reading the whole 25–60MB
// RAW off (often slow SD-card) storage. Reading whole files was the dominant
// cost when loading a card full of RAW: ~40MB/file × hundreds of files.
const RAW_THUMB_PREFIX_SCAN_BYTES = 4 * 1024 * 1024;
// A prefix hit smaller than this is probably just the tiny EXIF thumbnail
// (~160px), not the medium preview — fall through to a full read in that case.
const RAW_THUMB_MIN_PREVIEW_BYTES = 48 * 1024;
// Grid thumbnails: try the cheap prefix first, only read the whole file if the
// prefix has no usable preview. Large/lightbox previews: single full read so we
// still pick the biggest embedded preview available.
const RAW_THUMB_GRID_SCAN_STAGES = [RAW_THUMB_PREFIX_SCAN_BYTES, RAW_THUMB_MAX_READ_BYTES];
const RAW_THUMB_FULL_SCAN_STAGES = [RAW_THUMB_MAX_READ_BYTES];

// Extracted previews go in their own temp subfolder (not os.tmpdir() root)
// so we can wipe exactly this app's leftovers without touching anything
// else in the shared system temp folder — see initTempDir/cleanupTempDir.
const THUMB_TEMP_DIR = path.join(os.tmpdir(), 'reelup-thumbs');

function wipeTempDir() {
  try { fs.rmSync(THUMB_TEMP_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

// Call once at app startup: clears any thumbnails left over from a previous
// crashed session (a normal quit already cleans up via cleanupTempDir, so
// this is only a backstop) and (re)creates the folder.
function initTempDir() {
  wipeTempDir();
  try { fs.mkdirSync(THUMB_TEMP_DIR, { recursive: true }); } catch (e) { /* best effort */ }
}

// Call on app quit. Without this, enabling "delete after upload" would still
// leave a viewable JPEG preview of every deleted RAW/video cached here
// indefinitely — undermining that feature's implied privacy guarantee.
function cleanupTempDir() {
  wipeTempDir();
}

function findLargestEmbeddedJpeg(buffer) {
  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  const EOI = Buffer.from([0xff, 0xd9]);

  let best = null;
  let bestSize = 0;
  let pos = 0;
  while (pos < buffer.length) {
    const soi = buffer.indexOf(SOI, pos);
    if (soi === -1) break;
    const eoi = buffer.indexOf(EOI, soi + 3);
    if (eoi === -1) break;
    const len = eoi + 2 - soi;
    // Anything under ~2 KB is almost certainly just the tiny exif thumbnail.
    if (len > bestSize && len > 2048) {
      bestSize = len;
      best = buffer.slice(soi, eoi + 2);
    }
    pos = eoi + 2;
  }
  return best;
}

async function resizeRawThumbToJpegBuffer(input, maxDim, jpegQuality) {
  return sharp(input, { failOn: 'none' })
    .rotate()
    .resize(maxDim, maxDim, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: jpegQuality, mozjpeg: false })
    .toBuffer();
}

// Scan the file in increasing prefixes (scanStages), stopping as soon as a
// usable embedded JPEG is found. Returns the JPEG Buffer, or null if none.
// Re-reading from offset 0 each stage wastes at most one extra prefix read in
// the rare fallback case, and avoids an SOI/EOI marker straddling a boundary.
async function findEmbeddedJpegProgressive(fd, fileSize, scanStages) {
  let scannedWholeFile = false;
  for (let i = 0; i < scanStages.length && !scannedWholeFile; i++) {
    const readLen = Math.min(fileSize, scanStages[i]);
    scannedWholeFile = readLen >= fileSize;
    const isFinalStage = i === scanStages.length - 1 || scannedWholeFile;

    // allocUnsafe avoids zero-filling a multi-MB buffer we immediately overwrite.
    const buffer = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await fd.read(buffer, 0, readLen, 0);
    const scanBuf = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);

    const found = findLargestEmbeddedJpeg(scanBuf);
    // On a non-final prefix, reject a too-small hit (likely just the tiny EXIF
    // thumbnail) so we fall through to a larger read; on the final stage take
    // whatever we found.
    if (found && (isFinalStage || found.length >= RAW_THUMB_MIN_PREVIEW_BYTES)) {
      return found;
    }
  }
  return null;
}

async function extractRawThumbnailJpegBuffer(filePath, maxDim, jpegQuality, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return { success: false, error: 'Invalid path' };
  }
  const scanStages = opts.scanStages || RAW_THUMB_FULL_SCAN_STAGES;

  const ext = path.extname(filePath).toLowerCase();
  const isHeicOrHeif = ext === '.heic' || ext === '.heif';

  try {
    const stat = await fs.promises.stat(filePath);

    if (isHeicOrHeif) {
      const jpeg = await resizeRawThumbToJpegBuffer(filePath, maxDim, jpegQuality);
      return { success: true, jpeg, mtimeMs: stat.mtimeMs };
    }

    const fd = await fs.promises.open(filePath, 'r');
    let embedded;
    try {
      embedded = await findEmbeddedJpegProgressive(fd, stat.size, scanStages);
    } finally {
      await fd.close();
    }

    if (embedded) {
      try {
        const jpeg = await resizeRawThumbToJpegBuffer(
          embedded,
          maxDim,
          jpegQuality
        );
        return { success: true, jpeg, mtimeMs: stat.mtimeMs };
      } catch {
        /* fall through — embedded JPEG malformed */
      }
    }

    const jpeg = await resizeRawThumbToJpegBuffer(
      filePath,
      maxDim,
      jpegQuality
    );
    return { success: true, jpeg, mtimeMs: stat.mtimeMs };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Extract the thumbnail, write it to a temp JPEG, and return its path so the
// renderer can display it via the `localfile://` protocol. Preferred over
// returning a base64 data URL: no 33% base64 inflation, no large string
// crossing the IPC boundary per thumbnail, and the renderer holds a short
// path instead of a multi-KB data URL in memory for every tile. The temp file
// name is keyed by path+mtime so re-requests overwrite the same file (and the
// content is deterministic, so the protocol layer can cache the decode safely).
async function extractRawThumbnailToFile(filePath, maxDim, jpegQuality, tag, opts) {
  try {
    const r = await extractRawThumbnailJpegBuffer(filePath, maxDim, jpegQuality, opts);
    if (!r.success) return r;

    const h = crypto.createHash('sha1')
      .update(String(filePath))
      .update(String(r.mtimeMs))
      .digest('hex');

    const outPath = path.join(THUMB_TEMP_DIR, `${tag}-${h}.jpg`);
    await fs.promises.writeFile(outPath, r.jpeg);
    return { success: true, filePath: outPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Grid thumbnails: cheap prefix scan first (see RAW_THUMB_GRID_SCAN_STAGES).
function getRawThumbnail(filePath) {
  return extractRawThumbnailToFile(
    filePath, RAW_THUMB_MAX_DIM, RAW_THUMB_JPEG_QUALITY, 'sm',
    { scanStages: RAW_THUMB_GRID_SCAN_STAGES }
  );
}

function getRawThumbnailLarge(filePath) {
  return extractRawThumbnailToFile(
    filePath, RAW_THUMB_LARGE_MAX_DIM, RAW_THUMB_LARGE_JPEG_QUALITY, 'lg'
  );
}

// Pixel dimensions via sharp.metadata() — best-effort for images/RAW previews.
async function getMediaMetadata(filePath) {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid path' };
    }
    const meta = await sharp(filePath, { failOn: 'none' }).metadata();
    const w = meta.width;
    const h = meta.height;
    return {
      success: true,
      width: typeof w === 'number' ? w : null,
      height: typeof h === 'number' ? h : null
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  initTempDir,
  cleanupTempDir,
  getRawThumbnail,
  getRawThumbnailLarge,
  getMediaMetadata
};
