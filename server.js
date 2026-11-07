'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const DONATE_URL = process.env.DONATE_URL || '#donate';

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

function buildSystemInstruction(partner) {
  let extra = '';
  if (partner) {
    extra = `

Контекст партнёра (упомяни мягко один раз, если уместно по теме пользователя; не навязывай):
Название: ${partner.name}
Суть: ${partner.blurb}
Ссылка: ${partner.link}
Оговорка: ${partner.disclaimer}`;
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

function summarizeGeminiError(status, rawBody) {
  let code = '';
  let message = '';
  try {
    const parsed = JSON.parse(rawBody);
    code = parsed?.error?.status || parsed?.error?.code || '';
    message = parsed?.error?.message || '';
  } catch {
    message = rawBody;
  }

  const safeMessage = redactSecrets(message).replace(/\s+/g, ' ').trim();
  console.error(
    `[gemini] upstream status=${status} model=${GEMINI_MODEL} code=${code || 'n/a'} msg=${safeMessage || '(empty)'}`
  );

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

const MOCK_REPLY =
  'Спасибо, что рассказали. Для старта держитесь простого каркаса: овощи или зелень в каждом приёме пищи, белок (рыба, яйца, бобовые, птица — что вам подходит), полезные жиры (орехи, авокадо, растительное масло) и привычные углеводы без жёстких запретов.\n\n' +
  'Если есть аллергии или ограничения — напишите их, и я подстрою пример дня под вас. Это общий ориентир по рациону, не медицинская рекомендация.';

async function streamMock(res, partner) {
  const chunks = MOCK_REPLY.match(/.{1,24}|[\s\S]/g) || [MOCK_REPLY];
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ type: 'token', text: chunk })}\n\n`);
    await new Promise((r) => setTimeout(r, 18));
  }
  if (partner) {
    res.write(
      `data: ${JSON.stringify({
        type: 'partner',
        partner: {
          id: partner.id,
          name: partner.name,
          blurb: partner.blurb,
          link: partner.link,
          disclaimer: partner.disclaimer,
        },
      })}\n\n`
    );
  }
  res.write(`data: ${JSON.stringify({ type: 'done', mock: true })}\n\n`);
  res.end();
}

app.post('/api/chat', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const allowPartner = Boolean(req.body?.allowPartner);
  const partner = allowPartner ? pickPartner(messages) : null;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!GEMINI_API_KEY) {
    res.write(
      `data: ${JSON.stringify({
        type: 'notice',
        text: 'Ключ GEMINI_API_KEY не задан — показываю демо-ответ, чтобы можно было оценить интерфейс.',
      })}\n\n`
    );
    await streamMock(res, partner);
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    system_instruction: { parts: [{ text: buildSystemInstruction(partner) }] },
    contents: toGeminiContents(messages),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  };

  try {
    console.info(`[gemini] request model=${GEMINI_MODEL} turns=${messages.length} partner=${partner ? partner.id : 'none'}`);
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      const calm = summarizeGeminiError(upstream.status, errText);
      res.write(`data: ${JSON.stringify({ type: 'error', text: calm })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let tokenCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          if (json?.error) {
            const calm = summarizeGeminiError(json.error.code || 500, JSON.stringify(json));
            res.write(`data: ${JSON.stringify({ type: 'error', text: calm })}\n\n`);
            continue;
          }
          const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
          if (text) {
            tokenCount += 1;
            res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`);
          }
        } catch {
          /* skip partial JSON */
        }
      }
    }

    if (partner) {
      res.write(
        `data: ${JSON.stringify({
          type: 'partner',
          partner: {
            id: partner.id,
            name: partner.name,
            blurb: partner.blurb,
            link: partner.link,
            disclaimer: partner.disclaimer,
          },
        })}\n\n`
      );
    }

    console.info(`[gemini] done model=${GEMINI_MODEL} chunks=${tokenCount}`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[gemini] stream failed', redactSecrets(err?.message || String(err)));
    res.write(
      `data: ${JSON.stringify({
        type: 'error',
        text: 'Связь прервалась. Проверьте сеть и напишите снова.',
      })}\n\n`
    );
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `НутриКод на http://127.0.0.1:${PORT} (key: ${GEMINI_API_KEY ? 'yes' : 'mock'}, model: ${GEMINI_MODEL})`
  );
});
