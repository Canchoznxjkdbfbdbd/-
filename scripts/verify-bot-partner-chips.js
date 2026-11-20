'use strict';

/**
 * Offline checks: expandPartnerChipsForBot turns [[chips]] into human links
 * for Telegram /api/bot/chat only. Run: node scripts/verify-bot-partner-chips.js
 */

const assert = require('assert');
const http = require('http');

process.env.BOT_API_KEY = process.env.BOT_API_KEY || 'test-bot-key-chips';
if (!process.env.VERIFY_LIVE) {
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEY_2 = '';
}

const {
  expandPartnerChipsForBot,
  parseBotProductTag,
  buildBefitAdmitadUrl,
  buildGrowfoodAdmitadUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
  buildHvalwatersAdmitadUrl,
  BEFIT_DEEPLINK,
  GROWFOOD_DEEPLINK,
  app,
} = require('../server');

assert.strictEqual(typeof expandPartnerChipsForBot, 'function');
assert.strictEqual(typeof parseBotProductTag, 'function');

// parse
{
  const bf = parseBotProductTag('befit:extralight');
  assert.deepStrictEqual(bf, { kind: 'product', label: 'extralight', store: 'befit' });
  const gf = parseBotProductTag('growfood:balance');
  assert.deepStrictEqual(gf, { kind: 'product', label: 'balance', store: 'growfood' });
  const vv = parseBotProductTag('гречка');
  assert.deepStrictEqual(vv, { kind: 'product', label: 'гречка', store: 'vkusvill' });
  const partner = parseBotProductTag('partner:befit');
  assert.strictEqual(partner.kind, 'partner');
  const unknown = parseBotProductTag('magnit:молоко');
  assert.deepStrictEqual(unknown, { kind: 'plain', label: 'молоко', store: null });
}

// expand BeFit + GrowFood — no raw brackets; Admitad URLs present
{
  const src =
    'Возьми [[befit:extralight]] или [[growfood:balance]] — удобно на неделю. [[partner:befit]]';
  const out = expandPartnerChipsForBot(src);
  assert.doesNotMatch(out, /\[\[/);
  assert.doesNotMatch(out, /\]\]/);
  assert.match(out, /extralight/);
  assert.match(out, /balance/);
  assert.match(out, /Полезные ссылки:/);
  assert.match(out, /BeFit — extralight/);
  assert.match(out, /GrowFood — balance/);

  const bfUrl = buildBefitAdmitadUrl('extralight', BEFIT_DEEPLINK);
  const gfUrl = buildGrowfoodAdmitadUrl('balance', GROWFOOD_DEEPLINK);
  assert.ok(bfUrl && bfUrl.includes('uuwgc.com'));
  assert.ok(gfUrl && gfUrl.includes('naiawork.com'));
  assert.ok(out.includes(bfUrl));
  assert.ok(out.includes(gfUrl));
  assert.ok(out.includes('erid:'));
  // partner chip hidden
  assert.doesNotMatch(out, /partner:befit/i);
}

// VkusVill bare chip + fish/hval
{
  const src = 'Купи [[творог 5%]] и [[vipfish:лосось]] плюс [[hval:premium]].';
  const out = expandPartnerChipsForBot(src);
  assert.doesNotMatch(out, /\[\[/);
  assert.match(out, /Собрать корзину:/);
  const vv = buildVkusvillAdmitadUrl('творог 5%');
  const fish = buildVipfishAdmitadUrl('лосось');
  const hv = buildHvalwatersAdmitadUrl('premium');
  assert.ok(vv && out.includes(vv));
  assert.ok(fish && out.includes(fish));
  assert.ok(hv && out.includes(hv));
}

// No chips → unchanged
{
  const src = 'Просто поешь овсянку с ягодами.';
  assert.strictEqual(expandPartnerChipsForBot(src), src);
}

// Unknown prefix → label only, no fake link block entry
{
  const out = expandPartnerChipsForBot('Сходи в [[magnit:кефир]]');
  assert.doesNotMatch(out, /\[\[/);
  assert.match(out, /кефир/);
  assert.doesNotMatch(out, /Собрать корзину|Полезные ссылки/);
}

function listen(appRef) {
  return new Promise((resolve) => {
    const server = http.createServer(appRef);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  // Unit checks above already ran.
  const { server, base } = await listen(app);
  const key = process.env.BOT_API_KEY;
  try {
    // Route returns expanded reply when mock text has no chips — still JSON.
    {
      const res = await fetch(`${base}/api/bot/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Key': key,
        },
        body: JSON.stringify({ message: 'Что на завтрак?' }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.equal(typeof data.reply, 'string');
      assert.doesNotMatch(data.reply, /\[\[/);
    }

    // /api/chat SSE must still be event-stream (chips path untouched at transport layer)
    {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'тест' }] }),
      });
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/i);
    }

    console.log('verify-bot-partner-chips: ok');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
