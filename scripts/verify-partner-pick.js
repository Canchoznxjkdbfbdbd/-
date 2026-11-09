#!/usr/bin/env node
'use strict';

/**
 * Soft partner flow: clarify-first, 0–1 offer only on clear intent,
 * geo_mode/cities whitelist, UI card owns URL (context has no link).
 */
const assert = require('assert');
const {
  pickPartner,
  partnerTagScore,
  partnerDeniedByGeo,
  partnerAllowedByGeo,
  detectCity,
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

// Clear no-time, city unknown → nationwide only (yandex-eda / magnit / dodo…), not city-only grocery.
{
  const id = idOf(turns('привет', 'нет времени готовить'));
  assert.ok(id, 'expected nationwide default when city unknown');
  assert.ok(WIDE_DEFAULT_IDS.includes(id) || id === 'magnit' || id === 'dodo-pizza', `got ${id}`);
  assert.notStrictEqual(id, 'perekrestok');
  assert.notStrictEqual(id, 'yandex-lavka'); // cities mode, city unknown → skip
  assert.notStrictEqual(id, 'foodband');
}

// Brand wins when geo allows (nationwide brand, city unknown).
assert.strictEqual(idOf(turns('привет', 'хочу пиццу додо')), 'dodo-pizza');

// Brand city-only without city → skip that brand (null or other geo-ok).
{
  const id = idOf(turns('привет', 'заказать яндекс лавку'));
  assert.notStrictEqual(id, 'yandex-lavka');
}

// Water brand is cities (msk/spb) — without city skip hvalovskie.
{
  const id = idOf(turns('привет', 'нужна питьевая вода'));
  assert.notStrictEqual(id, 'hvalovskie-vody');
}
assert.strictEqual(idOf(turns('я в Москве', 'нужна питьевая вода')), 'hvalovskie-vody');

// Yobi brand with city in whitelist.
assert.strictEqual(idOf(turns('я в Хабаровске', 'суши ёбидоёби на ужин')), 'yobidoyobi');

// Geo: Комсомольск must not pick perekrestok; nationwide fallback ok.
{
  const id = idOf(turns('я в Комсомольске-на-Амуре', 'нет времени, хочу заказать готовое'));
  assert.ok(id);
  assert.notStrictEqual(id, 'perekrestok');
  assert.notStrictEqual(id, 'yandex-lavka');
  assert.notStrictEqual(id, 'foodband');
  // yandex-eda / dodo / magnit / yobidoyobi (city listed) are ok
  assert.ok(
    ['yandex-eda', 'dodo-pizza', 'magnit', 'yobidoyobi'].includes(id),
    `expected nationwide or yobi after komsomolsk, got ${id}`
  );
}

// Perekrestok only when city in whitelist.
assert.strictEqual(idOf(turns('я в Казани', 'хочу перекрёсток продукты')), 'perekrestok');
assert.notStrictEqual(idOf(turns('я в Комсомольске', 'хочу перекрёсток продукты')), 'perekrestok');

// Lavka in listed city.
assert.strictEqual(idOf(turns('живу в Новосибирске', 'заказать яндекс лавку')), 'yandex-lavka');

// Foodband only Moscow area.
assert.strictEqual(idOf(turns('я в Москве', 'заказать пиццу foodband готовое')), 'foodband');
assert.notStrictEqual(idOf(turns('я в Екатеринбурге', 'пицца foodband')), 'foodband');

// Detect city helpers.
assert.strictEqual(detectCity('живу в спб'), 'санкт-петербург');
assert.strictEqual(detectCity('комсомольск-на-амуре доставка'), 'комсомольск-на-амуре');
assert.strictEqual(
  partnerAllowedByGeo({ geo_mode: 'cities', cities: ['москва'] }, 'москва'),
  true
);
assert.strictEqual(
  partnerAllowedByGeo({ geo_mode: 'cities', cities: ['москва'] }, null),
  false
);
assert.strictEqual(
  partnerAllowedByGeo({ geo_mode: 'nationwide', cities: [] }, null),
  true
);

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
