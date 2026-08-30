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

      return json(request, { error: 'Não encontrado' }, 404);
    } catch (err) {
      return json(request, { error: err.message || 'Erro interno' }, 500);
    }
  },
};
