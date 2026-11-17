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
/**
 * Gemini API origin. On RU VPS, set GEMINI_API_ORIGIN to an allowed proxy host —
 * direct generativelanguage.googleapis.com returns FAILED_PRECONDITION (location).
 */
const GEMINI_API_ORIGIN = (
  process.env.GEMINI_API_ORIGIN || 'https://generativelanguage.googleapis.com'
).replace(/\/$/, '');
/** Slot 1 = GEMINI_API_KEY, slot 2 = GEMINI_API_KEY_2 (sticky primary after successful failover). */
const GEMINI_KEY_SLOTS = [
  { id: 1, key: String(process.env.GEMINI_API_KEY || '').trim() },
  { id: 2, key: String(process.env.GEMINI_API_KEY_2 || '').trim() },
].filter((slot) => slot.key);
const GEMINI_API_KEY = GEMINI_KEY_SLOTS[0]?.key || '';
let activeGeminiKeyId = GEMINI_KEY_SLOTS[0]?.id || null;
/** Prefer lean/fast models first under free-tier load; gemini-3.8-flash is opt-in via env. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
/** Default chain after the primary model when Gemini returns 503 / UNAVAILABLE. */
const DEFAULT_FALLBACK_MODELS = ['gemini-3.6-flash'];
const DONATE_URL = process.env.DONATE_URL || '#donate';
/** Single place for the VK community footer link (override via env if shortname changes). */
const COMMUNITY_VK_URL = process.env.COMMUNITY_VK_URL || 'https://vk.ru/ai.nutricode';

/**
 * Product auto-deeplink (Admitad ulp).
 * Pattern: merchant search/program URL → encodeURIComponent into webmaster base as &ulp=.
 * VkusVill search (verified 200): https://vkusvill.ru/search/?q=
 * Важная рыба search (verified 200): https://vipfish.ru/search/?q=
 * BeFit: WP search https://letbefit.ru/?s= ( /search/?q= → 404); programs /programmy/{slug}/.
 */
const VKUSVILL_SEARCH_PREFIX = 'https://vkusvill.ru/search/?q=';
const DEFAULT_ADMITAD_VKUSVILL_BASE =
  'https://kdbov.com/g/2xtzn37pfe268e100ca0b80ad6f8ae/?erid=2bL9aMPo2e49hMef4phUrdrQCx';
const DEFAULT_ADMITAD_VKUSVILL_ERID = '2bL9aMPo2e49hMef4phUrdrQCx';

const VIPFISH_SEARCH_PREFIX = 'https://vipfish.ru/search/?q=';
const DEFAULT_ADMITAD_VIPFISH_BASE =
  'https://dorinebeaumont.com/g/lqb6l7197z268e100ca094cf89477e/?erid=2bL9aMPo2e49hMef4peVndVUPr';
const DEFAULT_ADMITAD_VIPFISH_ERID = '2bL9aMPo2e49hMef4peVndVUPr';
/** Owner banner zones — soft-gate in prompt; chips use [[vipfish:…]] / [[ryba:…]]. */
const VIPFISH_GEO_CITIES = [
  'Санкт-Петербург',
  'Мурино',
  'Бугры',
  'Пушкин',
  'Петергоф',
  'Всеволожск',
  'Кудрово',
  'Шушары',
  'Сестрорецк',
];

/** BeFit (letbefit.ru) — WP search works; /search/?q= 404. Chips: [[befit:…]] / [[letbefit:…]]. */
const BEFIT_SEARCH_PREFIX = 'https://letbefit.ru/?s=';
const BEFIT_PROGRAM_PREFIX = 'https://letbefit.ru/programmy/';
const DEFAULT_ADMITAD_BEFIT_BASE =
  'https://uuwgc.com/g/qm29jzxwek268e100ca0fcd3300043/?erid=25H8d7vbP8SRTvJZjHsUpp';
const DEFAULT_ADMITAD_BEFIT_ERID = '25H8d7vbP8SRTvJZjHsUpp';
/** Soft-geo from partner brief (MSK + SPb). */
const BEFIT_GEO_CITIES = ['Москва', 'Санкт-Петербург'];
/** Verified program slugs from letbefit.ru home (2026-11-17). */
const BEFIT_PROGRAM_SLUGS = [
  'balance',
  'balancepremium',
  'daily',
  'everydaily',
  'extralightpremium',
  'fish',
  'fishpremium',
  'gluten_free',
  'gotovoe-menyu-dlya-pohudeniya',
  'gotovoe-menyu-dlya-sportsmenov',
  'keto-start',
  'light',
  'lightpremium',
  'middlesea',
  'nabor-myshechnoj-massy',
  'normal',
  'normalpremium',
  'strong',
  'strongpremium',
  'superstrongpremium',
  'vegetarian',
  'veggi',
];
/** Friendly aliases → verified slug (Energy* → sports page; no /programmy/energy*). */
const BEFIT_PROGRAM_ALIASES = {
  keto: 'keto-start',
  ketostart: 'keto-start',
  'keto start': 'keto-start',
  energy: 'gotovoe-menyu-dlya-sportsmenov',
  'energy max': 'gotovoe-menyu-dlya-sportsmenov',
  energymax: 'gotovoe-menyu-dlya-sportsmenov',
  'energy-max': 'gotovoe-menyu-dlya-sportsmenov',
  sport: 'gotovoe-menyu-dlya-sportsmenov',
  sports: 'gotovoe-menyu-dlya-sportsmenov',
  спорт: 'gotovoe-menyu-dlya-sportsmenov',
  кето: 'keto-start',
  'super strong premium': 'superstrongpremium',
  superstrong: 'superstrongpremium',
  'набор массы': 'nabor-myshechnoj-massy',
  похудение: 'gotovoe-menyu-dlya-pohudeniya',
};

/** Strip ulp so we can append a fresh double-encoded target; keep erid and other params. */
function normalizeAdmitadBase(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.searchParams.delete('ulp');
    let out = `${url.origin}${url.pathname}`;
    const qs = url.searchParams.toString();
    if (qs) out += `?${qs}`;
    return out;
  } catch {
    return value
      .replace(/([?&])ulp=[^&]*/gi, '$1')
      .replace(/[?&]$/, '')
      .replace(/\?&/, '?');
  }
}

function eridFromUrl(raw) {
  try {
    return String(new URL(String(raw || '').trim()).searchParams.get('erid') || '').trim();
  } catch {
    return '';
  }
}

/**
 * Admitad webmaster hosts only — never raw merchant landings
 * (vkusvill.ru / vipfish.ru / letbefit.ru).
 * VV kdbov.com; рыба dorinebeaumont.com; BeFit uuwgc.com; classic admitad.com also ok.
 */
function looksLikeAdmitadWebmaster(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return false;
  if (/vkusvill\.ru|vipfish\.ru|letbefit\.ru/i.test(value)) return false;
  return /kdbov\.com|dorinebeaumont\.com|uuwgc\.com|admitad\.com|ad\.admitad\.com/i.test(
    value
  );
}

function findPartnerRow(partners, id) {
  const needle = String(id || '')
    .trim()
    .toLowerCase();
  if (!needle || !Array.isArray(partners)) return null;
  return (
    partners.find((p) => p && String(p.id || '').toLowerCase() === needle) || null
  );
}

function resolveAdmitadDeeplinkConfig({
  partners,
  partnerId,
  envBaseKey,
  envEridKey,
  defaultBase,
  defaultErid,
  searchPrefix,
  extra = {},
}) {
  const row = findPartnerRow(partners, partnerId);
  const fromEnvBase = String(process.env[envBaseKey] || '').trim();
  const fromPartnerAdmitad = String((row && row.admitad_base) || '').trim();
  const fromPartnerLink = String((row && row.link) || '').trim();
  const candidate =
    (looksLikeAdmitadWebmaster(fromEnvBase) && fromEnvBase) ||
    (looksLikeAdmitadWebmaster(fromPartnerAdmitad) && fromPartnerAdmitad) ||
    (looksLikeAdmitadWebmaster(fromPartnerLink) && fromPartnerLink) ||
    defaultBase;
  const base = normalizeAdmitadBase(candidate);
  const fromEnvErid = String(process.env[envEridKey] || '').trim();
  const fromPartnerErid = String((row && row.erid) || '').trim();
  const erid =
    fromEnvErid || fromPartnerErid || eridFromUrl(base) || defaultErid;
  return {
    admitadBase: base,
    erid,
    searchPrefix,
    enabled: Boolean(base),
    promoCode: String((row && row.promo_code) || '').trim() || null,
    disclaimer: String((row && row.disclaimer) || '').trim() || null,
    legalName: String((row && row.legal_name) || '').trim() || null,
    inn: String((row && row.inn) || '').trim() || null,
    ...extra,
  };
}

function resolveVkusvillDeeplinkConfig(partners) {
  return resolveAdmitadDeeplinkConfig({
    partners,
    partnerId: 'vkusvill',
    envBaseKey: 'ADMITAD_VKUSVILL_BASE',
    envEridKey: 'ADMITAD_VKUSVILL_ERID',
    defaultBase: DEFAULT_ADMITAD_VKUSVILL_BASE,
    defaultErid: DEFAULT_ADMITAD_VKUSVILL_ERID,
    searchPrefix: VKUSVILL_SEARCH_PREFIX,
  });
}

function resolveVipfishDeeplinkConfig(partners) {
  const row =
    findPartnerRow(partners, 'vazhnaya-ryba') ||
    findPartnerRow(partners, 'vipfish');
  const geoFromPartner = Array.isArray(row && row.geo) ? row.geo : null;
  const cities =
    geoFromPartner && geoFromPartner.length
      ? geoFromPartner.map((c) => String(c || '').trim()).filter(Boolean)
      : VIPFISH_GEO_CITIES.slice();
  const cfg = resolveAdmitadDeeplinkConfig({
    partners: row ? [row] : partners,
    partnerId: (row && row.id) || 'vazhnaya-ryba',
    envBaseKey: 'ADMITAD_VIPFISH_BASE',
    envEridKey: 'ADMITAD_VIPFISH_ERID',
    defaultBase: DEFAULT_ADMITAD_VIPFISH_BASE,
    defaultErid: DEFAULT_ADMITAD_VIPFISH_ERID,
    searchPrefix: VIPFISH_SEARCH_PREFIX,
  });
  return {
    ...cfg,
    id: 'vazhnaya-ryba',
    name: String((row && row.name) || 'Важная рыба'),
    cities,
    tagPrefixes: ['vipfish', 'ryba'],
  };
}

function normalizeBefitPromos(row) {
  const fromRow = Array.isArray(row && row.promos) ? row.promos : null;
  if (fromRow && fromRow.length) {
    return fromRow
      .map((p) => {
        if (!p || typeof p !== 'object') return null;
        const codeRaw = p.code;
        const code =
          codeRaw == null || codeRaw === ''
            ? null
            : String(codeRaw).trim() || null;
        return {
          code,
          discount: String(p.discount || '').trim() || null,
          when: String(p.when || '').trim() || null,
        };
      })
      .filter(Boolean);
  }
  return [];
}

function resolveBefitProgramSlug(label, aliases = BEFIT_PROGRAM_ALIASES, slugs = BEFIT_PROGRAM_SLUGS) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  let key = raw.toLowerCase().replace(/^\/+/, '');
  key = key.replace(/^programmy\//i, '').replace(/\/+$/, '');
  key = key.replace(/\s+/g, ' ').trim();
  const aliasMap = aliases && typeof aliases === 'object' ? aliases : BEFIT_PROGRAM_ALIASES;
  const slugList = Array.isArray(slugs) && slugs.length ? slugs : BEFIT_PROGRAM_SLUGS;
  const slugSet = new Set(slugList.map((s) => String(s).toLowerCase()));
  if (aliasMap[key]) return aliasMap[key];
  const compact = key.replace(/\s+/g, '');
  if (aliasMap[compact]) return aliasMap[compact];
  if (slugSet.has(key)) return key;
  if (slugSet.has(compact)) return compact;
  // Bare verified slug with hyphens/underscores only.
  if (/^[a-z0-9_-]+$/i.test(key) && slugSet.has(key.toLowerCase())) {
    return key.toLowerCase();
  }
  return null;
}

function resolveBefitTargetUrl(label, cfg = {}) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  const slug = resolveBefitProgramSlug(
    raw,
    (cfg && cfg.programAliases) || BEFIT_PROGRAM_ALIASES,
    (cfg && cfg.programSlugs) || BEFIT_PROGRAM_SLUGS
  );
  if (slug) {
    const programPrefix = String(
      (cfg && cfg.programPrefix) || BEFIT_PROGRAM_PREFIX
    ).replace(/\/?$/, '/');
    return `${programPrefix}${slug}/`;
  }
  const prefix = String((cfg && cfg.searchPrefix) || BEFIT_SEARCH_PREFIX);
  return `${prefix}${encodeURIComponent(raw)}`;
}

function resolveBefitDeeplinkConfig(partners) {
  const row =
    findPartnerRow(partners, 'befit') || findPartnerRow(partners, 'letbefit');
  const geoFromPartner = Array.isArray(row && row.geo) ? row.geo : null;
  const cities =
    geoFromPartner && geoFromPartner.length
      ? geoFromPartner.map((c) => String(c || '').trim()).filter(Boolean)
      : BEFIT_GEO_CITIES.slice();
  const cfg = resolveAdmitadDeeplinkConfig({
    partners: row ? [row] : partners,
    partnerId: (row && row.id) || 'befit',
    envBaseKey: 'ADMITAD_BEFIT_BASE',
    envEridKey: 'ADMITAD_BEFIT_ERID',
    defaultBase: DEFAULT_ADMITAD_BEFIT_BASE,
    defaultErid: DEFAULT_ADMITAD_BEFIT_ERID,
    searchPrefix: BEFIT_SEARCH_PREFIX,
  });
  return {
    ...cfg,
    id: 'befit',
    name: String((row && row.name) || 'BeFit'),
    cities,
    tagPrefixes: ['befit', 'letbefit'],
    programPrefix: BEFIT_PROGRAM_PREFIX,
    programSlugs: BEFIT_PROGRAM_SLUGS.slice(),
    programAliases: { ...BEFIT_PROGRAM_ALIASES },
    promos: normalizeBefitPromos(row),
  };
}

/** Keep room for multi-paragraph ration replies; 1024 was cutting mid-thought. */
const MAX_OUTPUT_TOKENS = Math.min(
  Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192, 1024),
  8192
);
const MAX_CONTINUES = 2;
/** Retries per model on overload before switching to the next fallback. */
const OVERLOAD_RETRIES = Math.min(
  Math.max(Number(process.env.GEMINI_OVERLOAD_RETRIES) || 2, 0),
  5
);
const OVERLOAD_BACKOFF_MS = Math.min(
  Math.max(Number(process.env.GEMINI_OVERLOAD_BACKOFF_MS) || 800, 200),
  8000
);

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

function getGeminiKeySlot(id) {
  return GEMINI_KEY_SLOTS.find((s) => s.id === id) || null;
}

function orderedGeminiKeySlots() {
  if (!GEMINI_KEY_SLOTS.length) return [];
  const primary = getGeminiKeySlot(activeGeminiKeyId) || GEMINI_KEY_SLOTS[0];
  const rest = GEMINI_KEY_SLOTS.filter((s) => s.id !== primary.id);
  return [primary, ...rest];
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

/** Errors that justify one switch to the other API key. */
function isKeyFailoverError(status, code, message) {
  if (!status) return true;
  const blob = `${code || ''} ${message || ''}`;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate/i.test(blob)) return true;
  if (isOverloadError(status, code, message)) return true;
  if (status === 400 && /FAILED_PRECONDITION|location is not supported/i.test(blob)) return true;
  return false;
}

const ROOT = __dirname;
const SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, 'prompt.txt'), 'utf8');
const PARTNERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'partners.json'), 'utf8'));
const VKUSVILL_DEEPLINK = resolveVkusvillDeeplinkConfig(PARTNERS);
const VIPFISH_DEEPLINK = resolveVipfishDeeplinkConfig(PARTNERS);
const BEFIT_DEEPLINK = resolveBefitDeeplinkConfig(PARTNERS);

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
app.use(express.static(path.join(ROOT, 'public')));

const CHAT_RATE_WINDOW_MS = 15 * 60 * 1000;
const CHAT_RATE_MAX = 15;
const RL_CHANNEL = 'nutrikod:rl';

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
    hasKey: Boolean(GEMINI_API_KEY),
    donateUrl: DONATE_URL,
    communityVkUrl: COMMUNITY_VK_URL,
    brand: 'НутриКод',
    model: GEMINI_MODEL,
    modelChain: GEMINI_MODEL_CHAIN,
    modes: MODE_IDS.map((id) => ({ id, label: CHAT_MODES[id].label })),
    /** Public marking + webmaster deeplink base (semi-public); no private Admitad credentials. */
    vkusvillDeeplink: {
      enabled: VKUSVILL_DEEPLINK.enabled,
      admitadBase: VKUSVILL_DEEPLINK.admitadBase,
      erid: VKUSVILL_DEEPLINK.erid,
      searchPrefix: VKUSVILL_DEEPLINK.searchPrefix,
      promoCode: VKUSVILL_DEEPLINK.promoCode,
      disclaimer: VKUSVILL_DEEPLINK.disclaimer,
      legalName: VKUSVILL_DEEPLINK.legalName,
      inn: VKUSVILL_DEEPLINK.inn,
    },
    /** Важная рыба (vipfish.ru) — СПб зона; chips via [[vipfish:…]] / [[ryba:…]]. */
    vipfishDeeplink: {
      enabled: VIPFISH_DEEPLINK.enabled,
      admitadBase: VIPFISH_DEEPLINK.admitadBase,
      erid: VIPFISH_DEEPLINK.erid,
      searchPrefix: VIPFISH_DEEPLINK.searchPrefix,
      cities: VIPFISH_DEEPLINK.cities,
      tagPrefixes: VIPFISH_DEEPLINK.tagPrefixes,
      disclaimer: VIPFISH_DEEPLINK.disclaimer,
      legalName: VIPFISH_DEEPLINK.legalName,
      inn: VIPFISH_DEEPLINK.inn,
      name: VIPFISH_DEEPLINK.name,
    },
    /** BeFit (letbefit.ru) — MSK+SPb; chips via [[befit:…]] / [[letbefit:…]]. */
    befitDeeplink: {
      enabled: BEFIT_DEEPLINK.enabled,
      admitadBase: BEFIT_DEEPLINK.admitadBase,
      erid: BEFIT_DEEPLINK.erid,
      searchPrefix: BEFIT_DEEPLINK.searchPrefix,
      programPrefix: BEFIT_DEEPLINK.programPrefix,
      programSlugs: BEFIT_DEEPLINK.programSlugs,
      programAliases: BEFIT_DEEPLINK.programAliases,
      cities: BEFIT_DEEPLINK.cities,
      tagPrefixes: BEFIT_DEEPLINK.tagPrefixes,
      promoCode: BEFIT_DEEPLINK.promoCode,
      promos: BEFIT_DEEPLINK.promos,
      disclaimer: BEFIT_DEEPLINK.disclaimer,
      legalName: BEFIT_DEEPLINK.legalName,
      inn: BEFIT_DEEPLINK.inn,
      name: BEFIT_DEEPLINK.name,
    },
  });
});

/** Shared Admitad ulp builder: searchPrefix + name → &ulp=encodeURIComponent(target). */
function buildAdmitadUlpUrl(productName, cfg) {
  const name = String(productName || '').trim();
  const base = normalizeAdmitadBase(cfg && cfg.admitadBase);
  const prefix = String((cfg && cfg.searchPrefix) || '').trim();
  if (!name || !base || !prefix) return null;
  const target = `${prefix}${encodeURIComponent(name)}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ulp=${encodeURIComponent(target)}`;
}

/** Exported for scripts/verify-*-deeplink.js */
function buildVkusvillAdmitadUrl(productName, cfg = VKUSVILL_DEEPLINK) {
  return buildAdmitadUlpUrl(productName, {
    ...(cfg || {}),
    searchPrefix: (cfg && cfg.searchPrefix) || VKUSVILL_SEARCH_PREFIX,
  });
}

function buildVipfishAdmitadUrl(productName, cfg = VIPFISH_DEEPLINK) {
  return buildAdmitadUlpUrl(productName, {
    ...(cfg || {}),
    searchPrefix: (cfg && cfg.searchPrefix) || VIPFISH_SEARCH_PREFIX,
  });
}

/** BeFit: program slug → /programmy/{slug}/; else WP search ?s=. */
function buildBefitAdmitadUrl(label, cfg = BEFIT_DEEPLINK) {
  const target = resolveBefitTargetUrl(label, cfg || BEFIT_DEEPLINK);
  const base = normalizeAdmitadBase(cfg && cfg.admitadBase);
  if (!target || !base) return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ulp=${encodeURIComponent(target)}`;
}

/**
 * Intent only: готовое / заказать / нет времени готовить.
 * Avoid \\b — JS word boundaries ignore Cyrillic and break matches.
 */
const INTENT_RE =
  /готов(?:ое|ый|ую|ые|ого)|заказ(?:ать|аю|аем|ите)|заказы|нет времени(?:\s+готовить)?|некогда(?:\s+готовить)?/i;

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

/**
 * Pick 0–1 live partner on intent. Never on first user turn.
 * Demo rows (live:false / example.com) are skipped — no invented links.
 */
function pickPartner(messages, { allowPartner = false } = {}) {
  if (!allowPartner) return null;
  // Never first reply: need at least two user messages in the thread.
  if (countUserTurns(messages) < 2) return null;

  const live = PARTNERS.filter(isLivePartner);
  if (!live.length) return null;

  const text = conversationText(messages);
  if (!INTENT_RE.test(text)) return null;

  let best = null;
  let bestScore = 0;
  for (const p of live) {
    let score = 0;
    for (const tag of p.tags || []) {
      if (text.includes(String(tag).toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // Intent matched and at least one live partner exists — prefer tag fit, else first live.
  return bestScore > 0 ? best : live[0];
}

function partnerPayload(partner) {
  if (!partner) return null;
  return {
    id: partner.id,
    name: partner.name,
    blurb: partner.blurb,
    link: partner.link,
    disclaimer: partner.disclaimer,
    offer_type: partner.offer_type || null,
    promo_code: partner.promo_code || null,
  };
}

function donateUrlForPrompt() {
  const url = String(DONATE_URL || '').trim();
  if (!url || url === '#donate' || url.startsWith('#')) return null;
  return url;
}

/** System prompt + optional mode overlay + donate context. Partner offers stay UI-only. */
function buildSystemInstruction(mode = null) {
  let extra = modeOverlayBlock(mode);
  const donateUrl = donateUrlForPrompt();
  if (donateUrl) {
    extra += `

Контекст доната (не рекламируй; только по правилам 10–13 из промпта):
DONATE_URL: ${donateUrl}`;
  } else {
    extra += `

Контекст доната (не рекламируй; только по правилам 10–13 из промпта):
DONATE_URL нет — если уместно предложить поддержку, скажи «кнопка поддержки ниже».`;
  }
  return SYSTEM_PROMPT + extra;
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
 * Open Gemini SSE for one API key. On 503/UNAVAILABLE: backoff, then next model in chain.
 * @returns {Promise<{ upstream: Response, model: string, keyId: number } | { errorText: string, status: number, model: string, keyId: number, failoverWorthy: boolean }>}
 */
async function openGeminiStreamWithKey(body, models, keySlot) {
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
      console.info(
        `[gemini] request key=${keyId} model=${model} attempt=${attempt + 1}/${attempts} chain=${modelIndex + 1}/${chain.length}`
      );

      let upstream;
      try {
        upstream = await fetch(geminiStreamUrl(model, apiKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.error(
          `[gemini] fetch failed key=${keyId} model=${model}`,
          redactSecrets(err?.message || String(err))
        );
        lastFailure = {
          errorText: 'Связь прервалась. Проверьте сеть и напишите снова.',
          status: 0,
          model,
          keyId,
          failoverWorthy: true,
        };
        if (attempt < attempts - 1) {
          await sleep(OVERLOAD_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        break;
      }

      if (upstream.ok) {
        if (model !== GEMINI_MODEL) {
          console.info(
            `[gemini] fallback ok key=${keyId} model=${model} (primary was ${GEMINI_MODEL})`
          );
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
        break;
      }

      if (failoverWorthy) {
        console.warn(
          `[gemini] key=${keyId} failover-worthy status=${upstream.status} code=${code || 'n/a'}`
        );
        return lastFailure;
      }

      return lastFailure;
    }
  }

  return lastFailure;
}

/**
 * Open a Gemini SSE stream with dual-key failover (one switch on 429/503/network/geo).
 * @param {object} body request JSON
 * @param {string[]} [models] override chain (e.g. stick to one model on MAX_TOKENS continue)
 */
async function openGeminiStream(body, models = GEMINI_MODEL_CHAIN) {
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
    const result = await openGeminiStreamWithKey(body, models, slot);
    if (result?.upstream) {
      if (activeGeminiKeyId !== slot.id) {
        console.info(
          `[gemini] primary key switched ${activeGeminiKeyId || 'n/a'} → ${slot.id}`
        );
        activeGeminiKeyId = slot.id;
      }
      return result;
    }
    lastFailure = result;
    const canFailover = i === 0 && slots.length > 1 && result?.failoverWorthy === true;
    if (canFailover) {
      console.warn(
        `[gemini] key ${slot.id} failed (status=${result.status || 0}) — one failover to key ${slots[1].id}`
      );
      continue;
    }
    break;
  }

  return (
    lastFailure || {
      errorText: OVERLOAD_USER_MESSAGE,
      status: 503,
      model: GEMINI_MODEL,
      keyId: activeGeminiKeyId,
      failoverWorthy: false,
    }
  );
}

const MOCK_REPLY =
  'Спасибо, что рассказали. Для старта держитесь простого каркаса: овощи или зелень в каждом приёме пищи, белок (рыба, яйца, бобовые, птица — что вам подходит), полезные жиры (орехи, авокадо, растительное масло) и привычные углеводы без жёстких запретов.\n\n' +
  'Пример дня: завтрак — овсянка на воде или молоке с ягодами и горстью орехов; обед — гречка или киноа, запечённая рыба или тофу, большой салат; ужин — овощной суп или омлет с зеленью и цельнозерновой хлеб; перекус — йогурт без сахара, фрукты или хумус с морковью.\n\n' +
  'Если есть аллергии или ограничения — напишите их, и я подстрою пример дня под вас. Это общий ориентир по рациону, не медицинская рекомендация. Готово.';

function writeEvent(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
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
      const err = new Error('gemini_upstream_error');
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  if (buffer.trim()) drain(true);

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
  const mode = resolveChatMode(req.body?.mode, messages);
  const partner = pickPartner(messages, { allowPartner });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable Nagle so each token write can leave the socket promptly.
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders?.();

  // Tell the client which mode actually applied (explicit or quiet auto-detect).
  writeEvent(res, { type: 'mode', mode: { id: mode.id, label: mode.label, source: mode.source } });

  if (!GEMINI_API_KEY) {
    writeEvent(res, {
      type: 'notice',
      text: 'Ключ GEMINI_API_KEY не задан — показываю демо-ответ, чтобы можно было оценить интерфейс.',
    });
    await streamMock(res, partner);
    return;
  }

  writeEvent(res, { type: 'status', stage: 'thinking' });

  const systemInstruction = { parts: [{ text: buildSystemInstruction(mode) }] };
  let contents = toGeminiContents(messages);
  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  try {
    console.info(
      `[gemini] chat turns=${messages.length} mode=${mode.id}/${mode.source} partner=${partner ? partner.id : 'none'} maxOutputTokens=${MAX_OUTPUT_TOKENS} chain=${GEMINI_MODEL_CHAIN.join(
        '→'
      )}`
    );

    let tokenCount = 0;
    let finishReason = '';
    let assembled = '';
    let continues = 0;
    let signaledTyping = false;
    let activeModel = GEMINI_MODEL;

    for (let attempt = 0; attempt <= MAX_CONTINUES; attempt++) {
      const requestBody = {
        system_instruction: systemInstruction,
        contents,
        generationConfig,
      };

      // First segment: full retry + fallback chain. Continues stick to the model that worked.
      const opened = await openGeminiStream(
        requestBody,
        attempt === 0 ? GEMINI_MODEL_CHAIN : [activeModel]
      );

      if (!opened?.upstream) {
        writeEvent(res, {
          type: 'error',
          text: opened?.errorText || OVERLOAD_USER_MESSAGE,
        });
        writeEvent(res, { type: 'done', finishReason: finishReason || 'ERROR' });
        res.end();
        return;
      }

      activeModel = opened.model;

      if (!signaledTyping) {
        writeEvent(res, { type: 'status', stage: 'typing' });
        signaledTyping = true;
      }

      let segment;
      try {
        segment = await readGeminiSse(opened.upstream.body, (text) => {
          writeEvent(res, { type: 'token', text });
        });
      } catch (err) {
        if (err?.geminiError) {
          const calm = summarizeGeminiError(
            err.geminiError.code || 500,
            JSON.stringify({ error: err.geminiError }),
            activeModel
          );
          writeEvent(res, { type: 'error', text: calm });
          writeEvent(res, { type: 'done', finishReason: 'ERROR' });
          res.end();
          return;
        }
        throw err;
      }

      tokenCount += segment.tokenCount;
      finishReason = segment.finishReason || finishReason;
      assembled += segment.text;

      if (segment.finishReason !== 'MAX_TOKENS' || !segment.text || attempt === MAX_CONTINUES) {
        break;
      }

      continues += 1;
      console.info(
        `[gemini] MAX_TOKENS — continue ${continues}/${MAX_CONTINUES} model=${activeModel} soFarChars=${assembled.length}`
      );
      contents = [
        ...contents,
        { role: 'model', parts: [{ text: assembled.slice(-12000) }] },
        {
          role: 'user',
          parts: [
            {
              text: 'Продолжи ответ точно с того места, где оборвался. Не повторяй уже сказанное, без нового вступления.',
            },
          ],
        },
      ];
    }

    if (partner) {
      writeEvent(res, { type: 'partner', partner: partnerPayload(partner) });
    }

    console.info(
      `[gemini] done model=${activeModel} chunks=${tokenCount} finishReason=${finishReason || 'n/a'} continues=${continues} chars=${assembled.length}`
    );
    writeEvent(res, {
      type: 'done',
      finishReason: finishReason || 'STOP',
      truncated: finishReason === 'MAX_TOKENS',
      model: activeModel,
    });
    res.end();
  } catch (err) {
    console.error('[gemini] stream failed', redactSecrets(err?.message || String(err)));
    writeEvent(res, {
      type: 'error',
      text: 'Связь прервалась. Проверьте сеть и напишите снова.',
    });
    writeEvent(res, { type: 'done' });
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
          GEMINI_KEY_SLOTS.length
        }, active: ${activeGeminiKeyId || 'n/a'}, origin: ${GEMINI_API_ORIGIN}, model: ${GEMINI_MODEL}, chain: ${GEMINI_MODEL_CHAIN.join('→')})`
      );
    });
  }
}

module.exports = {
  app,
  parseModelChain,
  isOverloadError,
  isKeyFailoverError,
  summarizeGeminiError,
  openGeminiStream,
  openGeminiStreamWithKey,
  GEMINI_API_ORIGIN,
  GEMINI_KEY_SLOTS,
  pickPartner,
  isLivePartner,
  partnerPayload,
  INTENT_RE,
  OVERLOAD_USER_MESSAGE,
  GEMINI_MODEL,
  GEMINI_MODEL_CHAIN,
  DEFAULT_FALLBACK_MODELS,
  CHAT_MODES,
  MODE_IDS,
  normalizeModeId,
  resolveChatMode,
  modeOverlayBlock,
  buildSystemInstruction,
  buildAdmitadUlpUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
  buildBefitAdmitadUrl,
  resolveBefitTargetUrl,
  resolveBefitProgramSlug,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveVkusvillDeeplinkConfig,
  resolveVipfishDeeplinkConfig,
  resolveBefitDeeplinkConfig,
  VKUSVILL_SEARCH_PREFIX,
  VKUSVILL_DEEPLINK,
  VIPFISH_SEARCH_PREFIX,
  VIPFISH_DEEPLINK,
  VIPFISH_GEO_CITIES,
  BEFIT_SEARCH_PREFIX,
  BEFIT_PROGRAM_PREFIX,
  BEFIT_DEEPLINK,
  BEFIT_GEO_CITIES,
  BEFIT_PROGRAM_SLUGS,
  BEFIT_PROGRAM_ALIASES,
};
