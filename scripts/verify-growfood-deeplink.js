'use strict';

/**
 * Offline checks for GrowFood [[growfood:…]] / [[gf:…]] → Admitad ulp deeplink.
 * Run: node scripts/verify-growfood-deeplink.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildGrowfoodAdmitadUrl,
  buildBefitAdmitadUrl,
  buildHvalwatersAdmitadUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveGrowfoodDeeplinkConfig,
  resolveGrowfoodTargetUrl,
  resolveGrowfoodProgramSlug,
  resolveBefitDeeplinkConfig,
  resolveHvalwatersDeeplinkConfig,
  resolveVkusvillDeeplinkConfig,
  resolveVipfishDeeplinkConfig,
  GROWFOOD_SEARCH_PREFIX,
  GROWFOOD_CATALOG_URL,
  GROWFOOD_PROGRAM_PREFIX,
  GROWFOOD_DEEPLINK,
  GROWFOOD_GEO_CITIES,
  BEFIT_DEEPLINK,
  HVALWATERS_DEEPLINK,
  VKUSVILL_DEEPLINK,
  VIPFISH_DEEPLINK,
} = require('../server');

const OWNER_GROWFOOD_GEO = ['Москва', 'Санкт-Петербург'];

assert.strictEqual(GROWFOOD_SEARCH_PREFIX, 'https://growfood.pro/new-order/');
assert.strictEqual(GROWFOOD_CATALOG_URL, 'https://growfood.pro/new-order/');
assert.strictEqual(GROWFOOD_PROGRAM_PREFIX, 'https://growfood.pro/new-order/');
assert.ok(GROWFOOD_DEEPLINK.enabled);
assert.ok(GROWFOOD_DEEPLINK.admitadBase.includes('naiawork.com'));
assert.ok(!/growfood\.pro/i.test(GROWFOOD_DEEPLINK.admitadBase));
assert.ok(!/gf\.ru/i.test(GROWFOOD_DEEPLINK.admitadBase));
assert.strictEqual(GROWFOOD_DEEPLINK.erid, 'MvGzQC98w3Z1gMq1kxQwfCfT');
assert.ok(GROWFOOD_DEEPLINK.tagPrefixes.includes('growfood'));
assert.ok(GROWFOOD_DEEPLINK.tagPrefixes.includes('gf'));
assert.ok(GROWFOOD_DEEPLINK.cities.includes('Москва'));
assert.ok(GROWFOOD_DEEPLINK.cities.includes('Санкт-Петербург'));
assert.deepStrictEqual(GROWFOOD_GEO_CITIES.slice().sort(), OWNER_GROWFOOD_GEO.slice().sort());
assert.deepStrictEqual(GROWFOOD_DEEPLINK.cities.slice().sort(), OWNER_GROWFOOD_GEO.slice().sort());
assert.strictEqual(GROWFOOD_GEO_CITIES.length, 2);

const partners = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'partners.json'), 'utf8')
);
const gfRow = partners.find((p) => p && p.id === 'growfood');
assert.ok(gfRow, 'partners.json growfood');
assert.deepStrictEqual((gfRow.geo || []).slice().sort(), OWNER_GROWFOOD_GEO.slice().sort());
assert.ok(/ГФ Трейд/.test(String(GROWFOOD_DEEPLINK.legalName || GROWFOOD_DEEPLINK.disclaimer || '')));
assert.strictEqual(GROWFOOD_DEEPLINK.inn, '7811715411');
assert.strictEqual(GROWFOOD_DEEPLINK.promoCode, null);
assert.ok(Array.isArray(GROWFOOD_DEEPLINK.promos));
assert.strictEqual(GROWFOOD_DEEPLINK.promos.length, 0);

const stripped = normalizeAdmitadBase(
  'https://naiawork.com/g/36wusytszy268e100ca0aeb982cd0a/?erid=MvGzQC98w3Z1gMq1kxQwfCfT&ulp=https%3A%2F%2Fold'
);
assert.ok(!/ulp=/i.test(stripped));
assert.ok(/erid=MvGzQC98w3Z1gMq1kxQwfCfT/.test(stripped));

assert.ok(
  looksLikeAdmitadWebmaster(
    'https://naiawork.com/g/36wusytszy268e100ca0aeb982cd0a/?erid=MvGzQC98w3Z1gMq1kxQwfCfT'
  )
);
assert.ok(!looksLikeAdmitadWebmaster('https://growfood.pro/new-order/super-fit'));
assert.ok(!looksLikeAdmitadWebmaster('https://growfood.pro/new-order/'));
assert.ok(!looksLikeAdmitadWebmaster('https://gf.ru/'));

assert.strictEqual(resolveGrowfoodProgramSlug('super-fit'), 'super-fit');
assert.strictEqual(resolveGrowfoodProgramSlug('SuperFit'), 'super-fit');
assert.strictEqual(resolveGrowfoodProgramSlug('суперфит'), 'super-fit');
assert.strictEqual(resolveGrowfoodProgramSlug('похудение'), 'super-fit');
assert.strictEqual(resolveGrowfoodProgramSlug('daily'), 'daily');
assert.strictEqual(resolveGrowfoodProgramSlug('баланс'), 'balance');
assert.strictEqual(resolveGrowfoodProgramSlug('масса'), 'power');
assert.strictEqual(resolveGrowfoodProgramSlug('неизвестная-каша'), null);

assert.strictEqual(
  resolveGrowfoodTargetUrl('super-fit'),
  'https://growfood.pro/new-order/super-fit'
);
assert.strictEqual(
  resolveGrowfoodTargetUrl('похудение'),
  'https://growfood.pro/new-order/super-fit'
);
assert.strictEqual(
  resolveGrowfoodTargetUrl('протеиновый завтрак'),
  'https://growfood.pro/new-order/'
);

const url = buildGrowfoodAdmitadUrl('super-fit');
assert.ok(url);
assert.ok(url.startsWith('https://naiawork.com/'));
assert.ok(url.includes('erid=MvGzQC98w3Z1gMq1kxQwfCfT'));
assert.ok(url.includes('ulp='));
const ulp = new URL(url).searchParams.get('ulp');
assert.strictEqual(ulp, 'https://growfood.pro/new-order/super-fit');

const catalogUrl = buildGrowfoodAdmitadUrl('неизвестная линейка');
const catalogUlp = new URL(catalogUrl).searchParams.get('ulp');
assert.strictEqual(catalogUlp, 'https://growfood.pro/new-order/');

// Merchant landing must never become Admitad base.
const poisoned = resolveGrowfoodDeeplinkConfig([
  {
    id: 'growfood',
    admitad_base: 'https://growfood.pro/new-order/super-fit',
    link: 'https://growfood.pro/?utm_source=x',
    erid: 'MvGzQC98w3Z1gMq1kxQwfCfT',
    legal_name: 'ООО «ГФ Трейд»',
    inn: '7811715411',
    geo: ['Москва'],
    promo_code: 'БИГБОНУС',
    promos: [{ code: 'БИГБОНУС', discount: 'до 2000 ₽', when: 'вернувшиеся' }],
  },
]);
assert.ok(poisoned.admitadBase.includes('naiawork.com'));
assert.ok(!/growfood\.pro/i.test(poisoned.admitadBase));
assert.deepStrictEqual(poisoned.cities, ['Москва']);
assert.strictEqual(poisoned.promoCode, 'БИГБОНУС');
assert.strictEqual(poisoned.promos.length, 1);

// VV + vipfish + BeFit + Hvalwaters still intact.
assert.ok(VKUSVILL_DEEPLINK.enabled);
assert.ok(VKUSVILL_DEEPLINK.admitadBase.includes('kdbov.com'));
assert.ok(VIPFISH_DEEPLINK.enabled);
assert.ok(VIPFISH_DEEPLINK.admitadBase.includes('dorinebeaumont.com'));
assert.ok(BEFIT_DEEPLINK.enabled);
assert.ok(BEFIT_DEEPLINK.admitadBase.includes('uuwgc.com'));
assert.ok(HVALWATERS_DEEPLINK.enabled);
assert.ok(HVALWATERS_DEEPLINK.admitadBase.includes('xmknb.com'));
const vv = buildVkusvillAdmitadUrl('авокадо');
assert.ok(vv && new URL(vv).searchParams.get('ulp').includes('vkusvill.ru/search'));
const fish = buildVipfishAdmitadUrl('лосось');
assert.ok(fish && new URL(fish).searchParams.get('ulp').includes('vipfish.ru/search'));
const bf = buildBefitAdmitadUrl('keto-start');
assert.ok(bf && new URL(bf).searchParams.get('ulp').includes('letbefit.ru/programmy'));
const hv = buildHvalwatersAdmitadUrl('premium');
assert.ok(hv && new URL(hv).searchParams.get('ulp').includes('hvalwaters.ru/water'));
const vvPoison = resolveVkusvillDeeplinkConfig([
  {
    id: 'vkusvill',
    admitad_base: 'https://vkusvill.ru/?promo_code=VSC7247',
    link: 'https://vkusvill.ru/',
    erid: '2bL9aMPo2e49hMef4phUrdrQCx',
  },
]);
assert.ok(vvPoison.admitadBase.includes('kdbov.com'));
const fishPoison = resolveVipfishDeeplinkConfig([
  {
    id: 'vazhnaya-ryba',
    admitad_base: 'https://vipfish.ru/',
    link: 'https://vipfish.ru/',
    erid: '2bL9aMPo2e49hMef4peVndVUPr',
  },
]);
assert.ok(fishPoison.admitadBase.includes('dorinebeaumont.com'));
const bfPoison = resolveBefitDeeplinkConfig([
  {
    id: 'befit',
    admitad_base: 'https://letbefit.ru/programmy/keto-start/',
    link: 'https://letbefit.ru/',
    erid: '25H8d7vbP8SRTvJZjHsUpp',
  },
]);
assert.ok(bfPoison.admitadBase.includes('uuwgc.com'));
const hvPoison = resolveHvalwatersDeeplinkConfig([
  {
    id: 'hvalwaters',
    admitad_base: 'https://hvalwaters.ru/water/premium/',
    link: 'https://hvalwaters.ru/',
    erid: '2bL9aMPo2e49hMef4pfVDKbKSL',
  },
]);
assert.ok(hvPoison.admitadBase.includes('xmknb.com'));

console.log('verify-growfood-deeplink: ok');
console.log(' sample program:', url);
console.log(' sample catalog:', catalogUrl);
