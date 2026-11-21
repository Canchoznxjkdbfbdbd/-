'use strict';

/**
 * Offline checks: expandPartnerChipsForBot turns [[chips]] into human prose
 * + structured Admitad links for Telegram /api/bot/chat.
 * Run: node scripts/verify-bot-partner-chips.js
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
  BOT_LINKS_MAX,
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
assert.ok(BOT_LINKS_MAX >= 8 && BOT_LINKS_MAX <= 12);

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

// expand BeFit + GrowFood — no raw brackets; structured links; clean reply
{
  const src =
    'Возьми [[befit:extralight]] или [[growfood:balance]] — удобно на неделю. [[partner:befit]]';
  const { reply, links } = expandPartnerChipsForBot(src);
  assert.doesNotMatch(reply, /\[\[/);
  assert.doesNotMatch(reply, /\]\]/);
  assert.match(reply, /extralight/);
  assert.match(reply, /balance/);
  assert.match(reply, /Ссылки ниже/);
  assert.doesNotMatch(reply, /https?:\/\//);
  assert.ok(Array.isArray(links));
  assert.strictEqual(links.length, 2);

  const bfUrl = buildBefitAdmitadUrl('extralight', BEFIT_DEEPLINK);
  const gfUrl = buildGrowfoodAdmitadUrl('balance', GROWFOOD_DEEPLINK);
  assert.ok(bfUrl && bfUrl.includes('uuwgc.com'));
  assert.ok(gfUrl && gfUrl.includes('naiawork.com'));
  assert.deepStrictEqual(
    links.map((l) => ({ label: l.label, store: l.store, url: l.url })),
    [
      { label: 'extralight', store: 'befit', url: bfUrl },
      { label: 'balance', store: 'growfood', url: gfUrl },
    ]
  );
  assert.ok(reply.includes('erid:'));
  // partner chip hidden
  assert.doesNotMatch(reply, /partner:befit/i);
}

// VkusVill bare chip + fish/hval
{
  const src = 'Купи [[творог 5%]] и [[vipfish:лосось]] плюс [[hval:premium]].';
  const { reply, links } = expandPartnerChipsForBot(src);
  assert.doesNotMatch(reply, /\[\[/);
  assert.match(reply, /Собрать корзину|Ссылки ниже/);
  assert.doesNotMatch(reply, /https?:\/\//);
  const vv = buildVkusvillAdmitadUrl('творог 5%');
  const fish = buildVipfishAdmitadUrl('лосось');
  const hv = buildHvalwatersAdmitadUrl('premium');
  assert.strictEqual(links.length, 3);
  assert.ok(links.some((l) => l.url === vv && l.store === 'vkusvill'));
  assert.ok(links.some((l) => l.url === fish && l.store === 'vipfish'));
  assert.ok(links.some((l) => l.url === hv && l.store === 'hvalwaters'));
}

// No chips → unchanged reply, empty links
{
  const src = 'Просто поешь овсянку с ягодами.';
  const out = expandPartnerChipsForBot(src);
  assert.deepStrictEqual(out, { reply: src, links: [] });
}

// Unknown prefix → label only, no structured links
{
  const { reply, links } = expandPartnerChipsForBot('Сходи в [[magnit:кефир]]');
  assert.doesNotMatch(reply, /\[\[/);
  assert.match(reply, /кефир/);
  assert.strictEqual(links.length, 0);
  assert.doesNotMatch(reply, /Собрать корзину|Ссылки ниже|Полезные ссылки/);
}

// Cap links at BOT_LINKS_MAX
{
  const chips = Array.from({ length: BOT_LINKS_MAX + 5 }, (_, i) => `[[товар ${i}]]`).join(' ');
  const { links } = expandPartnerChipsForBot(`Список: ${chips}`);
  assert.strictEqual(links.length, BOT_LINKS_MAX);
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
    // Route returns JSON without links when no chips in model reply.
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
      // No chips in fallback → links omitted or empty
      if ('links' in data) {
        assert.ok(Array.isArray(data.links));
        assert.strictEqual(data.links.length, 0);
      }
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
