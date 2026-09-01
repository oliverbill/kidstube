'use strict';

// server.js — servidor HTTP: estáticos de public/, /api/*, /mock-thumb/*.
// Node 22, zero dependências. Log por pedido: "method path status ms".

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
const yt = require('./youtube');
const resolve = require('./resolve');
const hls = require('./hls');
const google = require('./google');
const mailer = require('./mailer');
const mockdata = require('./mockdata');

const PORT = Number(process.env.PORT) || 8478;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------- Helpers de resposta ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(Object.assign(new Error('Corpo demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Valida o X-Pin. Devolve true se ok; caso contrário responde 401/429 e devolve false.
function requirePin(req, res) {
  if (store.pinLockedForMs() > 0) {
    sendError(res, 429, 'Demasiadas tentativas. Tente novamente dentro de 60 segundos.');
    return false;
  }
  const pin = req.headers['x-pin'];
  const result = store.verifyPin(pin);
  if (result === 'ok') return true;
  if (result === 'locked') {
    sendError(res, 429, 'Demasiadas tentativas. Tente novamente dentro de 60 segundos.');
  } else {
    sendError(res, 401, 'PIN inválido.');
  }
  return false;
}

// ---------- Estáticos ----------

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendError(res, 403, 'Proibido');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendError(res, 404, 'Não encontrado');
    return;
  }
  if (stat.isDirectory()) {
    sendError(res, 404, 'Não encontrado');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- Thumbnails mock (SVG com título) ----------

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MOCK_COLORS = {
  'mockch-a': '#7c4dff',
  'mockch-b': '#00897b',
  'mockch-c': '#e65100',
  'mockch-d': '#c2185b',
};

function serveMockThumb(res, id) {
  const video = mockdata.VIDEOS.find((v) => v.id === id);
  const title = video ? video.title : id;
  const bg = (video && MOCK_COLORS[video.channelId]) || '#37474f';
  const words = escapeXml(title).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 28) {
      lines.push(line.trim());
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  const tspans = lines
    .slice(0, 3)
    .map((l, i) => `<tspan x="160" dy="${i === 0 ? 0 : 26}">${l}</tspan>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
<rect width="320" height="180" fill="${bg}"/>
<circle cx="160" cy="66" r="26" fill="rgba(255,255,255,0.25)"/>
<polygon points="152,52 152,80 176,66" fill="#ffffff"/>
<text x="160" y="118" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#ffffff">${tspans}</text>
</svg>`;
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(svg);
}

// ---------- Resolvedor de streams (reprodução sem anúncios) ----------
//
// Estas rotas são as únicas com CORS: são chamadas a partir do site publicado
// (GitHub Pages), que tem outra origem. Se KIDTUBE_RESOLVER_TOKEN estiver definido,
// exigem o token — o resolvedor fica exposto em HTTPS pelo túnel e sem token seria
// um yt-dlp aberto ao mundo.

const RESOLVER_TOKEN = process.env.KIDTUBE_RESOLVER_TOKEN || '';
const RESOLVER_ONLY = process.env.KIDTUBE_RESOLVER_ONLY === '1';

// Endereço público do serviço. Atrás do túnel o pedido chega em http, daí o
// X-Forwarded-Proto — e o KIDTUBE_PUBLIC_URL manda quando está definido.
function publicBase(req) {
  if (process.env.KIDTUBE_PUBLIC_URL) return process.env.KIDTUBE_PUBLIC_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// O Google exige que o redirect_uri seja exactamente o registado na consola.
function oauthRedirectUri(req) {
  return `${publicBase(req)}/api/oauth/callback`;
}

// "alves.bill@gmail.com" -> "al•••@gmail.com". Confirma a caixa certa a quem já a
// conhece, sem a revelar a quem abriu a página de administração por acaso.
function maskEmail(addr) {
  const m = String(addr || '').match(/^(.{1,2})[^@]*(@.+)$/);
  return m ? `${m[1]}•••${m[2]}` : '';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.KIDTUBE_ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'X-Resolver-Token, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
  };
}

function sendCorsJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Servida a app da Internet, as rotas do resolvedor são públicas — um token no
// browser de toda a gente não é segredo nenhum. O que impede isto de ser um
// descarregador de YouTube aberto ao mundo é o limite por IP: cada resolução custa
// um yt-dlp, e um visitante normal vê dezenas de vídeos por dia, não milhares.
const RATE_MAX = Number(process.env.KIDTUBE_RESOLVE_RATE) || 40;
const RATE_WINDOW_MS = 10 * 60_000;
const rateHits = new Map();

function clientIp(req) {
  if (process.env.KIDTUBE_TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'desconhecido';
}

function rateLimited(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const hits = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateHits.set(ip, hits);
  if (rateHits.size > 5000) rateHits.clear(); // rede: não crescer sem limite
  return hits.length > RATE_MAX;
}

function tokenOk(req, url) {
  if (!RESOLVER_TOKEN) return true;
  const given = req.headers['x-resolver-token'] || url.searchParams.get('t') || '';
  return String(given) === RESOLVER_TOKEN;
}

// Encaminha os bytes do googlevideo através daqui. Só é usado quando o iPad não
// consegue ler o URL directo — acontece quando o YouTube prende o URL ao IP de quem
// o resolveu. Preserva o Range, senão não há como saltar no vídeo.
async function proxyStream(req, res, info) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetch(info.url, { headers, redirect: 'follow' });
  const out = { ...corsHeaders(), 'Cache-Control': 'no-store' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  if (!out['content-type']) out['content-type'] = info.mime;
  res.writeHead(upstream.status, out);

  if (req.method === 'HEAD' || !upstream.body) return res.end();
  const { Readable } = require('node:stream');
  const body = Readable.fromWeb(upstream.body);
  req.on('close', () => body.destroy());
  body.pipe(res);
}

// Encaminha uma playlist HLS, reescrevendo cada URI lá dentro para voltar aqui.
async function proxyPlaylist(res, target, token) {
  const upstream = await fetch(target, { redirect: 'follow' });
  if (!upstream.ok) {
    sendCorsJson(res, upstream.status, { error: `O YouTube respondeu ${upstream.status}.` });
    return;
  }
  // O URL final (depois de redirecionamentos) é a base certa para os URIs relativos.
  const base = upstream.url || target;
  const text = await upstream.text();

  const suffix = token ? `&t=${encodeURIComponent(token)}` : '';
  const body = hls.rewritePlaylist(text, base, (abs, isPlaylist) =>
    `/api/hls/${isPlaylist ? 'playlist.m3u8' : 'segment'}?u=${hls.encodeTarget(abs)}${suffix}`);

  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Devolve true se tratou o pedido.
async function handleResolver(req, res, url) {
  const p = url.pathname;
  const isPing = p === '/api/ping';
  const stream = p.match(/^\/api\/stream\/([^/]+)(\/proxy)?$/);
  const hlsMaster = p.match(/^\/api\/hls\/([^/]+)\/master\.m3u8$/);
  const hlsPlaylist = p === '/api/hls/playlist.m3u8';
  const hlsSegment = p === '/api/hls/segment';
  if (!isPing && !stream && !hlsMaster && !hlsPlaylist && !hlsSegment) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendCorsJson(res, 405, { error: 'Método não permitido.' });
    return true;
  }
  if (!tokenOk(req, url)) {
    sendCorsJson(res, 401, { error: 'Token do resolvedor inválido.' });
    return true;
  }

  try {
    if (isPing) {
      sendCorsJson(res, 200, { ok: true, ytdlp: await resolve.version() });
      return true;
    }

    if (hlsPlaylist) {
      await proxyPlaylist(res, hls.decodeTarget(url.searchParams.get('u')), RESOLVER_TOKEN);
      return true;
    }

    if (hlsSegment) {
      const target = hls.decodeTarget(url.searchParams.get('u'));
      await proxyStream(req, res, { url: target, mime: 'video/mp4' });
      return true;
    }

    if (hlsMaster) {
      const info = await resolve.resolveStream(decodeURIComponent(hlsMaster[1]));
      if (info.kind !== 'hls') {
        sendCorsJson(res, 409, { error: 'Este vídeo não tem HLS.' });
        return true;
      }
      await proxyPlaylist(res, info.url, RESOLVER_TOKEN);
      return true;
    }

    // Só a resolução conta para o limite: playlists e segmentos são a continuação
    // de um vídeo já autorizado, e cortá-los a meio seria cortar a reprodução.
    if (rateLimited(req)) {
      sendCorsJson(res, 429, { error: 'Demasiados vídeos em pouco tempo. Tenta daqui a pouco.' });
      return true;
    }

    const videoId = decodeURIComponent(stream[1]);
    const wantsProxy = Boolean(stream[2]);
    // No proxy o cache pode ter um URL que o upstream já rejeita; ?fresh=1 força
    // uma resolução nova antes de desistir.
    if (url.searchParams.get('fresh') === '1') resolve.forget(videoId);
    const info = await resolve.resolveStream(videoId);

    if (wantsProxy) {
      // Um manifesto HLS não se encaminha por aqui (os segmentos apontariam para o
      // googlevideo na mesma) — o proxy serve sempre o progressivo.
      const target = info.kind === 'hls' ? info.fallback : info;
      if (!target) {
        sendCorsJson(res, 409, { error: 'Este vídeo não tem formato progressivo.' });
        return true;
      }
      await proxyStream(req, res, target);
      return true;
    }
    sendCorsJson(res, 200, {
      videoId: info.videoId,
      url: info.url,
      kind: info.kind,
      mime: info.mime,
      height: info.height,
      formatId: info.formatId,
      duration: info.duration,
      fallback: info.fallback
        ? { url: info.fallback.url, kind: 'progressive', mime: info.fallback.mime, height: info.fallback.height }
        : null,
      expiresAt: info.expiresAt,
    });
  } catch (err) {
    console.error('resolver:', err.message);
    if (!res.headersSent) {
      sendCorsJson(res, err.status || 500, { error: err.message || 'Erro no resolvedor.' });
    } else {
      res.end();
    }
  }
  return true;
}

// ---------- Router da API ----------

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // -------- Público --------

  if (method === 'GET' && p === '/api/status') {
    const cfg = store.getConfig();
    return sendJson(res, 200, {
      hasApiKey: Boolean(cfg.apiKey),
      hasPin: store.hasPin(),
      mock: yt.usingMock(),
      // Diz à app que este servidor resolve streams: servida daqui, ela usa o
      // resolvedor da própria origem e não precisa de configuração nenhuma.
      resolver: !RESOLVER_ONLY,
    });
  }

  // -------- Conta do YouTube (OAuth) e inscrições --------

  if (method === 'GET' && p === '/api/oauth/status') {
    return sendJson(res, 200, {
      configured: google.configured(),
      connected: google.connected(),
    });
  }

  if (method === 'GET' && p === '/api/oauth/start') {
    if (!google.configured()) return sendError(res, 503, 'OAuth não configurado no servidor.');
    res.writeHead(302, { Location: google.authUrl(oauthRedirectUri(req)) });
    return res.end();
  }

  if (method === 'GET' && p === '/api/oauth/callback') {
    try {
      await google.exchangeCode(
        url.searchParams.get('code') || '',
        url.searchParams.get('state') || '',
        oauthRedirectUri(req));
      res.writeHead(302, { Location: '/admin.html#oauth=ok' });
    } catch (err) {
      console.error('oauth:', err.message);
      res.writeHead(302, { Location: '/admin.html#oauth=erro' });
    }
    return res.end();
  }

  if (method === 'GET' && p === '/api/subscriptions') {
    const blockedIds = new Set((store.getConfig().blocked.channels || []).map((c) => c.id));
    const channels = (await google.subscriptions()).filter((c) => !blockedIds.has(c.id));
    return sendJson(res, 200, { channels });
  }

  if (method === 'GET' && p === '/api/home') {
    const pageToken = url.searchParams.get('pageToken') || undefined;
    const result = await yt.home(pageToken);
    return sendJson(res, 200, result);
  }

  if (method === 'GET' && p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendError(res, 400, 'Parâmetro q em falta.');
    const pageToken = url.searchParams.get('pageToken') || undefined;
    const result = await yt.search(q, pageToken);
    return sendJson(res, 200, result);
  }

  let m = p.match(/^\/api\/video\/([^/]+)$/);
  if (method === 'GET' && m) {
    const result = await yt.videoDetails(decodeURIComponent(m[1]));
    return sendJson(res, 200, result);
  }

  m = p.match(/^\/api\/channel\/([^/]+)$/);
  if (method === 'GET' && m) {
    const pageToken = url.searchParams.get('pageToken') || undefined;
    const result = await yt.channel(decodeURIComponent(m[1]), pageToken);
    return sendJson(res, 200, result);
  }

  // -------- Admin --------

  if (method === 'POST' && p === '/api/admin/pin') {
    const body = await readBody(req);
    const pin = String(body.pin ?? '').trim();
    if (!pin) return sendError(res, 400, 'PIN em falta.');
    if (store.hasPin()) {
      if (!requirePin(req, res)) return;
    }
    store.setPin(pin);
    return sendJson(res, 200, { ok: true });
  }

  // Reposição do PIN por email. Públicas por necessidade — quem esqueceu o PIN não
  // o pode provar. O que as segura: o email vai sempre para o endereço fixo em
  // KIDTUBE_RESET_EMAIL (nunca para um indicado no pedido) e há um intervalo mínimo
  // entre pedidos, para isto não servir de máquina de spam contra essa caixa.

  if (method === 'GET' && p === '/api/admin/pin/reset') {
    return sendJson(res, 200, {
      available: mailer.configured() && Boolean(mailer.recipient()),
      hint: maskEmail(mailer.recipient()),
    });
  }

  if (method === 'POST' && p === '/api/admin/pin/reset/request') {
    const to = mailer.recipient();
    if (!mailer.configured() || !to) {
      return sendError(res, 503, 'Reposição por email não configurada no servidor.');
    }
    const espera = store.resetCooldownMs();
    if (espera > 0) {
      return sendError(res, 429,
        `Já foi enviado um email há pouco. Tenta daqui a ${Math.ceil(espera / 60000)} min.`);
    }

    const token = store.createPinReset();
    const link = `${publicBase(req)}/admin.html#reset=${token}`;
    try {
      await mailer.send({
        to,
        subject: 'KidTube — repor o PIN parental',
        text: [
          'Foi pedida a reposição do PIN parental do KidTube.',
          '',
          'Abre este link para definir um PIN novo (válido 15 minutos, uma só vez):',
          link,
          '',
          'Se não foste tu, ignora este email: sem este link o PIN não muda.',
        ].join('\n'),
      });
    } catch (err) {
      console.error('reset:', err.message);
      return sendError(res, 502, 'Não foi possível enviar o email. Ver os registos do servidor.');
    }
    store.markPinResetSent();
    return sendJson(res, 200, { ok: true, hint: maskEmail(to) });
  }

  if (method === 'POST' && p === '/api/admin/pin/reset/confirm') {
    const body = await readBody(req);
    const pin = String(body.pin ?? '').trim();
    if (pin.length < 4) return sendError(res, 400, 'O PIN tem de ter pelo menos 4 dígitos.');
    if (store.consumePinReset(String(body.token || ''), pin) !== 'ok') {
      return sendError(res, 400, 'Link inválido ou expirado. Pede um email novo.');
    }
    console.log('PIN reposto por email.');
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/admin/verify') {
    if (!requirePin(req, res)) return;
    return sendJson(res, 200, { ok: true });
  }

  // Todas as restantes rotas admin exigem PIN válido.
  if (p.startsWith('/api/admin/')) {
    if (!requirePin(req, res)) return;
  }

  if (method === 'GET' && p === '/api/admin/search/channels') {
    return sendJson(res, 200, await yt.searchChannels(url.searchParams.get('q') || ''));
  }

  if (method === 'GET' && p === '/api/admin/config') {
    const cfg = store.getConfig();
    return sendJson(res, 200, {
      apiKeySet: Boolean(cfg.apiKey),
      blocked: cfg.blocked,
      safeSearch: cfg.safeSearch,
    });
  }

  if (method === 'POST' && p === '/api/admin/apikey') {
    const body = await readBody(req);
    store.setApiKey(body.apiKey);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/admin/block/channel') {
    const body = await readBody(req);
    if (!body.id) return sendError(res, 400, 'id em falta.');
    store.blockChannel(String(body.id), body.title);
    return sendJson(res, 200, { ok: true });
  }

  m = p.match(/^\/api\/admin\/block\/channel\/([^/]+)$/);
  if (method === 'DELETE' && m) {
    store.unblockChannel(decodeURIComponent(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/admin/block/keyword') {
    const body = await readBody(req);
    const kw = String(body.keyword || '').trim();
    if (!kw) return sendError(res, 400, 'keyword em falta.');
    store.blockKeyword(kw);
    return sendJson(res, 200, { ok: true });
  }

  m = p.match(/^\/api\/admin\/block\/keyword\/([^/]+)$/);
  if (method === 'DELETE' && m) {
    store.unblockKeyword(decodeURIComponent(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/admin/block/video') {
    const body = await readBody(req);
    if (!body.id) return sendError(res, 400, 'id em falta.');
    store.blockVideo(String(body.id), body.title);
    return sendJson(res, 200, { ok: true });
  }

  m = p.match(/^\/api\/admin\/block\/video\/([^/]+)$/);
  if (method === 'DELETE' && m) {
    store.unblockVideo(decodeURIComponent(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'Rota não encontrada.');
}

// ---------- Servidor ----------

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
  });

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendError(res, 400, 'URL inválido.');
  }

  try {
    if (await handleResolver(req, res, url)) return;
    // No VPS o servidor é só resolvedor: a app vem do GitHub Pages e a administração
    // não tem nada que estar exposta na Internet.
    if (RESOLVER_ONLY) return sendError(res, 404, 'Rota não encontrada.');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    const thumb = url.pathname.match(/^\/mock-thumb\/([^/]+)\.svg$/);
    if (thumb) {
      serveMockThumb(res, decodeURIComponent(thumb[1]));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'Método não permitido.');
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) sendError(res, status, err.message || 'Erro interno.');
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`kidstube a escutar em http://localhost:${PORT} (mock=${yt.usingMock()})`);
});
