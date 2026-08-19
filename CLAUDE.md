# CLAUDE.md

Architecture and contract notes for future developers and LLM coding assistants
working in this repo. `README.md` is the end-user quickstart; this file is the
"how is it built and what must I not break" reference.

## What this is
ReelUp — an Electron desktop app that uploads photos/RAW/video from a
local folder (SD card, DCIM, etc.) to one of several configurable
destinations: Immich, SFTP, Nextcloud (WebDAV), Dropbox, or a local folder.

## Architecture

### Main process (`src/`)
- **`main.js`** — bootstrap only: creates the window, registers most IPC
  handlers (settings, upload, thumbnails, history), wires the `localfile://`
  protocol used to show local images/thumbnails, and delegates all real
  logic to the modules below. `backends/sftp.js` self-registers its own
  `sftp-browse-*` handlers (the remote-folder browser) as a side effect of
  being required — those aren't in `main.js`.
- **`preload.js`** — the only bridge between renderer and main process
  (`contextBridge` + a whitelisted `window.api` surface). `contextIsolation`/
  `sandbox` are on, `nodeIntegration` is off — the renderer never gets raw
  Node/Electron APIs.
- **`lib/store.js`** — the encrypted settings store: settings get/save,
  first-run services migration, credential encryption/decryption, the SFTP
  resume-session blob, and upload history.
- **`lib/thumbnails.js`** — RAW/HEIC thumbnail extraction (embedded-JPEG
  scanning + sharp resize) and its temp-file lifecycle.
- **`lib/remote-path.js`** — the shared `basePath/YYYY/YYYY-MM-DD/filename`
  layout used by SFTP, Nextcloud, Dropbox, and Local.
- **`upload-orchestrator.js`** — drives one upload run: the concurrency
  pool, retry-with-backoff, progress/taskbar events, SFTP-resume
  persistence. Never branches on backend type directly — it looks up
  whichever `backends/*.js` module matches `service.type` in its `BACKENDS`
  map and calls it through the contract below.
- **`backends/*.js`** — one module per upload destination.

### Renderer (`src/renderer/`, `src/index.html`)
Seven plain `<script>` tags sharing one global scope — no bundler, no ES
modules. Load order from `index.html` matters: `state-and-chrome.js`,
`services-settings.js`, `photo-grid.js`, `upload.js`, `history-and-utils.js`,
`sftp-browser.js`, `init.js` (loads last — every other file's functions are
already defined by the time it runs, and the DOM is already parsed). Files
freely call each other's top-level functions by name; there's no
`export`/`import`, so `no-undef` is intentionally off for these files in
`eslint.config.js` — cross-file typos are only caught by actually running the
app.
- **`services-settings.js`** — despite the name, also owns folder selection
  and scan orchestration (`pickFolder`/`loadFolder`), not just service
  configuration — a leftover of the main.js split, not worth relocating.
- **`state-and-chrome.js`** — app-chrome state (theme/palette, drawers,
  upload services list) plus shared UI primitives like the confirm modal.
  Each *view* owns its own state in its own file rather than everything
  living here — see that file's top comment for the current map (grid/
  thumbnail state in `photo-grid.js`, upload-progress state in `upload.js`,
  etc).
- **`init.js`** — `wireStaticEventHandlers()` attaches every static button's
  click handler via `addEventListener` (see Security invariant #3 below for
  why). The photo lightbox and details-pane close/prev/next buttons are
  wired *separately*, inside `photo-grid.js`, at grid-setup time — look
  there first if a grid/lightbox button seems unwired.

## Backend contract
Every module in `src/backends/*.js` exports exactly these four functions:

```js
async function test(config)                   // -> { success, error? }
async function createSession(config, hooks?)  // -> session (opaque, backend-defined shape)
async function uploadFile(session, file)      // -> { duplicate, remotePath? }
async function closeSession(session)          // -> void, best-effort cleanup
```

`createSession` is where a backend does whatever one-time setup an upload run
needs — SFTP opens and host-key-verifies a connection it reuses for every
file in the run; Nextcloud and Local both build a per-run
directory-creation cache (`dirEnsurer`) alongside their config (Nextcloud
also builds its auth header there); Immich and Dropbox are fully stateless
per-file and just wrap `config` as their "session". `hooks.onInfo(message)` is optional — call it once from
`createSession` to surface a status line to the activity log (SFTP uses this
for "Connected to {host}").

**To add a 6th destination** (e.g. the "Coming soon" Google Photos/OneDrive
slots already in the add-service picker):
1. Write `backends/<name>.js` implementing the four functions above.
2. Add it to the `BACKENDS` map in `upload-orchestrator.js` — that's the only
   place upload dispatch and `main.js`'s `test-service` handler both read
   from, so this one line covers both.
3. Wire the UI: `services-settings.js`'s `defaultServiceConfig`/
   `serviceTypeLabel`/`defaultServiceLabel`/`serviceIconSvg`/
   `buildServiceConfigFields` switch statements, plus a new
   `addService<Name>Btn` button in `index.html`'s add-service modal and its
   `wireStaticEventHandlers()` entry in `init.js`.

## Security invariants — do not break these

1. **Every credential field is encrypted at rest.** `lib/store.js`'s
   `encryptSecret`/`decryptSecret` (via Electron's `safeStorage`,
   OS-keychain-backed) wrap every write/read of `SERVICE_SECRET_FIELDS`
   (Immich API key, SFTP/Nextcloud password, Dropbox token) and the legacy
   top-level fields. **Any new code path that writes `settings` to the store
   must run it through `transformServiceSecrets(..., encryptSecret)` first**
   — see the comment above `SECRET_ENC_PREFIX` in that file for the current
   list of paths that do this; keep it in sync if you add one.
2. **SFTP host keys are pinned, trust-on-first-use.** `backends/sftp.js`'s
   `withHostVerification`/`connectWithVerification` must wrap every
   `sftp.connect()` call (there are three: upload, service test, and the
   remote-folder browser) — this is what makes a MITM on the SFTP connection
   detectable instead of silent.
3. **CSP has no `unsafe-inline` in `script-src`.** Every interactive element
   in `index.html` is wired via `addEventListener` (see `init.js`), not
   `onclick="..."` attributes. Nothing enforces this at build time — adding
   a new `onclick=` attribute will still *work*, it just silently reopens the
   gap `unsafe-inline` removal closed. New buttons should get an `id` and a
   `wireStaticEventHandlers()` entry instead.
4. **`contextIsolation`/`sandbox` stay on, `nodeIntegration` stays off**
   (`main.js`'s `createWindow`). `preload.js` must keep exposing a minimal,
   explicit `window.api` surface — never `ipcRenderer` itself.

## Known gaps (deliberately not fixed)
- **No automated test suite.** All verification in this repo is manual
  click-through plus `npm run lint` / `node --check`. Treat any refactor of
  `upload-orchestrator.js` or the backend contract as needing a full manual
  pass through every destination type afterward.
- **Auto-update isn't wired up** — blocked on having a public GitHub repo to
  point `electron-updater` releases at.
- **`localfile://` and the thumbnail/scan IPC handlers trust whatever path
  the renderer sends**, with no containment to the originally-selected
  folder. Accepted as-is: the app's whole purpose is "browse any local
  folder," and the CSP already prevents the renderer from becoming
  attacker-scriptable in the first place (no exploitable `innerHTML` sink —
  see `no-unsanitized/property` in `eslint.config.js`).
