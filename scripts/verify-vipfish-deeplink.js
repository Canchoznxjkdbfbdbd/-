'use strict';

/**
 * Offline checks for Важная рыба [[vipfish:…]] / [[ryba:…]] → Admitad ulp deeplink.
 * Run: node scripts/verify-vipfish-deeplink.js
 */

const assert = require('assert');
const {
  buildVipfishAdmitadUrl,
  buildVkusvillAdmitadUrl,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveVipfishDeeplinkConfig,
  resolveVkusvillDeeplinkConfig,
  VIPFISH_SEARCH_PREFIX,
  VIPFISH_DEEPLINK,
  VIPFISH_GEO_CITIES,
  VKUSVILL_DEEPLINK,
} = require('../server');

assert.strictEqual(VIPFISH_SEARCH_PREFIX, 'https://vipfish.ru/search/?q=');
assert.ok(VIPFISH_DEEPLINK.enabled);
assert.ok(VIPFISH_DEEPLINK.admitadBase.includes('dorinebeaumont.com'));
assert.ok(!/vipfish\.ru/i.test(VIPFISH_DEEPLINK.admitadBase));
assert.strictEqual(VIPFISH_DEEPLINK.erid, '2bL9aMPo2e49hMef4peVndVUPr');
assert.ok(Array.isArray(VIPFISH_DEEPLINK.cities));
assert.ok(VIPFISH_DEEPLINK.cities.includes('Санкт-Петербург'));
assert.ok(VIPFISH_DEEPLINK.cities.includes('Мурино'));
assert.ok(VIPFISH_DEEPLINK.cities.includes('Кудрово'));
assert.deepStrictEqual(
  VIPFISH_GEO_CITIES.slice().sort(),
  [
    'Бугры',
    'Всеволожск',
    'Кудрово',
    'Мурино',
    'Петергоф',
    'Пушкин',
    'Санкт-Петербург',
    'Сестрорецк',
    'Шушары',
  ].sort()
);
assert.ok(VIPFISH_DEEPLINK.tagPrefixes.includes('vipfish'));
assert.ok(VIPFISH_DEEPLINK.tagPrefixes.includes('ryba'));
assert.ok(/Кейтеринг-Рент/.test(String(VIPFISH_DEEPLINK.legalName || VIPFISH_DEEPLINK.disclaimer || '')));
assert.strictEqual(VIPFISH_DEEPLINK.inn, '7804597213');

const stripped = normalizeAdmitadBase(
  'https://dorinebeaumont.com/g/lqb6l7197z268e100ca094cf89477e/?erid=2bL9aMPo2e49hMef4peVndVUPr&ulp=https%3A%2F%2Fold'
);
assert.ok(!/ulp=/i.test(stripped));
assert.ok(/erid=2bL9aMPo2e49hMef4peVndVUPr/.test(stripped));

assert.ok(
  looksLikeAdmitadWebmaster(
    'https://dorinebeaumont.com/g/lqb6l7197z268e100ca094cf89477e/?erid=2bL9aMPo2e49hMef4peVndVUPr'
  )
);
assert.ok(!looksLikeAdmitadWebmaster('https://vipfish.ru/catalog/poke-i-salaty/'));
assert.ok(!looksLikeAdmitadWebmaster('https://vkusvill.ru/?utm_source=x'));

const url = buildVipfishAdmitadUrl('лосось');
assert.ok(url);
assert.ok(url.startsWith('https://dorinebeaumont.com/'));
assert.ok(url.includes('erid=2bL9aMPo2e49hMef4peVndVUPr'));
assert.ok(url.includes('ulp='));

const ulp = new URL(url).searchParams.get('ulp');
assert.ok(ulp);
assert.strictEqual(
  ulp,
  `https://vipfish.ru/search/?q=${encodeURIComponent('лосось')}`
);

// Merchant landing must never become Admitad base.
const poisoned = resolveVipfishDeeplinkConfig([
  {
    id: 'vazhnaya-ryba',
    admitad_base: 'https://vipfish.ru/catalog/poke-i-salaty/',
    link: 'https://vipfish.ru/?utm_source=x',
    erid: '2bL9aMPo2e49hMef4peVndVUPr',
    legal_name: 'ООО «Кейтеринг-Рент»',
    inn: '7804597213',
    geo: ['Санкт-Петербург', 'Мурино'],
  },
]);
assert.ok(poisoned.admitadBase.includes('dorinebeaumont.com'));
assert.ok(!/vipfish\.ru/i.test(poisoned.admitadBase));
assert.deepStrictEqual(poisoned.cities, ['Санкт-Петербург', 'Мурино']);

// VV still intact after shared helpers.
assert.ok(VKUSVILL_DEEPLINK.enabled);
assert.ok(VKUSVILL_DEEPLINK.admitadBase.includes('kdbov.com'));
const vv = buildVkusvillAdmitadUrl('авокадо');
assert.ok(vv);
const vvUlp = new URL(vv).searchParams.get('ulp');
assert.ok(vvUlp && vvUlp.includes('vkusvill.ru/search'));
const vvPoison = resolveVkusvillDeeplinkConfig([
  {
    id: 'vkusvill',
    admitad_base: 'https://vkusvill.ru/?promo_code=VSC7247',
    link: 'https://vkusvill.ru/',
    erid: '2bL9aMPo2e49hMef4phUrdrQCx',
  },
]);
assert.ok(vvPoison.admitadBase.includes('kdbov.com'));

console.log('verify-vipfish-deeplink: ok');
console.log(' sample:', url);
