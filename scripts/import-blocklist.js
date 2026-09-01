'use strict';

// Importa blocklist.json (a lista partilhada da variante do GitHub Pages) para o
// store do servidor. Serve a migração para o VPS: o servidor passa a ser a única
// fonte dos bloqueios, e nada do que já estava bloqueado se perde.
//
//   node scripts/import-blocklist.js [caminho/para/blocklist.json]
//
// Idempotente: correr duas vezes não duplica nada.

const path = require('node:path');
const store = require('../server/store');

const file = process.argv[2] || path.join(__dirname, '..', 'blocklist.json');
const list = require(path.resolve(file));

let novos = 0;
let jaLa = 0;

function conta(antes, depois) {
  if (depois > antes) novos += 1;
  else jaLa += 1;
}

for (const c of list.channels || []) {
  const antes = store.getConfig().blocked.channels.length;
  store.blockChannel(String(c.id), c.title);
  conta(antes, store.getConfig().blocked.channels.length);
}
for (const k of list.keywords || []) {
  const antes = store.getConfig().blocked.keywords.length;
  store.blockKeyword(typeof k === 'string' ? k : k.keyword);
  conta(antes, store.getConfig().blocked.keywords.length);
}
for (const v of list.videos || []) {
  const antes = store.getConfig().blocked.videos.length;
  store.blockVideo(String(v.id), v.title);
  conta(antes, store.getConfig().blocked.videos.length);
}

const b = store.getConfig().blocked;
console.log(`Importados ${novos} novos, ${jaLa} já existiam.`);
console.log(`Total no servidor: ${b.channels.length} canais, ${b.keywords.length} temas, ${b.videos.length} vídeos.`);
