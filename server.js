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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_ORIGIN = (process.env.GEMINI_API_ORIGIN || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
/** Prefer lean/fast models first under free-tier load; gemini-3.8-flash is opt-in via env. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
/** Default chain after the primary model when Gemini returns 503 / UNAVAILABLE. */
const DEFAULT_FALLBACK_MODELS = ['gemini-3.6-flash'];
const DONATE_URL = process.env.DONATE_URL || '#donate';
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

function geminiStreamUrl(model) {
  return `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(GEMINI_API_KEY)}`;
}

/** True for high-demand / capacity errors that may clear after backoff or a lighter model. */
function isOverloadError(status, code, message) {
  const blob = `${code || ''} ${message || ''}`;
  if (status === 503) return true;
  if (/UNAVAILABLE|high demand|overloaded|try again later/i.test(blob)) return true;
  return false;
}

const ROOT = __dirname;
const SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, 'prompt.txt'), 'utf8');
const PARTNERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'partners.json'), 'utf8'));

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
    brand: 'НутриКод',
    model: GEMINI_MODEL,
    modelChain: GEMINI_MODEL_CHAIN,
    modes: MODE_IDS.map((id) => ({ id, label: CHAT_MODES[id].label })),
  });
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

/** Skip partners whose geo_deny substrings appear in the conversation. */
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

function isWideCoveragePartner(partner) {
  if (!partner) return false;
  if (partner.coverage === 'wide') return true;
  return WIDE_DEFAULT_IDS.includes(partner.id);
}

/**
 * Soft default among live partners: wide delivery first, never force a geo-limited chain.
 */
function pickWideDefault(live) {
  for (const id of WIDE_DEFAULT_IDS) {
    const hit = live.find((p) => p.id === id);
    if (hit) return hit;
  }
  const wide = live.find((p) => isWideCoveragePartner(p));
  if (wide) return wide;
  // Last resort: partner without geo_deny, else first remaining.
  return live.find((p) => !Array.isArray(p.geo_deny) || !p.geo_deny.length) || live[0] || null;
}

/**
 * Pick 0–1 live partner. Never on first user turn.
 * Only when intent is clear (order/delivery/no-time/brand/water…) OR a brand tag hits.
 * Vague «покушать» → null (model clarifies). Demo rows skipped.
 * Path: UI card owns URL/promo; model gets soft context only (see partnerContextBlock).
 */
function pickPartner(messages, { allowPartner = false } = {}) {
  if (!allowPartner) return null;
  // Never first reply: need at least two user messages in the thread.
  if (countUserTurns(messages) < 2) return null;

  const text = conversationText(messages);
  const live = PARTNERS.filter(isLivePartner).filter((p) => !partnerDeniedByGeo(p, text));
  if (!live.length) return null;

  let best = null;
  let bestBrand = 0;
  let bestTotal = 0;
  for (const p of live) {
    const score = partnerTagScore(p, text);
    if (score.brand > bestBrand || (score.brand === bestBrand && score.total > bestTotal)) {
      bestBrand = score.brand;
      bestTotal = score.total;
      best = p;
    }
  }

  // Brand/specific tag hit (e.g. «пицца додо», «яндекс лавка», «вода»).
  if (bestBrand > 0) return best;

  // Clear fulfillment intent without brand → wide delivery default (not Перекрёсток).
  if (CLEAR_INTENT_RE.test(text)) return pickWideDefault(live);

  // Vague / unclear hunger or small talk → no offer; prompt asks clarify + city if needed.
  return null;
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

/**
 * Compact 0–1 live offer for the model.
 * Dedup path (documented): UI SSE partner card owns URL + promo;
 * model gets name/blurb only and must NOT print raw link/code.
 */
function partnerContextBlock(partner) {
  if (!partner) return '';
  const payload = partnerPayload(partner);
  const lines = [
    'Контекст партнёрского оффера (ровно 0–1; ссылка и промокод уйдут в UI-карточку под ответом — не дублируй их в тексте):',
    `id: ${payload.id}`,
    `name: ${payload.name}`,
    `blurb: ${payload.blurb || ''}`,
    `offer_type: ${payload.offer_type || 'affiliate'}`,
    'Можно один раз мягко упомянуть бренд/выгоду и сказать, что удобный вариант — в карточке ниже. Не печатай сырой URL и не печатай промокод. Не ври, что офферов нет.',
  ];
  return `\n\n${lines.join('\n')}`;
}

/**
 * Owner strategy catalog: live ids/names only — never URLs/promo here.
 * User-facing offer is the UI card (0–1), not raw links in model text.
 */
function ownerPartnersCatalogBlock(messages) {
  if (!hasOwnerCodeword(messages)) return '';
  const live = PARTNERS.filter(isLivePartner);
  if (!live.length) return '';
  const lines = live.map((p) => {
    const promo = p.promo_code ? 'promo:да' : 'promo:нет';
    const cover = isWideCoveragePartner(p) ? 'wide' : 'geo';
    return `- ${p.id} — ${p.name} (${promo}, ${cover})`;
  });
  return (
    '\n\nКаталог live-партнёров для владельца (только id/name, без URL и без промокодов):\n' +
    lines.join('\n') +
    '\nПул живой; пользователю уходит максимум одна UI-карточка (SSE partner) + мягкий намёк из блока «Контекст партнёрского оффера» без сырого URL. ' +
    'Владельцу для стратегии можно кратко перечислить эти id/названия без ссылок.'
  );
}

function donateUrlForPrompt() {
  const url = String(DONATE_URL || '').trim();
  if (!url || url === '#donate' || url.startsWith('#')) return null;
  return url;
}

/** System prompt + mode overlay + donate + optional 0–1 offer + owner catalog. */
function buildSystemInstruction(mode = null, partner = null, messages = null) {
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
  extra += partnerContextBlock(partner);
  extra += ownerPartnersCatalogBlock(messages);
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
 * Open a Gemini SSE stream. On 503/UNAVAILABLE: backoff retries, then next model in chain.
 * @param {object} body request JSON
 * @param {string[]} [models] override chain (e.g. stick to one model on MAX_TOKENS continue)
 * @returns {Promise<{ upstream: Response, model: string } | { errorText: string, status: number, model: string }>}
 */
async function openGeminiStream(body, models = GEMINI_MODEL_CHAIN) {
  const chain = models.length ? models : GEMINI_MODEL_CHAIN;
  let lastFailure = { errorText: OVERLOAD_USER_MESSAGE, status: 503, model: chain[0] };

  for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
    const model = chain[modelIndex];
    const attempts = OVERLOAD_RETRIES + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      console.info(
        `[gemini] request model=${model} attempt=${attempt + 1}/${attempts} chain=${modelIndex + 1}/${chain.length}`
      );

      let upstream;
      try {
        upstream = await fetch(geminiStreamUrl(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.error(`[gemini] fetch failed model=${model}`, redactSecrets(err?.message || String(err)));
        lastFailure = {
          errorText: 'Связь прервалась. Проверьте сеть и напишите снова.',
          status: 0,
          model,
        };
        if (attempt < attempts - 1) {
          await sleep(OVERLOAD_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        break;
      }

      if (upstream.ok) {
        if (model !== GEMINI_MODEL) {
          console.info(`[gemini] fallback ok model=${model} (primary was ${GEMINI_MODEL})`);
        }
        return { upstream, model };
      }

      const errText = await upstream.text().catch(() => '');
      const { code, message } = parseGeminiErrorBody(errText);
      lastFailure = {
        errorText: summarizeGeminiError(upstream.status, errText, model),
        status: upstream.status,
        model,
      };

      if (isOverloadError(upstream.status, code, message)) {
        const canRetry = attempt < attempts - 1;
        const canFallback = modelIndex < chain.length - 1;
        console.warn(
          `[gemini] overload model=${model} status=${upstream.status} code=${code || 'n/a'} retry=${canRetry} fallback=${canFallback}`
        );
        if (canRetry) {
          await sleep(OVERLOAD_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        // Exhausted retries on this model — try next in chain.
        break;
      }

      // Non-overload failure: stop immediately (no fallback for auth/404/etc.).
      return lastFailure;
    }
  }

  return lastFailure;
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

  const systemInstruction = {
    parts: [{ text: buildSystemInstruction(mode, partner, messages) }],
  };
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
        `НутриКод worker pid=${process.pid} on http://127.0.0.1:${PORT} (key: ${
          GEMINI_API_KEY ? 'yes' : 'mock'
        }, model: ${GEMINI_MODEL}, chain: ${GEMINI_MODEL_CHAIN.join('→')})`
      );
    });
  }
}

module.exports = {
  app,
  parseModelChain,
  isOverloadError,
  summarizeGeminiError,
  openGeminiStream,
  pickPartner,
  isLivePartner,
  partnerPayload,
  partnerTagScore,
  partnerDeniedByGeo,
  isWideCoveragePartner,
  pickWideDefault,
  hasOwnerCodeword,
  ownerPartnersCatalogBlock,
  CLEAR_INTENT_RE,
  INTENT_RE,
  WIDE_DEFAULT_IDS,
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
};
