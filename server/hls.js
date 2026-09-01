'use strict';

// hls.js — reescrita de playlists HLS para as servir através deste servidor.
//
// Porquê: o URL que o YouTube devolve traz o IP de quem o pediu lá dentro
// (/ip/<addr>/). Com o resolvedor num VPS, quem pede é o VPS e quem toca é o iPad —
// IPs diferentes. Quando o YouTube impõe essa ligação, o iPad não consegue ler o
// stream directamente e os bytes têm de passar por aqui.
//
// Encaminhar HLS não é encaminhar um ficheiro: a playlist é texto que aponta para
// outras playlists e para os segmentos. Se só encaminhássemos o texto, o iPad ia
// buscar os segmentos ao googlevideo à mesma e voltava ao mesmo problema. Por isso
// cada URI dentro da playlist é reescrito para voltar cá.

// Tudo o que sai daqui é buscado pelo servidor a um URL que veio do cliente — sem
// esta barreira, o resolvedor seria um proxy aberto para qualquer endereço (SSRF).
function isGoogleVideo(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)googlevideo\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

function encodeTarget(url) {
  return Buffer.from(url, 'utf8').toString('base64url');
}

function decodeTarget(encoded) {
  const url = Buffer.from(String(encoded || ''), 'base64url').toString('utf8');
  if (!isGoogleVideo(url)) {
    throw Object.assign(new Error('Destino não permitido.'), { status: 400 });
  }
  return url;
}

// Um URI numa playlist pode ser relativo — resolve-se contra o URL da própria
// playlist, tal como o player faria.
function absolutize(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return null;
  }
}

// Reescreve todos os URIs de uma playlist. `route(absoluteUrl, isPlaylist)` devolve
// o URL local que os substitui.
function rewritePlaylist(text, baseUrl, route) {
  const out = [];

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');

    // Linha de tag com URI="…" — #EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP.
    if (line.startsWith('#') && line.includes('URI="')) {
      out.push(line.replace(/URI="([^"]+)"/g, (whole, uri) => {
        const abs = absolutize(uri, baseUrl);
        if (!abs || !isGoogleVideo(abs)) return whole;
        // #EXT-X-MEDIA aponta para outra playlist; #EXT-X-KEY e #EXT-X-MAP não.
        return `URI="${route(abs, line.startsWith('#EXT-X-MEDIA'))}"`;
      }));
      continue;
    }

    if (line.startsWith('#') || line.trim() === '') {
      out.push(line);
      continue;
    }

    // Linha de URI solta: uma variante (no master) ou um segmento (na media).
    const abs = absolutize(line.trim(), baseUrl);
    if (!abs || !isGoogleVideo(abs)) {
      out.push(line);
      continue;
    }
    // Uma playlist aponta para outra playlist só no master; o master distingue-se
    // por trazer variantes (#EXT-X-STREAM-INF antes da linha).
    const prev = out[out.length - 1] || '';
    out.push(route(abs, prev.startsWith('#EXT-X-STREAM-INF')));
  }

  return out.join('\n');
}

module.exports = { isGoogleVideo, encodeTarget, decodeTarget, rewritePlaylist };
