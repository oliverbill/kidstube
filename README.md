# KidTube — YouTube filtrado para iPad

Clone do YouTube com controlo parental: bloqueia **canais**, **temas (palavras-chave)** e
**vídeos específicos**. O filtro corre no servidor, por isso não é contornável a partir do iPad.

## Arrancar

```sh
node server/server.js
```

Servidor em `http://<ip-do-mac>:8478`. Sem dependências npm — só Node ≥ 18.

## Instalar no iPad

1. No Safari do iPad (na mesma rede Wi‑Fi), abre `http://<ip-do-mac>:8478`.
2. Partilhar → **Adicionar ao ecrã principal**. Fica como app ("KidTube").

## Configurar

1. Abre a engrenagem (canto superior direito) → define o **PIN** parental na primeira vez.
2. Em **Definições**, cola a tua **chave da YouTube Data API v3**
   (console.cloud.google.com → ativar *YouTube Data API v3* → Credenciais → API key).
   Sem chave, a app funciona em **modo demonstração** com vídeos fictícios.
3. Gere as listas nas tabs: canais, temas (palavras‑chave) e vídeos bloqueados.
   Canais e vídeos aceitam URLs do YouTube coladas diretamente.

## Como funciona o bloqueio

- Toda a navegação passa pela API local (`/api/...`); o servidor remove qualquer vídeo cujo
  canal, id ou texto (título/descrição/canal) bata numa regra, antes de responder ao iPad.
- Pesquisas cujo termo contenha uma palavra‑chave bloqueada devolvem zero resultados.
- A reprodução usa o player embutido oficial (`youtube-nocookie.com`) com `rel=0`, que limita
  as sugestões de fim de vídeo ao mesmo canal.

## Variante estática (GitHub Pages)

`docs/` contém uma versão 100% estática, montada por `node scripts/build-static.mjs`:
o `static-api.js` implementa a API no próprio browser (YouTube API direta + listas e PIN em
`localStorage`). Serve para publicar em https://oliverbill.github.io/youtube-filter/ — mas o
filtro passa a correr **no cliente**: num iPad de criança é eficaz na prática, mas quem tiver
acesso técnico ao browser consegue inspecioná-lo. A versão com servidor continua a ser a mais
blindada. A chave API é introduzida na administração e fica só no `localStorage` do dispositivo
(nunca é publicada); restringe-a por referrer HTTP no Google Cloud Console.

## Limitações honestas

- O ecrã final do player embutido ainda mostra vídeos do mesmo canal (comportamento do YouTube,
  não filtrável). Bloquear o canal inteiro resolve.
- As listas guardam-se em `data/config.json` neste Mac; faz backup se quiseres.
