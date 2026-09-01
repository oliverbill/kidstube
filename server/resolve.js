'use strict';

// resolve.js — resolve o URL de stream directo de um vídeo do YouTube via yt-dlp.
//
// Porquê: no iPad o player embutido nunca é ad-free. O Safari bloqueia cookies de
// terceiros, por isso o iframe é sempre uma sessão anónima e mete anúncios mesmo com
// Premium na conta. A única forma de tocar sem anúncios é não usar o iframe: obtemos
// o URL do ficheiro de vídeo e tocamo-lo num <video> normal.
//
// Preferimos o manifesto HLS que o YouTube serve ao cliente Safari: é adaptativo,
// chega a 1080p e o Safari do iPad toca-o nativamente. Como plano B fica o formato
// progressivo (itag 18, 360p) — o único MP4 com vídeo e áudio no mesmo ficheiro que
// um <video> sabe tocar sem MSE.

const { execFile } = require('node:child_process');

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const CLIENT = process.env.KIDTUBE_YT_CLIENT || 'web_safari';

// Num VPS o IP é de datacenter e o YouTube trata-o como suspeito ("confirma que não
// és um robô"). Com os cookies de uma sessão iniciada, os pedidos são de uma conta
// real e o bloqueio desaparece. Em casa não é preciso.
// Um ficheiro vazio ou inexistente não é erro: em casa não são precisos cookies, e
// no VPS o ficheiro é montado antes de alguém lá pôr a sessão. Passar --cookies a
// apontar para o vazio faria o yt-dlp falhar em todos os vídeos.
const COOKIES = process.env.KIDTUBE_COOKIES || '';
const cookieArgs = (() => {
  if (!COOKIES) return [];
  try {
    if (require('node:fs').statSync(COOKIES).size > 0) return ['--cookies', COOKIES];
  } catch { /* não existe */ }
  console.warn(`resolve: ${COOKIES} vazio ou inexistente — a resolver sem sessão.`);
  return [];
})();
const MAX_HEIGHT = Number(process.env.KIDTUBE_MAX_HEIGHT) || 1080;
const TIMEOUT_MS = Number(process.env.KIDTUBE_RESOLVE_TIMEOUT_MS) || 45_000;

// O URL do googlevideo traz ?expire=<unix>. Descartamo-lo um pouco antes disso para
// que um vídeo comprido não morra a meio por o URL ter caducado durante a reprodução.
const EXPIRY_MARGIN_MS = 5 * 60_000;
const FALLBACK_TTL_MS = 30 * 60_000; // sem expire no URL: assume meia hora

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const cache = new Map();    // videoId -> { info, notAfter }
const inflight = new Map(); // videoId -> Promise<info>

function isVideoId(id) {
  return typeof id === 'string' && VIDEO_ID.test(id);
}

function expiryOf(url) {
  try {
    const u = new URL(url);
    // Progressivo traz ?expire=…; o manifesto HLS traz /expire/…/ no caminho.
    const exp = Number(u.searchParams.get('expire') || (u.pathname.match(/\/expire\/(\d+)/) || [])[1]);
    if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  } catch { /* URL estranho: cai no TTL fixo */ }
  return Date.now() + FALLBACK_TTL_MS;
}

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n').pop();
          if (err.code === 'ENOENT') {
            return reject(Object.assign(
              new Error('yt-dlp não está instalado no servidor (brew install yt-dlp).'),
              { status: 503 }));
          }
          return reject(Object.assign(
            new Error(msg || 'yt-dlp falhou.'), { status: 502 }));
        }
        resolve(String(stdout));
      });
  });
}

// Do HLS interessa o manifesto-mestre (manifest_url), não a variante: é ele que traz
// todas as qualidades e deixa o Safari escolher conforme a ligação.
function pickHls(formats) {
  const cands = formats.filter((f) =>
    f.protocol === 'm3u8_native' && f.manifest_url && (f.height || 0) <= MAX_HEIGHT);
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => ((b.height || 0) > (a.height || 0) ? b : a));
  return {
    url: best.manifest_url,
    kind: 'hls',
    formatId: best.format_id || null,
    height: best.height || null,
    mime: 'application/vnd.apple.mpegurl',
  };
}

function pickProgressive(formats) {
  const cands = formats.filter((f) =>
    f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' &&
    typeof f.url === 'string' && /^https:\/\//.test(f.url) &&
    (f.protocol === 'https' || f.protocol === 'http') &&
    (f.height || 0) <= MAX_HEIGHT);
  if (!cands.length) return null;
  const best = cands.reduce((a, b) => ((b.height || 0) > (a.height || 0) ? b : a));
  return {
    url: best.url,
    kind: 'progressive',
    formatId: best.format_id || null,
    height: best.height || null,
    mime: best.ext === 'webm' ? 'video/webm' : 'video/mp4',
  };
}

async function fetchInfo(videoId) {
  const out = await runYtdlp([
    '--no-warnings', '--no-playlist', '--no-progress', '-J',
    '--extractor-args', `youtube:player_client=${CLIENT}`,
    ...cookieArgs,
    '--', `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  let data;
  try {
    data = JSON.parse(out);
  } catch {
    throw Object.assign(new Error('yt-dlp devolveu JSON inválido.'), { status: 502 });
  }

  const formats = Array.isArray(data.formats) ? data.formats : [];
  const hls = pickHls(formats);
  const prog = pickProgressive(formats);
  const primary = hls || prog;
  if (!primary) {
    throw Object.assign(
      new Error('Nenhum formato reproduzível neste vídeo.'), { status: 502 });
  }

  // O expire vem do URL principal; se o plano B caducar antes, manda o mais curto.
  const expiresAt = Math.min(
    expiryOf(primary.url),
    prog && prog !== primary ? expiryOf(prog.url) : Infinity);

  return {
    videoId,
    title: data.title || null,
    duration: Number(data.duration) || null,
    ...primary,
    // Só há plano B quando o principal é HLS: no proxy só sabemos encaminhar bytes,
    // e reescrever manifestos HLS não vale a complexidade.
    fallback: hls && prog ? prog : null,
    expiresAt,
  };
}

// Devolve o info em cache se ainda for válido; caso contrário resolve (uma vez só,
// mesmo com vários pedidos simultâneos para o mesmo vídeo).
async function resolveStream(videoId) {
  if (!isVideoId(videoId)) {
    throw Object.assign(new Error('Id de vídeo inválido.'), { status: 400 });
  }

  const hit = cache.get(videoId);
  if (hit && hit.notAfter > Date.now()) return hit.info;

  if (inflight.has(videoId)) return inflight.get(videoId);

  const p = fetchInfo(videoId)
    .then((info) => {
      cache.set(videoId, { info, notAfter: info.expiresAt - EXPIRY_MARGIN_MS });
      return info;
    })
    .finally(() => inflight.delete(videoId));

  inflight.set(videoId, p);
  return p;
}

function forget(videoId) {
  cache.delete(videoId);
}

async function version() {
  const out = await runYtdlp(['--version']);
  return out.trim();
}

module.exports = { resolveStream, forget, version, isVideoId };
