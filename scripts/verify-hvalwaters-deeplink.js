'use strict';

/**
 * Offline checks for Хваловская вода [[hval:…]] / [[water:…]] / [[hvalwaters:…]] → Admitad ulp.
 * Run: node scripts/verify-hvalwaters-deeplink.js
 */

const assert = require('assert');
const {
  buildHvalwatersAdmitadUrl,
  buildBefitAdmitadUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveHvalwatersDeeplinkConfig,
  resolveHvalwatersTargetUrl,
  resolveHvalwatersProductSlug,
  resolveBefitDeeplinkConfig,
  resolveVkusvillDeeplinkConfig,
  resolveVipfishDeeplinkConfig,
  HVALWATERS_SEARCH_PREFIX,
  HVALWATERS_PRODUCT_PREFIX,
  HVALWATERS_DEEPLINK,
  HVALWATERS_GEO_CITIES,
  BEFIT_DEEPLINK,
  VKUSVILL_DEEPLINK,
  VIPFISH_DEEPLINK,
} = require('../server');

assert.strictEqual(HVALWATERS_SEARCH_PREFIX, 'https://hvalwaters.ru/?s=');
assert.strictEqual(HVALWATERS_PRODUCT_PREFIX, 'https://hvalwaters.ru/water/');
assert.ok(HVALWATERS_DEEPLINK.enabled);
assert.ok(HVALWATERS_DEEPLINK.admitadBase.includes('xmknb.com'));
assert.ok(!/i=3/i.test(HVALWATERS_DEEPLINK.admitadBase));
assert.ok(!/hvalwaters\.ru/i.test(HVALWATERS_DEEPLINK.admitadBase));
assert.strictEqual(HVALWATERS_DEEPLINK.erid, '2bL9aMPo2e49hMef4pfVDKbKSL');
assert.ok(HVALWATERS_DEEPLINK.tagPrefixes.includes('hval'));
assert.ok(HVALWATERS_DEEPLINK.tagPrefixes.includes('water'));
assert.ok(HVALWATERS_DEEPLINK.tagPrefixes.includes('hvalwaters'));
assert.ok(HVALWATERS_DEEPLINK.cities.includes('Москва'));
assert.ok(HVALWATERS_DEEPLINK.cities.includes('Санкт-Петербург'));
assert.deepStrictEqual(
  HVALWATERS_GEO_CITIES.slice().sort(),
  ['Москва', 'Санкт-Петербург'].sort()
);
assert.ok(/АКВАСИТИ/.test(String(HVALWATERS_DEEPLINK.legalName || HVALWATERS_DEEPLINK.disclaimer || '')));
assert.strictEqual(HVALWATERS_DEEPLINK.inn, '7816714891');
assert.ok(HVALWATERS_DEEPLINK.couponAdmitadBase);
assert.ok(HVALWATERS_DEEPLINK.couponAdmitadBase.includes('xmknb.com'));

const stripped = normalizeAdmitadBase(
  'https://xmknb.com/g/b0173jl262268e100ca000dcac28d3/?erid=2bL9aMPo2e49hMef4pfVDKbKSL&ulp=https%3A%2F%2Fold'
);
assert.ok(!/ulp=/i.test(stripped));
assert.ok(/erid=2bL9aMPo2e49hMef4pfVDKbKSL/.test(stripped));

assert.ok(
  looksLikeAdmitadWebmaster(
    'https://xmknb.com/g/b0173jl262268e100ca000dcac28d3/?erid=2bL9aMPo2e49hMef4pfVDKbKSL'
  )
);
assert.ok(!looksLikeAdmitadWebmaster('https://hvalwaters.ru/water/premium/'));
assert.ok(!looksLikeAdmitadWebmaster('https://msc.hvalwaters.ru/water/premium/'));

assert.strictEqual(resolveHvalwatersProductSlug('premium'), 'premium');
assert.strictEqual(resolveHvalwatersProductSlug('Премиум'), 'premium');
assert.strictEqual(resolveHvalwatersProductSlug('19л'), 'premium');
assert.strictEqual(resolveHvalwatersProductSlug('горная'), 'gornaya');
assert.strictEqual(resolveHvalwatersProductSlug('delux'), 'deluxe');
assert.strictEqual(resolveHvalwatersProductSlug('кулер настольный'), null);

assert.strictEqual(
  resolveHvalwatersTargetUrl('premium'),
  'https://hvalwaters.ru/water/premium/'
);
assert.strictEqual(
  resolveHvalwatersTargetUrl('премиум'),
  'https://hvalwaters.ru/water/premium/'
);
assert.strictEqual(
  resolveHvalwatersTargetUrl('кулер'),
  `https://hvalwaters.ru/?s=${encodeURIComponent('кулер')}`
);

const url = buildHvalwatersAdmitadUrl('premium');
assert.ok(url);
assert.ok(url.startsWith('https://xmknb.com/'));
assert.ok(url.includes('erid=2bL9aMPo2e49hMef4pfVDKbKSL'));
assert.ok(!/i=3/i.test(url));
assert.ok(url.includes('ulp='));
const ulp = new URL(url).searchParams.get('ulp');
assert.strictEqual(ulp, 'https://hvalwaters.ru/water/premium/');

const searchUrl = buildHvalwatersAdmitadUrl('помпа');
const searchUlp = new URL(searchUrl).searchParams.get('ulp');
assert.strictEqual(searchUlp, `https://hvalwaters.ru/?s=${encodeURIComponent('помпа')}`);

// Merchant landing must never become Admitad base.
const poisoned = resolveHvalwatersDeeplinkConfig([
  {
    id: 'hvalwaters',
    admitad_base: 'https://hvalwaters.ru/water/premium/',
    link: 'https://msc.hvalwaters.ru/?utm_source=x',
    erid: '2bL9aMPo2e49hMef4pfVDKbKSL',
    legal_name: 'ООО «АКВАСИТИ»',
    inn: '7816714891',
    geo: ['Москва'],
  },
]);
assert.ok(poisoned.admitadBase.includes('xmknb.com'));
assert.ok(!/hvalwaters\.ru/i.test(poisoned.admitadBase));
assert.deepStrictEqual(poisoned.cities, ['Москва']);

// VV + vipfish + BeFit still intact.
assert.ok(VKUSVILL_DEEPLINK.enabled);
assert.ok(VKUSVILL_DEEPLINK.admitadBase.includes('kdbov.com'));
assert.ok(VIPFISH_DEEPLINK.enabled);
assert.ok(VIPFISH_DEEPLINK.admitadBase.includes('dorinebeaumont.com'));
assert.ok(BEFIT_DEEPLINK.enabled);
assert.ok(BEFIT_DEEPLINK.admitadBase.includes('uuwgc.com'));
const vv = buildVkusvillAdmitadUrl('авокадо');
assert.ok(vv && new URL(vv).searchParams.get('ulp').includes('vkusvill.ru/search'));
const fish = buildVipfishAdmitadUrl('лосось');
assert.ok(fish && new URL(fish).searchParams.get('ulp').includes('vipfish.ru/search'));
const bf = buildBefitAdmitadUrl('keto-start');
assert.ok(bf && new URL(bf).searchParams.get('ulp').includes('letbefit.ru/programmy'));
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

console.log('verify-hvalwaters-deeplink: ok');
console.log(' sample product:', url);
console.log(' sample search:', searchUrl);
