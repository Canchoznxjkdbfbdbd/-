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
  stripModelAdDisclosures,
  stripTrailingDuplicateProductList,
  buildCompactAdDisclosure,
  BOT_LINKS_MAX,
  parseBotProductTag,
  buildBefitAdmitadUrl,
  buildGrowfoodAdmitadUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
  buildAuchanAdmitadUrl,
  buildHvalwatersAdmitadUrl,
  BEFIT_DEEPLINK,
  GROWFOOD_DEEPLINK,
  VKUSVILL_DEEPLINK,
  VIPFISH_DEEPLINK,
  AUCHAN_DEEPLINK,
  app,
} = require('../server');

assert.strictEqual(typeof expandPartnerChipsForBot, 'function');
assert.strictEqual(typeof stripModelAdDisclosures, 'function');
assert.strictEqual(typeof stripTrailingDuplicateProductList, 'function');
assert.strictEqual(typeof buildCompactAdDisclosure, 'function');
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
  const au = parseBotProductTag('auchan:гречка');
  assert.deepStrictEqual(au, { kind: 'product', label: 'гречка', store: 'auchan' });
  const ashan = parseBotProductTag('ashan:творог');
  assert.deepStrictEqual(ashan, { kind: 'product', label: 'творог', store: 'auchan' });
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
  assert.match(reply, /Реклама\.\s*Партнёрские ссылки Admitad/i);
  // One compact header — not N full «Реклама…Admitad» lines
  const adHeaders = reply.match(/Реклама\./gi) || [];
  assert.strictEqual(adHeaders.length, 1);
  // partner chip hidden
  assert.doesNotMatch(reply, /partner:befit/i);
}

// VkusVill bare chip + fish/hval/auchan
{
  const src =
    'Купи [[творог 5%]] и [[vipfish:лосось]] плюс [[hval:premium]] и [[auchan:гречка]].';
  const { reply, links } = expandPartnerChipsForBot(src);
  assert.doesNotMatch(reply, /\[\[/);
  assert.match(reply, /Собрать корзину|Ссылки ниже/);
  assert.doesNotMatch(reply, /https?:\/\//);
  const vv = buildVkusvillAdmitadUrl('творог 5%');
  const fish = buildVipfishAdmitadUrl('лосось');
  const hv = buildHvalwatersAdmitadUrl('premium');
  const au = buildAuchanAdmitadUrl('гречка');
  assert.strictEqual(links.length, 4);
  assert.ok(links.some((l) => l.url === vv && l.store === 'vkusvill'));
  assert.ok(links.some((l) => l.url === fish && l.store === 'vipfish'));
  assert.ok(links.some((l) => l.url === hv && l.store === 'hvalwaters'));
  assert.ok(links.some((l) => l.url === au && l.store === 'auchan'));
  assert.ok(au && au.includes('rthsu.com') && AUCHAN_DEEPLINK.enabled);
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

// Strip model-written Реклама/erid; server adds disclosure once
{
  const stripped = stripModelAdDisclosures(
    'Бери творог.\nРеклама. АО «ВкусВилл».\nerid: FAKE_MODEL_ERID\nИ ещё совет.'
  );
  assert.doesNotMatch(stripped, /Реклама/i);
  assert.doesNotMatch(stripped, /erid/i);
  assert.match(stripped, /творог/);
  assert.match(stripped, /совет/);

  const src =
    'Купи [[греческий йогурт]].\nРеклама. что-то от модели.\nerid: MODEL_DUP_ERID';
  const { reply, links } = expandPartnerChipsForBot(src);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].label, 'греческий йогурт');
  assert.strictEqual(links[0].store, 'vkusvill');
  assert.doesNotMatch(reply, /MODEL_DUP_ERID/);
  assert.match(reply, /Собрать корзину|Ссылки ниже/);
  // Compact block: one header + one erid bullet
  const eridHits = reply.match(/\berid\s*:/gi) || [];
  assert.strictEqual(eridHits.length, 1);
  assert.match(reply, /Реклама\.\s*Партнёрские ссылки Admitad/i);
  assert.doesNotMatch(reply, /Реклама\.\s*АО/);
}

// Multi-partner chips in one reply (VV + vipfish + hval) — allowed
{
  const src = 'Набор: [[овсянка]], [[vipfish:лосось]], [[hval:premium]].';
  const { reply, links } = expandPartnerChipsForBot(src);
  assert.strictEqual(links.length, 3);
  assert.ok(links.every((l) => l.label && !/ВкусВилл|Важная|Хвалов/i.test(l.label)));
  assert.doesNotMatch(reply, /\[\[/);
  const eridHits = reply.match(/\berid\s*:/gi) || [];
  assert.ok(eridHits.length >= 1);
  assert.ok(eridHits.length <= 3);
  // Single compact header, not three full Реклама lines
  const adHeaders = reply.match(/Реклама\./gi) || [];
  assert.strictEqual(adHeaders.length, 1);
  assert.match(reply, /Реклама\.\s*Партнёрские ссылки Admitad/i);
  assert.match(reply, /•\s*ВкусВилл\s*\(erid:/);
}

// Trailing bare product list duplicates button labels → stripped
{
  const src =
    'Лёгкий ужин: творог с зеленью.\n\nСписок:\n• творог 5%\n• лосось\n\n[[творог 5%]]\n[[vipfish:лосось]]';
  const { reply, links } = expandPartnerChipsForBot(src);
  assert.strictEqual(links.length, 2);
  assert.match(reply, /Лёгкий ужин/);
  assert.match(reply, /Собрать корзину — ссылки ниже/);
  // No second trailing dump of the same products before CTA
  assert.doesNotMatch(reply, /Список:/i);
  const beforeCta = reply.split(/Собрать корзину/)[0];
  assert.doesNotMatch(beforeCta, /^\s*[•\-]\s*творог 5%\s*$/m);
  assert.doesNotMatch(beforeCta, /^\s*[•\-]\s*лосось\s*$/m);
  assert.doesNotMatch(beforeCta, /^\s*творог 5%\s*$/m);
  assert.doesNotMatch(beforeCta, /^\s*лосось\s*$/m);
}

// Compact disclosure builder — unique by erid
{
  const block = buildCompactAdDisclosure(new Set(['vkusvill', 'vipfish', 'vkusvill']));
  assert.match(block, /^Реклама\.\s*Партнёрские ссылки Admitad\./m);
  assert.match(block, new RegExp(`ВкусВилл \\(erid: ${VKUSVILL_DEEPLINK.erid}\\)`));
  assert.match(
    block,
    new RegExp(
      `${(VIPFISH_DEEPLINK.legalName || 'ООО «Кейтеринг-Рент»').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(erid: ${VIPFISH_DEEPLINK.erid}\\)`
    )
  );
  assert.strictEqual((block.match(/Реклама\./g) || []).length, 1);
  assert.doesNotMatch(block, /ИНН/);
}

// stripTrailingDuplicateProductList unit
{
  const links = [
    { label: 'творог 5%', store: 'vkusvill', url: 'https://example.com/a' },
    { label: 'лосось', store: 'vipfish', url: 'https://example.com/b' },
  ];
  const cleaned = stripTrailingDuplicateProductList(
    'Рецепт ок.\n\n• творог 5%\n• лосось\nтворог 5% лосось',
    links
  );
  assert.match(cleaned, /Рецепт ок/);
  assert.doesNotMatch(cleaned, /творог/);
  assert.doesNotMatch(cleaned, /лосось/);
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
