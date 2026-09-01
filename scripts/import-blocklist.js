'use strict';

// Importa blocklist.json (a lista partilhada da variante do GitHub Pages) para o
// store do servidor. Serve a migração para o VPS: o servidor passa a ser a única
// fonte dos bloqueios, e nada do que já estava bloqueado se perde.
//
//   node scripts/import-blocklist.js [caminho/para/blocklist.json]
//
// Idempotente: correr duas vezes não duplica nada.
//
// ATENÇÃO: corre num processo à parte do servidor, que tem a configuração em
// memória. Escrever aqui não avisa quem está a correr — e a próxima gravação do
// servidor sobrepõe-se ao que este script escreveu. Por isso o container é
// reiniciado no fim, para o servidor reler o ficheiro.

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
if (novos > 0) {
  console.log('\nReinicia o servidor para ele reler o ficheiro, senão a próxima');
  console.log('gravação no painel sobrepõe-se a esta importação:');
  console.log('  docker compose -f deploy/docker-compose.yml restart');
}
