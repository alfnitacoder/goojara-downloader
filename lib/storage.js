/**
 * chrome.storage.local helpers for streams, settings, download state, and shield stats.
 */

const DEFAULT_SETTINGS = {
  adBlockerEnabled: true,
  autoDetectEnabled: true
};

const DEFAULT_STATS = {
  blockedPopups: 0,
  blockedRedirects: 0,
  blockedAds: 0,
  sessionStart: Date.now()
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function setSettings(partial) {
  const current = await getSettings();
  const settings = { ...current, ...partial };
  await chrome.storage.local.set({ settings });
  return settings;
}

export async function getStats() {
  const { shieldStats } = await chrome.storage.local.get({ shieldStats: DEFAULT_STATS });
  return { ...DEFAULT_STATS, ...shieldStats };
}

export async function bumpStat(key, amount = 1) {
  const stats = await getStats();
  stats[key] = (stats[key] || 0) + amount;
  await chrome.storage.local.set({ shieldStats: stats });
  return stats;
}

export async function resetStats() {
  const shieldStats = { ...DEFAULT_STATS, sessionStart: Date.now() };
  await chrome.storage.local.set({ shieldStats });
  return shieldStats;
}

/** Stream fingerprint for dedupe. */
function streamKey(stream) {
  return `${stream.tabId || 0}::${stream.url}`;
}

export async function getStreams(tabId = null) {
  const { streams = [] } = await chrome.storage.local.get({ streams: [] });
  if (tabId == null) return streams;
  return streams.filter((s) => s.tabId === tabId);
}

export async function upsertStream(stream) {
  const { streams = [] } = await chrome.storage.local.get({ streams: [] });
  const key = streamKey(stream);
  const idx = streams.findIndex((s) => streamKey(s) === key);
  const entry = {
    id: stream.id || crypto.randomUUID(),
    url: stream.url,
    type: stream.type || detectType(stream.url),
    quality: stream.quality || null,
    size: stream.size || null,
    tabId: stream.tabId ?? null,
    title: stream.title || null,
    pageTitle: stream.pageTitle || null,
    source: stream.source || 'network',
    timestamp: stream.timestamp || Date.now()
  };
  if (idx >= 0) {
    streams[idx] = {
      ...streams[idx],
      ...entry,
      id: streams[idx].id,
      // Keep a good page title if the new entry lacks one
      pageTitle: entry.pageTitle || streams[idx].pageTitle || null,
      title:
        entry.title && !/^(native download|iframe source|opened in new tab)/i.test(entry.title)
          ? entry.title
          : streams[idx].title || entry.title || null
    };
  } else {
    streams.push(entry);
  }
  // Cap memory: keep newest 200
  const trimmed = streams.sort((a, b) => b.timestamp - a.timestamp).slice(0, 200);
  await chrome.storage.local.set({ streams: trimmed });
  return entry;
}

export async function clearStreamsForTab(tabId) {
  const { streams = [] } = await chrome.storage.local.get({ streams: [] });
  await chrome.storage.local.set({
    streams: streams.filter((s) => s.tabId !== tabId)
  });
}

export function detectType(url) {
  const u = (url || '').toLowerCase().split('?')[0];
  if (u.endsWith('.m3u8') || u.includes('.m3u8')) return 'HLS';
  if (u.endsWith('.mp4') || u.includes('.mp4')) return 'MP4';
  if (u.endsWith('.webm') || u.includes('.webm')) return 'WEBM';
  if (u.endsWith('.mpd') || u.includes('.mpd')) return 'DASH';
  if (u.endsWith('.ts')) return 'TS';
  if (u.startsWith('blob:')) return 'BLOB';
  return 'MEDIA';
}

export async function getDownloadState() {
  const { downloadState = null } = await chrome.storage.local.get({ downloadState: null });
  return downloadState;
}

export async function setDownloadState(state) {
  await chrome.storage.local.set({ downloadState: state });
  return state;
}

export async function clearDownloadState() {
  await chrome.storage.local.remove('downloadState');
}

/** Persist domains detected as redirect/ad hosts for dynamic DNR rules. */
export async function getBlockedDomains() {
  const { blockedDomains = [] } = await chrome.storage.local.get({ blockedDomains: [] });
  return blockedDomains;
}

export async function addBlockedDomain(domain) {
  const list = await getBlockedDomains();
  if (!domain || list.includes(domain)) return list;
  list.push(domain);
  await chrome.storage.local.set({ blockedDomains: list.slice(-100) });
  return list;
}
