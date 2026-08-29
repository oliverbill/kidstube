'use strict';

// server.js — servidor HTTP: estáticos de public/, /api/*, /mock-thumb/*.
// Node 22, zero dependências. Log por pedido: "method path status ms".

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
const yt = require('./youtube');
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
    });
  }

  if (method === 'GET' && p === '/api/home') {
    const items = await yt.home();
    return sendJson(res, 200, { items });
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
  console.log(`youtube-filter a escutar em http://localhost:${PORT} (mock=${yt.usingMock()})`);
});
