'use strict';

/**
 * Offline checks for ProstoEda [[prostoeda:…]] / [[prosto:…]] → Admitad ulp deeplink.
 * Run: node scripts/verify-prostoeda-deeplink.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildProstoedaAdmitadUrl,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveProstoedaDeeplinkConfig,
  parseBotProductTag,
  PROSTOEDA_LANDING_URL,
  PROSTOEDA_SEARCH_PREFIX,
  PROSTOEDA_DEEPLINK,
  PROSTOEDA_GEO_CITIES,
} = require('../server');

assert.strictEqual(PROSTOEDA_LANDING_URL, 'https://prostoeda.pro/#delivery-section');
assert.strictEqual(PROSTOEDA_SEARCH_PREFIX, PROSTOEDA_LANDING_URL);
assert.ok(PROSTOEDA_DEEPLINK.enabled);
assert.ok(PROSTOEDA_DEEPLINK.admitadBase.includes('uhtkc.com'));
assert.ok(!/prostoeda\.pro/i.test(PROSTOEDA_DEEPLINK.admitadBase));
assert.strictEqual(PROSTOEDA_DEEPLINK.erid, '2bL9aMPo2e49hMef4phUdhhLCE');
assert.deepStrictEqual(PROSTOEDA_DEEPLINK.tagPrefixes, ['prostoeda', 'prosto']);
assert.deepStrictEqual(PROSTOEDA_GEO_CITIES, ['Москва']);
assert.deepStrictEqual(PROSTOEDA_DEEPLINK.cities, ['Москва']);
assert.ok(!PROSTOEDA_DEEPLINK.cities.includes('Санкт-Петербург'));

const partners = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'partners.json'), 'utf8')
);
const peRow = partners.find((p) => p && p.id === 'prostoeda');
assert.ok(peRow, 'partners.json prostoeda');
assert.strictEqual(peRow.geo_mode, 'cities');
assert.deepStrictEqual(peRow.geo, ['Москва']);
assert.ok(/Джаст Фуд/.test(String(PROSTOEDA_DEEPLINK.legalName || '')));
assert.strictEqual(PROSTOEDA_DEEPLINK.inn, '7719465858');

assert.ok(
  looksLikeAdmitadWebmaster(
    'https://uhtkc.com/g/waw3987n9y268e100ca0137f45f8b8/?erid=2bL9aMPo2e49hMef4phUdhhLCE'
  )
);
assert.ok(!looksLikeAdmitadWebmaster('https://prostoeda.pro/#delivery-section'));

const stripped = normalizeAdmitadBase(
  'https://uhtkc.com/g/waw3987n9y268e100ca0137f45f8b8/?erid=2bL9aMPo2e49hMef4phUdhhLCE&ulp=https%3A%2F%2Fold'
);
assert.ok(!/ulp=/i.test(stripped));
assert.ok(/erid=2bL9aMPo2e49hMef4phUdhhLCE/.test(stripped));

const url = buildProstoedaAdmitadUrl('неделя');
assert.ok(url);
assert.ok(url.startsWith('https://uhtkc.com/'));
assert.ok(url.includes('erid=2bL9aMPo2e49hMef4phUdhhLCE'));
const ulp = new URL(url).searchParams.get('ulp');
assert.strictEqual(ulp, 'https://prostoeda.pro/#delivery-section');

assert.strictEqual(parseBotProductTag('prostoeda:рацион').store, 'prostoeda');
assert.strictEqual(parseBotProductTag('prosto:месяц').store, 'prostoeda');

const keep = partners.map((p) => p.id).sort();
assert.deepStrictEqual(keep, [
  'auchan',
  'befit',
  'growfood',
  'hvalwaters',
  'prostoeda',
  'vazhnaya-ryba',
  'vkusvill',
]);

console.log('verify-prostoeda-deeplink: ok');
