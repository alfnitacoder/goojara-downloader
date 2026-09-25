/**
 * Page-world shield — block popups/popunders without breaking stream playback.
 *
 * Strategy:
 * - Always block about:blank / empty window.open (classic popunder)
 * - Always block known ad-network URLs
 * - Do NOT rewrite location.href (breaks many players)
 * - location.assign/replace: only block known ad hosts
 * - After a real user click (gesture flag), briefly allow window.open to
 *   non-ad URLs so play bootstraps; still close those tabs from the SW if ads
 */
(function goojaraPageShield() {
  if (window.__goojaraShieldInstalled) return;
  window.__goojaraShieldInstalled = true;

  const GOOJARA_RE = /(^|\.)goojara\.[a-z0-9]+$/i;
  const MEDIA_RE = /\.(mp4|m3u8|webm|mpd)(\?|#|$)/i;
  const AD_HOST_RE =
    /(doubleclick|googlesyndication|googleads|adnxs|adsrvr|popads|popcash|exoclick|juicyads|propeller|adsterra|taboola|outbrain|mgid|revcontent|clickadu|adcash|trafficfactory|hilltopads|moatads|amazon-adsystem|trafficjunky)/i;

  const nativeOpen = window.open.bind(window);

  function shieldOn() {
    try {
      return document.documentElement?.getAttribute('data-goojara-shield') !== 'off';
    } catch {
      return true;
    }
  }

  function recentGesture() {
    try {
      const ts = Number(document.documentElement?.getAttribute('data-goojara-gesture') || 0);
      return ts > 0 && Date.now() - ts < 8000;
    } catch {
      return false;
    }
  }

  function hostOf(url) {
    try {
      return new URL(String(url), location.href).hostname;
    } catch {
      return '';
    }
  }

  function isGoojaraOrMedia(url) {
    if (url == null) return false;
    const href = String(url);
    if (href.startsWith('blob:')) return true;
    try {
      const u = new URL(href, location.href);
      if (GOOJARA_RE.test(u.hostname)) return true;
      if (MEDIA_RE.test(u.pathname) || MEDIA_RE.test(href)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function isAdUrl(url) {
    if (!url) return false;
    const href = String(url);
    if (!href || href === 'about:blank') return true; // treat blank as popup bait
    return AD_HOST_RE.test(href) || AD_HOST_RE.test(hostOf(href));
  }

  function block(kind, url) {
    window.dispatchEvent(
      new CustomEvent('goojara-shield', { detail: { kind, url: url ? String(url) : '' } })
    );
  }

  window.open = function guardedOpen(url, target, features) {
    if (!shieldOn()) return nativeOpen(url, target, features);

    const href = url == null ? '' : String(url);

    // Classic popunder seed
    if (!href || href === 'about:blank') {
      block('popup', href || 'about:blank');
      return null;
    }

    if (isAdUrl(href)) {
      block('popup', href);
      return null;
    }

    if (isGoojaraOrMedia(href)) {
      return nativeOpen(url, target, features);
    }

    // Play click often needs a short-lived open to a stream host.
    // Allow only right after a user gesture; SW still closes pure ad tabs.
    if (recentGesture()) {
      return nativeOpen(url, target, features);
    }

    block('popup', href);
    return null;
  };

  // Only block assign/replace onto known ad hosts — never generic external URLs
  // (players may navigate/bootstrap onto CDN/embed hosts).
  try {
    const loc = window.location;
    const proto = Object.getPrototypeOf(loc);
    const descAssign = Object.getOwnPropertyDescriptor(proto, 'assign');
    const descReplace = Object.getOwnPropertyDescriptor(proto, 'replace');

    const guardNav = (nativeFn) =>
      function (url) {
        if (!shieldOn()) return nativeFn.call(loc, url);
        if (isAdUrl(url) && !isGoojaraOrMedia(url)) {
          block('redirect', url);
          return;
        }
        return nativeFn.call(loc, url);
      };

    if (descAssign?.configurable || descAssign?.writable) {
      loc.assign = guardNav(descAssign.value);
    }
    if (descReplace?.configurable || descReplace?.writable) {
      loc.replace = guardNav(descReplace.value);
    }
  } catch {
    /* ignore */
  }

  if (typeof Notification !== 'undefined') {
    try {
      Notification.requestPermission = function () {
        return Promise.resolve('denied');
      };
    } catch {
      /* ignore */
    }
  }

  const stopUnload = (e) => {
    if (!shieldOn()) return;
    e.stopImmediatePropagation();
  };
  window.addEventListener('beforeunload', stopUnload, true);

  try {
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true,
      get() {
        return null;
      },
      set() {
        /* swallow */
      }
    });
  } catch {
    /* ignore */
  }
})();
