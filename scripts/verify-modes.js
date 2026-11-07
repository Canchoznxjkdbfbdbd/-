'use strict';

/**
 * Offline checks for chat-mode overlays (надстройки).
 * Run: node scripts/verify-modes.js
 */

const assert = require('assert');
const {
  CHAT_MODES,
  MODE_IDS,
  normalizeModeId,
  resolveChatMode,
  modeOverlayBlock,
  buildSystemInstruction,
} = require('../server');

function user(text) {
  return [{ role: 'user', content: text }];
}

assert.deepStrictEqual(MODE_IDS, ['normal', 'kids', 'notime', 'grocery']);
assert.strictEqual(normalizeModeId('KIDS'), 'kids');
assert.strictEqual(normalizeModeId('weird'), 'normal');

const explicitKids = resolveChatMode('kids', user('просто расскажи про ужин'));
assert.strictEqual(explicitKids.id, 'kids');
assert.strictEqual(explicitKids.source, 'explicit');
assert.ok(explicitKids.overlay.includes('детский'));

// Explicit wins over wording that would detect another mode.
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

const kidsBlock = modeOverlayBlock(CHAT_MODES.kids);
assert.ok(kidsBlock.includes('Режим-надстройка'));
assert.ok(kidsBlock.includes('детский'));

const system = buildSystemInstruction(CHAT_MODES.grocery);
assert.ok(system.includes('НутриКод'));
assert.ok(system.includes('список покупок'));
assert.ok(system.includes('DONATE_URL'));

console.log('verify-modes: ok');
