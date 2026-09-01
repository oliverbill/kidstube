'use strict';

// mailer.js — cliente SMTP mínimo, só o suficiente para enviar o email de reposição
// do PIN. O projeto não tem dependências npm e não é por uma mensagem ocasional que
// vale a pena arrastar o nodemailer: falamos SMTP sobre TLS directamente.
//
// Só o caminho implícito (porta 465, TLS desde o primeiro byte). Sem STARTTLS: um
// servidor que só aceite 587 não é servido por este módulo, e é melhor falhar de
// forma clara do que enviar credenciais em claro por engano.

const tls = require('node:tls');

const HOST = process.env.KIDTUBE_SMTP_HOST || 'smtp.gmail.com';
const PORT = Number(process.env.KIDTUBE_SMTP_PORT) || 465;
const USER = process.env.KIDTUBE_SMTP_USER || '';
const PASS = process.env.KIDTUBE_SMTP_PASS || '';
const FROM = process.env.KIDTUBE_SMTP_FROM || USER;
const TIMEOUT_MS = 20_000;

function configured() {
  return Boolean(HOST && USER && PASS);
}

// Uma resposta SMTP pode ocupar várias linhas: "250-XPTO" continua, "250 XPTO"
// fecha. Só a última linha traz o código final.
function createReader(socket) {
  let buffer = '';
  const waiters = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      // Linha final: código de 3 dígitos seguido de espaço.
      if (/^\d{3} /.test(line)) {
        const w = waiters.shift();
        if (w) w.resolve(line);
      }
    }
  });

  return function expect(codes) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('O servidor de email não respondeu.')), TIMEOUT_MS);
      waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          const code = Number(line.slice(0, 3));
          if (!codes.includes(code)) {
            // Nunca deixar a password aparecer numa mensagem de erro.
            return reject(new Error(`SMTP respondeu ${line.slice(0, 120)}`));
          }
          resolve(line);
        },
      });
    });
  };
}

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// Cabeçalhos não podem levar CR/LF vindo de fora — senão qualquer valor injectado
// acrescenta cabeçalhos à mensagem.
function header(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

// O ponto sozinho numa linha termina o DATA; uma linha do corpo que comece por
// ponto tem de ser duplicada, ou a mensagem fica cortada aí.
function dotStuff(body) {
  return body.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

async function send({ to, subject, text }) {
  if (!configured()) throw new Error('Envio de email não configurado no servidor.');

  const socket = tls.connect({ host: HOST, port: PORT, servername: HOST });
  socket.setTimeout(TIMEOUT_MS);

  const expect = createReader(socket);
  const say = (line) => new Promise((res, rej) => socket.write(line + '\r\n', (e) => (e ? rej(e) : res())));

  try {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('Ligação ao servidor de email expirou.')));
    });

    await expect([220]);
    await say('EHLO kidstube');
    await expect([250]);

    await say('AUTH LOGIN');
    await expect([334]);
    await say(b64(USER));
    await expect([334]);
    await say(b64(PASS));
    await expect([235]);

    await say(`MAIL FROM:<${header(FROM)}>`);
    await expect([250]);
    await say(`RCPT TO:<${header(to)}>`);
    await expect([250, 251]);
    await say('DATA');
    await expect([354]);

    const message = [
      `From: KidTube <${header(FROM)}>`,
      `To: <${header(to)}>`,
      `Subject: ${header(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      `Date: ${new Date().toUTCString()}`,
      '',
      dotStuff(text),
    ].join('\r\n');

    await say(message);
    await say('.');
    await expect([250]);

    await say('QUIT');
  } finally {
    socket.end();
    socket.destroy();
  }
}

module.exports = { send, configured, recipient: () => process.env.KIDTUBE_RESET_EMAIL || '' };
