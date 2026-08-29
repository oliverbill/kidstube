'use strict';

// youtube.js — YouTube Data API v3, normalização para o shape Video,
// pipeline de filtragem (canais / vídeos / keywords) e modo mock.

const store = require('./store');
const mockdata = require('./mockdata');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// ---------- Cache em memória (10 min, chave = url) para poupar quota ----------

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // url -> { at, data }

async function apiGet(pathname, params) {
  const cfg = store.getConfig();
  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', cfg.apiKey);
  const key = url.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const res = await fetch(key);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `YouTube API ${res.status}`;
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }
  cache.set(key, { at: Date.now(), data });
  // Limpeza ocasional de entradas expiradas.
  if (cache.size > 200) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
  }
  return data;
}

// ---------- Normalização / filtragem ----------

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "");
}

function isBlocked(video) {
  const { blocked } = store.getConfig();
  if (blocked.channels.some((c) => c.id === video.channelId)) return true;
  if (blocked.videos.some((v) => v.id === video.id)) return true;
  const haystack = normalize(`${video.title}\n${video.description || ''}\n${video.channelTitle}`);
  return blocked.keywords.some((kw) => haystack.includes(normalize(kw)));
}

function filterVideos(videos) {
  return videos.filter((v) => !isBlocked(v));
}

function isQueryBlocked(q) {
  const { blocked } = store.getConfig();
  const nq = normalize(q);
  return blocked.keywords.some((kw) => nq.includes(normalize(kw)));
}

function isChannelBlocked(channelId) {
  const { blocked } = store.getConfig();
  return blocked.channels.some((c) => c.id === channelId);
}

// ---------- Utilitários de normalização de shape ----------

// PT1H2M3S → "1:02:03"; PT12M34S → "12:34"; PT45S → "0:45"
function isoDuration(iso) {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${ss}`;
  return `${min}:${ss}`;
}

function videoFromSnippet(id, snippet, details) {
  return {
    id,
    title: snippet?.title || '',
    description: snippet?.description || '',
    channelId: snippet?.channelId || '',
    channelTitle: snippet?.channelTitle || '',
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    duration: details ? isoDuration(details.contentDetails?.duration) : null,
    publishedAt: snippet?.publishedAt || null,
    views: details ? (details.statistics?.viewCount ?? null) : null,
  };
}

// Batch videos.list para preencher duration/views (e descrição completa).
async function enrich(videos) {
  if (videos.length === 0) return videos;
  const byId = new Map();
  for (let i = 0; i < videos.length; i += 50) {
    const ids = videos.slice(i, i + 50).map((v) => v.id).join(',');
    const data = await apiGet('/videos', {
      part: 'snippet,contentDetails,statistics',
      id: ids,
      maxResults: 50,
    });
    for (const item of data.items || []) byId.set(item.id, item);
  }
  return videos.map((v) => {
    const item = byId.get(v.id);
    if (!item) return v;
    return videoFromSnippet(v.id, item.snippet, item);
  });
}

// ---------- Modo mock ----------

function usingMock() {
  return !store.getConfig().apiKey;
}

function stripDescription(v) {
  const { description, ...rest } = v;
  return rest;
}

// ---------- Operações públicas (mock-aware; TODAS filtradas) ----------

async function home() {
  const cfg = store.getConfig();
  let videos;
  if (usingMock()) {
    videos = mockdata.VIDEOS.slice();
  } else {
    const data = await apiGet('/videos', {
      part: 'snippet,contentDetails,statistics',
      chart: 'mostPopular',
      maxResults: 30,
    });
    videos = (data.items || []).map((it) => videoFromSnippet(it.id, it.snippet, it));
  }
  return filterVideos(videos).map(stripDescription);
}

async function search(q) {
  if (isQueryBlocked(q)) return { blockedQuery: true, items: [] };
  const cfg = store.getConfig();
  let videos;
  if (usingMock()) {
    const nq = normalize(q);
    videos = mockdata.VIDEOS.filter((v) =>
      normalize(`${v.title}\n${v.description}\n${v.channelTitle}`).includes(nq),
    );
  } else {
    const data = await apiGet('/search', {
      part: 'snippet',
      type: 'video',
      q,
      maxResults: 25,
      safeSearch: cfg.safeSearch,
    });
    videos = (data.items || [])
      .filter((it) => it.id?.videoId)
      .map((it) => videoFromSnippet(it.id.videoId, it.snippet, null));
    videos = await enrich(videos);
  }
  return { blockedQuery: false, items: filterVideos(videos).map(stripDescription) };
}

async function videoDetails(id) {
  let video = null;
  if (usingMock()) {
    video = mockdata.VIDEOS.find((v) => v.id === id) || null;
  } else {
    const data = await apiGet('/videos', {
      part: 'snippet,contentDetails,statistics',
      id,
    });
    const item = (data.items || [])[0];
    if (item) video = videoFromSnippet(item.id, item.snippet, item);
  }
  if (!video) return { video: null, blocked: false, related: [] };
  if (isBlocked(video)) return { video: null, blocked: true, related: [] };

  // Relacionados: outros vídeos do MESMO canal (playlist de uploads), filtrados.
  let related = [];
  try {
    related = await channelUploads(video.channelId);
  } catch {
    related = [];
  }
  related = filterVideos(related.filter((v) => v.id !== id)).map(stripDescription);
  return { video: stripDescription(video), blocked: false, related };
}

async function channelUploads(channelId) {
  if (usingMock()) {
    return mockdata.VIDEOS.filter((v) => v.channelId === channelId);
  }
  const ch = await apiGet('/channels', { part: 'contentDetails', id: channelId });
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const pl = await apiGet('/playlistItems', {
    part: 'snippet,contentDetails',
    playlistId: uploads,
    maxResults: 25,
  });
  let videos = (pl.items || [])
    .filter((it) => it.contentDetails?.videoId)
    .map((it) => videoFromSnippet(it.contentDetails.videoId, it.snippet, null))
    .map((v) => ({ ...v, channelId })); // snippet de playlistItems traz channelId do dono da playlist
  return enrich(videos);
}

async function channel(channelId) {
  if (isChannelBlocked(channelId)) {
    return { channel: { id: channelId, title: '' }, items: [], blocked: true };
  }
  let title = '';
  if (usingMock()) {
    title = mockdata.CHANNELS.find((c) => c.id === channelId)?.title || '';
  } else {
    const ch = await apiGet('/channels', { part: 'snippet', id: channelId });
    title = ch.items?.[0]?.snippet?.title || '';
  }
  const items = filterVideos(await channelUploads(channelId)).map(stripDescription);
  return { channel: { id: channelId, title }, items, blocked: false };
}

module.exports = {
  usingMock,
  normalize,
  isoDuration,
  home,
  search,
  videoDetails,
  channel,
};
