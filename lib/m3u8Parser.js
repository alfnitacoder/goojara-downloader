/**
 * Lightweight HLS/M3U8 playlist parser (master + media playlists).
 * Supports AES-128 EXT-X-KEY extraction.
 */

export function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

/**
 * @typedef {Object} HlsVariant
 * @property {string} url
 * @property {number|null} bandwidth
 * @property {string|null} resolution
 * @property {string|null} name
 * @property {number|null} width
 * @property {number|null} height
 */

/**
 * @typedef {Object} HlsSegment
 * @property {string} url
 * @property {number} duration
 * @property {number} sequence
 * @property {{ method: string, uri: string, iv: Uint8Array|null }|null} key
 * @property {number|null} byteRangeStart
 * @property {number|null} byteRangeLength
 */

/**
 * @typedef {Object} ParsedPlaylist
 * @property {'master'|'media'} kind
 * @property {HlsVariant[]} variants
 * @property {HlsSegment[]} segments
 * @property {number} targetDuration
 * @property {number} mediaSequence
 * @property {boolean} endList
 * @property {{ method: string, uri: string, iv: Uint8Array|null }|null} key
 */

function parseAttrList(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/gi;
  let m;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1].toUpperCase()] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function sequenceIv(seq) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, seq >>> 0, false);
  return iv;
}

/**
 * Parse an M3U8 playlist text into a structured object.
 * @param {string} text
 * @param {string} baseUrl
 * @returns {ParsedPlaylist}
 */
export function parseM3U8(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines[0]?.startsWith('#EXTM3U')) {
    throw new Error('Not a valid M3U8 playlist');
  }

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) {
    return parseMaster(lines, baseUrl);
  }
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  /** @type {HlsVariant[]} */
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttrList(line.slice('#EXT-X-STREAM-INF:'.length));
    const next = lines[i + 1];
    if (!next || next.startsWith('#')) continue;
    const res = attrs.RESOLUTION || null;
    let width = null;
    let height = null;
    if (res && res.includes('x')) {
      const [w, h] = res.split('x').map(Number);
      width = w;
      height = h;
    }
    variants.push({
      url: resolveUrl(baseUrl, next),
      bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null,
      resolution: res,
      name: attrs.NAME || (res ? `${res}` : null),
      width,
      height
    });
    i++;
  }
  variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  return {
    kind: 'master',
    variants,
    segments: [],
    targetDuration: 0,
    mediaSequence: 0,
    endList: true,
    key: null
  };
}

function parseMedia(lines, baseUrl) {
  /** @type {HlsSegment[]} */
  const segments = [];
  let mediaSequence = 0;
  let targetDuration = 0;
  let endList = false;
  /** @type {{ method: string, uri: string, iv: Uint8Array|null }|null} */
  let currentKey = null;
  let pendingDuration = 0;
  let pendingByteRange = null;
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]);
      seq = mediaSequence;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttrList(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
          iv: attrs.IV ? hexToBytes(attrs.IV) : null
        };
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const parts = line.split(':')[1].split('@');
      pendingByteRange = {
        length: Number(parts[0]),
        start: parts[1] !== undefined ? Number(parts[1]) : null
      };
    } else if (line.startsWith('#EXTINF:')) {
      const durStr = line.slice('#EXTINF:'.length).split(',')[0];
      pendingDuration = Number(durStr) || 0;
    } else if (!line.startsWith('#')) {
      const key = currentKey
        ? {
            method: currentKey.method,
            uri: currentKey.uri,
            iv: currentKey.iv || sequenceIv(seq)
          }
        : null;
      segments.push({
        url: resolveUrl(baseUrl, line),
        duration: pendingDuration,
        sequence: seq,
        key,
        byteRangeStart: pendingByteRange?.start ?? null,
        byteRangeLength: pendingByteRange?.length ?? null
      });
      seq++;
      pendingDuration = 0;
      pendingByteRange = null;
    }
  }

  return {
    kind: 'media',
    variants: [],
    segments,
    targetDuration,
    mediaSequence,
    endList,
    key: currentKey
  };
}

/**
 * Guess a friendly quality label from a variant or media URL.
 */
export function qualityLabel(variantOrUrl) {
  if (variantOrUrl && typeof variantOrUrl === 'object') {
    if (variantOrUrl.resolution) return variantOrUrl.resolution;
    if (variantOrUrl.height) return `${variantOrUrl.height}p`;
    if (variantOrUrl.bandwidth) return `${Math.round(variantOrUrl.bandwidth / 1000)}kbps`;
  }
  const url = String(variantOrUrl || '');
  const m = url.match(/(\d{3,4})p/i) || url.match(/[_-](\d{3,4})[_./?]/i);
  if (m) return `${m[1]}p`;
  return 'Auto';
}
