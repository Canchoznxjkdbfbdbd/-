#!/usr/bin/env node
'use strict';

/**
 * Soft partner flow: clarify-first, 0–1 offer only on clear intent,
 * geo_deny skips limited chains, UI card owns URL (context has no link).
 */
const assert = require('assert');
const {
  pickPartner,
  partnerTagScore,
  partnerDeniedByGeo,
  buildSystemInstruction,
  CLEAR_INTENT_RE,
  WIDE_DEFAULT_IDS,
} = require('../server');

function turns(...texts) {
  return texts.map((content) => ({ role: 'user', content }));
}

function idOf(messages) {
  const p = pickPartner(messages, { allowPartner: true });
  return p ? p.id : null;
}

// First turn never.
assert.strictEqual(idOf(turns('нет времени готовить')), null);

// Vague hunger — no partner even on turn 2.
assert.strictEqual(idOf(turns('привет', 'хочу покушать')), null);
assert.strictEqual(idOf(turns('что поесть', 'просто про еду')), null);

// Clear no-time → wide default, not perekrestok.
{
  const id = idOf(turns('привет', 'нет времени готовить'));
  assert.ok(id, 'expected wide default');
  assert.ok(WIDE_DEFAULT_IDS.includes(id), `expected wide id, got ${id}`);
  assert.notStrictEqual(id, 'perekrestok');
}

// Brand wins.
assert.strictEqual(idOf(turns('привет', 'хочу пиццу додо')), 'dodo-pizza');
assert.strictEqual(idOf(turns('привет', 'заказать яндекс лавку')), 'yandex-lavka'); // лавку→лавка stem
assert.strictEqual(idOf(turns('привет', 'нужна питьевая вода')), 'hvalovskie-vody');
assert.strictEqual(idOf(turns('привет', 'суши ёбидоёби на ужин')), 'yobidoyobi');

// Geo deny: Комсомольск must not pick perekrestok.
{
  const id = idOf(turns('я в Комсомольске-на-Амуре', 'нет времени, хочу заказать готовое'));
  assert.ok(id);
  assert.notStrictEqual(id, 'perekrestok');
  assert.ok(WIDE_DEFAULT_IDS.includes(id), `expected wide after geo deny, got ${id}`);
}

assert.strictEqual(
  partnerDeniedByGeo(
    { geo_deny: ['комсомольск'] },
    'живу в комсомольске-на-амуре'
  ),
  true
);

// Brand score shape.
{
  const s = partnerTagScore({ tags: ['додо', 'готовое'] }, 'пицца додо и готовое на ужин');
  assert.ok(s.brand >= 3);
  assert.ok(s.generic >= 1);
}

// CLEAR_INTENT does not fire on bare «покушать».
assert.strictEqual(CLEAR_INTENT_RE.test('хочу покушать'), false);
assert.ok(CLEAR_INTENT_RE.test('нет времени готовить'));

// Dedup path: system context must not embed raw partner URL/promo when offer present.
{
  const partner = {
    id: 'dodo-pizza',
    name: 'Додо Пицца',
    blurb: 'Пицца',
    link: 'https://dodo1.prfl.me/sites/0bw42g?erid=test',
    promo_code: 'A563Z',
    offer_type: 'promo',
    disclaimer: 'Реклама',
    live: true,
  };
  const sys = buildSystemInstruction(null, partner, turns('x', 'y'));
  assert.ok(/Контекст партнёрского оффера/i.test(sys));
  assert.ok(/не печатай сырой URL/i.test(sys));
  assert.ok(!sys.includes(partner.link), 'model context must not contain partner URL');
  assert.ok(!sys.includes('A563Z'), 'model context must not contain promo code');
}

console.log('verify-partner-pick: ok');
