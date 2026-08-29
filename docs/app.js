// KidTube — frontend principal (vanilla ES2022, sem dependências)
'use strict';

const app = document.getElementById('app');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const mockBanner = document.getElementById('mock-banner');

// ---------- Service worker + estado (mock) ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const status = await res.json();
    mockBanner.hidden = !status.mock;
  } catch {
    /* silencioso — o banner só aparece quando há resposta */
  }
}
checkStatus();

// ---------- Utilitários de formatação (pt-PT) ----------

function formatViews(views) {
  const n = Number(views);
  if (views == null || !Number.isFinite(n)) return null;
  let valor;
  if (n >= 1e9) valor = trimNum(n / 1e9) + ' mil M';
  else if (n >= 1e6) valor = trimNum(n / 1e6) + ' M';
  else if (n >= 1000) valor = trimNum(n / 1000) + ' mil';
  else valor = String(n);
  return `${valor} visualizações`;
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

// ---------- Vistas ----------

let renderSeq = 0; // ignora respostas de navegações antigas

async function viewHome() {
  const seq = ++renderSeq;
  showSkeletonGrid();
  try {
    const data = await apiGet('/api/home');
    if (seq !== renderSeq) return;
    app.replaceChildren();
    if (!data.items?.length) {
      showMessage({ emoji: '📺', title: 'Sem vídeos por agora', text: 'Volta mais tarde!' });
      return;
    }
    app.appendChild(videoGrid(data.items));
  } catch {
    if (seq === renderSeq) showError(viewHome);
  }
}

async function viewSearch(query) {
  const seq = ++renderSeq;
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
    app.appendChild(videoGrid(data.items));
  } catch {
    if (seq === renderSeq) showError(() => viewSearch(query));
  }
}

async function viewWatch(id) {
  const seq = ++renderSeq;
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
    app.replaceChildren();
    const wrap = el('div', 'watch');

    const player = el('div', 'player');
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?rel=0&playsinline=1`;
    iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.title = v.title || 'Vídeo';
    player.appendChild(iframe);
    wrap.appendChild(player);

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
    app.appendChild(el('h1', 'page-title', data.channel?.title || 'Canal'));
    if (!data.items?.length) {
      showMessage({ emoji: '📺', title: 'Este canal ainda não tem vídeos' });
      return;
    }
    app.appendChild(videoGrid(data.items));
  } catch {
    if (seq === renderSeq) showError(() => viewChannel(id));
  }
}

// ---------- Router por hash ----------

function route() {
  const hash = location.hash || '#home';
  const sep = hash.indexOf('/');
  const name = sep === -1 ? hash.slice(1) : hash.slice(1, sep);
  const arg = sep === -1 ? '' : decodeURIComponent(hash.slice(sep + 1));

  if (name !== 'search') searchInput.value = '';

  if (name === 'search' && arg) viewSearch(arg);
  else if (name === 'watch' && arg) viewWatch(arg);
  else if (name === 'channel' && arg) viewChannel(arg);
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
