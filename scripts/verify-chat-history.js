'use strict';

/**
 * Offline checks for browser-only chat history store.
 * Run: node scripts/verify-chat-history.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const History = require('../public/history-store');

const GREETING =
  'Залог хорошего самочувствия — это сбалансированное питание. Иногда его нужно подбирать индивидуально. Приступим...';
const FIRST_QUESTION =
  'Расскажите коротко: как вы питаетесь сейчас, есть ли аллергии или ограничения, и какую цель хотите — энергия, лёгкость, набор, поддержка после нагрузок или что-то ещё?';

assert.strictEqual(History.STORAGE_KEY, 'nutrikod_chat');
assert.strictEqual(History.VERSION, 1);

const memory = (() => {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
})();

const messages = [
  { role: 'assistant', content: `${GREETING}\n\n${FIRST_QUESTION}` },
  { role: 'user', content: 'Хочу лёгкий ужин без глютена' },
  { role: 'assistant', content: 'Можно так: рыба, овощи, гречка.' },
];

assert.strictEqual(History.save(memory, { messages, partnerShown: true, userTurns: 1 }), true);
const loaded = History.load(memory);
assert.ok(loaded);
assert.strictEqual(loaded.messages.length, 3);
assert.strictEqual(loaded.partnerShown, true);
assert.strictEqual(loaded.userTurns, 1);
assert.strictEqual(loaded.messages[1].content, 'Хочу лёгкий ужин без глютена');

// Ignore junk roles / empty content.
assert.deepStrictEqual(
  History.sanitizeMessages([
    { role: 'system', content: 'nope' },
    { role: 'user', content: '  ' },
    { role: 'user', content: 'ok' },
    null,
  ]),
  [{ role: 'user', content: 'ok' }]
);

assert.strictEqual(History.parse('not-json'), null);
assert.strictEqual(History.parse(JSON.stringify({ v: 99, messages })), null);
assert.strictEqual(History.parse(JSON.stringify({ v: 1, messages: [] })), null);

assert.strictEqual(
  History.displayAssistantText(GREETING, FIRST_QUESTION, `${GREETING}\n\n${FIRST_QUESTION}`),
  FIRST_QUESTION
);
assert.strictEqual(
  History.displayAssistantText(GREETING, FIRST_QUESTION, 'План на завтра'),
  'План на завтра'
);

History.clear(memory);
assert.strictEqual(History.load(memory), null);

// Empty save removes the key.
History.save(memory, { messages, userTurns: 1 });
assert.ok(memory.getItem(History.STORAGE_KEY));
History.save(memory, { messages: [] });
assert.strictEqual(memory.getItem(History.STORAGE_KEY), null);

// UI wiring present.
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(html.includes('id="clear-chat"'));
assert.ok(html.includes('Очистить чат'));
assert.ok(html.includes('history-store.js'));
assert.ok(/только в вашем браузере/i.test(html));
assert.ok(/Gemini/i.test(html));

const script = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
assert.ok(script.includes('NutriKodHistory'));
assert.ok(script.includes('persistChat'));
assert.ok(script.includes('renderRestoredHistory'));
assert.ok(script.includes('Точно очистить?'));
assert.ok(script.includes('setClearArmed'));

console.log('verify-chat-history: ok');
