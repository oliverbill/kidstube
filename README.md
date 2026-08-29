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

O painel de administração não tem link nenhum dentro da app — abre-o digitando o URL
diretamente: `http://<ip-do-mac>:8478/admin.html`.

1. Define o **PIN** parental na primeira vez.
2. Em **Definições**, cola a tua **chave da YouTube Data API v3**
   (console.cloud.google.com → ativar *YouTube Data API v3* → Credenciais → API key).
   Sem chave, a app funciona em **modo demonstração** com vídeos fictícios.
3. Gere as listas nas tabs: canais, temas (palavras‑chave) e vídeos bloqueados.
   Canais e vídeos aceitam URLs do YouTube coladas diretamente, ou o nome (autocomplete).

## Como funciona o bloqueio

- Toda a navegação passa pela API local (`/api/...`); o servidor remove qualquer vídeo cujo
  canal, id ou texto (título/descrição/canal) bata numa regra, antes de responder ao iPad.
- Pesquisas cujo termo contenha uma palavra‑chave bloqueada devolvem zero resultados.
- A reprodução usa o player embutido oficial (`youtube-nocookie.com`) com `rel=0`, que limita
  as sugestões de fim de vídeo ao mesmo canal.

## Variante estática (GitHub Pages)

O deploy é feito pelo workflow `.github/workflows/deploy-pages.yml` a cada push no `main`:
monta o site com `node scripts/build-static.mjs` e injeta a chave fixa a partir do secret
`YOUTUBE_API_KEY` do repositório (`gh secret set YOUTUBE_API_KEY`) — os dispositivos não
precisam de colar chave nenhuma; uma chave colada na administração sobrepõe-se à fixa.
O `docs/` é gerado no CI (está no .gitignore); a versão estática: o `static-api.js`
implementa a API no próprio browser (YouTube API direta, PIN em `localStorage`). Serve para
publicar em https://oliverbill.github.io/youtube-filter/ — mas o filtro passa a correr **no
cliente**: num iPad de criança é eficaz na prática, mas quem tiver acesso técnico ao browser
consegue inspecioná-lo. A versão com servidor continua a ser a mais blindada. A chave API é
introduzida na administração e fica só no `localStorage` do dispositivo (nunca é publicada);
restringe-a por referrer HTTP no Google Cloud Console.

### Bloqueio centralizado (todos os dispositivos)

Ao contrário do servidor Node (bloqueio local, por máquina), a variante estática guarda os
bloqueios em **`blocklist.json`** na raiz do repositório — público, lido por todos os iPads
via `raw.githubusercontent.com`. Um bloqueio feito num dispositivo aplica-se a todos os outros
com a app instalada, ao fim de alguns minutos (cache de 5 min + cache do CDN do GitHub).

Para **gravar** bloqueios a partir do painel (não é preciso para ler/navegar):

1. Cria um token em
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new),
   com acesso restrito ao repositório `youtube-filter` e permissão **Contents: Read and write**.
2. No painel de administração (`.../admin.html`, PIN necessário) → **Definições** → cola o
   token em "Token do GitHub". Fica só no `localStorage` desse dispositivo — nunca é publicado
   nem sai daí.
3. Cada bloqueio/desbloqueio passa a ser um commit no repositório (mensagem tipo
   "Bloquear canal: X"), visível no histórico do GitHub.

Guarda o token só nos teus próprios dispositivos de administração — não o coloques no iPad
da criança, já que esse não precisa de gravar nada, só de ler o `blocklist.json` público.

## Limitações honestas

- O ecrã final do player embutido ainda mostra vídeos do mesmo canal (comportamento do YouTube,
  não filtrável). Bloquear o canal inteiro resolve.
- As listas guardam-se em `data/config.json` neste Mac; faz backup se quiseres.
