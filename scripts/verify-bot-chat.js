'use strict';

/**
 * Offline checks for POST /api/bot/chat (auth, JSON shape, no SSE).
 * Run: BOT_API_KEY=test-bot-key node scripts/verify-bot-chat.js
 */

const assert = require('assert');
const http = require('http');

process.env.BOT_API_KEY = process.env.BOT_API_KEY || 'test-bot-key-verify';
// Offline by default: empty keys before require so dotenv won't fill mock path.
if (!process.env.VERIFY_LIVE) {
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEY_2 = '';
}

const { app, generateFullReply } = require('../server');

assert.strictEqual(typeof generateFullReply, 'function');

function listen(appRef) {
  return new Promise((resolve) => {
    const server = http.createServer(appRef);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function req(base, { method = 'POST', path = '/api/bot/chat', headers = {}, body }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, ct, text };
}

async function main() {
  const { server, base } = await listen(app);
  const key = process.env.BOT_API_KEY;

  try {
    // Missing key → 401
    {
      const r = await req(base, { body: { message: 'привет' } });
      assert.strictEqual(r.status, 401);
      assert.match(r.ct, /json/i);
      assert.doesNotMatch(r.ct, /text\/event-stream/i);
    }

    // Wrong key → 401
    {
      const r = await req(base, {
        headers: { 'X-Bot-Key': 'wrong' },
        body: { message: 'привет' },
      });
      assert.strictEqual(r.status, 401);
    }

    // Empty message → 400
    {
      const r = await req(base, {
        headers: { 'X-Bot-Key': key },
        body: { message: '   ' },
      });
      assert.strictEqual(r.status, 400);
    }

    // OK → JSON { reply }, never SSE (mock path without Gemini key)
    {
      const r = await req(base, {
        headers: { 'X-Bot-Key': key },
        body: { message: 'Что поесть на завтрак?' },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.match(r.ct, /application\/json/i);
      assert.doesNotMatch(r.ct, /text\/event-stream/i);
      assert.doesNotMatch(r.text, /^data:/m);
      const data = JSON.parse(r.text);
      assert.equal(typeof data.reply, 'string');
      assert.ok(data.reply.trim().length > 20);
    }

    // Frontend /api/chat still SSE
    {
      const r = await req(base, {
        path: '/api/chat',
        body: { messages: [{ role: 'user', content: 'тест' }] },
      });
      assert.strictEqual(r.status, 200);
      assert.match(r.ct, /text\/event-stream/i);
    }

    // generateFullReply returns a string
    {
      const reply = await generateFullReply('Короткий совет по ужину');
      assert.equal(typeof reply, 'string');
      assert.ok(reply.trim().length > 10);
    }

    console.log('verify-bot-chat: ok');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
