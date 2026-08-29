'use strict';

// static-api.js — SÓ EXISTE NA VARIANTE ESTÁTICA (GitHub Pages, sem servidor).
//
// Shim que corre no browser, carregado ANTES de app.js/admin.js. Substitui
// window.fetch para intercetar qualquer pedido cujo pathname contenha /api/
// e implementa TODA a API do SPEC no cliente, devolvendo objetos Response
// sintéticos com os mesmos status/shapes do backend Node. Pedidos que não
// sejam /api/ passam para o fetch original.
//
// - Config em localStorage (chave "kidtube-config"), mesmos defaults do store.js.
// - PIN: SHA-256 hex via crypto.subtle (em vez de scrypt — não há scrypt no browser).
// - Sem apiKey → modo mock (catálogo de server/mockdata.js, thumbnails em data URI SVG).
// - Com apiKey → YouTube Data API v3 diretamente do browser (suporta CORS).
// - Bloqueios (canais/temas/vídeos) NÃO são locais: vêm de blocklist.json no GitHub,
//   partilhado por todos os dispositivos. O painel admin.js grava lá diretamente via
//   API do GitHub (usa um token próprio, guardado só no localStorage desse aparelho).

(() => {
  window.__KIDTUBE_STATIC__ = true; // admin.js usa isto para saber que fala com este shim.

  const originalFetch = window.fetch.bind(window);

  // ---------- Config em localStorage ----------

  const STORAGE_KEY = 'kidtube-config';

  // Chave fixa injetada no deploy: o workflow do GitHub Actions substitui o
  // placeholder pelo secret YOUTUBE_API_KEY. No repo fica só o placeholder.
  const INJECTED_API_KEY_TOKEN = '__KIDTUBE_API_KEY__';
  const INJECTED_API_KEY = /^__KIDTUBE/.test(INJECTED_API_KEY_TOKEN) ? '' : INJECTED_API_KEY_TOKEN;

  // A chave colada na administração (localStorage) tem prioridade sobre a injetada.
  function effectiveApiKey(cfg) {
    return cfg.apiKey || INJECTED_API_KEY;
  }

  const DEFAULTS = {
    apiKey: '',
    pinHash: null, // SHA-256 hex; null = PIN ainda não definido
    safeSearch: 'strict',
  };

  function deepMergeDefaults(cfg) {
    return { ...DEFAULTS, ...cfg };
  }

  function getConfig() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      raw = null;
    }
    return deepMergeDefaults(raw || {});
  }

  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  // ---------- PIN (SHA-256 hex) + rate-limit em memória ----------

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const RATE = { failures: 0, lockedUntil: 0 };
  const MAX_FAILURES = 5;
  const LOCK_MS = 60_000;

  function pinLockedForMs() {
    const left = RATE.lockedUntil - Date.now();
    return left > 0 ? left : 0;
  }

  function registerFailure() {
    RATE.failures += 1;
    if (RATE.failures >= MAX_FAILURES) {
      RATE.lockedUntil = Date.now() + LOCK_MS;
      RATE.failures = 0;
      return 'locked';
    }
    return 'bad';
  }

  // Devolve: 'ok' | 'bad' | 'locked'
  async function verifyPin(pin) {
    if (pinLockedForMs() > 0) return 'locked';
    const cfg = getConfig();
    if (cfg.pinHash === null || pin === undefined || pin === null || pin === '') {
      return registerFailure();
    }
    if ((await sha256Hex(pin)) === cfg.pinHash) {
      RATE.failures = 0;
      return 'ok';
    }
    return registerFailure();
  }

  // ---------- Dados mock (cópia de server/mockdata.js, thumbnails em data URI) ----------

  const MOCK_CHANNELS = [
    { id: 'mockch-a', title: 'Desenhos do Zé' },
    { id: 'mockch-b', title: 'Ciência Divertida' },
    { id: 'mockch-c', title: 'Mundo dos Jogos' },
    { id: 'mockch-d', title: 'Cantigas da Rita' },
  ];

  const MOCK_COLORS = {
    'mockch-a': '#7c3aed',
    'mockch-b': '#0e7490',
    'mockch-c': '#b45309',
    'mockch-d': '#be185d',
  };

  function mockThumb(channelId, title) {
    const short = title.length > 26 ? title.slice(0, 25) + '…' : title;
    const color = MOCK_COLORS[channelId] || '#374151';
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">` +
      `<rect width="320" height="180" fill="${color}"/>` +
      `<circle cx="160" cy="76" r="30" fill="rgba(255,255,255,0.25)"/>` +
      `<path d="M150 60 L178 76 L150 92 Z" fill="#fff"/>` +
      `<text x="160" y="150" font-family="sans-serif" font-size="16" fill="#fff" text-anchor="middle">${short
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</text>` +
      `</svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function mv(id, chIdx, title, description, duration, publishedAt, views) {
    const ch = MOCK_CHANNELS[chIdx];
    return {
      id,
      title,
      description,
      channelId: ch.id,
      channelTitle: ch.title,
      thumbnail: mockThumb(ch.id, title),
      duration,
      publishedAt,
      views,
    };
  }

  const MOCK_VIDEOS = [
    // mockch-a — Desenhos do Zé
    mv('mock-001', 0, 'O Dragão que Não Sabia Voar', 'Um desenho animado sobre um dragão pequenino e os seus amigos.', '7:12', '2026-06-01T10:00:00Z', '154302'),
    mv('mock-002', 0, 'A Floresta Encantada — Episódio 1', 'Aventuras na floresta encantada com o Zé e a raposa Rufia.', '11:05', '2026-06-08T10:00:00Z', '98211'),
    mv('mock-003', 0, 'O Comboio das Cores', 'Aprende as cores com o comboio mais divertido de sempre.', '5:44', '2026-06-15T10:00:00Z', '203118'),
    mv('mock-004', 0, 'A Princesa e o Robô', 'Uma princesa constrói um robô para a ajudar no castelo.', '9:30', '2026-06-22T10:00:00Z', '87654'),
    mv('mock-005', 0, 'O Gato Aventureiro vai à Lua', 'O gato aventureiro constrói um foguetão de cartão.', '8:18', '2026-07-01T10:00:00Z', '312450'),
    // mockch-b — Ciência Divertida
    mv('mock-006', 1, 'Porque é que o céu é azul?', 'Ciência para crianças: a luz do sol e a atmosfera explicadas de forma simples.', '6:02', '2026-05-20T14:00:00Z', '441209'),
    mv('mock-007', 1, 'Experiência: vulcão de bicarbonato', 'Faz um vulcão em casa com bicarbonato e vinagre. Ciência divertida!', '10:41', '2026-05-27T14:00:00Z', '765310'),
    mv('mock-008', 1, 'Os planetas do Sistema Solar', 'Viagem pelos oito planetas, do Mercúrio a Neptuno.', '12:34', '2026-06-03T14:00:00Z', '1234567'),
    mv('mock-009', 1, 'Como funcionam os ímanes?', 'Magnetismo explicado com experiências simples e seguras.', '7:55', '2026-06-10T14:00:00Z', '98077'),
    mv('mock-010', 1, 'Dinossauros: gigantes do passado', 'Tudo sobre os dinossauros mais incríveis que já existiram.', '13:20', '2026-06-17T14:00:00Z', '654321'),
    // mockch-c — Mundo dos Jogos
    mv('mock-011', 2, 'Construímos um castelo gigante no Minecraft', 'Gameplay calmo de construção de um castelo bloco a bloco.', '15:47', '2026-07-05T16:00:00Z', '523009'),
    mv('mock-012', 2, 'Corrida maluca de karts — quem ganha?', 'Torneio de karts com muitas gargalhadas.', '12:03', '2026-07-12T16:00:00Z', '287640'),
    mv('mock-013', 2, 'Puzzle impossível resolvido em 10 minutos', 'Resolvemos o puzzle mais difícil do jogo das caixas.', '10:12', '2026-07-19T16:00:00Z', '134982'),
    mv('mock-014', 2, 'Aventura na ilha dos piratas (jogo de plataformas)', 'Exploramos a ilha dos piratas neste jogo de plataformas fofinho.', '14:28', '2026-07-26T16:00:00Z', '76210'),
    mv('mock-015', 2, 'Quinta feliz: a nossa horta virtual', 'Plantamos cenouras e cuidamos das galinhas no jogo da quinta.', '11:36', '2026-08-02T16:00:00Z', '45330'),
    // mockch-d — Cantigas da Rita
    mv('mock-016', 3, 'A Canção do Abecedário', 'Aprende as letras a cantar com a Rita.', '3:12', '2026-04-10T09:00:00Z', '2103450'),
    mv('mock-017', 3, 'Os Números até Dez (música infantil)', 'Conta até dez com esta música cheia de ritmo.', '2:58', '2026-04-17T09:00:00Z', '1876540'),
    mv('mock-018', 3, 'Roda Roda Carrossel', 'Uma cantiga de roda para dançar em família.', '3:45', '2026-04-24T09:00:00Z', '954120'),
    mv('mock-019', 3, 'A Banda dos Animais', 'Cada animal toca um instrumento nesta canção divertida.', '4:21', '2026-05-01T09:00:00Z', '673201'),
    mv('mock-020', 3, 'Boa Noite, Estrelinha (canção de embalar)', 'Uma canção suave para adormecer.', '5:03', '2026-05-08T09:00:00Z', '1450998'),
  ];

  // ---------- Bloqueio centralizado (blocklist.json no GitHub, partilhado) ----------

  const BLOCKLIST_OWNER = 'oliverbill';
  const BLOCKLIST_REPO = 'youtube-filter';
  const BLOCKLIST_BRANCH = 'main';
  const BLOCKLIST_URL =
    `https://raw.githubusercontent.com/${BLOCKLIST_OWNER}/${BLOCKLIST_REPO}/${BLOCKLIST_BRANCH}/blocklist.json`;
  const BLOCKLIST_TTL_MS = 5 * 60 * 1000;
  const BLOCKLIST_CACHE_KEY = 'kidtube-blocklist-cache';
  const EMPTY_BLOCKLIST = { channels: [], keywords: [], videos: [] };

  let blocklistMem = null; // { at, data }

  function normalizeBlocklistShape(data) {
    return {
      channels: Array.isArray(data?.channels) ? data.channels : [],
      keywords: Array.isArray(data?.keywords) ? data.keywords : [],
      videos: Array.isArray(data?.videos) ? data.videos : [],
    };
  }

  function readBlocklistCacheFromStorage() {
    try {
      const raw = JSON.parse(localStorage.getItem(BLOCKLIST_CACHE_KEY));
      if (raw?.data) return raw;
    } catch { /* ignora cache corrompida */ }
    return null;
  }

  function writeBlocklistCacheToStorage(data) {
    try {
      localStorage.setItem(BLOCKLIST_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
    } catch { /* localStorage indisponível/cheio: cache fica só em memória */ }
  }

  // Lê blocklist.json diretamente do GitHub (raw, público, sem autenticação, com
  // CORS). Cache em memória de 5 min; se a rede falhar usa o último valor
  // conhecido (memória ou localStorage) em vez de abrir tudo silenciosamente.
  async function getBlocklist() {
    if (blocklistMem && Date.now() - blocklistMem.at < BLOCKLIST_TTL_MS) return blocklistMem.data;
    try {
      const res = await originalFetch(BLOCKLIST_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`blocklist.json ${res.status}`);
      const data = normalizeBlocklistShape(await res.json());
      blocklistMem = { at: Date.now(), data };
      writeBlocklistCacheToStorage(data);
      return data;
    } catch {
      const fallback = blocklistMem?.data ? blocklistMem : readBlocklistCacheFromStorage();
      if (fallback) {
        blocklistMem = { at: Date.now(), data: fallback.data };
        return fallback.data;
      }
      return EMPTY_BLOCKLIST;
    }
  }

  // ---------- Normalização / filtragem (idêntico a server/youtube.js) ----------

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function isBlocked(video, blocked) {
    if (blocked.channels.some((c) => c.id === video.channelId)) return true;
    if (blocked.videos.some((v) => v.id === video.id)) return true;
    const tags = Array.isArray(video.tags) ? video.tags.join('\n') : '';
    const haystack = normalize(
      `${video.title}\n${video.description || ''}\n${video.channelTitle}\n${tags}`,
    );
    return blocked.keywords.some((kw) => haystack.includes(normalize(kw)));
  }

  function filterVideos(videos, blocked) {
    return videos.filter((v) => !isBlocked(v, blocked));
  }

  function isQueryBlocked(q, blocked) {
    const nq = normalize(q);
    return blocked.keywords.some((kw) => nq.includes(normalize(kw)));
  }

  function isChannelBlocked(channelId, blocked) {
    return blocked.channels.some((c) => c.id === channelId);
  }

  // Remove campos internos (usados só para filtragem) antes de responder à app.
  function stripDescription(v) {
    const { description, tags, ...rest } = v;
    return rest;
  }

  // ---------- YouTube Data API v3 (direto do browser; suporta CORS) ----------

  const API_BASE = 'https://www.googleapis.com/youtube/v3';

  // Paginação: o YouTube devolve no máximo 50 itens por página. Buscamos páginas
  // sucessivas (via nextPageToken) até termos tantos resultados sobreviventes ao
  // filtro de bloqueio quanto os que o YouTube mostra normalmente, ou até acabarem
  // as páginas / atingirmos o teto (para não estourar a quota da API).
  const PAGE_SIZE = 50;
  const TARGET_RESULTS = 30;
  const MAX_PAGES = 4;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const cache = new Map(); // url -> { at, data }

  async function apiGet(pathname, params) {
    const cfg = getConfig();
    const url = new URL(API_BASE + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    url.searchParams.set('key', effectiveApiKey(cfg));
    const key = url.toString();

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

    const res = await originalFetch(key);
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error?.message || `YouTube API ${res.status}`;
      const err = new Error(msg);
      err.status = 502;
      throw err;
    }
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 200) {
      for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
    return data;
  }

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
      // Tags do YouTube (metadado do uploader) — só vêm em snippet de videos.list,
      // nunca em search.list/playlistItems.list; por isso o enrich() é essencial
      // para filtrar por tema mesmo quando o termo não está no título.
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

  // ---------- Operações públicas (mock-aware; TODAS filtradas) ----------

  // Pesquisa de canais por nome/@handle (para a administração escolher qual bloquear).
  async function searchChannels(q) {
    const query = String(q || '').trim();
    if (!query) return { items: [] };
    if (usingMock()) {
      const nq = normalize(query);
      return { items: MOCK_CHANNELS.filter((c) => normalize(c.title).includes(nq)) };
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

  function usingMock() {
    return !effectiveApiKey(getConfig());
  }

  async function home() {
    const cfg = getConfig();
    let videos;
    if (usingMock()) {
      videos = MOCK_VIDEOS.slice();
    } else {
      const data = await apiGet('/videos', {
        part: 'snippet,contentDetails,statistics',
        chart: 'mostPopular',
        maxResults: 30,
      });
      videos = (data.items || []).map((it) => videoFromSnippet(it.id, it.snippet, it));
    }
    const blocked = await getBlocklist();
    return filterVideos(videos, blocked).map(stripDescription);
  }

  async function search(q) {
    const blocked = await getBlocklist();
    if (isQueryBlocked(q, blocked)) return { blockedQuery: true, items: [] };
    const cfg = getConfig();
    let videos;
    if (usingMock()) {
      const nq = normalize(q);
      videos = MOCK_VIDEOS.filter((v) =>
        normalize(`${v.title}\n${v.description}\n${v.channelTitle}`).includes(nq),
      );
    } else {
      videos = [];
      let pageToken;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await apiGet('/search', {
          part: 'snippet',
          type: 'video',
          q,
          maxResults: PAGE_SIZE,
          safeSearch: cfg.safeSearch,
          pageToken,
        });
        const pageVideos = (data.items || [])
          .filter((it) => it.id?.videoId)
          .map((it) => videoFromSnippet(it.id.videoId, it.snippet, null));
        videos = videos.concat(await enrich(pageVideos));
        pageToken = data.nextPageToken;
        const survivors = videos.filter((v) => !isBlocked(v, blocked)).length;
        if (!pageToken || survivors >= TARGET_RESULTS) break;
      }
    }
    return { blockedQuery: false, items: filterVideos(videos, blocked).map(stripDescription) };
  }

  async function channelUploads(channelId) {
    if (usingMock()) {
      return MOCK_VIDEOS.filter((v) => v.channelId === channelId);
    }
    const ch = await apiGet('/channels', { part: 'contentDetails', id: channelId });
    const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    const blocked = await getBlocklist();
    let videos = [];
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const pl = await apiGet('/playlistItems', {
        part: 'snippet,contentDetails',
        playlistId: uploads,
        maxResults: PAGE_SIZE,
        pageToken,
      });
      const pageVideos = (pl.items || [])
        .filter((it) => it.contentDetails?.videoId)
        .map((it) => videoFromSnippet(it.contentDetails.videoId, it.snippet, null))
        .map((v) => ({ ...v, channelId })); // snippet de playlistItems traz channelId do dono da playlist
      videos = videos.concat(await enrich(pageVideos));
      pageToken = pl.nextPageToken;
      const survivors = videos.filter((v) => !isBlocked(v, blocked)).length;
      if (!pageToken || survivors >= TARGET_RESULTS) break;
    }
    return videos;
  }

  async function videoDetails(id) {
    let video = null;
    if (usingMock()) {
      video = MOCK_VIDEOS.find((v) => v.id === id) || null;
    } else {
      const data = await apiGet('/videos', {
        part: 'snippet,contentDetails,statistics',
        id,
      });
      const item = (data.items || [])[0];
      if (item) video = videoFromSnippet(item.id, item.snippet, item);
    }
    if (!video) return { video: null, blocked: false, related: [] };
    const blocked = await getBlocklist();
    if (isBlocked(video, blocked)) return { video: null, blocked: true, related: [] };

    // Relacionados: outros vídeos do MESMO canal (playlist de uploads), filtrados.
    let related = [];
    try {
      related = await channelUploads(video.channelId);
    } catch {
      related = [];
    }
    related = filterVideos(related.filter((v) => v.id !== id), blocked).map(stripDescription);
    return { video: stripDescription(video), blocked: false, related };
  }

  async function channel(channelId) {
    const blocked = await getBlocklist();
    if (isChannelBlocked(channelId, blocked)) {
      return { channel: { id: channelId, title: '' }, items: [], blocked: true };
    }
    let title = '';
    if (usingMock()) {
      title = MOCK_CHANNELS.find((c) => c.id === channelId)?.title || '';
    } else {
      const ch = await apiGet('/channels', { part: 'snippet', id: channelId });
      title = ch.items?.[0]?.snippet?.title || '';
    }
    const items = filterVideos(await channelUploads(channelId), blocked).map(stripDescription);
    return { channel: { id: channelId, title }, items, blocked: false };
  }

  // ---------- Mutadores de config (equivalentes ao store.js) ----------

  function setPin(pin) {
    return sha256Hex(pin).then((hash) => {
      const cfg = getConfig();
      cfg.pinHash = hash;
      saveConfig(cfg);
    });
  }

  function setApiKey(apiKey) {
    const cfg = getConfig();
    cfg.apiKey = String(apiKey || '');
    saveConfig(cfg);
  }

  // Mutações de bloqueio deixaram de existir aqui: admin.js grava diretamente
  // no blocklist.json do GitHub via API (ver ghReadBlocklist/ghWriteBlocklist
  // em admin.js), para o bloqueio valer em todos os dispositivos.

  // ---------- Router /api/ ----------

  function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function getHeader(input, init, name) {
    const lower = name.toLowerCase();
    const h = init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : null);
    if (!h) return null;
    if (typeof h.get === 'function') return h.get(name);
    for (const [k, v] of Object.entries(h)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  }

  async function getBody(input, init) {
    let raw = init?.body;
    if (raw === undefined && typeof Request !== 'undefined' && input instanceof Request) {
      try {
        raw = await input.clone().text();
      } catch {
        raw = undefined;
      }
    }
    if (raw === undefined || raw === null || raw === '') return {};
    if (typeof raw !== 'string') raw = String(raw);
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  // null se autorizado; Response de erro (401/429) caso contrário.
  async function requirePin(input, init) {
    const pin = getHeader(input, init, 'X-Pin');
    const result = await verifyPin(pin);
    if (result === 'ok') return null;
    if (result === 'locked') {
      return json({ error: 'Demasiadas tentativas. Tente novamente dentro de 60 segundos.' }, 429);
    }
    return json({ error: 'PIN inválido' }, 401);
  }

  async function handleApi(pathname, searchParams, method, input, init) {
    try {
      // ----- Público -----
      if (method === 'GET' && pathname === '/api/home') {
        return json({ items: await home() });
      }
      if (method === 'GET' && pathname === '/api/search') {
        const q = searchParams.get('q') || '';
        return json(await search(q));
      }
      let m;
      if (method === 'GET' && (m = /^\/api\/video\/([^/]+)$/.exec(pathname))) {
        return json(await videoDetails(decodeURIComponent(m[1])));
      }
      if (method === 'GET' && (m = /^\/api\/channel\/([^/]+)$/.exec(pathname))) {
        return json(await channel(decodeURIComponent(m[1])));
      }
      if (method === 'GET' && pathname === '/api/status') {
        const cfg = getConfig();
        return json({
          hasApiKey: !!effectiveApiKey(cfg),
          hasPin: cfg.pinHash !== null,
          mock: usingMock(),
          static: true,
        });
      }

      // ----- Admin -----
      if (method === 'POST' && pathname === '/api/admin/pin') {
        const body = await getBody(input, init);
        const pin = String(body.pin ?? '');
        if (!pin) return json({ error: 'PIN em falta' }, 400);
        const cfg = getConfig();
        if (cfg.pinHash !== null) {
          const denied = await requirePin(input, init);
          if (denied) return denied;
        }
        await setPin(pin);
        return json({ ok: true });
      }
      if (method === 'POST' && pathname === '/api/admin/verify') {
        const denied = await requirePin(input, init);
        if (denied) return denied;
        return json({ ok: true });
      }

      // As restantes rotas admin exigem sempre X-Pin válido.
      if (pathname.startsWith('/api/admin/')) {
        const denied = await requirePin(input, init);
        if (denied) return denied;

        if (method === 'GET' && pathname === '/api/admin/config') {
          const cfg = getConfig();
          return json({
            apiKeySet: !!effectiveApiKey(cfg),
            safeSearch: cfg.safeSearch,
          });
        }
        if (method === 'GET' && pathname === '/api/admin/search/channels') {
          return json(await searchChannels(searchParams.get('q')));
        }
        if (method === 'POST' && pathname === '/api/admin/apikey') {
          const body = await getBody(input, init);
          setApiKey(body.apiKey);
          cache.clear();
          return json({ ok: true });
        }
        // Bloqueio de canais/temas/vídeos: ver ghReadBlocklist/ghWriteBlocklist em
        // admin.js — grava diretamente no GitHub, não passa por aqui.
      }

      return json({ error: 'Não encontrado' }, 404);
    } catch (err) {
      const status = err?.status === 502 ? 502 : 500;
      const msg =
        status === 502
          ? `Erro ao contactar a API do YouTube: ${err.message}. Verifique a chave API e a quota.`
          : err?.message || 'Erro interno';
      return json({ error: msg }, status);
    }
  }

  // ---------- Interceção do fetch ----------

  window.fetch = function (input, init) {
    let urlStr;
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof URL) urlStr = input.href;
    else if (typeof Request !== 'undefined' && input instanceof Request) urlStr = input.url;
    else urlStr = String(input);

    let url;
    try {
      const base =
        (typeof location !== 'undefined' && location.href) || 'http://localhost/';
      url = new URL(urlStr, base);
    } catch {
      return originalFetch(input, init);
    }

    if (!url.pathname.includes('/api/')) {
      return originalFetch(input, init);
    }

    // Normaliza o pathname para começar em /api/ mesmo servido de um subcaminho
    // (ex.: GitHub Pages em /<repo>/): tudo antes de /api/ é descartado.
    const idx = url.pathname.indexOf('/api/');
    const pathname = url.pathname.slice(idx);

    const method = (
      init?.method ||
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET') ||
      'GET'
    ).toUpperCase();

    return handleApi(pathname, url.searchParams, method, input, init);
  };
})();
