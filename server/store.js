'use strict';

// store.js — leitura/escrita atómica de data/config.json, PIN (scrypt) e blocklist.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  apiKey: '',
  pinHash: null,
  pinSalt: null,
  blocked: {
    channels: [],
    keywords: [],
    videos: [],
  },
  safeSearch: 'strict',
};

let config = null;

function deepMergeDefaults(cfg) {
  const out = { ...DEFAULTS, ...cfg };
  out.blocked = {
    channels: Array.isArray(cfg?.blocked?.channels) ? cfg.blocked.channels : [],
    keywords: Array.isArray(cfg?.blocked?.keywords) ? cfg.blocked.keywords : [],
    videos: Array.isArray(cfg?.blocked?.videos) ? cfg.blocked.videos : [],
  };
  return out;
}

function load() {
  if (config) return config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = deepMergeDefaults(JSON.parse(raw));
  } catch {
    config = deepMergeDefaults({});
    save();
  }
  return config;
}

// Escrita atómica: ficheiro temporário + rename.
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function getConfig() {
  return load();
}

// ---------- PIN ----------

function scryptHex(pin, saltHex) {
  return crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function hasPin() {
  return load().pinHash !== null;
}

function setPin(pin) {
  const cfg = load();
  const salt = crypto.randomBytes(16).toString('hex');
  cfg.pinSalt = salt;
  cfg.pinHash = scryptHex(pin, salt);
  save();
}

// ---------- Reposição do PIN por email ----------
//
// Vive em memória: um reinício do servidor invalida um pedido em curso, e o custo
// disso é pedir outro email. Guardar no disco daria persistência a um token que
// existe para ser usado nos próximos minutos.

const RESET_TTL_MS = 15 * 60_000;
const RESET_COOLDOWN_MS = 5 * 60_000;
let reset = null; // { hash, expiresAt }
let lastResetRequest = 0;

function resetCooldownMs() {
  const left = lastResetRequest + RESET_COOLDOWN_MS - Date.now();
  return left > 0 ? left : 0;
}

// Devolve o token em claro — é o que vai no email. Em memória fica só o resumo,
// para que quem leia o processo não encontre um token utilizável.
function createPinReset() {
  const token = crypto.randomBytes(32).toString('base64url');
  reset = {
    hash: crypto.createHash('sha256').update(token).digest(),
    expiresAt: Date.now() + RESET_TTL_MS,
  };
  return token;
}

// Só depois de o email sair. Marcar o intervalo antes de enviar deixaria alguém
// bloqueado 5 minutos por causa de uma falha de que nem chegou a beneficiar.
function markPinResetSent() {
  lastResetRequest = Date.now();
}

// Devolve: 'ok' | 'invalido'. Consome o token: serve uma vez só.
function consumePinReset(token, newPin) {
  if (!reset || reset.expiresAt < Date.now() || !token) return 'invalido';

  const given = crypto.createHash('sha256').update(String(token)).digest();
  if (!crypto.timingSafeEqual(reset.hash, given)) return 'invalido';

  reset = null;
  setPin(newPin);
  // Quem repõe o PIN acabou de provar que tem acesso ao email — não faz sentido
  // deixá-lo à espera de um bloqueio que as tentativas falhadas causaram.
  RATE.failures = 0;
  RATE.lockedUntil = 0;
  return 'ok';
}

// Rate-limit de verificação: 5 falhas seguidas → recusar 60s.
const RATE = { failures: 0, lockedUntil: 0 };
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

function pinLockedForMs() {
  const left = RATE.lockedUntil - Date.now();
  return left > 0 ? left : 0;
}

// Devolve: 'ok' | 'bad' | 'locked'
function verifyPin(pin) {
  if (pinLockedForMs() > 0) return 'locked';
  const cfg = load();
  if (cfg.pinHash === null || pin === undefined || pin === null || pin === '') {
    return registerFailure();
  }
  const expected = Buffer.from(cfg.pinHash, 'hex');
  const actual = Buffer.from(scryptHex(pin, cfg.pinSalt), 'hex');
  if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
    RATE.failures = 0;
    return 'ok';
  }
  return registerFailure();
}

function registerFailure() {
  RATE.failures += 1;
  if (RATE.failures >= MAX_FAILURES) {
    RATE.lockedUntil = Date.now() + LOCK_MS;
    RATE.failures = 0;
    return 'locked';
  }
  return 'bad';
}

// ---------- API key / região ----------

function setApiKey(apiKey) {
  const cfg = load();
  cfg.apiKey = String(apiKey || '');
  save();
}

// ---------- Blocklist ----------

function blockChannel(id, title) {
  const cfg = load();
  if (!cfg.blocked.channels.some((c) => c.id === id)) {
    cfg.blocked.channels.push({ id, title: String(title || '') });
    save();
  }
}

function unblockChannel(id) {
  const cfg = load();
  const before = cfg.blocked.channels.length;
  cfg.blocked.channels = cfg.blocked.channels.filter((c) => c.id !== id);
  if (cfg.blocked.channels.length !== before) save();
}

function blockKeyword(keyword) {
  const cfg = load();
  const kw = String(keyword || '').trim();
  if (kw && !cfg.blocked.keywords.includes(kw)) {
    cfg.blocked.keywords.push(kw);
    save();
  }
}

function unblockKeyword(keyword) {
  const cfg = load();
  const before = cfg.blocked.keywords.length;
  cfg.blocked.keywords = cfg.blocked.keywords.filter((k) => k !== keyword);
  if (cfg.blocked.keywords.length !== before) save();
}

function blockVideo(id, title) {
  const cfg = load();
  if (!cfg.blocked.videos.some((vd) => vd.id === id)) {
    cfg.blocked.videos.push({ id, title: String(title || '') });
    save();
  }
}

function unblockVideo(id) {
  const cfg = load();
  const before = cfg.blocked.videos.length;
  cfg.blocked.videos = cfg.blocked.videos.filter((vd) => vd.id !== id);
  if (cfg.blocked.videos.length !== before) save();
}

module.exports = {
  getConfig,
  hasPin,
  setPin,
  verifyPin,
  pinLockedForMs,
  createPinReset,
  markPinResetSent,
  consumePinReset,
  resetCooldownMs,
  setApiKey,
  blockChannel,
  unblockChannel,
  blockKeyword,
  unblockKeyword,
  blockVideo,
  unblockVideo,
};
