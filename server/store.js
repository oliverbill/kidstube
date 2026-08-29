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
  region: 'PT',
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

function setRegion(region) {
  const cfg = load();
  cfg.region = String(region || 'PT').toUpperCase();
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
  setApiKey,
  setRegion,
  blockChannel,
  unblockChannel,
  blockKeyword,
  unblockKeyword,
  blockVideo,
  unblockVideo,
};
