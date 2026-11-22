'use strict';

/**
 * Offline checks for Ашан [[auchan:…]] / [[ashan:…]] → Admitad ulp deeplink.
 * Run: node scripts/verify-auchan-deeplink.js
 */

const assert = require('assert');
const {
  buildAuchanAdmitadUrl,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveAuchanDeeplinkConfig,
  resolveAuchanTargetUrl,
  AUCHAN_SEARCH_PREFIX,
  AUCHAN_PRODUCT_PREFIX,
  AUCHAN_DEEPLINK,
  VKUSVILL_DEEPLINK,
  buildVkusvillAdmitadUrl,
} = require('../server');

assert.strictEqual(AUCHAN_SEARCH_PREFIX, 'https://www.auchan.ru/search/?query=');
assert.strictEqual(AUCHAN_PRODUCT_PREFIX, 'https://www.auchan.ru/product/');
assert.ok(AUCHAN_DEEPLINK.enabled);
assert.ok(AUCHAN_DEEPLINK.admitadBase.includes('rthsu.com'));
assert.ok(!/auchan\.ru/i.test(AUCHAN_DEEPLINK.admitadBase));
assert.strictEqual(AUCHAN_DEEPLINK.erid, '2bL9aMPo2e49hMef4rrTkXfiWn');
assert.strictEqual(AUCHAN_DEEPLINK.promoCode, null);
assert.deepStrictEqual(AUCHAN_DEEPLINK.tagPrefixes, ['auchan', 'ashan']);
assert.ok(AUCHAN_DEEPLINK.firstOrder);
assert.strictEqual(AUCHAN_DEEPLINK.firstOrder.erid, '2bL9aMPo2e49hMef4rrUepvhzG');
assert.notStrictEqual(AUCHAN_DEEPLINK.firstOrder.erid, AUCHAN_DEEPLINK.erid);
assert.ok(String(AUCHAN_DEEPLINK.firstOrder.link).includes('30o5vsx0bi'));
assert.ok(!String(AUCHAN_DEEPLINK.admitadBase).includes('30o5vsx0bi'));

const stripped = normalizeAdmitadBase(
  'https://rthsu.com/g/g1f8w0wsou268e100ca0414eca7795/?erid=2bL9aMPo2e49hMef4rrTkXfiWn&ulp=https%3A%2F%2Fold'
);
assert.ok(!/ulp=/i.test(stripped));
assert.ok(/erid=2bL9aMPo2e49hMef4rrTkXfiWn/.test(stripped));

assert.ok(
  looksLikeAdmitadWebmaster(
    'https://rthsu.com/g/g1f8w0wsou268e100ca0414eca7795/?erid=2bL9aMPo2e49hMef4rrTkXfiWn'
  )
);
assert.ok(!looksLikeAdmitadWebmaster('https://www.auchan.ru/search/?query=гречка'));
assert.ok(!looksLikeAdmitadWebmaster('https://auchan.ru/'));

const url = buildAuchanAdmitadUrl('гречка');
assert.ok(url);
assert.ok(url.startsWith('https://rthsu.com/'));
assert.ok(url.includes('erid=2bL9aMPo2e49hMef4rrTkXfiWn'));
assert.ok(url.includes('ulp='));

const ulp = new URL(url).searchParams.get('ulp');
assert.ok(ulp);
assert.strictEqual(
  ulp,
  `https://www.auchan.ru/search/?query=${encodeURIComponent('гречка')}`
);

const productUrl = buildAuchanAdmitadUrl('product/organik-0-5');
assert.ok(productUrl);
const productUlp = new URL(productUrl).searchParams.get('ulp');
assert.strictEqual(productUlp, 'https://www.auchan.ru/product/organik-0-5/');

assert.strictEqual(
  resolveAuchanTargetUrl('organik-0-5'),
  'https://www.auchan.ru/product/organik-0-5/'
);
assert.ok(
  resolveAuchanTargetUrl('гречка').includes('/search/?query=')
);

// Merchant landing must never become Admitad base.
const poisoned = resolveAuchanDeeplinkConfig([
  {
    id: 'auchan',
    admitad_base: 'https://www.auchan.ru/?utm_source=x',
    link: 'https://www.auchan.ru/',
    erid: '2bL9aMPo2e49hMef4rrTkXfiWn',
  },
]);
assert.ok(poisoned.admitadBase.includes('rthsu.com'));
assert.ok(!/auchan\.ru/i.test(poisoned.admitadBase));

assert.ok(VKUSVILL_DEEPLINK.enabled);
const vv = buildVkusvillAdmitadUrl('авокадо');
assert.ok(vv && new URL(vv).searchParams.get('ulp').includes('vkusvill.ru/search'));

console.log('verify-auchan-deeplink: ok');
console.log(' sample:', url);
