'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
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
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
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

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    hasKey: Boolean(GEMINI_API_KEY),
    donateUrl: DONATE_URL,
    brand: 'НутриКод',
    model: GEMINI_MODEL,
    modelChain: GEMINI_MODEL_CHAIN,
  });
});

const INTENT_RE =
  /готов(ое|ый|ую)|заказ|доставк|нет времени|некогда|пп[- ]?рацион|купить|партн[её]р|магний|детск|малыш|школ|перекус|устал|стресс/i;

function pickPartner(messages) {
  const text = messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
    .toLowerCase();

  if (!INTENT_RE.test(text)) return null;

  let best = null;
  let bestScore = 0;
  for (const p of PARTNERS) {
    let score = 0;
    for (const tag of p.tags || []) {
      if (text.includes(String(tag).toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore > 0 ? best : null;
}

function donateUrlForPrompt() {
  const url = String(DONATE_URL || '').trim();
  if (!url || url === '#donate' || url.startsWith('#')) return null;
  return url;
}

function buildSystemInstruction(partner) {
  let extra = '';
  if (partner) {
    extra += `

Контекст партнёра (упомяни мягко один раз, если уместно по теме пользователя; не навязывай):
Название: ${partner.name}
Суть: ${partner.blurb}
Ссылка: ${partner.link}
Оговорка: ${partner.disclaimer}`;
  }
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
    writeEvent(res, {
      type: 'partner',
      partner: {
        id: partner.id,
        name: partner.name,
        blurb: partner.blurb,
        link: partner.link,
        disclaimer: partner.disclaimer,
      },
    });
  }
  writeEvent(res, { type: 'done', mock: true, finishReason: 'STOP' });
  res.end();
}

app.post('/api/chat', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const allowPartner = Boolean(req.body?.allowPartner);
  const partner = allowPartner ? pickPartner(messages) : null;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable Nagle so each token write can leave the socket promptly.
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders?.();

  if (!GEMINI_API_KEY) {
    writeEvent(res, {
      type: 'notice',
      text: 'Ключ GEMINI_API_KEY не задан — показываю демо-ответ, чтобы можно было оценить интерфейс.',
    });
    await streamMock(res, partner);
    return;
  }

  writeEvent(res, { type: 'status', stage: 'thinking' });

  const systemInstruction = { parts: [{ text: buildSystemInstruction(partner) }] };
  let contents = toGeminiContents(messages);
  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  try {
    console.info(
      `[gemini] chat turns=${messages.length} partner=${partner ? partner.id : 'none'} maxOutputTokens=${MAX_OUTPUT_TOKENS} chain=${GEMINI_MODEL_CHAIN.join(
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
      writeEvent(res, {
        type: 'partner',
        partner: {
          id: partner.id,
          name: partner.name,
          blurb: partner.blurb,
          link: partner.link,
          disclaimer: partner.disclaimer,
        },
      });
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `НутриКод на http://127.0.0.1:${PORT} (key: ${GEMINI_API_KEY ? 'yes' : 'mock'}, model: ${GEMINI_MODEL}, chain: ${GEMINI_MODEL_CHAIN.join(
        '→'
      )})`
    );
  });
}

module.exports = {
  app,
  parseModelChain,
  isOverloadError,
  summarizeGeminiError,
  openGeminiStream,
  OVERLOAD_USER_MESSAGE,
  GEMINI_MODEL,
  GEMINI_MODEL_CHAIN,
  DEFAULT_FALLBACK_MODELS,
};
