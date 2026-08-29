'use strict';

// Dados mock: 4 canais, 20 vídeos com ids estáveis.
// Usados quando não há apiKey configurada. Passam pelo MESMO pipeline de filtragem.

const CHANNELS = [
  { id: 'mockch-a', title: 'Desenhos do Zé' },
  { id: 'mockch-b', title: 'Ciência Divertida' },
  { id: 'mockch-c', title: 'Mundo dos Jogos' },
  { id: 'mockch-d', title: 'Cantigas da Rita' },
];

function v(id, chIdx, title, description, duration, publishedAt, views) {
  const ch = CHANNELS[chIdx];
  return {
    id,
    title,
    description,
    channelId: ch.id,
    channelTitle: ch.title,
    thumbnail: `/mock-thumb/${id}.svg`,
    duration,
    publishedAt,
    views,
  };
}

const VIDEOS = [
  // mockch-a — Desenhos do Zé
  v('mock-001', 0, 'O Dragão que Não Sabia Voar', 'Um desenho animado sobre um dragão pequenino e os seus amigos.', '7:12', '2026-06-01T10:00:00Z', '154302'),
  v('mock-002', 0, 'A Floresta Encantada — Episódio 1', 'Aventuras na floresta encantada com o Zé e a raposa Rufia.', '11:05', '2026-06-08T10:00:00Z', '98211'),
  v('mock-003', 0, 'O Comboio das Cores', 'Aprende as cores com o comboio mais divertido de sempre.', '5:44', '2026-06-15T10:00:00Z', '203118'),
  v('mock-004', 0, 'A Princesa e o Robô', 'Uma princesa constrói um robô para a ajudar no castelo.', '9:30', '2026-06-22T10:00:00Z', '87654'),
  v('mock-005', 0, 'O Gato Aventureiro vai à Lua', 'O gato aventureiro constrói um foguetão de cartão.', '8:18', '2026-07-01T10:00:00Z', '312450'),
  // mockch-b — Ciência Divertida
  v('mock-006', 1, 'Porque é que o céu é azul?', 'Ciência para crianças: a luz do sol e a atmosfera explicadas de forma simples.', '6:02', '2026-05-20T14:00:00Z', '441209'),
  v('mock-007', 1, 'Experiência: vulcão de bicarbonato', 'Faz um vulcão em casa com bicarbonato e vinagre. Ciência divertida!', '10:41', '2026-05-27T14:00:00Z', '765310'),
  v('mock-008', 1, 'Os planetas do Sistema Solar', 'Viagem pelos oito planetas, do Mercúrio a Neptuno.', '12:34', '2026-06-03T14:00:00Z', '1234567'),
  v('mock-009', 1, 'Como funcionam os ímanes?', 'Magnetismo explicado com experiências simples e seguras.', '7:55', '2026-06-10T14:00:00Z', '98077'),
  v('mock-010', 1, 'Dinossauros: gigantes do passado', 'Tudo sobre os dinossauros mais incríveis que já existiram.', '13:20', '2026-06-17T14:00:00Z', '654321'),
  // mockch-c — Mundo dos Jogos
  v('mock-011', 2, 'Construímos um castelo gigante no Minecraft', 'Gameplay calmo de construção de um castelo bloco a bloco.', '15:47', '2026-07-05T16:00:00Z', '523009'),
  v('mock-012', 2, 'Corrida maluca de karts — quem ganha?', 'Torneio de karts com muitas gargalhadas.', '12:03', '2026-07-12T16:00:00Z', '287640'),
  v('mock-013', 2, 'Puzzle impossível resolvido em 10 minutos', 'Resolvemos o puzzle mais difícil do jogo das caixas.', '10:12', '2026-07-19T16:00:00Z', '134982'),
  v('mock-014', 2, 'Aventura na ilha dos piratas (jogo de plataformas)', 'Exploramos a ilha dos piratas neste jogo de plataformas fofinho.', '14:28', '2026-07-26T16:00:00Z', '76210'),
  v('mock-015', 2, 'Quinta feliz: a nossa horta virtual', 'Plantamos cenouras e cuidamos das galinhas no jogo da quinta.', '11:36', '2026-08-02T16:00:00Z', '45330'),
  // mockch-d — Cantigas da Rita
  v('mock-016', 3, 'A Canção do Abecedário', 'Aprende as letras a cantar com a Rita.', '3:12', '2026-04-10T09:00:00Z', '2103450'),
  v('mock-017', 3, 'Os Números até Dez (música infantil)', 'Conta até dez com esta música cheia de ritmo.', '2:58', '2026-04-17T09:00:00Z', '1876540'),
  v('mock-018', 3, 'Roda Roda Carrossel', 'Uma cantiga de roda para dançar em família.', '3:45', '2026-04-24T09:00:00Z', '954120'),
  v('mock-019', 3, 'A Banda dos Animais', 'Cada animal toca um instrumento nesta canção divertida.', '4:21', '2026-05-01T09:00:00Z', '673201'),
  v('mock-020', 3, 'Boa Noite, Estrelinha (canção de embalar)', 'Uma canção suave para adormecer.', '5:03', '2026-05-08T09:00:00Z', '1450998'),
];

module.exports = { CHANNELS, VIDEOS };
