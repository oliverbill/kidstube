#!/usr/bin/env node
// Gerador dos ícones PNG do KidTube — zero dependências (node:zlib + PNG raw).
// Fundo vermelho #cc0000 sólido com triângulo play branco centrado.
// Uso: node make-icons.mjs   (escreve icon-180.png e icon-512.png nesta pasta)

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- CRC32 (tabela clássica) ----
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ---- Rasterização: fundo #cc0000, triângulo play branco ----
// Triângulo: vértices (0.36N, 0.30N), (0.36N, 0.70N), (0.72N, 0.50N).
function raster(size) {
  const bg = [0xcc, 0x00, 0x00];
  const fg = [0xff, 0xff, 0xff];
  const x0 = 0.36 * size, x1 = 0.72 * size;
  const halfH = 0.20 * size, cy = 0.50 * size;
  // 1 byte de filtro (0) + 3 bytes RGB por pixel, por scanline
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let c = bg;
      if (px >= x0 && px <= x1) {
        const allowed = halfH * (x1 - px) / (x1 - x0);
        if (Math.abs(py - cy) <= allowed) c = fg;
      }
      const o = row + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  return raw;
}

function makePng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);      // width
  ihdr.writeUInt32BE(size, 4);      // height
  ihdr[8] = 8;                      // bit depth
  ihdr[9] = 2;                      // color type: truecolor RGB
  ihdr[10] = 0;                     // compression
  ihdr[11] = 0;                     // filter
  ihdr[12] = 0;                     // interlace
  const idat = deflateSync(raster(size), { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [180, 512]) {
  const out = join(HERE, `icon-${size}.png`);
  writeFileSync(out, makePng(size));
  console.log(`escrito ${out}`);
}
