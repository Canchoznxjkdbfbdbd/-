'use strict';

/**
 * Offline checks for partner-link / hole counters in /admin.
 * Run: ADMIN_PASSWORD=test-admin-pass node scripts/verify-admin-link-stats.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.BOT_API_KEY = process.env.BOT_API_KEY || 'test-bot-key-link-stats';
process.env.ADMIN_USER = process.env.ADMIN_USER || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin-pass';
if (!process.env.VERIFY_LIVE) {
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEY_2 = '';
}

const {
  app,
  inspectPartnerLinkOutcome,
  countResolvablePartnerLinks,
  recordChatSuccess,
  readAdminStats,
  LINK_STATS_PATH,
  expandPartnerChipsForBot,
  buildVkusvillAdmitadUrl,
  VKUSVILL_DEEPLINK,
} = require('../server');

assert.strictEqual(typeof inspectPartnerLinkOutcome, 'function');
assert.strictEqual(typeof countResolvablePartnerLinks, 'function');
assert.strictEqual(typeof recordChatSuccess, 'function');
assert.strictEqual(typeof readAdminStats, 'function');
assert.ok(LINK_STATS_PATH && path.isAbsolute(LINK_STATS_PATH));

// --- pure inspect ---
{
  const withChip = inspectPartnerLinkOutcome(
    'Возьми [[творог]] и [[гречка]] — нормальный набор на день.'
  );
  assert.strictEqual(withChip.hasLinks, true);
  assert.ok(withChip.linkCount >= 2);
  assert.strictEqual(withChip.isHole, false);

  const holeBrand = inspectPartnerLinkOutcome(
    'Могу подсказать ВкусВилл с доставкой по городу, без списка пока.'
  );
  assert.strictEqual(holeBrand.hasLinks, false);
  assert.strictEqual(holeBrand.isHole, true);
  assert.match(holeBrand.fragment, /ВкусВилл|вкусвилл/i);

  const holeCta = inspectPartnerLinkOutcome(
    'Ок, соберу варианты под доставку. Напиши город — подскажу, что реально привезут.'
  );
  assert.strictEqual(holeCta.hasLinks, false);
  assert.strictEqual(holeCta.isHole, true);

  const clean = inspectPartnerLinkOutcome('Пара вопросов: на сейчас или на неделю? Есть аллергии?');
  assert.strictEqual(clean.hasLinks, false);
  assert.strictEqual(clean.isHole, false);

  const chipWins = inspectPartnerLinkOutcome(
    'ВкусВилл удобен. [[авокадо]] [[греческий йогурт]]'
  );
  assert.strictEqual(chipWins.hasLinks, true);
  assert.strictEqual(chipWins.isHole, false);

  // Resolvable URLs match expandPartnerChipsForBot
  const raw = 'Купи [[молоко]]';
  const { links } = expandPartnerChipsForBot(raw);
  assert.strictEqual(countResolvablePartnerLinks(raw), links.length);
  if (VKUSVILL_DEEPLINK.enabled) {
    const url = buildVkusvillAdmitadUrl('молоко', VKUSVILL_DEEPLINK);
    assert.ok(url);
    assert.ok(links.some((l) => l.url === url));
  }
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

function basicAuth() {
  const token = Buffer.from(
    `${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`,
    'utf8'
  ).toString('base64');
  return `Basic ${token}`;
}

async function main() {
  const prevExists = fs.existsSync(LINK_STATS_PATH);
  const prevRaw = prevExists ? fs.readFileSync(LINK_STATS_PATH, 'utf8') : null;

  const { server, base } = await listen(app);

  try {
    const before = await readAdminStats();
    const linksBefore = Number(before.linksToday) || 0;
    const holesBefore = Number(before.holesToday) || 0;

    await recordChatSuccess('Бери [[овсянка]] из ВкусВилл — быстро.');
    await recordChatSuccess('Могу заказать BeFit на неделю с доставкой по Москве.');
    await recordChatSuccess('Ок, уточни: готовить самим или готовая еда?');

    const after = await readAdminStats();
    assert.strictEqual(after.linksToday, linksBefore + 1);
    assert.strictEqual(after.holesToday, holesBefore + 1);
    assert.ok(Array.isArray(after.recentHoles));
    assert.ok(after.recentHoles.length >= 1);
    assert.ok(after.recentHoles[0].id);
    assert.ok(after.recentHoles[0].at);
    assert.match(String(after.recentHoles[0].fragment || ''), /BeFit|доставк/i);

    // Persist file written
    assert.ok(fs.existsSync(LINK_STATS_PATH));
    const saved = JSON.parse(fs.readFileSync(LINK_STATS_PATH, 'utf8'));
    assert.strictEqual(saved.linksToday, after.linksToday);
    assert.strictEqual(saved.holesToday, after.holesToday);

    // Admin API exposes the same fields
    const res = await fetch(`${base}/api/admin/stats`, {
      headers: { Authorization: basicAuth() },
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.linksToday, after.linksToday);
    assert.strictEqual(json.holesToday, after.holesToday);
    assert.ok(Array.isArray(json.recentHoles));

    // Admin HTML has the new UI hooks
    const htmlRes = await fetch(`${base}/admin`, {
      headers: { Authorization: basicAuth() },
    });
    assert.strictEqual(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /id="links-today"/);
    assert.match(html, /id="holes-today"/);
    assert.match(html, /id="holes-list"/);
    assert.match(html, /Ответы со ссылками сегодня/);
    assert.match(html, /Дыры \(рекомендация без ссылки\)/);

    console.log('verify-admin-link-stats: ok');
  } finally {
    server.close();
    // Restore prior persist file so local runs don't leave test noise.
    try {
      if (prevRaw != null) fs.writeFileSync(LINK_STATS_PATH, prevRaw, 'utf8');
      else if (fs.existsSync(LINK_STATS_PATH)) fs.unlinkSync(LINK_STATS_PATH);
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
