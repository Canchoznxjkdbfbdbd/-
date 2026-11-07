'use strict';

/**
 * Offline checks: leftover SSE flush + multi-paragraph mock completeness.
 * Run: node scripts/verify-stream-complete.js [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3010';

function parseGeminiSsePayload(payload) {
  if (!payload || payload === '[DONE]') return { text: '', finishReason: '' };
  const json = JSON.parse(payload);
  if (json?.error) return { text: '', finishReason: '', error: json.error };
  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason || '';
  const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
  return { text, finishReason, error: null };
}

/** Mirrors server readGeminiSse drain — last event has NO trailing newline. */
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
    if (parsed.finishReason) finishReason = parsed.finishReason;
    if (parsed.text) {
      tokenCount += 1;
      assembled += parsed.text;
      onText(parsed.text);
    }
  };

  const drain = (flushAll) => {
    const parts = buffer.split(/\r?\n/);
    if (!flushAll) buffer = parts.pop() || '';
    else buffer = '';
    for (const line of parts) handleDataLine(line.trim());
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

function makeStream(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

async function testLeftoverFlush() {
  // Deliberately omit final \n\n so the last token sits in the leftover buffer.
  const chunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Первый абзац.\\n\\n"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"Второй абзац.\\n\\n"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"Третий — финал. Готово."}]},"finishReason":"STOP"}]}',
  ];
  const withoutFlushBug = await readGeminiSse(makeStream(chunks), () => {});
  if (!withoutFlushBug.text.includes('Готово.') || withoutFlushBug.tokenCount !== 3) {
    throw new Error(`leftover flush failed: ${JSON.stringify(withoutFlushBug)}`);
  }
  console.log('ok leftover_flush', withoutFlushBug);
}

/** Client-style drain used in public/script.js */
function clientDrain(buffer, flushAll, onPayload) {
  let sep;
  while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
    const raw = buffer.slice(0, sep);
    buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
    const line = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!line) continue;
    onPayload(JSON.parse(line.slice(5).trim()));
  }
  if (flushAll && buffer.trim()) {
    const line = buffer
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (line) onPayload(JSON.parse(line.slice(5).trim()));
    buffer = '';
  }
  return buffer;
}

function testClientLeftover() {
  let full = '';
  let buf =
    'data: {"type":"token","text":"Абзац один.\\n\\n"}\n\n' +
    'data: {"type":"token","text":"Абзац два — конец."}';
  buf = clientDrain(buf, false, (p) => {
    if (p.type === 'token') full += p.text;
  });
  buf = clientDrain(buf, true, (p) => {
    if (p.type === 'token') full += p.text;
  });
  if (!full.includes('конец') || buf !== '') throw new Error(`client leftover failed: ${full}`);
  console.log('ok client_leftover', JSON.stringify(full));
}

async function testHttpMock() {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      messages: [
        { role: 'assistant', content: 'Привет' },
        {
          role: 'user',
          content:
            'Ем как попало, хочу больше энергии. Распиши подробный пример дня из нескольких абзацев.',
        },
      ],
      allowPartner: false,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`http status ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let doneMeta = null;
  const stages = [];
  let firstTokenAt = -1;
  let eventIndex = 0;

  const handle = (payload) => {
    eventIndex += 1;
    if (payload.type === 'status' && payload.stage) stages.push(payload.stage);
    if (payload.type === 'token') {
      if (firstTokenAt < 0) firstTokenAt = eventIndex;
      full += payload.text || '';
    }
    if (payload.type === 'done') doneMeta = payload;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = clientDrain(buffer, false, handle);
  }
  buffer += decoder.decode();
  buffer = clientDrain(buffer, true, handle);

  if (!stages.includes('thinking') || !stages.includes('typing')) {
    throw new Error(`expected thinking+typing status stages, got ${JSON.stringify(stages)}`);
  }
  const thinkingIdx = stages.indexOf('thinking');
  const typingIdx = stages.indexOf('typing');
  if (!(thinkingIdx < typingIdx)) {
    throw new Error(`stages out of order: ${JSON.stringify(stages)}`);
  }
  if (firstTokenAt < 0) throw new Error('no tokens received');

  const paragraphs = full.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length < 3) throw new Error(`expected 3+ paragraphs, got ${paragraphs.length}: ${full.slice(0, 200)}`);
  if (!full.includes('Готово')) throw new Error('missing completion marker Готово');
  if (!full.includes('Пример дня')) throw new Error('missing mid section');
  console.log('ok http_mock', {
    chars: full.length,
    paragraphs: paragraphs.length,
    endsWith: full.trim().slice(-20),
    stages,
    doneMeta,
  });
}

(async () => {
  await testLeftoverFlush();
  testClientLeftover();
  await testHttpMock();
  console.log('ALL_PASSED');
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
