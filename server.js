'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const cluster = require('cluster');
const express = require('express');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
/** Behind nginx / Beget / Timeweb proxy — rate-limit must see real client IP. */
app.set('trust proxy', 1);
const GEMINI_API_ORIGIN = (process.env.GEMINI_API_ORIGIN || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
/** Prefer lean/fast models first under free-tier load; gemini-3.8-flash is opt-in via env. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
/** Default chain after the primary model when Gemini returns 503 / UNAVAILABLE. */
const DEFAULT_FALLBACK_MODELS = ['gemini-3.6-flash'];
const DONATE_URL = process.env.DONATE_URL || '#donate';
/** Single place for the VK community footer link (override via env if shortname changes). */
const COMMUNITY_VK_URL = process.env.COMMUNITY_VK_URL || 'https://vk.ru/ai.nutricode';

/** Yandex.Metrika counter id; empty disables /api/config advertisement. */
const YANDEX_METRIKA_ID = String(process.env.YANDEX_METRIKA_ID || '').trim();
/** Keep room for multi-paragraph ration replies; 1024 was cutting mid-thought. */
const MAX_OUTPUT_TOKENS = Math.min(
  Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192, 1024),
  8192
);
const MAX_CONTINUES = 2;
/**
 * Hard cap for one user chat message (JS string .length — UTF-16 code units).
 * Rejected before Gemini; admin/prompt editors are not covered by this limit.
 */
const MAX_USER_MESSAGE_CHARS = Math.min(
  Math.max(Number(process.env.MAX_USER_MESSAGE_CHARS) || 2000, 200),
  20000
);
const USER_MESSAGE_TOO_LONG_TEXT = `Сообщение слишком длинное — сократите до ${MAX_USER_MESSAGE_CHARS} символов и отправьте снова.`;
/**
 * Retries per model on overload before switching to the next fallback.
 * Prefer stability over raw TTFB — default 2 (3 attempts) again after #15 regression.
 */
const OVERLOAD_RETRIES = Math.min(
  Math.max(Number(process.env.GEMINI_OVERLOAD_RETRIES) || 2, 0),
  5
);
const OVERLOAD_BACKOFF_MS = Math.min(
  Math.max(Number(process.env.GEMINI_OVERLOAD_BACKOFF_MS) || 800, 200),
  8000
);
/**
 * Hard timeout for opening the Gemini upstream (connect + headers / first byte only).
 * Does NOT cancel an already-streaming body. Raised after #15 false cutoffs.
 */
const GEMINI_FETCH_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.GEMINI_FETCH_TIMEOUT_MS) || 90000, 15000),
  180000
);
const INCOMPLETE_ANSWER_NOTICE =
  'Ответ оборвался на середине — это не полный текст. Напишите «продолжи» или повторите вопрос.';
/** SSE keepalive while waiting for Gemini so proxies/clients don’t stall on silence. */
const SSE_HEARTBEAT_MS = Math.min(
  Math.max(Number(process.env.SSE_HEARTBEAT_MS) || 1500, 500),
  10000
);

/**
 * Dual-key pool. Values never leave the process / never appear in admin UI.
 * Slot 1 = GEMINI_API_KEY, slot 2 = GEMINI_API_KEY_2.
 */
const GEMINI_KEY_SLOTS = [
  { id: 1, key: String(process.env.GEMINI_API_KEY || '').trim() },
  { id: 2, key: String(process.env.GEMINI_API_KEY_2 || '').trim() },
].filter((slot) => slot.key);

/** @deprecated alias — many call sites / exports expect a truthy primary string. */
const GEMINI_API_KEY = GEMINI_KEY_SLOTS[0]?.key || '';

/** Sticky primary slot id (1 or 2). Updated after a successful failover. */
let activeGeminiKeyId = GEMINI_KEY_SLOTS[0]?.id || null;

function geminiKeyStatus() {
  const has1 = GEMINI_KEY_SLOTS.some((s) => s.id === 1);
  const has2 = GEMINI_KEY_SLOTS.some((s) => s.id === 2);
  return {
    key1: has1 ? 'configured' : 'missing',
    key2: has2 ? 'configured' : 'missing',
    activeKey: activeGeminiKeyId,
    failoverReady: has1 && has2,
  };
}

function getGeminiKeySlot(id) {
  return GEMINI_KEY_SLOTS.find((s) => s.id === id) || null;
}

function orderedGeminiKeySlots() {
  if (!GEMINI_KEY_SLOTS.length) return [];
  const primary = getGeminiKeySlot(activeGeminiKeyId) || GEMINI_KEY_SLOTS[0];
  const rest = GEMINI_KEY_SLOTS.filter((s) => s.id !== primary.id);
  return [primary, ...rest];
}

/** Primary + fallbacks. Override with GEMINI_MODEL_CHAIN=a,b,c or GEMINI_FALLBACK_MODELS=b,c */
function parseModelChain() {
  const split = (value) =>
    String(value || '')
      .split(/[,|]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const fromChain = split(process.env.GEMINI_MODEL_CHAIN);
  if (fromChain.length) return [...new Set(fromChain)];

  const fallbacks = split(process.env.GEMINI_FALLBACK_MODELS);
  const tail = fallbacks.length ? fallbacks : DEFAULT_FALLBACK_MODELS;
  return [...new Set([GEMINI_MODEL, ...tail])];
}

const GEMINI_MODEL_CHAIN = parseModelChain();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geminiStreamUrl(model, apiKey) {
  const key = apiKey || GEMINI_API_KEY;
  return `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
}

/** True for high-demand / capacity errors that may clear after backoff or a lighter model. */
function isOverloadError(status, code, message) {
  const blob = `${code || ''} ${message || ''}`;
  if (status === 503) return true;
  if (/UNAVAILABLE|high demand|overloaded|try again later/i.test(blob)) return true;
  return false;
}

/** Failures that justify one switch to the other API key (not auth/404). */
function isKeyFailoverError(status, code, message) {
  if (!status) return true; // network / fetch throw
  const blob = `${code || ''} ${message || ''}`;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate/i.test(blob)) return true;
  if (isOverloadError(status, code, message)) return true;
  return false;
}

const ROOT = __dirname;
const PROMPT_PATH = path.join(ROOT, 'prompt.txt');
const PARTNERS_PATH = path.join(ROOT, 'partners.json');
const ADMIN_HTML_PATH = path.join(ROOT, 'admin.html');

/**
 * Hot-reload from disk on each use (mtime cache). Admin saves invalidate immediately.
 * Do not keep a forever-cached copy from process start.
 */
const fileCache = {
  prompt: { mtimeMs: -1, value: '' },
  partners: { mtimeMs: -1, value: [] },
  cityIndex: { mtimeMs: -1, value: null },
};

function invalidateContentCache() {
  fileCache.prompt.mtimeMs = -1;
  fileCache.partners.mtimeMs = -1;
  fileCache.cityIndex.mtimeMs = -1;
}

function loadSystemPrompt() {
  const st = fs.statSync(PROMPT_PATH);
  if (st.mtimeMs !== fileCache.prompt.mtimeMs) {
    fileCache.prompt = {
      mtimeMs: st.mtimeMs,
      value: fs.readFileSync(PROMPT_PATH, 'utf8'),
    };
  }
  return fileCache.prompt.value;
}

function loadPartners() {
  const st = fs.statSync(PARTNERS_PATH);
  if (st.mtimeMs !== fileCache.partners.mtimeMs) {
    fileCache.partners = {
      mtimeMs: st.mtimeMs,
      value: JSON.parse(fs.readFileSync(PARTNERS_PATH, 'utf8')),
    };
    fileCache.cityIndex.mtimeMs = -1;
  }
  const value = fileCache.partners.value;
  return Array.isArray(value) ? value : [];
}

function getCityIndex() {
  const partners = loadPartners();
  const st = fs.statSync(PARTNERS_PATH);
  if (st.mtimeMs !== fileCache.cityIndex.mtimeMs || !fileCache.cityIndex.value) {
    fileCache.cityIndex = {
      mtimeMs: st.mtimeMs,
      value: buildCityIndex(partners),
    };
  }
  return fileCache.cityIndex.value;
}

/** Bootstrap once so a missing/corrupt file fails at startup, not mid-chat. */
loadSystemPrompt();
loadPartners();

/**
 * Quiet chat-mode overlays (надстройки). Same bot + short context block.
 * Explicit UI choice is primary; keyword detect is only a fallback for «Обычный».
 */
const CHAT_MODES = {
  normal: {
    id: 'normal',
    label: 'Обычный',
    overlay: '',
  },
  kids: {
    id: 'kids',
    label: 'Детский стол',
    overlay:
      'Режим-надстройка: детский / семейный стол.\n' +
      'Подстрой ответ: одно блюдо или набор на всех, мягкий вкус; без отдельного «детского меню» как диеты. ' +
      'Для детей — общие принципы еды и коротко: это не замена педиатру или нутрициологу.',
  },
  notime: {
    id: 'notime',
    label: 'Нет времени',
    overlay:
      'Режим-надстройка: нет времени.\n' +
      'Подстрой ответ: 2–4 готовых или почти готовых варианта на сегодня (15–20 мин или сборка без плиты): ' +
      'что есть / что купить по пути, без длинных рецептов.',
  },
  grocery: {
    id: 'grocery',
    label: 'Список покупок',
    overlay:
      'Режим-надстройка: список покупок.\n' +
      'Подстрой ответ: короткий список на 3–7 дней (или срок из запроса): группы продуктов, порции-ориентиры, ' +
      'без брендов и выдуманных ссылок в магазины.',
  },
};

const MODE_IDS = Object.keys(CHAT_MODES);

/** Secondary auto-detect from Russian wording — never overrides an explicit non-normal mode. */
const MODE_DETECT = [
  {
    id: 'kids',
    re: /детск|реб[её]н|малыш|школьник|для\s+семьи|семейный\s+стол|на\s+всех/i,
  },
  {
    id: 'notime',
    re: /нет\s+времени|некогда|на\s+скорую|быстр(?:о|ый|ая|ое)\s+(?:ужин|обед|завтрак|еда)|15\s*мин|без\s+плиты/i,
  },
  {
    id: 'grocery',
    re: /список\s+покупок|что\s+купить|закупк|набрать\s+в\s+магазин|список\s+на\s+\d/i,
  },
];

function normalizeModeId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase();
  return MODE_IDS.includes(id) ? id : 'normal';
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/**
 * Resolve active mode: explicit UI id wins; if «normal», optionally detect from latest user text.
 * @returns {{ id: string, label: string, overlay: string, source: 'explicit'|'detected'|'default' }}
 */
function resolveChatMode(rawMode, messages) {
  const explicit = normalizeModeId(rawMode);
  if (explicit !== 'normal') {
    const mode = CHAT_MODES[explicit];
    return { id: mode.id, label: mode.label, overlay: mode.overlay, source: 'explicit' };
  }

  const text = lastUserText(messages);
  if (text) {
    for (const rule of MODE_DETECT) {
      if (rule.re.test(text)) {
        const mode = CHAT_MODES[rule.id];
        return { id: mode.id, label: mode.label, overlay: mode.overlay, source: 'detected' };
      }
    }
  }

  const mode = CHAT_MODES.normal;
  return { id: mode.id, label: mode.label, overlay: mode.overlay, source: 'default' };
}

function modeOverlayBlock(mode) {
  if (!mode?.overlay) return '';
  return `

Контекст режима (надстройка; характер тот же, только акцент ответа):
${mode.overlay}`;
}

app.use(express.json({ limit: '256kb' }));

/** PWA manifest: correct MIME for Chromium install / home-screen icons. */
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(ROOT, 'public', 'manifest.webmanifest'));
});

app.use(express.static(path.join(ROOT, 'public')));

const CHAT_RATE_WINDOW_MS = 15 * 60 * 1000;
const CHAT_RATE_MAX = 15;
const RL_CHANNEL = 'nutrikod:rl';

const STATS_CHANNEL = 'nutrikod:stats';
const STATS_ALERT_TTL_MS = 15 * 60 * 1000;
const SITE_STARTED_AT = Date.now();

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function createLocalStats() {
  return {
    day: dayKey(),
    successToday: 0,
    errorsToday: 0,
    warning: null,
  };
}

/** In-process stats for single-worker / tests; cluster workers proxy to master. */
const localStats = createLocalStats();

function rollLocalStatsDay() {
  const today = dayKey();
  if (localStats.day !== today) {
    localStats.day = today;
    localStats.successToday = 0;
    localStats.errorsToday = 0;
  }
}

function applyLocalStatOp(op, payload = {}) {
  rollLocalStatsDay();
  if (op === 'success') {
    localStats.successToday += 1;
    return snapshotLocalStats();
  }
  if (op === 'error') {
    localStats.errorsToday += 1;
    const kind = String(payload.kind || 'error');
    const alert =
      kind === 'rate_limit' || kind === 'overload' || kind === 'outage' || kind === 'auth';
    if (alert) {
      localStats.warning = {
        active: true,
        kind,
        message: String(payload.message || defaultWarningMessage(kind)),
        at: Date.now(),
      };
    }
    return snapshotLocalStats();
  }
  return snapshotLocalStats();
}

function defaultWarningMessage(kind) {
  if (kind === 'rate_limit') return 'Gemini: лимит запросов / квота (429).';
  if (kind === 'overload') return 'Gemini: перегрузка / 503 — модель временно недоступна.';
  if (kind === 'outage') return 'Gemini: сбой связи с API.';
  if (kind === 'auth') return 'Gemini: проблема с ключом API (401/403).';
  return 'Gemini: ошибка API.';
}

function snapshotLocalStats() {
  rollLocalStatsDay();
  const warning =
    localStats.warning && Date.now() - localStats.warning.at <= STATS_ALERT_TTL_MS
      ? { ...localStats.warning, active: true }
      : { active: false };
  if (!warning.active) localStats.warning = null;
  return {
    successToday: localStats.successToday,
    errorsToday: localStats.errorsToday,
    warning,
    startedAt: SITE_STARTED_AT,
  };
}

function classifyGeminiFailure(status, code, message) {
  const blob = `${code || ''} ${message || ''}`;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate/i.test(blob)) return 'rate_limit';
  if (isOverloadError(status, code, message)) return 'overload';
  if (
    status === 401 ||
    status === 403 ||
    /API[_\s-]?KEY|PERMISSION|UNAUTHENTICATED|not valid/i.test(blob)
  ) {
    return 'auth';
  }
  if (!status || status >= 500) return 'outage';
  return 'error';
}

let statsIpcSeq = 0;
const statsIpcPending = new Map();

if (cluster.isWorker) {
  process.on('message', (msg) => {
    if (!msg || msg.channel !== STATS_CHANNEL || msg.id == null) return;
    const settle = statsIpcPending.get(msg.id);
    if (!settle) return;
    statsIpcPending.delete(msg.id);
    settle(msg.result);
  });
}

function statsCall(op, payload = {}) {
  if (!cluster.isWorker || typeof process.send !== 'function') {
    return Promise.resolve(applyLocalStatOp(op, payload));
  }
  return new Promise((resolve, reject) => {
    const id = ++statsIpcSeq;
    const timer = setTimeout(() => {
      statsIpcPending.delete(id);
      reject(new Error('cluster stats IPC timeout'));
    }, 3000);
    statsIpcPending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    process.send({ channel: STATS_CHANNEL, op, payload, id });
  });
}

async function recordChatSuccess() {
  try {
    await statsCall('success');
  } catch (err) {
    console.warn('[stats] success record failed', err?.message || err);
  }
}

async function recordChatError(kind, message) {
  try {
    await statsCall('error', { kind, message });
  } catch (err) {
    console.warn('[stats] error record failed', err?.message || err);
  }
}

async function readAdminStats() {
  const base = await statsCall('get');
  const load = os.loadavg();
  const keys = geminiKeyStatus();
  return {
    load1: load[0],
    load5: load[1],
    load15: load[2],
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
    uptimeSec: Math.floor((Date.now() - (base.startedAt || SITE_STARTED_AT)) / 1000),
    processUptimeSec: Math.floor(process.uptime()),
    successToday: base.successToday || 0,
    errorsToday: base.errorsToday || 0,
    warning: base.warning || { active: false },
    day: dayKey(),
    // Status only — never key values.
    geminiKeys: keys,
    activeGeminiKey: keys.activeKey,
  };
}

/** Master-side admin stats IPC (shared across workers). */
function attachClusterStatsMaster() {
  const masterStats = createLocalStats();
  const masterStartedAt = SITE_STARTED_AT;

  const roll = () => {
    const today = dayKey();
    if (masterStats.day !== today) {
      masterStats.day = today;
      masterStats.successToday = 0;
      masterStats.errorsToday = 0;
    }
  };

  const snapshot = () => {
    roll();
    const warning =
      masterStats.warning && Date.now() - masterStats.warning.at <= STATS_ALERT_TTL_MS
        ? { ...masterStats.warning, active: true }
        : { active: false };
    if (!warning.active) masterStats.warning = null;
    return {
      successToday: masterStats.successToday,
      errorsToday: masterStats.errorsToday,
      warning,
      startedAt: masterStartedAt,
    };
  };

  const apply = (op, payload = {}) => {
    roll();
    if (op === 'success') {
      masterStats.successToday += 1;
      return snapshot();
    }
    if (op === 'error') {
      masterStats.errorsToday += 1;
      const kind = String(payload.kind || 'error');
      if (kind === 'rate_limit' || kind === 'overload' || kind === 'outage' || kind === 'auth') {
        masterStats.warning = {
          active: true,
          kind,
          message: String(payload.message || defaultWarningMessage(kind)),
          at: Date.now(),
        };
      }
      return snapshot();
    }
    return snapshot();
  };

  const reply = (worker, id, result) => {
    try {
      worker.send({ channel: STATS_CHANNEL, id, result });
    } catch {
      /* worker gone */
    }
  };

  const handle = (worker, msg) => {
    if (!msg || msg.channel !== STATS_CHANNEL) return;
    reply(worker, msg.id, apply(msg.op, msg.payload || {}));
  };

  cluster.on('fork', (worker) => {
    worker.on('message', (msg) => handle(worker, msg));
  });
}


/**
 * Rate-limit counters live in the master so every worker shares one 15/15min budget per IP.
 * Workers talk to master over cluster IPC; single-process / tests keep the default MemoryStore.
 */
function createClusterRateLimitStore(windowMs) {
  let seq = 0;
  const pending = new Map();

  process.on('message', (msg) => {
    if (!msg || msg.channel !== RL_CHANNEL || msg.id == null) return;
    const settle = pending.get(msg.id);
    if (!settle) return;
    pending.delete(msg.id);
    settle(msg.result);
  });

  function call(op, key) {
    return new Promise((resolve, reject) => {
      if (typeof process.send !== 'function') {
        reject(new Error('cluster rate-limit store needs process.send'));
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('cluster rate-limit IPC timeout'));
      }, 3000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      process.send({ channel: RL_CHANNEL, op, key, id });
    });
  }

  return {
    async increment(key) {
      const result = await call('increment', key);
      return {
        totalHits: result.totalHits,
        resetTime: result.resetTime ? new Date(result.resetTime) : undefined,
      };
    },
    async decrement(key) {
      await call('decrement', key);
    },
    async resetKey(key) {
      await call('resetKey', key);
    },
    async get(key) {
      const result = await call('get', key);
      if (!result) return undefined;
      return {
        totalHits: result.totalHits,
        resetTime: result.resetTime ? new Date(result.resetTime) : undefined,
      };
    },
  };
}

/** Master-side map for createClusterRateLimitStore IPC. */
function attachClusterRateLimitMaster(windowMs) {
  const buckets = new Map();

  const reply = (worker, id, result) => {
    try {
      worker.send({ channel: RL_CHANNEL, id, result });
    } catch {
      /* worker already gone */
    }
  };

  const handle = (worker, msg) => {
    if (!msg || msg.channel !== RL_CHANNEL) return;
    const now = Date.now();
    const key = String(msg.key || '');
    let entry = buckets.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { hits: 0, resetTime: now + windowMs };
      buckets.set(key, entry);
    }

    if (msg.op === 'increment') {
      entry.hits += 1;
      reply(worker, msg.id, { totalHits: entry.hits, resetTime: entry.resetTime });
      return;
    }
    if (msg.op === 'decrement') {
      entry.hits = Math.max(0, entry.hits - 1);
      reply(worker, msg.id, {});
      return;
    }
    if (msg.op === 'resetKey') {
      buckets.delete(key);
      reply(worker, msg.id, {});
      return;
    }
    if (msg.op === 'get') {
      reply(
        worker,
        msg.id,
        entry ? { totalHits: entry.hits, resetTime: entry.resetTime } : null
      );
    }
  };

  cluster.on('fork', (worker) => {
    worker.on('message', (msg) => handle(worker, msg));
  });
}

/** Chat flood guard: 15 requests / 15 min per IP. */
const chatLimiter = rateLimit({
  windowMs: CHAT_RATE_WINDOW_MS,
  max: CHAT_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  ...(cluster.isWorker ? { store: createClusterRateLimitStore(CHAT_RATE_WINDOW_MS) } : {}),
  message: {
    type: 'error',
    text: 'Вы слишком часто общаетесь с ИИ, подождите немного',
  },
});

app.get('/api/config', (_req, res) => {
  res.json({
    hasKey: GEMINI_KEY_SLOTS.length > 0,
    keySlotsConfigured: GEMINI_KEY_SLOTS.length,
    donateUrl: DONATE_URL,
    communityVkUrl: COMMUNITY_VK_URL,
    yandexMetrikaId: YANDEX_METRIKA_ID || null,
    brand: 'НутриКод',
    model: GEMINI_MODEL,
    modelChain: GEMINI_MODEL_CHAIN,
    maxUserMessageChars: MAX_USER_MESSAGE_CHARS,
    modes: MODE_IDS.map((id) => ({ id, label: CHAT_MODES[id].label })),
  });
});


const ADMIN_USER = String(process.env.ADMIN_USER || 'admin').trim() || 'admin';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');

function unauthorizedAdmin(res) {
  res.set('WWW-Authenticate', 'Basic realm="NutriKod Admin", charset="UTF-8"');
  res.status(401).type('text/plain').send('Требуется авторизация');
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    unauthorizedAdmin(res);
    return;
  }
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) {
    unauthorizedAdmin(res);
    return;
  }
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    unauthorizedAdmin(res);
    return;
  }
  const sep = decoded.indexOf(':');
  const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
  if (user !== ADMIN_USER || pass !== ADMIN_PASSWORD) {
    unauthorizedAdmin(res);
    return;
  }
  next();
}

app.get('/admin', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(ADMIN_HTML_PATH);
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const stats = await readAdminStats();
    res.set('Cache-Control', 'no-store');
    res.json(stats);
  } catch (err) {
    console.error('[admin] stats failed', err?.message || err);
    res.status(500).json({ error: 'Не удалось получить статистику' });
  }
});

app.get('/api/admin/files', requireAdmin, (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({
      partners: fs.readFileSync(PARTNERS_PATH, 'utf8'),
      prompt: fs.readFileSync(PROMPT_PATH, 'utf8'),
    });
  } catch (err) {
    console.error('[admin] files read failed', err?.message || err);
    res.status(500).json({ error: 'Не удалось прочитать файлы' });
  }
});

app.post('/api/admin/save', requireAdmin, (req, res) => {
  const partnersRaw = req.body?.partners;
  const promptRaw = req.body?.prompt;
  if (typeof partnersRaw !== 'string' || typeof promptRaw !== 'string') {
    res.status(400).json({ error: 'Нужны строковые поля partners и prompt' });
    return;
  }
  if (!promptRaw.trim()) {
    res.status(400).json({ error: 'prompt.txt не может быть пустым' });
    return;
  }

  let partnersParsed;
  try {
    partnersParsed = JSON.parse(partnersRaw);
  } catch {
    res.status(400).json({ error: 'partners.json: невалидный JSON' });
    return;
  }
  if (!Array.isArray(partnersParsed)) {
    res.status(400).json({ error: 'partners.json должен быть массивом' });
    return;
  }

  try {
    const partnersOut = `${JSON.stringify(partnersParsed, null, 2)}\n`;
    fs.writeFileSync(PARTNERS_PATH, partnersOut, 'utf8');
    fs.writeFileSync(PROMPT_PATH, promptRaw, 'utf8');
    invalidateContentCache();
    loadPartners();
    loadSystemPrompt();
    console.info(
      `[admin] saved partners.json (${partnersParsed.length} rows) and prompt.txt (${promptRaw.length} chars)`
    );
    res.json({ ok: true, partnersCount: partnersParsed.length, promptChars: promptRaw.length });
  } catch (err) {
    console.error('[admin] save failed', err?.message || err);
    res.status(500).json({ error: 'Не удалось сохранить файлы' });
  }
});


/**
 * Clear fulfillment / brand intent — only then inject 0–1 live offer.
 * Avoid \\b — JS word boundaries ignore Cyrillic and break matches.
 * Bare «покушать / продукты / магазин» is NOT enough (clarify first).
 */
const CLEAR_INTENT_RE =
  /заказ(?:ать|аю|аем|ите)|заказы|доставк|нет времени(?:\s+готовить)?|некогда(?:\s+готовить)?|готов(?:ое|ую|ые|ой)\s+(?:ед|блюд)|заказ(?:ать)?\s+готов|пицц|суши|ролл|лавк|перекр[её]сток|магнит|ёбидоёби|yobidoyobi|додо|\bdodo\b|яндекс\s*ед|яндекс\s*лавк|вод[аыуе]|гидрат|питьев|купить\s+продукт|заказать\s+продукт|доставк\w*\s+продукт/i;

/** @deprecated alias — kept for older verify scripts / exports */
const INTENT_RE = CLEAR_INTENT_RE;

/**
 * Soft default when intent is clear but no brand won.
 * Prefer wide delivery over local grocery chains (Перекрёсток).
 */
const WIDE_DEFAULT_IDS = ['yandex-eda', 'yandex-lavka', 'dodo-pizza', 'yobidoyobi', 'foodband'];

/** Low-signal tags shared by many partners — brand/specific tags weigh more. */
const GENERIC_PARTNER_TAGS = new Set([
  'готовое',
  'готовая еда',
  'нет времени',
  'доставка',
  'быстрая доставка',
  'обед',
  'ужин',
  'заказать',
  'продукты',
  'grocery',
  'ready-meals',
  'еда',
  'пп',
]);

const OWNER_CODEWORD_RE = /михалыч/i;

/** Placeholder / demo hosts must never ship as live offers. */
const PLACEHOLDER_LINK_RE = /^https?:\/\/(www\.)?example\.com(\/|$)/i;

function isHttpUrl(value) {
  return /^https?:\/\/\S+/i.test(String(value || '').trim());
}

/** Live partner = explicit live:true + real https URL (not example.com). */
function isLivePartner(partner) {
  if (!partner || partner.live !== true) return false;
  const link = String(partner.link || '').trim();
  if (!isHttpUrl(link)) return false;
  if (PLACEHOLDER_LINK_RE.test(link)) return false;
  return true;
}

function conversationText(messages) {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
    .toLowerCase();
}

function countUserTurns(messages) {
  return messages.filter((m) => m && m.role === 'user' && typeof m.content === 'string').length;
}

function hasOwnerCodeword(messages) {
  return (messages || []).some(
    (m) => m && m.role === 'user' && typeof m.content === 'string' && OWNER_CODEWORD_RE.test(m.content)
  );
}

/** Tag hit with light Cyrillic inflection (лавка/лавку, пицца/пиццу). */
function textHasTag(text, tag) {
  const t = String(tag || '').toLowerCase().trim();
  if (!t) return false;
  if (text.includes(t)) return true;
  // Soft stem for longer tags only — avoid short false positives (вода→вод).
  if (t.length >= 5) {
    const stem = t.slice(0, -1);
    if (stem.length >= 4 && text.includes(stem)) return true;
  }
  return false;
}

function partnerTagScore(partner, text) {
  let brand = 0;
  let generic = 0;
  for (const tag of partner.tags || []) {
    const t = String(tag).toLowerCase();
    if (!textHasTag(text, t)) continue;
    if (GENERIC_PARTNER_TAGS.has(t)) generic += 1;
    else brand += 3;
  }
  return { brand, generic, total: brand + generic };
}

/** Legacy deny-list (belt-and-suspenders; cities whitelist is source of truth). */
function partnerDeniedByGeo(partner, text) {
  const denies = Array.isArray(partner?.geo_deny) ? partner.geo_deny : [];
  for (const d of denies) {
    const needle = String(d || '')
      .toLowerCase()
      .trim();
    if (needle && text.includes(needle)) return true;
  }
  return false;
}

/** Canonical city id → extra substrings that map to it (simple RU match). */
const CITY_ALIASES = {
  москва: ['мск', 'москве', 'москвы', 'москву', 'москов'],
  'санкт-петербург': ['спб', 'питер', 'питере', 'петербург', 'петербурге'],
  'комсомольск-на-амуре': ['комсомольск', 'комсомольске', 'комсе'],
  'нижний новгород': ['нижнем новгород', 'нижегород'],
  'ростов-на-дону': ['ростове-на-дону', 'ростов на дону', 'ростов', 'ростове'],
  'великий новгород': ['великом новгород'],
  'южно-сахалинск': ['сахалинск'],
  'петропавловск-камчатский': ['петропавловск'],
  'набережные челны': ['челны'],
};

/** Cheap RU case/stem variants for substring match (не морфология, а эвристика). */
function cityFormNeedles(city) {
  const c = String(city || '').toLowerCase().trim();
  if (!c) return [];
  const out = new Set([c]);
  const add = (x) => {
    if (x && x.length >= 3) out.add(x);
  };
  // казань → казани / казане; тула → туле / тулу
  if (c.endsWith('ь')) {
    const stem = c.slice(0, -1);
    add(stem + 'и');
    add(stem + 'е');
    add(stem + 'ю');
  } else if (c.endsWith('а')) {
    const stem = c.slice(0, -1);
    add(stem + 'е');
    add(stem + 'у');
    add(stem + 'ы');
    add(stem + 'ой');
  } else if (c.endsWith('я')) {
    const stem = c.slice(0, -1);
    add(stem + 'и');
    add(stem + 'е');
    add(stem + 'ю');
  } else if (c.endsWith('ий') || c.endsWith('ый')) {
    const stem = c.slice(0, -2);
    add(stem + 'ом');
    add(stem + 'ому');
    add(stem + 'ого');
  } else {
    // екатеринбург → екатеринбурге; краснодар → краснодаре
    add(c + 'е');
    add(c + 'а');
    add(c + 'у');
  }
  // multi-word: «нижний новгород» → «нижнем новгороде»
  if (c.includes(' ')) {
    const parts = c.split(/\s+/);
    if (parts.length === 2) {
      const [a, b] = parts;
      for (const fa of cityFormNeedles(a)) {
        for (const fb of cityFormNeedles(b)) add(`${fa} ${fb}`);
      }
    }
  }
  // hyphenated: ростов-на-дону already exact; комсомольск-на-амуре handled via aliases
  return [...out];
}

function partnerGeoMode(partner) {
  const mode = String(partner?.geo_mode || '').toLowerCase();
  if (mode === 'nationwide' || mode === 'cities') return mode;
  // Legacy fallback from coverage / empty cities.
  if (partner?.coverage === 'wide') return 'nationwide';
  if (Array.isArray(partner?.cities) && partner.cities.length) return 'cities';
  return 'nationwide';
}

function partnerCities(partner) {
  return (Array.isArray(partner?.cities) ? partner.cities : [])
    .map((c) => String(c || '').toLowerCase().trim())
    .filter(Boolean);
}

/** All known city needles from partners + aliases, longest first. */
function buildCityIndex(partners = loadPartners()) {
  const canonical = new Map(); // needle → canonical city
  const add = (canon, needle) => {
    const c = String(canon || '').toLowerCase().trim();
    const n = String(needle || '').toLowerCase().trim();
    if (!c || !n || n.length < 3) return;
    // Prefer longer / more specific mapping when collisions arise.
    if (!canonical.has(n) || n.length > [...canonical.keys()].find((k) => k === n)?.length) {
      canonical.set(n, c);
    }
  };
  const register = (city) => {
    add(city, city);
    for (const form of cityFormNeedles(city)) add(city, form);
    for (const ex of CITY_ALIASES[city] || []) {
      add(city, ex);
      for (const form of cityFormNeedles(ex)) add(city, form);
    }
  };
  for (const p of partners || []) {
    for (const city of partnerCities(p)) register(city);
  }
  // Aliases for cities we care about even if no partner lists them yet.
  for (const city of Object.keys(CITY_ALIASES)) register(city);
  const needles = [...canonical.keys()].sort((a, b) => b.length - a.length);
  return { canonical, needles };
}

/** Detect first matching city mention in conversation text (lowercase). */
function detectCity(text, index = null) {
  if (!index) index = getCityIndex();
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  for (const needle of index.needles) {
    if (t.includes(needle)) return index.canonical.get(needle) || needle;
  }
  return null;
}

/**
 * Geo allow: nationwide always OK; cities — only if detected city ∈ whitelist.
 * Unknown city + cities mode → not allowed (clarify / skip; no guessing).
 */
function partnerAllowedByGeo(partner, city) {
  if (!partner) return false;
  const mode = partnerGeoMode(partner);
  if (mode === 'nationwide') return true;
  if (mode === 'cities') {
    if (!city) return false;
    const list = partnerCities(partner);
    if (!list.length) return false;
    return list.some((c) => city === c || city.includes(c) || c.includes(city));
  }
  return true;
}

function isWideCoveragePartner(partner) {
  if (!partner) return false;
  if (partnerGeoMode(partner) === 'nationwide') return true;
  if (partner.coverage === 'wide') return true;
  return WIDE_DEFAULT_IDS.includes(partner.id) && partnerGeoMode(partner) === 'nationwide';
}

/**
 * Soft default among geo-allowed live partners: nationwide wide delivery first.
 * Kept for mock / heuristic fallback when the model does not mark an id.
 */
function pickWideDefault(live) {
  for (const id of WIDE_DEFAULT_IDS) {
    const hit = live.find((p) => p.id === id);
    if (hit) return hit;
  }
  const wide = live.find((p) => isWideCoveragePartner(p));
  if (wide) return wide;
  // Last resort among already geo-filtered live list.
  return live[0] || null;
}

/** Hidden end-of-reply mark: model selects 0–1 offer from the city pool. */
const PARTNER_MARK_RE = /\[\[\s*partner\s*:\s*([a-z0-9_-]+)\s*\]\]/gi;

function stripPartnerMark(text) {
  return String(text || '')
    .replace(PARTNER_MARK_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * All live partners available in the detected city.
 * City unknown → empty pool (soft clarify; do not push offers).
 * Never on first user turn / when allowPartner is false.
 * Geo lists (geo_mode + cities / nationwide) are the source of truth.
 */
function collectPartnerPool(messages, { allowPartner = false } = {}) {
  if (!allowPartner) return [];
  if (countUserTurns(messages) < 2) return [];

  const text = conversationText(messages);
  const city = detectCity(text);
  // Owner rule: without a city, do not inject offers (nationwide included).
  if (!city) return [];

  return loadPartners().filter(isLivePartner)
    .filter((p) => !partnerDeniedByGeo(p, text))
    .filter((p) => partnerAllowedByGeo(p, city));
}

/**
 * Legacy single-pick helper (brand → wide default) over the city pool.
 * Prefer collectPartnerPool + model choice; this remains for mock/heuristic.
 */
function pickPartner(messages, { allowPartner = false } = {}) {
  const pool = collectPartnerPool(messages, { allowPartner });
  if (!pool.length) return null;

  const text = conversationText(messages);
  let best = null;
  let bestBrand = 0;
  let bestTotal = 0;
  for (const p of pool) {
    const score = partnerTagScore(p, text);
    if (score.brand > bestBrand || (score.brand === bestBrand && score.total > bestTotal)) {
      bestBrand = score.brand;
      bestTotal = score.total;
      best = p;
    }
  }
  if (bestBrand > 0) return best;
  if (CLEAR_INTENT_RE.test(text)) return pickWideDefault(pool);
  return null;
}

/** Parse YYYY-MM-DD or null; expired if date is before local today. */
function promoExpiresOn(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d);
}

function isPromoExpired(expires) {
  const end = promoExpiresOn(expires);
  if (!end) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return end < today;
}

/** Drop trailing «до DD.MM.YYYY» from human terms — UI must not show expiry. */
function stripPromoExpiryPhrase(terms) {
  return String(terms || '')
    .replace(/,?\s*до\s+\d{1,2}[./]\d{1,2}[./]\d{2,4}\s*$/i, '')
    .replace(/,?\s*до\s+\d{4}-\d{2}-\d{2}\s*$/i, '')
    .trim()
    .replace(/[,\s—–-]+$/g, '')
    .trim();
}

/**
 * Normalize partner promos: prefer `promos[]`, else legacy promo_code + promo_terms.
 * Expired rows are dropped. Returned terms never include an expiry phrase.
 */
function normalizePartnerPromos(partner) {
  const rows = [];
  if (Array.isArray(partner?.promos)) {
    for (const raw of partner.promos) {
      if (!raw || typeof raw !== 'object') continue;
      const code = String(raw.code || '').trim();
      if (!code) continue;
      if (isPromoExpired(raw.expires)) continue;
      const terms = stripPromoExpiryPhrase(raw.terms || raw.promo_terms || '');
      rows.push({
        code,
        terms: terms || '',
        expires: raw.expires ? String(raw.expires).trim() : null,
      });
    }
  }
  if (!rows.length) {
    const code = partner?.promo_code != null ? String(partner.promo_code).trim() : '';
    if (code) {
      const terms = stripPromoExpiryPhrase(
        partner.promo_terms != null ? String(partner.promo_terms) : ''
      );
      rows.push({ code, terms: terms || '', expires: null });
    }
  }
  return rows;
}

function partnerPayload(partner) {
  if (!partner) return null;
  const promos = normalizePartnerPromos(partner);
  const primary = promos[0] || null;
  const legacyTerms =
    primary?.terms ||
    stripPromoExpiryPhrase(partner.promo_terms != null ? String(partner.promo_terms) : '') ||
    null;
  return {
    id: partner.id,
    name: partner.name,
    blurb: partner.blurb,
    link: partner.link,
    disclaimer: partner.disclaimer,
    offer_type: partner.offer_type || null,
    promo_code: primary ? primary.code : partner.promo_code || null,
    promo_terms: legacyTerms,
    promos,
  };
}

function partnerExcludeIds(partner) {
  return (Array.isArray(partner?.exclude_partners) ? partner.exclude_partners : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

/** Compact pool row for Gemini (skip tags / long promo lists — keeps TTFB down). */
function partnerPoolRow(partner) {
  const payload = partnerPayload(partner);
  const excludes = partnerExcludeIds(partner);
  return [
    `- id: ${payload.id}`,
    `  name: ${payload.name}`,
    `  blurb: ${payload.blurb || ''}`,
    `  link: ${payload.link}`,
    `  promo_code: ${payload.promo_code || ''}`,
    `  promo_terms: ${payload.promo_terms || ''}`,
    `  offer_type: ${payload.offer_type || 'affiliate'}`,
    `  disclaimer: ${payload.disclaimer || ''}`,
    `  exclude_partners: ${excludes.length ? excludes.join(', ') : '—'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function partnerGeoHintBlock(messages) {
  const text = conversationText(messages || []);
  const city = detectCity(text);
  if (!city) {
    return (
      '\n\nКонтекст гео: город пользователя ещё не определён. Партнёрский пул пуст — ' +
      'не предлагай бренды доставки и чужие ссылки; если уместен заказ/доставка — мягко спроси город одной фразой.'
    );
  }
  return `\n\nКонтекст гео: город пользователя ≈ «${city}».`;
}

/**
 * Inject the full city-local live pool into the system instruction.
 * Model chooses 0–1 offer; UI card follows [[partner:id]] (or URL/brand heuristic).
 */
function partnerPoolContextBlock(pool, messages = null) {
  const list = Array.isArray(pool) ? pool : [];
  let block = partnerGeoHintBlock(messages);
  if (!list.length) {
    block +=
      '\nПул live-партнёров для этого ответа: пуст. Молчи про партнёрские бренды и ссылки; общие советы без брендов — ок. Не ври, что «бэкенд не настроен».';
    return block;
  }
  const rows = list.map(partnerPoolRow).join('\n');
  block += `
Пул доступных live-партнёров в этом городе (ты сама выбираешь 0 или 1 по намерению пользователя):
${rows}
Правила выбора из пула:
• Максимум один оффер в одном ответе; можно выбрать ноль, если оффер не к месту.
• Если пользователь явно недоволен прошлым оффером или просит другую категорию/продукт — можно выбрать другой уместный id из этого пула (или ответить без оффера). Не упирайся в уже показанный бренд.
• Учитывай exclude_partners и эксклюзивы из системных правил (ЁбиДоёби ≠ Важная рыба/Тануки/Farfor; Додо ≠ Еаптека).
• URL и промокоды — ТОЛЬКО из этого пула, ничего не выдумывай.
• Предпочтение: мягко упомяни бренд/выгоду после пользы по рациону и в самом конце ответа поставь скрытую метку ровно одного выбранного id: [[partner:ID]] (например [[partner:dodo-pizza]]). Тогда UI нарисует карточку со ссылкой и промо — сырой URL и промокод в текст НЕ копируй.
• Если метку поставить нельзя — допустима одна ссылка из пула без дубля карточки.
• Не говори, что офферов/ссылок нет или что «нужно настраивать бэкенд».`;
  return block;
}

/**
 * Resolve 0–1 partner after the model reply: mark → URL from pool → brand heuristic.
 */
function resolveSelectedPartner(assembledText, pool) {
  const list = Array.isArray(pool) ? pool : [];
  if (!list.length) return null;
  const text = String(assembledText || '');
  const markRe = /\[\[\s*partner\s*:\s*([a-z0-9_-]+)\s*\]\]/i;
  const mark = text.match(markRe);
  if (mark) {
    const id = mark[1].toLowerCase();
    const hit = list.find((p) => p.id === id);
    if (hit) return hit;
  }
  for (const p of list) {
    const link = String(p.link || '').trim();
    if (link && text.includes(link)) return p;
  }
  const lower = text.toLowerCase();
  let best = null;
  let bestBrand = 0;
  for (const p of list) {
    const score = partnerTagScore(p, lower);
    const name = String(p.name || '').toLowerCase();
    const nameHit = name && lower.includes(name);
    const brand = score.brand + (nameHit ? 3 : 0);
    if (brand > bestBrand) {
      bestBrand = brand;
      best = p;
    }
  }
  return bestBrand > 0 ? best : null;
}

/**
 * Owner strategy catalog: live ids/names only — never URLs/promo here.
 * User-facing offer is at most one UI card from the city pool.
 */
function ownerPartnersCatalogBlock(messages) {
  if (!hasOwnerCodeword(messages)) return '';
  const live = loadPartners().filter(isLivePartner);
  if (!live.length) return '';
  const lines = live.map((p) => {
    const promo = p.promo_code ? 'promo:да' : 'promo:нет';
    const cover = isWideCoveragePartner(p) ? 'wide' : 'geo';
    return `- ${p.id} — ${p.name} (${promo}, ${cover})`;
  });
  return (
    '\n\nКаталог live-партнёров для владельца (только id/name, без URL и без промокодов):\n' +
    lines.join('\n') +
    '\nПул живой; пользователю — максимум одна UI-карточка из городского пула (метка [[partner:id]] или эвристика). ' +
    'Владельцу для стратегии можно кратко перечислить эти id/названия без ссылок.'
  );
}

function donateUrlForPrompt() {
  const url = String(DONATE_URL || '').trim();
  if (!url || url === '#donate' || url.startsWith('#')) return null;
  return url;
}

/** System prompt + mode overlay + donate + city partner pool + owner catalog. */
function buildSystemInstruction(mode = null, poolOrPartner = null, messages = null) {
  let extra = modeOverlayBlock(mode);
  const donateUrl = donateUrlForPrompt();
  if (donateUrl) {
    extra += `

Контекст доната (не рекламируй; только по правилам 10–13 из промпта):
DONATE_URL: ${donateUrl}
Не вставляй голый URL доната. Если даёшь ссылку — только markdown: [Поддержать НутриКод](${donateUrl}). Иначе без ссылки: «кнопка поддержки ниже» (мягкая кнопка без суммы).`;
  } else {
    extra += `

Контекст доната (не рекламируй; только по правилам 10–13 из промпта):
DONATE_URL нет — если уместно предложить поддержку, скажи «кнопка поддержки ниже» (мягкая кнопка без суммы), без URL.`;
  }
  // Accept either a pool array or a legacy single partner object.
  const pool = Array.isArray(poolOrPartner)
    ? poolOrPartner
    : poolOrPartner
      ? [poolOrPartner]
      : [];
  extra += partnerPoolContextBlock(pool, messages);
  extra += ownerPartnersCatalogBlock(messages);
  return loadSystemPrompt() + extra;
}

function toGeminiContents(messages) {
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 8000) }],
    }));
}

/** Strip API keys / long token-like blobs from logs. Never print secrets. */
function redactSecrets(text) {
  return String(text || '')
    .replace(/key=[^&\s"']+/gi, 'key=[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 280);
}

const OVERLOAD_USER_MESSAGE =
  'Сейчас у ИИ высокая нагрузка — это временно. Подождите минуту и напишите снова, обычно всё снова отвечает.';

function parseGeminiErrorBody(rawBody) {
  let code = '';
  let message = '';
  try {
    const parsed = JSON.parse(rawBody);
    code = String(parsed?.error?.status || parsed?.error?.code || '');
    message = parsed?.error?.message || '';
  } catch {
    message = rawBody;
  }
  return { code, message };
}

function summarizeGeminiError(status, rawBody, model = GEMINI_MODEL) {
  const { code, message } = parseGeminiErrorBody(rawBody);
  const safeMessage = redactSecrets(message).replace(/\s+/g, ' ').trim();
  console.error(
    `[gemini] upstream status=${status} model=${model} code=${code || 'n/a'} msg=${safeMessage || '(empty)'}`
  );

  if (isOverloadError(status, code, message)) {
    return OVERLOAD_USER_MESSAGE;
  }
  if (
    status === 401 ||
    status === 403 ||
    /API[_\s-]?KEY|PERMISSION|UNAUTHENTICATED|not valid/i.test(`${code} ${message}`)
  ) {
    return 'Сейчас не удаётся связаться с моделью. Загляните позже — обычно это быстро проходит.';
  }
  if (status === 404 || /NOT_FOUND|model/i.test(`${code} ${message}`)) {
    return 'Модель временно недоступна. Попробуйте чуть позже.';
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate/i.test(`${code} ${message}`)) {
    return 'Слишком много запросов. Подождите минуту и напишите снова.';
  }
  if (status >= 500) {
    return 'У модели короткий перерыв. Напишите ещё раз через минуту.';
  }
  return 'Ответ пока не пришёл. Можно повторить через минуту.';
}

/**
 * Open a Gemini SSE stream with one API key.
 * On 503/UNAVAILABLE: backoff retries, then next model in chain.
 * @param {object} body request JSON
 * @param {string[]} [models] override chain (e.g. stick to one model on MAX_TOKENS continue)
 * @param {{ id: number, key: string }} keySlot
 * @returns {Promise<{ upstream: Response, model: string, keyId: number } | { errorText: string, status: number, model: string, keyId: number, failoverWorthy: boolean }>}
 */
async function openGeminiStreamWithKey(body, models, keySlot, { signal } = {}) {
  const chain = models.length ? models : GEMINI_MODEL_CHAIN;
  const apiKey = keySlot.key;
  const keyId = keySlot.id;
  let lastFailure = {
    errorText: OVERLOAD_USER_MESSAGE,
    status: 503,
    model: chain[0],
    keyId,
    failoverWorthy: true,
  };

  for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
    const model = chain[modelIndex];
    const attempts = OVERLOAD_RETRIES + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) {
        lastFailure = {
          errorText: 'Связь прервалась. Проверьте сеть и напишите снова.',
          status: 0,
          model,
          keyId,
          failoverWorthy: false,
        };
        return lastFailure;
      }

      console.info(
        `[gemini] request key=${keyId} model=${model} attempt=${attempt + 1}/${attempts} chain=${modelIndex + 1}/${chain.length}`
      );

      let upstream;
      const attemptCtrl = new AbortController();
      const onAbort = () => attemptCtrl.abort();
      if (signal) {
        if (signal.aborted) {
          attemptCtrl.abort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      const timeoutId = setTimeout(() => attemptCtrl.abort(), GEMINI_FETCH_TIMEOUT_MS);
      try {
        upstream = await fetch(geminiStreamUrl(model, apiKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: attemptCtrl.signal,
        });
      } catch (err) {
        const aborted = attemptCtrl.signal.aborted || signal?.aborted;
        const timedOut = aborted && !signal?.aborted;
        console.error(
          `[gemini] fetch failed key=${keyId} model=${model}${timedOut ? ' timeout' : ''}`,
          redactSecrets(err?.message || String(err))
        );
        lastFailure = {
          errorText: timedOut
            ? 'Модель отвечает слишком долго. Напишите ещё раз — обычно со второго раза быстрее.'
            : 'Связь прервалась. Проверьте сеть и напишите снова.',
          status: 0,
          model,
          keyId,
          failoverWorthy: true,
        };
        if (signal?.aborted) return lastFailure;
        if (attempt < attempts - 1) {
          await sleep(OVERLOAD_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        break;
      } finally {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      if (upstream.ok) {
        if (model !== GEMINI_MODEL) {
          console.info(`[gemini] fallback ok key=${keyId} model=${model} (primary was ${GEMINI_MODEL})`);
        }
        return { upstream, model, keyId };
      }

      const errText = await upstream.text().catch(() => '');
      const { code, message } = parseGeminiErrorBody(errText);
      const failoverWorthy = isKeyFailoverError(upstream.status, code, message);
      lastFailure = {
        errorText: summarizeGeminiError(upstream.status, errText, model),
        status: upstream.status,
        model,
        keyId,
        failoverWorthy,
      };

      if (isOverloadError(upstream.status, code, message)) {
        const canRetry = attempt < attempts - 1;
        const canFallback = modelIndex < chain.length - 1;
        console.warn(
          `[gemini] overload key=${keyId} model=${model} status=${upstream.status} code=${code || 'n/a'} retry=${canRetry} fallback=${canFallback}`
        );
        if (canRetry) {
          await sleep(OVERLOAD_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        // Exhausted retries on this model — try next in chain.
        break;
      }

      // 429/quota: stop this key's model chain; outer layer may failover once.
      if (failoverWorthy) {
        console.warn(
          `[gemini] key=${keyId} failover-worthy status=${upstream.status} code=${code || 'n/a'}`
        );
        return lastFailure;
      }

      // Non-failover failure (auth/404/etc.): stop immediately.
      return lastFailure;
    }
  }

  return lastFailure;
}

/**
 * Open Gemini SSE with dual-key failover.
 * One automatic switch to the other key on 429/quota/503/network — no ping-pong loop.
 * @param {object} body request JSON
 * @param {string[]} [models] override chain
 */
async function openGeminiStream(body, models = GEMINI_MODEL_CHAIN, { signal } = {}) {
  const slots = orderedGeminiKeySlots();
  if (!slots.length) {
    return {
      errorText: 'Ключ Gemini не задан.',
      status: 0,
      model: GEMINI_MODEL,
      keyId: null,
      failoverWorthy: false,
    };
  }

  let lastFailure = null;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const result = await openGeminiStreamWithKey(body, models, slot, { signal });
    if (result?.upstream) {
      if (activeGeminiKeyId !== slot.id) {
        console.info(`[gemini] primary key switched ${activeGeminiKeyId || 'n/a'} → ${slot.id}`);
        activeGeminiKeyId = slot.id;
      }
      return result;
    }
    lastFailure = result;
    if (signal?.aborted) break;
    const canFailover =
      i === 0 &&
      slots.length > 1 &&
      result?.failoverWorthy === true;
    if (canFailover) {
      console.warn(
        `[gemini] key ${slot.id} failed (status=${result.status || 0}) — one failover to key ${slots[1].id}`
      );
      continue;
    }
    break;
  }

  return lastFailure || {
    errorText: OVERLOAD_USER_MESSAGE,
    status: 503,
    model: GEMINI_MODEL,
    keyId: activeGeminiKeyId,
    failoverWorthy: false,
  };
}

const MOCK_REPLY =
  'Спасибо, что рассказали. Для старта держитесь простого каркаса: овощи или зелень в каждом приёме пищи, белок (рыба, яйца, бобовые, птица — что вам подходит), полезные жиры (орехи, авокадо, растительное масло) и привычные углеводы без жёстких запретов.\n\n' +
  'Пример дня: завтрак — овсянка на воде или молоке с ягодами и горстью орехов; обед — гречка или киноа, запечённая рыба или тофу, большой салат; ужин — овощной суп или омлет с зеленью и цельнозерновой хлеб; перекус — йогурт без сахара, фрукты или хумус с морковью.\n\n' +
  'Если есть аллергии или ограничения — напишите их, и я подстрою пример дня под вас. Это общий ориентир по рациону, не медицинская рекомендация. Готово.';

function writeEvent(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

/** SSE comment frame — keeps the pipe warm without changing UI state. */
function writeSseComment(res, comment = 'ping') {
  res.write(`: ${comment}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

/**
 * Heartbeat while Gemini open/read is blocked: comment + occasional thinking status.
 * Stops when the returned disposer runs (first token / error / done).
 */
function startSseHeartbeat(res, { onTick } = {}) {
  let ticks = 0;
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    ticks += 1;
    try {
      writeSseComment(res, `hb-${ticks}`);
      if (typeof onTick === 'function') onTick(ticks);
    } catch {
      clearInterval(timer);
    }
  }, SSE_HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * Parse one Gemini SSE `data:` JSON payload.
 * @returns {{ text: string, finishReason: string, error?: object }}
 */
function parseGeminiSsePayload(payload) {
  if (!payload || payload === '[DONE]') return { text: '', finishReason: '' };
  const json = JSON.parse(payload);
  if (json?.error) return { text: '', finishReason: '', error: json.error };
  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason || '';
  const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
  return { text, finishReason, error: null };
}

/**
 * Read Gemini upstream SSE to completion, flushing the leftover buffer
 * (last event often arrives without a trailing blank line).
 */
async function readGeminiSse(upstreamBody, onText) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;
  let finishReason = '';
  let assembled = '';

  const attachPartial = (err) => {
    if (!err || typeof err !== 'object') return err;
    err.partialText = assembled;
    err.partialTokenCount = tokenCount;
    err.partialFinishReason = finishReason;
    return err;
  };

  const handleDataLine = (trimmed) => {
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    let parsed;
    try {
      parsed = parseGeminiSsePayload(payload);
    } catch {
      return;
    }
    if (parsed.error) {
      const err = attachPartial(new Error('gemini_upstream_error'));
      err.geminiError = parsed.error;
      throw err;
    }
    if (parsed.finishReason) finishReason = parsed.finishReason;
    if (parsed.text) {
      tokenCount += 1;
      assembled += parsed.text;
      onText(parsed.text);
    }
  };

  const drain = (flushAll) => {
    const parts = buffer.split(/\r?\n/);
    if (!flushAll) {
      buffer = parts.pop() || '';
    } else {
      buffer = '';
    }
    for (const line of parts) {
      handleDataLine(line.trim());
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
    buffer += decoder.decode();
    if (buffer.trim()) drain(true);
  } catch (err) {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* ignore */
    }
    throw attachPartial(err);
  }

  return { tokenCount, finishReason, text: assembled };
}

async function streamMock(res, partner) {
  // Staged wait: thinking → typing → tokens (client also rotates calm Russian phrases).
  writeEvent(res, { type: 'status', stage: 'thinking' });
  await new Promise((r) => setTimeout(r, 1200));
  writeEvent(res, { type: 'status', stage: 'typing' });
  await new Promise((r) => setTimeout(r, 700));
  const chunks = MOCK_REPLY.match(/.{1,24}|[\s\S]/g) || [MOCK_REPLY];
  for (const chunk of chunks) {
    writeEvent(res, { type: 'token', text: chunk });
    await new Promise((r) => setTimeout(r, 18));
  }
  if (partner) {
    writeEvent(res, { type: 'partner', partner: partnerPayload(partner) });
  }
  writeEvent(res, { type: 'done', mock: true, finishReason: 'STOP' });
  res.end();
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const allowPartner = Boolean(req.body?.allowPartner);

  // Hard reject oversized newest user turn before SSE / Gemini (history context still slice-capped separately).
  const newestUserText = lastUserText(messages);
  if (newestUserText.length > MAX_USER_MESSAGE_CHARS) {
    res.status(413).json({
      type: 'error',
      text: USER_MESSAGE_TOO_LONG_TEXT,
      maxUserMessageChars: MAX_USER_MESSAGE_CHARS,
      length: newestUserText.length,
    });
    return;
  }

  const mode = resolveChatMode(req.body?.mode, messages);
  const partnerPool = collectPartnerPool(messages, { allowPartner });
  // Mock / no-key path still needs a single heuristic card from the city pool.
  const mockPartner = pickPartner(messages, { allowPartner });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable Nagle so each token write can leave the socket promptly.
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders?.();

  const chatStartedAt = Date.now();
  let firstTokenAt = 0;

  // Tell the client which mode actually applied (explicit or quiet auto-detect).
  writeEvent(res, { type: 'mode', mode: { id: mode.id, label: mode.label, source: mode.source } });

  if (!GEMINI_KEY_SLOTS.length) {
    writeEvent(res, {
      type: 'notice',
      text: 'Ключ GEMINI_API_KEY не задан — показываю демо-ответ, чтобы можно было оценить интерфейс.',
    });
    await streamMock(res, mockPartner);
    return;
  }

  writeEvent(res, { type: 'status', stage: 'thinking', text: 'Думает…' });
  // Kick the socket immediately so «думает» is not stuck behind Gemini TTFB.
  writeSseComment(res, 'open');

  const stopHeartbeat = startSseHeartbeat(res, {
    onTick: (ticks) => {
      if (firstTokenAt) return;
      if (ticks === 3) {
        writeEvent(res, { type: 'status', stage: 'thinking', text: 'Ещё думаю…' });
      } else if (ticks === 7) {
        writeEvent(res, {
          type: 'status',
          stage: 'thinking',
          text: 'Модель отвечает дольше обычного — почти готово…',
        });
      }
    },
  });

  const systemInstruction = {
    parts: [{ text: buildSystemInstruction(mode, partnerPool, messages) }],
  };
  let contents = toGeminiContents(messages);
  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  const buildContinueContents = (soFar) => [
    ...contents,
    { role: 'model', parts: [{ text: String(soFar || '').slice(-12000) }] },
    {
      role: 'user',
      parts: [
        {
          text: 'Продолжи ответ точно с того места, где оборвался. Не повторяй уже сказанное, без нового вступления.',
        },
      ],
    },
  ];

  try {
    console.info(
      `[gemini] chat turns=${messages.length} mode=${mode.id}/${mode.source} pool=${partnerPool.map((p) => p.id).join(',') || 'none'} maxOutputTokens=${MAX_OUTPUT_TOKENS} chain=${GEMINI_MODEL_CHAIN.join(
        '→'
      )}`
    );

    let tokenCount = 0;
    let finishReason = '';
    let assembled = '';
    let continues = 0;
    let signaledTyping = false;
    let activeModel = GEMINI_MODEL;
    let incomplete = false;
    let lastErrorText = '';

    for (let attempt = 0; attempt <= MAX_CONTINUES; attempt++) {
      const requestBody = {
        system_instruction: systemInstruction,
        contents: attempt === 0 ? contents : buildContinueContents(assembled),
        generationConfig,
      };

      // Full retry + fallback on first segment; continues stick to the model that worked.
      // No client-req abort signal — req 'close' fires after body parse and was cutting streams (#15 regression).
      const opened = await openGeminiStream(
        requestBody,
        attempt === 0 || !activeModel ? GEMINI_MODEL_CHAIN : [activeModel]
      );

      if (!opened?.upstream) {
        // Honest retry: if we already have partial text, try one continue instead of silent end.
        if (assembled.length && attempt < MAX_CONTINUES) {
          continues += 1;
          console.warn(
            `[gemini] open failed after partial — continue ${continues}/${MAX_CONTINUES} chars=${assembled.length}`
          );
          incomplete = true;
          lastErrorText = opened?.errorText || OVERLOAD_USER_MESSAGE;
          continue;
        }
        stopHeartbeat();
        const failStatus = opened?.status || 0;
        const kind = classifyGeminiFailure(failStatus, '', opened?.errorText || '');
        void recordChatError(kind, defaultWarningMessage(kind));
        if (assembled.length) {
          writeEvent(res, { type: 'notice', text: INCOMPLETE_ANSWER_NOTICE });
          incomplete = true;
        }
        writeEvent(res, {
          type: 'error',
          text: opened?.errorText || lastErrorText || OVERLOAD_USER_MESSAGE,
        });
        writeEvent(res, {
          type: 'done',
          finishReason: 'ERROR',
          incomplete: true,
          truncated: true,
        });
        res.end();
        return;
      }

      activeModel = opened.model;

      if (!signaledTyping) {
        writeEvent(res, { type: 'status', stage: 'typing', text: 'Печатает…' });
        signaledTyping = true;
      }

      let segment;
      try {
        segment = await readGeminiSse(opened.upstream.body, (text) => {
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
            stopHeartbeat();
            console.info(
              `[gemini] ttfb_ms=${firstTokenAt - chatStartedAt} model=${activeModel} key=${opened.keyId || 'n/a'}`
            );
          }
          writeEvent(res, { type: 'token', text });
        });
      } catch (err) {
        const partial = String(err?.partialText || '');
        if (partial) {
          assembled += partial;
          tokenCount += Number(err.partialTokenCount) || 0;
        }
        if (err?.geminiError && assembled.length && attempt < MAX_CONTINUES) {
          continues += 1;
          incomplete = true;
          console.warn(
            `[gemini] mid-stream error — continue ${continues}/${MAX_CONTINUES} chars=${assembled.length}`
          );
          continue;
        }
        stopHeartbeat();
        if (err?.geminiError) {
          const statusNum = Number(err.geminiError.code) || 500;
          const kind = classifyGeminiFailure(
            statusNum,
            err.geminiError.status || err.geminiError.code,
            err.geminiError.message
          );
          void recordChatError(kind, defaultWarningMessage(kind));
          const calm = summarizeGeminiError(
            err.geminiError.code || 500,
            JSON.stringify({ error: err.geminiError }),
            activeModel
          );
          if (assembled.length) {
            writeEvent(res, { type: 'notice', text: INCOMPLETE_ANSWER_NOTICE });
          }
          writeEvent(res, { type: 'error', text: calm });
          writeEvent(res, {
            type: 'done',
            finishReason: 'ERROR',
            incomplete: Boolean(assembled.length),
            truncated: Boolean(assembled.length),
          });
          res.end();
          return;
        }
        throw err;
      }

      tokenCount += segment.tokenCount;
      finishReason = segment.finishReason || finishReason;
      assembled += segment.text;

      if (segment.finishReason === 'STOP' || segment.finishReason === 'END_TURN') {
        incomplete = false;
        break;
      }

      if (segment.finishReason !== 'MAX_TOKENS' || !segment.text || attempt === MAX_CONTINUES) {
        if (segment.finishReason === 'MAX_TOKENS') incomplete = true;
        break;
      }

      continues += 1;
      incomplete = false;
      console.info(
        `[gemini] MAX_TOKENS — continue ${continues}/${MAX_CONTINUES} model=${activeModel} soFarChars=${assembled.length}`
      );
    }

    stopHeartbeat();

    const cleanFinish =
      finishReason === 'STOP' || finishReason === 'END_TURN' || (!incomplete && assembled.length > 0);
    const selected = cleanFinish ? resolveSelectedPartner(assembled, partnerPool) : null;
    if (selected) {
      writeEvent(res, { type: 'partner', partner: partnerPayload(selected) });
    }

    if (incomplete && assembled.length) {
      writeEvent(res, { type: 'notice', text: INCOMPLETE_ANSWER_NOTICE });
    }

    const finalReason = cleanFinish ? finishReason || 'STOP' : finishReason || 'ERROR';
    console.info(
      `[gemini] done model=${activeModel} chunks=${tokenCount} finishReason=${finalReason} continues=${continues} chars=${assembled.length} selected=${selected ? selected.id : 'none'} incomplete=${incomplete} ttfb_ms=${firstTokenAt ? firstTokenAt - chatStartedAt : -1} total_ms=${Date.now() - chatStartedAt}`
    );
    if (assembled.length > 0 && cleanFinish) {
      void recordChatSuccess();
    } else if (!assembled.length || incomplete) {
      void recordChatError('outage', defaultWarningMessage('outage'));
    }
    writeEvent(res, {
      type: 'done',
      finishReason: finalReason,
      truncated: incomplete || finishReason === 'MAX_TOKENS',
      incomplete,
      model: activeModel,
    });
    res.end();
  } catch (err) {
    stopHeartbeat();
    console.error('[gemini] stream failed', redactSecrets(err?.message || String(err)));
    void recordChatError('outage', defaultWarningMessage('outage'));
    writeEvent(res, {
      type: 'error',
      text: 'Связь прервалась. Проверьте сеть и напишите снова.',
    });
    writeEvent(res, { type: 'done', finishReason: 'ERROR', incomplete: true });
    res.end();
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

if (require.main === module) {
  // Master: one worker per CPU; workers serve HTTP. Dead workers are forked again — master stays up.
  if (cluster.isPrimary) {
    attachClusterRateLimitMaster(CHAT_RATE_WINDOW_MS);
    attachClusterStatsMaster();
    const workers = Math.max(1, os.cpus().length);
    console.log(`НутриКод master pid=${process.pid} — starting ${workers} worker(s)`);
    for (let i = 0; i < workers; i++) {
      cluster.fork();
    }
    cluster.on('exit', (worker, code, signal) => {
      console.warn(
        `Worker ${worker.process.pid} exited (code=${code}, signal=${signal || 'n/a'}) — respawning`
      );
      cluster.fork();
    });
  } else {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `НутриКод worker pid=${process.pid} on http://127.0.0.1:${PORT} (keys: ${
          GEMINI_KEY_SLOTS.length || 'mock'
        }, active: ${activeGeminiKeyId || 'n/a'}, model: ${GEMINI_MODEL}, chain: ${GEMINI_MODEL_CHAIN.join('→')})`
      );
    });
  }
}

module.exports = {
  app,
  loadSystemPrompt,
  loadPartners,
  invalidateContentCache,
  requireAdmin,
  classifyGeminiFailure,
  parseModelChain,
  isOverloadError,
  isKeyFailoverError,
  geminiKeyStatus,
  summarizeGeminiError,
  openGeminiStream,
  openGeminiStreamWithKey,
  pickPartner,
  collectPartnerPool,
  resolveSelectedPartner,
  stripPartnerMark,
  partnerPoolContextBlock,
  isLivePartner,
  partnerPayload,
  normalizePartnerPromos,
  isPromoExpired,
  stripPromoExpiryPhrase,
  partnerTagScore,
  partnerDeniedByGeo,
  partnerAllowedByGeo,
  partnerGeoMode,
  detectCity,
  isWideCoveragePartner,
  pickWideDefault,
  hasOwnerCodeword,
  ownerPartnersCatalogBlock,
  CLEAR_INTENT_RE,
  INTENT_RE,
  PARTNER_MARK_RE,
  WIDE_DEFAULT_IDS,
  OVERLOAD_USER_MESSAGE,
  MAX_USER_MESSAGE_CHARS,
  USER_MESSAGE_TOO_LONG_TEXT,
  lastUserText,
  GEMINI_MODEL,
  GEMINI_MODEL_CHAIN,
  DEFAULT_FALLBACK_MODELS,
  CHAT_MODES,
  MODE_IDS,
  normalizeModeId,
  resolveChatMode,
  modeOverlayBlock,
  buildSystemInstruction,
};
