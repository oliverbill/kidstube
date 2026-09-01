// KidTube — frontend principal (vanilla ES2022, sem dependências)
'use strict';

const app = document.getElementById('app');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const mockBanner = document.getElementById('mock-banner');

// ---------- Service worker + estado (mock) ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let statusPromise = null;

// Pedido único, partilhado: o banner de demonstração e o player perguntam o mesmo.
function getStatus() {
  if (!statusPromise) {
    statusPromise = fetch('/api/status')
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  }
  return statusPromise;
}

getStatus().then((status) => { mockBanner.hidden = !status.mock; });

// ---------- Utilitários de formatação (pt-PT) ----------

function formatCompact(n) {
  if (n >= 1e9) return trimNum(n / 1e9) + ' mil M';
  if (n >= 1e6) return trimNum(n / 1e6) + ' M';
  if (n >= 1000) return trimNum(n / 1000) + ' mil';
  return String(n);
}

function formatViews(views) {
  const n = Number(views);
  if (views == null || !Number.isFinite(n)) return null;
  return `${formatCompact(n)} visualizações`;
}

function formatSubscribers(count) {
  const n = Number(count);
  if (count == null || !Number.isFinite(n)) return null;
  return `${formatCompact(n)} ${n === 1 ? 'inscrito' : 'inscritos'}`;
}

function trimNum(x) {
  // 1 casa decimal, vírgula decimal pt-PT, sem ",0"
  const s = x.toFixed(1).replace('.', ',');
  return s.endsWith(',0') ? s.slice(0, -2) : s;
}

function relativeDate(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const seg = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const passos = [
    [31536000, 'ano', 'anos'],
    [2592000, 'mês', 'meses'],
    [604800, 'semana', 'semanas'],
    [86400, 'dia', 'dias'],
    [3600, 'hora', 'horas'],
    [60, 'minuto', 'minutos'],
  ];
  for (const [unidade, sing, plur] of passos) {
    const v = Math.floor(seg / unidade);
    if (v >= 1) return `há ${v} ${v === 1 ? sing : plur}`;
  }
  return 'agora mesmo';
}

// ---------- Construção de DOM (sempre textContent — nunca HTML cru) ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function videoCard(video) {
  const a = el('a', 'card');
  a.href = `#watch/${encodeURIComponent(video.id)}`;

  const thumb = el('div', 'thumb');
  const img = document.createElement('img');
  img.src = video.thumbnail || '';
  img.alt = '';
  img.loading = 'lazy';
  thumb.appendChild(img);
  if (video.duration) thumb.appendChild(el('span', 'duration', video.duration));
  a.appendChild(thumb);

  const title = el('h3', 'card-title', video.title || '');
  a.appendChild(title);

  const meta = el('div', 'card-meta');
  meta.appendChild(el('div', null, video.channelTitle || ''));
  const partes = [formatViews(video.views), relativeDate(video.publishedAt)].filter(Boolean);
  if (partes.length) meta.appendChild(el('div', null, partes.join(' • ')));
  a.appendChild(meta);

  return a;
}

function channelHeader(ch) {
  const header = el('div', 'channel-header');

  const avatar = el('div', 'channel-avatar-lg');
  if (ch.thumbnail) {
    const img = document.createElement('img');
    img.src = ch.thumbnail;
    img.alt = '';
    avatar.appendChild(img);
  } else {
    avatar.textContent = (ch.title || '?').trim().charAt(0).toUpperCase() || '?';
  }
  header.appendChild(avatar);

  const info = el('div', 'channel-header-info');
  info.appendChild(el('h1', 'channel-header-title', ch.title || 'Canal'));

  const stats = [formatSubscribers(ch.subscriberCount), ch.videoCount != null ? `${formatCompact(Number(ch.videoCount))} vídeos` : null]
    .filter(Boolean);
  if (stats.length) info.appendChild(el('div', 'channel-header-stats', stats.join(' • ')));

  if (ch.description) {
    const desc = el('p', 'channel-header-desc', ch.description);
    info.appendChild(desc);
  }

  header.appendChild(info);
  return header;
}

function channelCard(ch) {
  const a = el('a', 'card channel-card');
  a.href = `#channel/${encodeURIComponent(ch.id)}`;
  const avatar = el('div', 'thumb channel-avatar-thumb');
  if (ch.thumbnail) {
    const img = document.createElement('img');
    img.src = ch.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    avatar.appendChild(img);
  }
  a.appendChild(avatar);
  a.appendChild(el('h3', 'card-title', ch.title || '(sem título)'));
  return a;
}

function channelGrid(items) {
  const grid = el('div', 'grid');
  for (const ch of items) grid.appendChild(channelCard(ch));
  return grid;
}

function videoGrid(items) {
  const grid = el('div', 'grid');
  for (const v of items) grid.appendChild(videoCard(v));
  return grid;
}

// ---------- Estados: loading, erro, mensagens ----------

function showSkeletonGrid(count = 8) {
  app.replaceChildren();
  const grid = el('div', 'grid');
  for (let i = 0; i < count; i++) {
    const card = el('div', 'card skeleton');
    card.appendChild(el('div', 'thumb'));
    card.appendChild(el('div', 'sk-line'));
    card.appendChild(el('div', 'sk-line short'));
    grid.appendChild(card);
  }
  app.appendChild(grid);
}

function showSkeletonWatch() {
  app.replaceChildren();
  const wrap = el('div', 'watch');
  wrap.appendChild(el('div', 'sk-player'));
  wrap.appendChild(el('div', 'sk-line'));
  wrap.appendChild(el('div', 'sk-line short'));
  app.appendChild(wrap);
}

function showMessage({ emoji, title, text, buttonLabel, onButton }) {
  app.replaceChildren();
  const box = el('div', 'message');
  box.appendChild(el('span', 'emoji', emoji));
  box.appendChild(el('h2', null, title));
  if (text) box.appendChild(el('p', null, text));
  if (buttonLabel) {
    const btn = el('button', 'btn', buttonLabel);
    btn.addEventListener('click', onButton);
    box.appendChild(btn);
  }
  app.appendChild(box);
}

function showError(retry) {
  showMessage({
    emoji: '😕',
    title: 'Algo correu mal',
    text: 'Não foi possível carregar os vídeos. Verifica a ligação e tenta de novo.',
    buttonLabel: 'Tentar novamente',
    onButton: retry,
  });
}

// ---------- API ----------

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Histórico (por dispositivo — o que foi assistido nesta app; a API do
// YouTube não expõe o histórico real de nenhuma conta, com ou sem OAuth) ----------

const HISTORY_KEY = 'kidtube-history';
const HISTORY_MAX = 200;

function readHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function recordHistory(video) {
  const list = readHistory().filter((v) => v.id !== video.id);
  list.unshift({
    id: video.id,
    title: video.title || '',
    thumbnail: video.thumbnail || '',
    channelTitle: video.channelTitle || '',
    watchedAt: new Date().toISOString(),
  });
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch { /* localStorage indisponível/cheio: histórico fica só nesta sessão */ }
}

// ---------- Scroll infinito ----------

let scrollObserver = null;

function stopInfiniteScroll() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
}

// Observa um sentinela no fim da grid; ao aproximar-se dele, chama fetchNext()
// (que deve devolver `true` se ainda há mais páginas). Pára sozinho quando
// fetchNext devolve false/lança, ou quando a navegação muda (seq desatualizado).
function startInfiniteScroll(seq, fetchNext) {
  stopInfiniteScroll();
  const sentinel = el('div', 'scroll-sentinel');
  sentinel.style.height = '1px';
  let loading = false;
  scrollObserver = new IntersectionObserver((entries) => {
    if (seq !== renderSeq) { stopInfiniteScroll(); return; }
    if (!entries[0].isIntersecting || loading) return;
    loading = true;
    fetchNext()
      .then((hasMore) => {
        loading = false;
        if (seq !== renderSeq || !hasMore) stopInfiniteScroll();
      })
      .catch(() => {
        loading = false;
        stopInfiniteScroll();
      });
  }, { rootMargin: '600px' });
  scrollObserver.observe(sentinel);
  app.appendChild(sentinel);
}

// ---------- Vistas ----------

let renderSeq = 0; // ignora respostas de navegações antigas

async function viewHome() {
  const seq = ++renderSeq;
  stopInfiniteScroll();
  showSkeletonGrid();
  try {
    const data = await apiGet('/api/home');
    if (seq !== renderSeq) return;
    app.replaceChildren();
    if (!data.items?.length) {
      showMessage({ emoji: '📺', title: 'Sem vídeos por agora', text: 'Volta mais tarde!' });
      return;
    }
    const grid = videoGrid(data.items);
    app.appendChild(grid);
    let nextPageToken = data.nextPageToken || null;
    if (nextPageToken) {
      startInfiniteScroll(seq, async () => {
        const more = await apiGet(`/api/home?pageToken=${encodeURIComponent(nextPageToken)}`);
        if (seq !== renderSeq) return false;
        for (const v of more.items || []) grid.appendChild(videoCard(v));
        nextPageToken = more.nextPageToken || null;
        return Boolean(nextPageToken);
      });
    }
  } catch {
    if (seq === renderSeq) showError(viewHome);
  }
}

async function viewSearch(query) {
  const seq = ++renderSeq;
  stopInfiniteScroll();
  searchInput.value = query;
  showSkeletonGrid();
  try {
    const data = await apiGet(`/api/search?q=${encodeURIComponent(query)}`);
    if (seq !== renderSeq) return;
    if (data.blockedQuery) {
      showMessage({
        emoji: '🙈',
        title: 'Essa pesquisa não está disponível',
        text: 'Experimenta procurar outra coisa divertida!',
        buttonLabel: 'Voltar ao início',
        onButton: () => { location.hash = '#home'; },
      });
      return;
    }
    app.replaceChildren();
    app.appendChild(el('h1', 'page-title', `Resultados para “${query}”`));
    if (!data.items?.length) {
      showMessage({ emoji: '🔍', title: 'Nada encontrado', text: 'Tenta outras palavras.' });
      return;
    }
    const grid = videoGrid(data.items);
    app.appendChild(grid);
    let nextPageToken = data.nextPageToken || null;
    if (nextPageToken) {
      startInfiniteScroll(seq, async () => {
        const more = await apiGet(
          `/api/search?q=${encodeURIComponent(query)}&pageToken=${encodeURIComponent(nextPageToken)}`,
        );
        if (seq !== renderSeq) return false;
        for (const v of more.items || []) grid.appendChild(videoCard(v));
        nextPageToken = more.nextPageToken || null;
        return Boolean(nextPageToken);
      });
    }
  } catch {
    if (seq === renderSeq) showError(() => viewSearch(query));
  }
}

async function viewWatch(id) {
  const seq = ++renderSeq;
  stopInfiniteScroll();
  showSkeletonWatch();
  try {
    const data = await apiGet(`/api/video/${encodeURIComponent(id)}`);
    if (seq !== renderSeq) return;
    if (data.blocked || !data.video) {
      showMessage({
        emoji: '🐻',
        title: 'Este vídeo não está disponível',
        text: 'Mas há muitos outros vídeos giros para ver!',
        buttonLabel: 'Voltar',
        onButton: () => {
          if (history.length > 1) history.back();
          else location.hash = '#home';
        },
      });
      return;
    }
    const v = data.video;
    recordHistory(v);
    app.replaceChildren();
    const wrap = el('div', 'watch');

    const backBtn = el('button', 'watch-back', '← Voltar');
    backBtn.type = 'button';
    backBtn.addEventListener('click', () => {
      if (history.length > 1) history.back();
      else location.hash = '#home';
    });
    wrap.appendChild(backBtn);

    wrap.appendChild(buildPlayer(v.id));

    wrap.appendChild(el('h1', 'watch-title', v.title || ''));

    const partes = [formatViews(v.views), relativeDate(v.publishedAt)].filter(Boolean);
    if (partes.length) wrap.appendChild(el('div', 'watch-meta', partes.join(' • ')));

    const chanLink = el('a', 'watch-channel');
    chanLink.href = `#channel/${encodeURIComponent(v.channelId)}`;
    const inicial = (v.channelTitle || '?').trim().charAt(0).toUpperCase() || '?';
    chanLink.appendChild(el('span', 'channel-avatar', inicial));
    chanLink.appendChild(el('span', null, v.channelTitle || ''));
    wrap.appendChild(chanLink);

    if (data.related?.length) {
      wrap.appendChild(el('h2', 'section-title', 'Mais deste canal'));
      wrap.appendChild(videoGrid(data.related));
    }

    app.appendChild(wrap);
    window.scrollTo(0, 0);
  } catch {
    if (seq === renderSeq) showError(() => viewWatch(id));
  }
}

async function viewChannel(id) {
  const seq = ++renderSeq;
  stopInfiniteScroll();
  showSkeletonGrid();
  try {
    const data = await apiGet(`/api/channel/${encodeURIComponent(id)}`);
    if (seq !== renderSeq) return;
    if (data.blocked) {
      showMessage({
        emoji: '🐻',
        title: 'Este canal não está disponível',
        text: 'Mas há muitos outros canais giros para explorar!',
        buttonLabel: 'Voltar ao início',
        onButton: () => { location.hash = '#home'; },
      });
      return;
    }
    app.replaceChildren();
    app.appendChild(channelHeader(data.channel || {}));
    if (!data.items?.length) {
      app.appendChild(el('p', 'empty', 'Este canal ainda não tem vídeos.'));
      return;
    }
    app.appendChild(el('h2', 'section-title', 'Vídeos'));
    const grid = videoGrid(data.items);
    app.appendChild(grid);
    let nextPageToken = data.nextPageToken || null;
    if (nextPageToken) {
      startInfiniteScroll(seq, async () => {
        const more = await apiGet(
          `/api/channel/${encodeURIComponent(id)}?pageToken=${encodeURIComponent(nextPageToken)}`,
        );
        if (seq !== renderSeq) return false;
        for (const v of more.items || []) grid.appendChild(videoCard(v));
        nextPageToken = more.nextPageToken || null;
        return Boolean(nextPageToken);
      });
    }
  } catch {
    if (seq === renderSeq) showError(() => viewChannel(id));
  }
}

async function viewSubscriptions() {
  const seq = ++renderSeq;
  stopInfiniteScroll();
  showSkeletonGrid();
  try {
    const data = await apiGet('/api/subscriptions');
    if (seq !== renderSeq) return;
    app.replaceChildren();
    app.appendChild(el('h1', 'page-title', 'Inscrições'));
    if (!data.channels?.length) {
      showMessage({
        emoji: '📺',
        title: 'Sem inscrições',
        text: 'Liga a conta do YouTube em Definições para trazer os canais inscritos.',
      });
      return;
    }
    app.appendChild(channelGrid(data.channels));
  } catch {
    if (seq === renderSeq) showError(viewSubscriptions);
  }
}

function viewHistory() {
  ++renderSeq;
  stopInfiniteScroll();
  app.replaceChildren();
  app.appendChild(el('h1', 'page-title', 'Histórico'));
  const items = readHistory();
  if (!items.length) {
    showMessage({ emoji: '🕘', title: 'Ainda sem histórico', text: 'Os vídeos que vires aqui aparecem nesta lista.' });
    return;
  }
  app.appendChild(videoGrid(items));
}

// ---------- Router por hash ----------

// ---------------------------------------------------------------------------
// Player controlado (YouTube IFrame API)
//
// O iframe do YouTube nunca recebe toques (pointer-events: none no CSS) — sem
// título clicável, sem logo, sem "Ver no YouTube". Os controlos são nossos:
// tocar no vídeo alterna play/pausa; barra de progresso e ecrã inteiro em baixo.
// ---------------------------------------------------------------------------

let ytApiPromise = null;

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => reject(new Error('iframe_api falhou'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('iframe_api demorou')), 10000);
    }).catch((err) => {
      ytApiPromise = null;
      throw err;
    });
  }
  return ytApiPromise;
}

let activePlayer = null; // { yt?, video?, timer }

function destroyPlayer() {
  if (!activePlayer) return;
  clearInterval(activePlayer.timer);
  const { video } = activePlayer;
  if (video) {
    // Sem limpar o src o Safari continua a puxar bytes do vídeo anterior.
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* já removido */ }
  }
  try { activePlayer.yt?.destroy(); } catch { /* já removido do DOM */ }
  activePlayer = null;
}

// ---------------------------------------------------------------------------
// Resolvedor de streams — reprodução sem anúncios
//
// O player embutido nunca é ad-free no iPad: o Safari bloqueia cookies de terceiros,
// por isso o iframe é sempre uma sessão anónima, mesmo com Premium na conta. Este
// servidor resolve o stream (server/resolve.js) e tocamo-lo num <video> nosso — sem
// anúncios e sem YouTube no meio. Se o resolvedor falhar, fica o iframe de sempre.
//
// O resolvedor é sempre a própria origem: a app é servida pelo mesmo servidor que
// resolve. O /api/status diz se este servidor o faz.
// ---------------------------------------------------------------------------

// Resolve quando os metadados chegam — é o primeiro momento em que se sabe que a
// fonte é mesmo reproduzível; um URL preso a outro IP só falha aqui.
function loadSource(video, src, timeoutMs = 20000) {
  return new Promise((ok, bad) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onOk);
      video.removeEventListener('error', onBad);
    };
    const onOk = () => { cleanup(); ok(); };
    const onBad = () => { cleanup(); bad(new Error('fonte rejeitada')); };
    const timer = setTimeout(onBad, timeoutMs);
    video.addEventListener('loadedmetadata', onOk);
    video.addEventListener('error', onBad);
    video.src = src;
    video.load();
  });
}

function wireNativeControls(video, ctx) {
  const { player, shield, bigPlay, playBtn, seek, clock, fsBtn } = ctx;

  const timer = setInterval(() => {
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    if (dur > 0 && !seek.matches(':active')) {
      seek.value = String((video.currentTime / dur) * 100);
    }
    clock.textContent = `${formatClock(video.currentTime)} / ${formatClock(dur)}`;
  }, 500);
  activePlayer = { video, timer };

  const sync = () => {
    const playing = !video.paused && !video.ended;
    playBtn.textContent = playing ? '❚❚' : '▶';
    bigPlay.textContent = video.ended ? '↺' : '▶';
    shield.classList.toggle('is-playing', playing);
  };
  for (const ev of ['play', 'pause', 'ended']) video.addEventListener(ev, sync);
  sync();

  const toggle = () => {
    if (video.ended) { video.currentTime = 0; video.play().catch(() => {}); }
    else if (video.paused) video.play().catch(() => {});
    else video.pause();
  };
  shield.addEventListener('click', toggle);
  playBtn.addEventListener('click', toggle);

  seek.addEventListener('input', () => {
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    if (dur > 0) video.currentTime = (Number(seek.value) / 100) * dur;
  });

  fsBtn.addEventListener('click', () => {
    // No iPad o Fullscreen API não existe para divs — só o próprio <video> entra em
    // ecrã inteiro (aí com os controlos do sistema, que continuam a ser os do iOS).
    if (video.webkitEnterFullscreen) return video.webkitEnterFullscreen();
    if (document.fullscreenElement) return document.exitFullscreen();
    if (player.requestFullscreen) {
      player.requestFullscreen().catch(() => player.classList.toggle('fs-fallback'));
    } else {
      player.classList.toggle('fs-fallback');
    }
  });
}

async function attachNative(videoId, ctx) {
  const res = await fetch(`/api/stream/${videoId}`);
  if (!res.ok) throw new Error(`resolvedor devolveu ${res.status}`);
  const info = await res.json();
  if (!ctx.mount.isConnected) return; // já navegámos para outra página

  const video = document.createElement('video');
  video.className = 'player-video';
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.controls = false;

  // Por ordem de preferência. Os dois primeiros vão direitos ao YouTube e não custam
  // nada ao servidor; os outros dois passam por ele, e só fazem falta quando o YouTube
  // prende o URL ao IP de quem o resolveu (o caso do VPS, em que o iPad tem outro IP).
  // O HLS encaminhado vem antes do progressivo encaminhado por ser 1080p contra 360p.
  const sources = [info.url];
  if (info.fallback?.url) sources.push(info.fallback.url);
  if (info.kind === 'hls') sources.push(`/api/hls/${videoId}/master.m3u8`);
  sources.push(`/api/stream/${videoId}/proxy`);

  let lastErr = null;
  let loaded = false;
  for (const src of sources) {
    try { await loadSource(video, src); loaded = true; break; }
    catch (err) { lastErr = err; }
  }
  if (!loaded) throw lastErr || new Error('nenhuma fonte reproduzível');
  if (!ctx.mount.isConnected) return;

  ctx.mount.replaceWith(video);
  wireNativeControls(video, ctx);
  video.play().catch(() => { /* o iPad pode exigir um toque: fica o botão ▶ */ });
}

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function buildPlayer(videoId) {
  const player = el('div', 'player');
  const frame = el('div', 'player-frame');
  const mount = el('div');
  const shield = el('div', 'player-shield');
  const bigPlay = el('div', 'player-bigplay', '▶');
  shield.appendChild(bigPlay);
  frame.append(mount, shield);

  const controls = el('div', 'player-controls');
  const playBtn = el('button', 'player-btn', '▶');
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Reproduzir/pausar');
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'player-seek';
  seek.min = '0';
  seek.max = '100';
  seek.step = '0.1';
  seek.value = '0';
  const clock = el('span', 'player-clock', '0:00 / 0:00');
  const fsBtn = el('button', 'player-btn', '⛶');
  fsBtn.type = 'button';
  fsBtn.setAttribute('aria-label', 'Ecrã inteiro');
  controls.append(playBtn, seek, clock, fsBtn);

  player.append(frame, controls);

  destroyPlayer();

  // Vídeos do modo demonstração não existem no YouTube — placeholder em vez de player.
  if (/^mock-/.test(videoId)) {
    frame.replaceChildren(el('div', 'player-error',
      'Vídeo de demonstração — a reprodução funciona com a chave API configurada.'));
    return player;
  }

  const ctx = { player, frame, mount, shield, bigPlay, playBtn, seek, clock, fsBtn };

  getStatus().then((status) => {
    if (!ctx.mount.isConnected) return; // já navegámos para outra página
    if (!status.resolver) return attachEmbed(videoId, ctx);
    attachNative(videoId, ctx).catch((err) => {
      console.warn('resolvedor falhou (%s) — a usar o player embutido', err.message);
      if (ctx.mount.isConnected) attachEmbed(videoId, ctx);
    });
  });

  return player;
}

function attachEmbed(videoId, ctx) {
  const { player, frame, mount, shield, bigPlay, playBtn, seek, clock, fsBtn } = ctx;

  loadYouTubeApi().then(() => {
    if (!mount.isConnected) return; // já navegámos para outra página
    const yt = new YT.Player(mount, {
      videoId,
      // Este caminho é o plano B (sem resolvedor) e leva anúncios de qualquer forma:
      // no iPad o Safari não deixa passar os cookies da sessão para dentro do iframe,
      // por isso nem uma conta Premium o torna ad-free. Sendo assim, fica o domínio
      // nocookie — pelo menos não deixa rasto de tracking no aparelho da criança.
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        controls: 0, rel: 0, playsinline: 1, disablekb: 1,
        fs: 0, iv_load_policy: 3, autoplay: 1,
      },
      events: {
        onReady: () => {
          const timer = setInterval(() => {
            if (!yt.getDuration) return;
            const dur = yt.getDuration() || 0;
            const cur = yt.getCurrentTime?.() || 0;
            if (dur > 0 && !seek.matches(':active')) seek.value = String((cur / dur) * 100);
            clock.textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
          }, 500);
          activePlayer = { yt, timer };
        },
        onStateChange: (ev) => {
          const playing = ev.data === YT.PlayerState.PLAYING;
          playBtn.textContent = playing ? '❚❚' : '▶';
          bigPlay.textContent = ev.data === YT.PlayerState.ENDED ? '↺' : '▶';
          shield.classList.toggle('is-playing', playing);
        },
      },
    });

    const toggle = () => {
      const state = yt.getPlayerState?.();
      if (state === YT.PlayerState.PLAYING) yt.pauseVideo();
      else if (state === YT.PlayerState.ENDED) yt.seekTo(0, true);
      else yt.playVideo();
    };
    shield.addEventListener('click', toggle);
    playBtn.addEventListener('click', toggle);
    seek.addEventListener('input', () => {
      const dur = yt.getDuration?.() || 0;
      if (dur > 0) yt.seekTo((Number(seek.value) / 100) * dur, true);
    });
    fsBtn.addEventListener('click', () => {
      const target = player;
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      } else if (target.requestFullscreen) {
        target.requestFullscreen().catch(() => target.classList.toggle('fs-fallback'));
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      } else {
        target.classList.toggle('fs-fallback'); // iPad antigo: "ecrã inteiro" via CSS
      }
    });
  }).catch((err) => {
    console.error('player:', err);
    frame.replaceChildren(el('div', 'player-error',
      'Não foi possível carregar o vídeo. Verifica a ligação e tenta de novo.'));
  });
}

function route() {
  destroyPlayer();
  const hash = location.hash || '#home';
  const sep = hash.indexOf('/');
  const name = sep === -1 ? hash.slice(1) : hash.slice(1, sep);
  const arg = sep === -1 ? '' : decodeURIComponent(hash.slice(sep + 1));

  if (name !== 'search') searchInput.value = '';

  if (name === 'search' && arg) viewSearch(arg);
  else if (name === 'watch' && arg) viewWatch(arg);
  else if (name === 'channel' && arg) viewChannel(arg);
  else if (name === 'subscriptions') viewSubscriptions();
  else if (name === 'history') viewHistory();
  else viewHome();
}

window.addEventListener('hashchange', route);
route();

// ---------- Pesquisa ----------

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  searchInput.blur(); // fecha o teclado no iPad
  location.hash = `#search/${encodeURIComponent(q)}`;
});
