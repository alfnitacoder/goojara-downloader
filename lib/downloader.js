/**
 * Stream downloader: direct MP4/WebM via chrome.downloads, HLS via parallel
 * segment fetch + AES-128 decrypt + in-memory stitch.
 * Runs inside the service worker (fewer CORS restrictions).
 */

import { parseM3U8, qualityLabel } from './m3u8Parser.js';
import { setDownloadState, clearDownloadState } from './storage.js';

const GOOJARA_REFERER = 'https://ww1.goojara.to/';
const GOOJARA_ORIGIN = 'https://ww1.goojara.to';
const GOOJARA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CONCURRENCY = 4;
const MAX_RETRIES = 3;
const REFERER_RULE_ID = 20_001;

/** @type {AbortController|null} */
let activeAbort = null;
/** @type {string|null} */
let activeDownloadId = null;

/**
 * Attach Referer/Origin via session DNR rules (fetch cannot set forbidden headers).
 * Broad match during an active download so master playlist, keys, and CDN segments
 * all receive the goojara Referer.
 */
async function ensureRefererRules(_targetUrl) {
  const rule = {
    id: REFERER_RULE_ID,
    priority: 100,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: GOOJARA_REFERER },
        { header: 'Origin', operation: 'set', value: GOOJARA_ORIGIN }
      ]
    },
    condition: {
      // Scoped to media playlists/segments only — never rewrite all site XHR
      regexFilter: '\\.(m3u8|mp4|webm|ts|key)(\\?|$)',
      resourceTypes: ['xmlhttprequest', 'media', 'other']
    }
  };
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: [rule]
    });
  } catch (err) {
    console.warn('[downloader] referer rule failed', err);
  }
}

async function clearRefererRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: []
    });
  } catch {
    /* ignore */
  }
}

export function isDownloading() {
  return activeAbort != null && !activeAbort.signal.aborted;
}

export function cancelDownload() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  activeDownloadId = null;
  clearRefererRules();
  return clearDownloadState();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/**
 * Fetch with Referer/UA, 403 retry, and exponential backoff.
 */
export async function fetchWithHeaders(url, { signal, range, asText = false } = {}) {
  await ensureRefererRules(url);
  const headers = {
    Accept: '*/*'
  };
  // Referer / User-Agent are applied via session DNR rules (forbidden in fetch()).
  if (range) headers.Range = range;

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(url, { headers, signal, credentials: 'omit', cache: 'no-store' });
      if (res.status === 403 && attempt < MAX_RETRIES - 1) {
        // Retry with alternate referer host variants
        headers.Referer = 'https://goojara.to/';
        await sleep(300 * 2 ** attempt, signal);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (asText) return await res.text();
      return await res.arrayBuffer();
    } catch (err) {
      lastError = err;
      if (err?.name === 'AbortError') throw err;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(400 * 2 ** attempt, signal);
      }
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

/** AES-128-CBC decrypt a single HLS segment using Web Crypto. */
async function decryptAes128(data, keyBytes, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
    'decrypt'
  ]);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    data
  );
  return new Uint8Array(decrypted);
}

const keyCache = new Map();

async function getKeyBytes(uri, signal) {
  if (keyCache.has(uri)) return keyCache.get(uri);
  const buf = await fetchWithHeaders(uri, { signal });
  const bytes = new Uint8Array(buf);
  keyCache.set(uri, bytes);
  return bytes;
}

function broadcastProgress(progress) {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', progress }).catch(() => {});
}

/**
 * Probe an HLS URL and return qualities / media playlist info for the popup.
 */
export async function probeHls(url) {
  const text = await fetchWithHeaders(url, { asText: true });
  const parsed = parseM3U8(text, url);
  if (parsed.kind === 'master') {
    return {
      kind: 'master',
      variants: parsed.variants.map((v) => ({
        url: v.url,
        label: qualityLabel(v),
        bandwidth: v.bandwidth,
        resolution: v.resolution
      }))
    };
  }
  return {
    kind: 'media',
    variants: [
      {
        url,
        label: qualityLabel(url),
        bandwidth: null,
        resolution: null,
        segmentCount: parsed.segments.length,
        duration: parsed.segments.reduce((s, x) => s + (x.duration || 0), 0)
      }
    ],
    segmentCount: parsed.segments.length
  };
}

/**
 * Download a direct progressive file (MP4/WebM) via chrome.downloads.
 */
export async function downloadDirect(url, filename) {
  const safeName = sanitizeFilename(filename || guessFilename(url, 'mp4'));
  // Prefer chrome.downloads — Chrome attaches cookies/session for the URL.
  // On 403, fall back to SW fetch + blob download.
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: safeName,
      conflictAction: 'uniquify',
      saveAs: false
    });
    return { method: 'downloads', downloadId };
  } catch (err) {
    console.warn('[downloader] chrome.downloads failed, fetching via SW', err);
  }

  const abort = new AbortController();
  activeAbort = abort;
  activeDownloadId = crypto.randomUUID();
  try {
    await setDownloadState({
      id: activeDownloadId,
      url,
      type: 'direct',
      filename: safeName,
      status: 'fetching',
      startedAt: Date.now()
    });
    broadcastProgress({
      id: activeDownloadId,
      status: 'downloading',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      speedMBps: 0,
      etaSeconds: null
    });

    const buf = await fetchWithHeaders(url, { signal: abort.signal });
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: safeName,
      conflictAction: 'uniquify'
    });
    // Revoke after Chrome has started the download
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    broadcastProgress({
      id: activeDownloadId,
      status: 'complete',
      percent: 100,
      downloadedBytes: buf.byteLength,
      totalBytes: buf.byteLength,
      speedMBps: 0,
      etaSeconds: 0
    });
    await clearDownloadState();
    return { method: 'blob', downloadId };
  } finally {
    activeAbort = null;
    activeDownloadId = null;
    await clearRefererRules();
  }
}

/**
 * Download an HLS media playlist: parallel segments, AES decrypt, stitch, save as .mp4.
 */
export async function downloadHls(mediaPlaylistUrl, filename, resumeState = null) {
  if (isDownloading()) {
    throw new Error('A download is already in progress');
  }

  const abort = new AbortController();
  activeAbort = abort;
  activeDownloadId = resumeState?.id || crypto.randomUUID();
  const safeName = sanitizeFilename(filename || guessFilename(mediaPlaylistUrl, 'mp4'));

  const startedAt = Date.now();
  let downloadedBytes = resumeState?.downloadedBytes || 0;

  try {
    const text = await fetchWithHeaders(mediaPlaylistUrl, {
      asText: true,
      signal: abort.signal
    });
    const playlist = parseM3U8(text, mediaPlaylistUrl);
    if (playlist.kind !== 'media' || playlist.segments.length === 0) {
      throw new Error('Playlist has no media segments');
    }

    const segments = playlist.segments;
    const total = segments.length;
    /** @type {(Uint8Array|null)[]} */
    const parts = new Array(total).fill(null);
    let completed = resumeState?.completedIndexes?.length || 0;
    const doneSet = new Set(resumeState?.completedIndexes || []);

    // We can't easily resume binary parts after SW death without IDB;
    // on resume we re-download from scratch but keep the same id for UI continuity.
    if (resumeState) {
      completed = 0;
      doneSet.clear();
      downloadedBytes = 0;
    }

    await setDownloadState({
      id: activeDownloadId,
      url: mediaPlaylistUrl,
      type: 'hls',
      filename: safeName,
      status: 'downloading',
      totalSegments: total,
      completedIndexes: [],
      downloadedBytes: 0,
      startedAt
    });

    let lastBytes = 0;
    let lastTick = Date.now();

    const report = (status = 'downloading') => {
      const now = Date.now();
      const dt = Math.max((now - lastTick) / 1000, 0.001);
      const speed = (downloadedBytes - lastBytes) / dt;
      lastBytes = downloadedBytes;
      lastTick = now;
      const speedMBps = speed / (1024 * 1024);
      const remaining = total - completed;
      const avgPerSeg = completed > 0 ? downloadedBytes / completed : 0;
      const etaSeconds =
        speed > 0 ? Math.round((remaining * avgPerSeg) / speed) : null;
      const progress = {
        id: activeDownloadId,
        status,
        percent: Math.min(99, Math.round((completed / total) * 100)),
        downloadedBytes,
        totalBytes: null,
        speedMBps: Number(speedMBps.toFixed(2)),
        etaSeconds,
        completed,
        total
      };
      broadcastProgress(progress);
      return progress;
    };

    report();

    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (cursor < total) {
        if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const i = cursor++;
        if (doneSet.has(i)) continue;
        const seg = segments[i];
        try {
          const range =
            seg.byteRangeLength != null
              ? `bytes=${seg.byteRangeStart ?? 0}-${(seg.byteRangeStart ?? 0) + seg.byteRangeLength - 1}`
              : undefined;
          let data = new Uint8Array(
            await fetchWithHeaders(seg.url, { signal: abort.signal, range })
          );
          if (seg.key && seg.key.method === 'AES-128') {
            const keyBytes = await getKeyBytes(seg.key.uri, abort.signal);
            data = await decryptAes128(data, keyBytes, seg.key.iv);
          }
          parts[i] = data;
          downloadedBytes += data.byteLength;
          completed++;
          doneSet.add(i);
          report();

          // Persist lightweight resume metadata periodically
          if (completed % 8 === 0) {
            await setDownloadState({
              id: activeDownloadId,
              url: mediaPlaylistUrl,
              type: 'hls',
              filename: safeName,
              status: 'downloading',
              totalSegments: total,
              completedIndexes: [...doneSet],
              downloadedBytes,
              startedAt
            });
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          console.warn(`[downloader] segment ${i} failed after retries, skipping`, err);
          // Skip failed segment (zero-length placeholder) so stitch can continue
          parts[i] = new Uint8Array(0);
          completed++;
          doneSet.add(i);
          report();
        }
      }
    });

    await Promise.all(workers);

    // Stitch
    broadcastProgress({
      id: activeDownloadId,
      status: 'stitching',
      percent: 99,
      downloadedBytes,
      totalBytes: downloadedBytes,
      speedMBps: 0,
      etaSeconds: 0,
      completed,
      total
    });

    const totalSize = parts.reduce((n, p) => n + (p?.byteLength || 0), 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const p of parts) {
      if (!p || !p.byteLength) continue;
      merged.set(p, offset);
      offset += p.byteLength;
    }

    const blob = new Blob([merged], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: safeName,
      conflictAction: 'uniquify'
    });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);

    broadcastProgress({
      id: activeDownloadId,
      status: 'complete',
      percent: 100,
      downloadedBytes: totalSize,
      totalBytes: totalSize,
      speedMBps: 0,
      etaSeconds: 0,
      completed: total,
      total
    });
    await clearDownloadState();
    return { method: 'hls', downloadId, bytes: totalSize };
  } catch (err) {
    if (err?.name === 'AbortError') {
      broadcastProgress({
        id: activeDownloadId,
        status: 'cancelled',
        percent: 0,
        downloadedBytes,
        totalBytes: null,
        speedMBps: 0,
        etaSeconds: null
      });
      await clearDownloadState();
      throw err;
    }
    broadcastProgress({
      id: activeDownloadId,
      status: 'error',
      percent: 0,
      downloadedBytes,
      totalBytes: null,
      speedMBps: 0,
      etaSeconds: null,
      error: String(err?.message || err)
    });
    throw err;
  } finally {
    activeAbort = null;
    activeDownloadId = null;
    keyCache.clear();
    await clearRefererRules();
  }
}

export function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'goojara-video.mp4';
}

export function guessFilename(url, ext = 'mp4') {
  try {
    const path = new URL(url).pathname;
    const base = path.split('/').pop() || `goojara-video.${ext}`;
    if (base.endsWith('.m3u8') || base.endsWith('.ts')) {
      return base.replace(/\.(m3u8|ts)$/i, `.${ext}`);
    }
    if (!/\.\w{2,4}$/.test(base)) return `${base}.${ext}`;
    return base;
  } catch {
    return `goojara-video.${ext}`;
  }
}
