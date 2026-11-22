'use strict';

/**
 * Offline checks for VkusVill [[product]] → Admitad ulp deeplink.
 * Run: node scripts/verify-vkusvill-deeplink.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildVkusvillAdmitadUrl,
  normalizeAdmitadBase,
  resolveVkusvillDeeplinkConfig,
  VKUSVILL_SEARCH_PREFIX,
  VKUSVILL_DEEPLINK,
  VKUSVILL_GEO,
} = require('../server');

const OWNER_VKUSVILL_GEO = [
  'Ленинградская область',
  'Москва',
  'Московская область',
  'Россия',
  'Санкт-Петербург',
];

assert.strictEqual(VKUSVILL_SEARCH_PREFIX, 'https://vkusvill.ru/search/?q=');
assert.ok(VKUSVILL_DEEPLINK.enabled);
assert.ok(VKUSVILL_DEEPLINK.admitadBase.includes('kdbov.com'));
assert.ok(!/vkusvill\.ru/i.test(VKUSVILL_DEEPLINK.admitadBase));
assert.strictEqual(VKUSVILL_DEEPLINK.erid, '2bL9aMPo2e49hMef4phUrdrQCx');
assert.strictEqual(VKUSVILL_DEEPLINK.promoCode, null);
assert.strictEqual(VKUSVILL_DEEPLINK.geoMode, 'nationwide');
assert.deepStrictEqual(VKUSVILL_GEO.slice().sort(), OWNER_VKUSVILL_GEO.slice().sort());
assert.deepStrictEqual(VKUSVILL_DEEPLINK.cities.slice().sort(), OWNER_VKUSVILL_GEO.slice().sort());
assert.ok(VKUSVILL_DEEPLINK.cities.includes('Москва'));
assert.ok(VKUSVILL_DEEPLINK.cities.includes('Санкт-Петербург'));
assert.ok(VKUSVILL_DEEPLINK.cities.includes('Московская область'));
assert.ok(VKUSVILL_DEEPLINK.cities.includes('Ленинградская область'));

const partners = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'partners.json'), 'utf8')
);
const vvRow = partners.find((p) => p && p.id === 'vkusvill');
assert.ok(vvRow, 'partners.json vkusvill');
assert.strictEqual(vvRow.geo_mode, 'nationwide');
assert.deepStrictEqual((vvRow.geo || []).slice().sort(), OWNER_VKUSVILL_GEO.slice().sort());

const stripped = normalizeAdmitadBase(
  'https://kdbov.com/g/2xtzn37pfe268e100ca0b80ad6f8ae/?erid=2bL9aMPo2e49hMef4phUrdrQCx&ulp=https%3A%2F%2Fold'
);
assert.ok(!/ulp=/i.test(stripped));
assert.ok(/erid=2bL9aMPo2e49hMef4phUrdrQCx/.test(stripped));

const url = buildVkusvillAdmitadUrl('авокадо');
assert.ok(url);
assert.ok(url.startsWith('https://kdbov.com/'));
assert.ok(url.includes('erid=2bL9aMPo2e49hMef4phUrdrQCx'));
assert.ok(url.includes('ulp='));

const ulp = new URL(url).searchParams.get('ulp');
assert.ok(ulp);
assert.strictEqual(
  ulp,
  `https://vkusvill.ru/search/?q=${encodeURIComponent('авокадо')}`
);

// Email landing must never become Admitad base.
const poisoned = resolveVkusvillDeeplinkConfig([
  {
    id: 'vkusvill',
    admitad_base:
      'https://vkusvill.ru/?utm_medium=677297&utm_source=partners&promo_code=VSC7247',
    link: 'https://vkusvill.ru/?utm_campaign=16031',
    erid: '2bL9aMPo2e49hMef4phUrdrQCx',
    promo_code: 'VSC7247',
  },
]);
assert.ok(poisoned.admitadBase.includes('kdbov.com'));
assert.ok(!/vkusvill\.ru/i.test(poisoned.admitadBase));

console.log('verify-vkusvill-deeplink: ok');
console.log(' sample:', url);
