'use strict';

/**
 * Offline source contracts for cart-block deeplink UX (no inline chips in prose).
 * Run: node scripts/verify-cart-block-ux.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const prompt = fs.readFileSync(path.join(root, 'prompt.txt'), 'utf8');

assert.ok(script.includes('function syncCartBlock'), 'syncCartBlock missing');
assert.ok(script.includes('Собрать корзину'), 'cart title missing');
assert.ok(script.includes('Полезные ссылки'), 'links title missing');
assert.ok(
  script.includes('Когда рацион уже ясен — эти ссылки помогут сэкономить время и деньги.'),
  'soft CTA missing'
);
assert.ok(script.includes('cart-block-chips'), 'chip row missing');
assert.ok(
  /\/\/ Prose stays readable plain names[\s\S]*pushText\(hit\.label\)/.test(script),
  'prose must keep plain product names'
);
assert.ok(
  !/else if \(hit\.href\) \{\s*const a = document\.createElement\('a'\);\s*a\.className = 'product-chip'/.test(
    script
  ),
  'inline product-chip in prose path should be gone'
);
assert.ok(script.includes('if (cart) cart.appendChild(box)'), 'partner should nest into cart block');

assert.ok(css.includes('.cart-block'), 'cart-block CSS missing');
assert.ok(css.includes('.cart-block-chips'), 'cart-block-chips CSS missing');
assert.ok(css.includes('.cart-block-cta'), 'cart-block-cta CSS missing');

assert.ok(prompt.includes('Собрать корзину'), 'prompt should mention cart block');
assert.ok(
  /Предпочтительно ставь метки в конце/.test(prompt),
  'prompt should prefer tags at end'
);

console.log('verify-cart-block-ux: ok');
