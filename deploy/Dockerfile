# KidTube — app + resolvedor de streams.
#
# O yt-dlp vem do binário oficial (auto-contido, sem Python no sistema) em vez do
# pacote da distribuição: quando o YouTube muda, o que resolve é a versão nova, e
# essa sai no GitHub deles muito antes de chegar ao apt.

FROM node:22-bookworm-slim

ARG YTDLP_VERSION=2026.07.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
 && chmod 755 /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && apt-get purge -y curl && apt-get autoremove -y \
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
