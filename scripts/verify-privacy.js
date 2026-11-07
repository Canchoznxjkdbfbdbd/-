'use strict';

/**
 * Offline checks for the short privacy/info page and footer link.
 * Run: node scripts/verify-privacy.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const privacyHtml = fs.readFileSync(path.join(root, 'public', 'privacy.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

assert.match(indexHtml, /href="\/privacy\.html"/);
assert.match(indexHtml, /О данных и границах/);

assert.match(privacyHtml, /lang="ru"/);
assert.match(privacyHtml, /Что уходит в Gemini/);
assert.match(privacyHtml, /История только в браузере/);
assert.match(privacyHtml, /Без аккаунтов/);
assert.match(privacyHtml, /Не медицинский совет/);
assert.match(privacyHtml, /href="\/"/);
assert.match(privacyHtml, /без регистрации/i);

assert.match(styleCss, /\.legal-link\s*\{/);
assert.match(styleCss, /\.privacy-card\s*\{/);

console.log('verify:privacy ok');
