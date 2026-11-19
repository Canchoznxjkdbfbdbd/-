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

/**
 * Product auto-deeplink (Admitad ulp).
 * Pattern: merchant search/program URL → encodeURIComponent into webmaster base as &ulp=.
 * VkusVill search (verified 200): https://vkusvill.ru/search/?q=
 * Важная рыба search (verified 200): https://vipfish.ru/search/?q=
 * BeFit: WP search https://letbefit.ru/?s= ( /search/?q= → 404); programs /programmy/{slug}/.
 * Хваловская вода: WP https://hvalwaters.ru/?s= (/search/?q= → 404); products /water/{slug}/.
 * GrowFood: order hub https://growfood.pro/new-order/ (no WP search); lines /new-order/{slug}.
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
 * (vkusvill.ru / vipfish.ru / letbefit.ru / hvalwaters.ru / growfood.pro / gf.ru).
 * VV kdbov.com; рыба dorinebeaumont.com; BeFit uuwgc.com; Hvalwaters xmknb.com;
 * GrowFood naiawork.com; classic admitad.com also ok.
 */
function looksLikeAdmitadWebmaster(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return false;
  if (
    /vkusvill\.ru|vipfish\.ru|letbefit\.ru|hvalwaters\.ru|growfood\.pro|gf\.ru/i.test(
      value
    )
  ) {
    return false;
  }
  return /kdbov\.com|dorinebeaumont\.com|uuwgc\.com|xmknb\.com|naiawork\.com|admitad\.com|ad\.admitad\.com/i.test(
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
  8192
);
const MAX_CONTINUES = 2;
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
const SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, 'prompt.txt'), 'utf8');
const PARTNERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'partners.json'), 'utf8'));
const VKUSVILL_DEEPLINK = resolveVkusvillDeeplinkConfig(PARTNERS);
const VIPFISH_DEEPLINK = resolveVipfishDeeplinkConfig(PARTNERS);
const BEFIT_DEEPLINK = resolveBefitDeeplinkConfig(PARTNERS);
const HVALWATERS_DEEPLINK = resolveHvalwatersDeeplinkConfig(PARTNERS);
const GROWFOOD_DEEPLINK = resolveGrowfoodDeeplinkConfig(PARTNERS);

/**
 * Quiet chat-mode overlays (надстройки). Same bot + short context block.
 * Explicit UI choice is primary; keyword detect is only a fallback for «Обычный».
 */
const CHAT_MODES = {
  normal: {
    id: 'normal',
    label: 'Обычный',
    overlay: '',
  },
  kids: {
    id: 'kids',
    label: 'Детский стол',
    overlay:
      'Режим-надстройка: детский / семейный стол.\n' +
      'На первом ответе (стартер / мало данных) — ТОЛЬКО 1–2 коротких уточнения: возраст детей?, аллергии?, на сегодня или на неделю? ' +
      'Без меню, без стены рациона, без брендов, без [[меток]] и корзины. ' +
      'После ответов: одно блюдо или набор на всех, мягкий вкус; без отдельного «детского меню» как диеты. ' +
      'Для детей — общие принципы еды и коротко: это не замена педиатру или нутрициологу.',
  },
  notime: {
    id: 'notime',
    label: 'Нет времени',
    overlay:
      'Режим-надстройка: нет времени.\n' +
      'На первом ответе (стартер / мало данных) — ТОЛЬКО 1–2 коротких уточняющих вопроса БЕЗ города: ' +
      'готовить самим быстро или готовая доставка на неделю?, аллергии одной фразой. ' +
      'Запрещено в первом ответе: город / «откуда вы?» / «укажите город» / MSK·SPb-опрос, ' +
      '2–4 варианта меню, тосты/йогурт/авокадо списком, лекция про БЖУ, бренды (BeFit / GrowFood и др.), [[метки]], корзина. ' +
      'Город спроси позже и мягко (помощь: что реально привезут, без пустых ссылок) — только когда уже ясна ' +
      'доставка / готовые рационы / корзина / партнёрские ссылки, а город ещё неизвестен. ' +
      'После clarifications: если MSK/SPb и человек открыт к готовой еде на неделю — мягко один недельный пакет ' +
      '(BeFit ИЛИ GrowFood, не оба); если готовят сами — 2–4 очень коротких варианта без длинных рецептов; ' +
      'корзину — только по явному шопингу.',
  },
  grocery: {
    id: 'grocery',
    label: 'Список покупок',
    overlay:
      'Режим-надстройка: список покупок.\n' +
      'На первом ответе — ТОЛЬКО 1–2 уточнения БЕЗ города: на сейчас/день/неделю? на сколько человек? ограничения? ' +
      'Без длинного эссе, без [[меток]], без BeFit/GrowFood, пока человек не ответил. ' +
      'Город — позже и мягко (что реально доставят / без пустых ссылок), если нужны партнёрские ссылки и город неизвестен. ' +
      'После уточнений — короткий маркированный список продуктов (не портянка), без брендов и выдуманных ссылок; ' +
      'недельный пакет BeFit или GrowFood — только если MSK/SPb + нет времени готовить + человек открыт (один бренд).',
  },
};

const MODE_IDS = Object.keys(CHAT_MODES);

/** Secondary auto-detect from Russian wording — never overrides an explicit non-normal mode. */
const MODE_DETECT = [
  {
    id: 'kids',
    re: /детск|реб[её]н|малыш|школьник|для\s+семьи|семейный\s+стол|на\s+всех/i,
  },
  {
    id: 'notime',
    re: /нет\s+времени|некогда|на\s+скорую|быстр(?:о|ый|ая|ое)\s+(?:ужин|обед|завтрак|еда)|15\s*мин|без\s+плиты/i,
  },
  {
    id: 'grocery',
    re: /список\s+покупок|что\s+купить|закупк|набрать\s+в\s+магазин|список\s+на\s+\d/i,
  },
];

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

/**
 * Resolve active mode: explicit UI id wins; if «normal», optionally detect from latest user text.
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
      if (rule.re.test(text)) {
        const mode = CHAT_MODES[rule.id];
        return { id: mode.id, label: mode.label, overlay: mode.overlay, source: 'detected' };
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

const CHAT_RATE_WINDOW_MS = 15 * 60 * 1000;
const CHAT_RATE_MAX = 15;
const RL_CHANNEL = 'nutrikod:rl';

/**
 * Rate-limit counters live in the master so every worker shares one 15/15min budget per IP.
 * Workers talk to master over cluster IPC; single-process / tests keep the default MemoryStore.
 */
function createClusterRateLimitStore(windowMs) {
  let seq = 0;
  const pending = new Map();

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
      process.send({ channel: RL_CHANNEL, op, key, id });
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

/** Master-side map for createClusterRateLimitStore IPC. */
function attachClusterRateLimitMaster(windowMs) {
  const buckets = new Map();

  const reply = (worker, id, result) => {
    try {
      worker.send({ channel: RL_CHANNEL, id, result });
    } catch {
      /* worker already gone */
    }
  };

  const handle = (worker, msg) => {
    if (!msg || msg.channel !== RL_CHANNEL) return;
    const now = Date.now();
    const key = String(msg.key || '');
    let entry = buckets.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { hits: 0, resetTime: now + windowMs };
      buckets.set(key, entry);
    }

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

/** Chat flood guard: 15 requests / 15 min per IP. */
const chatLimiter = rateLimit({
  windowMs: CHAT_RATE_WINDOW_MS,
  max: CHAT_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  ...(cluster.isWorker ? { store: createClusterRateLimitStore(CHAT_RATE_WINDOW_MS) } : {}),
  message: {
    type: 'error',
    text: 'Вы слишком часто общаетесь с ИИ, подождите немного',
  },
});

app.get('/api/config', (_req, res) => {
  res.json({
    hasKey: Boolean(GEMINI_API_KEY),
    communityVkUrl: COMMUNITY_VK_URL,
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
      promoCode: VKUSVILL_DEEPLINK.promoCode,
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
      promoCode: BEFIT_DEEPLINK.promoCode,
      promos: BEFIT_DEEPLINK.promos,
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
      promoCode: HVALWATERS_DEEPLINK.promoCode,
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
      promoCode: GROWFOOD_DEEPLINK.promoCode,
      promos: GROWFOOD_DEEPLINK.promos,
      disclaimer: GROWFOOD_DEEPLINK.disclaimer,
      legalName: GROWFOOD_DEEPLINK.legalName,
      inn: GROWFOOD_DEEPLINK.inn,
      name: GROWFOOD_DEEPLINK.name,
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

  const live = PARTNERS.filter(isLivePartner);
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
    promo_code: partner.promo_code || null,
  };
}

/** System prompt + optional mode overlay. Partner offers stay UI-only. */
function buildSystemInstruction(mode = null) {
  const extra = modeOverlayBlock(mode);
  return SYSTEM_PROMPT + extra;
}

function toGeminiContents(messages) {
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, 8000) }],
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
  writeEvent(res, { type: 'done', mock: true, finishReason: 'STOP' });
  res.end();
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
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

  if (!GEMINI_API_KEY) {
    writeEvent(res, {
      type: 'notice',
      text: 'Ключ GEMINI_API_KEY не задан — показываю демо-ответ, чтобы можно было оценить интерфейс.',
    });
    await streamMock(res, partner);
    return;
  }

  writeEvent(res, { type: 'status', stage: 'thinking' });

  const systemInstruction = { parts: [{ text: buildSystemInstruction(mode) }] };
  let contents = toGeminiContents(messages);
  const generationConfig = {
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  try {
    console.info(
      `[gemini] chat turns=${messages.length} mode=${mode.id}/${mode.source} partner=${partner ? partner.id : 'none'} maxOutputTokens=${MAX_OUTPUT_TOKENS} chain=${GEMINI_MODEL_CHAIN.join(
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
        writeEvent(res, {
          type: 'error',
          text: opened?.errorText || OVERLOAD_USER_MESSAGE,
        });
        writeEvent(res, { type: 'done', finishReason: finishReason || 'ERROR' });
        res.end();
        return;
      }

      activeModel = opened.model;

      if (!signaledTyping) {
        writeEvent(res, { type: 'status', stage: 'typing' });
        signaledTyping = true;
      }

      let segment;
      try {
        segment = await readGeminiSse(opened.upstream.body, (text) => {
          writeEvent(res, { type: 'token', text });
        });
      } catch (err) {
        if (err?.geminiError) {
          const calm = summarizeGeminiError(
            err.geminiError.code || 500,
            JSON.stringify({ error: err.geminiError }),
            activeModel
          );
          writeEvent(res, { type: 'error', text: calm });
          writeEvent(res, { type: 'done', finishReason: 'ERROR' });
          res.end();
          return;
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

    if (partner) {
      writeEvent(res, { type: 'partner', partner: partnerPayload(partner) });
    }

    console.info(
      `[gemini] done model=${activeModel} chunks=${tokenCount} finishReason=${finishReason || 'n/a'} continues=${continues} chars=${assembled.length}`
    );
    writeEvent(res, {
      type: 'done',
      finishReason: finishReason || 'STOP',
      truncated: finishReason === 'MAX_TOKENS',
      model: activeModel,
    });
    res.end();
  } catch (err) {
    console.error('[gemini] stream failed', redactSecrets(err?.message || String(err)));
    writeEvent(res, {
      type: 'error',
      text: 'Связь прервалась. Проверьте сеть и напишите снова.',
    });
    writeEvent(res, { type: 'done' });
    res.end();
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

if (require.main === module) {
  // Master: one worker per CPU; workers serve HTTP. Dead workers are forked again — master stays up.
  if (cluster.isPrimary) {
    attachClusterRateLimitMaster(CHAT_RATE_WINDOW_MS);
    const workers = Math.max(1, os.cpus().length);
    console.log(`НутриКод master pid=${process.pid} — starting ${workers} worker(s)`);
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
    app.listen(PORT, '0.0.0.0', () => {
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
  GEMINI_API_ORIGIN,
  GEMINI_KEY_SLOTS,
  pickPartner,
  isLivePartner,
  partnerPayload,
  INTENT_RE,
  OVERLOAD_USER_MESSAGE,
  GEMINI_MODEL,
  GEMINI_MODEL_CHAIN,
  DEFAULT_FALLBACK_MODELS,
  CHAT_MODES,
  MODE_IDS,
  normalizeModeId,
  resolveChatMode,
  modeOverlayBlock,
  buildSystemInstruction,
  buildAdmitadUlpUrl,
  buildVkusvillAdmitadUrl,
  buildVipfishAdmitadUrl,
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
  resolveBefitDeeplinkConfig,
  resolveHvalwatersDeeplinkConfig,
  resolveGrowfoodDeeplinkConfig,
  VKUSVILL_SEARCH_PREFIX,
  VKUSVILL_DEEPLINK,
  VIPFISH_SEARCH_PREFIX,
  VIPFISH_DEEPLINK,
  VIPFISH_GEO_CITIES,
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
