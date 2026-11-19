'use strict';

/**
 * Offline checks for BeFit [[befit:…]] / [[letbefit:…]] → Admitad ulp deeplink.
 * Run: node scripts/verify-befit-deeplink.js
 */

const assert = require('assert');
const {
  buildBefitAdmitadUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveBefitDeeplinkConfig,
  resolveBefitTargetUrl,
  resolveBefitProgramSlug,
  resolveVkusvillDeeplinkConfig,
  resolveVipfishDeeplinkConfig,
  BEFIT_SEARCH_PREFIX,
  BEFIT_PROGRAM_PREFIX,
  BEFIT_DEEPLINK,
  BEFIT_GEO_CITIES,
  VKUSVILL_DEEPLINK,
  VIPFISH_DEEPLINK,
} = require('../server');

assert.strictEqual(BEFIT_SEARCH_PREFIX, 'https://letbefit.ru/?s=');
assert.strictEqual(BEFIT_PROGRAM_PREFIX, 'https://letbefit.ru/programmy/');
assert.ok(BEFIT_DEEPLINK.enabled);
assert.ok(BEFIT_DEEPLINK.admitadBase.includes('uuwgc.com'));
assert.ok(!/letbefit\.ru/i.test(BEFIT_DEEPLINK.admitadBase));
assert.strictEqual(BEFIT_DEEPLINK.erid, '25H8d7vbP8SRTvJZjHsUpp');
assert.ok(BEFIT_DEEPLINK.tagPrefixes.includes('befit'));
assert.ok(BEFIT_DEEPLINK.tagPrefixes.includes('letbefit'));
assert.ok(BEFIT_DEEPLINK.cities.includes('Москва'));
assert.ok(BEFIT_DEEPLINK.cities.includes('Санкт-Петербург'));
assert.deepStrictEqual(BEFIT_GEO_CITIES.slice().sort(), ['Москва', 'Санкт-Петербург'].sort());
assert.ok(/АЛ-МУЛК/.test(String(BEFIT_DEEPLINK.legalName || BEFIT_DEEPLINK.disclaimer || '')));
assert.strictEqual(BEFIT_DEEPLINK.inn, '7713441603');
assert.strictEqual(BEFIT_DEEPLINK.promoCode, 'ADMBF2026');
assert.ok(Array.isArray(BEFIT_DEEPLINK.promos));
assert.ok(BEFIT_DEEPLINK.promos.length >= 6);
assert.ok(BEFIT_DEEPLINK.promos.some((p) => p && p.code === 'KETOADM'));
assert.ok(BEFIT_DEEPLINK.promos.some((p) => p && p.code === null));

const stripped = normalizeAdmitadBase(
  'https://uuwgc.com/g/qm29jzxwek268e100ca0fcd3300043/?erid=25H8d7vbP8SRTvJZjHsUpp&ulp=https%3A%2F%2Fold'
);
assert.ok(!/ulp=/i.test(stripped));
assert.ok(/erid=25H8d7vbP8SRTvJZjHsUpp/.test(stripped));

assert.ok(
  looksLikeAdmitadWebmaster(
    'https://uuwgc.com/g/qm29jzxwek268e100ca0fcd3300043/?erid=25H8d7vbP8SRTvJZjHsUpp'
  )
);
assert.ok(!looksLikeAdmitadWebmaster('https://letbefit.ru/programmy/superstrongpremium/'));
assert.ok(!looksLikeAdmitadWebmaster('https://letbefit.ru/?s=keto'));

assert.strictEqual(resolveBefitProgramSlug('keto-start'), 'keto-start');
assert.strictEqual(resolveBefitProgramSlug('Keto Start'), 'keto-start');
assert.strictEqual(resolveBefitProgramSlug('кето'), 'keto-start');
assert.strictEqual(resolveBefitProgramSlug('Energy Max'), 'gotovoe-menyu-dlya-sportsmenov');
assert.strictEqual(resolveBefitProgramSlug('superstrongpremium'), 'superstrongpremium');
assert.strictEqual(resolveBefitProgramSlug('extralight'), 'extralight');
assert.strictEqual(resolveBefitProgramSlug('неизвестная-каша'), null);
// Owner dead-link ground truth: SEO hub → product program.
assert.strictEqual(resolveBefitProgramSlug('gotovoe-menyu-dlya-pohudeniya'), 'extralight');
assert.strictEqual(resolveBefitProgramSlug('похудение'), 'extralight');
assert.strictEqual(resolveBefitProgramSlug('nabor-myshechnoj-massy'), 'strong');
assert.strictEqual(resolveBefitProgramSlug('набор массы'), 'strong');
assert.ok(!BEFIT_DEEPLINK.programSlugs.includes('gotovoe-menyu-dlya-pohudeniya'));
assert.ok(BEFIT_DEEPLINK.programSlugs.includes('extralight'));

assert.strictEqual(
  resolveBefitTargetUrl('superstrongpremium'),
  'https://letbefit.ru/programmy/superstrongpremium/'
);
assert.strictEqual(
  resolveBefitTargetUrl('keto-start'),
  'https://letbefit.ru/programmy/keto-start/'
);
assert.strictEqual(
  resolveBefitTargetUrl('похудение'),
  'https://letbefit.ru/programmy/extralight/'
);
assert.strictEqual(
  resolveBefitTargetUrl('gotovoe-menyu-dlya-pohudeniya'),
  'https://letbefit.ru/programmy/extralight/'
);
assert.strictEqual(
  resolveBefitTargetUrl('кето рацион'),
  `https://letbefit.ru/?s=${encodeURIComponent('кето рацион')}`
);

const url = buildBefitAdmitadUrl('superstrongpremium');
assert.ok(url);
assert.ok(url.startsWith('https://uuwgc.com/'));
assert.ok(url.includes('erid=25H8d7vbP8SRTvJZjHsUpp'));
assert.ok(url.includes('ulp='));
const ulp = new URL(url).searchParams.get('ulp');
assert.strictEqual(ulp, 'https://letbefit.ru/programmy/superstrongpremium/');

// Before (owner dead): …ulp=…/programmy/gotovoe-menyu-dlya-pohudeniya/
// After: product Extralight.
const fixedHub = buildBefitAdmitadUrl('gotovoe-menyu-dlya-pohudeniya');
const fixedHubUlp = new URL(fixedHub).searchParams.get('ulp');
assert.strictEqual(fixedHubUlp, 'https://letbefit.ru/programmy/extralight/');
const fixedAlias = buildBefitAdmitadUrl('похудение');
assert.strictEqual(
  new URL(fixedAlias).searchParams.get('ulp'),
  'https://letbefit.ru/programmy/extralight/'
);

const searchUrl = buildBefitAdmitadUrl('протеиновый завтрак');
const searchUlp = new URL(searchUrl).searchParams.get('ulp');
assert.strictEqual(
  searchUlp,
  `https://letbefit.ru/?s=${encodeURIComponent('протеиновый завтрак')}`
);

// Merchant landing must never become Admitad base.
const poisoned = resolveBefitDeeplinkConfig([
  {
    id: 'befit',
    admitad_base: 'https://letbefit.ru/programmy/keto-start/',
    link: 'https://letbefit.ru/?utm_source=x',
    erid: '25H8d7vbP8SRTvJZjHsUpp',
    legal_name: 'ООО «АЛ-МУЛК»',
    inn: '7713441603',
    geo: ['Москва'],
    promo_code: 'ADM15',
    promos: [{ code: 'ADM15', discount: '−15%', when: 'общий' }],
  },
]);
assert.ok(poisoned.admitadBase.includes('uuwgc.com'));
assert.ok(!/letbefit\.ru/i.test(poisoned.admitadBase));
assert.deepStrictEqual(poisoned.cities, ['Москва']);
assert.strictEqual(poisoned.promoCode, 'ADM15');
assert.strictEqual(poisoned.promos.length, 1);

// VV + vipfish still intact.
assert.ok(VKUSVILL_DEEPLINK.enabled);
assert.ok(VKUSVILL_DEEPLINK.admitadBase.includes('kdbov.com'));
assert.ok(VIPFISH_DEEPLINK.enabled);
assert.ok(VIPFISH_DEEPLINK.admitadBase.includes('dorinebeaumont.com'));
const vv = buildVkusvillAdmitadUrl('авокадо');
assert.ok(vv && new URL(vv).searchParams.get('ulp').includes('vkusvill.ru/search'));
const fish = buildVipfishAdmitadUrl('лосось');
assert.ok(fish && new URL(fish).searchParams.get('ulp').includes('vipfish.ru/search'));
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

console.log('verify-befit-deeplink: ok');
console.log(' sample program:', url);
console.log(' sample search:', searchUrl);
