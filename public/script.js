(() => {
  const GREETING =
    'Подберём рацион под вашу жизнь — без регистрации. Напишите или выберите короткий старт.';

  /** Kept for older localStorage threads that still store the bundled first question. */
  const FIRST_QUESTION =
    'Расскажите коротко: как вы питаетесь сейчас, есть ли аллергии или ограничения, и какую цель хотите — энергия, лёгкость, набор, поддержка после нагрузок или что-то ещё?';

  /** Show quiet donate strip only after this many user messages. */
  const DONATE_AFTER_TURNS = 3;

  /** Fallback if /api/config has no communityVkUrl — keep in sync with server COMMUNITY_VK_URL. */
  const COMMUNITY_VK_URL_DEFAULT = 'https://vk.ru/ai.nutricode';

  /** Calm Russian wait stages — rotate short variants so it doesn’t feel canned. */
  const THINKING_STATUS = ['Думает…', 'Что-то прикидывает…', 'Собирает мысли…'];
  const TYPING_STATUS = ['Печатает…', 'Набирает ответ…', 'Подбирает слова…'];

  const DONATE_VARIANTS = [
    { id: 'a', copy: 'Если откликнулось — киньте мелочь админу на полезное, а то он на тостах.' },
    { id: 'b', copy: 'Бесплатно, как совет про овощи. Поддержка — по желанию, кнопки ниже.' },
  ];

  function pickStatus(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function isStatusPhrase(text) {
    const t = String(text || '');
    return THINKING_STATUS.includes(t) || TYPING_STATUS.includes(t);
  }

  const MODE_STORAGE_KEY = 'nutrikod_mode';
  const MODE_IDS = ['normal', 'kids', 'notime', 'grocery'];
  const HistoryStore = window.NutriKodHistory;

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const clearChatBtn = document.getElementById('clear-chat');
  const donateBanner = document.getElementById('donate-banner');
  const donateCopy = document.getElementById('donate-copy');
  const donateDismiss = document.getElementById('donate-dismiss');
  const communityVkLink = document.getElementById('community-vk');
  const emptyStart = document.getElementById('empty-start');
  const modeBar = document.getElementById('mode-bar');
  const modeChips = Array.from(document.querySelectorAll('.mode-chip'));
  const starterChips = Array.from(document.querySelectorAll('.starter-chip'));

  /** @type {{role: string, content: string}[]} */
  let history = [];
  let streaming = false;
  let partnerShown = false;
  let donateUrl = '#donate';
  let communityVkUrl = COMMUNITY_VK_URL_DEFAULT;
  /** @type {{enabled:boolean,admitadBase:string,erid:string,searchPrefix:string,disclaimer:string,legalName:string,inn:string}} */
  let vkusvillDeeplink = {
    enabled: false,
    admitadBase: '',
    erid: '',
    searchPrefix: 'https://vkusvill.ru/search/?q=',
    disclaimer: '',
    legalName: 'АО «ВкусВилл»',
    inn: '7734443270',
  };
  /** @type {{enabled:boolean,admitadBase:string,erid:string,searchPrefix:string,disclaimer:string,legalName:string,inn:string,name:string,tagPrefixes:string[]}} */
  let vipfishDeeplink = {
    enabled: false,
    admitadBase: '',
    erid: '',
    searchPrefix: 'https://vipfish.ru/search/?q=',
    disclaimer: '',
    legalName: 'ООО «Кейтеринг-Рент»',
    inn: '7804597213',
    name: 'Важная рыба',
    tagPrefixes: ['vipfish', 'ryba'],
  };
  /** @type {{enabled:boolean,admitadBase:string,erid:string,searchPrefix:string,programPrefix:string,programSlugs:string[],programAliases:Record<string,string>,disclaimer:string,legalName:string,inn:string,name:string,tagPrefixes:string[],promoCode:string|null,promos:object[]}} */
  let befitDeeplink = {
    enabled: false,
    admitadBase: '',
    erid: '',
    searchPrefix: 'https://letbefit.ru/?s=',
    programPrefix: 'https://letbefit.ru/programmy/',
    programSlugs: [],
    programAliases: {},
    disclaimer: '',
    legalName: 'ООО «АЛ-МУЛК»',
    inn: '7713441603',
    name: 'BeFit',
    tagPrefixes: ['befit', 'letbefit'],
    promoCode: null,
    promos: [],
  };
  /** @type {{enabled:boolean,admitadBase:string,erid:string,searchPrefix:string,productPrefix:string,productSlugs:string[],productAliases:Record<string,string>,disclaimer:string,legalName:string,inn:string,name:string,tagPrefixes:string[],promoCode:string|null,couponAdmitadBase:string|null}} */
  let hvalwatersDeeplink = {
    enabled: false,
    admitadBase: '',
    erid: '',
    searchPrefix: 'https://hvalwaters.ru/?s=',
    productPrefix: 'https://hvalwaters.ru/water/',
    productSlugs: [],
    productAliases: {},
    disclaimer: '',
    legalName: 'ООО «АКВАСИТИ»',
    inn: '7816714891',
    name: 'Хваловская вода',
    tagPrefixes: ['hval', 'water', 'hvalwaters'],
    promoCode: null,
    couponAdmitadBase: null,
  };
  let userTurns = 0;
  let selectedMode = 'normal';

  function hasUserMessage() {
    return history.some((m) => m.role === 'user');
  }

  function setEmptyChrome(on) {
    if (emptyStart) emptyStart.hidden = !on;
    if (modeBar) modeBar.hidden = on;
    starterChips.forEach((chip) => {
      chip.disabled = streaming;
    });
  }

  function syncSessionChrome() {
    const hasUser = hasUserMessage();
    setEmptyChrome(!hasUser);
    syncClearButton();
  }

  function persistChat() {
    if (!HistoryStore) return;
    // Keep localStorage empty until the person actually writes — empty starters alone are not a session.
    if (!hasUserMessage()) {
      HistoryStore.clear(window.localStorage);
    } else {
      HistoryStore.save(window.localStorage, { messages: history, partnerShown, userTurns });
    }
    syncSessionChrome();
  }

  let clearArmed = false;

  function setClearArmed(on) {
    clearArmed = Boolean(on);
    if (!clearChatBtn) return;
    clearChatBtn.textContent = clearArmed ? 'Точно очистить?' : 'Очистить чат';
    clearChatBtn.classList.toggle('armed', clearArmed);
    clearChatBtn.setAttribute('aria-expanded', clearArmed ? 'true' : 'false');
  }

  function syncClearButton() {
    if (!clearChatBtn) return;
    const hasUser = hasUserMessage();
    clearChatBtn.hidden = !hasUser;
    clearChatBtn.disabled = streaming;
    if (!hasUser || streaming) setClearArmed(false);
  }

  function resetToFreshChat() {
    messagesEl.innerHTML = '';
    history = [];
    partnerShown = false;
    userTurns = 0;
    if (donateBanner) donateBanner.hidden = true;
    if (HistoryStore) HistoryStore.clear(window.localStorage);
    syncSessionChrome();
    input.focus();
  }

  function renderRestoredHistory(saved) {
    messagesEl.innerHTML = '';
    history = saved.messages.slice();
    partnerShown = Boolean(saved.partnerShown);
    userTurns =
      typeof saved.userTurns === 'number' && saved.userTurns > 0
        ? saved.userTurns
        : history.filter((m) => m.role === 'user').length;

    let sawUser = false;
    for (const msg of history) {
      if (msg.role === 'user') {
        sawUser = true;
        addMessage('user', msg.content);
      } else {
        const text = HistoryStore
          ? HistoryStore.displayAssistantText(GREETING, FIRST_QUESTION, msg.content)
          : msg.content;
        // Feedback only after the person has written — no 👍👎 on a lonely opener.
        addMessage('assistant', text, { feedback: sawUser });
      }
    }
    syncSessionChrome();
    showDonateBanner();
  }

  function normalizeMode(id) {
    const value = String(id || '').trim().toLowerCase();
    return MODE_IDS.includes(value) ? value : 'normal';
  }

  function readStoredMode() {
    try {
      return normalizeMode(sessionStorage.getItem(MODE_STORAGE_KEY));
    } catch {
      return 'normal';
    }
  }

  function persistMode(id) {
    try {
      sessionStorage.setItem(MODE_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }

  function setMode(id, { persist = true } = {}) {
    selectedMode = normalizeMode(id);
    modeChips.forEach((chip) => {
      const on = chip.dataset.mode === selectedMode;
      chip.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (persist) persistMode(selectedMode);
  }

  modeChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      if (streaming) return;
      setMode(chip.dataset.mode);
    });
  });

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /**
   * Build Admitad deeplink: search URL → double-encode into admitadBase as ulp=.
   * Base must be Admitad webmaster (kdbov… / dorinebeaumont… / uuwgc… / xmknb…), never raw merchant landing.
   */
  function buildAdmitadUlpUrl(productName, cfg) {
    const name = String(productName || '').trim();
    const base = String((cfg && cfg.admitadBase) || '').trim();
    const prefix = String((cfg && cfg.searchPrefix) || '').trim();
    if (!name || !base || !prefix) return null;
    const target = `${prefix}${encodeURIComponent(name)}`;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}ulp=${encodeURIComponent(target)}`;
  }

  /** BeFit: known program slug → /programmy/{slug}/; else WP ?s= search. */
  function resolveBefitTargetUrl(label) {
    const raw = String(label || '').trim();
    if (!raw) return null;
    let key = raw.toLowerCase().replace(/^\/+/, '');
    key = key.replace(/^programmy\//i, '').replace(/\/+$/, '');
    key = key.replace(/\s+/g, ' ').trim();
    const aliases = befitDeeplink.programAliases || {};
    const slugs = Array.isArray(befitDeeplink.programSlugs)
      ? befitDeeplink.programSlugs.map((s) => String(s).toLowerCase())
      : [];
    const slugSet = new Set(slugs);
    let slug = aliases[key] || aliases[key.replace(/\s+/g, '')] || null;
    if (!slug && slugSet.has(key)) slug = key;
    if (!slug && /^[a-z0-9_-]+$/i.test(key) && slugSet.has(key.toLowerCase())) {
      slug = key.toLowerCase();
    }
    if (slug) {
      const programPrefix = String(
        befitDeeplink.programPrefix || 'https://letbefit.ru/programmy/'
      ).replace(/\/?$/, '/');
      return `${programPrefix}${slug}/`;
    }
    const prefix = String(befitDeeplink.searchPrefix || 'https://letbefit.ru/?s=');
    return `${prefix}${encodeURIComponent(raw)}`;
  }

  function buildBefitAdmitadUrl(label) {
    const target = resolveBefitTargetUrl(label);
    const base = String(befitDeeplink.admitadBase || '').trim();
    if (!target || !base) return null;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}ulp=${encodeURIComponent(target)}`;
  }

  /** Hvalwaters: known product slug → /water/{slug}/; else WP ?s= search. */
  function resolveHvalwatersTargetUrl(label) {
    const raw = String(label || '').trim();
    if (!raw) return null;
    let key = raw.toLowerCase().replace(/^\/+/, '');
    key = key.replace(/^water\//i, '').replace(/\/+$/, '');
    key = key.replace(/\s+/g, ' ').trim();
    const aliases = hvalwatersDeeplink.productAliases || {};
    const slugs = Array.isArray(hvalwatersDeeplink.productSlugs)
      ? hvalwatersDeeplink.productSlugs.map((s) => String(s).toLowerCase())
      : [];
    const slugSet = new Set(slugs);
    let slug = aliases[key] || aliases[key.replace(/\s+/g, '')] || null;
    if (!slug && slugSet.has(key)) slug = key;
    if (!slug && /^[a-z0-9_-]+$/i.test(key) && slugSet.has(key.toLowerCase())) {
      slug = key.toLowerCase();
    }
    if (slug) {
      const productPrefix = String(
        hvalwatersDeeplink.productPrefix || 'https://hvalwaters.ru/water/'
      ).replace(/\/?$/, '/');
      return `${productPrefix}${slug}/`;
    }
    const prefix = String(hvalwatersDeeplink.searchPrefix || 'https://hvalwaters.ru/?s=');
    return `${prefix}${encodeURIComponent(raw)}`;
  }

  function buildHvalwatersAdmitadUrl(label) {
    const target = resolveHvalwatersTargetUrl(label);
    const base = String(hvalwatersDeeplink.admitadBase || '').trim();
    if (!target || !base) return null;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}ulp=${encodeURIComponent(target)}`;
  }

  function parseProductTag(inner) {
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
      const fishPrefixes = (vipfishDeeplink.tagPrefixes || ['vipfish', 'ryba']).map((p) =>
        String(p).toLowerCase()
      );
      const befitPrefixes = (befitDeeplink.tagPrefixes || ['befit', 'letbefit']).map((p) =>
        String(p).toLowerCase()
      );
      const hvalPrefixes = (hvalwatersDeeplink.tagPrefixes || ['hval', 'water', 'hvalwaters']).map(
        (p) => String(p).toLowerCase()
      );
      if (fishPrefixes.includes(prefix)) {
        return { kind: 'product', label, store: 'vipfish' };
      }
      if (befitPrefixes.includes(prefix)) {
        return { kind: 'product', label, store: 'befit' };
      }
      if (hvalPrefixes.includes(prefix)) {
        return { kind: 'product', label, store: 'hvalwaters' };
      }
      // Unknown prefix (e.g. magnit:) — show label only; do not invent links.
      return { kind: 'plain', label, store: null };
    }
    return { kind: 'product', label: raw, store: 'vkusvill' };
  }

  function disclosureLine(cfg, fallbackName) {
    if (!cfg || !cfg.erid) return '';
    if (cfg.disclaimer) return String(cfg.disclaimer).trim();
    const legal = String(cfg.legalName || fallbackName || '').trim();
    const inn = String(cfg.inn || '').trim();
    const bits = ['Реклама.'];
    if (legal) bits.push(inn ? `${legal}, ИНН ${inn}.` : `${legal}.`);
    bits.push(`erid: ${cfg.erid}`);
    return bits.join(' ');
  }

  function storePartnerId(store) {
    if (store === 'vipfish') return 'vazhnaya-ryba';
    if (store === 'befit') return 'befit';
    if (store === 'hvalwaters') return 'hvalwaters';
    if (store === 'vkusvill') return 'vkusvill';
    return '';
  }

  function storeDisplayName(store) {
    if (store === 'vipfish') return vipfishDeeplink.name || 'Важная рыба';
    if (store === 'befit') return befitDeeplink.name || 'BeFit';
    if (store === 'hvalwaters') return hvalwatersDeeplink.name || 'Хваловская вода';
    if (store === 'vkusvill') return 'ВкусВилл';
    return '';
  }

  function cartBlockTitleForStore(store) {
    // Grocery / fish basket vs ready programs & water delivery.
    if (store === 'befit' || store === 'hvalwaters') return 'Полезные ссылки';
    return 'Собрать корзину';
  }

  function makeProductChip(hit) {
    const a = document.createElement('a');
    a.className = 'product-chip';
    a.href = hit.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer sponsored';
    a.textContent = hit.label;
    const partnerId = storePartnerId(hit.store);
    if (partnerId) a.dataset.partner = partnerId;
    const name = storeDisplayName(hit.store);
    if (hit.store === 'vipfish') a.title = `${name} — поиск`;
    else if (hit.store === 'befit') a.title = `${name} — программа / поиск`;
    else if (hit.store === 'hvalwaters') a.title = `${name} — товар / поиск`;
    else a.title = 'ВкусВилл — поиск';
    return a;
  }

  /**
   * Strip [[product]] / [[vipfish:…]] / [[befit:…]] / [[hval:…]] from prose (plain names);
   * collect Admitad chips for the cart block under the message. Hide [[partner:id]].
   * Incomplete trailing [[… stays plain text while streaming.
   */
  function renderProductDeeplinks(text) {
    const src = String(text || '');
    const re = /\[\[([^\]]+)\]\]/g;
    /** @type {{start:number,end:number,label:string,store:string|null,kind:string,href:string|null}[]} */
    const hits = [];
    let m;
    while ((m = re.exec(src))) {
      const parsed = parseProductTag(m[1]);
      if (!parsed) continue;
      let href = null;
      if (parsed.kind === 'product' && parsed.store === 'vkusvill' && vkusvillDeeplink.enabled) {
        href = buildAdmitadUlpUrl(parsed.label, vkusvillDeeplink);
      } else if (parsed.kind === 'product' && parsed.store === 'vipfish' && vipfishDeeplink.enabled) {
        href = buildAdmitadUlpUrl(parsed.label, vipfishDeeplink);
      } else if (parsed.kind === 'product' && parsed.store === 'befit' && befitDeeplink.enabled) {
        href = buildBefitAdmitadUrl(parsed.label);
      } else if (
        parsed.kind === 'product' &&
        parsed.store === 'hvalwaters' &&
        hvalwatersDeeplink.enabled
      ) {
        href = buildHvalwatersAdmitadUrl(parsed.label);
      }
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        label: parsed.label,
        store: parsed.store,
        kind: parsed.kind,
        href,
      });
    }

    const root = document.createDocumentFragment();
    let cursor = 0;
    let vvCount = 0;
    let fishCount = 0;
    let befitCount = 0;
    let hvalCount = 0;
    /** @type {{label:string,store:string,href:string}[]} */
    const chips = [];

    const pushText = (chunk) => {
      if (!chunk) return;
      root.appendChild(document.createTextNode(chunk));
    };

    for (const hit of hits) {
      if (hit.start < cursor) continue;
      pushText(src.slice(cursor, hit.start));
      if (hit.kind === 'partner') {
        // Keep raw [[partner:id]] for strip/partner UI on richer branches; hide visibly.
        pushText('');
      } else if (hit.href && hit.store) {
        // Prose stays readable plain names; clickable chips live in the cart block.
        pushText(hit.label);
        chips.push({ label: hit.label, store: hit.store, href: hit.href });
        if (hit.store === 'vipfish') fishCount += 1;
        else if (hit.store === 'befit') befitCount += 1;
        else if (hit.store === 'hvalwaters') hvalCount += 1;
        else vvCount += 1;
      } else {
        // No Admitad base / unknown prefix — show product name without raw brackets.
        pushText(hit.label);
      }
      cursor = hit.end;
    }
    pushText(src.slice(cursor));

    /** @type {string[]} */
    const disclosures = [];
    if (vvCount >= 1) {
      const line = disclosureLine(vkusvillDeeplink, 'АО «ВкусВилл»');
      if (line) disclosures.push(line);
    }
    if (fishCount >= 1) {
      const line = disclosureLine(vipfishDeeplink, 'ООО «Кейтеринг-Рент»');
      if (line) disclosures.push(line);
    }
    if (befitCount >= 1) {
      const line = disclosureLine(befitDeeplink, 'ООО «АЛ-МУЛК»');
      if (line) disclosures.push(line);
    }
    if (hvalCount >= 1) {
      const line = disclosureLine(hvalwatersDeeplink, 'ООО «АКВАСИТИ»');
      if (line) disclosures.push(line);
    }

    /** @type {string|null} */
    let primaryStore = null;
    if (hvalCount >= 1) primaryStore = 'hvalwaters';
    else if (befitCount >= 1) primaryStore = 'befit';
    else if (fishCount >= 1) primaryStore = 'vipfish';
    else if (vvCount >= 1) primaryStore = 'vkusvill';

    return {
      fragment: root,
      chips,
      primaryStore,
      linkCount: vvCount + fishCount + befitCount + hvalCount,
      disclosures,
      erid:
        hvalCount >= 1
          ? hvalwatersDeeplink.erid || ''
          : befitCount >= 1
            ? befitDeeplink.erid || ''
            : fishCount >= 1
              ? vipfishDeeplink.erid || ''
              : vvCount >= 1
                ? vkusvillDeeplink.erid || ''
                : '',
    };
  }

  function insertBeforeMessageMeta(wrap, el) {
    const tip = wrap.querySelector(':scope > .ad-disclosure');
    const feedback = wrap.querySelector(':scope > .feedback');
    if (tip) wrap.insertBefore(el, tip);
    else if (feedback) wrap.insertBefore(el, feedback);
    else wrap.appendChild(el);
  }

  function syncAdDisclosure(wrap, disclosures) {
    if (!wrap) return;
    const lines = Array.isArray(disclosures) ? disclosures.filter(Boolean) : [];
    let tip = wrap.querySelector(':scope > .ad-disclosure');
    if (lines.length) {
      if (!tip) {
        tip = document.createElement('p');
        tip.className = 'ad-disclosure';
        const feedback = wrap.querySelector(':scope > .feedback');
        if (feedback) wrap.insertBefore(tip, feedback);
        else wrap.appendChild(tip);
      }
      tip.textContent = lines.join(' ');
    } else if (tip) {
      tip.remove();
    }
  }

  /**
   * Cart / useful-links block under the assistant message.
   * Preserves an existing .partner plaque (moves it in/out as chips appear).
   */
  function syncCartBlock(wrap, chips, primaryStore) {
    if (!wrap) return;
    const list = Array.isArray(chips) ? chips.filter((c) => c && c.href && c.label) : [];
    let block = wrap.querySelector(':scope > .cart-block');

    if (!list.length) {
      if (block) {
        const orphan = block.querySelector('.partner');
        if (orphan) {
          insertBeforeMessageMeta(wrap, orphan);
        }
        block.remove();
      }
      return;
    }

    if (!block) {
      block = document.createElement('div');
      block.className = 'cart-block';
      block.setAttribute('role', 'complementary');
      insertBeforeMessageMeta(wrap, block);
      // If a partner plaque already landed on the wrap, nest it into the cart block.
      const loosePartner = wrap.querySelector(':scope > .partner');
      if (loosePartner) block.appendChild(loosePartner);
    }

    block.setAttribute('aria-label', cartBlockTitleForStore(primaryStore));

    let title = block.querySelector(':scope > .cart-block-title');
    if (!title) {
      title = document.createElement('div');
      title.className = 'cart-block-title';
      block.insertBefore(title, block.firstChild);
    }
    title.textContent = cartBlockTitleForStore(primaryStore);

    let cta = block.querySelector(':scope > .cart-block-cta');
    if (!cta) {
      cta = document.createElement('p');
      cta.className = 'cart-block-cta';
      title.after(cta);
    }
    cta.textContent =
      'Когда рацион уже ясен — эти ссылки помогут сэкономить время и деньги.';

    let storeHint = block.querySelector(':scope > .cart-block-store');
    const storeName = storeDisplayName(primaryStore);
    if (storeName) {
      if (!storeHint) {
        storeHint = document.createElement('p');
        storeHint.className = 'cart-block-store';
        cta.after(storeHint);
      }
      storeHint.textContent = storeName;
    } else if (storeHint) {
      storeHint.remove();
      storeHint = null;
    }

    let chipRow = block.querySelector(':scope > .cart-block-chips');
    if (!chipRow) {
      chipRow = document.createElement('div');
      chipRow.className = 'cart-block-chips';
      const partner = block.querySelector(':scope > .partner');
      if (partner) block.insertBefore(chipRow, partner);
      else block.appendChild(chipRow);
    } else {
      // Keep chip row above partner plaque if both exist.
      const partner = block.querySelector(':scope > .partner');
      if (partner && chipRow.nextElementSibling !== partner) {
        block.insertBefore(chipRow, partner);
      }
    }

    chipRow.replaceChildren();
    for (const hit of list) {
      chipRow.appendChild(makeProductChip(hit));
    }
  }

  /** Paint assistant bubble: plain names in prose; chips + soft CTA in cart block under the message. */
  function fillAssistantBubble(bubble, text, wrap) {
    const { fragment, chips, primaryStore, disclosures } = renderProductDeeplinks(text);
    bubble.replaceChildren(fragment);
    if (wrap) {
      syncCartBlock(wrap, chips, primaryStore);
      syncAdDisclosure(wrap, disclosures);
    }
  }

  function addMessage(role, text, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}${opts.notice ? ' notice' : ''}${opts.error ? ' error' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);

    if (role === 'assistant' && opts.feedback) {
      const fb = document.createElement('div');
      fb.className = 'feedback';
      fb.innerHTML =
        '<button type="button" data-v="up" aria-label="Полезно">👍</button>' +
        '<button type="button" data-v="down" aria-label="Не очень">👎</button>';
      fb.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        fb.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        try {
          const key = 'nutrikod_fb';
          const prev = JSON.parse(localStorage.getItem(key) || '[]');
          prev.push({ v: btn.dataset.v, t: Date.now() });
          localStorage.setItem(key, JSON.stringify(prev.slice(-100)));
        } catch {
          /* ignore */
        }
      });
      wrap.appendChild(fb);
    }

    if (role === 'assistant' && !opts.notice && !opts.error) {
      fillAssistantBubble(bubble, text, wrap);
    } else {
      bubble.textContent = text;
    }

    messagesEl.appendChild(wrap);
    scrollBottom();
    return { wrap, bubble };
  }

  function isRealPartnerLink(link) {
    const href = String(link || '').trim();
    if (!/^https?:\/\/\S+/i.test(href)) return false;
    // Never paint placeholder demo hosts even if a bad payload slips through.
    if (/^https?:\/\/(www\.)?example\.com(\/|$)/i.test(href)) return false;
    return true;
  }

  /** Quiet offer below the assistant bubble — nest into cart block when present. */
  function attachPartner(wrap, partner) {
    if (!partner || !wrap) return;
    if (!isRealPartnerLink(partner.link)) return;
    // One promo plaque per reply.
    if (wrap.querySelector('.partner')) return;

    const box = document.createElement('div');
    box.className = 'partner';
    box.setAttribute('role', 'complementary');
    box.setAttribute('aria-label', 'Партнёрское предложение');

    const title = document.createElement('div');
    title.className = 'partner-title';
    title.textContent =
      partner.offer_type === 'promo' ? 'Промо от партнёра' : 'Вариант готового рациона';

    const body = document.createElement('p');
    body.className = 'partner-body';
    body.append(document.createTextNode(`${partner.name} — ${partner.blurb} `));
    const a = document.createElement('a');
    a.href = partner.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'открыть';
    body.appendChild(a);

    box.appendChild(title);
    box.appendChild(body);

    if (partner.promo_code) {
      const promo = document.createElement('p');
      promo.className = 'partner-promo';
      promo.append(document.createTextNode('Промокод: '));
      const code = document.createElement('code');
      code.textContent = String(partner.promo_code);
      promo.appendChild(code);
      box.appendChild(promo);
    }

    if (partner.disclaimer) {
      const tip = document.createElement('p');
      tip.className = 'tiny';
      tip.textContent = partner.disclaimer;
      box.appendChild(tip);
    }

    const cart = wrap.querySelector(':scope > .cart-block');
    if (cart) cart.appendChild(box);
    else insertBeforeMessageMeta(wrap, box);
    scrollBottom();
  }

  function showDonateBanner() {
    if (sessionStorage.getItem('nutrikod_donate_hide') === '1') return;
    if (userTurns < DONATE_AFTER_TURNS) return;
    if (!donateBanner.hidden) return;
    const variant = Math.random() < 0.5 ? DONATE_VARIANTS[0] : DONATE_VARIANTS[1];
    donateCopy.textContent = variant.copy;
    donateBanner.hidden = false;
    donateBanner.querySelectorAll('.donate-btn').forEach((a) => {
      const amount = a.getAttribute('data-amount');
      const base = donateUrl || '#donate';
      a.href = base.includes('?') ? `${base}&amount=${amount}` : `${base}?amount=${amount}`;
      if (base === '#donate' || base.startsWith('#')) {
        a.href = `#donate-${amount}`;
      }
    });
  }

  donateDismiss?.addEventListener('click', () => {
    donateBanner.hidden = true;
    sessionStorage.setItem('nutrikod_donate_hide', '1');
  });

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      donateUrl = data.donateUrl || '#donate';
      if (data.communityVkUrl) {
        communityVkUrl = String(data.communityVkUrl).trim() || COMMUNITY_VK_URL_DEFAULT;
      }
      if (communityVkLink && communityVkUrl) {
        communityVkLink.href = communityVkUrl;
      }
      const dl = data.vkusvillDeeplink;
      if (dl && typeof dl === 'object') {
        vkusvillDeeplink = {
          enabled: Boolean(dl.enabled && dl.admitadBase),
          admitadBase: String(dl.admitadBase || '').trim(),
          erid: String(dl.erid || '').trim(),
          searchPrefix: String(dl.searchPrefix || 'https://vkusvill.ru/search/?q=').trim(),
          disclaimer: String(dl.disclaimer || '').trim(),
          legalName: String(dl.legalName || 'АО «ВкусВилл»').trim(),
          inn: String(dl.inn || '7734443270').trim(),
        };
      }
      const fish = data.vipfishDeeplink;
      if (fish && typeof fish === 'object') {
        const prefixes = Array.isArray(fish.tagPrefixes)
          ? fish.tagPrefixes.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
          : ['vipfish', 'ryba'];
        vipfishDeeplink = {
          enabled: Boolean(fish.enabled && fish.admitadBase),
          admitadBase: String(fish.admitadBase || '').trim(),
          erid: String(fish.erid || '').trim(),
          searchPrefix: String(fish.searchPrefix || 'https://vipfish.ru/search/?q=').trim(),
          disclaimer: String(fish.disclaimer || '').trim(),
          legalName: String(fish.legalName || 'ООО «Кейтеринг-Рент»').trim(),
          inn: String(fish.inn || '7804597213').trim(),
          name: String(fish.name || 'Важная рыба').trim(),
          tagPrefixes: prefixes.length ? prefixes : ['vipfish', 'ryba'],
        };
      }
      const bf = data.befitDeeplink;
      if (bf && typeof bf === 'object') {
        const prefixes = Array.isArray(bf.tagPrefixes)
          ? bf.tagPrefixes.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
          : ['befit', 'letbefit'];
        const aliases =
          bf.programAliases && typeof bf.programAliases === 'object' ? bf.programAliases : {};
        const aliasNorm = {};
        for (const [k, v] of Object.entries(aliases)) {
          const key = String(k || '')
            .trim()
            .toLowerCase();
          const val = String(v || '').trim();
          if (key && val) aliasNorm[key] = val;
        }
        befitDeeplink = {
          enabled: Boolean(bf.enabled && bf.admitadBase),
          admitadBase: String(bf.admitadBase || '').trim(),
          erid: String(bf.erid || '').trim(),
          searchPrefix: String(bf.searchPrefix || 'https://letbefit.ru/?s=').trim(),
          programPrefix: String(bf.programPrefix || 'https://letbefit.ru/programmy/').trim(),
          programSlugs: Array.isArray(bf.programSlugs)
            ? bf.programSlugs.map((s) => String(s || '').trim()).filter(Boolean)
            : [],
          programAliases: aliasNorm,
          disclaimer: String(bf.disclaimer || '').trim(),
          legalName: String(bf.legalName || 'ООО «АЛ-МУЛК»').trim(),
          inn: String(bf.inn || '7713441603').trim(),
          name: String(bf.name || 'BeFit').trim(),
          tagPrefixes: prefixes.length ? prefixes : ['befit', 'letbefit'],
          promoCode: bf.promoCode ? String(bf.promoCode).trim() : null,
          promos: Array.isArray(bf.promos) ? bf.promos : [],
        };
      }
      const hv = data.hvalwatersDeeplink;
      if (hv && typeof hv === 'object') {
        const prefixes = Array.isArray(hv.tagPrefixes)
          ? hv.tagPrefixes.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
          : ['hval', 'water', 'hvalwaters'];
        const aliases =
          hv.productAliases && typeof hv.productAliases === 'object' ? hv.productAliases : {};
        const aliasNorm = {};
        for (const [k, v] of Object.entries(aliases)) {
          const key = String(k || '')
            .trim()
            .toLowerCase();
          const val = String(v || '').trim();
          if (key && val) aliasNorm[key] = val;
        }
        hvalwatersDeeplink = {
          enabled: Boolean(hv.enabled && hv.admitadBase),
          admitadBase: String(hv.admitadBase || '').trim(),
          erid: String(hv.erid || '').trim(),
          searchPrefix: String(hv.searchPrefix || 'https://hvalwaters.ru/?s=').trim(),
          productPrefix: String(hv.productPrefix || 'https://hvalwaters.ru/water/').trim(),
          productSlugs: Array.isArray(hv.productSlugs)
            ? hv.productSlugs.map((s) => String(s || '').trim()).filter(Boolean)
            : [],
          productAliases: aliasNorm,
          disclaimer: String(hv.disclaimer || '').trim(),
          legalName: String(hv.legalName || 'ООО «АКВАСИТИ»').trim(),
          inn: String(hv.inn || '7816714891').trim(),
          name: String(hv.name || 'Хваловская вода').trim(),
          tagPrefixes: prefixes.length ? prefixes : ['hval', 'water', 'hvalwaters'],
          promoCode: hv.promoCode ? String(hv.promoCode).trim() : null,
          couponAdmitadBase: hv.couponAdmitadBase
            ? String(hv.couponAdmitadBase).trim()
            : null,
        };
      }
      if (!data.hasKey) {
        /* mock mode is fine; notice comes with first stream */
      }
    } catch {
      /* offline demo still works after server up */
    }
  }

  async function streamReply() {
    streaming = true;
    sendBtn.disabled = true;
    syncSessionChrome();

    let full = '';
    let gotToken = false;
    /** @type {'thinking' | 'typing' | 'reply'} */
    let stage = 'thinking';
    let typingFallbackTimer = 0;
    const allowPartner = !partnerShown && userTurns >= 2;

    // Stage 1: calm “thinking” so the wait never looks like a blank chat or fake typing.
    const { wrap, bubble } = addMessage('assistant', pickStatus(THINKING_STATUS), { feedback: true });
    bubble.classList.add('typing');
    bubble.dataset.stage = 'thinking';

    const setStatus = (next, phrase) => {
      if (gotToken || stage === 'reply') return;
      // Only advance (or keep) — never flicker a new random phrase for the same stage.
      if (next === 'thinking' && stage !== 'thinking') return;
      if (stage === next) return;
      stage = next;
      bubble.dataset.stage = next;
      bubble.textContent = phrase;
      bubble.classList.add('typing');
      scrollBottom();
    };

    const beginReply = () => {
      if (gotToken) return;
      gotToken = true;
      stage = 'reply';
      bubble.dataset.stage = 'reply';
      if (typingFallbackTimer) {
        clearTimeout(typingFallbackTimer);
        typingFallbackTimer = 0;
      }
      bubble.classList.remove('typing');
      // Only clear the placeholder once — never wipe accumulated tokens later.
      bubble.textContent = '';
    };

    const paint = () => {
      fillAssistantBubble(bubble, full, wrap);
      scrollBottom();
    };

    // If the server is slow to signal “typing”, still advance the stage locally.
    typingFallbackTimer = window.setTimeout(() => {
      setStatus('typing', pickStatus(TYPING_STATUS));
    }, 1400);

    const handlePayload = (payload) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'status') {
        if (payload.stage === 'thinking') {
          setStatus('thinking', payload.text || pickStatus(THINKING_STATUS));
        } else if (payload.stage === 'typing') {
          if (typingFallbackTimer) {
            clearTimeout(typingFallbackTimer);
            typingFallbackTimer = 0;
          }
          setStatus('typing', payload.text || pickStatus(TYPING_STATUS));
        }
      } else if (payload.type === 'notice') {
        const { wrap: noticeWrap } = addMessage('assistant', payload.text, { notice: true });
        // Keep the live status/reply bubble last so stages stay in view.
        if (wrap?.parentNode && noticeWrap) {
          wrap.parentNode.insertBefore(noticeWrap, wrap);
        }
      } else if (payload.type === 'token') {
        // Ignore empty token frames so we never clear the status into a blank bubble.
        if (!payload.text) return;
        beginReply();
        full += payload.text;
        paint();
      } else if (payload.type === 'partner' && payload.partner) {
        // Do not treat partner as the start of reply text — avoids wiping status into empty.
        partnerShown = true;
        attachPartner(wrap, payload.partner);
      } else if (payload.type === 'error') {
        if (typingFallbackTimer) {
          clearTimeout(typingFallbackTimer);
          typingFallbackTimer = 0;
        }
        bubble.classList.remove('typing');
        if (!full) {
          bubble.textContent = payload.text || 'Ответ пока не пришёл. Можно повторить через минуту.';
          wrap.classList.add('error');
          stage = 'reply';
          bubble.dataset.stage = 'reply';
        }
      }
      // type:done — keep whatever text we already painted (including after continues).
    };

    const consumeEventBlock = (raw) => {
      const line = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (!line) return;
      try {
        handlePayload(JSON.parse(line.slice(5).trim()));
      } catch {
        /* skip partial / non-JSON */
      }
    };

    /** Drain complete SSE events; when flushAll, also accept a final data: without blank line. */
    const drainBuffer = (state, flushAll) => {
      let sep;
      while ((sep = state.buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = state.buffer.slice(0, sep);
        state.buffer = state.buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        consumeEventBlock(raw);
      }
      if (flushAll && state.buffer.trim()) {
        consumeEventBlock(state.buffer);
        state.buffer = '';
      }
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages: history, allowPartner, mode: selectedMode }),
      });

      if (!res.ok || !res.body) {
        if (typingFallbackTimer) {
          clearTimeout(typingFallbackTimer);
          typingFallbackTimer = 0;
        }
        bubble.classList.remove('typing');
        bubble.textContent = 'Ответ пока не пришёл. Можно повторить через минуту.';
        wrap.classList.add('error');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const state = { buffer: '' };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        state.buffer += decoder.decode(value, { stream: true });
        drainBuffer(state, false);
      }
      state.buffer += decoder.decode();
      drainBuffer(state, true);

      if (full) {
        history.push({ role: 'assistant', content: full });
        persistChat();
        paint();
      } else if (!wrap.classList.contains('error')) {
        // Never leave a blank or stuck status bubble after the stream ends.
        bubble.classList.remove('typing');
        if (!bubble.textContent || isStatusPhrase(bubble.textContent)) {
          bubble.textContent = 'Пусто пока. Напишите ещё раз — иногда помогает.';
        }
      }
    } catch {
      bubble.classList.remove('typing');
      if (!full) {
        bubble.textContent = 'Связь прервалась. Проверьте сеть и напишите снова.';
        wrap.classList.add('error');
      } else {
        // Keep partial answer visible if the connection dropped mid-stream.
        paint();
      }
    } finally {
      if (typingFallbackTimer) {
        clearTimeout(typingFallbackTimer);
        typingFallbackTimer = 0;
      }
      bubble.classList.remove('typing');
      streaming = false;
      sendBtn.disabled = false;
      syncSessionChrome();
      input.focus();
      showDonateBanner();
    }
  }

  async function sendUserText(text) {
    if (streaming) return;
    const value = String(text || '').trim();
    if (!value) return;

    addMessage('user', value);
    history.push({ role: 'user', content: value });
    userTurns += 1;
    persistChat();
    input.value = '';
    autoGrow();
    await streamReply();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (streaming) return;
    await sendUserText(input.value);
  });

  starterChips.forEach((chip) => {
    chip.addEventListener('click', async () => {
      if (streaming) return;
      const prompt = chip.getAttribute('data-prompt') || chip.textContent || '';
      await sendUserText(prompt);
    });
  });

  clearChatBtn?.addEventListener('click', () => {
    if (streaming) return;
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    if (HistoryStore) HistoryStore.clear(window.localStorage);
    setClearArmed(false);
    resetToFreshChat();
  });

  // Tap elsewhere cancels the armed clear — avoids accidental wipe.
  document.addEventListener('click', (e) => {
    if (!clearArmed || !clearChatBtn) return;
    if (e.target === clearChatBtn || clearChatBtn.contains(e.target)) return;
    setClearArmed(false);
  });

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  async function boot() {
    await loadConfig();
    setMode(readStoredMode());

    const saved = HistoryStore ? HistoryStore.load(window.localStorage) : null;
    if (saved && saved.messages.some((m) => m.role === 'user')) {
      renderRestoredHistory(saved);
    } else {
      // Empty chat: brand + invite + starters + input. No bot survey, no mode/feedback noise.
      history = [];
      syncSessionChrome();
    }
    input.focus();
  }

  boot();
})();
