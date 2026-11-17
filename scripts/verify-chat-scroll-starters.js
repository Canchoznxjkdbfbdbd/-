'use strict';

/**
 * Offline contracts: near-bottom-only stream scroll (no force-to-cart) +
 * soft starter clarifying flow + BeFit weekly / cart when picture clear.
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
assert.ok(script.includes('function maybeFollowBottom'), 'maybeFollowBottom missing');
assert.ok(script.includes('ignoreScrollEvent'), 'ignoreScrollEvent guard missing');
assert.ok(script.includes('markProgrammaticScroll'), 'markProgrammaticScroll missing');
assert.ok(script.includes('let streamPinBottom'), 'streamPinBottom missing');
assert.ok(
  !script.includes('function scrollToMessageStart'),
  'scrollToMessageStart must be removed (forced jump / re-pin bug)'
);
assert.ok(!/scrollToMessageStart\s*\(/.test(script), 'no scrollToMessageStart calls');
assert.ok(
  /if \(ignoreScrollEvent\) return/.test(script),
  'stream scroll listener must ignore programmatic scrolls'
);
assert.ok(
  /role === 'user' \|\| isNearBottom\(\)/.test(script),
  'addMessage must not always force scrollBottom'
);
assert.ok(
  /preventScroll:\s*true/.test(script),
  'composer focus after stream must preventScroll'
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

assert.ok(/7b\./.test(prompt) && /уточняющ/.test(prompt), 'prompt must ask soft clarifying questions first (7b)');
assert.ok(
  /ТОЛЬКО 1–2|ТОЛЬКО 1-2/.test(prompt) && /Запрещено в этом ответе/.test(prompt),
  'prompt 7b must hard-require questions-only first reply'
);
assert.ok(
  /мягкого стартера[\s\S]{0,800}без \[\[/.test(prompt) || /без \[\[…\]\]/.test(prompt),
  'prompt must forbid [[tags]] / cart dump on soft starter'
);
assert.ok(
  !/сразу польза по запросу/.test(prompt),
  'old “immediate value before clarify” rule must be gone'
);
assert.ok(
  /недельные?/.test(prompt) && /BeFit/.test(prompt) && /пакет|рацион/.test(prompt),
  'prompt must still allow BeFit weekly packs after clarifications'
);
assert.ok(
  /на сейчас|на день|на неделю/.test(prompt),
  'prompt must offer cart horizon now/day/week'
);
assert.ok(
  /список покупок|корзин/.test(prompt),
  'prompt must still allow tags for real shopping turns'
);
assert.ok(prompt.includes('Собрать корзину'), 'cart block mention must remain');

assert.ok(script.includes('function stripBracketTags'), 'stripBracketTags hard gate missing');
assert.ok(
  /allowChipsThisReply|userTurns >= 2/.test(script),
  'first-reply chip suppress gate missing'
);
assert.ok(
  /allowChips:\s*allowChipsThisReply|allowChipsThisReply/.test(script),
  'stream paint must pass allowChipsThisReply'
);

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.ok(
  /ТОЛЬКО 1–2 коротких уточняющ/.test(server),
  'notime/grocery/kids overlays must clarify-first (not dump menu)'
);
assert.ok(
  !/Подстрой ответ: 2–4 готовых или почти готовых варианта на сегодня/.test(server),
  'old notime overlay that forced 2–4 options must be gone'
);
assert.ok(
  /latest user message|lastUserText\(messages\)/.test(server),
  'pickPartner must gate on latest user text, not starter alone'
);
assert.ok(
  !/нет времени\(\?:\\s\+готовить\)\?\|некогда\(\?:\\s\+готовить\)\?/.test(server),
  'INTENT_RE must not match bare «нет времени» from starter'
);

console.log('verify-chat-scroll-starters: ok');
