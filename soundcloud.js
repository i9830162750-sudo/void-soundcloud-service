'use strict';

/**
 * soundcloud.js
 * Talks to the SoundCloud public API using your client_id.
 *
 * All public SoundCloud tracks have a transcoding endpoint that returns
 * a direct HLS or progressive MP3 stream URL — no scraping needed.
 *
 * Set SOUNDCLOUD_CLIENT_ID in your .env / Render environment variables.
 */

const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID || '';

// ── In-memory cache (5 min TTL) ───────────────────────────────────────────────
const cache    = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── Base fetch helper ─────────────────────────────────────────────────────────
async function scFetch(path, params = {}) {
  if (!CLIENT_ID) throw new Error('SOUNDCLOUD_CLIENT_ID is not set');

  const url = new URL(`https://api-v2.soundcloud.com${path}`);
  url.searchParams.set('client_id', CLIENT_ID);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Origin': 'https://soundcloud.com',
      'Referer': 'https://soundcloud.com/',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SoundCloud API ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

// ── Parse a raw SC track object into our unified format ───────────────────────
function parseTrack(t) {
  // Thumbnail — prefer 500x500, fallback to original
  const artUrl = (t.artwork_url || t.user?.avatar_url || '')
    .replace('-large', '-t500x500');

  // Duration from SC is in milliseconds
  const duration = Math.round((t.duration || 0) / 1000);

  return {
    id:        String(t.id),
    videoId:   String(t.id),   // unified field name VOID uses
    title:     t.title || 'Unknown',
    artist:    t.user?.username || t.publisher_metadata?.artist || 'Unknown',
    album:     t.publisher_metadata?.album_title || '',
    duration,
    thumbnail: artUrl,
    source:    'soundcloud',
    permalink: t.permalink_url || '',
  };
}

// ── Exported: search ──────────────────────────────────────────────────────────
exports.search = async function search(query, limit = 15) {
  const cacheKey = `sc_search:${query}:${limit}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await scFetch('/search/tracks', {
    q:            query,
    limit,
    offset:       0,
    linked_partitioning: 1,
  });

  const tracks = (data.collection || [])
    .filter(t => t.streamable !== false && t.policy !== 'BLOCK')
    .map(parseTrack);

  cacheSet(cacheKey, tracks);
  return tracks;
};

// ── Exported: getStreamUrl ────────────────────────────────────────────────────
// Returns { url, mimeType } — same contract as the JioSaavn /stream endpoint.
exports.getStreamUrl = async function getStreamUrl(trackId) {
  const cacheKey = `sc_stream:${trackId}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  // 1. Fetch track details to get transcodings list
  const track = await scFetch(`/tracks/${trackId}`);

  if (!track.streamable) throw new Error('Track is not streamable');

  const transcodings = track.media?.transcodings || [];
  if (!transcodings.length) throw new Error('No transcodings available');

  // 2. Prefer progressive MP3 over HLS (simpler for direct <audio> playback)
  let tc = transcodings.find(
    t => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg')
  );
  // Fallback: any progressive
  if (!tc) tc = transcodings.find(t => t.format?.protocol === 'progressive');
  // Fallback: HLS
  if (!tc) tc = transcodings.find(t => t.format?.protocol === 'hls');
  // Last resort: first available
  if (!tc) tc = transcodings[0];

  // 3. Resolve the actual stream URL (SC gives a signed URL that expires)
  const resolveRes = await fetch(
    `${tc.url}?client_id=${CLIENT_ID}`,
    {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Origin':  'https://soundcloud.com',
        'Referer': 'https://soundcloud.com/',
      },
    }
  );
  if (!resolveRes.ok) throw new Error(`Transcoding resolve failed: ${resolveRes.status}`);

  const { url } = await resolveRes.json();
  if (!url) throw new Error('Empty stream URL from SoundCloud');

  const mimeType = tc.format?.mime_type || 'audio/mpeg';
  const result   = { url, mimeType };

  // Cache for 4 min (SC signed URLs expire ~5 min)
  cache.set(cacheKey, { data: result, ts: Date.now() - (CACHE_TTL - 4 * 60 * 1000) });
  return result;
};
