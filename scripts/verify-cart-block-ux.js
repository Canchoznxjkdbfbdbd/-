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
assert.ok(css.includes('.cart-block-first-order'), 'first-order plaque CSS missing');
assert.ok(script.includes('syncAuchanFirstOrderCta'), 'Auchan first-order CTA sync missing');
assert.ok(script.includes('Забрать скидку на первый заказ'), 'first-order CTA label missing');

assert.ok(prompt.includes('Собрать корзину'), 'prompt should mention cart block');
assert.ok(
  /Предпочтительно ставь метки в конце/.test(prompt),
  'prompt should prefer tags at end'
);
assert.ok(/7d\.\s*Рецепт/.test(prompt), 'prompt should have recipe block 7d');
assert.ok(/Мясо\s*\/\s*птица\s*\/\s*рыба/.test(prompt), 'prompt recipe: meat structure mentioned');
assert.ok(/Овощи\s*\/\s*крупы/.test(prompt), 'prompt recipe: veg/grains structure mentioned');
assert.ok(/Зелень/.test(prompt), 'prompt recipe: greens structure mentioned');
assert.ok(/Специи/.test(prompt), 'prompt recipe: spices structure mentioned');
assert.ok(
  /БЕЗ заголовков-категорий/.test(prompt),
  'prompt 7d must hide category headers from visible text'
);
assert.ok(
  /от основ до специй/.test(prompt),
  'prompt must tag full set from basics to spices'
);
assert.ok(
  /только недостающее|добор/.test(prompt),
  'prompt must top-up only missing items when user already has some'
);
assert.ok(
  /не будь «невнимательным»|следи за контекстом/.test(prompt),
  'prompt must require dialogue context for cart tags'
);
assert.ok(/не обрывай на полуслове/.test(prompt), 'prompt should forbid mid-word cutoff');
assert.ok(script.includes("payload.type === 'done'"), 'client should reconcile on done');
assert.ok(script.includes('syncTermLinkDock'), 'terminal link dock sync missing');
assert.ok(script.includes('function stripRecipeCategoryLabels'), 'client strip for category labels');
assert.ok(
  /body:not\(\.page-privacy\) \.composer[\s\S]{0,80}display:\s*none\s*!important/.test(css),
  'terminal composer must be hidden (inline shell type-in)'
);
assert.ok(
  /body:not\(\.page-privacy\) \.term-link-dock[\s\S]{0,40}order:\s*2/.test(css),
  'terminal product link dock stays at bottom (order 2)'
);

const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert.ok(
  /term-live-line"><span class="term-live-prompt"[^>]*>nutrikod:~\$ <\/span><span id="term-live-text"/.test(
    indexHtml
  ),
  'term-live prompt+text must be adjacent (no newline before caret)'
);

console.log('verify-cart-block-ux: ok');
