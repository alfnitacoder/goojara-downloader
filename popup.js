/**
 * Popup controller — streams list, HLS quality picker, download progress, settings.
 */

const $ = (sel) => document.querySelector(sel);

const els = {
  shieldPill: $('#shieldPill'),
  shieldDot: $('#shieldDot'),
  shieldLabel: $('#shieldLabel'),
  statPopups: $('#statPopups'),
  statRedirects: $('#statRedirects'),
  statAds: $('#statAds'),
  progressPanel: $('#progressPanel'),
  progressStatus: $('#progressStatus'),
  progressFill: $('#progressFill'),
  progressPercent: $('#progressPercent'),
  progressSize: $('#progressSize'),
  progressSpeed: $('#progressSpeed'),
  progressEta: $('#progressEta'),
  btnCancel: $('#btnCancel'),
  btnRefresh: $('#btnRefresh'),
  streamList: $('#streamList'),
  emptyState: $('#emptyState'),
  qualityPanel: $('#qualityPanel'),
  qualityList: $('#qualityList'),
  btnQualityClose: $('#btnQualityClose'),
  toggleAdBlock: $('#toggleAdBlock'),
  toggleAutoDetect: $('#toggleAutoDetect'),
  tabHint: $('#tabHint')
};

/** @type {number|null} */
let activeTabId = null;
/** @type {string} */
let activeTabUrl = '';
/** @type {string} */
let activeTabTitle = '';
/** @type {boolean} */
let downloading = false;
/** @type {object|null} */
let pendingHls = null;

const GENERIC_TITLES = /^(native download|iframe source|opened in new tab|download|media|goojara downloader)/i;

function cleanMovieTitle(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  if (GENERIC_TITLES.test(t) || /^goojara downloader/i.test(t)) return '';
  t = t
    .replace(/\s*[\|\-–—]\s*Goojara.*$/i, '')
    .replace(/\s*\|.*$/i, '')
    .replace(/\s+Online(\s+Free)?(\s+HD)?(\s+Streaming)?$/i, '')
    .replace(/^Watch\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 120);
}

function sanitizeFilenameBase(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const mb = n / (1024 * 1024);
  if (mb < 0.1) return `${(n / 1024).toFixed(0)} KB`;
  return `${mb.toFixed(1)} MB`;
}

function formatEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return 'ETA —';
  if (sec < 60) return `ETA ${sec}s`;
  return `ETA ${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return `${u.hostname}/${path}`.slice(0, 48);
  } catch {
    return String(url).slice(0, 48);
  }
}

function isGoojara(url) {
  try {
    return /(^|\.)goojara\.[a-z0-9]+$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function updateShield(stats, settings) {
  const threats =
    (stats?.blockedPopups || 0) +
    (stats?.blockedRedirects || 0) +
    (stats?.blockedAds || 0);
  const on = settings?.adBlockerEnabled !== false;
  if (!on) {
    els.shieldPill.classList.add('threat');
    els.shieldLabel.textContent = 'Shield off';
  } else if (threats > 0) {
    els.shieldPill.classList.remove('threat');
    els.shieldLabel.textContent = `${threats} blocked`;
  } else {
    els.shieldPill.classList.remove('threat');
    els.shieldLabel.textContent = 'Protected';
  }
}

function renderStats(stats) {
  els.statPopups.textContent = String(stats?.blockedPopups || 0);
  els.statRedirects.textContent = String(stats?.blockedRedirects || 0);
  els.statAds.textContent = String(stats?.blockedAds || 0);
}

function renderProgress(p) {
  if (!p || p.status === 'complete' || p.status === 'cancelled' || p.status === 'error') {
    if (p?.status === 'complete') {
      els.progressPanel.classList.remove('hidden');
      els.progressStatus.textContent = 'Download complete';
      els.progressFill.style.width = '100%';
      els.progressPercent.textContent = '100%';
      setTimeout(() => {
        if (!downloading) els.progressPanel.classList.add('hidden');
      }, 1800);
    } else if (p?.status === 'error') {
      els.progressPanel.classList.remove('hidden');
      els.progressStatus.textContent = `Error: ${p.error || 'failed'}`;
    } else if (p?.status === 'cancelled') {
      els.progressPanel.classList.add('hidden');
    }
    downloading = p?.status === 'downloading' || p?.status === 'stitching' || p?.status === 'fetching';
    return;
  }

  downloading = true;
  els.progressPanel.classList.remove('hidden');
  const label =
    p.status === 'stitching'
      ? 'Stitching segments…'
      : p.status === 'fetching'
        ? 'Fetching file…'
        : 'Downloading…';
  els.progressStatus.textContent = label;
  els.progressFill.style.width = `${p.percent || 0}%`;
  els.progressPercent.textContent = `${p.percent || 0}%`;
  els.progressSize.textContent = formatBytes(p.downloadedBytes);
  els.progressSpeed.textContent = `${p.speedMBps ?? 0} MB/s`;
  els.progressEta.textContent = formatEta(p.etaSeconds);
}

function dedupeStreams(streams) {
  const map = new Map();
  for (const s of streams || []) {
    // Prefer non-TS, newer entries
    if (s.type === 'TS') continue;
    const prev = map.get(s.url);
    if (!prev || (s.timestamp || 0) > (prev.timestamp || 0)) map.set(s.url, s);
  }
  return [...map.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function renderStreams(streams) {
  const list = dedupeStreams(streams);
  els.streamList.innerHTML = '';
  if (!list.length) {
    els.streamList.appendChild(els.emptyState);
    els.emptyState.classList.remove('hidden');
    return;
  }
  els.emptyState.classList.add('hidden');

  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'stream-card';

    const badge = document.createElement('span');
    badge.className = `badge ${s.type || 'MEDIA'}`;
    badge.textContent = s.type || 'MEDIA';

    const meta = document.createElement('div');
    meta.className = 'stream-meta';
    const title = document.createElement('div');
    title.className = 'stream-title';
    const displayTitle =
      cleanMovieTitle(s.pageTitle) ||
      (!GENERIC_TITLES.test(s.title || '') ? cleanMovieTitle(s.title) : '') ||
      cleanMovieTitle(activeTabTitle) ||
      shortUrl(s.url);
    title.textContent = displayTitle;
    const sub = document.createElement('div');
    sub.className = 'stream-sub';
    const bits = [];
    if (s.quality) bits.push(s.quality);
    if (s.size) bits.push(formatBytes(s.size));
    bits.push(s.source || 'detected');
    sub.textContent = bits.join(' · ');
    meta.append(title, sub);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = 'Download';
    btn.disabled = downloading || s.type === 'BLOB';
    if (s.type === 'BLOB') btn.title = 'Blob URLs can’t be fetched from the extension — use network-detected MP4/HLS';
    btn.addEventListener('click', () => onDownload(s));

    card.append(badge, meta, btn);
    els.streamList.appendChild(card);
  }
}

async function onDownload(stream) {
  if (downloading) return;

  if (stream.type === 'HLS' || (stream.url || '').includes('.m3u8')) {
    els.qualityPanel.classList.remove('hidden');
    els.qualityList.innerHTML = `<div class="empty">Probing playlist…</div>`;
    pendingHls = stream;
    try {
      const res = await send('PROBE_HLS', { url: stream.url });
      if (!res?.ok) throw new Error(res?.error || 'Probe failed');
      const variants = res.variants || [];
      els.qualityList.innerHTML = '';
      if (!variants.length) {
        els.qualityList.innerHTML = `<div class="empty">No variants found</div>`;
        return;
      }
      for (const v of variants) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quality-card';
        const label = v.label || v.resolution || 'Auto';
        const bw = v.bandwidth ? ` · ${Math.round(v.bandwidth / 1000)} kbps` : '';
        const segs = v.segmentCount ? ` · ${v.segmentCount} segments` : '';
        btn.innerHTML = `<div class="stream-meta"><div class="stream-title">${label}${bw}</div><div class="stream-sub">${shortUrl(v.url)}${segs}</div></div>`;
        btn.addEventListener('click', () => startDownload(stream, v.url));
        els.qualityList.appendChild(btn);
      }
    } catch (err) {
      els.qualityList.innerHTML = `<div class="empty">Probe error: ${String(err.message || err)}</div>`;
    }
    return;
  }

  if (stream.type === 'DASH') {
    // Optional ffmpeg.wasm merge not bundled (keeps package under 500KB).
    // Download the MPD URL as a reference file and surface a note.
    alert(
      'DASH (separate audio/video) detected. ffmpeg.wasm is not bundled to keep the extension under 500KB. Try an HLS/MP4 source if available, or download tracks separately.'
    );
  }

  await startDownload(stream, null);
}

async function startDownload(stream, variantUrl) {
  els.qualityPanel.classList.add('hidden');
  downloading = true;
  renderProgress({
    status: 'downloading',
    percent: 0,
    downloadedBytes: 0,
    speedMBps: 0,
    etaSeconds: null
  });

  const filename = suggestFilename(stream);
  const res = await send('START_DOWNLOAD', {
    url: stream.url,
    variantUrl,
    mediaType: stream.type,
    filename
  });

  if (!res?.ok) {
    downloading = false;
    renderProgress({ status: 'error', error: res?.error || 'failed to start' });
  }
}

function suggestFilename(stream) {
  const movie =
    cleanMovieTitle(stream.pageTitle) ||
    (!GENERIC_TITLES.test(stream.title || '') ? cleanMovieTitle(stream.title) : '') ||
    cleanMovieTitle(activeTabTitle) ||
    'goojara-video';
  const base = sanitizeFilenameBase(movie) || 'goojara-video';
  const ext = stream.type === 'WEBM' ? 'webm' : 'mp4';
  return `${base}.${ext}`;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  activeTabUrl = tab?.url || '';
  activeTabTitle = cleanMovieTitle(tab?.title || '');

  if (!activeTabId || !isGoojara(activeTabUrl)) {
    els.tabHint.textContent = activeTabUrl
      ? 'This tab is not on goojara.to — open a Goojara page'
      : 'Open a goojara.to tab to begin';
  } else {
    els.tabHint.textContent = activeTabTitle || shortUrl(activeTabUrl);
  }

  const [settingsRes, statsRes, streamsRes, dlRes] = await Promise.all([
    send('GET_SETTINGS'),
    send('GET_STATS'),
    send('GET_STREAMS', { tabId: activeTabId }),
    send('DOWNLOAD_STATE')
  ]);

  const settings = settingsRes?.settings || {};
  els.toggleAdBlock.checked = settings.adBlockerEnabled !== false;
  els.toggleAutoDetect.checked = settings.autoDetectEnabled !== false;
  renderStats(statsRes?.stats);
  updateShield(statsRes?.stats, settings);

  let streams = streamsRes?.streams || [];

  if (activeTabId && isGoojara(activeTabUrl)) {
    try {
      const scan = await send('SCAN_TAB', { tabId: activeTabId });
      if (scan?.streams) streams = scan.streams;
    } catch {
      /* content script may be unavailable on restricted pages */
    }
  }

  renderStreams(streams);

  if (dlRes?.downloading || dlRes?.state?.status === 'downloading') {
    downloading = true;
    renderProgress({
      status: 'downloading',
      percent: Math.round(
        ((dlRes.state?.completedIndexes?.length || 0) / (dlRes.state?.totalSegments || 1)) * 100
      ),
      downloadedBytes: dlRes.state?.downloadedBytes || 0,
      speedMBps: 0,
      etaSeconds: null
    });
  }
}

// Events
els.btnRefresh.addEventListener('click', () => refresh());
els.btnCancel.addEventListener('click', async () => {
  await send('CANCEL_DOWNLOAD');
  downloading = false;
  els.progressPanel.classList.add('hidden');
});
els.btnQualityClose.addEventListener('click', () => {
  els.qualityPanel.classList.add('hidden');
  pendingHls = null;
});

els.toggleAdBlock.addEventListener('change', async () => {
  const res = await send('SET_SETTINGS', {
    settings: { adBlockerEnabled: els.toggleAdBlock.checked }
  });
  updateShield(null, res?.settings);
  const stats = await send('GET_STATS');
  updateShield(stats?.stats, res?.settings);
});

els.toggleAutoDetect.addEventListener('change', async () => {
  await send('SET_SETTINGS', {
    settings: { autoDetectEnabled: els.toggleAutoDetect.checked }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'DOWNLOAD_PROGRESS') {
    renderProgress(msg.progress);
    if (msg.progress?.status === 'complete' || msg.progress?.status === 'cancelled') {
      downloading = false;
      refresh();
    }
  }
  if (msg?.type === 'STREAM_DETECTED' && msg.stream?.tabId === activeTabId) {
    refresh();
  }
});

refresh();
