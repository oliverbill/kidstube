#!/bin/sh
# Corre isto tu mesmo (não eu) — cria os recursos Cloudflare e pede o token do
# GitHub interativamente. Corre a partir da pasta worker/.
set -e

command -v wrangler >/dev/null 2>&1 || npm install -g wrangler

echo "== Login na Cloudflare (abre o browser) =="
wrangler login

echo "== Criar KV namespace PIN_KV =="
wrangler kv namespace create PIN_KV
echo ">>> Copia o 'id' que apareceu acima para wrangler.toml (REPLACE_WITH_KV_NAMESPACE_ID) e grava o ficheiro antes de continuar."
read -p "Já editaste o wrangler.toml? [Enter para continuar] " _

echo "== Definir o token do GitHub (fine-grained PAT, Contents: Read and write, só no repo kidstube) =="
echo "Cria um em: https://github.com/settings/personal-access-tokens/new"
wrangler secret put GITHUB_TOKEN

echo "== Deploy =="
wrangler deploy

echo ""
echo "Pronto. Copia a URL 'https://kidstube-admin.<subdomínio>.workers.dev' que apareceu acima"
echo "e manda-me para eu colar em public/admin.js (WORKER_BASE)."
