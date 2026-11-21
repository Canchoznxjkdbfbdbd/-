'use strict';

/**
 * Offline checks for admin kill switch (service.json).
 * Run: BOT_API_KEY=test-bot-key node scripts/verify-kill-switch.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.BOT_API_KEY = process.env.BOT_API_KEY || 'test-bot-key-verify';
process.env.ADMIN_USER = process.env.ADMIN_USER || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pass';
if (!process.env.VERIFY_LIVE) {
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEY_2 = '';
}

const {
  app,
  isServiceEnabled,
  setServiceEnabled,
  SERVICE_PATH,
  SERVICE_DISABLED_USER_MESSAGE,
} = require('../server');

assert.strictEqual(typeof isServiceEnabled, 'function');
assert.strictEqual(typeof setServiceEnabled, 'function');

function listen(appRef) {
  return new Promise((resolve) => {
    const server = http.createServer(appRef);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function basicAuth() {
  const token = Buffer.from(
    `${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`,
    'utf8'
  ).toString('base64');
  return `Basic ${token}`;
}

async function req(base, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, ct, text };
}

async function main() {
  const prevExists = fs.existsSync(SERVICE_PATH);
  const prevRaw = prevExists ? fs.readFileSync(SERVICE_PATH, 'utf8') : null;

  const { server, base } = await listen(app);
  const botKey = process.env.BOT_API_KEY;

  try {
    // Default / after enable → ON
    setServiceEnabled(true);
    assert.strictEqual(isServiceEnabled(), true);

    const cfgOn = await req(base, { path: '/api/config' });
    assert.strictEqual(cfgOn.status, 200);
    const cfgOnJson = JSON.parse(cfgOn.text);
    assert.strictEqual(cfgOnJson.serviceEnabled, true);

    // Disable via admin API
    const off = await req(base, {
      method: 'POST',
      path: '/api/admin/service',
      headers: { Authorization: basicAuth() },
      body: { enabled: false },
    });
    assert.strictEqual(off.status, 200, off.text);
    const offJson = JSON.parse(off.text);
    assert.strictEqual(offJson.serviceEnabled, false);
    assert.strictEqual(isServiceEnabled(), false);
    assert.ok(fs.existsSync(SERVICE_PATH));
    assert.strictEqual(JSON.parse(fs.readFileSync(SERVICE_PATH, 'utf8')).enabled, false);

    // Chat SSE → calm error, no Gemini path needed
    const chat = await req(base, {
      method: 'POST',
      path: '/api/chat',
      body: { messages: [{ role: 'user', content: 'привет' }] },
    });
    assert.strictEqual(chat.status, 200);
    assert.match(chat.ct, /text\/event-stream/i);
    assert.match(chat.text, /SERVICE_DISABLED|Сервис временно недоступен/);
    assert.ok(chat.text.includes(SERVICE_DISABLED_USER_MESSAGE));

    // Bot JSON → 503
    const bot = await req(base, {
      method: 'POST',
      path: '/api/bot/chat',
      headers: { 'X-Bot-Key': botKey },
      body: { message: 'привет' },
    });
    assert.strictEqual(bot.status, 503);
    assert.match(bot.ct, /json/i);
    const botJson = JSON.parse(bot.text);
    assert.strictEqual(botJson.error, SERVICE_DISABLED_USER_MESSAGE);

    // Admin still reachable
    const files = await req(base, {
      path: '/api/admin/files',
      headers: { Authorization: basicAuth() },
    });
    assert.strictEqual(files.status, 200);
    const filesJson = JSON.parse(files.text);
    assert.strictEqual(filesJson.serviceEnabled, false);
    assert.ok(typeof filesJson.prompt === 'string' && filesJson.prompt.length > 0);

    // Re-enable
    const on = await req(base, {
      method: 'POST',
      path: '/api/admin/service',
      headers: { Authorization: basicAuth() },
      body: { enabled: true },
    });
    assert.strictEqual(on.status, 200);
    assert.strictEqual(JSON.parse(on.text).serviceEnabled, true);
    assert.strictEqual(isServiceEnabled(), true);

    // Bot works again (mock without Gemini key)
    const botOk = await req(base, {
      method: 'POST',
      path: '/api/bot/chat',
      headers: { 'X-Bot-Key': botKey },
      body: { message: 'Что поесть?' },
    });
    assert.strictEqual(botOk.status, 200);
    assert.match(botOk.ct, /json/i);
    assert.ok(JSON.parse(botOk.text).reply);

    console.log('verify-kill-switch: ok');
  } finally {
    server.close();
    try {
      if (prevRaw != null) {
        fs.writeFileSync(SERVICE_PATH, prevRaw, 'utf8');
      } else if (fs.existsSync(SERVICE_PATH)) {
        fs.unlinkSync(SERVICE_PATH);
      }
    } catch (err) {
      console.warn('cleanup service.json:', err?.message || err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  try {
    if (fs.existsSync(SERVICE_PATH)) fs.unlinkSync(SERVICE_PATH);
  } catch {
    /* ignore */
  }
});
