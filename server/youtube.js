'use strict';

// youtube.js — YouTube Data API v3, normalização para o shape Video,
// pipeline de filtragem (canais / vídeos / keywords) e modo mock.

const store = require('./store');
const mockdata = require('./mockdata');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// Paginação: o YouTube devolve no máximo 50 itens por página. Buscamos páginas
// sucessivas (via nextPageToken) até termos tantos resultados sobreviventes ao
// filtro de bloqueio quanto os que o YouTube mostra normalmente, ou até acabarem
// as páginas / atingirmos o teto (para não estourar a quota da API).
const PAGE_SIZE = 50;
const TARGET_RESULTS = 30;
const MAX_PAGES = 4;

// A home usa primeiro o chart "mostPopular" (o mesmo que o YouTube mostra na
// sua própria home). Esse chart tem um teto por região (tipicamente ~200
// vídeos) — quando se esgota, a home passa a rodar ciclicamente por estes
// temas via search.list, para nunca ficar sem vídeos novos ao dar scroll.
const HOME_SEED_QUERIES = [
  'música', 'desenhos animados', 'jogos', 'ciência', 'esportes',
  'natureza', 'culinária', 'humor', 'tecnologia', 'viagens',
];

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
  const tags = Array.isArray(video.tags) ? video.tags.join('\n') : '';
  const haystack = normalize(
    `${video.title}\n${video.description || ''}\n${video.channelTitle}\n${tags}`,
  );
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
    // Tags do YouTube (metadado interno do uploader) — só existe em snippet de
    // videos.list, nunca em search.list/playlistItems.list; por isso o enrich()
    // é essencial para filtrar por tema mesmo quando o termo não está no título.
    tags: snippet?.tags || null,
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

// Remove campos internos (usados só para filtragem) antes de responder ao cliente.
function stripDescription(v) {
  const { description, tags, ...rest } = v;
  return rest;
}

// ---------- Operações públicas (mock-aware; TODAS filtradas) ----------

async function home(pageToken) {
  if (usingMock()) {
    return { items: filterVideos(mockdata.VIDEOS.slice()).map(stripDescription), nextPageToken: null };
  }

  // Fase 1: chart=mostPopular (o mesmo catálogo que a home do YouTube usa).
  if (!pageToken || pageToken.startsWith('mp:')) {
    let token = pageToken ? pageToken.slice(3) || undefined : undefined;
    let videos = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await apiGet('/videos', {
        part: 'snippet,contentDetails,statistics',
        chart: 'mostPopular',
        maxResults: PAGE_SIZE,
        pageToken: token,
      });
      videos = videos.concat((data.items || []).map((it) => videoFromSnippet(it.id, it.snippet, it)));
      token = data.nextPageToken || null;
      const survivors = videos.filter((v) => !isBlocked(v)).length;
      if (!token || survivors >= TARGET_RESULTS) break;
    }
    if (token) {
      return { items: filterVideos(videos).map(stripDescription), nextPageToken: `mp:${token}` };
    }
    // O chart esgotou-se (teto da API por região) — passa à rotação de temas,
    // que nunca acaba: ao esgotar um termo avança para o seguinte, ciclicamente.
    const result = await search(HOME_SEED_QUERIES[0], undefined);
    const nextPageToken = result.nextPageToken
      ? `sr:0:${result.nextPageToken}`
      : `sr:${1 % HOME_SEED_QUERIES.length}:`;
    return { items: result.items, nextPageToken };
  }

  // Fase 2: rotação cíclica de buscas por tema.
  const m = /^sr:(\d+):(.*)$/.exec(pageToken);
  const idx = m ? Number(m[1]) % HOME_SEED_QUERIES.length : 0;
  const seedToken = m && m[2] ? m[2] : undefined;
  const result = await search(HOME_SEED_QUERIES[idx], seedToken);
  const nextPageToken = result.nextPageToken
    ? `sr:${idx}:${result.nextPageToken}`
    : `sr:${(idx + 1) % HOME_SEED_QUERIES.length}:`;
  return { items: result.items, nextPageToken };
}

async function search(q, pageToken) {
  if (isQueryBlocked(q)) return { blockedQuery: true, items: [], nextPageToken: null };
  const cfg = store.getConfig();
  let videos;
  let nextPageToken = null;
  if (usingMock()) {
    const nq = normalize(q);
    videos = mockdata.VIDEOS.filter((v) =>
      normalize(`${v.title}\n${v.description}\n${v.channelTitle}`).includes(nq),
    );
  } else {
    videos = [];
    let token = pageToken || undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await apiGet('/search', {
        part: 'snippet',
        type: 'video',
        q,
        maxResults: PAGE_SIZE,
        safeSearch: cfg.safeSearch,
        pageToken: token,
      });
      const pageVideos = (data.items || [])
        .filter((it) => it.id?.videoId)
        .map((it) => videoFromSnippet(it.id.videoId, it.snippet, null));
      videos = videos.concat(await enrich(pageVideos));
      token = data.nextPageToken || null;
      const survivors = videos.filter((v) => !isBlocked(v)).length;
      if (!token || survivors >= TARGET_RESULTS) break;
    }
    nextPageToken = token || null;
  }
  return { blockedQuery: false, items: filterVideos(videos).map(stripDescription), nextPageToken };
}

// Pesquisa de canais por nome/@handle (para a administração escolher qual bloquear).
async function searchChannels(q) {
  const query = String(q || '').trim();
  if (!query) return { items: [] };
  if (usingMock()) {
    const nq = normalize(query);
    return { items: mockdata.CHANNELS.filter((c) => normalize(c.title).includes(nq)) };
  }
  const data = await apiGet('/search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: 6,
  });
  return {
    items: (data.items || [])
      .filter((it) => it.id?.channelId)
      .map((it) => ({
        id: it.id.channelId,
        title: it.snippet?.channelTitle || it.snippet?.title || '',
      })),
  };
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
    related = (await channelUploads(video.channelId)).videos;
  } catch {
    related = [];
  }
  related = filterVideos(related.filter((v) => v.id !== id)).map(stripDescription);
  return { video: stripDescription(video), blocked: false, related };
}

async function channelUploads(channelId, pageToken) {
  if (usingMock()) {
    return { videos: mockdata.VIDEOS.filter((v) => v.channelId === channelId), nextPageToken: null };
  }
  const ch = await apiGet('/channels', { part: 'contentDetails', id: channelId });
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { videos: [], nextPageToken: null };
  let videos = [];
  let token = pageToken || undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pl = await apiGet('/playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploads,
      maxResults: PAGE_SIZE,
      pageToken: token,
    });
    const pageVideos = (pl.items || [])
      .filter((it) => it.contentDetails?.videoId)
      .map((it) => videoFromSnippet(it.contentDetails.videoId, it.snippet, null))
      .map((v) => ({ ...v, channelId })); // snippet de playlistItems traz channelId do dono da playlist
    videos = videos.concat(await enrich(pageVideos));
    token = pl.nextPageToken || null;
    const survivors = videos.filter((v) => !isBlocked(v)).length;
    if (!token || survivors >= TARGET_RESULTS) break;
  }
  return { videos, nextPageToken: token || null };
}

async function channel(channelId, pageToken) {
  if (isChannelBlocked(channelId)) {
    return { channel: { id: channelId, title: '' }, items: [], blocked: true, nextPageToken: null };
  }
  let info = { id: channelId, title: '' };
  if (usingMock()) {
    info.title = mockdata.CHANNELS.find((c) => c.id === channelId)?.title || '';
  } else {
    const ch = await apiGet('/channels', { part: 'snippet,statistics', id: channelId });
    const item = ch.items?.[0];
    const sn = item?.snippet;
    const st = item?.statistics;
    info = {
      id: channelId,
      title: sn?.title || '',
      description: sn?.description || '',
      thumbnail: sn?.thumbnails?.medium?.url || sn?.thumbnails?.default?.url || '',
      subscriberCount: st?.hiddenSubscriberCount ? null : (st?.subscriberCount ?? null),
      videoCount: st?.videoCount ?? null,
    };
  }
  const { videos, nextPageToken } = await channelUploads(channelId, pageToken);
  const items = filterVideos(videos).map(stripDescription);
  return { channel: info, items, blocked: false, nextPageToken };
}

module.exports = {
  usingMock,
  normalize,
  isoDuration,
  home,
  search,
  searchChannels,
  videoDetails,
  channel,
};
