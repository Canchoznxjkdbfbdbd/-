'use strict';

/**
 * Offline source contracts for voice INPUT (STT) — no TTS.
 * Run: node scripts/verify-voice-input.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

assert.match(indexHtml, /id="voice-input"/);
assert.match(indexHtml, /aria-label="Голосовой ввод"/);
assert.match(indexHtml, /id="send"/);
assert.match(indexHtml, /id="community-vk"/);
assert.match(indexHtml, /https:\/\/vk\.ru\/ai\.nutricode/);

assert.ok(script.includes('webkitSpeechRecognition'), 'webkitSpeechRecognition missing');
assert.ok(script.includes("recognition.lang = 'ru-RU'"), 'ru-RU lang missing');
assert.ok(script.includes('initVoiceInput'), 'initVoiceInput missing');
assert.ok(script.includes('stopVoiceInput'), 'stopVoiceInput missing');
assert.ok(script.includes('toggleVoiceInput'), 'toggleVoiceInput missing');
assert.ok(script.includes('voiceBtn.hidden = false'), 'show mic when supported missing');
assert.ok(script.includes("form.classList.add('composer--voice')"), 'composer voice class missing');
assert.ok(!/speechSynthesis|SpeechSynthesisUtterance/.test(script), 'TTS must not be present');
assert.ok(script.includes('function syncCartBlock'), 'cart block must stay');
assert.ok(script.includes('COMMUNITY_VK_URL_DEFAULT'), 'VK default must stay');

assert.ok(css.includes('.voice-input'), 'voice-input CSS missing');
assert.ok(css.includes('.composer--voice'), 'composer--voice CSS missing');
assert.ok(css.includes('voice-pulse'), 'listening pulse missing');

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.ok(server.includes('GEMINI_API_ORIGIN'), 'GEMINI_API_ORIGIN must stay in server');

console.log('verify:voice-input ok');
