'use strict';

/**
 * Offline checks: extensible Gemini key pool + round-robin + 429 cooldown.
 * Run: node scripts/verify-gemini-keys.js
 */

const assert = require('assert');

process.env.GEMINI_API_KEY = 'k1';
process.env.GEMINI_API_KEY_2 = 'k2';
process.env.GEMINI_API_KEY_3 = 'k3';
delete process.env.GEMINI_API_KEY_4;
delete process.env.GEMINI_API_KEY_5;
delete process.env.GEMINI_API_KEYS;
process.env.GEMINI_KEY_COOLDOWN_MS = '5000';
process.env.GEMINI_OVERLOAD_RETRIES = '0';
process.env.GEMINI_OVERLOAD_BACKOFF_MS = '10';
delete process.env.GEMINI_MODEL_CHAIN;
delete process.env.GEMINI_FALLBACK_MODELS;
delete process.env.GEMINI_MODEL;

const {
  parseGeminiKeySlotsFromEnv,
  GEMINI_KEY_SLOTS,
  GEMINI_KEY_SLOT_MAX,
  GEMINI_KEY_COOLDOWN_MS,
  orderedGeminiKeySlots,
  markKeyCooldown,
  clearKeyCooldown,
  isKeyHealthy,
  isQuotaError,
  openGeminiStream,
  geminiKeyStatus,
  resetGeminiKeyRotationForTests,
} = require('../server');

assert.strictEqual(GEMINI_KEY_SLOT_MAX, 5);
assert.strictEqual(GEMINI_KEY_COOLDOWN_MS, 5000);
assert.strictEqual(GEMINI_KEY_SLOTS.length, 3);
assert.deepStrictEqual(
  GEMINI_KEY_SLOTS.map((s) => s.id),
  [1, 2, 3]
);

assert.deepStrictEqual(
  parseGeminiKeySlotsFromEnv({
    GEMINI_API_KEYS: 'a,b|c',
    GEMINI_API_KEY: 'a',
    GEMINI_API_KEY_2: 'd',
    GEMINI_API_KEY_3: '',
    GEMINI_API_KEY_4: 'e',
    GEMINI_API_KEY_5: 'f',
  }).map((s) => s.key),
  ['a', 'b', 'c', 'd', 'e']
);

assert.strictEqual(
  parseGeminiKeySlotsFromEnv({
    GEMINI_API_KEYS: '1,2,3,4,5,6',
  }).length,
  5,
  'cap at 5'
);

assert.strictEqual(isQuotaError(429, 'RESOURCE_EXHAUSTED', 'quota'), true);
assert.strictEqual(isQuotaError(503, 'UNAVAILABLE', 'high demand'), false);

const first = orderedGeminiKeySlots().map((s) => s.id);
const second = orderedGeminiKeySlots().map((s) => s.id);
const third = orderedGeminiKeySlots().map((s) => s.id);
assert.deepStrictEqual(first, [1, 2, 3]);
assert.deepStrictEqual(second, [2, 3, 1]);
assert.deepStrictEqual(third, [3, 1, 2]);

markKeyCooldown(2, 'test');
assert.strictEqual(isKeyHealthy(2), false);
const afterCooldown = orderedGeminiKeySlots().map((s) => s.id);
assert.ok(!afterCooldown.includes(2), 'cooling key skipped while healthy remain');
assert.deepStrictEqual(afterCooldown.sort(), [1, 3]);
clearKeyCooldown(2);
assert.strictEqual(isKeyHealthy(2), true);

const status = geminiKeyStatus();
assert.strictEqual(status.mode, 'round-robin');
assert.strictEqual(status.configured, 3);
assert.strictEqual(status.key1, 'configured');
assert.strictEqual(status.key4, 'missing');
assert.strictEqual(status.failoverReady, true);

function jsonResponse(statusCode, body, okOverride) {
  const ok = okOverride ?? (statusCode >= 200 && statusCode < 300);
  return {
    ok,
    status: statusCode,
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

async function withMockFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

(async () => {
  resetGeminiKeyRotationForTests();

  const calls = [];
  const opened = await withMockFetch(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('key=k1')) {
      return jsonResponse(429, {
        error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' },
      });
    }
    return jsonResponse(200, {});
  }, () => openGeminiStream({ contents: [] }, ['gemini-3.5-flash-lite']));

  assert.ok(opened.upstream, 'expected failover after 429');
  assert.ok(calls.length >= 2, `expected ≥2 attempts, got ${calls.length}`);
  assert.match(calls[0], /key=k1/);
  assert.ok(
    calls.slice(1).some((u) => /key=k2|key=k3/.test(u)),
    'expected next healthy key after 429'
  );
  assert.strictEqual(isKeyHealthy(1), false, 'key1 should be in cooldown after 429');

  const rr = orderedGeminiKeySlots().map((s) => s.id);
  assert.ok(!rr.includes(1), 'cooling key1 out of healthy RR pool');
  assert.ok(isKeyHealthy(2) || isKeyHealthy(3));

  console.log('verify-gemini-keys: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
