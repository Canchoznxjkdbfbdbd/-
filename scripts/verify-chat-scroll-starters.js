'use strict';

/**
 * Offline contracts: near-bottom stream scroll + short starter intents + no cart dump on soft starters.
 * Run: node scripts/verify-chat-scroll-starters.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const prompt = fs.readFileSync(path.join(root, 'prompt.txt'), 'utf8');

assert.ok(script.includes('function isNearBottom'), 'isNearBottom missing');
assert.ok(script.includes('function scrollToMessageStart'), 'scrollToMessageStart missing');
assert.ok(script.includes('let streamPinBottom'), 'streamPinBottom missing');
assert.ok(
  /if \(streamPinBottom\) scrollBottom\(\)/.test(script),
  'paint/status must guard scrollBottom with streamPinBottom'
);
assert.ok(
  /scrollToMessageStart\(wrap\);\s*streamPinBottom = false/.test(script),
  'beginReply must pin to message start and clear stream pin'
);
assert.ok(
  script.includes("messagesEl.removeEventListener('scroll', onStreamScroll)"),
  'stream scroll listener must be removed in finally'
);
assert.ok(
  !/webkitSpeechRecognition|SpeechRecognition|initVoiceInput|voice-input/.test(script),
  'voice STT must stay removed'
);
assert.ok(script.includes('function syncCartBlock'), 'cart block must stay intact');

assert.ok(!/scroll-behavior:\s*smooth/.test(css), 'messages scroll-behavior must not be smooth');
assert.ok(/scroll-behavior:\s*auto/.test(css), 'messages scroll-behavior should be auto');

const prompts = [...html.matchAll(/class="starter-chip"[^>]*data-prompt="([^"]+)"/g)].map((m) => m[1]);
assert.ok(prompts.length >= 5, 'expected starter chips');
for (const p of prompts) {
  assert.ok(p.trim().split(/\s+/).length <= 8, `starter prompt too long: ${p}`);
  assert.ok(
    !/Составьте короткий список покупок на 3–5 дней/.test(p),
    'old long shopping starter prompt still present'
  );
}

assert.ok(
  /первом ответе диалога|короткого стартера|без двойных квадратных скобок/.test(prompt),
  'prompt must forbid [[tags]] / cart dump on first soft starter'
);
assert.ok(
  /явно просит купить|список покупок|корзину/.test(prompt),
  'prompt must still allow tags for real shopping turns'
);
assert.ok(prompt.includes('Собрать корзину'), 'cart block mention must remain');

console.log('verify-chat-scroll-starters: ok');
