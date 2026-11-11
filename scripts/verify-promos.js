/**
 * Smoke: multi-promo normalize + expiry filter + no dates in terms.
 * Run: node scripts/verify-promos.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  partnerPayload,
  normalizePartnerPromos,
  isPromoExpired,
  stripPromoExpiryPhrase,
} = require('../server.js');

const partners = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'partners.json'), 'utf8')
);

assert.strictEqual(stripPromoExpiryPhrase('Скидка 25% на заказ, до 30.11.2026'), 'Скидка 25% на заказ');
assert.strictEqual(isPromoExpired('2000-01-01'), true);
assert.strictEqual(isPromoExpired('2099-12-31'), false);

const perek = partners.find((p) => p.id === 'perekrestok');
const payload = partnerPayload(perek);
assert.ok(payload);
assert.strictEqual(payload.promo_code, '196WA72QR');
assert.ok(!/до\s+\d/i.test(payload.promo_terms || ''));
assert.ok(payload.promos.length >= 2);
assert.ok(payload.promos.every((p) => p.code && !/до\s+\d/i.test(p.terms || '')));

const magnit = partners.find((p) => p.id === 'magnit');
const mPromos = normalizePartnerPromos(magnit);
assert.ok(!mPromos.some((p) => p.code === 'Ноябрь'), 'expired Ноябрь must be filtered');

const legacy = partnerPayload({
  id: 'legacy',
  name: 'Legacy',
  live: true,
  link: 'https://example.org/x',
  promo_code: 'ABC',
  promo_terms: 'Скидка 10%, до 01.01.2099',
});
assert.strictEqual(legacy.promo_code, 'ABC');
assert.strictEqual(legacy.promos.length, 1);
assert.strictEqual(legacy.promos[0].terms, 'Скидка 10%');

console.log('verify-promos: ok');
