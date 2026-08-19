# ReelUp

<!-- Add a real screenshot before publishing, then uncomment:
![ReelUp screenshot](docs/screenshot.png)
-->

A desktop app for uploading photos and RAW files from a folder (SD card, DCIM, etc.)
to Immich, SFTP, Nextcloud (WebDAV), Dropbox, or a local folder.

> **Platform:** Packaged builds are Windows only (portable `.exe` / NSIS installer).
> Running from source (`npm start`) is plain Electron and should work on macOS/Linux
> too, but only Windows is tested and has build scripts.

## Features

- Upload to Immich, SFTP, Nextcloud, Dropbox, or a local folder — configure multiple
  destinations and switch between them from the Upload tab
- Upload any folder (SD card, DCIM, etc.)
- Supports RAW formats: NEF, CR2, CR3, ARW, DNG, ORF, and more
- Automatic duplicate detection
- Configurable parallel uploads (1–10 connections)
- Optional delete-after-upload for SD card clearing
- SFTP uploads can resume after an interrupted session
- Credentials are encrypted at rest using your OS keychain
- Live activity log with per-file status, plus upload history
- Settings saved locally between sessions

---

## Setup (Development / Run from source)

### Requirements
- [Node.js](https://nodejs.org/) v18 or higher
- npm (comes with Node.js)

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Run the app
npm start
```

---

## Build a Standalone .exe

```bash
# Portable .exe (single file, no installer)
npm run build

# Installer .exe (with install wizard)
npm run build:installer
```

Output will be in the `dist/` folder.

> **Note:** These builds are not code-signed. On first launch, Windows
> SmartScreen may show a "Windows protected your PC" warning — this is
> expected for an unsigned indie app, not a sign anything is broken. Click
> **More info → Run anyway** to continue.

---

## First-Time Configuration

The app walks you through adding a destination the first time you launch it. To add or
edit one later:

1. Open **Settings → Services** and click **Add Service**
2. Pick a destination — for example, Immich:
   - Enter your server URL, e.g. `http://192.168.1.50:2283`
   - Generate an API key in Immich: **Account Settings → API Keys → New API Key**
   - Paste it in and click **Test Connection**
3. Click **Save Settings**

You can configure multiple destinations (SFTP, Nextcloud, Dropbox, local folder) the
same way and switch between them from the Upload tab.

---

## Usage

1. On the **Upload** tab, click the folder area or drag & drop a folder
2. The app will scan and count all media files
3. Adjust parallel uploads and delete-after-upload if desired
4. Click **Start Upload**
5. Watch the live log — green = uploaded, purple = already exists, red = error

---

## Supported Formats

**Images:** JPG, PNG, GIF, WEBP, HEIC, HEIF, TIFF  
**RAW:** NEF, CR2, CR3, ARW, DNG, ORF, RW2, PEF, SRW  
**Video:** MP4, MOV, AVI, MKV, WMV, M4V, 3GP

---

## License

MIT — see [LICENSE](LICENSE).
