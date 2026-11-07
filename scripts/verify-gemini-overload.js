'use strict';

/**
 * Offline checks for 503/UNAVAILABLE retry + model fallback chain.
 * Run: node scripts/verify-gemini-overload.js
 */

const assert = require('assert');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.GEMINI_OVERLOAD_RETRIES = '1';
process.env.GEMINI_OVERLOAD_BACKOFF_MS = '20';
delete process.env.GEMINI_MODEL_CHAIN;
delete process.env.GEMINI_FALLBACK_MODELS;
process.env.GEMINI_MODEL = 'gemini-3.8-flash';

const {
  parseModelChain,
  isOverloadError,
  summarizeGeminiError,
  openGeminiStream,
  OVERLOAD_USER_MESSAGE,
  DEFAULT_FALLBACK_MODELS,
} = require('../server');

assert.deepStrictEqual(parseModelChain(), [
  'gemini-3.8-flash',
  ...DEFAULT_FALLBACK_MODELS,
]);

process.env.GEMINI_MODEL_CHAIN = 'a-flash,b-flash,c-lite';
assert.deepStrictEqual(parseModelChain(), ['a-flash', 'b-flash', 'c-lite']);
delete process.env.GEMINI_MODEL_CHAIN;

process.env.GEMINI_FALLBACK_MODELS = 'only-fallback';
assert.deepStrictEqual(parseModelChain(), ['gemini-3.8-flash', 'only-fallback']);
delete process.env.GEMINI_FALLBACK_MODELS;

assert.strictEqual(isOverloadError(503, 'UNAVAILABLE', 'high demand'), true);
assert.strictEqual(isOverloadError(500, 'INTERNAL', 'boom'), false);
assert.strictEqual(isOverloadError(429, 'RESOURCE_EXHAUSTED', 'quota'), false);

const overloadMsg = summarizeGeminiError(
  503,
  JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } }),
  'gemini-3.8-flash'
);
assert.strictEqual(overloadMsg, OVERLOAD_USER_MESSAGE);
assert.match(overloadMsg, /нагрузк|временн|минут/i);

async function withMockFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

function jsonResponse(status, body, okOverride) {
  const ok = okOverride ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    body: ok
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
              )
            );
            controller.close();
          },
        })
      : null,
  };
}

(async () => {
  const calls = [];
  const opened = await withMockFetch(async (url) => {
    calls.push(String(url));
    if (calls.length < 3) {
      return jsonResponse(503, {
        error: { status: 'UNAVAILABLE', message: 'high demand' },
      });
    }
    return jsonResponse(200, {});
  }, () =>
    openGeminiStream(
      { contents: [], generationConfig: {} },
      ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']
    )
  );

  assert.ok(opened.upstream, 'expected successful upstream after retries/fallback');
  assert.strictEqual(opened.model, 'gemini-3.6-flash');
  assert.strictEqual(calls.length, 3, `expected 2 fails on primary + 1 ok on fallback, got ${calls.length}`);
  assert.match(calls[0], /gemini-3\.8-flash/);
  assert.match(calls[1], /gemini-3\.8-flash/);
  assert.match(calls[2], /gemini-3\.6-flash/);

  const failed = await withMockFetch(async () => {
    return jsonResponse(503, { error: { status: 'UNAVAILABLE', message: 'high demand' } });
  }, () => openGeminiStream({ contents: [] }, ['only-model']));

  assert.ok(!failed.upstream);
  assert.strictEqual(failed.errorText, OVERLOAD_USER_MESSAGE);

  const authFail = await withMockFetch(async () => {
    return jsonResponse(403, { error: { status: 'PERMISSION_DENIED', message: 'API key not valid' } });
  }, () => openGeminiStream({ contents: [] }, ['primary', 'fallback']));

  assert.ok(!authFail.upstream);
  assert.notStrictEqual(authFail.errorText, OVERLOAD_USER_MESSAGE);

  console.log('verify-gemini-overload: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
