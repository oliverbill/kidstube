// KidTube — painel de administração
'use strict';

const $ = (sel) => document.querySelector(sel);

const PIN_KEY = 'kidtube-pin';

const state = {
  config: null, // { apiKeySet, blocked: {channels, keywords, videos}, safeSearch }
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

function verifyPinCall(opts) {
  return api('POST', '/api/admin/verify', {}, opts);
}

function setPinCall(pin, opts) {
  return api('POST', '/api/admin/pin', { pin }, opts);
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

async function offerPinReset() {
  const btn = $('#pin-forgot');
  if (!btn) return;
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
  if (token) showPinResetScreen(token);
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
  if (resetToken) {
    showPinResetScreen(resetToken);
    return;
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
  state.config = await api('GET', '/api/admin/config');
  renderLists();
  renderSettings();
  await renderYoutubeAccountStatus();
}

async function renderYoutubeAccountStatus() {
  const el = $('#youtube-account-status');
  const link = $('#youtube-account-connect');
  if (!el || !link) return;
  link.href = '/api/oauth/start';
  try {
    const { connected, configured } = await api('GET', '/api/oauth/status', undefined, { noPin: true });
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
  if (!status) return; // variante estática: bloco da chave removido no build
  if (cfg.apiKeySet) {
    status.innerHTML = '';
    const ok = document.createElement('span');
    ok.className = 'apikey-ok';
    ok.textContent = 'configurada ✓';
    status.append('Chave da API: ', ok, ' — definida em KIDTUBE_API_KEY, no servidor.');
  } else {
    status.textContent =
      'Sem chave — a app está em modo demonstração. Define KIDTUBE_API_KEY no servidor.';
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
  await api('POST', '/api/admin/block/channel', { id, title });
  await refreshConfig();
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
    await api('POST', '/api/admin/block/keyword', { keyword });
    await refreshConfig();
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
    await api('POST', '/api/admin/block/video', { id, title });
    await refreshConfig();
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
