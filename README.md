# Goojara Downloader & Shield

Chrome Manifest V3 extension for **https://*.goojara.to** that:

1. Detects and downloads video streams (MP4 / WebM / HLS) entirely client-side
2. Aggressively blocks ads, popups, popunders, and forced redirects

All processing stays on-device. No external APIs or cloud servers.

## Install (developer mode)

### Chrome / Opera / Edge
1. Open `chrome://extensions` (or `opera://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Visit a Goojara page, click **Play**, then open the extension popup

### Firefox
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` in this folder  
   (Temporary add-ons are removed when Firefox restarts.)
4. Visit a Goojara page, click **Play**, then open the extension popup

> The manifest includes both `background.service_worker` (Chromium) and `background.scripts` (Firefox).

## File structure

```
manifest.json          MV3 manifest + CSP
background.js          Service worker (sniff, shield, downloads)
content.js             document_start shield + DOM scrape
popup.html/js/css      Glassmorphic popup UI
rules.json             Static declarativeNetRequest ad rules
lib/storage.js         chrome.storage helpers
lib/m3u8Parser.js      HLS master/media + AES-128 key parsing
lib/downloader.js      Parallel HLS download, decrypt, stitch
injected/pageShield.js Page-world popup/redirect overrides
icons/                 Extension icons
```

## Permission justifications (Chrome Web Store)

| Permission | Why |
|---|---|
| `activeTab` | Read/act on the tab the user opens the popup on |
| `storage` | Persist detected streams, settings, shield stats, and interrupted download state |
| `scripting` | Inject DOM media scraper when the popup rescans |
| `downloads` | Save stitched MP4/WebM files to the user's download folder |
| `declarativeNetRequest` | Block ad/popunder domains and attach Referer headers for media CDN fetches |
| `webRequest` | **Observe only** (non-blocking) media URLs matching `.m3u8` / `.mp4` / `.webm` / `.ts` |
| `tabs` | Detect forced navigations away from Goojara and revert them; close popunder tabs |
| `alarms` | Wake the service worker to resume an HLS download interrupted by MV3 termination |
| Host `*://goojara.to/*` / `*://*.goojara.to/*` | Match the site the extension is built for |
| Host `*://*/*` | Video segments and keys are often on third-party CDNs; the SW must fetch them client-side to assemble the file |

## Features

### Video detection
- Network sniffing via `webRequest.onCompleted` / `onBeforeRequest`
- DOM scrape of `<video>`, iframes, `.mp4`/`.m3u8` links, and the native **DOWNLOAD** control
- New-tab media URLs captured and stored against the opener tab

### HLS download
- Master playlist quality picker in the popup
- 4-way parallel segment fetch, 3 retries with exponential backoff
- AES-128-CBC decryption via Web Crypto
- In-memory `.ts` stitch → single `.mp4` download
- Live progress (% / MB / MB/s / ETA) + Cancel (`AbortController`)
- Download state persisted so the SW can resume after sleep

### Shield
- Static + dynamic DNR blocklists
- `window.open` / `location.assign` / `location.replace` overrides
- Notification permission denied; `beforeunload` traps neutralized
- MutationObserver strips ad iframes/scripts within ~100ms
- Click interceptor for invisible overlays
- Forced off-site navigations without a recent user gesture are reverted

## Notes

- **BLOB** streams appear in the list but cannot be re-fetched from the extension; prefer network-detected MP4/HLS.
- **DASH** (separate A/V) is detected; `ffmpeg.wasm` is intentionally not bundled so the package stays under 500KB.
- Use only on content you have the right to download. This tool is for personal/authorized use and privacy protection on Goojara.
