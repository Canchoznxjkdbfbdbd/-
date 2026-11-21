'use strict';

/**
 * Smoke checks for smart rate limits / Gemini concurrency / admin fail2ban-light.
 * Run: npm run verify:rate-limits
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Tight limits for this process before requiring server.js
process.env.CHAT_RATE_MINUTE_MAX = '3';
process.env.CHAT_RATE_MINUTE_WINDOW_MS = '60000';
process.env.CHAT_RATE_BURST_MAX = '20';
process.env.CHAT_RATE_BURST_WINDOW_MS = '300000';
process.env.GEMINI_CONCURRENCY_MAX = '2';
process.env.MAX_MESSAGE_CHARS = '4000';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'verify-admin-pass';
process.env.ADMIN_AUTH_FAIL_MAX = '3';
process.env.ADMIN_AUTH_BAN_MS = '600000';
process.env.BOT_API_KEY = 'verify-bot-key';
// Mock chat path (no real Gemini) — still exercises IP rate limiters.
process.env.GEMINI_API_KEY = '';
process.env.GEMINI_API_KEY_2 = '';

const {
  app,
  MAX_MESSAGE_CHARS,
  CHAT_RATE_MINUTE_MAX,
  CHAT_RATE_BURST_MAX,
  GEMINI_CONCURRENCY_MAX,
  GEMINI_BUSY_USER_MESSAGE,
  acquireGeminiSlot,
  releaseGeminiSlot,
  ADMIN_AUTH_FAIL_MAX,
  recordAdminAuthFail,
  clearAdminAuthFails,
  isAdminIpBanned,
  generateGeminiReply,
} = require('../server');

assert.strictEqual(MAX_MESSAGE_CHARS, 4000);
assert.strictEqual(CHAT_RATE_MINUTE_MAX, 3);
assert.strictEqual(CHAT_RATE_BURST_MAX, 20);
assert.strictEqual(GEMINI_CONCURRENCY_MAX, 2);
assert.strictEqual(ADMIN_AUTH_FAIL_MAX, 3);
assert.match(GEMINI_BUSY_USER_MESSAGE, /много запросов/i);

function listen(appRef) {
  return new Promise((resolve) => {
    const server = http.createServer(appRef);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function postChat(base) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'тест лимита' }] }),
  });
  const text = await res.text();
  return { status: res.status, text, ct: res.headers.get('content-type') || '' };
}

async function getAdmin(base, user, pass) {
  const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  const res = await fetch(`${base}/admin`, {
    headers: { Authorization: `Basic ${token}` },
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  // --- Gemini slot wallet (site+bot share) ---
  assert.strictEqual(await acquireGeminiSlot(), true);
  assert.strictEqual(await acquireGeminiSlot(), true);
  assert.strictEqual(await acquireGeminiSlot(), false);
  await releaseGeminiSlot();
  assert.strictEqual(await acquireGeminiSlot(), true);
  await releaseGeminiSlot();
  await releaseGeminiSlot();

  // Without API key, generateGeminiReply uses mock and must not stick on a slot.
  const mock = await generateGeminiReply({
    messages: [{ role: 'user', content: 'привет' }],
    logLabel: 'verify',
  });
  assert.ok(mock.mock || String(mock.text || '').length > 0);
  assert.strictEqual(await acquireGeminiSlot(), true);
  await releaseGeminiSlot();

  // --- Message length constant matches UI maxlength ---
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(indexHtml, /maxlength="4000"/);
  const historyStore = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'history-store.js'),
    'utf8'
  );
  assert.match(historyStore, /slice\(0,\s*4000\)/);

  // --- nginx sample has chat rate limit + bot allowlist placeholder ---
  const nginx = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'nginx-nutricode.conf'),
    'utf8'
  );
  assert.match(nginx, /limit_req_zone/);
  assert.match(nginx, /limit_req zone=nutri_chat/);
  assert.match(nginx, /proxy_buffering off/);
  assert.match(nginx, /YOUR\.BOT\.DE\.IP/);
  assert.match(nginx, /127\.0\.0\.1:3000/);
  assert.match(nginx, /Do NOT open firewall/);

  const { server, base } = await listen(app);
  try {
    // Minute limiter: 3 OK (mock SSE), 4th → 429
    for (let i = 0; i < 3; i++) {
      const r = await postChat(base);
      assert.strictEqual(r.status, 200, `chat #${i + 1}: ${r.status} ${r.text.slice(0, 120)}`);
      assert.match(r.ct, /text\/event-stream/i);
    }
    {
      const r = await postChat(base);
      assert.strictEqual(r.status, 429, r.text.slice(0, 200));
      assert.match(r.text, /часто|подождите/i);
    }

    // Admin fail2ban-light
    clearAdminAuthFails('unit-test-ip');
    for (let i = 0; i < 3; i++) {
      recordAdminAuthFail('unit-test-ip');
    }
    assert.strictEqual(isAdminIpBanned('unit-test-ip'), true);
    clearAdminAuthFails('unit-test-ip');
    assert.strictEqual(isAdminIpBanned('unit-test-ip'), false);

    {
      const bad = await getAdmin(base, 'admin', 'wrong-password');
      assert.strictEqual(bad.status, 401);
    }
    {
      const bad2 = await getAdmin(base, 'admin', 'wrong-password');
      assert.strictEqual(bad2.status, 401);
    }
    {
      const bad3 = await getAdmin(base, 'admin', 'wrong-password');
      assert.strictEqual(bad3.status, 401);
    }
    {
      const banned = await getAdmin(base, 'admin', 'wrong-password');
      assert.strictEqual(banned.status, 429, banned.text.slice(0, 200));
      assert.match(banned.text, /неудачных попыток/i);
    }
    {
      // Even correct password is rejected while banned (cooldown).
      const still = await getAdmin(base, 'admin', 'verify-admin-pass');
      assert.strictEqual(still.status, 429);
    }

    console.log('verify-smart-rate-limits: ok');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
