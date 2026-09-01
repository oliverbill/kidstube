# KidTube — YouTube filtrado para iPad

Clone do YouTube com controlo parental: bloqueia **canais**, **temas (palavras-chave)** e
**vídeos específicos**. O filtro corre no servidor, por isso não é contornável a partir do iPad.

Corre num VPS, em `https://kidstube.oliversys.tech` — o iPad funciona em qualquer rede, não só
em casa. Ver "Reprodução sem anúncios" para a instalação completa.

## Arrancar localmente

```sh
KIDTUBE_API_KEY='<a-tua-chave>' node server/server.js
```

Servidor em `http://localhost:8478`. Sem dependências npm — só Node ≥ 18.

## Instalar no iPad

1. No Safari do iPad, abre `https://kidstube.oliversys.tech`.
2. Partilhar → **Adicionar ao ecrã principal**. Fica como app ("KidTube").

## Configurar

O painel de administração não tem link nenhum dentro da app — abre-o digitando o URL
diretamente: `https://kidstube.oliversys.tech/admin.html`.

1. Define o **PIN** parental na primeira vez.
2. Define a **chave da YouTube Data API v3** na variável de ambiente `KIDTUBE_API_KEY`
   (console.cloud.google.com → ativar *YouTube Data API v3* → Credenciais → API key).
   Sem chave, a app funciona em **modo demonstração** com vídeos fictícios.
3. Gere as listas nas tabs: canais, temas (palavras‑chave) e vídeos bloqueados.
   Canais e vídeos aceitam URLs do YouTube coladas diretamente, ou o nome (autocomplete).

## Como funciona o bloqueio

- Toda a navegação passa pela API local (`/api/...`); o servidor remove qualquer vídeo cujo
  canal, id ou texto (título/descrição/canal) bata numa regra, antes de responder ao iPad.
- Pesquisas cujo termo contenha uma palavra‑chave bloqueada devolvem zero resultados.
- Sem resolvedor configurado, a reprodução usa o player embutido oficial
  (`youtube-nocookie.com`) com `rel=0`, que limita as sugestões de fim de vídeo ao mesmo canal —
  mas leva anúncios. Com o resolvedor (secção seguinte), não há iframe nenhum, nem anúncios.

## Reprodução sem anúncios (resolvedor)

**O problema.** No iPad o player embutido nunca é *ad‑free*, tenha a conta Premium ou não. O
Safari bloqueia cookies de terceiros, por isso o iframe do YouTube é sempre uma sessão anónima
— e sessão anónima leva anúncios. Não há parâmetro, chave de API nem OAuth que mude isto: o
player só olha para os cookies do browser onde corre.

**A solução.** Deixar de usar o iframe. O servidor expõe um *resolvedor* que pede ao `yt-dlp` o
URL do stream, e a app toca-o num `<video>` normal. Preferimos o manifesto **HLS** que o YouTube
serve ao cliente Safari (adaptativo, até 1080p, nativo no iPad); se não existir, cai no MP4
progressivo (360p) e, em último recurso, encaminha esse MP4 pelo próprio servidor.

> O `yt-dlp` vai contra os Termos de Serviço do YouTube. Uso doméstico, decisão tua.

**Onde corre.** No VPS, para o iPad funcionar fora de casa. O mesmo servidor corre num Mac
em casa se preferires (aí o IP é doméstico e dispensa os cookies), mas então só há vídeo sem
anúncios dentro da rede de casa. As instruções abaixo são para o VPS.

### 1. Cookies da conta Premium

Este passo é o que faz a diferença entre funcionar e não funcionar num VPS. O IP é de
datacenter, e o YouTube responde a esses com "confirma que não és um robô". Com os cookies de
uma sessão iniciada, os pedidos são de uma conta real e o bloqueio desaparece — e é também
assim que a Premium do `alves.bill@gmail.com` entra na jogada.

Numa máquina com browser, com sessão iniciada no YouTube nessa conta, exporta os cookies para
`cookies.txt` (formato Netscape — qualquer extensão de "export cookies" faz isto) e leva-o
para o VPS:

```sh
scp cookies.txt gomide-vps:/tmp/
ssh gomide-vps 'install -o root -g root -m 600 /tmp/cookies.txt /etc/kidstube/cookies.txt && rm /tmp/cookies.txt'
```

> Este ficheiro é a sessão da conta. Quem o tiver entra no Google como tu, sem password e sem
> segundo factor. Daí os `600` e o dono `root`, e o container montá-lo `:ro`. Se preferires não
> o pôr no VPS, uma conta Google secundária resolve na mesma o bloqueio anti-robô — perdes só o
> tecto de qualidade da Premium.

O servidor aguenta o ficheiro em falta ou vazio: avisa no log e resolve sem sessão. Serve para
pôr a andar antes de teres os cookies, mas conta com o YouTube a recusar mais cedo ou mais tarde.

### 2. Configuração

```sh
ssh gomide-vps 'mkdir -p /etc/kidstube'
scp deploy/kidstube.env.example gomide-vps:/etc/kidstube/kidstube.env
ssh gomide-vps 'chmod 600 /etc/kidstube/kidstube.env'
```

Preencher `KIDTUBE_API_KEY`, `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. Sem a primeira a app
fica em modo demonstração; sem as outras duas, tudo funciona menos as inscrições (a página
"Inscrições" mostra só o canal fixo).

Variáveis:

| Variável | Omissão | Para quê |
| --- | --- | --- |
| `KIDTUBE_PUBLIC_URL` | *(derivado do pedido)* | Endereço público; o `redirect_uri` do OAuth sai daqui |
| `KIDTUBE_TRUST_PROXY` | `0` | `1` atrás do túnel: o IP real vem no `X-Forwarded-For` |
| `KIDTUBE_RESOLVE_RATE` | `40` | Resoluções por IP em 10 minutos |
| `KIDTUBE_COOKIES` | *(vazio)* | `cookies.txt` da conta do YouTube |
| `KIDTUBE_GOOGLE_STATE` | `.google-oauth.json` | Onde fica o `refresh_token` do Google |
| `GOOGLE_CLIENT_ID` / `_SECRET` | *(vazio)* | OAuth da conta; sem isto não há inscrições |
| `KIDTUBE_API_KEY` | *(vazio)* | Chave da YouTube Data API v3 — única origem; sem ela, modo demonstração |
| `KIDTUBE_RESET_EMAIL` | *(vazio)* | Caixa que recebe o link de reposição do PIN |
| `KIDTUBE_SMTP_HOST/PORT/USER/PASS` | `smtp.gmail.com`, `465` | Envio do email; no Gmail a `PASS` é uma palavra-passe de aplicação |
| `KIDTUBE_MAX_HEIGHT` | `1080` | Tecto de qualidade |
| `KIDTUBE_RESOLVER_ONLY` | `0` | `1` = só resolvedor, não serve a app (não é o caso aqui) |
| `KIDTUBE_RESOLVER_TOKEN` | *(vazio)* | Token nas rotas do resolvedor; desnecessário com a app na mesma origem |
| `YTDLP_PATH` | `yt-dlp` | Caminho do binário |

### 3. Arrancar

```sh
ssh gomide-vps 'git clone https://github.com/oliverbill/kidstube /opt/kidstube && chown -R deploy:deploy /opt/kidstube'
ssh gomide-vps 'cd /opt/kidstube && docker compose -f deploy/docker-compose.yml up -d --build'
ssh gomide-vps 'curl -s http://127.0.0.1:8478/api/status'
```

O container escuta em `127.0.0.1:8478` — nenhuma porta é aberta no firewall, tal como o resto
do que corre nesta máquina. O `data/` (PIN e bloqueios) e o estado do OAuth vivem
em volumes, por isso sobrevivem a `--build`.

### 4. Publicar o endereço

O VPS não tem nginx nem Caddy: quem fala com a Internet é o **Cloudflare Tunnel** que já lá
corre. É preciso acrescentar o hostname `kidstube.oliversys.tech` → `http://127.0.0.1:8478`
às rotas do túnel, na Cloudflare (o túnel é gerido por token, não há ficheiro para editar na
máquina).

### 5. Primeira configuração na app

Em `https://kidstube.oliversys.tech/admin.html`:

1. Definir o **PIN** parental.
2. A chave da **YouTube Data API v3** vem do `KIDTUBE_API_KEY` do servidor — não há onde a colar
   no painel, e ela nunca chega ao browser. Trocá-la é editar essa variável e reiniciar. Vazia,
   a app fica em modo demonstração; o painel diz apenas se está definida.
3. **Definições** → **Ligar conta** para autorizar o `alves.bill@gmail.com` e trazer as
   inscrições. O `redirect_uri` `https://kidstube.oliversys.tech/api/oauth/callback` tem de
   estar registado na consola do Google Cloud, senão o Google recusa.

Não é preciso configurar resolvedor nenhum: servida deste servidor, a app descobre-o sozinha
pelo `/api/status`. A secção "Reprodução sem anúncios" da administração só faz falta quando a
app é servida de outro sítio.

### Esquecer o PIN

O ecrã do PIN tem **"Esqueci-me do PIN"**, que envia um link para a caixa em
`KIDTUBE_RESET_EMAIL` — sempre essa, nunca uma indicada no pedido, para o botão não servir de
máquina de spam contra terceiros. O link vale **15 minutos**, serve **uma só vez**, e repor o
PIN limpa também o bloqueio das tentativas falhadas (quem esqueceu o PIN costuma chegar aqui
já bloqueado). Entre emails há um intervalo de 5 minutos.

O botão só aparece se o servidor souber enviar email. Sem SMTP configurado, um PIN esquecido
resolve-se por SSH:

```sh
ssh gomide-vps 'docker exec kidstube node -e "require(\"/app/server/store\").setPin(\"1234\")" && docker restart kidstube'
```

O `docker restart` é preciso: o `setPin` corre noutro processo e o servidor tem a configuração
em memória.

### Largura de banda

O URL que o YouTube devolve traz o IP de quem o pediu lá dentro. Como quem pede é o VPS e quem
toca é o iPad, há dois cenários:

- **O YouTube não impõe a ligação ao IP** — o iPad vai buscar o vídeo directamente ao Google e o
  VPS só transporta o pedido de resolução, uns kilobytes por vídeo.
- **Impõe** — os bytes passam pelo VPS (`/api/hls/…`, com a playlist reescrita para manter o
  1080p). Aí conta como tráfego teu: ~1 GB/hora a 1080p, ~0,3 GB/hora a 480p. Se a quota do VPS
  for apertada, põe `KIDTUBE_MAX_HEIGHT=480`.

A app tenta sempre o caminho directo primeiro e só encaminha quando esse falha, por isso não é
preciso escolher — mas convém saber qual é o cenário. Vê-se em `journalctl -u kidstube-resolver`:
pedidos a `/api/hls/segment` significam que os bytes estão a passar pelo VPS.

### Quando o resolvedor não está disponível

A app tenta o resolvedor e, se ele falhar (servidor desligado, túnel em baixo, yt-dlp partido
por uma mudança do YouTube), volta sozinha ao player embutido. Nunca fica sem vídeo: fica com
anúncios, que é o comportamento antigo. O motivo aparece na consola do browser.

## Limitações honestas

- O ecrã final do player embutido ainda mostra vídeos do mesmo canal (comportamento do YouTube,
  não filtrável). Bloquear o canal inteiro resolve.
- As listas guardam-se em `data/config.json` (volume `kidstube-data` no VPS); faz backup se quiseres.
