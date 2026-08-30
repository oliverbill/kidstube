# kidstube-admin (Cloudflare Worker)

Backend mínimo para a variante estática do KidTube (GitHub Pages): guarda o PIN de
administração partilhado (KV) e o token do GitHub como *secret*, e é quem grava
`blocklist.json` — o navegador nunca vê o token, só o PIN. Ver `public/admin.js` (`WORKER_BASE`,
`workerFetch`) e `worker/src/index.js`.

## Deploy (feito por ti, não pelo agente)

```sh
cd worker
./deploy.sh
```

O script pede login na Cloudflare, cria o KV namespace `PIN_KV`, pede o token do GitHub
(fine-grained PAT, só `Contents: Read and write` no repo `kidstube`, criado em
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new))
e faz o deploy.

Depois de gerares o `id` do KV namespace, edita `wrangler.toml` (troca
`REPLACE_WITH_KV_NAMESPACE_ID`) antes de continuar — o script pausa para isso.

No fim, o `wrangler deploy` mostra a URL `https://kidstube-admin.<subdomínio>.workers.dev`.
Atualiza `WORKER_BASE` em `public/admin.js` com essa URL.

## Migração

Como o PIN passa a viver no Worker (antes era por dispositivo), o primeiro acesso ao painel
depois do deploy volta a pedir "Primeira utilização: escolha um PIN" — normal, e esse PIN passa
a ser o único, partilhado por todos os dispositivos daí em diante.
