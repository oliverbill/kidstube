// KidTube — Worker de administração (PIN + gravação centralizada no GitHub).
//
// Substitui, na variante estática (GitHub Pages), o par "PIN local por
// dispositivo" + "token pessoal do GitHub por dispositivo" que existia em
// admin.js/static-api.js. O PIN passa a viver aqui (KV), partilhado por todos
// os aparelhos; a gravação em blocklist.json usa um GITHUB_TOKEN guardado só
// como secret do Worker — nunca chega ao browser.
//
// Rotas (nenhuma contém a substring "/api/": o shim static-api.js interceta
// qualquer fetch cujo pathname contenha "/api/", mesmo cross-origin):
//   GET  /status           -> { hasPin }
//   POST /pin               { pin } -> 1ª vez define; depois exige X-Pin válido
//   POST /verify            (X-Pin) -> 'ok' | 401 | 429
//   POST /blocklist/mutate  { op, payload, message } (X-Pin) -> { blocked }
//   GET  /oauth/start       -> redireciona para o consentimento do Google
//   GET  /oauth/callback    -> troca code por tokens, grava refresh_token no KV
//   GET  /oauth/status      -> { connected }
//   GET  /subscriptions     -> { channels } (lista real via subscriptions.list)

const GH_OWNER = 'oliverbill';
const GH_REPO = 'kidstube';
const GH_PATH = 'blocklist.json';
const GH_BRANCH = 'main';

const ALLOWED_ORIGIN = 'https://oliverbill.github.io';
// Testar docs/ localmente (ex.: `npx serve docs`) fala de http://localhost:<porta>.
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

const EMPTY_BLOCKLIST = { channels: [], keywords: [], videos: [] };

const ADMIN_URL = 'https://oliverbill.github.io/kidstube/admin.html';
const OAUTH_REDIRECT_URI = 'https://kidstube-admin.alves-bill.workers.dev/oauth/callback';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const OAUTH_STATE_TTL_S = 300;
const SUBS_CACHE_TTL_MS = 30 * 60 * 1000;

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = origin === ALLOWED_ORIGIN || LOCAL_ORIGIN_RE.test(origin) ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Pin',
    Vary: 'Origin',
  };
}

function json(request, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getPinState(env) {
  const raw = await env.PIN_KV.get('state', 'json');
  return raw || { pinHash: null, failures: 0, lockedUntil: 0 };
}

async function putPinState(env, state) {
  await env.PIN_KV.put('state', JSON.stringify(state));
}

// Devolve 'ok' | 'bad' | 'locked'.
async function verifyPin(env, pin) {
  const state = await getPinState(env);
  const lockedFor = state.lockedUntil - Date.now();
  if (lockedFor > 0) return 'locked';

  if (state.pinHash === null || !pin) {
    state.failures += 1;
    if (state.failures >= MAX_FAILURES) {
      state.lockedUntil = Date.now() + LOCK_MS;
      state.failures = 0;
      await putPinState(env, state);
      return 'locked';
    }
    await putPinState(env, state);
    return 'bad';
  }

  if ((await sha256Hex(pin)) === state.pinHash) {
    if (state.failures !== 0) {
      state.failures = 0;
      await putPinState(env, state);
    }
    return 'ok';
  }

  state.failures += 1;
  if (state.failures >= MAX_FAILURES) {
    state.lockedUntil = Date.now() + LOCK_MS;
    state.failures = 0;
    await putPinState(env, state);
    return 'locked';
  }
  await putPinState(env, state);
  return 'bad';
}

// null se autorizado; Response de erro caso contrário.
async function requirePin(env, request) {
  const pin = request.headers.get('X-Pin') || '';
  const result = await verifyPin(env, pin);
  if (result === 'ok') return null;
  if (result === 'locked') {
    return json(request, { error: 'Demasiadas tentativas. Tente novamente dentro de 60 segundos.' }, 429);
  }
  return json(request, { error: 'PIN inválido' }, 401);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// GitHub Contents API
// ---------------------------------------------------------------------------

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kidstube-admin-worker',
  };
}

async function ghReadBlocklist(env) {
  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}?ref=${GH_BRANCH}`,
    { headers: ghHeaders(env), cf: { cacheTtl: 0 } },
  );
  if (!res.ok) throw new Error(`Não consegui ler o blocklist.json do GitHub (${res.status}).`);
  const data = await res.json();
  const decoded = atob(data.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return {
    sha: data.sha,
    blocked: {
      channels: Array.isArray(parsed.channels) ? parsed.channels : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      videos: Array.isArray(parsed.videos) ? parsed.videos : [],
    },
  };
}

async function ghWriteBlocklist(env, blocked, sha, message) {
  const bytes = new TextEncoder().encode(JSON.stringify(blocked, null, 2) + '\n');
  const content = btoa(String.fromCharCode(...bytes));
  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_PATH}`,
    {
      method: 'PUT',
      headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, branch: GH_BRANCH, sha, content }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const conflict = res.status === 409;
    const e = new Error(err.message || `O GitHub recusou a gravação (${res.status}).`);
    e.conflict = conflict;
    throw e;
  }
}

const MUTATIONS = {
  'block-channel': (bl, { id, title }) => {
    if (!bl.channels.some((c) => c.id === id)) bl.channels.push({ id, title: title || '' });
  },
  'unblock-channel': (bl, { id }) => {
    bl.channels = bl.channels.filter((c) => c.id !== id);
  },
  'block-keyword': (bl, { keyword }) => {
    if (!bl.keywords.includes(keyword)) bl.keywords.push(keyword);
  },
  'unblock-keyword': (bl, { keyword }) => {
    bl.keywords = bl.keywords.filter((k) => k !== keyword);
  },
  'block-video': (bl, { id, title }) => {
    if (!bl.videos.some((v) => v.id === id)) bl.videos.push({ id, title: title || '' });
  },
  'unblock-video': (bl, { id }) => {
    bl.videos = bl.videos.filter((v) => v.id !== id);
  },
};

async function mutateBlocklist(env, op, payload, message) {
  const fn = MUTATIONS[op];
  if (!fn) throw new Error(`Operação desconhecida: ${op}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { blocked, sha } = await ghReadBlocklist(env).catch(() => ({ sha: null, blocked: { ...EMPTY_BLOCKLIST } }));
    fn(blocked, payload || {});
    try {
      await ghWriteBlocklist(env, blocked, sha, message);
      return blocked;
    } catch (err) {
      if (err.conflict && attempt === 0) continue; // outro dispositivo gravou entretanto — tenta de novo
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// OAuth Google + subscriptions.list (inscrições reais da conta ligada)
// ---------------------------------------------------------------------------

function randomState() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getGoogleState(env) {
  return (await env.PIN_KV.get('google_oauth', 'json')) || null;
}

async function putGoogleState(env, state) {
  await env.PIN_KV.put('google_oauth', JSON.stringify(state));
}

// Troca o refresh_token por um access_token válido, reaproveitando o guardado
// no KV enquanto não expirar.
async function getGoogleAccessToken(env) {
  const state = await getGoogleState(env);
  if (!state?.refresh_token) return null;
  if (state.access_token && state.expiresAt > Date.now() + 60_000) return state.access_token;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: state.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Falha ao renovar o token do Google.');

  state.access_token = data.access_token;
  state.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await putGoogleState(env, state);
  return state.access_token;
}

async function fetchAllSubscriptions(accessToken) {
  const channels = [];
  let pageToken;
  do {
    const url = new URL('https://www.googleapis.com/youtube/v3/subscriptions');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('order', 'alphabetical');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `subscriptions.list ${res.status}`);
    for (const item of data.items || []) {
      const sn = item.snippet;
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

// Canal da própria família (@danadinhos) — a conta não está inscrita nele (raro um
// dono se autoinscrever), por isso subscriptions.list nunca o traria; fica sempre
// presente, independente do estado real da inscrição.
const PINNED_CHANNELS = [
  {
    id: 'UCNu1shC7iRpk6is5RETRrxg',
    title: 'Os Danadinhos',
    thumbnail: 'https://yt3.ggpht.com/bcxKzSL-P8aFjYMdF2DZH7hYf77JI9W4MkByp7rAhW7O8UI1e7FeHLExupXUF7GbprFZWonQElk=s240-c-k-c0x00ffffff-no-rj',
  },
];

async function getSubscriptionsCached(env) {
  const cached = await env.PIN_KV.get('subs_cache', 'json');
  if (cached && Date.now() - cached.at < SUBS_CACHE_TTL_MS) return cached.channels;

  const accessToken = await getGoogleAccessToken(env);
  const fetched = accessToken ? await fetchAllSubscriptions(accessToken) : [];
  const channels = [
    ...PINNED_CHANNELS,
    ...fetched.filter((c) => !PINNED_CHANNELS.some((p) => p.id === c.id)),
  ];
  await env.PIN_KV.put('subs_cache', JSON.stringify({ at: Date.now(), channels }));
  return channels;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === 'GET' && pathname === '/status') {
        const state = await getPinState(env);
        return json(request, { hasPin: state.pinHash !== null });
      }

      if (request.method === 'POST' && pathname === '/pin') {
        const body = await readBody(request);
        const pin = String(body.pin ?? '');
        if (!pin) return json(request, { error: 'PIN em falta' }, 400);
        const state = await getPinState(env);
        if (state.pinHash !== null) {
          const denied = await requirePin(env, request);
          if (denied) return denied;
        }
        state.pinHash = await sha256Hex(pin);
        state.failures = 0;
        state.lockedUntil = 0;
        await putPinState(env, state);
        return json(request, { ok: true });
      }

      if (request.method === 'POST' && pathname === '/verify') {
        const denied = await requirePin(env, request);
        if (denied) return denied;
        return json(request, { ok: true });
      }

      if (request.method === 'POST' && pathname === '/blocklist/mutate') {
        const denied = await requirePin(env, request);
        if (denied) return denied;
        const body = await readBody(request);
        const blocked = await mutateBlocklist(env, body.op, body.payload, body.message || body.op);
        return json(request, { blocked });
      }

      if (request.method === 'GET' && pathname === '/oauth/start') {
        const state = randomState();
        await env.PIN_KV.put(`oauth_state:${state}`, '1', { expirationTtl: OAUTH_STATE_TTL_S });
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
        authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', GOOGLE_SCOPE);
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('state', state);
        return Response.redirect(authUrl.toString(), 302);
      }

      if (request.method === 'GET' && pathname === '/oauth/callback') {
        const state = url.searchParams.get('state') || '';
        const code = url.searchParams.get('code') || '';
        const stateKey = `oauth_state:${state}`;
        const stateOk = state && await env.PIN_KV.get(stateKey);
        if (!stateOk || !code) return Response.redirect(`${ADMIN_URL}#oauth=erro`, 302);
        await env.PIN_KV.delete(stateKey);

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: OAUTH_REDIRECT_URI,
          }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.refresh_token) {
          return Response.redirect(`${ADMIN_URL}#oauth=erro`, 302);
        }
        await putGoogleState(env, {
          refresh_token: tokenData.refresh_token,
          access_token: tokenData.access_token,
          expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
        });
        await env.PIN_KV.delete('subs_cache'); // força refrescar a lista com a conta nova
        return Response.redirect(`${ADMIN_URL}#oauth=ok`, 302);
      }

      if (request.method === 'GET' && pathname === '/oauth/status') {
        const state = await getGoogleState(env);
        return json(request, { connected: !!state?.refresh_token });
      }

      if (request.method === 'GET' && pathname === '/subscriptions') {
        const channels = await getSubscriptionsCached(env);
        return json(request, { channels });
      }

      return json(request, { error: 'Não encontrado' }, 404);
    } catch (err) {
      return json(request, { error: err.message || 'Erro interno' }, 500);
    }
  },
};
