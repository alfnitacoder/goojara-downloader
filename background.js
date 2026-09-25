/**
 * Service worker — network sniffing, anti-redirect shield, download orchestration,
 * dynamic DNR rules, and resume of interrupted HLS jobs.
 */

import {
  upsertStream,
  getStreams,
  getSettings,
  setSettings,
  getStats,
  bumpStat,
  resetStats,
  detectType,
  getDownloadState,
  addBlockedDomain,
  getBlockedDomains,
  clearStreamsForTab
} from './lib/storage.js';
import {
  probeHls,
  downloadDirect,
  downloadHls,
  cancelDownload,
  isDownloading,
  guessFilename
} from './lib/downloader.js';

const GOOJARA_HOST_RE = /(^|\.)goojara\.[a-z0-9]+$/i;
const MEDIA_URL_RE = /\.(m3u8|mp4|webm|ts|mpd)(\?|#|$)/i;
const AD_HOST_RE =
  /(doubleclick|googlesyndication|googleads|adnxs|adsrvr|popads|popcash|exoclick|juicyads|propeller|adsterra|taboola|outbrain|mgid|clickadu|adcash|trafficfactory)/i;
const DYNAMIC_RULE_ID_BASE = 10_000;
const MAX_DYNAMIC_RULES = 50;

function cleanTabTitle(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  t = t
    .replace(/\s*[\|\-–—]\s*Goojara.*$/i, '')
    .replace(/\s*\|.*$/i, '')
    .replace(/\s+Online(\s+Free)?(\s+HD)?(\s+Streaming)?$/i, '')
    .replace(/^Watch\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 2 || /^goojara downloader/i.test(t)) return null;
  return t.slice(0, 120);
}

function isAdHost(hostname) {
  return hostname ? AD_HOST_RE.test(hostname) : false;
}

/** tabId -> last known goojara URL (for revert) */
const tabHome = new Map();
/** tabId -> timestamp of last user-gesture-ish interaction from content script */
const tabGestureAt = new Map();

// --- Boot / resume -----------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await resetStats();
  await chrome.storage.local.set({ blockedDomains: [] });
  try {
    const session = await chrome.declarativeNetRequest.getSessionRules();
    if (session.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: session.map((r) => r.id),
        addRules: []
      });
    }
  } catch {
    /* ignore */
  }
  await rebuildDynamicRules();
});

chrome.runtime.onStartup.addListener(async () => {
  // Clear any leftover download Referer session rules that can break in-page playback
  try {
    const session = await chrome.declarativeNetRequest.getSessionRules();
    if (session.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: session.map((r) => r.id),
        addRules: []
      });
    }
  } catch {
    /* ignore */
  }
  const domains = await getBlockedDomains();
  const cleaned = domains.filter((d) => isAdHost(d));
  if (cleaned.length !== domains.length) {
    await chrome.storage.local.set({ blockedDomains: cleaned });
  }
  await rebuildDynamicRules();
  await maybeResumeDownload();
});

// Alarms keep the SW periodically awake enough to check resume state
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') {
    await maybeResumeDownload();
  }
});

async function maybeResumeDownload() {
  if (isDownloading()) return;
  const state = await getDownloadState();
  if (!state || state.status !== 'downloading' || state.type !== 'hls') return;
  console.info('[bg] Resuming interrupted HLS download', state.id);
  try {
    await downloadHls(state.url, state.filename, state);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error('[bg] Resume failed', err);
    }
  }
}

// --- Network sniffing (observational webRequest) -----------------------------

function classifyMediaUrl(url) {
  if (!url || url.startsWith('chrome') || url.startsWith('data:')) return null;
  if (url.startsWith('blob:')) return 'BLOB';
  if (!MEDIA_URL_RE.test(url)) return null;
  return detectType(url);
}

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    try {
      const settings = await getSettings();
      if (!settings.autoDetectEnabled) return;

      const type = classifyMediaUrl(details.url);
      if (!type) return;
      // Ignore tiny tracking .ts beacons / ad segments under ~ very short — keep all for now
      if (type === 'TS' && details.url.includes('ads')) return;

      const size =
        details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-length')
          ?.value || null;

      let pageTitle = null;
      if (details.tabId >= 0) {
        try {
          const tab = await chrome.tabs.get(details.tabId);
          pageTitle = cleanTabTitle(tab?.title);
        } catch {
          /* tab closed */
        }
      }

      await upsertStream({
        url: details.url,
        type,
        tabId: details.tabId >= 0 ? details.tabId : null,
        size: size ? Number(size) : null,
        pageTitle,
        source: 'network',
        timestamp: Date.now()
      });

      // Notify open popup
      chrome.runtime
        .sendMessage({
          type: 'STREAM_DETECTED',
          stream: { url: details.url, type, tabId: details.tabId }
        })
        .catch(() => {});
    } catch (err) {
      console.warn('[bg] sniff error', err);
    }
  },
  {
    urls: ['<all_urls>'],
    types: ['media', 'xmlhttprequest', 'other', 'object']
  },
  ['responseHeaders']
);

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const type = classifyMediaUrl(details.url);
    if (!type || type === 'TS') return;
    const settings = await getSettings();
    if (!settings.autoDetectEnabled) return;
    let pageTitle = null;
    if (details.tabId >= 0) {
      try {
        const tab = await chrome.tabs.get(details.tabId);
        pageTitle = cleanTabTitle(tab?.title);
      } catch {
        /* ignore */
      }
    }
    await upsertStream({
      url: details.url,
      type,
      tabId: details.tabId >= 0 ? details.tabId : null,
      pageTitle,
      source: 'network',
      timestamp: Date.now()
    });
  },
  {
    urls: ['*://*/*.m3u8*', '*://*/*.mp4*', '*://*/*.webm*', '*://*/*.mpd*'],
    types: ['media', 'xmlhttprequest', 'other', 'object']
  }
);

// --- Anti-redirect shield ----------------------------------------------------

function isGoojaraUrl(url) {
  try {
    return GOOJARA_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;

  if (isGoojaraUrl(url)) {
    tabHome.set(tabId, url);
    return;
  }

  // Allow direct media file navigations
  if (MEDIA_URL_RE.test(url)) return;

  const home = tabHome.get(tabId);
  if (!home) return;

  const settings = await getSettings();
  if (!settings.adBlockerEnabled) return;

  // Only act on actual URL changes (not title/status)
  if (!changeInfo.url) return;

  const lastGesture = tabGestureAt.get(tabId) || 0;
  const recentGesture = Date.now() - lastGesture < 8000;

  // Silent off-site hop → bounce back. Recent user gesture (e.g. Play) → allow.
  if (recentGesture) return;

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }

  console.info('[bg] Blocking forced redirect', url, '→ revert', home);
  try {
    await chrome.tabs.update(tabId, { url: home });
    await bumpStat('blockedRedirects');
    // Only persist DNR blocks for known ad networks (never stream CDNs)
    if (isAdHost(host)) {
      await addBlockedDomain(host);
      await rebuildDynamicRules();
    }
  } catch (err) {
    console.warn('[bg] revert failed', err);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabHome.delete(tabId);
  tabGestureAt.delete(tabId);
  clearStreamsForTab(tabId).catch(() => {});
});

// Close popup/popunder tabs opened from Goojara (keep goojara + direct media)
chrome.tabs.onCreated.addListener(async (tab) => {
  const openerId = tab.openerTabId;
  if (openerId == null) return;
  const openerHome = tabHome.get(openerId);
  if (!openerHome) return;

  const settings = await getSettings();
  if (!settings.adBlockerEnabled) return;

  const tryClose = async (attempt) => {
    try {
      const fresh = await chrome.tabs.get(tab.id);
      const url = fresh.pendingUrl || fresh.url || '';

      // Still loading — retry briefly
      if ((!url || url === 'about:blank' || url.startsWith('chrome://newtab')) && attempt < 6) {
        setTimeout(() => tryClose(attempt + 1), 200);
        return;
      }
      if (!url || url.startsWith('chrome') || url.startsWith('opera')) return;

      if (MEDIA_URL_RE.test(url) || url.includes('.m3u8') || url.includes('.mp4')) {
        await upsertStream({
          url,
          type: detectType(url),
          tabId: openerId,
          source: 'new-tab',
          title: 'Opened in new tab',
          timestamp: Date.now()
        });
        return;
      }

      if (isGoojaraUrl(url)) return;

      // External tab from a goojara page = popup/popunder
      await chrome.tabs.remove(tab.id).catch(() => {});
      await bumpStat('blockedPopups');
      try {
        const host = new URL(url).hostname;
        if (isAdHost(host)) {
          await addBlockedDomain(host);
          await rebuildDynamicRules();
        }
      } catch {
        /* ignore */
      }
    } catch {
      /* tab gone */
    }
  };

  setTimeout(() => tryClose(0), 150);
});

// --- Dynamic DNR rules for learned redirect domains --------------------------

async function rebuildDynamicRules() {
  const domains = await getBlockedDomains();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules = domains.slice(0, MAX_DYNAMIC_RULES).map((domain, i) => ({
    id: DYNAMIC_RULE_ID_BASE + i,
    priority: 10,
    action: { type: 'block' },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: [
        'main_frame',
        'sub_frame',
        'script',
        'xmlhttprequest',
        'image',
        'ping',
        'other'
      ]
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

// Toggle static ruleset when ad blocker setting changes
async function applyAdBlockerSetting(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? ['ad_block_rules'] : [],
    disableRulesetIds: enabled ? [] : ['ad_block_rules']
  });
  if (!enabled) {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((r) => r.id),
        addRules: []
      });
    }
  } else {
    await rebuildDynamicRules();
  }
}

// --- Messaging ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'GET_STREAMS': {
      const tabId = message.tabId;
      const streams = await getStreams(tabId);
      return { ok: true, streams };
    }

    case 'DOM_STREAMS': {
      const tabId = sender.tab?.id ?? message.tabId;
      const list = message.streams || [];
      for (const s of list) {
        await upsertStream({
          ...s,
          tabId,
          source: s.source || 'dom',
          timestamp: Date.now()
        });
      }
      return { ok: true, count: list.length };
    }

    case 'USER_GESTURE': {
      if (sender.tab?.id != null) {
        tabGestureAt.set(sender.tab.id, Date.now());
      }
      return { ok: true };
    }

    case 'SHIELD_EVENT': {
      const key =
        message.kind === 'popup'
          ? 'blockedPopups'
          : message.kind === 'redirect'
            ? 'blockedRedirects'
            : 'blockedAds';
      const stats = await bumpStat(key, message.count || 1);
      // Only learn domains that look like ad networks — never player CDNs
      if (message.domain && isAdHost(message.domain)) {
        await addBlockedDomain(message.domain);
        const settings = await getSettings();
        if (settings.adBlockerEnabled) await rebuildDynamicRules();
      }
      return { ok: true, stats };
    }

    case 'GET_STATS': {
      return { ok: true, stats: await getStats() };
    }

    case 'GET_SETTINGS': {
      return { ok: true, settings: await getSettings() };
    }

    case 'SET_SETTINGS': {
      const settings = await setSettings(message.settings || {});
      if (Object.prototype.hasOwnProperty.call(message.settings || {}, 'adBlockerEnabled')) {
        await applyAdBlockerSetting(settings.adBlockerEnabled);
      }
      return { ok: true, settings };
    }

    case 'PROBE_HLS': {
      const result = await probeHls(message.url);
      return { ok: true, ...result };
    }

    case 'START_DOWNLOAD': {
      const { url, mediaType, filename, variantUrl } = message;
      const title = filename || guessFilename(variantUrl || url, 'mp4');
      if ((mediaType === 'HLS' || (variantUrl || url || '').includes('.m3u8')) && (variantUrl || url)) {
        // Fire and continue — progress streamed via DOWNLOAD_PROGRESS messages
        downloadHls(variantUrl || url, title).catch((err) => {
          if (err?.name !== 'AbortError') console.error('[bg] HLS download error', err);
        });
        return { ok: true, started: true, mode: 'hls' };
      }
      const result = await downloadDirect(url, title);
      return { ok: true, started: true, mode: 'direct', result };
    }

    case 'CANCEL_DOWNLOAD': {
      await cancelDownload();
      return { ok: true };
    }

    case 'DOWNLOAD_STATE': {
      return {
        ok: true,
        downloading: isDownloading(),
        state: await getDownloadState()
      };
    }

    case 'SCAN_TAB': {
      const tabId = message.tabId;
      if (tabId == null) return { ok: false, error: 'No tabId' };
      try {
        // allFrames: true → one result object per frame
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: scrapeMediaFromDom
        });
        const streams = [];
        for (const r of results) {
          if (Array.isArray(r.result)) streams.push(...r.result);
        }
        for (const s of streams) {
          await upsertStream({ ...s, tabId, source: 'dom-scan', timestamp: Date.now() });
        }
        return { ok: true, streams: await getStreams(tabId) };
      } catch (err) {
        return { ok: false, error: String(err?.message || err), streams: await getStreams(tabId) };
      }
    }

    case 'RESET_STATS': {
      return { ok: true, stats: await resetStats() };
    }

    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

/**
 * Injected into the page (and iframes) when the popup requests a fresh scan.
 * Must be self-contained — no imports.
 */
function scrapeMediaFromDom() {
  const found = [];
  const seen = new Set();

  const cleanTitle = (raw) => {
    if (!raw) return '';
    let t = String(raw).trim();
    t = t
      .replace(/\s*[\|\-–—]\s*Goojara.*$/i, '')
      .replace(/\s*\|.*$/i, '')
      .replace(/\s+Online(\s+Free)?(\s+HD)?(\s+Streaming)?$/i, '')
      .replace(/^Watch\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length < 2 || /^goojara/i.test(t)) return '';
    return t.slice(0, 120);
  };

  const pageTitle =
    cleanTitle(document.querySelector('meta[property="og:title"]')?.content) ||
    cleanTitle(document.querySelector('meta[name="twitter:title"]')?.content) ||
    cleanTitle(
      document.querySelector('h1.entry-title, h1.title, .movie-title, h1')?.textContent
    ) ||
    cleanTitle(document.title);

  const push = (url, extra = {}) => {
    if (!url || seen.has(url)) return;
    if (url.startsWith('javascript:')) return;
    seen.add(url);
    let type = 'MEDIA';
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) type = 'HLS';
    else if (lower.includes('.mp4')) type = 'MP4';
    else if (lower.includes('.webm')) type = 'WEBM';
    else if (lower.includes('.mpd')) type = 'DASH';
    else if (url.startsWith('blob:')) type = 'BLOB';
    found.push({ url, type, pageTitle, ...extra });
  };

  document.querySelectorAll('video').forEach((v) => {
    if (v.currentSrc) push(v.currentSrc, { quality: v.videoHeight ? `${v.videoHeight}p` : null });
    if (v.src) push(v.src, { quality: v.videoHeight ? `${v.videoHeight}p` : null });
    v.querySelectorAll('source').forEach((s) => push(s.src));
  });

  document.querySelectorAll('iframe').forEach((frame) => {
    try {
      const src = frame.src || frame.getAttribute('data-src');
      if (src && (/\.(mp4|m3u8|webm)/i.test(src) || /embed|player|video/i.test(src))) {
        push(src, { title: 'iframe source' });
      }
    } catch {
      /* cross-origin */
    }
  });

  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href;
    if (/\.(mp4|m3u8|webm)(\?|$)/i.test(href)) push(href, { title: a.textContent?.trim()?.slice(0, 80) });
    const text = (a.textContent || '').trim().toUpperCase();
    if (text === 'DOWNLOAD' || text.includes('DOWNLOAD')) {
      push(href, { title: 'Native DOWNLOAD button' });
    }
  });

  // Goojara often uses buttons / spans labeled DOWNLOAD near the player
  document.querySelectorAll('button, [role="button"], .download, #download, a.download').forEach((el) => {
    const label = (el.textContent || el.getAttribute('title') || '').trim().toUpperCase();
    if (!label.includes('DOWNLOAD')) return;
    const href =
      el.getAttribute('href') ||
      el.getAttribute('data-href') ||
      el.getAttribute('data-url') ||
      el.getAttribute('data-link') ||
      el.dataset?.href;
    if (href) push(href, { title: 'Native DOWNLOAD button' });
  });

  return found;
}

console.info('[Goojara Downloader & Shield] service worker ready');
