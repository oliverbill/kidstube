# youtube-filter — Spec (contrato interno)

App para iPad (PWA) tipo YouTube com controlo parental: bloqueio de **canais**, **temas
(palavras-chave)** e **vídeos específicos**. O filtro corre **no servidor** — o cliente nunca
recebe conteúdo bloqueado.

## Stack

- **Servidor:** Node.js 22, **zero dependências npm** (`node:http`, `node:crypto`, `fetch`).
  Entry point: `server/server.js`, porta `8478` (env `PORT` sobrepõe).
- **Frontend:** HTML/CSS/JS vanilla, sem build step, servido de `public/`.
- **Dados:** `data/config.json` (criado on-demand; `data/` está no .gitignore).
- **Playback:** iframe `https://www.youtube-nocookie.com/embed/<id>?rel=0&playsinline=1`.

## Layout de ficheiros (cada agente só toca nos seus)

- **Agente A (backend):** `server/server.js`, `server/youtube.js`, `server/store.js`,
  `server/mockdata.js`
- **Agente B (frontend principal):** `public/index.html`, `public/app.js`, `public/app.css`
- **Agente C (admin + PWA):** `public/admin.html`, `public/admin.js`, `public/admin.css`,
  `public/manifest.webmanifest`, `public/sw.js`, `public/icons/icon-180.png`,
  `public/icons/icon-512.png` (PNGs gerados por script, estilo simples: play button sobre fundo)

## data/config.json (só o backend toca)

```json
{
  "apiKey": "",
  "pinHash": null,            // scrypt hex; null = PIN ainda não definido
  "pinSalt": null,
  "blocked": {
    "channels": [ {"id": "UC...", "title": "Nome do canal"} ],
    "keywords": [ "minecraft", "arma" ],
    "videos":   [ {"id": "abc123", "title": "Título do vídeo"} ]
  },
  "region": "PT",
  "safeSearch": "strict"
}
```

## Regras de filtragem (backend, aplicadas a QUALQUER lista de vídeos devolvida)

Um vídeo é removido se:
1. `channelId` ∈ blocked.channels, OU
2. `videoId` ∈ blocked.videos, OU
3. alguma keyword (case/acentos-insensitive, substring) aparece em `title`, `description`
   ou `channelTitle`.

Normalização: lowercase + remover diacríticos (NFD). A pesquisa também rejeita a QUERY em si
se contiver keyword bloqueada → responde `{"blockedQuery": true, "items": []}`.

## API HTTP (JSON; erros: `{"error": "mensagem"}` com status apropriado)

### Público (app da criança)

- `GET /api/home` → vídeos populares da região (mostPopular). Resp: `{"items": [Video]}`
- `GET /api/search?q=...` → pesquisa (type=video, safeSearch). Resp: `{"items": [Video], "blockedQuery": false}`
- `GET /api/video/:id` → detalhes + relacionados **do mesmo canal** (playlist de uploads do canal, filtrada).
  Resp: `{"video": Video|null, "blocked": false, "related": [Video]}` — se bloqueado: `{"blocked": true}` e `video: null`, `related: []`.
- `GET /api/channel/:id` → vídeos do canal. Resp: `{"channel": {"id","title"}, "items": [Video], "blocked": false}`
- `GET /api/status` → `{"hasApiKey": bool, "hasPin": bool, "mock": bool}`

**Video (shape normalizado):**
```json
{"id": "...", "title": "...", "channelId": "...", "channelTitle": "...",
 "thumbnail": "https://i.ytimg.com/vi/<id>/mqdefault.jpg", "duration": "12:34",
 "publishedAt": "2026-01-01T00:00:00Z", "views": "1234567"}
```
(`duration`/`views` podem ser `null` em resultados de pesquisa sem chamada extra — o backend
faz batch `videos.list` para preencher quando possível.)

### Admin (todas exceto set-pin inicial exigem header `X-Pin: <pin em claro>`; backend valida contra hash)

- `POST /api/admin/pin` body `{"pin": "1234"}` — define PIN. Só permitido se `pinHash` é null
  (primeira vez) OU header X-Pin válido (troca).
- `POST /api/admin/verify` body `{}` + header — `{"ok": true}` ou 401.
- `GET  /api/admin/config` → config sem apiKey em claro: `{"apiKeySet": bool, "blocked": {...}, "region", "safeSearch"}`
- `POST /api/admin/apikey` body `{"apiKey": "..."}`
- `POST /api/admin/block/channel` body `{"id","title"}` ; `DELETE /api/admin/block/channel/:id`
- `POST /api/admin/block/keyword` body `{"keyword"}` ; `DELETE /api/admin/block/keyword/:kw` (kw URL-encoded)
- `POST /api/admin/block/video` body `{"id","title"}` ; `DELETE /api/admin/block/video/:id`
- `POST /api/admin/region` body `{"region": "PT"}`

401 em X-Pin inválido/ausente. Rate-limit de verificação de PIN: após 5 falhas seguidas,
recusar por 60s (`429`).

## Modo mock

Sem `apiKey` configurada, o backend responde com dados de `server/mockdata.js` (~20 vídeos
inventados, 4 canais, com ids estáveis tipo `mock-001`) para toda a API pública, aplicando o
MESMO pipeline de filtragem. `/api/status` devolve `"mock": true`. Thumbnails mock:
`/mock-thumb/<id>.svg` gerado pelo servidor (SVG com título). Isto permite testar tudo sem chave.

## Frontend principal (Agente B)

- Estilo YouTube dark: topbar (logo "KidTube", barra de pesquisa), grelha responsiva de
  thumbnails (iPad landscape ~4 col, portrait ~3).
- Rotas por hash: `#home`, `#search/<q>`, `#watch/<id>`, `#channel/<id>`.
- Página watch: player iframe 16:9, título, canal (link para `#channel`), vistas/data;
  por baixo, grelha "Mais deste canal" (o campo `related`).
- Se `/api/video/:id` devolve `blocked: true` → ecrã amigável "Este vídeo não está disponível".
- Se query devolve `blockedQuery: true` → mensagem amigável.
- Link discreto para `admin.html` no fundo (ícone engrenagem pequeno na topbar).
- Sem dependências externas; fetch à API relativa (`/api/...`).
- Banner subtil quando `mock: true` ("Modo demonstração — configure a chave API").

## Admin (Agente C)

- `admin.html`: ecrã de PIN primeiro (definir na 1ª vez — `/api/status.hasPin` —, pedir depois);
  PIN guardado em `sessionStorage` enquanto a sessão dura, enviado como X-Pin.
- Tabs: **Canais bloqueados**, **Temas (palavras-chave)**, **Vídeos bloqueados**, **Definições**
  (API key, região, trocar PIN).
- Cada tab: lista atual com botão remover + form de adicionar. Para canais/vídeos, aceitar
  colar URL do YouTube e extrair o id no cliente (padrões `youtube.com/watch?v=`, `youtu.be/`,
  `youtube.com/channel/UC...`, `@handle` → nesse caso guardar como keyword? NÃO: se não der
  para extrair id de canal, mostrar erro pedindo URL de canal com /channel/).
- PWA: `manifest.webmanifest` (name KidTube, display standalone, orientação any, theme #0f0f0f),
  `sw.js` cache-first para estáticos, network-only para `/api/`, meta tags Apple no index e admin
  (`apple-mobile-web-app-capable`, `apple-touch-icon` → icons/icon-180.png).
- Os dois HTML (B e C) referenciam manifest/sw/icons com estes nomes exatos.

## Convenções

- Tudo UTF-8, texto de UI em **português de Portugal**.
- JS moderno (ES2022), sem frameworks, sem CDNs — offline-friendly.
- O servidor faz log de cada pedido numa linha (`method path status ms`).
