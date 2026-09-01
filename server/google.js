'use strict';

// google.js — OAuth com a conta do YouTube e a lista de inscrições.
//
// Porta para o servidor o que vivia no Worker (worker/src/index.js). Na variante
// do GitHub Pages o Worker era necessário porque não havia servidor nenhum onde
// guardar um refresh_token; servida a app do VPS, o servidor é o sítio natural.
//
// O refresh_token fica num ficheiro só de leitura para o dono do processo — é ele
// que dá acesso de leitura à conta do YouTube, e nunca chega ao browser.

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = process.env.KIDTUBE_GOOGLE_STATE
  || path.join(__dirname, '..', '.google-oauth.json');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const STATE_TTL_MS = 5 * 60_000;
const SUBS_CACHE_TTL_MS = 30 * 60_000;

// Canal da própria família (@danadinhos): a conta não está inscrita nele, por isso
// subscriptions.list nunca o traria. Fica sempre presente.
const PINNED_CHANNELS = [
  {
    id: 'UCNu1shC7iRpk6is5RETRrxg',
    title: 'Os Danadinhos',
    thumbnail: 'https://yt3.ggpht.com/bcxKzSL-P8aFjYMdF2DZH7hYf77JI9W4MkByp7rAhW7O8UI1e7FeHLExupXUF7GbprFZWonQElk=s240-c-k-c0x00ffffff-no-rj',
  },
];

function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// Os `state` do OAuth vivem em memória: são válidos 5 minutos e um reinício do
// servidor a meio de um consentimento só custa repetir o clique.
const pendingStates = new Map();

function newState() {
  const s = require('node:crypto').randomBytes(16).toString('hex');
  pendingStates.set(s, Date.now() + STATE_TTL_MS);
  for (const [k, exp] of pendingStates) if (exp < Date.now()) pendingStates.delete(k);
  return s;
}

function consumeState(s) {
  const exp = pendingStates.get(s);
  if (!exp || exp < Date.now()) return false;
  pendingStates.delete(s);
  return true;
}

function authUrl(redirectUri) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', newState());
  return u.href;
}

async function exchangeCode(code, state, redirectUri) {
  if (!consumeState(state)) throw new Error('Pedido de consentimento inválido ou expirado.');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || 'O Google não devolveu refresh_token.');
  }

  writeState({
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  subsCache = null; // conta nova, lista nova
}

function connected() {
  return Boolean(readState().refresh_token);
}

async function accessToken() {
  const state = readState();
  if (!state.refresh_token) return null;
  if (state.access_token && state.expiresAt > Date.now() + 60_000) return state.access_token;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: state.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Falha ao renovar o token do Google.');

  state.access_token = data.access_token;
  state.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  writeState(state);
  return state.access_token;
}

async function fetchAllSubscriptions(token) {
  const channels = [];
  let pageToken;
  do {
    const u = new URL('https://www.googleapis.com/youtube/v3/subscriptions');
    u.searchParams.set('part', 'snippet');
    u.searchParams.set('mine', 'true');
    u.searchParams.set('maxResults', '50');
    u.searchParams.set('order', 'alphabetical');
    if (pageToken) u.searchParams.set('pageToken', pageToken);

    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `subscriptions.list ${res.status}`);

    for (const item of data.items || []) {
      const sn = item.snippet || {};
      channels.push({
        id: sn.resourceId?.channelId,
        title: sn.title || '',
        thumbnail: sn.thumbnails?.default?.url || sn.thumbnails?.medium?.url || '',
      });
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return channels.filter((c) => c.id);
}

let subsCache = null; // { at, channels }

async function subscriptions() {
  if (subsCache && Date.now() - subsCache.at < SUBS_CACHE_TTL_MS) return subsCache.channels;

  const token = await accessToken();
  const fetched = token ? await fetchAllSubscriptions(token) : [];
  const channels = [
    ...PINNED_CHANNELS,
    ...fetched.filter((c) => !PINNED_CHANNELS.some((p) => p.id === c.id)),
  ];
  subsCache = { at: Date.now(), channels };
  return channels;
}

module.exports = { configured, connected, authUrl, exchangeCode, subscriptions };
