/**
 * Content script — runs at document_start on goojara.to.
 * Injects page-world shield, strips known ad hosts (player-safe), scrapes media.
 */

(() => {
  const GOOJARA_RE = /(^|\.)goojara\.[a-z0-9]+$/i;
  const AD_HOST_RE =
    /(doubleclick|googlesyndication|googleads|adnxs|adsrvr|popads|popcash|exoclick|juicyads|propellerads|propeller\.|adsterra|taboola|outbrain|mgid|revcontent|clickadu|adcash|trafficfactory|hilltopads|moatads|amazon-adsystem|scorecardresearch|quantserve|histats|statcounter|zergnet)/i;

  // Strict: avoid matching "download", "header", "player", "pad", etc.
  const AD_ATTR_RE =
    /(^|[^a-z])((ads?)[-_]?((box|wrap|slot|unit|banner|container|iframe|holder|block)s?)|advert|sponsor[-_]?ads?|popunder|pop[-_]?up[-_]?ad)([^a-z]|$)/i;

  const PLAYER_RE =
    /(player|video|stream|embed|watch|movie|jwplayer|plyr|clappr|vidstack|mediaelement|html5)/i;

  let settingsCache = { adBlockerEnabled: true, autoDetectEnabled: true };
  let lastReport = 0;

  chrome.storage.local.get({ settings: settingsCache }, (data) => {
    settingsCache = { ...settingsCache, ...(data.settings || {}) };
    syncShieldFlag();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settingsCache = { ...settingsCache, ...changes.settings.newValue };
      syncShieldFlag();
    }
  });

  function shieldOn() {
    return settingsCache.adBlockerEnabled !== false;
  }

  /** Let the page-world script know whether to block window.open aggressively. */
  function syncShieldFlag() {
    try {
      document.documentElement?.setAttribute(
        'data-goojara-shield',
        shieldOn() ? 'on' : 'off'
      );
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Inject page-world shield
  // ---------------------------------------------------------------------------
  function injectPageShield() {
    try {
      syncShieldFlag();
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected/pageShield.js');
      s.async = false;
      (document.documentElement || document.head || document).appendChild(s);
      s.onload = () => s.remove();
    } catch (err) {
      console.warn('[content] shield inject failed', err);
    }
  }
  injectPageShield();

  window.addEventListener('goojara-shield', (ev) => {
    if (!shieldOn()) return;
    const detail = ev.detail || {};
    let domain = null;
    try {
      if (detail.url) domain = new URL(detail.url, location.href).hostname;
    } catch {
      /* ignore */
    }
    chrome.runtime
      .sendMessage({ type: 'SHIELD_EVENT', kind: detail.kind || 'popup', domain })
      .catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Helpers — protect the player at all costs
  // ---------------------------------------------------------------------------
  function isLikelyMedia(url) {
    return /\.(mp4|m3u8|webm|mpd)(\?|#|$)/i.test(url) || url.startsWith('blob:');
  }

  function isInsidePlayer(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest?.('video, audio')) return true;
    if (el.closest?.('iframe')) {
      const frame = el.closest('iframe');
      const src = frame?.getAttribute('src') || frame?.getAttribute('data-src') || '';
      if (PLAYER_RE.test(src) || !AD_HOST_RE.test(src)) return true;
    }
    const host = el.closest?.(
      '[id*="player" i], [class*="player" i], [id*="video" i], [class*="video" i], [id*="watch" i], [class*="embed" i], .jwplayer, #player, #movie, #vplayer, #mainplayer'
    );
    return Boolean(host);
  }

  function isPlayControl(el) {
    if (!(el instanceof Element)) return false;
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.textContent ||
      ''
    ).toLowerCase();
    if (/\b(play|pause|watch|start)\b/.test(label)) return true;
    if (el.matches?.('button, [role="button"], .play, .play-btn, .vjs-big-play-button, .jw-icon-display')) {
      if (isInsidePlayer(el) || /\bplay\b/i.test(el.className || '')) return true;
    }
    return false;
  }

  function isPlayerIframe(el) {
    if (!(el instanceof HTMLIFrameElement)) return false;
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    if (!src) return true; // empty src often filled later by player bootstrap
    if (AD_HOST_RE.test(src)) return false;
    if (GOOJARA_RE.test(safeHost(src))) return true;
    if (PLAYER_RE.test(src)) return true;
    // Third-party stream hosts are common on Goojara — never strip unknown iframes
    // unless they match a known ad network.
    return true;
  }

  function safeHost(url) {
    try {
      return new URL(url, location.href).hostname;
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Click interception — block popup links + clickjack overlays (player-safe)
  // ---------------------------------------------------------------------------
  document.addEventListener(
    'click',
    (e) => {
      try {
        document.documentElement?.setAttribute('data-goojara-gesture', String(Date.now()));
      } catch {
        /* ignore */
      }
      chrome.runtime.sendMessage({ type: 'USER_GESTURE' }).catch(() => {});
      if (!shieldOn()) return;

      // Never interfere with play / player UI
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      for (const node of path) {
        if (!(node instanceof Element)) continue;
        if (isInsidePlayer(node) || isPlayControl(node) || node.tagName === 'VIDEO') {
          return;
        }
      }

      for (const node of path) {
        if (!node || node === document || node === window) continue;
        if (!(node instanceof Element)) continue;

        if (isClickjackOverlay(node)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          node.remove();
          chrome.runtime
            .sendMessage({ type: 'SHIELD_EVENT', kind: 'ad', count: 1 })
            .catch(() => {});
          return;
        }

        const anchor = node.closest?.('a[href]');
        if (!anchor || isInsidePlayer(anchor)) continue;

        const href = anchor.href || '';
        let host = '';
        try {
          host = new URL(href, location.href).hostname;
        } catch {
          continue;
        }

        const external = host && !GOOJARA_RE.test(host) && !isLikelyMedia(href);
        if (!external) continue;

        // Popup / new-tab bait links (most Goojara popunders)
        const target = (anchor.getAttribute('target') || '').toLowerCase();
        const rel = (anchor.getAttribute('rel') || '').toLowerCase();
        const isNewTab =
          target === '_blank' ||
          target === '_new' ||
          rel.includes('noopener') ||
          anchor.hasAttribute('data-popup');

        if (isNewTab || isClickjackOverlay(anchor) || isStrictAdElement(anchor)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          chrome.runtime
            .sendMessage({
              type: 'SHIELD_EVENT',
              kind: 'popup',
              domain: host
            })
            .catch(() => {});
          return;
        }
      }
    },
    true
  );

  document.addEventListener(
    'auxclick',
    () => {
      try {
        document.documentElement?.setAttribute('data-goojara-gesture', String(Date.now()));
      } catch {
        /* ignore */
      }
      chrome.runtime.sendMessage({ type: 'USER_GESTURE' }).catch(() => {});
    },
    true
  );

  /** True full-viewport transparent clickjacker — not a player play overlay. */
  function isClickjackOverlay(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (isInsidePlayer(el) || isPlayControl(el)) return false;
    if (el.querySelector?.('video, button, [class*="play" i], iframe')) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = el.getBoundingClientRect();
    // Must cover essentially the whole viewport (not just the player box)
    const coversViewport =
      rect.width >= window.innerWidth * 0.9 &&
      rect.height >= window.innerHeight * 0.85 &&
      rect.top <= 10 &&
      rect.left <= 10;
    if (!coversViewport) return false;

    const opacity = Number(style.opacity);
    const z = Number(style.zIndex) || 0;
    if (z < 100) return false;

    // Near-invisible hitchhiker over the whole page
    if (opacity < 0.2) return true;
    if (
      (style.backgroundColor === 'transparent' ||
        style.backgroundColor === 'rgba(0, 0, 0, 0)') &&
      !el.textContent?.trim()
    ) {
      return true;
    }
    return false;
  }

  function isStrictAdElement(el) {
    if (!(el instanceof Element)) return false;
    if (isInsidePlayer(el)) return false;
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    if (AD_ATTR_RE.test(id) || AD_ATTR_RE.test(cls)) return true;
    const src =
      el.getAttribute?.('src') ||
      el.getAttribute?.('data-src') ||
      el.getAttribute?.('href') ||
      '';
    return AD_HOST_RE.test(src);
  }

  // ---------------------------------------------------------------------------
  // MutationObserver — only strip known ad-network nodes (never player iframes)
  // ---------------------------------------------------------------------------
  const pendingRemovals = new Set();

  function scheduleRemove(el) {
    if (!el || pendingRemovals.has(el)) return;
    if (isInsidePlayer(el) || isPlayerIframe(el) || el.tagName === 'VIDEO') return;
    pendingRemovals.add(el);
    setTimeout(() => {
      pendingRemovals.delete(el);
      if (!shieldOn()) return;
      if (!el.isConnected) return;
      if (isInsidePlayer(el) || isPlayerIframe(el)) return;
      try {
        el.remove();
        chrome.runtime
          .sendMessage({ type: 'SHIELD_EVENT', kind: 'ad', count: 1 })
          .catch(() => {});
      } catch {
        /* ignore */
      }
    }, 50);
  }

  function inspectNode(node) {
    if (!shieldOn()) return;
    if (!(node instanceof Element)) return;
    if (isInsidePlayer(node) || node.tagName === 'VIDEO') return;

    if (node.tagName === 'IFRAME') {
      // Only remove iframes from known ad networks — keep all player/unknown embeds
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      if (src && AD_HOST_RE.test(src)) scheduleRemove(node);
      return;
    }

    if (node.tagName === 'SCRIPT' || node.tagName === 'IMG' || node.tagName === 'INS') {
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      if (src && AD_HOST_RE.test(src)) scheduleRemove(node);
      return;
    }

    // Divs: only if clearly labeled as ad units AND not in the player
    if (node.tagName === 'DIV' || node.tagName === 'SECTION' || node.tagName === 'ASIDE') {
      if (isStrictAdElement(node) && !node.querySelector?.('video, iframe')) {
        scheduleRemove(node);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!shieldOn()) return;
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        inspectNode(n);
        if (n instanceof Element) {
          // Do NOT walk every div — only high-risk tags
          n.querySelectorAll?.('iframe, script, img, ins, [id*="ad-" i], [class*="ads" i]').forEach(
            inspectNode
          );
        }
      });
    }
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });

  // ---------------------------------------------------------------------------
  // Media detection
  // ---------------------------------------------------------------------------
  function scrapeAndReport() {
    if (!settingsCache.autoDetectEnabled) return;
    const streams = scrapeNow();
    if (!streams.length) return;
    const now = Date.now();
    if (now - lastReport < 1500) return;
    lastReport = now;
    chrome.runtime.sendMessage({ type: 'DOM_STREAMS', streams }).catch(() => {});
  }

  function getPageMovieTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.content;
    const twitter = document.querySelector('meta[name="twitter:title"]')?.content;
    const h1 =
      document.querySelector('h1.entry-title, h1.title, .movie-title, h1')?.textContent?.trim();
    const candidates = [og, twitter, h1, document.title];
    for (const raw of candidates) {
      if (!raw) continue;
      let t = String(raw).trim();
      t = t
        .replace(/\s*[\|\-–—]\s*Goojara.*$/i, '')
        .replace(/\s*\|.*$/i, '')
        .replace(/\s+Online(\s+Free)?(\s+HD)?(\s+Streaming)?$/i, '')
        .replace(/^Watch\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t.length >= 2 && !/^goojara/i.test(t)) return t.slice(0, 120);
    }
    return '';
  }

  function scrapeNow() {
    const found = [];
    const seen = new Set();
    const pageTitle = getPageMovieTitle();
    const push = (url, extra = {}) => {
      if (!url || seen.has(url) || url.startsWith('javascript:')) return;
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
      const q = v.videoHeight ? `${v.videoHeight}p` : null;
      if (v.currentSrc) push(v.currentSrc, { quality: q });
      if (v.src) push(v.src, { quality: q });
      v.querySelectorAll('source').forEach((s) => push(s.src, { quality: q }));
    });

    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      if (/\.(mp4|m3u8|webm)(\?|$)/i.test(href)) push(href);
      const text = (a.textContent || '').trim().toUpperCase();
      if (text.includes('DOWNLOAD') && href) {
        push(href, { title: 'Native DOWNLOAD button' });
      }
    });

    document
      .querySelectorAll('button, [role="button"], a.download, #download, .download')
      .forEach((el) => {
        const label = (el.textContent || el.getAttribute('title') || '').toUpperCase();
        if (!label.includes('DOWNLOAD')) return;
        const href =
          el.getAttribute('href') ||
          el.getAttribute('data-href') ||
          el.getAttribute('data-url') ||
          el.getAttribute('data-link');
        if (href) push(href, { title: 'Native DOWNLOAD button' });
      });

    return found;
  }

  function watchVideos() {
    const bind = (video) => {
      if (video.__goojaraBound) return;
      video.__goojaraBound = true;
      const onReady = () => scrapeAndReport();
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('play', onReady);
      video.addEventListener('playing', onReady);
      const srcObs = new MutationObserver(onReady);
      srcObs.observe(video, { attributes: true, attributeFilter: ['src', 'srcObject'] });
    };
    document.querySelectorAll('video').forEach(bind);
  }

  const videoObserver = new MutationObserver(() => {
    watchVideos();
    scrapeAndReport();
  });

  const bootMedia = () => {
    syncShieldFlag();
    watchVideos();
    scrapeAndReport();
    videoObserver.observe(document.documentElement || document, {
      childList: true,
      subtree: true
    });
    setInterval(scrapeAndReport, 4000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootMedia, { once: true });
  } else {
    bootMedia();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'CONTENT_SCRAPE') {
      sendResponse({ ok: true, streams: scrapeNow() });
      return true;
    }
    return false;
  });
})();
