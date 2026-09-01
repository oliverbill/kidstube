// KidTube — painel de administração
'use strict';

const $ = (sel) => document.querySelector(sel);

const PIN_KEY = 'kidtube-pin';

// Definido por static-api.js (só existe na variante GitHub Pages). Nessa variante
// o bloqueio não é local: vive em blocklist.json no GitHub, partilhado por todos
// os dispositivos com a app instalada. No servidor Node continua tudo local.
const IS_STATIC = typeof window.__KIDTUBE_STATIC__ !== 'undefined';

const state = {
  config: null, // { apiKeySet, blocked: {channels, keywords, videos}, safeSearch }
};

// ---------------------------------------------------------------------------
// Bloqueio centralizado no GitHub (só na variante estática)
// ---------------------------------------------------------------------------

const GH_OWNER = 'oliverbill';
const GH_REPO = 'kidstube';
const GH_PATH = 'blocklist.json';
const GH_BRANCH = 'main';

// Worker central (worker/) — guarda o PIN partilhado e o token do GitHub como
// secret; a gravação em blocklist.json passa sempre por aqui, nunca direto do
// browser. Ver worker/src/index.js.
const WORKER_BASE = 'https://kidstube-admin.alves-bill.workers.dev';

// Leitura é sempre pública (repo público) — não precisa de token nem do Worker.
async function ghReadBlocklist() {
  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`,
    { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`Não consegui ler o blocklist.json do GitHub (${res.status}).`);
  const data = await res.json();
  const decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  const parsed = JSON.parse(decoded);
  return {
    blocked: {
      channels: Array.isArray(parsed.channels) ? parsed.channels : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      videos: Array.isArray(parsed.videos) ? parsed.videos : [],
    },
  };
}

// Grava uma mutação via Worker (que lê o ficheiro mais recente, aplica e
// grava com o seu próprio token — evita conflitos de sha do lado dele).
async function workerMutateBlocklist(op, payload, message) {
  const res = await workerFetch('/blocklist/mutate', { op, payload, message });
  return res.blocked;
}

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

async function handleApiResponse(resp, opts) {
  let data = null;
  try { data = await resp.json(); } catch { /* corpo vazio ou não-JSON */ }

  if (resp.status === 401 && !opts.keep401) {
    // PIN inválido/expirado — volta ao ecrã de PIN.
    clearPin();
    showPinScreen('O PIN deixou de ser válido. Introduza-o novamente.');
    throw new ApiError(401, 'PIN inválido');
  }
  if (resp.status === 429) {
    // Nem todos os 429 são tentativas falhadas de PIN: o intervalo entre emails de
    // reposição também devolve 429, e explica-se melhor a si próprio.
    throw new ApiError(429,
      (data && data.error) || 'Demasiadas tentativas falhadas. Aguarde 60 segundos e tente de novo.');
  }
  if (!resp.ok) {
    throw new ApiError(resp.status, (data && data.error) || `Erro ${resp.status}`);
  }
  return data;
}

async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noPin) headers['X-Pin'] = getPin();
  const resp = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleApiResponse(resp, opts);
}

// Fala com o Worker central (worker/) em vez do fetch interceptado localmente
// — usado só nos pontos de admin.js que precisam de PIN/gravação partilhados
// (ver WORKER_BASE acima).
async function workerFetch(path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noPin) headers['X-Pin'] = getPin();
  const resp = await fetch(WORKER_BASE + path, {
    method: opts.method || 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleApiResponse(resp, opts);
}

// PIN é sempre partilhado via Worker na variante estática (ver WORKER_BASE).
function verifyPinCall(opts) {
  return IS_STATIC
    ? workerFetch('/verify', {}, opts)
    : api('POST', '/api/admin/verify', {}, opts);
}

function setPinCall(pin, opts) {
  return IS_STATIC
    ? workerFetch('/pin', { pin }, opts)
    : api('POST', '/api/admin/pin', { pin }, opts);
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
  $('#pin-reset-form').hidden = true;
  $('#pin-title').textContent = setupMode ? 'Definir PIN de administração' : 'Administração';
  $('#pin-subtitle').textContent = subtitle || '';
  showError('#pin-error', '');
  // O "esqueci-me" só faz sentido a pedir o PIN, e só se o servidor souber enviar email.
  if (!setupMode) offerPinReset();
  const focusEl = setupMode ? $('#pin-new') : $('#pin-input');
  setTimeout(() => focusEl.focus(), 50);
}

// ---------------------------------------------------------------------------
// Reposição do PIN por email
// ---------------------------------------------------------------------------

// Na variante estática o PIN vive no Worker, que não envia email: lá o botão não
// aparece de todo.
async function offerPinReset() {
  const btn = $('#pin-forgot');
  if (!btn || IS_STATIC) return;
  try {
    const { available, hint } = await api('GET', '/api/admin/pin/reset', undefined, { noPin: true });
    btn.hidden = !available;
    btn.dataset.hint = hint || '';
  } catch {
    btn.hidden = true; // servidor antigo ou offline: não prometer o que não há
  }
}

$('#pin-forgot')?.addEventListener('click', async () => {
  const btn = $('#pin-forgot');
  showError('#pin-error', '');
  btn.disabled = true;
  btn.textContent = 'A enviar…';
  try {
    const { hint } = await api('POST', '/api/admin/pin/reset/request', {}, { noPin: true });
    const note = $('#pin-note');
    note.hidden = false;
    note.textContent = `Email enviado para ${hint}. O link é válido 15 minutos.`;
    btn.hidden = true;
  } catch (err) {
    showError('#pin-error', err.message);
    btn.disabled = false;
    btn.textContent = 'Esqueci-me do PIN';
  }
});

// O link do email traz #reset=<token>. Tira-se logo do URL: fica no histórico do
// browser e na barra de endereço, e é uma chave de uso único.
function pendingResetToken() {
  const m = (location.hash || '').match(/^#reset=(.+)$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

// Abrir o link do email com o painel já aberto no mesmo separador muda só o #, e
// isso não recarrega a página — sem isto, o link parecia não fazer nada.
window.addEventListener('hashchange', () => {
  const token = pendingResetToken();
  if (token && !IS_STATIC) showPinResetScreen(token);
});

function showPinResetScreen(token) {
  $('#admin-screen').hidden = true;
  $('#pin-screen').hidden = false;
  $('#pin-setup-form').hidden = true;
  $('#pin-entry-form').hidden = true;
  $('#pin-forgot').hidden = true;
  $('#pin-reset-form').hidden = false;
  $('#pin-reset-form').dataset.token = token;
  $('#pin-title').textContent = 'Definir PIN novo';
  $('#pin-subtitle').textContent = 'Confirmaste o pedido por email. Escolhe o PIN novo.';
  showError('#pin-error', '');
  setTimeout(() => $('#pin-reset-new').focus(), 50);
}

$('#pin-reset-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#pin-error', '');
  const pin = $('#pin-reset-new').value;
  if (pin !== $('#pin-reset-new2').value) {
    return showError('#pin-error', 'Os dois PINs não coincidem.');
  }
  try {
    await api('POST', '/api/admin/pin/reset/confirm',
      { token: $('#pin-reset-form').dataset.token, pin }, { noPin: true });
    setPin(pin);
    $('#pin-reset-form').reset();
    await showAdminScreen();
    flash('PIN alterado.');
  } catch (err) {
    showError('#pin-error', err.message);
  }
});

async function showAdminScreen() {
  $('#pin-screen').hidden = true;
  $('#admin-screen').hidden = false;
  await refreshConfig();
  if (location.hash === '#oauth=ok' || location.hash === '#oauth=erro') {
    flash(location.hash === '#oauth=ok' ? 'Conta do YouTube ligada.' : 'Não consegui ligar a conta — tenta de novo.',
      location.hash === '#oauth=erro');
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// Fallback do "Voltar à app": em fase de captura, força a navegação mesmo que
// algum handler/extensão engula o clique no anchor.
document.addEventListener('click', (ev) => {
  const a = ev.target?.closest?.('a.back-link');
  if (!a) return;
  ev.preventDefault();
  window.location.assign(a.getAttribute('href'));
}, true);

// ---------------------------------------------------------------------------
// Fluxo de PIN
// ---------------------------------------------------------------------------

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA opcional */ });
  }
  // Um link de reposição manda em tudo o resto: quem o abriu não sabe o PIN, e não
  // vale a pena mostrar-lhe primeiro o ecrã a pedi-lo.
  const resetToken = pendingResetToken();
  if (resetToken && !IS_STATIC) {
    showPinResetScreen(resetToken);
    return;
  }

  // O bloco da conta do YouTube existe nas duas variantes: na estática fala com o
  // Worker, servida do servidor fala com o próprio servidor.
  let status;
  try {
    status = IS_STATIC
      ? await workerFetch('/status', undefined, { method: 'GET', noPin: true })
      : await api('GET', '/api/status', undefined, { noPin: true });
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
      await verifyPinCall({ keep401: false });
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
    setPin(pin); // 1ª vez não exige X-Pin, mas guardamos já
    await setPinCall(pin, { keep401: true });
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
    await verifyPinCall({ keep401: true });
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
  if (IS_STATIC) {
    const { blocked } = await ghReadBlocklist();
    state.config = { blocked };
  } else {
    state.config = await api('GET', '/api/admin/config');
  }
  renderLists();
  renderSettings();
  await renderYoutubeAccountStatus();
}

async function renderYoutubeAccountStatus() {
  const el = $('#youtube-account-status');
  const link = $('#youtube-account-connect');
  if (!el || !link) return;
  link.href = IS_STATIC ? `${WORKER_BASE}/oauth/start` : '/api/oauth/start';
  try {
    const { connected, configured } = IS_STATIC
      ? await workerFetch('/oauth/status', undefined, { method: 'GET', noPin: true })
      : await api('GET', '/api/oauth/status', undefined, { noPin: true });
    if (configured === false) {
      el.textContent = 'O servidor não tem GOOGLE_CLIENT_ID/SECRET configurados — ver o README.';
      link.hidden = true;
      return;
    }
    link.hidden = false;
    el.textContent = connected
      ? 'Conta ligada ✓ — liga outra para a substituir.'
      : 'Nenhuma conta ligada — a home e as inscrições ficam vazias até ligares uma.';
  } catch (err) {
    el.textContent = `Não foi possível verificar o estado (${err.message}).`;
  }
}

// Aplica diretamente o `blocked` devolvido pelo Worker após uma mutação — relê-lo
// do GitHub logo a seguir (refreshConfig) bate por vezes numa réplica que ainda não
// viu o commit e faz o item recém-bloqueado "desaparecer" da tela.
function applyBlocked(blocked) {
  state.config = { ...state.config, blocked };
  renderLists();
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
        const blocked = await onRemove(item);
        if (IS_STATIC) applyBlocked(blocked);
        else await refreshConfig();
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
  }, (ch) => IS_STATIC
    ? workerMutateBlocklist('unblock-channel', { id: ch.id }, `Desbloquear canal: ${ch.title || ch.id}`)
    : api('DELETE', `/api/admin/block/channel/${encodeURIComponent(ch.id)}`));

  renderList('#keyword-list', '#keyword-empty', b.keywords || [], (el, kw) => {
    const t = document.createElement('span');
    t.className = 'item-title';
    t.textContent = kw;
    el.append(t);
  }, (kw) => IS_STATIC
    ? workerMutateBlocklist('unblock-keyword', { keyword: kw }, `Desbloquear tema: ${kw}`)
    : api('DELETE', `/api/admin/block/keyword/${encodeURIComponent(kw)}`));

  renderList('#video-list', '#video-empty', b.videos || [], (el, v) => {
    const t = document.createElement('span');
    t.className = 'item-title';
    t.textContent = v.title || '(sem título)';
    const id = document.createElement('span');
    id.className = 'item-id';
    id.textContent = v.id;
    el.append(t, id);
  }, (v) => IS_STATIC
    ? workerMutateBlocklist('unblock-video', { id: v.id }, `Desbloquear vídeo: ${v.title || v.id}`)
    : api('DELETE', `/api/admin/block/video/${encodeURIComponent(v.id)}`));
}

function renderSettings() {
  const cfg = state.config;
  const status = $('#apikey-status');
  if (!status) return; // variante estática: bloco da chave removido no build
  if (cfg.apiKeySet) {
    status.innerHTML = '';
    const ok = document.createElement('span');
    ok.className = 'apikey-ok';
    ok.textContent = 'configurada ✓';
    status.append('Chave da API: ', ok, ' — introduza uma nova para a substituir.');
  } else {
    status.textContent = 'Sem chave configurada — a app está em modo demonstração.';
  }
}

// ---------------------------------------------------------------------------
// Forms de adicionar
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Autocomplete de canais por nome/@handle
// ---------------------------------------------------------------------------

const channelInput = $('#channel-input');
const suggestBox = $('#channel-suggest');
let suggestTimer = null;
let suggestSeq = 0;

function hideSuggest() {
  suggestBox.hidden = true;
  suggestBox.textContent = '';
}

async function blockChannelEntry(id, title) {
  if (IS_STATIC) {
    const blocked = await workerMutateBlocklist('block-channel', { id, title }, `Bloquear canal: ${title || id}`);
    applyBlocked(blocked);
  } else {
    await api('POST', '/api/admin/block/channel', { id, title });
    await refreshConfig();
  }
  $('#channel-form').reset();
  hideSuggest();
  flash(title ? `Canal "${title}" bloqueado.` : 'Canal bloqueado.');
}

async function runSuggest(q) {
  const seq = ++suggestSeq;
  const res = await api('GET', `/api/admin/search/channels?q=${encodeURIComponent(q)}`);
  if (seq !== suggestSeq) return false; // resposta antiga; outra pesquisa em curso
  suggestBox.textContent = '';
  if (!res.items.length) {
    hideSuggest();
    return false;
  }
  for (const ch of res.items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggest-item';
    const t = document.createElement('span');
    t.className = 'item-title';
    t.textContent = ch.title || '(sem título)';
    const id = document.createElement('span');
    id.className = 'item-id';
    id.textContent = ch.id;
    btn.append(t, id);
    btn.addEventListener('click', async () => {
      try {
        await blockChannelEntry(ch.id, ch.title);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;
        showError('#channel-error', err.message);
      }
    });
    li.append(btn);
    suggestBox.append(li);
  }
  suggestBox.hidden = false;
  return true;
}

channelInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  showError('#channel-error', '');
  const q = channelInput.value.trim();
  // URLs e IDs não precisam de pesquisa; nomes só a partir de 3 caracteres.
  if (q.length < 3 || CHANNEL_ID_RE.test(q) || /youtube\.|youtu\.be/.test(q)) {
    hideSuggest();
    return;
  }
  suggestTimer = setTimeout(() => {
    runSuggest(q).catch(() => { /* autocomplete é conveniência; sem alarme */ });
  }, 350);
});

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.autocomplete')) hideSuggest();
});

$('#channel-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#channel-error', '');
  const raw = channelInput.value.trim();
  const title = $('#channel-title').value.trim();
  let id = null;
  try {
    id = extractChannelId(raw);
  } catch (err) {
    // URL de vídeo é engano claro; qualquer outro texto tratamos como nome a pesquisar.
    const parsed = parseYouTubeUrl(raw);
    if (parsed && parsed.kind === 'video') {
      showError('#channel-error', err.message);
      return;
    }
  }
  try {
    if (!id) {
      const found = await runSuggest(raw);
      if (!found) showError('#channel-error', 'Não encontrei canais com esse nome.');
      return;
    }
    await blockChannelEntry(id, title);
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
    if (IS_STATIC) {
      const blocked = await workerMutateBlocklist('block-keyword', { keyword }, `Bloquear tema: ${keyword}`);
      applyBlocked(blocked);
    } else {
      await api('POST', '/api/admin/block/keyword', { keyword });
      await refreshConfig();
    }
    $('#keyword-form').reset();
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
    if (IS_STATIC) {
      const blocked = await workerMutateBlocklist('block-video', { id, title }, `Bloquear vídeo: ${title || id}`);
      applyBlocked(blocked);
    } else {
      await api('POST', '/api/admin/block/video', { id, title });
      await refreshConfig();
    }
    $('#video-form').reset();
    flash('Vídeo bloqueado.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    showError('#video-error', err.message);
  }
});

// ---------------------------------------------------------------------------
// Definições
// ---------------------------------------------------------------------------

$('#apikey-form')?.addEventListener('submit', async (ev) => {
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

// Resolvedor de streams (reprodução sem anúncios). Fica no localStorage deste
// aparelho — não passa pelo servidor nem pela blocklist partilhada.
const RESOLVER_KEY = 'kidtube-resolver';

function readResolver() {
  try {
    const raw = JSON.parse(localStorage.getItem(RESOLVER_KEY));
    return { base: String(raw?.base || ''), token: String(raw?.token || '') };
  } catch {
    return { base: '', token: '' };
  }
}

function renderResolver() {
  const status = $('#resolver-status');
  if (!status) return;
  const { base, token } = readResolver();
  $('#resolver-base').value = base;
  $('#resolver-token').value = token;
  status.textContent = base
    ? `Ligado a ${base} — os vídeos tocam sem anúncios enquanto este servidor responder.`
    : 'Desligado — os vídeos tocam no player embutido do YouTube, com anúncios.';
}

async function pingResolver({ base, token }) {
  const u = new URL(base.replace(/\/+$/, '') + '/api/ping');
  if (token) u.searchParams.set('t', token);
  const res = await fetch(u.href, { mode: 'cors' });
  if (!res.ok) {
    throw new Error(res.status === 401
      ? 'O servidor respondeu 401 — o token não bate certo.'
      : `O servidor respondeu ${res.status}.`);
  }
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Resposta inesperada do resolvedor.');
  return body;
}

function resolverFromForm() {
  const base = $('#resolver-base').value.trim().replace(/\/+$/, '');
  const token = $('#resolver-token').value.trim();
  if (!/^https?:\/\//.test(base)) {
    throw new Error('O endereço tem de começar por http:// ou https://.');
  }
  return { base, token };
}

$('#resolver-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('#resolver-error', '');
  try {
    const cfg = resolverFromForm();
    await pingResolver(cfg); // não guarda um endereço que nem responde
    localStorage.setItem(RESOLVER_KEY, JSON.stringify(cfg));
    renderResolver();
    flash('Resolvedor guardado — os vídeos passam a tocar sem anúncios.');
  } catch (err) {
    showError('#resolver-error', `Não guardei: ${err.message}`);
  }
});

$('#resolver-test')?.addEventListener('click', async () => {
  showError('#resolver-error', '');
  try {
    const body = await pingResolver(resolverFromForm());
    flash(`Resolvedor a responder (yt-dlp ${body.ytdlp || '?'}).`);
  } catch (err) {
    showError('#resolver-error', `Sem resposta: ${err.message}`);
  }
});

$('#resolver-clear')?.addEventListener('click', () => {
  showError('#resolver-error', '');
  localStorage.removeItem(RESOLVER_KEY);
  renderResolver();
  flash('Resolvedor desligado.');
});

renderResolver();

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
    await setPinCall(pin, {}); // X-Pin atual valida a troca
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
