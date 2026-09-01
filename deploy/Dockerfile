# KidTube — app + resolvedor de streams.
#
# O yt-dlp vem do binário oficial (auto-contido, sem Python no sistema) em vez do
# pacote da distribuição: quando o YouTube muda, o que resolve é a versão nova, e
# essa sai no GitHub deles muito antes de chegar ao apt.

FROM node:22-bookworm-slim

ARG YTDLP_VERSION=2026.07.04
# O YouTube protege os URLs com desafios de assinatura em JavaScript. O yt-dlp
# precisa de um runtime para os resolver e, dos que ele aceita, o deno é o que
# funciona — com o node instalado e mais nada, saem zero formatos reproduzíveis.
ARG DENO_VERSION=v2.9.3

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
 && chmod 755 /usr/local/bin/yt-dlp \
 && curl -fsSL -o /tmp/deno.zip \
      "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
 && unzip -q /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip \
 && chmod 755 /usr/local/bin/deno \
 && yt-dlp --version && deno --version | head -1 \
 && apt-get purge -y curl unzip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY blocklist.json ./blocklist.json

# data/ (config, PIN, bloqueios) e o estado do OAuth vivem em volumes — a imagem
# é descartável, o estado não.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=8478
EXPOSE 8478
CMD ["node", "server/server.js"]
