'use strict';

/**
 * Offline checks: Auchan first-order CTA (partners.json → config → bot links).
 * Separate Admitad link/erid from grocery search deeplink.
 * Run: node scripts/verify-auchan-first-order.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const partners = JSON.parse(fs.readFileSync(path.join(root, 'partners.json'), 'utf8'));
const auchan = partners.find((p) => p && p.id === 'auchan');
assert.ok(auchan, 'auchan row missing');
assert.ok(auchan.firstOrder && typeof auchan.firstOrder === 'object', 'firstOrder missing');
assert.strictEqual(
  auchan.firstOrder.link,
  'https://rthsu.com/g/30o5vsx0bi268e100ca0414eca7795/?i=3&erid=2bL9aMPo2e49hMef4rrUepvhzG'
);
assert.strictEqual(auchan.firstOrder.erid, '2bL9aMPo2e49hMef4rrUepvhzG');
assert.strictEqual(auchan.firstOrder.minOrderRub, 4000);
assert.ok(String(auchan.firstOrder.discountHint).includes('800'));
// Must not mix with search deeplink erid / base.
assert.notStrictEqual(auchan.firstOrder.erid, auchan.erid);
assert.ok(!String(auchan.firstOrder.link).includes('g1f8w0wsou'));
assert.ok(!String(auchan.admitad_base).includes('30o5vsx0bi'));
assert.strictEqual(auchan.promo_code, null);

const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
assert.ok(script.includes('syncAuchanFirstOrderCta'), 'web CTA sync missing');
assert.ok(script.includes('cart-block-first-order'), 'web plaque class missing');
assert.ok(script.includes('Забрать скидку на первый заказ'), 'CTA label missing');
assert.ok(script.includes('Если раньше не заказывали в Ашане'), 'hint fallback missing');
assert.ok(!/промокод|promo_code|VSC7247/i.test(
  script.slice(script.indexOf('syncAuchanFirstOrderCta'), script.indexOf('syncAuchanFirstOrderCta') + 1200)
), 'promo code must not appear in first-order CTA');
assert.ok(css.includes('.cart-block-first-order'), 'first-order CSS missing');
assert.ok(css.includes('.cart-block-first-order-btn'), 'first-order button CSS missing');

process.env.BOT_API_KEY = process.env.BOT_API_KEY || 'test-bot-key-fo';
if (!process.env.VERIFY_LIVE) {
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEY_2 = '';
}

const {
  AUCHAN_DEEPLINK,
  resolveAuchanFirstOrder,
  resolveAuchanDeeplinkConfig,
  expandPartnerChipsForBot,
  buildAuchanAdmitadUrl,
  app,
} = require('../server');

assert.ok(AUCHAN_DEEPLINK.firstOrder, 'AUCHAN_DEEPLINK.firstOrder missing');
assert.strictEqual(AUCHAN_DEEPLINK.firstOrder.erid, '2bL9aMPo2e49hMef4rrUepvhzG');
assert.notStrictEqual(AUCHAN_DEEPLINK.firstOrder.erid, AUCHAN_DEEPLINK.erid);
assert.match(AUCHAN_DEEPLINK.firstOrder.hint, /4\u202f000|4000|4 000/);
assert.match(AUCHAN_DEEPLINK.firstOrder.hint, /800/);
assert.doesNotMatch(AUCHAN_DEEPLINK.firstOrder.hint, /%/);
assert.doesNotMatch(AUCHAN_DEEPLINK.firstOrder.hint, /промокод/i);
assert.strictEqual(AUCHAN_DEEPLINK.firstOrder.cta, 'Забрать скидку на первый заказ');

const parsed = resolveAuchanFirstOrder(auchan);
assert.ok(parsed && parsed.link.includes('30o5vsx0bi'));
assert.strictEqual(parsed.erid, '2bL9aMPo2e49hMef4rrUepvhzG');

// Guard: never accept search erid as first-order erid.
const mixed = resolveAuchanFirstOrder({
  firstOrder: {
    link: auchan.firstOrder.link,
    erid: auchan.erid,
    minOrderRub: 4000,
    discountHint: 'больше 800 ₽',
  },
});
assert.strictEqual(mixed, null);

const searchUrl = buildAuchanAdmitadUrl('гречка');
assert.ok(searchUrl && searchUrl.includes('g1f8w0wsou'));
assert.ok(searchUrl.includes('erid=2bL9aMPo2e49hMef4rrTkXfiWn'));
assert.ok(!searchUrl.includes('30o5vsx0bi'));
assert.ok(!searchUrl.includes('2bL9aMPo2e49hMef4rrUepvhzG'));

{
  const { reply, links } = expandPartnerChipsForBot('Купи [[auchan:гречка]]');
  assert.ok(links.length >= 2, 'expect product + first-order links');
  const product = links.find((l) => l.store === 'auchan' && l.kind !== 'firstOrder');
  const fo = links.find((l) => l.kind === 'firstOrder');
  assert.ok(product && product.url === searchUrl);
  assert.ok(fo);
  assert.strictEqual(fo.url, AUCHAN_DEEPLINK.firstOrder.link);
  assert.strictEqual(fo.label, 'Забрать скидку на первый заказ');
  assert.match(reply, /Собрать корзину/);
  assert.match(reply, /2bL9aMPo2e49hMef4rrTkXfiWn/);
  assert.match(reply, /2bL9aMPo2e49hMef4rrUepvhzG/);
  assert.doesNotMatch(reply, /промокод/i);
}

{
  const { links } = expandPartnerChipsForBot('Купи [[творог]]');
  assert.ok(!links.some((l) => l.kind === 'firstOrder'));
}

{
  const cfg = resolveAuchanDeeplinkConfig(partners);
  assert.ok(cfg.firstOrder);
  assert.strictEqual(cfg.firstOrder.erid, '2bL9aMPo2e49hMef4rrUepvhzG');
}

const server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  http
    .get(`http://127.0.0.1:${port}/api/config`, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        server.close();
        const data = JSON.parse(body);
        assert.ok(data.auchanDeeplink && data.auchanDeeplink.enabled);
        assert.ok(data.auchanDeeplink.firstOrder);
        assert.strictEqual(
          data.auchanDeeplink.firstOrder.link,
          AUCHAN_DEEPLINK.firstOrder.link
        );
        assert.strictEqual(
          data.auchanDeeplink.firstOrder.erid,
          '2bL9aMPo2e49hMef4rrUepvhzG'
        );
        assert.notStrictEqual(
          data.auchanDeeplink.firstOrder.erid,
          data.auchanDeeplink.erid
        );
        assert.ok(data.auchanDeeplink.firstOrder.hint);
        assert.ok(data.auchanDeeplink.firstOrder.cta);
        console.log('verify-auchan-first-order: ok');
      });
    })
    .on('error', (err) => {
      server.close();
      throw err;
    });
});
