// KidTube — painel de administração
'use strict';

const $ = (sel) => document.querySelector(sel);

const PIN_KEY = 'kidtube-pin';

const state = {
  config: null, // { apiKeySet, blocked: {channels, keywords, videos}, region, safeSearch }
};

// ---------------------------------------------------------------------------
// Pedidos à API
// ---------------------------------------------------------------------------

function getPin() {
  return sessionStorage.getItem(PIN_KEY) || '';
}

function setPin(pin) {
  sessionStorage.setItem(PIN_KEY, pin);
}

function clearPin() {
  sessionStorage.removeItem(PIN_KEY);
}

async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noPin) headers['X-Pin'] = getPin();
  const resp = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* corpo vazio ou não-JSON */ }

  if (resp.status === 401 && !opts.keep401) {
    // PIN inválido/expirado — volta ao ecrã de PIN.
    clearPin();
    showPinScreen('O PIN deixou de ser válido. Introduza-o novamente.');
    throw new ApiError(401, 'PIN inválido');
  }
  if (resp.status === 429) {
    throw new ApiError(429, 'Demasiadas tentativas falhadas. Aguarde 60 segundos e tente de novo.');
  }
  if (!resp.ok) {
    throw new ApiError(resp.status, (data && data.error) || `Erro ${resp.status}`);
  }
  return data;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Extração de IDs de URLs do YouTube (no cliente)
// ---------------------------------------------------------------------------

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

function parseYouTubeUrl(raw) {
  const text = raw.trim();
  let url = null;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch { /* não é URL */ }
  if (!url || !/(^|\.)((youtube|youtube-nocookie)\.com|youtu\.be)$/i.test(url.hostname)) {
    return null;
  }
  const path = url.pathname;

  if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
    const id = path.split('/').filter(Boolean)[0] || '';
    if (VIDEO_ID_RE.test(id)) return { kind: 'video', id };
    return { kind: 'unknown' };
  }
  const v = url.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return { kind: 'video', id: v };

  let m = path.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
  if (m) return { kind: 'video', id: m[1] };

  m = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?]|$)/);
  if (m) return { kind: 'channel', id: m[1] };

  // URLs de canal sem ID extraível: @handle, /c/..., /user/...
  if (/^\/(@|c\/|user\/)/.test(path)) return { kind: 'handle' };

  return { kind: 'unknown' };
}

const HANDLE_HELP =
  'Não é possível obter o ID a partir de um @handle ou de um URL curto de canal. ' +
  'Abra o canal no YouTube, veja o código-fonte ou use um URL do tipo ' +
  'youtube.com/channel/UC… e cole esse URL aqui.';

// Devolve o ID do vídeo, ou lança Error com mensagem explicativa.
function extractVideoId(input) {
  const text = input.trim();
  if (VIDEO_ID_RE.test(text) && !text.includes('.')) return text;
  const parsed = parseYouTubeUrl(text);
  if (parsed && parsed.kind === 'video') return parsed.id;
  if (parsed && parsed.kind === 'channel') {
    throw new Error('Esse URL é de um canal, não de um vídeo. Use a tab "Canais bloqueados".');
  }
  throw new Error('Não reconheci esse vídeo. Cole um URL do tipo youtube.com/watch?v=…, ' +
    'youtu.be/… ou youtube.com/shorts/…, ou o ID do vídeo (11 caracteres).');
}

// Devolve o ID do canal (UC…), ou lança Error com mensagem explicativa.
function extractChannelId(input) {
  const text = input.trim();
  if (CHANNEL_ID_RE.test(text)) return text;
  if (text.startsWith('@')) throw new Error(HANDLE_HELP);
  const parsed = parseYouTubeUrl(text);
  if (parsed && parsed.kind === 'channel') return parsed.id;
  if (parsed && parsed.kind === 'handle') throw new Error(HANDLE_HELP);
  if (parsed && parsed.kind === 'video') {
    throw new Error('Esse URL é de um vídeo, não de um canal. Use a tab "Vídeos bloqueados".');
  }
  throw new Error('Não reconheci esse canal. Cole um URL do tipo ' +
    'youtube.com/channel/UC… ou o próprio ID (começa por UC).');
}

// ---------------------------------------------------------------------------
// UI: ecrãs e mensagens
// ---------------------------------------------------------------------------

function showError(sel, message) {
  const el = $(sel);
  el.textContent = message || '';
  el.hidden = !message;
}

let flashTimer = null;
function flash(message, isError = false) {
  const el = $('#admin-msg');
  el.textContent = message;
  el.classList.toggle('flash-error', isError);
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function showPinScreen(subtitle, setupMode = false) {
  $('#admin-screen').hidden = true;
  $('#pin-screen').hidden = false;
  $('#pin-setup-form').hidden = !setupMode;
  $('#pin-entry-form').hidden = setupMode;
  $('#pin-title').textContent = setupMode ? 'Definir PIN de administração' : 'Administração';
  $('#pin-subtitle').textContent = subtitle || '';
  showError('#pin-error', '');
  const focusEl = setupMode ? $('#pin-new') : $('#pin-input');
  setTimeout(() => focusEl.focus(), 50);
}

async function showAdminScreen() {
  $('#pin-screen').hidden = true;
  $('#admin-screen').hidden = false;
  await refreshConfig();
}

// ---------------------------------------------------------------------------
// Fluxo de PIN
// ---------------------------------------------------------------------------

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* PWA opcional */ });
  }
  let status;
  try {
    status = await api('GET', '/api/status', undefined, { noPin: true });
  } catch (err) {
    showPinScreen(`Não foi possível contactar o servidor (${err.message}).`);
    return;
  }
  if (!status.hasPin) {
    showPinScreen('Primeira utilização: escolha um PIN para proteger este painel.', true);
    return;
  }
  if (getPin()) {
    try {
      await api('POST', '/api/admin/verify', {}, { keep401: false });
      await showAdminScreen();
      return;
    } catch (err) {
      if (err.status !== 401) showPinScreen(err.message);
      return; // 401 já mostrou o ecrã de PIN
    }
  }
  showPinScreen('Introduza o PIN de administração.');
}

$('#pin-setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pin = $('#pin-new').value;
  const pin2 = $('#pin-new2').value;
  if (pin !== pin2) {
    showError('#pin-error', 'Os dois PINs não coincidem.');
    return;
  }
  try {
    setPin(pin); // /api/admin/pin na 1ª vez não exige X-Pin, mas guardamos já
    await api('POST', '/api/admin/pin', { pin }, { keep401: true });
    await showAdminScreen();
  } catch (err) {
    clearPin();
    showError('#pin-error', err.message);
  }
});

$('#pin-entry-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pin = $('#pin-input').value;
  setPin(pin);
  try {
    await api('POST', '/api/admin/verify', {}, { keep401: true });
    $('#pin-input').value = '';
    await showAdminScreen();
  } catch (err) {
    clearPin();
    if (err.status === 401) {
      showError('#pin-error', 'PIN incorreto.');
    } else {
      showError('#pin-error', err.message);
    }
  }
});

$('#lock-btn').addEventListener('click', () => {
  clearPin();
  showPinScreen('Sessão bloqueada. Introduza o PIN para continuar.');
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.hidden = p.id !== `tab-${btn.dataset.tab}`;
    });
  });
});

// ---------------------------------------------------------------------------
// Config + listas
// ---------------------------------------------------------------------------

async function refreshConfig() {
  const cfg = await api('GET', '/api/admin/config');
  state.config = cfg;
  renderLists();
  renderSettings();
}

function renderList(listSel, emptySel, items, renderItem, onRemove) {
  const ul = $(listSel);
  ul.textContent = '';
  $(emptySel).hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'item-main';
    renderItem(main, item);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-remove';
    btn.textContent = '✕';
    btn.setAttribute('aria-label', 'Remover');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await onRemove(item);
        await refreshConfig();
      } catch (err) {
        btn.disabled = false;
        flash(err.message, true);
      }
    });
    li.append(main, btn);
    ul.append(li);
  }
}

function renderLists() {
  const b = state.config.blocked || {};
  renderList('#channel-list', '#channel-empty', b.channels || [], (el, ch) => {
    const t = document.createElement('span');
    t.className = 'item-title';
    t.textContent = ch.title || '(sem título)';
    const id = document.createElement('span');
    id.className = 'item-id';
    id.textContent = ch.id;
    el.append(t, id);
  }, (ch) => api('DELETE', `/api/admin/block/channel/${encodeURIComponent(ch.id)}`));

  renderList('#keyword-list', '#keyword-empty', b.keywords || [], (el, kw) => {
    const t = document.createElement('span');
    t.className = 'item-title';
    t.textContent = kw;
    el.append(t);
  }, (kw) => api('DELETE', `/api/admin/block/keyword/${encodeURIComponent(kw)}`));

  renderList('#video-list', '#video-empty', b.videos || [], (el, v) => {
    const t = document.createElement('span');
    t.className = 'item-title';
    t.textContent = v.title || '(sem título)';
    const id = document.createElement('span');
    id.className = 'item-id';
    id.textContent = v.id;
    el.append(t, id);
  }, (v) => api('DELETE', `/api/admin/block/video/${encodeURIComponent(v.id)}`));
}

function renderSettings() {
  const cfg = state.config;
  const status = $('#apikey-status');
  if (cfg.apiKeySet) {
    status.innerHTML = '';
    const ok = document.createElement('span');
    ok.className = 'apikey-ok';
    ok.textContent = 'configurada ✓';
    status.append('Chave da API: ', ok, ' — introduza uma nova para a substituir.');
  } else {
    status.textContent = 'Sem chave configurada — a app está em modo demonstração.';
  }
  $('#region-select').value = cfg.region || 'PT';
}

// ---------------------------------------------------------------------------
// Forms de adicionar
// ---------------------------------------------------------------------------

$('#channel-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#channel-error', '');
  try {
    const id = extractChannelId($('#channel-input').value);
    const title = $('#channel-title').value.trim();
    await api('POST', '/api/admin/block/channel', { id, title });
    $('#channel-form').reset();
    await refreshConfig();
    flash('Canal bloqueado.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showError('#channel-error', err.message);
  }
});

$('#keyword-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#keyword-error', '');
  const keyword = $('#keyword-input').value.trim();
  if (!keyword) return;
  try {
    await api('POST', '/api/admin/block/keyword', { keyword });
    $('#keyword-form').reset();
    await refreshConfig();
    flash('Tema bloqueado.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showError('#keyword-error', err.message);
  }
});

$('#video-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#video-error', '');
  try {
    const id = extractVideoId($('#video-input').value);
    const title = $('#video-title').value.trim();
    await api('POST', '/api/admin/block/video', { id, title });
    $('#video-form').reset();
    await refreshConfig();
    flash('Vídeo bloqueado.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showError('#video-error', err.message);
  }
});

// ---------------------------------------------------------------------------
// Definições
// ---------------------------------------------------------------------------

$('#apikey-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#apikey-error', '');
  const apiKey = $('#apikey-input').value.trim();
  if (!apiKey) {
    showError('#apikey-error', 'Cole a chave da API antes de guardar.');
    return;
  }
  try {
    await api('POST', '/api/admin/apikey', { apiKey });
    $('#apikey-form').reset();
    await refreshConfig();
    flash('Chave da API guardada.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showError('#apikey-error', err.message);
  }
});

$('#region-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#region-error', '');
  try {
    await api('POST', '/api/admin/region', { region: $('#region-select').value });
    await refreshConfig();
    flash('Região guardada.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showError('#region-error', err.message);
  }
});

$('#changepin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#changepin-error', '');
  const pin = $('#changepin-new').value;
  const pin2 = $('#changepin-new2').value;
  if (pin !== pin2) {
    showError('#changepin-error', 'Os dois PINs não coincidem.');
    return;
  }
  try {
    await api('POST', '/api/admin/pin', { pin }); // X-Pin atual valida a troca
    setPin(pin);
    $('#changepin-form').reset();
    flash('PIN alterado.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showError('#changepin-error', err.message);
  }
});

// ---------------------------------------------------------------------------

boot();
