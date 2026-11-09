#!/usr/bin/env node
'use strict';

/**
 * City partner pool → Gemini: no offers without city; full geo-filtered pool
 * injected; model chooses 0–1 via [[partner:id]] (UI card + promo plank).
 */
const assert = require('assert');
const {
  pickPartner,
  collectPartnerPool,
  resolveSelectedPartner,
  stripPartnerMark,
  partnerTagScore,
  partnerDeniedByGeo,
  partnerAllowedByGeo,
  detectCity,
  buildSystemInstruction,
  CLEAR_INTENT_RE,
} = require('../server');

function turns(...texts) {
  return texts.map((content) => ({ role: 'user', content }));
}

function poolIds(messages) {
  return collectPartnerPool(messages, { allowPartner: true }).map((p) => p.id).sort();
}

function idOf(messages) {
  const p = pickPartner(messages, { allowPartner: true });
  return p ? p.id : null;
}

// First turn never.
assert.deepStrictEqual(poolIds(turns('нет времени готовить')), []);
assert.strictEqual(idOf(turns('нет времени готовить')), null);

// Vague hunger — no pool even on turn 2 without city.
assert.deepStrictEqual(poolIds(turns('привет', 'хочу покушать')), []);
assert.strictEqual(idOf(turns('привет', 'хочу покушать')), null);

// Clear intent but city unknown → empty pool (soft city ask; no nationwide push).
assert.deepStrictEqual(poolIds(turns('привет', 'нет времени готовить')), []);
assert.strictEqual(idOf(turns('привет', 'хочу пиццу додо')), null);

// Smoke: Комсомольск → pool has dodo, yandex-eda, magnit, yobidoyobi; no perekrestok.
{
  const ids = poolIds(turns('я в Комсомольске-на-Амуре', 'что заказать'));
  assert.ok(ids.includes('dodo-pizza'), `expected dodo, got ${ids}`);
  assert.ok(ids.includes('yandex-eda'), `expected yandex-eda, got ${ids}`);
  assert.ok(ids.includes('magnit'), `expected magnit, got ${ids}`);
  assert.ok(ids.includes('yobidoyobi'), `expected yobidoyobi, got ${ids}`);
  assert.ok(!ids.includes('perekrestok'), 'perekrestok must stay out of Komsomolsk pool');
  assert.ok(!ids.includes('yandex-lavka'), 'lavka not in Komsomolsk');
  assert.ok(!ids.includes('foodband'), 'foodband not in Komsomolsk');
}

// Heuristic pick inside city pool: pizza → dodo.
assert.strictEqual(idOf(turns('я в Комсомольске', 'хочу пиццу')), 'dodo-pizza');
assert.strictEqual(idOf(turns('я в Хабаровске', 'суши ёбидоёби на ужин')), 'yobidoyobi');

// Water brand cities-only: Moscow ok, Komsomolsk skip hvalovskie.
assert.strictEqual(idOf(turns('я в Москве', 'нужна питьевая вода')), 'hvalovskie-vody');
{
  const ids = poolIds(turns('я в Комсомольске', 'нужна питьевая вода'));
  assert.ok(!ids.includes('hvalovskie-vody'));
}

// Perekrestok only when city in whitelist.
{
  const kazan = poolIds(turns('я в Казани', 'хочу продукты'));
  assert.ok(kazan.includes('perekrestok'));
  const koms = poolIds(turns('я в Комсомольске', 'хочу продукты'));
  assert.ok(!koms.includes('perekrestok'));
}

// Lavka / Foodband geo lists intact.
assert.ok(poolIds(turns('живу в Новосибирске', 'доставка')).includes('yandex-lavka'));
assert.ok(poolIds(turns('я в Москве', 'пицца')).includes('foodband'));
assert.ok(!poolIds(turns('я в Екатеринбурге', 'пицца')).includes('foodband'));

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

assert.strictEqual(CLEAR_INTENT_RE.test('хочу покушать'), false);
assert.ok(CLEAR_INTENT_RE.test('нет времени готовить'));

// System context: full city pool with links/promo; empty without city.
{
  const pool = collectPartnerPool(turns('я в Комсомольске', 'пицца'), { allowPartner: true });
  const sys = buildSystemInstruction(null, pool, turns('я в Комсомольске', 'пицца'));
  assert.ok(/Пул доступных live-партнёров/i.test(sys));
  assert.ok(sys.includes('dodo-pizza'));
  assert.ok(sys.includes('yandex-eda'));
  assert.ok(sys.includes('magnit'));
  assert.ok(sys.includes('yobidoyobi'));
  assert.ok(!sys.includes('perekrestok') || !/id: perekrestok/.test(sys));
  const dodo = pool.find((p) => p.id === 'dodo-pizza');
  assert.ok(dodo?.link);
  assert.ok(sys.includes(dodo.link), 'pool must expose real link to the model');
  if (dodo.promo_code) assert.ok(sys.includes(dodo.promo_code));
  assert.ok(/\[\[partner:ID\]\]/i.test(sys) || /\[\[partner:id\]\]/i.test(sys));
}

{
  const sys = buildSystemInstruction(null, [], turns('привет', 'нет времени'));
  assert.ok(/пуст/i.test(sys));
  assert.ok(/город/i.test(sys));
}

// Resolve selection: mark wins, then URL, then brand.
{
  const pool = collectPartnerPool(turns('я в Комсомольске', 'еда'), { allowPartner: true });
  assert.strictEqual(
    resolveSelectedPartner('Бери Додо. [[partner:dodo-pizza]]', pool)?.id,
    'dodo-pizza'
  );
  const dodo = pool.find((p) => p.id === 'dodo-pizza');
  assert.strictEqual(
    resolveSelectedPartner(`Ссылка: ${dodo.link}`, pool)?.id,
    'dodo-pizza'
  );
  assert.strictEqual(
    resolveSelectedPartner('На ужин отличная пицца от Додо Пицца.', pool)?.id,
    'dodo-pizza'
  );
  assert.ok(!/\[\[partner/.test(stripPartnerMark('ok [[partner:magnit]]')));
  assert.ok(stripPartnerMark('Текст [[partner:dodo-pizza]]').includes('Текст'));
}

console.log('verify-partner-pick: ok');
