'use strict';

/**
 * Modes registry + GET /api/modes (ephemeral HTTP).
 * Run: node scripts/verify-modes.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

if (!process.env.VERIFY_LIVE) {
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEY_2 = '';
}

const {
  app,
  CHAT_MODES,
  MODE_IDS,
  loadModes,
  normalizeModeId,
  resolveChatMode,
  modeOverlayBlock,
  buildSystemInstruction,
} = require('../server');

const MODES_DIR = path.join(__dirname, '..', 'modes');
const TEST_MODE_PATH = path.join(MODES_DIR, 'test.json');
const BROKEN_MODE_PATH = path.join(MODES_DIR, 'zz-broken.json');

function user(text) {
  return [{ role: 'user', content: text }];
}

function listen(appRef) {
  return new Promise((resolve) => {
    const server = http.createServer(appRef);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function getModes(base) {
  const res = await fetch(`${base}/api/modes`);
  const cache = res.headers.get('cache-control') || '';
  const body = await res.json();
  return { status: res.status, cache, body };
}

function cleanupTempModes() {
  for (const p of [TEST_MODE_PATH, BROKEN_MODE_PATH]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

// --- unit: registry from modes/*.json ---
loadModes();
assert.deepStrictEqual(MODE_IDS.slice().sort(), ['grocery', 'kids', 'normal', 'notime'].sort());
assert.ok(CHAT_MODES.kids && CHAT_MODES.kids.overlay.includes('детский'));
assert.strictEqual(normalizeModeId('KIDS'), 'kids');
assert.strictEqual(normalizeModeId('weird'), 'normal');

const explicitKids = resolveChatMode('kids', user('просто расскажи про ужин'));
assert.strictEqual(explicitKids.id, 'kids');
assert.strictEqual(explicitKids.source, 'explicit');
assert.ok(explicitKids.overlay.includes('детский'));

const explicitWins = resolveChatMode('notime', user('нужен список покупок на неделю'));
assert.strictEqual(explicitWins.id, 'notime');
assert.strictEqual(explicitWins.source, 'explicit');

const detectedGrocery = resolveChatMode('normal', user('Составь список покупок на 5 дней'));
assert.strictEqual(detectedGrocery.id, 'grocery');
assert.strictEqual(detectedGrocery.source, 'detected');

const detectedKids = resolveChatMode('', user('Что приготовить ребёнку и всей семье?'));
assert.strictEqual(detectedKids.id, 'kids');
assert.strictEqual(detectedKids.source, 'detected');

const detectedNotime = resolveChatMode('normal', user('Нет времени готовить — что быстро поесть?'));
assert.strictEqual(detectedNotime.id, 'notime');
assert.strictEqual(detectedNotime.source, 'detected');

const plain = resolveChatMode('normal', user('Хочу больше овощей и белка'));
assert.strictEqual(plain.id, 'normal');
assert.strictEqual(plain.source, 'default');
assert.strictEqual(modeOverlayBlock(plain), '');

assert.ok(/ТОЛЬКО 1–2/.test(CHAT_MODES.kids.overlay), 'kids overlay must clarify-first');
assert.ok(/ТОЛЬКО 1–2/.test(CHAT_MODES.notime.overlay), 'notime overlay must clarify-first');
assert.ok(/ТОЛЬКО 1–2/.test(CHAT_MODES.grocery.overlay), 'grocery overlay must clarify-first');
assert.ok(
  !/2–4 готовых или почти готовых варианта на сегодня/.test(CHAT_MODES.notime.overlay),
  'notime must not dump 2–4 options on first reply'
);
assert.ok(/БЕЗ города/.test(CHAT_MODES.notime.overlay), 'notime must not ask city on first reply');
assert.ok(
  !/город \(MSK\/SPb\?\)/.test(CHAT_MODES.notime.overlay),
  'old notime first-turn MSK/SPb city ask must be gone'
);
assert.ok(
  /Город спроси позже|позже и мягко/.test(CHAT_MODES.notime.overlay),
  'notime must delay soft city ask until delivery/cart'
);
assert.ok(/БЕЗ города/.test(CHAT_MODES.grocery.overlay), 'grocery must not ask city on first reply');
assert.ok(
  /через чипы|БЕЗ второго маркированного/.test(CHAT_MODES.grocery.overlay),
  'grocery must align with chip-no-duplicate-list (#48)'
);
assert.ok(
  !/После уточнений — короткий маркированный список продуктов/.test(CHAT_MODES.grocery.overlay),
  'grocery must not force a second bullet product list when chips are used'
);

const system = buildSystemInstruction(CHAT_MODES.grocery);
assert.ok(system.includes('НутриКод'));
assert.ok(system.includes('список покупок'));
assert.ok(!/DONATE_URL/.test(system), 'system must not inject DONATE_URL');
assert.ok(!/Контекст доната/i.test(system), 'system must not append donate context');
assert.ok(!/кнопка поддержки ниже/i.test(system), 'system must not soft-promo donate UI');
assert.ok(/Не упоминай донат/i.test(system), 'system must explicitly forbid donate mentions in replies');

async function main() {
  cleanupTempModes();
  loadModes();

  const { server, base } = await listen(app);

  try {
    // Baseline: 4 modes from modes/*.json
    {
      const r = await getModes(base);
      assert.strictEqual(r.status, 200);
      assert.ok(/no-store|max-age=60/i.test(r.cache), `Cache-Control expected, got: ${r.cache}`);
      assert.ok(Array.isArray(r.body));
      assert.strictEqual(r.body.length, 4, JSON.stringify(r.body));
      for (const row of r.body) {
        assert.deepStrictEqual(Object.keys(row).sort(), ['id', 'label']);
      }
      assert.deepStrictEqual(
        r.body.map((m) => m.id).sort(),
        ['grocery', 'kids', 'normal', 'notime']
      );
    }

    // Add test.json → reload → 5
    fs.writeFileSync(
      TEST_MODE_PATH,
      JSON.stringify({
        id: 'test',
        label: 'Тест',
        overlay: 'verify-modes ephemeral',
        detect: ['режимтеста'],
      }),
      'utf8'
    );
    loadModes();
    {
      const r = await getModes(base);
      assert.strictEqual(r.body.length, 5, JSON.stringify(r.body));
      assert.ok(r.body.some((m) => m.id === 'test' && m.label === 'Тест'));
    }

    // Remove test.json → reload → 4
    fs.unlinkSync(TEST_MODE_PATH);
    loadModes();
    {
      const r = await getModes(base);
      assert.strictEqual(r.body.length, 4, JSON.stringify(r.body));
      assert.ok(!r.body.some((m) => m.id === 'test'));
    }

    // Broken JSON skipped — still 4
    fs.writeFileSync(BROKEN_MODE_PATH, '{not-json', 'utf8');
    loadModes();
    {
      const r = await getModes(base);
      assert.strictEqual(r.body.length, 4, JSON.stringify(r.body));
    }

    // Missing id/label skipped
    fs.writeFileSync(BROKEN_MODE_PATH, JSON.stringify({ overlay: 'nope' }), 'utf8');
    loadModes();
    {
      const r = await getModes(base);
      assert.strictEqual(r.body.length, 4, JSON.stringify(r.body));
    }
  } finally {
    cleanupTempModes();
    loadModes();
    server.close();
  }

  console.log('verify-modes: ok');
}

main().catch((err) => {
  cleanupTempModes();
  try {
    loadModes();
  } catch {
    /* ignore */
  }
  console.error(err);
  process.exit(1);
});
