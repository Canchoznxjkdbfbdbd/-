'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const cluster = require('cluster');
const express = require('express');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
/** Behind nginx / Beget / Timeweb proxy — rate-limit must see real client IP. */
app.set('trust proxy', 1);
/**
 * Gemini API origin. On RU VPS, set GEMINI_API_ORIGIN to an allowed proxy host —
 * direct generativelanguage.googleapis.com returns FAILED_PRECONDITION (location).
 */
const GEMINI_API_ORIGIN = (
  process.env.GEMINI_API_ORIGIN || 'https://generativelanguage.googleapis.com'
).replace(/\/$/, '');
/** Slot 1 = GEMINI_API_KEY, slot 2 = GEMINI_API_KEY_2 (sticky primary after successful failover). */
const GEMINI_KEY_SLOTS = [
  { id: 1, key: String(process.env.GEMINI_API_KEY || '').trim() },
  { id: 2, key: String(process.env.GEMINI_API_KEY_2 || '').trim() },
].filter((slot) => slot.key);
const GEMINI_API_KEY = GEMINI_KEY_SLOTS[0]?.key || '';
let activeGeminiKeyId = GEMINI_KEY_SLOTS[0]?.id || null;
/** Prefer lean/fast models first under free-tier load; gemini-3.8-flash is opt-in via env. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
/** Default chain after the primary model when Gemini returns 503 / UNAVAILABLE. */
const DEFAULT_FALLBACK_MODELS = ['gemini-3.6-flash'];
/** Single place for the VK community footer link (override via env if shortname changes). */
const COMMUNITY_VK_URL = process.env.COMMUNITY_VK_URL || 'https://vk.ru/ai.nutricode';
/** Yandex.Metrika counter id; empty disables /api/config advertisement. */
const YANDEX_METRIKA_ID = String(process.env.YANDEX_METRIKA_ID || '').trim();

/**
 * Product auto-deeplink (Admitad ulp).
 * Pattern: merchant search/program URL → encodeURIComponent into webmaster base as &ulp=.
 * VkusVill search (verified 200): https://vkusvill.ru/search/?q=
 * Важная рыба search (verified 200): https://vipfish.ru/search/?q=
 * BeFit: WP search https://letbefit.ru/?s= ( /search/?q= → 404); programs /programmy/{slug}/.
 * Хваловская вода: WP https://hvalwaters.ru/?s= (/search/?q= → 404); products /water/{slug}/.
 * GrowFood: order hub https://growfood.pro/new-order/ (no WP search); lines /new-order/{slug}.
 * Ашан (auchan.ru): search https://www.auchan.ru/search/?query= (/search/?q= → home; catalogsearch → 404);
 *   product https://www.auchan.ru/product/{slug}/. Webmaster rthsu.com (not /job/).
 */
const VKUSVILL_SEARCH_PREFIX = 'https://vkusvill.ru/search/?q=';
const DEFAULT_ADMITAD_VKUSVILL_BASE =
  'https://kdbov.com/g/2xtzn37pfe268e100ca0b80ad6f8ae/?erid=2bL9aMPo2e49hMef4phUrdrQCx';
const DEFAULT_ADMITAD_VKUSVILL_ERID = '2bL9aMPo2e49hMef4phUrdrQCx';

const VIPFISH_SEARCH_PREFIX = 'https://vipfish.ru/search/?q=';
const DEFAULT_ADMITAD_VIPFISH_BASE =
  'https://dorinebeaumont.com/g/lqb6l7197z268e100ca094cf89477e/?erid=2bL9aMPo2e49hMef4peVndVUPr';
const DEFAULT_ADMITAD_VIPFISH_ERID = '2bL9aMPo2e49hMef4peVndVUPr';
/** Owner banner zones — soft-gate in prompt; chips use [[vipfish:…]] / [[ryba:…]]. */
const VIPFISH_GEO_CITIES = [
  'Санкт-Петербург',
  'Мурино',
  'Бугры',
  'Пушкин',
  'Петергоф',
  'Всеволожск',
  'Кудрово',
  'Шушары',
  'Сестрорецк',
];

/** Ашан (www.auchan.ru) — chips [[auchan:…]] / [[ashan:…]]. Search ?query= (verified 200). */
const AUCHAN_SEARCH_PREFIX = 'https://www.auchan.ru/search/?query=';
const AUCHAN_PRODUCT_PREFIX = 'https://www.auchan.ru/product/';
const DEFAULT_ADMITAD_AUCHAN_BASE =
  'https://rthsu.com/g/g1f8w0wsou268e100ca0414eca7795/?erid=2bL9aMPo2e49hMef4rrTkXfiWn';
const DEFAULT_ADMITAD_AUCHAN_ERID = '2bL9aMPo2e49hMef4rrTkXfiWn';
/** First-order Admitad (i=3) — separate erid from search deeplink; user builds cart themselves. */
const DEFAULT_AUCHAN_FIRST_ORDER_LINK =
  'https://rthsu.com/g/30o5vsx0bi268e100ca0414eca7795/?i=3&erid=2bL9aMPo2e49hMef4rrUepvhzG';
const DEFAULT_AUCHAN_FIRST_ORDER_ERID = '2bL9aMPo2e49hMef4rrUepvhzG';
const DEFAULT_AUCHAN_FIRST_ORDER_MIN_RUB = 4000;
const DEFAULT_AUCHAN_FIRST_ORDER_DISCOUNT_HINT = 'больше 800 ₽';
/** Soft-geo: hypermarkets in MSK, SPb + many RF cities — delivery not everywhere. */
const AUCHAN_GEO_CITIES = ['Москва', 'Санкт-Петербург'];

/** BeFit (letbefit.ru) — WP search works; /search/?q= 404. Chips: [[befit:…]] / [[letbefit:…]]. */
const BEFIT_SEARCH_PREFIX = 'https://letbefit.ru/?s=';
const BEFIT_PROGRAM_PREFIX = 'https://letbefit.ru/programmy/';
const DEFAULT_ADMITAD_BEFIT_BASE =
  'https://uuwgc.com/g/qm29jzxwek268e100ca0fcd3300043/?erid=25H8d7vbP8SRTvJZjHsUpp';
const DEFAULT_ADMITAD_BEFIT_ERID = '25H8d7vbP8SRTvJZjHsUpp';
/** Soft-geo from partner brief (MSK + SPb). */
const BEFIT_GEO_CITIES = ['Москва', 'Санкт-Петербург'];

/** Хваловская вода (hvalwaters.ru) — chips [[hval:…]] / [[water:…]] / [[hvalwaters:…]]. */
const HVALWATERS_SEARCH_PREFIX = 'https://hvalwaters.ru/?s=';
const HVALWATERS_PRODUCT_PREFIX = 'https://hvalwaters.ru/water/';
const DEFAULT_ADMITAD_HVALWATERS_BASE =
  'https://xmknb.com/g/b0173jl262268e100ca000dcac28d3/?erid=2bL9aMPo2e49hMef4pfVDKbKSL';
const DEFAULT_ADMITAD_HVALWATERS_ERID = '2bL9aMPo2e49hMef4pfVDKbKSL';
/** Optional coupon-ish Admitad (i=3) — stored in partners, chips use base without i=3. */
const DEFAULT_ADMITAD_HVALWATERS_COUPON_BASE =
  'https://xmknb.com/g/b4m98x4q7s268e100ca000dcac28d3/?i=3&erid=2bL9aMPo2e49hMef4pgUkgcvSC';
/** Soft-geo MSK + SPb (+ near regions by address; hubs only in code). */
const HVALWATERS_GEO_CITIES = ['Москва', 'Санкт-Петербург'];
/**
 * Verified product slugs under /water/{slug}/.
 * deluxe removed 2026-11-19: /water/deluxe/ soft-redirects to /catalog/ (wrong landing).
 */
const HVALWATERS_PRODUCT_SLUGS = ['premium', 'naturelle', 'gornaya'];
/** Friendly aliases → verified /water/ slug. Unknown (incl. legacy deluxe) → WP ?s=. */
const HVALWATERS_PRODUCT_ALIASES = {
  premium: 'premium',
  премиум: 'premium',
  'хваловская premium': 'premium',
  'хваловская премиум': 'premium',
  'hvalovskaya premium': 'premium',
  '19л': 'premium',
  '19 l': 'premium',
  '19l': 'premium',
  '18.9': 'premium',
  '18,9': 'premium',
  бутыль: 'premium',
  naturelle: 'naturelle',
  натурель: 'naturelle',
  'хваловская naturelle': 'naturelle',
  gornaya: 'gornaya',
  горная: 'gornaya',
  'хваловская горная': 'gornaya',
};

/**
 * GrowFood (growfood.pro) — chips [[growfood:…]] / [[gf:…]].
 * SPA route new-order/:goal; no WP search ( /search/?q= → 404).
 * Unknown → /new-order/ (working order hub). Do NOT use #menu-plans / bare / —
 * growfood.pro/ returns a 307 loop for crawlers and Admitad ulp follow.
 */
const GROWFOOD_CATALOG_URL = 'https://growfood.pro/new-order/';
const GROWFOOD_SEARCH_PREFIX = GROWFOOD_CATALOG_URL;
const GROWFOOD_PROGRAM_PREFIX = 'https://growfood.pro/new-order/';
const DEFAULT_ADMITAD_GROWFOOD_BASE =
  'https://naiawork.com/g/36wusytszy268e100ca0aeb982cd0a/?erid=MvGzQC98w3Z1gMq1kxQwfCfT';
const DEFAULT_ADMITAD_GROWFOOD_ERID = 'MvGzQC98w3Z1gMq1kxQwfCfT';
/** Soft-geo from owner dump (MSK + SPb only for now). */
const GROWFOOD_GEO_CITIES = ['Москва', 'Санкт-Петербург'];
/** Owner lines + SPA-verified /new-order/{slug} (2026-11-17). */
const GROWFOOD_PROGRAM_SLUGS = ['super-fit', 'fit', 'daily', 'balance', 'power'];
/** Friendly aliases → verified /new-order/ slug. */
const GROWFOOD_PROGRAM_ALIASES = {
  superfit: 'super-fit',
  'super fit': 'super-fit',
  'super-fit': 'super-fit',
  суперфит: 'super-fit',
  'супер фит': 'super-fit',
  'супер-фит': 'super-fit',
  fit: 'fit',
  фит: 'fit',
  похудение: 'super-fit',
  'сбросить вес': 'super-fit',
  daily: 'daily',
  дейли: 'daily',
  дэйли: 'daily',
  balance: 'balance',
  баланс: 'balance',
  спорт: 'balance',
  рельеф: 'balance',
  power: 'power',
  пауэр: 'power',
  павер: 'power',
  масса: 'power',
  'набор массы': 'power',
  'набор мышечной массы': 'power',
};

/**
 * Verified product program slugs (named rations with kcal, like superstrongpremium).
 * SEO hub pages (gotovoe-menyu-dlya-pohudeniya / nabor-myshechnoj-massy) are NOT
 * orderable product URLs — owner reported them as dead affiliate targets; remap via aliases.
 */
const BEFIT_PROGRAM_SLUGS = [
  'balance',
  'balancepremium',
  'daily',
  'everydaily',
  'extralight',
  'extralightpremium',
  'fish',
  'fishpremium',
  'gluten_free',
  'gotovoe-menyu-dlya-sportsmenov',
  'keto-start',
  'light',
  'lightpremium',
  'middlesea',
  'normal',
  'normalpremium',
  'strong',
  'strongpremium',
  'superstrongpremium',
  'vegetarian',
  'veggi',
];
/**
 * Friendly / legacy aliases → product slug.
 * Hub SEO paths remap to concrete programs (похудение → extralight, масса → strong).
 * Energy* → sports landing (no /programmy/energy* on site).
 */
const BEFIT_PROGRAM_ALIASES = {
  keto: 'keto-start',
  ketostart: 'keto-start',
  'keto start': 'keto-start',
  energy: 'gotovoe-menyu-dlya-sportsmenov',
  'energy max': 'gotovoe-menyu-dlya-sportsmenov',
  energymax: 'gotovoe-menyu-dlya-sportsmenov',
  'energy-max': 'gotovoe-menyu-dlya-sportsmenov',
  sport: 'gotovoe-menyu-dlya-sportsmenov',
  sports: 'gotovoe-menyu-dlya-sportsmenov',
  спорт: 'gotovoe-menyu-dlya-sportsmenov',
  кето: 'keto-start',
  'super strong premium': 'superstrongpremium',
  superstrong: 'superstrongpremium',
  extralight: 'extralight',
  'extra light': 'extralight',
  'extra-light': 'extralight',
  // Legacy SEO hubs → real product pages (owner dead-link ground truth).
  'gotovoe-menyu-dlya-pohudeniya': 'extralight',
  'готовое меню для похудения': 'extralight',
  похудение: 'extralight',
  slim: 'extralight',
  'nabor-myshechnoj-massy': 'strong',
  'набор массы': 'strong',
  масса: 'strong',
};

/** Strip ulp so we can append a fresh double-encoded target; keep erid and other params. */
function normalizeAdmitadBase(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.searchParams.delete('ulp');
    let out = `${url.origin}${url.pathname}`;
    const qs = url.searchParams.toString();
    if (qs) out += `?${qs}`;
    return out;
  } catch {
    return value
      .replace(/([?&])ulp=[^&]*/gi, '$1')
      .replace(/[?&]$/, '')
      .replace(/\?&/, '?');
  }
}

function eridFromUrl(raw) {
  try {
    return String(new URL(String(raw || '').trim()).searchParams.get('erid') || '').trim();
  } catch {
    return '';
  }
}

/**
 * Admitad webmaster hosts only — never raw merchant landings
 * (vkusvill.ru / vipfish.ru / letbefit.ru / hvalwaters.ru / growfood.pro / gf.ru / auchan.ru).
 * VV kdbov.com; рыба dorinebeaumont.com; BeFit uuwgc.com; Hvalwaters xmknb.com;
 * GrowFood naiawork.com; Ашан rthsu.com; classic admitad.com also ok.
 */
function looksLikeAdmitadWebmaster(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return false;
  if (
    /vkusvill\.ru|vipfish\.ru|letbefit\.ru|hvalwaters\.ru|growfood\.pro|gf\.ru|auchan\.ru/i.test(
      value
    )
  ) {
    return false;
  }
  return /kdbov\.com|dorinebeaumont\.com|uuwgc\.com|xmknb\.com|naiawork\.com|rthsu\.com|admitad\.com|ad\.admitad\.com/i.test(
    value
  );
}

function findPartnerRow(partners, id) {
  const needle = String(id || '')
    .trim()
    .toLowerCase();
  if (!needle || !Array.isArray(partners)) return null;
  return (
    partners.find((p) => p && String(p.id || '').toLowerCase() === needle) || null
  );
}

function resolveAdmitadDeeplinkConfig({
  partners,
  partnerId,
  envBaseKey,
  envEridKey,
  defaultBase,
  defaultErid,
  searchPrefix,
  extra = {},
}) {
  const row = findPartnerRow(partners, partnerId);
  const fromEnvBase = String(process.env[envBaseKey] || '').trim();
  const fromPartnerAdmitad = String((row && row.admitad_base) || '').trim();
  const fromPartnerLink = String((row && row.link) || '').trim();
  const candidate =
    (looksLikeAdmitadWebmaster(fromEnvBase) && fromEnvBase) ||
    (looksLikeAdmitadWebmaster(fromPartnerAdmitad) && fromPartnerAdmitad) ||
    (looksLikeAdmitadWebmaster(fromPartnerLink) && fromPartnerLink) ||
    defaultBase;
  const base = normalizeAdmitadBase(candidate);
  const fromEnvErid = String(process.env[envEridKey] || '').trim();
  const fromPartnerErid = String((row && row.erid) || '').trim();
  const erid =
    fromEnvErid || fromPartnerErid || eridFromUrl(base) || defaultErid;
  return {
    admitadBase: base,
    erid,
    searchPrefix,
    enabled: Boolean(base),
    promoCode: String((row && row.promo_code) || '').trim() || null,
    disclaimer: String((row && row.disclaimer) || '').trim() || null,
    legalName: String((row && row.legal_name) || '').trim() || null,
    inn: String((row && row.inn) || '').trim() || null,
    ...extra,
  };
}

function resolveVkusvillDeeplinkConfig(partners) {
  return resolveAdmitadDeeplinkConfig({
    partners,
    partnerId: 'vkusvill',
    envBaseKey: 'ADMITAD_VKUSVILL_BASE',
    envEridKey: 'ADMITAD_VKUSVILL_ERID',
    defaultBase: DEFAULT_ADMITAD_VKUSVILL_BASE,
    defaultErid: DEFAULT_ADMITAD_VKUSVILL_ERID,
    searchPrefix: VKUSVILL_SEARCH_PREFIX,
  });
}

function resolveVipfishDeeplinkConfig(partners) {
  const row =
    findPartnerRow(partners, 'vazhnaya-ryba') ||
    findPartnerRow(partners, 'vipfish');
  const geoFromPartner = Array.isArray(row && row.geo) ? row.geo : null;
  const cities =
    geoFromPartner && geoFromPartner.length
      ? geoFromPartner.map((c) => String(c || '').trim()).filter(Boolean)
      : VIPFISH_GEO_CITIES.slice();
  const cfg = resolveAdmitadDeeplinkConfig({
    partners: row ? [row] : partners,
    partnerId: (row && row.id) || 'vazhnaya-ryba',
    envBaseKey: 'ADMITAD_VIPFISH_BASE',
    envEridKey: 'ADMITAD_VIPFISH_ERID',
    defaultBase: DEFAULT_ADMITAD_VIPFISH_BASE,
    defaultErid: DEFAULT_ADMITAD_VIPFISH_ERID,
    searchPrefix: VIPFISH_SEARCH_PREFIX,
  });
  return {
    ...cfg,
    id: 'vazhnaya-ryba',
    name: String((row && row.name) || 'Важная рыба'),
    cities,
    tagPrefixes: ['vipfish', 'ryba'],
  };
}

function resolveAuchanProductSlug(label) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  let key = raw.toLowerCase().replace(/^\/+/, '');
  key = key.replace(/^product\//i, '').replace(/\/+$/, '');
  // Only ASCII product path slugs (e.g. organik-0-5), not Russian grocery names.
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(key) && /[-_]/.test(key)) {
    return key;
  }
  if (/^product\//i.test(raw) && /^[a-z0-9][a-z0-9_-]*$/i.test(key)) {
    return key;
  }
  return null;
}

function resolveAuchanTargetUrl(label, cfg = {}) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  const slug = resolveAuchanProductSlug(raw);
  if (slug) {
    const productPrefix = String(
      (cfg && cfg.productPrefix) || AUCHAN_PRODUCT_PREFIX
    ).replace(/\/?$/, '/');
    return `${productPrefix}${slug}/`;
  }
  const prefix = String((cfg && cfg.searchPrefix) || AUCHAN_SEARCH_PREFIX);
  return `${prefix}${encodeURIComponent(raw)}`;
}

/**
 * Parse partners.json firstOrder for Ашан (landing CTA, not search deeplink).
 * @param {object|null|undefined} row
 * @returns {{link:string,erid:string,minOrderRub:number,discountHint:string,hint:string,cta:string}|null}
 */
function resolveAuchanFirstOrder(row) {
  const raw = row && row.firstOrder && typeof row.firstOrder === 'object' ? row.firstOrder : null;
  const link = String(
    (raw && (raw.link || raw.url)) || DEFAULT_AUCHAN_FIRST_ORDER_LINK
  ).trim();
  const erid = String(
    (raw && raw.erid) || DEFAULT_AUCHAN_FIRST_ORDER_ERID
  ).trim();
  if (!link || !/^https?:\/\//i.test(link)) return null;
  // Keep first-order webmaster link as-is (may include i=3); do not strip or reuse search base.
  if (!looksLikeAdmitadWebmaster(link) && !/rthsu\.com/i.test(link)) return null;
  // Never reuse search deeplink erid for first-order CTA.
  if (erid && erid === DEFAULT_ADMITAD_AUCHAN_ERID) return null;
  const minRaw = raw && raw.minOrderRub != null ? Number(raw.minOrderRub) : NaN;
  const minOrderRub =
    Number.isFinite(minRaw) && minRaw > 0 ? Math.round(minRaw) : DEFAULT_AUCHAN_FIRST_ORDER_MIN_RUB;
  const discountHint = String(
    (raw && raw.discountHint) || DEFAULT_AUCHAN_FIRST_ORDER_DISCOUNT_HINT
  ).trim();
  const minFmt = String(minOrderRub).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  const hint = String((raw && (raw.hint || raw.text)) || '').trim()
    || `Если раньше не заказывали в Ашане — на заказ от ${minFmt}\u202f₽ скидка ${discountHint}`;
  const cta = String((raw && (raw.cta || raw.ctaLabel || raw.button)) || '').trim()
    || 'Забрать скидку на первый заказ';
  return { link, erid, minOrderRub, discountHint, hint, cta };
}

function resolveAuchanDeeplinkConfig(partners) {
  const row =
    findPartnerRow(partners, 'auchan') ||
    findPartnerRow(partners, 'ashan') ||
    findPartnerRow(partners, 'ашан');
  const geoFromPartner = Array.isArray(row && row.geo) ? row.geo : null;
  const cities =
    geoFromPartner && geoFromPartner.length
      ? geoFromPartner.map((c) => String(c || '').trim()).filter(Boolean)
      : AUCHAN_GEO_CITIES.slice();
  const cfg = resolveAdmitadDeeplinkConfig({
    partners: row ? [row] : partners,
    partnerId: (row && row.id) || 'auchan',
    envBaseKey: 'ADMITAD_AUCHAN_BASE',
    envEridKey: 'ADMITAD_AUCHAN_ERID',
    defaultBase: DEFAULT_ADMITAD_AUCHAN_BASE,
    defaultErid: DEFAULT_ADMITAD_AUCHAN_ERID,
    searchPrefix: AUCHAN_SEARCH_PREFIX,
  });
  return {
    ...cfg,
    id: 'auchan',
    name: String((row && row.name) || 'Ашан'),
    cities,
    tagPrefixes: ['auchan', 'ashan'],
    productPrefix: AUCHAN_PRODUCT_PREFIX,
    firstOrder: resolveAuchanFirstOrder(row),
  };
}

function normalizeBefitPromos(row) {
  const fromRow = Array.isArray(row && row.promos) ? row.promos : null;
  if (fromRow && fromRow.length) {
    return fromRow
      .map((p) => {
        if (!p || typeof p !== 'object') return null;
        const codeRaw = p.code;
        const code =
          codeRaw == null || codeRaw === ''
            ? null
            : String(codeRaw).trim() || null;
        return {
          code,
          discount: String(p.discount || '').trim() || null,
          when: String(p.when || '').trim() || null,
        };
      })
      .filter(Boolean);
  }
  return [];
}

function resolveBefitProgramSlug(label, aliases = BEFIT_PROGRAM_ALIASES, slugs = BEFIT_PROGRAM_SLUGS) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  let key = raw.toLowerCase().replace(/^\/+/, '');
  key = key.replace(/^programmy\//i, '').replace(/\/+$/, '');
  key = key.replace(/\s+/g, ' ').trim();
  const aliasMap = aliases && typeof aliases === 'object' ? aliases : BEFIT_PROGRAM_ALIASES;
  const slugList = Array.isArray(slugs) && slugs.length ? slugs : BEFIT_PROGRAM_SLUGS;
  const slugSet = new Set(slugList.map((s) => String(s).toLowerCase()));
  const pickAlias = (k) => {
    const mapped = aliasMap[k];
    if (!mapped) return null;
    const m = String(mapped).toLowerCase();
    return slugSet.has(m) ? mapped : null;
  };
  const fromAlias = pickAlias(key) || pickAlias(key.replace(/\s+/g, ''));
  if (fromAlias) return fromAlias;
  if (slugSet.has(key)) return key;
  const compact = key.replace(/\s+/g, '');
  if (slugSet.has(compact)) return compact;
  // Bare verified slug with hyphens/underscores only.
  if (/^[a-z0-9_-]+$/i.test(key) && slugSet.has(key.toLowerCase())) {
    return key.toLowerCase();
  }
  return null;
}

function resolveBefitTargetUrl(label, cfg = {}) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  const slug = resolveBefitProgramSlug(
    raw,
    (cfg && cfg.programAliases) || BEFIT_PROGRAM_ALIASES,
    (cfg && cfg.programSlugs) || BEFIT_PROGRAM_SLUGS
  );
  if (slug) {
    const programPrefix = String(
      (cfg && cfg.programPrefix) || BEFIT_PROGRAM_PREFIX
    ).replace(/\/?$/, '/');
    return `${programPrefix}${slug}/`;
  }
  const prefix = String((cfg && cfg.searchPrefix) || BEFIT_SEARCH_PREFIX);
  return `${prefix}${encodeURIComponent(raw)}`;
}

function resolveBefitDeeplinkConfig(partners) {
  const row =
    findPartnerRow(partners, 'befit') || findPartnerRow(partners, 'letbefit');
  const geoFromPartner = Array.isArray(row && row.geo) ? row.geo : null;
  const cities =
    geoFromPartner && geoFromPartner.length
      ? geoFromPartner.map((c) => String(c || '').trim()).filter(Boolean)
      : BEFIT_GEO_CITIES.slice();
  const cfg = resolveAdmitadDeeplinkConfig({
    partners: row ? [row] : partners,
    partnerId: (row && row.id) || 'befit',
    envBaseKey: 'ADMITAD_BEFIT_BASE',
    envEridKey: 'ADMITAD_BEFIT_ERID',
    defaultBase: DEFAULT_ADMITAD_BEFIT_BASE,
    defaultErid: DEFAULT_ADMITAD_BEFIT_ERID,
    searchPrefix: BEFIT_SEARCH_PREFIX,
  });
  return {
    ...cfg,
    id: 'befit',
    name: String((row && row.name) || 'BeFit'),
    cities,
    tagPrefixes: ['befit', 'letbefit'],
    programPrefix: BEFIT_PROGRAM_PREFIX,
    programSlugs: BEFIT_PROGRAM_SLUGS.slice(),
    programAliases: { ...BEFIT_PROGRAM_ALIASES },
    promos: normalizeBefitPromos(row),
  };
}

function resolveHvalwatersProductSlug(
  label,
  aliases = HVALWATERS_PRODUCT_ALIASES,
  slugs = HVALWATERS_PRODUCT_SLUGS
) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  let key = raw.toLowerCase().replace(/^\/+/, '');
  key = key.replace(/^water\//i, '').replace(/\/+$/, '');
  key = key.replace(/\s+/g, ' ').trim();
  const aliasMap = aliases && typeof aliases === 'object' ? aliases : HVALWATERS_PRODUCT_ALIASES;
  const slugList = Array.isArray(slugs) && slugs.length ? slugs : HVALWATERS_PRODUCT_SLUGS;
  const slugSet = new Set(slugList.map((s) => String(s).toLowerCase()));
  const pickAlias = (k) => {
    const mapped = aliasMap[k];
    if (!mapped) return null;
    const m = String(mapped).toLowerCase();
    return slugSet.has(m) ? mapped : null;
  };
  const fromAlias = pickAlias(key) || pickAlias(key.replace(/\s+/g, ''));
  if (fromAlias) return fromAlias;
  if (slugSet.has(key)) return key;
  const compact = key.replace(/\s+/g, '');
  if (slugSet.has(compact)) return compact;
  if (/^[a-z0-9_-]+$/i.test(key) && slugSet.has(key.toLowerCase())) {
    return key.toLowerCase();
  }
  return null;
}

function resolveHvalwatersTargetUrl(label, cfg = {}) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  const slug = resolveHvalwatersProductSlug(
    raw,
    (cfg && cfg.productAliases) || HVALWATERS_PRODUCT_ALIASES,
    (cfg && cfg.productSlugs) || HVALWATERS_PRODUCT_SLUGS
  );
  if (slug) {
    const productPrefix = String(
      (cfg && cfg.productPrefix) || HVALWATERS_PRODUCT_PREFIX
    ).replace(/\/?$/, '/');
    return `${productPrefix}${slug}/`;
  }
  const prefix = String((cfg && cfg.searchPrefix) || HVALWATERS_SEARCH_PREFIX);
  return `${prefix}${encodeURIComponent(raw)}`;
}

function resolveHvalwatersDeeplinkConfig(partners) {
  const row =
    findPartnerRow(partners, 'hvalwaters') ||
    findPartnerRow(partners, 'hvalovskie-vody') ||
    findPartnerRow(partners, 'hval');
  const geoFromPartner = Array.isArray(row && row.geo) ? row.geo : null;
  const cities =
    geoFromPartner && geoFromPartner.length
      ? geoFromPartner.map((c) => String(c || '').trim()).filter(Boolean)
      : HVALWATERS_GEO_CITIES.slice();
  const cfg = resolveAdmitadDeeplinkConfig({
    partners: row ? [row] : partners,
    partnerId: (row && row.id) || 'hvalwaters',
    envBaseKey: 'ADMITAD_HVALWATERS_BASE',
    envEridKey: 'ADMITAD_HVALWATERS_ERID',
    defaultBase: DEFAULT_ADMITAD_HVALWATERS_BASE,
    defaultErid: DEFAULT_ADMITAD_HVALWATERS_ERID,
    searchPrefix: HVALWATERS_SEARCH_PREFIX,
  });
  const couponRaw = String(
    (row && (row.admitad_coupon_base || row.coupon_admitad_base)) ||
      DEFAULT_ADMITAD_HVALWATERS_COUPON_BASE
  ).trim();
  const couponBase =
    looksLikeAdmitadWebmaster(couponRaw) ? normalizeAdmitadBase(couponRaw) : '';
  return {
    ...cfg,
    id: 'hvalwaters',
    name: String((row && row.name) || 'Хваловская вода'),
    cities,
    tagPrefixes: ['hval', 'water', 'hvalwaters'],
    productPrefix: HVALWATERS_PRODUCT_PREFIX,
    productSlugs: HVALWATERS_PRODUCT_SLUGS.slice(),
    productAliases: { ...HVALWATERS_PRODUCT_ALIASES },
    couponAdmitadBase: couponBase || null,
  };
}

function resolveGrowfoodProgramSlug(
  label,
  aliases = GROWFOOD_PROGRAM_ALIASES,
  slugs = GROWFOOD_PROGRAM_SLUGS
) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  let key = raw.toLowerCase().replace(/^\/+/, '');
  key = key.replace(/^new-order\//i, '').replace(/\/+$/, '');
  key = key.replace(/\s+/g, ' ').trim();
  const aliasMap = aliases && typeof aliases === 'object' ? aliases : GROWFOOD_PROGRAM_ALIASES;
  const slugList = Array.isArray(slugs) && slugs.length ? slugs : GROWFOOD_PROGRAM_SLUGS;
  const slugSet = new Set(slugList.map((s) => String(s).toLowerCase()));
  const pickAlias = (k) => {
    const mapped = aliasMap[k];
    if (!mapped) return null;
    const m = String(mapped).toLowerCase();
    return slugSet.has(m) ? mapped : null;
  };
  const fromAlias = pickAlias(key) || pickAlias(key.replace(/\s+/g, ''));
  if (fromAlias) return fromAlias;
  if (slugSet.has(key)) return key;
  const compact = key.replace(/\s+/g, '');
  if (slugSet.has(compact)) return compact;
  if (/^[a-z0-9_-]+$/i.test(key) && slugSet.has(key.toLowerCase())) {
    return key.toLowerCase();
  }
  return null;
}

function resolveGrowfoodTargetUrl(label, cfg = {}) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  const slug = resolveGrowfoodProgramSlug(
    raw,
    (cfg && cfg.programAliases) || GROWFOOD_PROGRAM_ALIASES,
    (cfg && cfg.programSlugs) || GROWFOOD_PROGRAM_SLUGS
  );
  if (slug) {
    const programPrefix = String(
      (cfg && cfg.programPrefix) || GROWFOOD_PROGRAM_PREFIX
    ).replace(/\/?$/, '/');
    // SPA routes are /new-order/{slug} without trailing slash (Admitad-verified).
    return `${programPrefix}${slug}`;
  }
  return String((cfg && cfg.searchPrefix) || GROWFOOD_CATALOG_URL);
}

function resolveGrowfoodDeeplinkConfig(partners) {
  const row =
    findPartnerRow(partners, 'growfood') ||
    findPartnerRow(partners, 'gf') ||
    findPartnerRow(partners, 'letgrowfood');
  const geoFromPartner = Array.isArray(row && row.geo) ? row.geo : null;
  const cities =
    geoFromPartner && geoFromPartner.length
      ? geoFromPartner.map((c) => String(c || '').trim()).filter(Boolean)
      : GROWFOOD_GEO_CITIES.slice();
  const cfg = resolveAdmitadDeeplinkConfig({
    partners: row ? [row] : partners,
    partnerId: (row && row.id) || 'growfood',
    envBaseKey: 'ADMITAD_GROWFOOD_BASE',
    envEridKey: 'ADMITAD_GROWFOOD_ERID',
    defaultBase: DEFAULT_ADMITAD_GROWFOOD_BASE,
    defaultErid: DEFAULT_ADMITAD_GROWFOOD_ERID,
    searchPrefix: GROWFOOD_SEARCH_PREFIX,
  });
  return {
    ...cfg,
    id: 'growfood',
    name: String((row && row.name) || 'GrowFood'),
    cities,
    tagPrefixes: ['growfood', 'gf'],
    programPrefix: GROWFOOD_PROGRAM_PREFIX,
    programSlugs: GROWFOOD_PROGRAM_SLUGS.slice(),
    programAliases: { ...GROWFOOD_PROGRAM_ALIASES },
    promos: normalizeBefitPromos(row),
  };
}

/** Keep room for multi-paragraph ration replies; 1024 was cutting mid-thought. */
const MAX_OUTPUT_TOKENS = Math.min(
  Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192, 1024),
  16384
);
/** Extra continues so mid-word cutoffs (MAX_TOKENS / thinking budget) still finish. */
const MAX_CONTINUES = 3;
/** Retries per model on overload before switching to the next fallback. */
const OVERLOAD_RETRIES = Math.min(
  Math.max(Number(process.env.GEMINI_OVERLOAD_RETRIES) || 2, 0),
  5
);
const OVERLOAD_BACKOFF_MS = Math.min(
  Math.max(Number(process.env.GEMINI_OVERLOAD_BACKOFF_MS) || 800, 200),
  8000
);

/** Primary + fallbacks. Override with GEMINI_MODEL_CHAIN=a,b,c or GEMINI_FALLBACK_MODELS=b,c */
function parseModelChain() {
  const split = (value) =>
    String(value || '')
      .split(/[,|]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const fromChain = split(process.env.GEMINI_MODEL_CHAIN);
  if (fromChain.length) return [...new Set(fromChain)];

  const fallbacks = split(process.env.GEMINI_FALLBACK_MODELS);
  const tail = fallbacks.length ? fallbacks : DEFAULT_FALLBACK_MODELS;
  return [...new Set([GEMINI_MODEL, ...tail])];
}

const GEMINI_MODEL_CHAIN = parseModelChain();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geminiKeyStatus() {
  const has1 = GEMINI_KEY_SLOTS.some((s) => s.id === 1);
  const has2 = GEMINI_KEY_SLOTS.some((s) => s.id === 2);
  return {
    key1: has1 ? 'configured' : 'missing',
    key2: has2 ? 'configured' : 'missing',
    activeKey: activeGeminiKeyId,
    failoverReady: has1 && has2,
  };
}

function getGeminiKeySlot(id) {
  return GEMINI_KEY_SLOTS.find((s) => s.id === id) || null;
}

function orderedGeminiKeySlots() {
  if (!GEMINI_KEY_SLOTS.length) return [];
  const primary = getGeminiKeySlot(activeGeminiKeyId) || GEMINI_KEY_SLOTS[0];
  const rest = GEMINI_KEY_SLOTS.filter((s) => s.id !== primary.id);
  return [primary, ...rest];
}

function geminiStreamUrl(model, apiKey) {
  const key = apiKey || GEMINI_API_KEY;
  return `${GEMINI_API_ORIGIN}/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
}

/** True for high-demand / capacity errors that may clear after backoff or a lighter model. */
function isOverloadError(status, code, message) {
  const blob = `${code || ''} ${message || ''}`;
  if (status === 503) return true;
  if (/UNAVAILABLE|high demand|overloaded|try again later/i.test(blob)) return true;
  return false;
}

/** Errors that justify one switch to the other API key. */
function isKeyFailoverError(status, code, message) {
  if (!status) return true;
  const blob = `${code || ''} ${message || ''}`;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate/i.test(blob)) return true;
  if (isOverloadError(status, code, message)) return true;
  if (status === 400 && /FAILED_PRECONDITION|location is not supported/i.test(blob)) return true;
  return false;
}

const ROOT = __dirname;
const PROMPT_PATH = path.join(ROOT, 'prompt.txt');
const PARTNERS_PATH = path.join(ROOT, 'partners.json');
/** Kill switch on disk (survives PM2 restart). Missing file = service ON. Not in git — live state. */
const SERVICE_PATH = path.join(ROOT, 'service.json');
const ADMIN_HTML_PATH = path.join(ROOT, 'admin.html');
const SERVICE_DISABLED_USER_MESSAGE = 'Сервис временно недоступен';

/**
 * Hot-reload from disk on each use (mtime cache). Admin saves invalidate immediately.
 * Do not keep a forever-cached copy from process start.
 */
const fileCache = {
  prompt: { mtimeMs: -1, value: '' },
  partners: { mtimeMs: -1, value: [] },
  cityIndex: { mtimeMs: -1, value: null },
  service: { mtimeMs: -1, value: true },
};

function invalidateContentCache() {
  fileCache.prompt.mtimeMs = -1;
  fileCache.partners.mtimeMs = -1;
  fileCache.cityIndex.mtimeMs = -1;
  fileCache.service.mtimeMs = -1;
}

/**
 * Kill-switch flag. Missing/corrupt file → enabled (service ON).
 * @returns {boolean}
 */
function isServiceEnabled() {
  try {
    const st = fs.statSync(SERVICE_PATH);
    if (st.mtimeMs !== fileCache.service.mtimeMs) {
      let enabled = true;
      try {
        const raw = JSON.parse(fs.readFileSync(SERVICE_PATH, 'utf8'));
        if (raw && typeof raw.enabled === 'boolean') {
          enabled = raw.enabled;
        }
      } catch {
        enabled = true;
      }
      fileCache.service = { mtimeMs: st.mtimeMs, value: enabled };
    }
    return fileCache.service.value;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fileCache.service = { mtimeMs: 0, value: true };
      return true;
    }
    console.warn('[service] read failed — treating as enabled', err?.message || err);
    return true;
  }
}

/**
 * Persist kill switch; refreshes mtime cache.
 * @param {boolean} enabled
 * @returns {boolean}
 */
function setServiceEnabled(enabled) {
  const on = Boolean(enabled);
  const out = `${JSON.stringify({ enabled: on }, null, 2)}\n`;
  fs.writeFileSync(SERVICE_PATH, out, 'utf8');
  const st = fs.statSync(SERVICE_PATH);
  fileCache.service = { mtimeMs: st.mtimeMs, value: on };
  console.info(`[service] kill switch → enabled=${on}`);
  return on;
}

function loadSystemPrompt() {
  const st = fs.statSync(PROMPT_PATH);
  if (st.mtimeMs !== fileCache.prompt.mtimeMs) {
    fileCache.prompt = {
      mtimeMs: st.mtimeMs,
      value: fs.readFileSync(PROMPT_PATH, 'utf8'),
    };
  }
  return fileCache.prompt.value;
}

function loadPartners() {
  const st = fs.statSync(PARTNERS_PATH);
  if (st.mtimeMs !== fileCache.partners.mtimeMs) {
    fileCache.partners = {
      mtimeMs: st.mtimeMs,
      value: JSON.parse(fs.readFileSync(PARTNERS_PATH, 'utf8')),
    };
    fileCache.cityIndex.mtimeMs = -1;
  }
  const value = fileCache.partners.value;
  return Array.isArray(value) ? value : [];
}


/** Bootstrap once so a missing/corrupt file fails at startup, not mid-chat. */
loadSystemPrompt();
loadPartners();

// Deeplink bases from current partners.json (restart or admin-save+process refresh not required for prompt/partner pool;
// Admitad bases refresh on next process start — rare).
const VKUSVILL_DEEPLINK = resolveVkusvillDeeplinkConfig(loadPartners());
const VIPFISH_DEEPLINK = resolveVipfishDeeplinkConfig(loadPartners());
const AUCHAN_DEEPLINK = resolveAuchanDeeplinkConfig(loadPartners());
const BEFIT_DEEPLINK = resolveBefitDeeplinkConfig(loadPartners());
const HVALWATERS_DEEPLINK = resolveHvalwatersDeeplinkConfig(loadPartners());
const GROWFOOD_DEEPLINK = resolveGrowfoodDeeplinkConfig(loadPartners());

/**
 * Quiet chat-mode overlays (надстройки) — loaded from modes/*.json at startup.
 * Explicit UI choice is primary; keyword/regex detect is only a fallback for «Обычный».
 * Registry + detect rules are rebuilt by loadModes(); mutated in place so exports stay live.
 */
const MODES_DIR = path.join(ROOT, 'modes');
const CHAT_MODES = Object.create(null);
const MODE_IDS = [];
/** @type {{ id: string, detect: string[], re: RegExp|null }[]} */
const MODE_DETECT = [];

function clearModeRegistry() {
  for (const key of Object.keys(CHAT_MODES)) delete CHAT_MODES[key];
  MODE_IDS.length = 0;
  MODE_DETECT.length = 0;
}

/**
 * Read modes/*.json (A→Z). Skip invalid files (no id/label, bad JSON/regex) with a log — never crash.
 * Builds CHAT_MODES registry and MODE_DETECT rules in file order.
 */
function loadModes() {
  clearModeRegistry();
  let names = [];
  try {
    names = fs
      .readdirSync(MODES_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.warn('[modes] cannot read modes/:', err?.message || err);
    return MODE_IDS.slice();
  }

  for (const name of names) {
    const filePath = path.join(MODES_DIR, name);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.warn(`[modes] skip ${name}: read failed (${err?.message || err})`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.warn(`[modes] skip ${name}: invalid JSON (${err?.message || err})`);
      continue;
    }

    if (!data || typeof data !== 'object') {
      console.warn(`[modes] skip ${name}: not an object`);
      continue;
    }

    const id = String(data.id || '')
      .trim()
      .toLowerCase();
    const label = String(data.label || '').trim();
    if (!id || !label) {
      console.warn(`[modes] skip ${name}: missing id/label`);
      continue;
    }

    if (CHAT_MODES[id]) {
      console.warn(`[modes] skip ${name}: duplicate id "${id}"`);
      continue;
    }

    const overlay = typeof data.overlay === 'string' ? data.overlay : '';
    const detect = Array.isArray(data.detect)
      ? data.detect.map((w) => String(w || '').trim()).filter(Boolean)
      : [];

    let re = null;
    if (data.detect_regex != null && String(data.detect_regex).trim()) {
      try {
        re = new RegExp(String(data.detect_regex), 'i');
      } catch (err) {
        console.warn(`[modes] skip ${name}: bad detect_regex (${err?.message || err})`);
        continue;
      }
    }

    CHAT_MODES[id] = { id, label, overlay };
    MODE_IDS.push(id);
    MODE_DETECT.push({ id, detect, re });
  }

  if (!CHAT_MODES.normal) {
    CHAT_MODES.normal = { id: 'normal', label: 'Обычный', overlay: '' };
    MODE_IDS.unshift('normal');
    MODE_DETECT.unshift({ id: 'normal', detect: [], re: null });
    console.warn('[modes] normal.json missing — injected default «Обычный»');
  }

  console.info(`[modes] loaded ${MODE_IDS.length}: ${MODE_IDS.join(', ')}`);
  return MODE_IDS.slice();
}

loadModes();

function normalizeModeId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase();
  return MODE_IDS.includes(id) ? id : 'normal';
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function modeMatchesText(rule, text) {
  if (!rule || !text) return false;
  const lower = text.toLowerCase();
  for (const word of rule.detect || []) {
    if (word && lower.includes(word.toLowerCase())) return true;
  }
  if (rule.re && rule.re.test(text)) return true;
  return false;
}

/**
 * Resolve active mode from loaded registry only.
 * Explicit UI id wins; if «normal», scan MODE_DETECT in file order (detect words then detect_regex).
 * @returns {{ id: string, label: string, overlay: string, source: 'explicit'|'detected'|'default' }}
 */
function resolveChatMode(rawMode, messages) {
  const explicit = normalizeModeId(rawMode);
  if (explicit !== 'normal') {
    const mode = CHAT_MODES[explicit];
    return { id: mode.id, label: mode.label, overlay: mode.overlay, source: 'explicit' };
  }

  const text = lastUserText(messages);
  if (text) {
    for (const rule of MODE_DETECT) {
      if (rule.id === 'normal') continue;
      if (modeMatchesText(rule, text)) {
        const mode = CHAT_MODES[rule.id];
        if (mode) {
          return { id: mode.id, label: mode.label, overlay: mode.overlay, source: 'detected' };
        }
      }
    }
  }

  const mode = CHAT_MODES.normal;
  return { id: mode.id, label: mode.label, overlay: mode.overlay, source: 'default' };
}

function modeOverlayBlock(mode) {
  if (!mode?.overlay) return '';
  return `

Контекст режима (надстройка; характер тот же, только акцент ответа):
${mode.overlay}`;
}

app.use(express.json({ limit: '256kb' }));

/** PWA manifest: correct MIME for Chromium install / home-screen icons. */
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(ROOT, 'public', 'manifest.webmanifest'));
});

/**
 * SEO: robots + sitemap must return 200 text/xml — never SPA HTML and never
 * a redirect. Explicit routes stay ahead of express.static and the `*` catch-all.
 * Nginx must also proxy these on :80 without HTTPS 301 (see deploy/nginx-nutricode.conf).
 */
app.get('/robots.txt', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('text/plain; charset=utf-8');
  res.sendFile(path.join(ROOT, 'public', 'robots.txt'));
});

app.get('/sitemap.xml', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('application/xml; charset=utf-8');
  res.sendFile(path.join(ROOT, 'public', 'sitemap.xml'));
});

app.use(express.static(path.join(ROOT, 'public')));

const STATS_CHANNEL = 'nutrikod:stats';
const STATS_ALERT_TTL_MS = 15 * 60 * 1000;
const SITE_STARTED_AT = Date.now();

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function createLocalStats() {
  return {
    day: dayKey(),
    successToday: 0,
    errorsToday: 0,
    warning: null,
  };
}

/** In-process stats for single-worker / tests; cluster workers proxy to master. */
const localStats = createLocalStats();

function rollLocalStatsDay() {
  const today = dayKey();
  if (localStats.day !== today) {
    localStats.day = today;
    localStats.successToday = 0;
    localStats.errorsToday = 0;
  }
}

function applyLocalStatOp(op, payload = {}) {
  rollLocalStatsDay();
  if (op === 'success') {
    localStats.successToday += 1;
    return snapshotLocalStats();
  }
  if (op === 'error') {
    localStats.errorsToday += 1;
    const kind = String(payload.kind || 'error');
    const alert =
      kind === 'rate_limit' || kind === 'overload' || kind === 'outage' || kind === 'auth';
    if (alert) {
      localStats.warning = {
        active: true,
        kind,
        message: String(payload.message || defaultWarningMessage(kind)),
        at: Date.now(),
      };
    }
    return snapshotLocalStats();
  }
  return snapshotLocalStats();
}

function defaultWarningMessage(kind) {
  if (kind === 'rate_limit') return 'Gemini: лимит запросов / квота (429).';
  if (kind === 'overload') return 'Gemini: перегрузка / 503 — модель временно недоступна.';
  if (kind === 'outage') return 'Gemini: сбой связи с API.';
  if (kind === 'auth') return 'Gemini: проблема с ключом API (401/403).';
  return 'Gemini: ошибка API.';
}

function snapshotLocalStats() {
  rollLocalStatsDay();
  const warning =
    localStats.warning && Date.now() - localStats.warning.at <= STATS_ALERT_TTL_MS
      ? { ...localStats.warning, active: true }
      : { active: false };
  if (!warning.active) localStats.warning = null;
  return {
    successToday: localStats.successToday,
    errorsToday: localStats.errorsToday,
    warning,
    startedAt: SITE_STARTED_AT,
  };
}

function classifyGeminiFailure(status, code, message) {
  const blob = `${code || ''} ${message || ''}`;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate/i.test(blob)) return 'rate_limit';
  if (isOverloadError(status, code, message)) return 'overload';
  if (
    status === 401 ||
    status === 403 ||
    /API[_\s-]?KEY|PERMISSION|UNAUTHENTICATED|not valid/i.test(blob)
  ) {
    return 'auth';
  }
  if (!status || status >= 500) return 'outage';
  return 'error';
}

let statsIpcSeq = 0;
const statsIpcPending = new Map();

if (cluster.isWorker) {
  process.on('message', (msg) => {
    if (!msg || msg.channel !== STATS_CHANNEL || msg.id == null) return;
    const settle = statsIpcPending.get(msg.id);
    if (!settle) return;
    statsIpcPending.delete(msg.id);
    settle(msg.result);
  });
}

function statsCall(op, payload = {}) {
  if (!cluster.isWorker || typeof process.send !== 'function') {
    return Promise.resolve(applyLocalStatOp(op, payload));
  }
  return new Promise((resolve, reject) => {
    const id = ++statsIpcSeq;
    const timer = setTimeout(() => {
      statsIpcPending.delete(id);
      reject(new Error('cluster stats IPC timeout'));
    }, 3000);
    statsIpcPending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    process.send({ channel: STATS_CHANNEL, op, payload, id });
  });
}

async function recordChatSuccess() {
  try {
    await statsCall('success');
  } catch (err) {
    console.warn('[stats] success record failed', err?.message || err);
  }
}

async function recordChatError(kind, message) {
  try {
    await statsCall('error', { kind, message });
  } catch (err) {
    console.warn('[stats] error record failed', err?.message || err);
  }
}

async function readAdminStats() {
  const base = await statsCall('get');
  const load = os.loadavg();
  const keys = geminiKeyStatus();
  return {
    load1: load[0],
    load5: load[1],
    load15: load[2],
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
    uptimeSec: Math.floor((Date.now() - (base.startedAt || SITE_STARTED_AT)) / 1000),
    processUptimeSec: Math.floor(process.uptime()),
    successToday: base.successToday || 0,
    errorsToday: base.errorsToday || 0,
    warning: base.warning || { active: false },
    day: dayKey(),
    // Status only — never key values.
    geminiKeys: keys,
    activeGeminiKey: keys.activeKey,
  };
}

/** Master-side admin stats IPC (shared across workers). */
function attachClusterStatsMaster() {
  const masterStats = createLocalStats();
  const masterStartedAt = SITE_STARTED_AT;

  const roll = () => {
    const today = dayKey();
    if (masterStats.day !== today) {
      masterStats.day = today;
      masterStats.successToday = 0;
      masterStats.errorsToday = 0;
    }
  };

  const snapshot = () => {
    roll();
    const warning =
      masterStats.warning && Date.now() - masterStats.warning.at <= STATS_ALERT_TTL_MS
        ? { ...masterStats.warning, active: true }
        : { active: false };
    if (!warning.active) masterStats.warning = null;
    return {
      successToday: masterStats.successToday,
      errorsToday: masterStats.errorsToday,
      warning,
      startedAt: masterStartedAt,
    };
  };

  const apply = (op, payload = {}) => {
    roll();
    if (op === 'success') {
      masterStats.successToday += 1;
      return snapshot();
    }
    if (op === 'error') {
      masterStats.errorsToday += 1;
      const kind = String(payload.kind || 'error');
      if (kind === 'rate_limit' || kind === 'overload' || kind === 'outage' || kind === 'auth') {
        masterStats.warning = {
          active: true,
          kind,
          message: String(payload.message || defaultWarningMessage(kind)),
          at: Date.now(),
        };
      }
      return snapshot();
    }
    return snapshot();
  };

  const reply = (worker, id, result) => {
    try {
      worker.send({ channel: STATS_CHANNEL, id, result });
    } catch {
      /* worker gone */
    }
  };

  const handle = (worker, msg) => {
    if (!msg || msg.channel !== STATS_CHANNEL) return;
    reply(worker, msg.id, apply(msg.op, msg.payload || {}));
  };

  cluster.on('fork', (worker) => {
    worker.on('message', (msg) => handle(worker, msg));
  });
}

/**
 * Smart chat flood guard (no hard day-cap):
 * ~12/min + ~25 / 5 min per IP. Honest planners stay fine; scripts get clipped.
 */
const CHAT_RATE_MINUTE_WINDOW_MS = Math.max(
  Number(process.env.CHAT_RATE_MINUTE_WINDOW_MS) || 60 * 1000,
  1000
);
const CHAT_RATE_MINUTE_MAX = Math.max(Number(process.env.CHAT_RATE_MINUTE_MAX) || 12, 1);
const CHAT_RATE_BURST_WINDOW_MS = Math.max(
  Number(process.env.CHAT_RATE_BURST_WINDOW_MS) || 5 * 60 * 1000,
  1000
);
const CHAT_RATE_BURST_MAX = Math.max(Number(process.env.CHAT_RATE_BURST_MAX) || 25, 1);
/** Align server + UI (~2000–4000). Default 4000 matches maxlength. */
const MAX_MESSAGE_CHARS = Math.min(
  Math.max(Number(process.env.MAX_MESSAGE_CHARS) || 4000, 500),
  8000
);
/** Global Gemini in-flight ceiling shared by site + bot (same wallet). */
const GEMINI_CONCURRENCY_MAX = Math.min(
  Math.max(Number(process.env.GEMINI_CONCURRENCY_MAX) || 4, 1),
  20
);
const GEMINI_BUSY_USER_MESSAGE =
  'Сейчас много запросов, подождите минуту.';
const RL_CHANNEL = 'nutrikod:rl';
const GEMINI_SLOT_CHANNEL = 'nutrikod:gemini-slot';

/**
 * Rate-limit counters live in the master so every worker shares one budget per IP + window.
 * Workers talk to master over cluster IPC; single-process / tests keep the default MemoryStore.
 */
function createClusterRateLimitStore(windowMs) {
  let seq = 0;
  const pending = new Map();
  const win = Math.max(Number(windowMs) || 60000, 1000);

  process.on('message', (msg) => {
    if (!msg || msg.channel !== RL_CHANNEL || msg.id == null) return;
    const settle = pending.get(msg.id);
    if (!settle) return;
    pending.delete(msg.id);
    settle(msg.result);
  });

  function call(op, key) {
    return new Promise((resolve, reject) => {
      if (typeof process.send !== 'function') {
        reject(new Error('cluster rate-limit store needs process.send'));
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('cluster rate-limit IPC timeout'));
      }, 3000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      process.send({ channel: RL_CHANNEL, op, key, id, windowMs: win });
    });
  }

  return {
    async increment(key) {
      const result = await call('increment', key);
      return {
        totalHits: result.totalHits,
        resetTime: result.resetTime ? new Date(result.resetTime) : undefined,
      };
    },
    async decrement(key) {
      await call('decrement', key);
    },
    async resetKey(key) {
      await call('resetKey', key);
    },
    async get(key) {
      const result = await call('get', key);
      if (!result) return undefined;
      return {
        totalHits: result.totalHits,
        resetTime: result.resetTime ? new Date(result.resetTime) : undefined,
      };
    },
  };
}

/** Master-side maps for createClusterRateLimitStore IPC (one bucket map per windowMs). */
function attachClusterRateLimitMaster() {
  /** @type {Map<number, Map<string, {hits:number, resetTime:number}>>} */
  const byWindow = new Map();

  const reply = (worker, id, result) => {
    try {
      worker.send({ channel: RL_CHANNEL, id, result });
    } catch {
      /* worker already gone */
    }
  };

  const bucketFor = (windowMs, key, now) => {
    const win = Math.max(Number(windowMs) || 60000, 1000);
    let buckets = byWindow.get(win);
    if (!buckets) {
      buckets = new Map();
      byWindow.set(win, buckets);
    }
    let entry = buckets.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { hits: 0, resetTime: now + win };
      buckets.set(key, entry);
    }
    return { buckets, entry, win };
  };

  const handle = (worker, msg) => {
    if (!msg || msg.channel !== RL_CHANNEL) return;
    const now = Date.now();
    const key = String(msg.key || '');
    const { buckets, entry } = bucketFor(msg.windowMs, key, now);

    if (msg.op === 'increment') {
      entry.hits += 1;
      reply(worker, msg.id, { totalHits: entry.hits, resetTime: entry.resetTime });
      return;
    }
    if (msg.op === 'decrement') {
      entry.hits = Math.max(0, entry.hits - 1);
      reply(worker, msg.id, {});
      return;
    }
    if (msg.op === 'resetKey') {
      buckets.delete(key);
      reply(worker, msg.id, {});
      return;
    }
    if (msg.op === 'get') {
      reply(
        worker,
        msg.id,
        entry ? { totalHits: entry.hits, resetTime: entry.resetTime } : null
      );
    }
  };

  cluster.on('fork', (worker) => {
    worker.on('message', (msg) => handle(worker, msg));
  });
}

/** Shared Gemini concurrency counter across workers (site + bot). */
function attachClusterGeminiSlotMaster() {
  let inFlight = 0;

  const reply = (worker, id, result) => {
    try {
      worker.send({ channel: GEMINI_SLOT_CHANNEL, id, result });
    } catch {
      /* worker gone */
    }
  };

  const handle = (worker, msg) => {
    if (!msg || msg.channel !== GEMINI_SLOT_CHANNEL) return;
    if (msg.op === 'acquire') {
      if (inFlight >= GEMINI_CONCURRENCY_MAX) {
        reply(worker, msg.id, { ok: false, inFlight });
        return;
      }
      inFlight += 1;
      reply(worker, msg.id, { ok: true, inFlight });
      return;
    }
    if (msg.op === 'release') {
      inFlight = Math.max(0, inFlight - 1);
      reply(worker, msg.id, { ok: true, inFlight });
    }
  };

  cluster.on('fork', (worker) => {
    worker.on('message', (msg) => handle(worker, msg));
  });
}

let localGeminiInFlight = 0;
let geminiSlotSeq = 0;
const geminiSlotPending = new Map();

if (cluster.isWorker) {
  process.on('message', (msg) => {
    if (!msg || msg.channel !== GEMINI_SLOT_CHANNEL || msg.id == null) return;
    const settle = geminiSlotPending.get(msg.id);
    if (!settle) return;
    geminiSlotPending.delete(msg.id);
    settle(msg.result);
  });
}

function callGeminiSlotMaster(op) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('cluster gemini-slot needs process.send'));
      return;
    }
    const id = ++geminiSlotSeq;
    const timer = setTimeout(() => {
      geminiSlotPending.delete(id);
      reject(new Error('cluster gemini-slot IPC timeout'));
    }, 3000);
    geminiSlotPending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    process.send({ channel: GEMINI_SLOT_CHANNEL, op, id });
  });
}

/** Acquire one global Gemini thinking slot. false = busy. */
async function acquireGeminiSlot() {
  if (cluster.isWorker && typeof process.send === 'function') {
    try {
      const result = await callGeminiSlotMaster('acquire');
      return Boolean(result && result.ok);
    } catch (err) {
      console.warn('[gemini] slot acquire IPC failed — allowing request', err?.message || err);
      return true;
    }
  }
  if (localGeminiInFlight >= GEMINI_CONCURRENCY_MAX) return false;
  localGeminiInFlight += 1;
  return true;
}

async function releaseGeminiSlot() {
  if (cluster.isWorker && typeof process.send === 'function') {
    try {
      await callGeminiSlotMaster('release');
    } catch (err) {
      console.warn('[gemini] slot release IPC failed', err?.message || err);
    }
    return;
  }
  localGeminiInFlight = Math.max(0, localGeminiInFlight - 1);
}

const chatRateLimitMessage = {
  type: 'error',
  text: 'Вы слишком часто общаетесь с ИИ, подождите немного',
};

function makeChatLimiter(windowMs, max) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Two limiters stacked on /api/chat (1min + 5min) — intentional; silence ERR_ERL_DOUBLE_COUNT.
    validate: { singleCount: false },
    ...(cluster.isWorker ? { store: createClusterRateLimitStore(windowMs) } : {}),
    message: chatRateLimitMessage,
  });
}

const chatLimiterMinute = makeChatLimiter(CHAT_RATE_MINUTE_WINDOW_MS, CHAT_RATE_MINUTE_MAX);
const chatLimiterBurst = makeChatLimiter(CHAT_RATE_BURST_WINDOW_MS, CHAT_RATE_BURST_MAX);
app.get('/api/modes', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(MODE_IDS.map((id) => ({ id, label: CHAT_MODES[id].label })));
});

app.get('/api/config', (_req, res) => {
  res.json({
    hasKey: Boolean(GEMINI_API_KEY),
    serviceEnabled: isServiceEnabled(),
    communityVkUrl: COMMUNITY_VK_URL,
    yandexMetrikaId: YANDEX_METRIKA_ID || null,
    brand: 'НутриКод',
    model: GEMINI_MODEL,
    modelChain: GEMINI_MODEL_CHAIN,
    modes: MODE_IDS.map((id) => ({ id, label: CHAT_MODES[id].label })),
    /** Public marking + webmaster deeplink base (semi-public); no private Admitad credentials. */
    vkusvillDeeplink: {
      enabled: VKUSVILL_DEEPLINK.enabled,
      admitadBase: VKUSVILL_DEEPLINK.admitadBase,
      erid: VKUSVILL_DEEPLINK.erid,
      searchPrefix: VKUSVILL_DEEPLINK.searchPrefix,
      disclaimer: VKUSVILL_DEEPLINK.disclaimer,
      legalName: VKUSVILL_DEEPLINK.legalName,
      inn: VKUSVILL_DEEPLINK.inn,
    },
    /** Важная рыба (vipfish.ru) — СПб зона; chips via [[vipfish:…]] / [[ryba:…]]. */
    vipfishDeeplink: {
      enabled: VIPFISH_DEEPLINK.enabled,
      admitadBase: VIPFISH_DEEPLINK.admitadBase,
      erid: VIPFISH_DEEPLINK.erid,
      searchPrefix: VIPFISH_DEEPLINK.searchPrefix,
      cities: VIPFISH_DEEPLINK.cities,
      tagPrefixes: VIPFISH_DEEPLINK.tagPrefixes,
      disclaimer: VIPFISH_DEEPLINK.disclaimer,
      legalName: VIPFISH_DEEPLINK.legalName,
      inn: VIPFISH_DEEPLINK.inn,
      name: VIPFISH_DEEPLINK.name,
    },
    /** BeFit (letbefit.ru) — MSK+SPb; chips via [[befit:…]] / [[letbefit:…]]. */
    befitDeeplink: {
      enabled: BEFIT_DEEPLINK.enabled,
      admitadBase: BEFIT_DEEPLINK.admitadBase,
      erid: BEFIT_DEEPLINK.erid,
      searchPrefix: BEFIT_DEEPLINK.searchPrefix,
      programPrefix: BEFIT_DEEPLINK.programPrefix,
      programSlugs: BEFIT_DEEPLINK.programSlugs,
      programAliases: BEFIT_DEEPLINK.programAliases,
      cities: BEFIT_DEEPLINK.cities,
      tagPrefixes: BEFIT_DEEPLINK.tagPrefixes,
      disclaimer: BEFIT_DEEPLINK.disclaimer,
      legalName: BEFIT_DEEPLINK.legalName,
      inn: BEFIT_DEEPLINK.inn,
      name: BEFIT_DEEPLINK.name,
    },
    /** Хваловская вода (hvalwaters.ru) — MSK+SPb; chips [[hval:…]] / [[water:…]] / [[hvalwaters:…]]. */
    hvalwatersDeeplink: {
      enabled: HVALWATERS_DEEPLINK.enabled,
      admitadBase: HVALWATERS_DEEPLINK.admitadBase,
      erid: HVALWATERS_DEEPLINK.erid,
      searchPrefix: HVALWATERS_DEEPLINK.searchPrefix,
      productPrefix: HVALWATERS_DEEPLINK.productPrefix,
      productSlugs: HVALWATERS_DEEPLINK.productSlugs,
      productAliases: HVALWATERS_DEEPLINK.productAliases,
      cities: HVALWATERS_DEEPLINK.cities,
      tagPrefixes: HVALWATERS_DEEPLINK.tagPrefixes,
      couponAdmitadBase: HVALWATERS_DEEPLINK.couponAdmitadBase,
      disclaimer: HVALWATERS_DEEPLINK.disclaimer,
      legalName: HVALWATERS_DEEPLINK.legalName,
      inn: HVALWATERS_DEEPLINK.inn,
      name: HVALWATERS_DEEPLINK.name,
    },
    /** GrowFood (growfood.pro) — MSK+SPb; chips [[growfood:…]] / [[gf:…]]. */
    growfoodDeeplink: {
      enabled: GROWFOOD_DEEPLINK.enabled,
      admitadBase: GROWFOOD_DEEPLINK.admitadBase,
      erid: GROWFOOD_DEEPLINK.erid,
      searchPrefix: GROWFOOD_DEEPLINK.searchPrefix,
      programPrefix: GROWFOOD_DEEPLINK.programPrefix,
      programSlugs: GROWFOOD_DEEPLINK.programSlugs,
      programAliases: GROWFOOD_DEEPLINK.programAliases,
      cities: GROWFOOD_DEEPLINK.cities,
      tagPrefixes: GROWFOOD_DEEPLINK.tagPrefixes,
      disclaimer: GROWFOOD_DEEPLINK.disclaimer,
      legalName: GROWFOOD_DEEPLINK.legalName,
      inn: GROWFOOD_DEEPLINK.inn,
      name: GROWFOOD_DEEPLINK.name,
    },
    /** Ашан (auchan.ru) — hypermarkets MSK/SPb+RF; chips [[auchan:…]] / [[ashan:…]]. */
    auchanDeeplink: {
      enabled: AUCHAN_DEEPLINK.enabled,
      admitadBase: AUCHAN_DEEPLINK.admitadBase,
      erid: AUCHAN_DEEPLINK.erid,
      searchPrefix: AUCHAN_DEEPLINK.searchPrefix,
      productPrefix: AUCHAN_DEEPLINK.productPrefix,
      cities: AUCHAN_DEEPLINK.cities,
      tagPrefixes: AUCHAN_DEEPLINK.tagPrefixes,
      disclaimer: AUCHAN_DEEPLINK.disclaimer,
      legalName: AUCHAN_DEEPLINK.legalName,
      inn: AUCHAN_DEEPLINK.inn,
      name: AUCHAN_DEEPLINK.name,
      /** First-order landing (not search ulp); separate erid from admitadBase. */
      firstOrder: AUCHAN_DEEPLINK.firstOrder
        ? {
            link: AUCHAN_DEEPLINK.firstOrder.link,
            erid: AUCHAN_DEEPLINK.firstOrder.erid,
            minOrderRub: AUCHAN_DEEPLINK.firstOrder.minOrderRub,
            discountHint: AUCHAN_DEEPLINK.firstOrder.discountHint,
            hint: AUCHAN_DEEPLINK.firstOrder.hint,
            cta: AUCHAN_DEEPLINK.firstOrder.cta,
          }
        : null,
    },
  });
});

/** Shared Admitad ulp builder: searchPrefix + name → &ulp=encodeURIComponent(target). */
function buildAdmitadUlpUrl(productName, cfg) {
  const name = String(productName || '').trim();
  const base = normalizeAdmitadBase(cfg && cfg.admitadBase);
  const prefix = String((cfg && cfg.searchPrefix) || '').trim();
  if (!name || !base || !prefix) return null;
  const target = `${prefix}${encodeURIComponent(name)}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ulp=${encodeURIComponent(target)}`;
}

/** Exported for scripts/verify-*-deeplink.js */
function buildVkusvillAdmitadUrl(productName, cfg = VKUSVILL_DEEPLINK) {
  return buildAdmitadUlpUrl(productName, {
    ...(cfg || {}),
    searchPrefix: (cfg && cfg.searchPrefix) || VKUSVILL_SEARCH_PREFIX,
  });
}

function buildVipfishAdmitadUrl(productName, cfg = VIPFISH_DEEPLINK) {
  return buildAdmitadUlpUrl(productName, {
    ...(cfg || {}),
    searchPrefix: (cfg && cfg.searchPrefix) || VIPFISH_SEARCH_PREFIX,
  });
}

/** Ашан: product/{slug}/ → /product/{slug}/; else search ?query=. */
function buildAuchanAdmitadUrl(label, cfg = AUCHAN_DEEPLINK) {
  const target = resolveAuchanTargetUrl(label, cfg || AUCHAN_DEEPLINK);
  const base = normalizeAdmitadBase(cfg && cfg.admitadBase);
  if (!target || !base) return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ulp=${encodeURIComponent(target)}`;
}

/** BeFit: program slug → /programmy/{slug}/; else WP search ?s=. */
function buildBefitAdmitadUrl(label, cfg = BEFIT_DEEPLINK) {
  const target = resolveBefitTargetUrl(label, cfg || BEFIT_DEEPLINK);
  const base = normalizeAdmitadBase(cfg && cfg.admitadBase);
  if (!target || !base) return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ulp=${encodeURIComponent(target)}`;
}

/** Hvalwaters: product slug → /water/{slug}/; else WP search ?s=. */
function buildHvalwatersAdmitadUrl(label, cfg = HVALWATERS_DEEPLINK) {
  const target = resolveHvalwatersTargetUrl(label, cfg || HVALWATERS_DEEPLINK);
  const base = normalizeAdmitadBase(cfg && cfg.admitadBase);
  if (!target || !base) return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ulp=${encodeURIComponent(target)}`;
}

/** GrowFood: program slug → /new-order/{slug}; else order hub /new-order/. */
function buildGrowfoodAdmitadUrl(label, cfg = GROWFOOD_DEEPLINK) {
  const target = resolveGrowfoodTargetUrl(label, cfg || GROWFOOD_DEEPLINK);
  const base = normalizeAdmitadBase(cfg && cfg.admitadBase);
  if (!target || !base) return null;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ulp=${encodeURIComponent(target)}`;
}

/**
 * Parse [[chip]] inner text the same way as public/script.js parseProductTag.
 * @returns {{kind:string,label:string,store:string|null}|null}
 */
function parseBotProductTag(inner) {
  const raw = String(inner || '').trim();
  if (!raw) return null;
  if (/^\s*partner\s*:/i.test(raw)) {
    return { kind: 'partner', label: raw, store: null };
  }
  const prefixed = raw.match(/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i);
  if (prefixed) {
    const prefix = String(prefixed[1] || '')
      .trim()
      .toLowerCase();
    const label = String(prefixed[2] || '').trim();
    if (!label) return null;
    const fishPrefixes = (VIPFISH_DEEPLINK.tagPrefixes || ['vipfish', 'ryba']).map((p) =>
      String(p).toLowerCase()
    );
    const befitPrefixes = (BEFIT_DEEPLINK.tagPrefixes || ['befit', 'letbefit']).map((p) =>
      String(p).toLowerCase()
    );
    const hvalPrefixes = (HVALWATERS_DEEPLINK.tagPrefixes || [
      'hval',
      'water',
      'hvalwaters',
    ]).map((p) => String(p).toLowerCase());
    const gfPrefixes = (GROWFOOD_DEEPLINK.tagPrefixes || ['growfood', 'gf']).map((p) =>
      String(p).toLowerCase()
    );
    const auchanPrefixes = (AUCHAN_DEEPLINK.tagPrefixes || ['auchan', 'ashan']).map((p) =>
      String(p).toLowerCase()
    );
    if (fishPrefixes.includes(prefix)) {
      return { kind: 'product', label, store: 'vipfish' };
    }
    if (auchanPrefixes.includes(prefix)) {
      return { kind: 'product', label, store: 'auchan' };
    }
    if (befitPrefixes.includes(prefix)) {
      return { kind: 'product', label, store: 'befit' };
    }
    if (hvalPrefixes.includes(prefix)) {
      return { kind: 'product', label, store: 'hvalwaters' };
    }
    if (gfPrefixes.includes(prefix)) {
      return { kind: 'product', label, store: 'growfood' };
    }
    // Unknown prefix — plain label, no invented link.
    return { kind: 'plain', label, store: null };
  }
  return { kind: 'product', label: raw, store: 'vkusvill' };
}

function botStoreDisplayName(store) {
  if (store === 'vipfish') return VIPFISH_DEEPLINK.name || 'Важная рыба';
  if (store === 'auchan') return AUCHAN_DEEPLINK.name || 'Ашан';
  if (store === 'befit') return BEFIT_DEEPLINK.name || 'BeFit';
  if (store === 'hvalwaters') return HVALWATERS_DEEPLINK.name || 'Хваловская вода';
  if (store === 'growfood') return GROWFOOD_DEEPLINK.name || 'GrowFood';
  if (store === 'vkusvill') return 'ВкусВилл';
  return '';
}

function botBuildChipHref(store, label) {
  if (store === 'vkusvill' && VKUSVILL_DEEPLINK.enabled) {
    return buildVkusvillAdmitadUrl(label, VKUSVILL_DEEPLINK);
  }
  if (store === 'vipfish' && VIPFISH_DEEPLINK.enabled) {
    return buildVipfishAdmitadUrl(label, VIPFISH_DEEPLINK);
  }
  if (store === 'auchan' && AUCHAN_DEEPLINK.enabled) {
    return buildAuchanAdmitadUrl(label, AUCHAN_DEEPLINK);
  }
  if (store === 'befit' && BEFIT_DEEPLINK.enabled) {
    return buildBefitAdmitadUrl(label, BEFIT_DEEPLINK);
  }
  if (store === 'hvalwaters' && HVALWATERS_DEEPLINK.enabled) {
    return buildHvalwatersAdmitadUrl(label, HVALWATERS_DEEPLINK);
  }
  if (store === 'growfood' && GROWFOOD_DEEPLINK.enabled) {
    return buildGrowfoodAdmitadUrl(label, GROWFOOD_DEEPLINK);
  }
  return null;
}

function botStoreDeeplinkCfg(store) {
  if (store === 'vkusvill') return { cfg: VKUSVILL_DEEPLINK, fallback: 'АО «ВкусВилл»' };
  if (store === 'vipfish') return { cfg: VIPFISH_DEEPLINK, fallback: 'ООО «Кейтеринг-Рент»' };
  if (store === 'auchan') return { cfg: AUCHAN_DEEPLINK, fallback: 'ООО «АШАН»' };
  if (store === 'befit') return { cfg: BEFIT_DEEPLINK, fallback: 'ООО «АЛ-МУЛК»' };
  if (store === 'hvalwaters') return { cfg: HVALWATERS_DEEPLINK, fallback: 'ООО «АКВАСИТИ»' };
  if (store === 'growfood') return { cfg: GROWFOOD_DEEPLINK, fallback: 'ООО «ГФ Трейд»' };
  return { cfg: null, fallback: '' };
}

function botDisclosureLine(store) {
  const { cfg, fallback } = botStoreDeeplinkCfg(store);
  if (!cfg || !cfg.erid) return '';
  if (cfg.disclaimer) return String(cfg.disclaimer).trim();
  const legal = String(cfg.legalName || fallback || '').trim();
  const inn = String(cfg.inn || '').trim();
  const bits = ['Реклама.'];
  if (legal) bits.push(inn ? `${legal}, ИНН ${inn}.` : `${legal}.`);
  bits.push(`erid: ${cfg.erid}`);
  return bits.join(' ');
}

/** Short partner name for compact Telegram ad block (unique by erid). */
function botDisclosureShortName(store) {
  if (store === 'vkusvill') return 'ВкусВилл';
  if (store === 'auchan') return 'Ашан';
  const { cfg, fallback } = botStoreDeeplinkCfg(store);
  const legal = String((cfg && cfg.legalName) || fallback || '').trim();
  if (legal) return legal;
  return botStoreDisplayName(store) || store;
}

/**
 * One compact legal block for Telegram (not N full «Реклама…Admitad» lines).
 * @param {Set<string>|Iterable<string>} storesUsed
 * @param {Array<{name:string,erid:string}>} [extraItems] — e.g. Auchan first-order erid
 * @returns {string}
 */
function buildCompactAdDisclosure(storesUsed, extraItems = []) {
  const used = storesUsed instanceof Set ? storesUsed : new Set(storesUsed || []);
  const items = [];
  /** @type {Set<string>} */
  const seenErids = new Set();
  for (const store of ['vkusvill', 'vipfish', 'auchan', 'befit', 'hvalwaters', 'growfood']) {
    if (!used.has(store)) continue;
    const { cfg } = botStoreDeeplinkCfg(store);
    const erid = String((cfg && cfg.erid) || '').trim();
    if (!erid || seenErids.has(erid)) continue;
    seenErids.add(erid);
    const name = botDisclosureShortName(store);
    if (!name) continue;
    items.push(`• ${name} (erid: ${erid})`);
  }
  const extras = Array.isArray(extraItems) ? extraItems : [];
  for (const extra of extras) {
    if (!extra || typeof extra !== 'object') continue;
    const erid = String(extra.erid || '').trim();
    const name = String(extra.name || '').trim();
    if (!erid || !name || seenErids.has(erid)) continue;
    seenErids.add(erid);
    items.push(`• ${name} (erid: ${erid})`);
  }
  if (!items.length) return '';
  return ['Реклама. Партнёрские ссылки Admitad.', ...items].join('\n');
}

/**
 * Drop model-written «Реклама» / erid lines so the server can append
 * canonical disclosures once (unique erids) after chip expand.
 * @param {string} text
 * @returns {string}
 */
function stripModelAdDisclosures(text) {
  const src = String(text || '');
  if (!src) return '';
  const kept = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t) {
      kept.push(line);
      continue;
    }
    // Avoid \\b with Cyrillic — JS word boundaries are ASCII-only.
    if (/^реклама/i.test(t)) continue;
    if (/(?:^|[\s,;:(])erid\s*[:=]/i.test(t)) continue;
    if (/реклама/i.test(t) && /erid/i.test(t)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeBotProductLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a line is only product labels that already become Telegram buttons.
 * @param {string} line
 * @param {Set<string>} labels lowercased
 */
function isLineOnlyProductLabels(line, labels) {
  let rest = normalizeBotProductLabel(line);
  if (!rest) return false;
  rest = rest.replace(/^(?:[-•*–—]|\d+[.)])\s+/, '').trim();
  rest = rest
    .replace(
      /^(?:список(?:\s+покупок)?|продукты|купить|корзина|нужно|взять|набор)\s*:?\s*/i,
      ''
    )
    .trim();
  if (!rest || !labels.size) return false;
  const sorted = [...labels].filter(Boolean).sort((a, b) => b.length - a.length);
  let matched = 0;
  while (rest) {
    rest = rest.replace(/^[,;•·|/]+\s*/, '').trim();
    if (!rest) break;
    let found = false;
    for (const lab of sorted) {
      if (
        rest === lab ||
        rest.startsWith(`${lab} `) ||
        rest.startsWith(`${lab},`) ||
        rest.startsWith(`${lab};`) ||
        rest.startsWith(`${lab}•`) ||
        rest.startsWith(`${lab}·`) ||
        rest.startsWith(`${lab}/`) ||
        rest.startsWith(`${lab}|`)
      ) {
        rest = rest.slice(lab.length).trim();
        matched += 1;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return matched > 0;
}

/**
 * When structured links exist, drop a trailing bare ingredient list that
 * only duplicates button labels (chips / bullets / comma lists).
 * @param {string} text
 * @param {Array<{label?:string}>} links
 * @returns {string}
 */
function stripTrailingDuplicateProductList(text, links) {
  const src = String(text || '').trimEnd();
  if (!src || !Array.isArray(links) || !links.length) return src;
  /** @type {Set<string>} */
  const labels = new Set(
    links.map((l) => normalizeBotProductLabel(l && l.label)).filter(Boolean)
  );
  if (!labels.size) return src;

  const lines = src.split('\n');
  let changed = false;
  while (lines.length) {
    const raw = lines[lines.length - 1];
    const t = raw.trim();
    if (!t) {
      lines.pop();
      changed = true;
      continue;
    }
    if (/^(?:список(?:\s+покупок)?|продукты|купить|корзина|нужно|взять|набор)\s*:?\s*$/i.test(t)) {
      lines.pop();
      changed = true;
      continue;
    }
    if (isLineOnlyProductLabels(t, labels)) {
      lines.pop();
      changed = true;
      continue;
    }
    break;
  }
  if (!changed) return src;
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Max structured product links for Telegram inline keyboard (API + bot). */
const BOT_LINKS_MAX = 24;

/**
 * Hide recipe block headers (neural structure) — keep product names after the colon.
 * Clarify-first replies have no such headers.
 * @param {string} text
 * @returns {string}
 */
function stripRecipeCategoryLabels(text) {
  let s = String(text || '');
  const labels = [
    /^(?:\s*[-–•*]?\s*)?Мясо\s*\/\s*птица\s*\/\s*рыба\s*:\s*/gim,
    /^(?:\s*[-–•*]?\s*)?Овощи\s*\/\s*крупы\s*:\s*/gim,
    /^(?:\s*[-–•*]?\s*)?Зелень\s*:\s*/gim,
    /^(?:\s*[-–•*]?\s*)?Специи\s*:\s*/gim,
    /^(?:\s*[-–•*]?\s*)?Ещё(?:\s*\([^)\n]*\))?\s*:\s*/gim,
  ];
  for (const re of labels) s = s.replace(re, '');
  return s;
}

/**
 * Expand [[partner chips]] for Telegram / JSON bot clients.
 * Prose keeps human labels; real Admitad hrefs become structured `links` for inline buttons.
 * Reply text stays clean (short “Ссылки ниже” + erid) — no duplicate URL list.
 * Never leaves raw [[…]] in the output. Web /api/chat SSE is untouched (call only from bot route).
 * @param {string} text
 * @returns {{reply:string, links:Array<{label:string,url:string,store?:string}>}}
 */
function expandPartnerChipsForBot(text) {
  const src = stripRecipeCategoryLabels(stripModelAdDisclosures(text));
  if (!src.includes('[[')) return { reply: src, links: [] };

  const re = /\[\[([^\]]+)\]\]/g;
  /** @type {{start:number,end:number,kind:string,label:string,store:string|null,href:string|null}[]} */
  const hits = [];
  let m;
  while ((m = re.exec(src))) {
    const parsed = parseBotProductTag(m[1]);
    if (!parsed) {
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        kind: 'plain',
        label: String(m[1] || '').trim(),
        store: null,
        href: null,
      });
      continue;
    }
    const href =
      parsed.kind === 'product' && parsed.store
        ? botBuildChipHref(parsed.store, parsed.label)
        : null;
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: parsed.kind,
      label: parsed.label,
      store: parsed.store,
      href,
    });
  }
  if (!hits.length) return { reply: src, links: [] };

  let out = '';
  let cursor = 0;
  /** @type {{label:string,store:string,url:string}[]} */
  const links = [];
  /** @type {Set<string>} */
  const seenHref = new Set();
  /** @type {Set<string>} */
  const storesUsed = new Set();

  for (const hit of hits) {
    if (hit.start < cursor) continue;
    out += src.slice(cursor, hit.start);
    if (hit.kind === 'partner') {
      // Hide [[partner:id]] like the web cart UI.
      out += '';
    } else {
      out += hit.label || '';
      if (hit.href && hit.store) {
        const key = hit.href;
        if (!seenHref.has(key)) {
          seenHref.add(key);
          if (links.length < BOT_LINKS_MAX) {
            links.push({ label: hit.label, store: hit.store, url: hit.href });
          }
          storesUsed.add(hit.store);
        }
      }
    }
    cursor = hit.end;
  }
  out += src.slice(cursor);

  // Strip any leftover raw brackets (defensive).
  out = out.replace(/\[\[([^\]]*)\]\]/g, (_, inner) => {
    const parsed = parseBotProductTag(inner);
    if (!parsed || parsed.kind === 'partner') return '';
    return parsed.label || '';
  });

  // Optional Auchan first-order CTA (landing, not search deeplink) — separate erid.
  /** @type {Array<{name:string,erid:string}>} */
  const disclosureExtras = [];
  const fo = AUCHAN_DEEPLINK && AUCHAN_DEEPLINK.firstOrder;
  if (
    fo &&
    fo.link &&
    storesUsed.has('auchan') &&
    links.length < BOT_LINKS_MAX &&
    !seenHref.has(fo.link)
  ) {
    seenHref.add(fo.link);
    links.push({
      label: fo.cta || 'Забрать скидку на первый заказ',
      store: 'auchan',
      url: fo.link,
      kind: 'firstOrder',
    });
    if (fo.erid && fo.erid !== AUCHAN_DEEPLINK.erid) {
      disclosureExtras.push({ name: 'Ашан, первый заказ', erid: fo.erid });
    }
  }

  if (links.length) {
    // Prefer Telegram inline buttons for URLs — keep prose clean.
    // Drop trailing bare product list that only duplicates button labels.
    out = stripTrailingDuplicateProductList(out, links);
    // Link labels stay product-name-only (bot renders buttons without store prefix).
    const programStores = new Set(['befit', 'hvalwaters', 'growfood']);
    const productLinks = links.filter((l) => l.kind !== 'firstOrder');
    const onlyPrograms =
      productLinks.length > 0 && productLinks.every((l) => programStores.has(l.store));
    const hint = onlyPrograms ? 'Ссылки ниже ↓' : 'Собрать корзину — ссылки ниже ↓';
    const lines = [hint];
    const disclosure = buildCompactAdDisclosure(storesUsed, disclosureExtras);
    if (disclosure) {
      lines.push('');
      lines.push(disclosure);
    }
    out = `${out.trimEnd()}\n\n${lines.join('\n')}`;
  }

  return { reply: out.trim(), links };
}

/**
 * Soft-offer intent: готовая еда / заказ / доставка / недельный пакет.
 * Do NOT match bare «нет времени» from a starter chip — only clear ready-food wording
 * in the latest user reply (see pickPartner). Avoid \\b — JS word boundaries break Cyrillic.
 */
const INTENT_RE =
  /готов(?:ое|ый|ую|ые|ого)(?:\s+(?:питан\w*|ед\w*|рацион\w*|пакет\w*))?|заказ(?:ать|аю|аем|ите)|заказы|доставк\w*|недельн\w*\s*(?:рацион\w*|пакет\w*)|нет времени готовить|некогда готовить|готовый\s+рацион|befit|летбифит|letbefit|growfood|гроуфуд|grow\s*food/i;

/** Placeholder / demo hosts must never ship as live offers. */
const PLACEHOLDER_LINK_RE = /^https?:\/\/(www\.)?example\.com(\/|$)/i;

function isHttpUrl(value) {
  return /^https?:\/\/\S+/i.test(String(value || '').trim());
}

/** Live partner = explicit live:true + real https URL (not example.com). */
function isLivePartner(partner) {
  if (!partner || partner.live !== true) return false;
  const link = String(partner.link || '').trim();
  if (!isHttpUrl(link)) return false;
  if (PLACEHOLDER_LINK_RE.test(link)) return false;
  return true;
}

function conversationText(messages) {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
    .toLowerCase();
}

function countUserTurns(messages) {
  return messages.filter((m) => m && m.role === 'user' && typeof m.content === 'string').length;
}

/**
 * Pick 0–1 live partner on intent. Never on first user turn.
 * Intent must appear in the latest user message (not only in an earlier starter).
 * Demo rows (live:false / example.com) are skipped — no invented links.
 */
function pickPartner(messages, { allowPartner = false } = {}) {
  if (!allowPartner) return null;
  // Never first reply: need at least two user messages in the thread.
  if (countUserTurns(messages) < 2) return null;

  const live = loadPartners().filter(isLivePartner);
  if (!live.length) return null;

  // Starter «Нет времени» alone must not unlock ads — check the latest reply.
  const latest = String(lastUserText(messages) || '').toLowerCase();
  if (!INTENT_RE.test(latest)) return null;

  const text = conversationText(messages);

  let best = null;
  let bestScore = 0;
  for (const p of live) {
    let score = 0;
    for (const tag of p.tags || []) {
      if (text.includes(String(tag).toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // Intent matched and at least one live partner exists — prefer tag fit, else first live.
  return bestScore > 0 ? best : live[0];
}

function partnerPayload(partner) {
  if (!partner) return null;
  return {
    id: partner.id,
    name: partner.name,
    blurb: partner.blurb,
    link: partner.link,
    disclaimer: partner.disclaimer,
    offer_type: partner.offer_type || null,
    // Promo codes hidden from chat/bot UI; chips/Admitad links stay.
  };
}

/** System prompt + optional mode overlay. Partner offers stay UI-only. */
function buildSystemInstruction(mode = null) {
  const extra = modeOverlayBlock(mode);
  return loadSystemPrompt() + extra;
}

function toGeminiContents(messages) {
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, MAX_MESSAGE_CHARS) }],
    }));
}

/** Strip API keys / long token-like blobs from logs. Never print secrets. */
function redactSecrets(text) {
  return String(text || '')
    .replace(/key=[^&\s"']+/gi, 'key=[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 280);
}

const OVERLOAD_USER_MESSAGE =
  'Сейчас у ИИ высокая нагрузка — это временно. Подождите минуту и напишите снова, обычно всё снова отвечает.';

function parseGeminiErrorBody(rawBody) {
  let code = '';
  let message = '';
  try {
    const parsed = JSON.parse(rawBody);
    code = String(parsed?.error?.status || parsed?.error?.code || '');
    message = parsed?.error?.message || '';
  } catch {
    message = rawBody;
  }
  return { code, message };
}

function summarizeGeminiError(status, rawBody, model = GEMINI_MODEL) {
  const { code, message } = parseGeminiErrorBody(rawBody);
  const safeMessage = redactSecrets(message).replace(/\s+/g, ' ').trim();
  console.error(
    `[gemini] upstream status=${status} model=${model} code=${code || 'n/a'} msg=${safeMessage || '(empty)'}`
  );

  if (isOverloadError(status, code, message)) {
    return OVERLOAD_USER_MESSAGE;
  }
  if (
    status === 401 ||
    status === 403 ||
    /API[_\s-]?KEY|PERMISSION|UNAUTHENTICATED|not valid/i.test(`${code} ${message}`)
  ) {
    return 'Сейчас не удаётся связаться с моделью. Загляните позже — обычно это быстро проходит.';
  }
  if (status === 404 || /NOT_FOUND|model/i.test(`${code} ${message}`)) {
    return 'Модель временно недоступна. Попробуйте чуть позже.';
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate/i.test(`${code} ${message}`)) {
    return 'Слишком много запросов. Подождите минуту и напишите снова.';
  }
  if (status >= 500) {
    return 'У модели короткий перерыв. Напишите ещё раз через минуту.';
  }
  return 'Ответ пока не пришёл. Можно повторить через минуту.';
}

/**
 * Open Gemini SSE for one API key. On 503/UNAVAILABLE: backoff, then next model in chain.
 * @returns {Promise<{ upstream: Response, model: string, keyId: number } | { errorText: string, status: number, model: string, keyId: number, failoverWorthy: boolean }>}
 */
async function openGeminiStreamWithKey(body, models, keySlot) {
  const chain = models.length ? models : GEMINI_MODEL_CHAIN;
  const apiKey = keySlot.key;
  const keyId = keySlot.id;
  let lastFailure = {
    errorText: OVERLOAD_USER_MESSAGE,
    status: 503,
    model: chain[0],
    keyId,
    failoverWorthy: true,
  };

  for (let modelIndex = 0; modelIndex < chain.length; modelIndex++) {
    const model = chain[modelIndex];
    const attempts = OVERLOAD_RETRIES + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      console.info(
        `[gemini] request key=${keyId} model=${model} attempt=${attempt + 1}/${attempts} chain=${modelIndex + 1}/${chain.length}`
      );

      let upstream;
      try {
        upstream = await fetch(geminiStreamUrl(model, apiKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.error(
          `[gemini] fetch failed key=${keyId} model=${model}`,
          redactSecrets(err?.message || String(err))
        );
        lastFailure = {
          errorText: 'Связь прервалась. Проверьте сеть и напишите снова.',
          status: 0,
          model,
          keyId,
          failoverWorthy: true,
        };
        if (attempt < attempts - 1) {
          await sleep(OVERLOAD_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        break;
      }

      if (upstream.ok) {
        if (model !== GEMINI_MODEL) {
          console.info(
            `[gemini] fallback ok key=${keyId} model=${model} (primary was ${GEMINI_MODEL})`
          );
        }
        return { upstream, model, keyId };
      }

      const errText = await upstream.text().catch(() => '');
      const { code, message } = parseGeminiErrorBody(errText);
      const failoverWorthy = isKeyFailoverError(upstream.status, code, message);
      lastFailure = {
        errorText: summarizeGeminiError(upstream.status, errText, model),
        status: upstream.status,
        model,
        keyId,
        failoverWorthy,
      };

      if (isOverloadError(upstream.status, code, message)) {
        const canRetry = attempt < attempts - 1;
        const canFallback = modelIndex < chain.length - 1;
        console.warn(
          `[gemini] overload key=${keyId} model=${model} status=${upstream.status} code=${code || 'n/a'} retry=${canRetry} fallback=${canFallback}`
        );
        if (canRetry) {
          await sleep(OVERLOAD_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        break;
      }

      if (failoverWorthy) {
        console.warn(
          `[gemini] key=${keyId} failover-worthy status=${upstream.status} code=${code || 'n/a'}`
        );
        return lastFailure;
      }

      return lastFailure;
    }
  }

  return lastFailure;
}

/**
 * Open a Gemini SSE stream with dual-key failover (one switch on 429/503/network/geo).
 * @param {object} body request JSON
 * @param {string[]} [models] override chain (e.g. stick to one model on MAX_TOKENS continue)
 */
async function openGeminiStream(body, models = GEMINI_MODEL_CHAIN) {
  const slots = orderedGeminiKeySlots();
  if (!slots.length) {
    return {
      errorText: 'Ключ Gemini не задан.',
      status: 0,
      model: GEMINI_MODEL,
      keyId: null,
      failoverWorthy: false,
    };
  }

  let lastFailure = null;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const result = await openGeminiStreamWithKey(body, models, slot);
    if (result?.upstream) {
      if (activeGeminiKeyId !== slot.id) {
        console.info(
          `[gemini] primary key switched ${activeGeminiKeyId || 'n/a'} → ${slot.id}`
        );
        activeGeminiKeyId = slot.id;
      }
      return result;
    }
    lastFailure = result;
    const canFailover = i === 0 && slots.length > 1 && result?.failoverWorthy === true;
    if (canFailover) {
      console.warn(
        `[gemini] key ${slot.id} failed (status=${result.status || 0}) — one failover to key ${slots[1].id}`
      );
      continue;
    }
    break;
  }

  return (
    lastFailure || {
      errorText: OVERLOAD_USER_MESSAGE,
      status: 503,
      model: GEMINI_MODEL,
      keyId: activeGeminiKeyId,
      failoverWorthy: false,
    }
  );
}

const MOCK_REPLY =
  'Спасибо, что рассказали. Для старта держитесь простого каркаса: овощи или зелень в каждом приёме пищи, белок (рыба, яйца, бобовые, птица — что вам подходит), полезные жиры (орехи, авокадо, растительное масло) и привычные углеводы без жёстких запретов.\n\n' +
  'Пример дня: завтрак — овсянка на воде или молоке с ягодами и горстью орехов; обед — гречка или киноа, запечённая рыба или тофу, большой салат; ужин — овощной суп или омлет с зеленью и цельнозерновой хлеб; перекус — йогурт без сахара, фрукты или хумус с морковью.\n\n' +
  'Если есть аллергии или ограничения — напишите их, и я подстрою пример дня под вас. Это общий ориентир по рациону, не медицинская рекомендация. Готово.';

function writeEvent(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

/**
 * Parse one Gemini SSE `data:` JSON payload.
 * @returns {{ text: string, finishReason: string, error?: object }}
 */
function parseGeminiSsePayload(payload) {
  if (!payload || payload === '[DONE]') return { text: '', finishReason: '' };
  const json = JSON.parse(payload);
  if (json?.error) return { text: '', finishReason: '', error: json.error };
  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason || '';
  const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
  return { text, finishReason, error: null };
}

/**
 * Read Gemini upstream SSE to completion, flushing the leftover buffer
 * (last event often arrives without a trailing blank line).
 */
async function readGeminiSse(upstreamBody, onText) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;
  let finishReason = '';
  let assembled = '';

  const handleDataLine = (trimmed) => {
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    let parsed;
    try {
      parsed = parseGeminiSsePayload(payload);
    } catch {
      return;
    }
    if (parsed.error) {
      const err = new Error('gemini_upstream_error');
      err.geminiError = parsed.error;
      throw err;
    }
    if (parsed.finishReason) finishReason = parsed.finishReason;
    if (parsed.text) {
      tokenCount += 1;
      assembled += parsed.text;
      onText(parsed.text);
    }
  };

  const drain = (flushAll) => {
    const parts = buffer.split(/\r?\n/);
    if (!flushAll) {
      buffer = parts.pop() || '';
    } else {
      buffer = '';
    }
    for (const line of parts) {
      handleDataLine(line.trim());
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  if (buffer.trim()) drain(true);

  return { tokenCount, finishReason, text: assembled };
}

async function streamMock(res, partner) {
  // Staged wait: thinking → typing → tokens (client also rotates calm Russian phrases).
  writeEvent(res, { type: 'status', stage: 'thinking' });
  await new Promise((r) => setTimeout(r, 1200));
  writeEvent(res, { type: 'status', stage: 'typing' });
  await new Promise((r) => setTimeout(r, 700));
  const chunks = MOCK_REPLY.match(/.{1,24}|[\s\S]/g) || [MOCK_REPLY];
  for (const chunk of chunks) {
    writeEvent(res, { type: 'token', text: chunk });
    await new Promise((r) => setTimeout(r, 18));
  }
  if (partner) {
    writeEvent(res, { type: 'partner', partner: partnerPayload(partner) });
  }
  writeEvent(res, {
    type: 'done',
    mock: true,
    finishReason: 'STOP',
    truncated: false,
    text: MOCK_REPLY,
    continues: 0,
  });
  res.end();
}

/**
 * Shared Gemini core used by SSE /api/chat and JSON /api/bot/chat.
 * Talks to Gemini via streamGenerateContent; optional onToken for live SSE clients.
 * Does not write HTTP responses — callers decide SSE vs JSON.
 *
 * @param {{ messages: Array, mode?: object, onToken?: (text: string) => void, onTyping?: () => void, logLabel?: string }} opts
 * @returns {Promise<{ text: string, finishReason: string, model: string, truncated: boolean, tokenCount: number, continues: number, errorText?: string, mock?: boolean }>}
 */
async function generateGeminiReply({
  messages,
  mode = null,
  onToken = null,
  onTyping = null,
  logLabel = 'chat',
} = {}) {
  if (!GEMINI_API_KEY) {
    if (typeof onToken === 'function') {
      const chunks = MOCK_REPLY.match(/.{1,24}|[\s\S]/g) || [MOCK_REPLY];
      for (const chunk of chunks) onToken(chunk);
    }
    return {
      text: MOCK_REPLY,
      finishReason: 'STOP',
      model: 'mock',
      truncated: false,
      tokenCount: 1,
      continues: 0,
      mock: true,
    };
  }

  const gotSlot = await acquireGeminiSlot();
  if (!gotSlot) {
    return {
      text: '',
      finishReason: 'ERROR',
      model: GEMINI_MODEL,
      truncated: false,
      tokenCount: 0,
      continues: 0,
      errorText: GEMINI_BUSY_USER_MESSAGE,
    };
  }

  try {
    return await generateGeminiReplyWithSlot({
      messages,
      mode,
      onToken,
      onTyping,
      logLabel,
    });
  } finally {
    await releaseGeminiSlot();
  }
}

async function generateGeminiReplyWithSlot({
  messages,
  mode = null,
  onToken = null,
  onTyping = null,
  logLabel = 'chat',
} = {}) {
  const resolvedMode = mode || resolveChatMode('normal', messages);
  const systemInstruction = { parts: [{ text: buildSystemInstruction(resolvedMode) }] };
  let contents = toGeminiContents(messages);
  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  console.info(
    `[gemini] ${logLabel} turns=${messages.length} mode=${resolvedMode.id}/${resolvedMode.source || 'n/a'} maxOutputTokens=${MAX_OUTPUT_TOKENS} chain=${GEMINI_MODEL_CHAIN.join(
      '→'
    )}`
  );

  let tokenCount = 0;
  let finishReason = '';
  let assembled = '';
  let continues = 0;
  let signaledTyping = false;
  let activeModel = GEMINI_MODEL;

  for (let attempt = 0; attempt <= MAX_CONTINUES; attempt++) {
    const requestBody = {
      system_instruction: systemInstruction,
      contents,
      generationConfig,
    };

    // First segment: full retry + fallback chain. Continues stick to the model that worked.
    const opened = await openGeminiStream(
      requestBody,
      attempt === 0 ? GEMINI_MODEL_CHAIN : [activeModel]
    );

    if (!opened?.upstream) {
      const kind = classifyGeminiFailure(0, '', opened?.errorText || '');
      void recordChatError(kind, defaultWarningMessage(kind));
      return {
        text: assembled,
        finishReason: finishReason || 'ERROR',
        model: activeModel,
        truncated: false,
        tokenCount,
        continues,
        errorText: opened?.errorText || OVERLOAD_USER_MESSAGE,
      };
    }

    activeModel = opened.model;

    if (!signaledTyping) {
      if (typeof onTyping === 'function') onTyping();
      signaledTyping = true;
    }

    let segment;
    try {
      segment = await readGeminiSse(opened.upstream.body, (text) => {
        if (typeof onToken === 'function') onToken(text);
      });
    } catch (err) {
      if (err?.geminiError) {
        const calm = summarizeGeminiError(
          err.geminiError.code || 500,
          JSON.stringify({ error: err.geminiError }),
          activeModel
        );
        const kind = classifyGeminiFailure(
          err.geminiError.code || 500,
          err.geminiError.status || '',
          err.geminiError.message || calm
        );
        void recordChatError(kind, defaultWarningMessage(kind));
        return {
          text: assembled,
          finishReason: 'ERROR',
          model: activeModel,
          truncated: false,
          tokenCount,
          continues,
          errorText: calm,
        };
      }
      throw err;
    }

    tokenCount += segment.tokenCount;
    finishReason = segment.finishReason || finishReason;
    assembled += segment.text;

    if (segment.finishReason !== 'MAX_TOKENS' || !segment.text || attempt === MAX_CONTINUES) {
      break;
    }

    continues += 1;
    console.info(
      `[gemini] MAX_TOKENS — continue ${continues}/${MAX_CONTINUES} model=${activeModel} soFarChars=${assembled.length}`
    );
    contents = [
      ...contents,
      { role: 'model', parts: [{ text: assembled.slice(-12000) }] },
      {
        role: 'user',
        parts: [
          {
            text: 'Продолжи ответ точно с того места, где оборвался. Не повторяй уже сказанное, без нового вступления.',
          },
        ],
      },
    ];
  }

  console.info(
    `[gemini] done ${logLabel} model=${activeModel} chunks=${tokenCount} finishReason=${finishReason || 'n/a'} continues=${continues} chars=${assembled.length}`
  );

  if (assembled.trim()) {
    void recordChatSuccess();
  } else {
    void recordChatError('outage', defaultWarningMessage('outage'));
  }

  return {
    text: assembled,
    finishReason: finishReason || 'STOP',
    model: activeModel,
    truncated: finishReason === 'MAX_TOKENS',
    tokenCount,
    continues,
  };
}

/** Max chat turns kept for bot JSON clients (user+assistant messages). */
const BOT_HISTORY_MAX = 20;

/**
 * Normalize bot/chat message list: user|assistant + non-empty string content, last N.
 * @param {unknown} raw
 * @returns {Array<{role: string, content: string}>}
 */
function normalizeBotMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim()
    )
    .map((m) => ({
      role: m.role,
      content: String(m.content).trim().slice(0, MAX_MESSAGE_CHARS),
    }))
    .slice(-BOT_HISTORY_MAX);
}

/**
 * Full non-streaming reply for the Telegram bot (and any JSON client).
 * Same prompt.txt / partners context path / Gemini keys as /api/chat.
 * @param {string|Array<{role: string, content: string}>} input single user message or history
 * @returns {Promise<string>}
 */
async function generateFullReply(input) {
  let messages;
  if (Array.isArray(input)) {
    messages = normalizeBotMessages(input);
  } else {
    const text = String(input || '').trim().slice(0, MAX_MESSAGE_CHARS);
    messages = text ? [{ role: 'user', content: text }] : [];
  }
  const mode = resolveChatMode('normal', messages);
  const result = await generateGeminiReply({
    messages,
    mode,
    logLabel: 'bot',
  });
  if (result.errorText && !String(result.text || '').trim()) {
    return result.errorText;
  }
  return String(result.text || '').trim() || result.errorText || OVERLOAD_USER_MESSAGE;
}

app.post('/api/chat', chatLimiterMinute, chatLimiterBurst, async (req, res) => {
  const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = rawMessages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim()
    )
    .map((m) => ({
      role: m.role,
      content: String(m.content).trim().slice(0, MAX_MESSAGE_CHARS),
    }))
    .slice(-20);
  const allowPartner = Boolean(req.body?.allowPartner);
  const mode = resolveChatMode(req.body?.mode, messages);
  const partner = pickPartner(messages, { allowPartner });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable Nagle so each token write can leave the socket promptly.
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders?.();

  // Tell the client which mode actually applied (explicit or quiet auto-detect).
  writeEvent(res, { type: 'mode', mode: { id: mode.id, label: mode.label, source: mode.source } });

  if (!isServiceEnabled()) {
    writeEvent(res, { type: 'error', text: SERVICE_DISABLED_USER_MESSAGE });
    writeEvent(res, { type: 'done', finishReason: 'SERVICE_DISABLED' });
    res.end();
    return;
  }

  if (!GEMINI_API_KEY) {
    writeEvent(res, {
      type: 'notice',
      text: 'Ключ GEMINI_API_KEY не задан — показываю демо-ответ, чтобы можно было оценить интерфейс.',
    });
    await streamMock(res, partner);
    return;
  }

  writeEvent(res, { type: 'status', stage: 'thinking' });

  try {
    console.info(
      `[gemini] chat partner=${partner ? partner.id : 'none'}`
    );

    const result = await generateGeminiReply({
      messages,
      mode,
      logLabel: 'chat',
      onTyping: () => writeEvent(res, { type: 'status', stage: 'typing' }),
      onToken: (text) => writeEvent(res, { type: 'token', text }),
    });

    if (result.errorText) {
      writeEvent(res, { type: 'error', text: result.errorText });
      writeEvent(res, { type: 'done', finishReason: result.finishReason || 'ERROR' });
      res.end();
      return;
    }

    if (partner) {
      writeEvent(res, { type: 'partner', partner: partnerPayload(partner) });
    }

    // Include full assembled text so the client can reconcile if the last SSE
    // token frames were dropped by a proxy / leftover buffer edge-case.
    writeEvent(res, {
      type: 'done',
      finishReason: result.finishReason || 'STOP',
      truncated: Boolean(result.truncated),
      model: result.model,
      text: String(result.text || ''),
      continues: Number(result.continues) || 0,
    });
    res.end();
  } catch (err) {
    console.error('[gemini] stream failed', redactSecrets(err?.message || String(err)));
    void recordChatError('outage', defaultWarningMessage('outage'));
    writeEvent(res, {
      type: 'error',
      text: 'Связь прервалась. Проверьте сеть и напишите снова.',
    });
    writeEvent(res, { type: 'done' });
    res.end();
  }
});

/** Bot API key for Telegram thin client — refuse route when unset. */
const BOT_API_KEY = String(process.env.BOT_API_KEY || '').trim();
const BOT_RATE_WINDOW_MS = 60 * 1000;
const BOT_RATE_MAX = 30;

/** In-memory 30 req/min per X-Bot-Key value (single-process; fine for one bot). */
const botRateBuckets = new Map();

function botRateLimitOk(key) {
  const now = Date.now();
  let entry = botRateBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { hits: 0, resetAt: now + BOT_RATE_WINDOW_MS };
    botRateBuckets.set(key, entry);
  }
  entry.hits += 1;
  return entry.hits <= BOT_RATE_MAX;
}

/**
 * Telegram bot thin-client endpoint. JSON only — never SSE.
 * Body: { messages: [{role, content}, ...] } (preferred) or { message: "..." }
 * → { reply: "..." } and optional links: [{ label, url, store? }] when chips expanded to Admitad.
 */
app.post('/api/bot/chat', async (req, res) => {
  if (!BOT_API_KEY) {
    res.status(503).json({ error: 'BOT_API_KEY не задан — бот-маршрут отключён' });
    return;
  }

  const provided = String(req.get('X-Bot-Key') || '').trim();
  if (!provided || provided !== BOT_API_KEY) {
    res.status(401).json({ error: 'Неверный или отсутствующий X-Bot-Key' });
    return;
  }

  if (!botRateLimitOk(provided)) {
    res.status(429).json({ error: 'Слишком много запросов от бота, подождите минуту' });
    return;
  }

  if (!isServiceEnabled()) {
    res.status(503).json({ error: SERVICE_DISABLED_USER_MESSAGE });
    return;
  }

  const hasMessages = Array.isArray(req.body?.messages);
  const messages = hasMessages ? normalizeBotMessages(req.body.messages) : null;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

  if (hasMessages) {
    if (!messages.length) {
      res.status(400).json({ error: 'Нужен непустой массив messages (role + content)' });
      return;
    }
  } else if (!message) {
    res.status(400).json({ error: 'Нужно поле message (строка) или messages (массив)' });
    return;
  }

  try {
    const rawReply = await generateFullReply(hasMessages ? messages : message);
    // Expand [[chips]] → human labels + structured Admitad links (Telegram has no frontend cart UI).
    // Web /api/chat keeps raw chips for script.js chips/cart block.
    const { reply, links } = expandPartnerChipsForBot(rawReply);
    /** @type {{reply:string, links?:Array<{label:string,url:string,store?:string}>}} */
    const payload = { reply };
    if (Array.isArray(links) && links.length) {
      payload.links = links;
    }
    res.json(payload);
  } catch (err) {
    console.error('[bot] generate failed', redactSecrets(err?.message || String(err)));
    void recordChatError('outage', defaultWarningMessage('outage'));
    res.status(502).json({ error: 'Не удалось получить ответ модели' });
  }
});

const ADMIN_USER = String(process.env.ADMIN_USER || 'admin').trim() || 'admin';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
/** Fail2ban-light: ban IP after N bad Basic Auth attempts. */
const ADMIN_AUTH_FAIL_MAX = Math.max(Number(process.env.ADMIN_AUTH_FAIL_MAX) || 8, 3);
const ADMIN_AUTH_FAIL_WINDOW_MS = Math.max(
  Number(process.env.ADMIN_AUTH_FAIL_WINDOW_MS) || 15 * 60 * 1000,
  60 * 1000
);
const ADMIN_AUTH_BAN_MS = Math.max(
  Number(process.env.ADMIN_AUTH_BAN_MS) || 30 * 60 * 1000,
  60 * 1000
);
/** @type {Map<string, {fails:number, resetAt:number, bannedUntil:number}>} */
const adminAuthFails = new Map();

function adminClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function getAdminAuthState(ip) {
  const now = Date.now();
  let entry = adminAuthFails.get(ip);
  if (!entry || (entry.bannedUntil <= now && entry.resetAt <= now)) {
    entry = { fails: 0, resetAt: now + ADMIN_AUTH_FAIL_WINDOW_MS, bannedUntil: 0 };
    adminAuthFails.set(ip, entry);
  } else if (entry.resetAt <= now && entry.bannedUntil <= now) {
    entry.fails = 0;
    entry.resetAt = now + ADMIN_AUTH_FAIL_WINDOW_MS;
  }
  return entry;
}

function isAdminIpBanned(ip) {
  const entry = adminAuthFails.get(ip);
  return Boolean(entry && entry.bannedUntil > Date.now());
}

function recordAdminAuthFail(ip) {
  const now = Date.now();
  const entry = getAdminAuthState(ip);
  if (entry.bannedUntil > now) return entry;
  if (entry.resetAt <= now) {
    entry.fails = 0;
    entry.resetAt = now + ADMIN_AUTH_FAIL_WINDOW_MS;
  }
  entry.fails += 1;
  if (entry.fails >= ADMIN_AUTH_FAIL_MAX) {
    entry.bannedUntil = now + ADMIN_AUTH_BAN_MS;
    console.warn(
      `[admin] auth ban ip=${ip} fails=${entry.fails} for ${Math.round(ADMIN_AUTH_BAN_MS / 60000)}m`
    );
  }
  return entry;
}

function clearAdminAuthFails(ip) {
  adminAuthFails.delete(ip);
}

function unauthorizedAdmin(res) {
  res.set('WWW-Authenticate', 'Basic realm="NutriKod Admin", charset="UTF-8"');
  res.status(401).type('text/plain').send('Требуется авторизация');
}

function requireAdmin(req, res, next) {
  const ip = adminClientIp(req);
  if (isAdminIpBanned(ip)) {
    // No WWW-Authenticate — avoid browser auth-loop while banned.
    res
      .status(429)
      .type('text/plain')
      .send('Слишком много неудачных попыток входа. Подождите немного и попробуйте снова.');
    return;
  }
  if (!ADMIN_PASSWORD) {
    unauthorizedAdmin(res);
    return;
  }
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) {
    unauthorizedAdmin(res);
    return;
  }
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    recordAdminAuthFail(ip);
    unauthorizedAdmin(res);
    return;
  }
  const sep = decoded.indexOf(':');
  const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
  if (user !== ADMIN_USER || pass !== ADMIN_PASSWORD) {
    recordAdminAuthFail(ip);
    unauthorizedAdmin(res);
    return;
  }
  clearAdminAuthFails(ip);
  next();
}

app.get('/admin', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(ADMIN_HTML_PATH);
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const stats = await readAdminStats();
    res.set('Cache-Control', 'no-store');
    res.json({ ...stats, serviceEnabled: isServiceEnabled() });
  } catch (err) {
    console.error('[admin] stats failed', err?.message || err);
    res.status(500).json({ error: 'Не удалось получить статистику' });
  }
});

app.get('/api/admin/files', requireAdmin, (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({
      partners: fs.readFileSync(PARTNERS_PATH, 'utf8'),
      prompt: fs.readFileSync(PROMPT_PATH, 'utf8'),
      serviceEnabled: isServiceEnabled(),
    });
  } catch (err) {
    console.error('[admin] files read failed', err?.message || err);
    res.status(500).json({ error: 'Не удалось прочитать файлы' });
  }
});

app.post('/api/admin/service', requireAdmin, (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ error: 'Нужно поле enabled (boolean)' });
    return;
  }
  try {
    const enabled = setServiceEnabled(req.body.enabled);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, serviceEnabled: enabled });
  } catch (err) {
    console.error('[admin] service save failed', err?.message || err);
    res.status(500).json({ error: 'Не удалось сохранить состояние сервиса' });
  }
});

app.post('/api/admin/save', requireAdmin, (req, res) => {
  const partnersRaw = req.body?.partners;
  const promptRaw = req.body?.prompt;
  if (typeof partnersRaw !== 'string' || typeof promptRaw !== 'string') {
    res.status(400).json({ error: 'Нужны строковые поля partners и prompt' });
    return;
  }
  if (!promptRaw.trim()) {
    res.status(400).json({ error: 'prompt.txt не может быть пустым' });
    return;
  }

  let partnersParsed;
  try {
    partnersParsed = JSON.parse(partnersRaw);
  } catch {
    res.status(400).json({ error: 'partners.json: невалидный JSON' });
    return;
  }
  if (!Array.isArray(partnersParsed)) {
    res.status(400).json({ error: 'partners.json должен быть массивом' });
    return;
  }

  try {
    const partnersOut = `${JSON.stringify(partnersParsed, null, 2)}\n`;
    fs.writeFileSync(PARTNERS_PATH, partnersOut, 'utf8');
    fs.writeFileSync(PROMPT_PATH, promptRaw, 'utf8');
    invalidateContentCache();
    loadPartners();
    loadSystemPrompt();
    console.info(
      `[admin] saved partners.json (${partnersParsed.length} rows) and prompt.txt (${promptRaw.length} chars)`
    );
    res.json({ ok: true, partnersCount: partnersParsed.length, promptChars: promptRaw.length });
  } catch (err) {
    console.error('[admin] save failed', err?.message || err);
    res.status(500).json({ error: 'Не удалось сохранить файлы' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

if (require.main === module) {
  // Master: one worker per CPU; workers serve HTTP. Dead workers are forked again — master stays up.
  if (cluster.isPrimary) {
    attachClusterRateLimitMaster();
    attachClusterGeminiSlotMaster();
    attachClusterStatsMaster();
    const workers = Math.max(1, os.cpus().length);
    console.log(
      `НутриКод master pid=${process.pid} — starting ${workers} worker(s); gemini concurrency=${GEMINI_CONCURRENCY_MAX}; chat rate ${CHAT_RATE_MINUTE_MAX}/${CHAT_RATE_MINUTE_WINDOW_MS}ms + ${CHAT_RATE_BURST_MAX}/${CHAT_RATE_BURST_WINDOW_MS}ms`
    );
    for (let i = 0; i < workers; i++) {
      cluster.fork();
    }
    cluster.on('exit', (worker, code, signal) => {
      console.warn(
        `Worker ${worker.process.pid} exited (code=${code}, signal=${signal || 'n/a'}) — respawning`
      );
      cluster.fork();
    });
  } else {
    // Bind loopback only — nginx on the same host proxies; do not expose :3000 publicly.
    app.listen(PORT, '127.0.0.1', () => {
      console.log(
        `НутриКод worker pid=${process.pid} on http://127.0.0.1:${PORT} (keys: ${
          GEMINI_KEY_SLOTS.length
        }, active: ${activeGeminiKeyId || 'n/a'}, origin: ${GEMINI_API_ORIGIN}, model: ${GEMINI_MODEL}, chain: ${GEMINI_MODEL_CHAIN.join('→')})`
      );
    });
  }
}

module.exports = {
  app,
  parseModelChain,
  isOverloadError,
  isKeyFailoverError,
  summarizeGeminiError,
  openGeminiStream,
  openGeminiStreamWithKey,
  generateGeminiReply,
  generateFullReply,
  isServiceEnabled,
  setServiceEnabled,
  SERVICE_DISABLED_USER_MESSAGE,
  SERVICE_PATH,
  expandPartnerChipsForBot,
  stripModelAdDisclosures,
  stripRecipeCategoryLabels,
  stripTrailingDuplicateProductList,
  buildCompactAdDisclosure,
  botDisclosureShortName,
  BOT_LINKS_MAX,
  parseBotProductTag,
  GEMINI_API_ORIGIN,
  GEMINI_KEY_SLOTS,
  pickPartner,
  isLivePartner,
  partnerPayload,
  INTENT_RE,
  OVERLOAD_USER_MESSAGE,
  GEMINI_BUSY_USER_MESSAGE,
  MAX_MESSAGE_CHARS,
  CHAT_RATE_MINUTE_MAX,
  CHAT_RATE_MINUTE_WINDOW_MS,
  CHAT_RATE_BURST_MAX,
  CHAT_RATE_BURST_WINDOW_MS,
  GEMINI_CONCURRENCY_MAX,
  acquireGeminiSlot,
  releaseGeminiSlot,
  ADMIN_AUTH_FAIL_MAX,
  recordAdminAuthFail,
  clearAdminAuthFails,
  isAdminIpBanned,
  GEMINI_MODEL,
  GEMINI_MODEL_CHAIN,
  DEFAULT_FALLBACK_MODELS,
  CHAT_MODES,
  MODE_IDS,
  MODE_DETECT,
  loadModes,
  normalizeModeId,
  resolveChatMode,
  modeOverlayBlock,
  buildSystemInstruction,
  buildAdmitadUlpUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
  buildAuchanAdmitadUrl,
  resolveAuchanTargetUrl,
  resolveAuchanProductSlug,
  buildBefitAdmitadUrl,
  resolveBefitTargetUrl,
  resolveBefitProgramSlug,
  buildHvalwatersAdmitadUrl,
  resolveHvalwatersTargetUrl,
  resolveHvalwatersProductSlug,
  buildGrowfoodAdmitadUrl,
  resolveGrowfoodTargetUrl,
  resolveGrowfoodProgramSlug,
  normalizeAdmitadBase,
  looksLikeAdmitadWebmaster,
  resolveVkusvillDeeplinkConfig,
  resolveVipfishDeeplinkConfig,
  resolveAuchanDeeplinkConfig,
  resolveAuchanFirstOrder,
  resolveBefitDeeplinkConfig,
  resolveHvalwatersDeeplinkConfig,
  resolveGrowfoodDeeplinkConfig,
  VKUSVILL_SEARCH_PREFIX,
  VKUSVILL_DEEPLINK,
  VIPFISH_SEARCH_PREFIX,
  VIPFISH_DEEPLINK,
  VIPFISH_GEO_CITIES,
  AUCHAN_SEARCH_PREFIX,
  AUCHAN_PRODUCT_PREFIX,
  AUCHAN_DEEPLINK,
  AUCHAN_GEO_CITIES,
  BEFIT_SEARCH_PREFIX,
  BEFIT_PROGRAM_PREFIX,
  BEFIT_DEEPLINK,
  BEFIT_GEO_CITIES,
  BEFIT_PROGRAM_SLUGS,
  BEFIT_PROGRAM_ALIASES,
  HVALWATERS_SEARCH_PREFIX,
  HVALWATERS_PRODUCT_PREFIX,
  HVALWATERS_DEEPLINK,
  HVALWATERS_GEO_CITIES,
  HVALWATERS_PRODUCT_SLUGS,
  HVALWATERS_PRODUCT_ALIASES,
  GROWFOOD_SEARCH_PREFIX,
  GROWFOOD_CATALOG_URL,
  GROWFOOD_PROGRAM_PREFIX,
  GROWFOOD_DEEPLINK,
  GROWFOOD_GEO_CITIES,
  GROWFOOD_PROGRAM_SLUGS,
  GROWFOOD_PROGRAM_ALIASES,
};
