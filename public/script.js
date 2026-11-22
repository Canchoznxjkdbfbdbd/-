(() => {
  const GREETING =
    'Подберём рацион под вашу жизнь — без регистрации. Напишите или выберите короткий старт.';

  /** Kept for older localStorage threads that still store the bundled first question. */
  const FIRST_QUESTION =
    'Расскажите коротко: как вы питаетесь сейчас, есть ли аллергии или ограничения, и какую цель хотите — энергия, лёгкость, набор, поддержка после нагрузок или что-то ещё?';

  /** Fallback if /api/config has no communityVkUrl — keep in sync with server COMMUNITY_VK_URL. */
  const COMMUNITY_VK_URL_DEFAULT = 'https://vk.ru/ai.nutricode';
  /** Soft support CTA placeholder until /api/config loads DONATE_URL. */
  const DONATE_URL_DEFAULT = '#donate';
  /** Fallback if /api/config has no yandexMetrikaId yet — must match live counter. */
  window.__nkMetrikaId = window.__nkMetrikaId || '114157729';

  /** Calm Russian wait stages — rotate short variants so it doesn’t feel canned. */
  const THINKING_STATUS = ['Думает…', 'Что-то прикидывает…', 'Собирает мысли…'];
  const TYPING_STATUS = ['Печатает…', 'Набирает ответ…', 'Подбирает слова…'];

  function pickStatus(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function isStatusPhrase(text) {
    const t = String(text || '');
    return THINKING_STATUS.includes(t) || TYPING_STATUS.includes(t);
  }

  const MODE_STORAGE_KEY = 'nutrikod_mode';
  const THEME_STORAGE_KEY = 'nutrikod_theme';
  /** Immediate fallback so chips are never empty before / while /api/modes loads. */
  const FALLBACK_MODES = [
    { id: 'normal', label: 'Обычный' },
    { id: 'kids', label: 'Детский стол' },
    { id: 'notime', label: 'Нет времени' },
    { id: 'grocery', label: 'Список покупок' },
  ];
  let MODE_IDS = FALLBACK_MODES.map((m) => m.id);
  const HistoryStore = window.NutriKodHistory;

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const termLive = document.getElementById('term-live');
  const termLiveText = document.getElementById('term-live-text');
  const termCapture = document.getElementById('term-capture');
  const termCaret = document.getElementById('term-caret');
  const termLinkDock = document.getElementById('term-link-dock');
  const termLinkAd = document.getElementById('term-link-ad');
  const termLinkRow = document.getElementById('term-link-row');
  const chatEl = document.querySelector('.chat');
  const sendBtn = document.getElementById('send');
  const clearChatBtn = document.getElementById('clear-chat');
  const communityVkLink = document.getElementById('community-vk');
  const termSupport = document.getElementById('term-support');
  const supportLinks = Array.from(document.querySelectorAll('.support-href'));
  const emptyStart = document.getElementById('empty-start');
  const modeBar = document.getElementById('mode-bar');
  const modeChipsEl = document.querySelector('.mode-chips');
  const themeBtns = Array.from(document.querySelectorAll('[data-theme-choice]'));
  const themeColorMeta = document.getElementById('theme-color-meta');
  /** @type {HTMLButtonElement[]} */
  let modeChips = [];
  const starterChips = Array.from(document.querySelectorAll('.starter-chip'));

  /** @type {'default' | 'terminal'} */
  let activeTheme = 'default';

  /** @type {{role: string, content: string}[]} */
  let history = [];
  let streaming = false;
  let partnerShown = false;
  let donateUrl = DONATE_URL_DEFAULT;
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
  /** @type {{enabled:boolean,admitadBase:string,erid:string,searchPrefix:string,programPrefix:string,programSlugs:string[],programAliases:Record<string,string>,disclaimer:string,legalName:string,inn:string,name:string,tagPrefixes:string[],promoCode:string|null,promos:object[]}} */
  let growfoodDeeplink = {
    enabled: false,
    admitadBase: '',
    erid: '',
    searchPrefix: 'https://growfood.pro/new-order/',
    programPrefix: 'https://growfood.pro/new-order/',
    programSlugs: [],
    programAliases: {},
    disclaimer: '',
    legalName: 'ООО «ГФ Трейд»',
    inn: '7811715411',
    name: 'GrowFood',
    tagPrefixes: ['growfood', 'gf'],
    promoCode: null,
    promos: [],
  };
  /** @type {{enabled:boolean,admitadBase:string,erid:string,searchPrefix:string,productPrefix:string,disclaimer:string,legalName:string,inn:string,name:string,tagPrefixes:string[],firstOrder:{link:string,erid:string,minOrderRub:number,discountHint:string,hint:string,cta:string}|null}} */
  let auchanDeeplink = {
    enabled: false,
    admitadBase: '',
    erid: '',
    searchPrefix: 'https://www.auchan.ru/search/?query=',
    productPrefix: 'https://www.auchan.ru/product/',
    disclaimer: '',
    legalName: 'ООО «АШАН»',
    inn: '7703270067',
    name: 'Ашан',
    tagPrefixes: ['auchan', 'ashan'],
    firstOrder: null,
  };
  let userTurns = 0;
  let selectedMode = 'normal';

  function hasUserMessage() {
    return history.some((m) => m.role === 'user');
  }

  function syncSessionChrome() {
    const hasUser = hasUserMessage();
    // Empty chat → starter chips; after first message → mode bar. Terminal hides these via CSS.
    if (emptyStart) emptyStart.hidden = hasUser;
    if (modeBar) modeBar.hidden = !hasUser;
    if (messagesEl) messagesEl.hidden = false;
    starterChips.forEach((chip) => {
      chip.disabled = streaming;
    });
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
    if (input) input.value = '';
    clearTermCapture();
    if (HistoryStore) HistoryStore.clear(window.localStorage);
    clearTermLinkDock();
    syncSessionChrome();
    syncTermLive();
    focusActiveTypeIn();
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

  function normalizeTheme(id) {
    const value = String(id || '').trim().toLowerCase();
    // Migrate legacy "matrix" storage value → terminal.
    return value === 'matrix' || value === 'terminal' ? 'terminal' : 'default';
  }

  function readStoredTheme() {
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      const id = normalizeTheme(raw);
      if (raw === 'matrix' && id === 'terminal') persistTheme('terminal');
      return id;
    } catch {
      return 'default';
    }
  }

  function persistTheme(id) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }

  function setTheme(id, { persist = true } = {}) {
    const prev = activeTheme;
    activeTheme = normalizeTheme(id);
    if (activeTheme === 'terminal') {
      document.documentElement.setAttribute('data-theme', 'terminal');
      if (themeColorMeta) themeColorMeta.setAttribute('content', '#0d1117');
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (themeColorMeta) themeColorMeta.setAttribute('content', '#1f6b4f');
      clearTermLinkDock();
    }
    themeBtns.forEach((btn) => {
      const on = btn.getAttribute('data-theme-choice') === activeTheme;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (persist) persistTheme(activeTheme);
    syncSupportChrome();
    // Re-paint transcript so Terminal shell text vs default cards stay in sync.
    if (prev !== activeTheme && !streaming && hasUserMessage()) {
      renderRestoredHistory({ messages: history, partnerShown, userTurns });
    } else {
      syncSessionChrome();
    }
    syncTermLive();
    syncTermKeyboardInset();
    focusActiveTypeIn();
  }

  /** Soft support links: Normal = footer bottom line; Terminal = fixed safe-bottom (no amounts). */
  function applySupportHrefs() {
    const base = donateUrl || DONATE_URL_DEFAULT;
    const isPlaceholder = base === '#donate' || base.startsWith('#');
    supportLinks.forEach((a) => {
      a.href = base;
      if (isPlaceholder) {
        a.removeAttribute('target');
        a.removeAttribute('rel');
      } else {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  function syncSupportChrome() {
    applySupportHrefs();
    if (termSupport) {
      termSupport.hidden = activeTheme !== 'terminal';
    }
  }

  /** While typing, keep the block caret solid; resume blink after idle. */
  let termCaretTypingTimer = 0;

  function markTermCaretTyping() {
    if (!termCaret || activeTheme !== 'terminal') return;
    termCaret.classList.add('is-typing');
    if (termCaretTypingTimer) window.clearTimeout(termCaretTypingTimer);
    termCaretTypingTimer = window.setTimeout(() => {
      termCaretTypingTimer = 0;
      if (termCaret) termCaret.classList.remove('is-typing');
    }, 520);
  }

  /** Paint the live shell line from the hidden capture field (no composer box). */
  function syncTermLive() {
    if (!termLive) return;
    const on = activeTheme === 'terminal';
    termLive.hidden = !on;
    if (!on) {
      termLive.classList.remove('is-busy');
      if (termCaret) termCaret.classList.remove('is-typing');
      return;
    }
    if (termLiveText && termCapture) {
      termLiveText.textContent = termCapture.value || '';
    }
    termLive.classList.toggle('is-busy', streaming);
    if (termCapture) termCapture.disabled = streaming;
  }

  function focusActiveTypeIn() {
    if (activeTheme === 'terminal') {
      if (termCapture && !streaming) {
        termCapture.focus({ preventScroll: true });
      }
      return;
    }
    if (input) input.focus({ preventScroll: true });
  }

  function clearTermCapture() {
    if (termCapture) termCapture.value = '';
    if (termLiveText) termLiveText.textContent = '';
  }

  function setMode(id, { persist = true } = {}) {
    selectedMode = normalizeMode(id);
    modeChips.forEach((chip) => {
      const on = chip.dataset.mode === selectedMode;
      chip.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (persist) persistMode(selectedMode);
  }

  function renderModeChips(modes) {
    if (!modeChipsEl) return;
    const list = Array.isArray(modes) ? modes : [];
    modeChipsEl.innerHTML = '';
    modeChips = list.map((mode) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mode-chip';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.mode = mode.id;
      btn.textContent = mode.label;
      btn.addEventListener('click', () => {
        if (streaming) return;
        setMode(mode.id);
      });
      modeChipsEl.appendChild(btn);
      return btn;
    });
    setMode(selectedMode, { persist: false });
  }

  /** Paint fallback chips immediately — never leave an empty mode bar. */
  renderModeChips(FALLBACK_MODES);

  async function loadModesFromApi() {
    try {
      const res = await fetch('/api/modes', { cache: 'no-store' });
      if (!res || !res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) return;
      const modes = data
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({
          id: String(m.id || '')
            .trim()
            .toLowerCase(),
          label: String(m.label || '').trim(),
        }))
        .filter((m) => m.id && m.label);
      if (!modes.length) return;
      MODE_IDS = modes.map((m) => m.id);
      renderModeChips(modes);
    } catch {
      /* keep fallback chips */
    }
  }

  function autoGrow() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  /**
   * Programmatic scroll must not re-enable streamPinBottom via the scroll listener
   * (that was the #30 failure: scrollToMessageStart → near-bottom → chase cart).
   */
  let ignoreScrollEvent = false;
  let ignoreScrollTimer = 0;

  function markProgrammaticScroll() {
    ignoreScrollEvent = true;
    if (ignoreScrollTimer) window.clearTimeout(ignoreScrollTimer);
    // Clear after the browser has delivered the synthetic scroll event (2 frames),
    // so a real user scroll-up is not swallowed by a long timeout.
    ignoreScrollTimer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        ignoreScrollEvent = false;
        ignoreScrollTimer = 0;
      });
    }, 0);
  }

  function scrollBottom() {
    // Terminal: .chat is the scrollport (messages overflow visible). Default: #messages.
    if (activeTheme === 'terminal' && chatEl) {
      markProgrammaticScroll();
      chatEl.scrollTop = chatEl.scrollHeight;
      return;
    }
    if (!messagesEl) return;
    markProgrammaticScroll();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** Near the bottom of the transcript (user is following the latest lines). */
  function isNearBottom(threshold = 96) {
    if (activeTheme === 'terminal' && chatEl) {
      return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight <= threshold;
    }
    if (!messagesEl) return true;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
  }

  /**
   * Keep Terminal output above the mobile keyboard via visualViewport.
   * Sets --term-kb-inset to the obscured bottom strip (layout − visible).
   * Also toggles data-term-kb so the bottom support CTA hides while the KB is up
   * (avoids accidental taps on the thumb/keyboard edge).
   */
  function syncTermKeyboardInset() {
    const root = document.documentElement;
    if (activeTheme !== 'terminal') {
      root.style.removeProperty('--term-kb-inset');
      root.removeAttribute('data-term-kb');
      return;
    }
    const vv = window.visualViewport;
    if (!vv) {
      root.style.removeProperty('--term-kb-inset');
      root.removeAttribute('data-term-kb');
      return;
    }
    const obscured = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--term-kb-inset', `${obscured}px`);
    if (obscured > 48) root.setAttribute('data-term-kb', '');
    else root.removeAttribute('data-term-kb');
  }

  function keepTermLiveInView() {
    if (activeTheme !== 'terminal' || !termLive || !chatEl) return;
    // After keyboard inset applies, keep the live prompt in the visible scrollport.
    requestAnimationFrame(() => {
      termLive.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function onTermViewportChange() {
    syncTermKeyboardInset();
    keepTermLiveInView();
  }

  /**
   * Autoscroll only when already following the bottom. Never force to cart / last
   * paragraph; never yank the viewport if the person scrolled up to read.
   */
  function maybeFollowBottom() {
    if (streamPinBottom) scrollBottom();
  }

  /** While streaming: pin to bottom only if the user is (or stays) at the bottom. */
  let streamPinBottom = false;

  /**
   * Build Admitad deeplink: search URL → double-encode into admitadBase as ulp=.
   * Base must be Admitad webmaster (kdbov… / dorinebeaumont… / uuwgc… / xmknb… / naiawork… / rthsu…), never raw merchant landing.
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

  /** Ашан: product/{slug} → /product/{slug}/; else search ?query=. */
  function resolveAuchanTargetUrl(label) {
    const raw = String(label || '').trim();
    if (!raw) return null;
    let key = raw.toLowerCase().replace(/^\/+/, '');
    key = key.replace(/^product\//i, '').replace(/\/+$/, '');
    const isProductPath =
      (/^[a-z0-9][a-z0-9_-]*$/i.test(key) && /[-_]/.test(key)) ||
      (/^product\//i.test(raw) && /^[a-z0-9][a-z0-9_-]*$/i.test(key));
    if (isProductPath) {
      const productPrefix = String(
        auchanDeeplink.productPrefix || 'https://www.auchan.ru/product/'
      ).replace(/\/?$/, '/');
      return `${productPrefix}${key}/`;
    }
    const prefix = String(
      auchanDeeplink.searchPrefix || 'https://www.auchan.ru/search/?query='
    );
    return `${prefix}${encodeURIComponent(raw)}`;
  }

  function buildAuchanAdmitadUrl(label) {
    const target = resolveAuchanTargetUrl(label);
    const base = String(auchanDeeplink.admitadBase || '').trim();
    if (!target || !base) return null;
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
    if (slug && !slugSet.has(String(slug).toLowerCase())) slug = null;
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
    if (slug && !slugSet.has(String(slug).toLowerCase())) slug = null;
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

  /** GrowFood: known line slug → /new-order/{slug}; else order hub /new-order/. */
  function resolveGrowfoodTargetUrl(label) {
    const raw = String(label || '').trim();
    if (!raw) return null;
    let key = raw.toLowerCase().replace(/^\/+/, '');
    key = key.replace(/^new-order\//i, '').replace(/\/+$/, '');
    key = key.replace(/\s+/g, ' ').trim();
    const aliases = growfoodDeeplink.programAliases || {};
    const slugs = Array.isArray(growfoodDeeplink.programSlugs)
      ? growfoodDeeplink.programSlugs.map((s) => String(s).toLowerCase())
      : [];
    const slugSet = new Set(slugs);
    let slug = aliases[key] || aliases[key.replace(/\s+/g, '')] || null;
    if (slug && !slugSet.has(String(slug).toLowerCase())) slug = null;
    if (!slug && slugSet.has(key)) slug = key;
    if (!slug && /^[a-z0-9_-]+$/i.test(key) && slugSet.has(key.toLowerCase())) {
      slug = key.toLowerCase();
    }
    if (slug) {
      const programPrefix = String(
        growfoodDeeplink.programPrefix || 'https://growfood.pro/new-order/'
      ).replace(/\/?$/, '/');
      return `${programPrefix}${slug}`;
    }
    return String(growfoodDeeplink.searchPrefix || 'https://growfood.pro/new-order/');
  }

  function buildGrowfoodAdmitadUrl(label) {
    const target = resolveGrowfoodTargetUrl(label);
    const base = String(growfoodDeeplink.admitadBase || '').trim();
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
      const gfPrefixes = (growfoodDeeplink.tagPrefixes || ['growfood', 'gf']).map((p) =>
        String(p).toLowerCase()
      );
      const auchanPrefixes = (auchanDeeplink.tagPrefixes || ['auchan', 'ashan']).map((p) =>
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
    if (store === 'auchan') return 'auchan';
    if (store === 'befit') return 'befit';
    if (store === 'hvalwaters') return 'hvalwaters';
    if (store === 'growfood') return 'growfood';
    if (store === 'vkusvill') return 'vkusvill';
    return '';
  }

  function storeDisplayName(store) {
    if (store === 'vipfish') return vipfishDeeplink.name || 'Важная рыба';
    if (store === 'auchan') return auchanDeeplink.name || 'Ашан';
    if (store === 'befit') return befitDeeplink.name || 'BeFit';
    if (store === 'hvalwaters') return hvalwatersDeeplink.name || 'Хваловская вода';
    if (store === 'growfood') return growfoodDeeplink.name || 'GrowFood';
    if (store === 'vkusvill') return 'ВкусВилл';
    return '';
  }

  function cartBlockTitleForStore(store) {
    // Grocery / fish basket vs ready programs & water delivery.
    if (store === 'befit' || store === 'hvalwaters' || store === 'growfood') {
      return 'Полезные ссылки';
    }
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
    else if (hit.store === 'auchan') a.title = `${name} — поиск / товар`;
    else if (hit.store === 'befit') a.title = `${name} — программа / поиск`;
    else if (hit.store === 'hvalwaters') a.title = `${name} — товар / поиск`;
    else if (hit.store === 'growfood') a.title = `${name} — линейка / каталог`;
    else a.title = 'ВкусВилл — поиск';
    return a;
  }

  /** Strip [[…]] to plain product names (no chips) — hard kill cart dump on first soft reply. */
  function stripBracketTags(text) {
    return String(text || '').replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
      const parsed = parseProductTag(inner);
      if (!parsed) return String(inner || '').trim();
      if (parsed.kind === 'partner') return '';
      return parsed.label || String(inner || '').trim();
    });
  }

  /**
   * Hide recipe block headers (neural structure) — keep product names after the colon.
   * Clarify-first replies have no such headers; leave them untouched.
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
   * Strip [[product]] / [[vipfish:…]] / [[auchan:…]] / [[befit:…]] / [[hval:…]] / [[growfood:…]] from prose
   * (plain names); collect Admitad chips for the cart block under the message. Hide [[partner:id]].
   * Incomplete trailing [[… stays plain text while streaming.
   * @param {string} text
   * @param {{ allowChips?: boolean }} [opts] — allowChips=false: plain names only, empty chip list
   */
  function renderProductDeeplinks(text, opts = {}) {
    const allowChips = opts.allowChips !== false;
    const src = String(text || '');
    const re = /\[\[([^\]]+)\]\]/g;
    /** @type {{start:number,end:number,label:string,store:string|null,kind:string,href:string|null}[]} */
    const hits = [];
    let m;
    while ((m = re.exec(src))) {
      const parsed = parseProductTag(m[1]);
      if (!parsed) continue;
      let href = null;
      if (allowChips && parsed.kind === 'product' && parsed.store === 'vkusvill' && vkusvillDeeplink.enabled) {
        href = buildAdmitadUlpUrl(parsed.label, vkusvillDeeplink);
      } else if (allowChips && parsed.kind === 'product' && parsed.store === 'vipfish' && vipfishDeeplink.enabled) {
        href = buildAdmitadUlpUrl(parsed.label, vipfishDeeplink);
      } else if (allowChips && parsed.kind === 'product' && parsed.store === 'auchan' && auchanDeeplink.enabled) {
        href = buildAuchanAdmitadUrl(parsed.label);
      } else if (allowChips && parsed.kind === 'product' && parsed.store === 'befit' && befitDeeplink.enabled) {
        href = buildBefitAdmitadUrl(parsed.label);
      } else if (
        allowChips &&
        parsed.kind === 'product' &&
        parsed.store === 'hvalwaters' &&
        hvalwatersDeeplink.enabled
      ) {
        href = buildHvalwatersAdmitadUrl(parsed.label);
      } else if (
        allowChips &&
        parsed.kind === 'product' &&
        parsed.store === 'growfood' &&
        growfoodDeeplink.enabled
      ) {
        href = buildGrowfoodAdmitadUrl(parsed.label);
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
    let auchanCount = 0;
    let befitCount = 0;
    let hvalCount = 0;
    let gfCount = 0;
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
        else if (hit.store === 'auchan') auchanCount += 1;
        else if (hit.store === 'befit') befitCount += 1;
        else if (hit.store === 'hvalwaters') hvalCount += 1;
        else if (hit.store === 'growfood') gfCount += 1;
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
    if (auchanCount >= 1) {
      const line = disclosureLine(auchanDeeplink, 'ООО «АШАН»');
      if (line) disclosures.push(line);
      const fo = auchanDeeplink.firstOrder;
      if (fo && fo.erid && fo.erid !== auchanDeeplink.erid) {
        const legal = String(auchanDeeplink.legalName || 'ООО «АШАН»').trim();
        const inn = String(auchanDeeplink.inn || '').trim();
        const bits = ['Реклама.'];
        if (legal) bits.push(inn ? `${legal}, ИНН ${inn}.` : `${legal}.`);
        bits.push(`erid: ${fo.erid}`);
        disclosures.push(bits.join(' '));
      }
    }
    if (befitCount >= 1) {
      const line = disclosureLine(befitDeeplink, 'ООО «АЛ-МУЛК»');
      if (line) disclosures.push(line);
    }
    if (hvalCount >= 1) {
      const line = disclosureLine(hvalwatersDeeplink, 'ООО «АКВАСИТИ»');
      if (line) disclosures.push(line);
    }
    if (gfCount >= 1) {
      const line = disclosureLine(growfoodDeeplink, 'ООО «ГФ Трейд»');
      if (line) disclosures.push(line);
    }

    /** @type {string|null} */
    let primaryStore = null;
    if (gfCount >= 1) primaryStore = 'growfood';
    else if (hvalCount >= 1) primaryStore = 'hvalwaters';
    else if (befitCount >= 1) primaryStore = 'befit';
    else if (auchanCount >= 1) primaryStore = 'auchan';
    else if (fishCount >= 1) primaryStore = 'vipfish';
    else if (vvCount >= 1) primaryStore = 'vkusvill';

    return {
      fragment: root,
      chips,
      primaryStore,
      linkCount: vvCount + fishCount + auchanCount + befitCount + hvalCount + gfCount,
      disclosures,
      erid:
        gfCount >= 1
          ? growfoodDeeplink.erid || ''
          : hvalCount >= 1
            ? hvalwatersDeeplink.erid || ''
            : befitCount >= 1
              ? befitDeeplink.erid || ''
              : auchanCount >= 1
                ? auchanDeeplink.erid || ''
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

    syncAuchanFirstOrderCta(block, list);
  }

  /**
   * Extra CTA under Auchan cart chips: first-order Admitad landing (user builds cart).
   * Does not replace grocery search deeplinks.
   */
  function syncAuchanFirstOrderCta(block, chips) {
    if (!block) return;
    const hasAuchan = (Array.isArray(chips) ? chips : []).some((c) => c && c.store === 'auchan');
    const fo = auchanDeeplink && auchanDeeplink.firstOrder;
    let plaque = block.querySelector(':scope > .cart-block-first-order');

    if (!hasAuchan || !fo || !fo.link) {
      if (plaque) plaque.remove();
      return;
    }

    if (!plaque) {
      plaque = document.createElement('div');
      plaque.className = 'cart-block-first-order';
      const partner = block.querySelector(':scope > .partner');
      const chipRow = block.querySelector(':scope > .cart-block-chips');
      if (partner) block.insertBefore(plaque, partner);
      else if (chipRow) chipRow.after(plaque);
      else block.appendChild(plaque);
    } else {
      const partner = block.querySelector(':scope > .partner');
      if (partner && plaque.nextElementSibling !== partner) {
        block.insertBefore(plaque, partner);
      }
    }

    let hint = plaque.querySelector(':scope > .cart-block-first-order-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'cart-block-first-order-hint';
      plaque.appendChild(hint);
    }
    hint.textContent =
      fo.hint ||
      'Если раньше не заказывали в Ашане — на заказ от 4 000 ₽ скидка больше 800 ₽';

    let btn = plaque.querySelector(':scope > .cart-block-first-order-btn');
    if (!btn) {
      btn = document.createElement('a');
      btn.className = 'cart-block-first-order-btn';
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer sponsored';
      plaque.appendChild(btn);
    }
    btn.href = fo.link;
    btn.textContent = fo.cta || 'Забрать скидку на первый заказ';
    btn.dataset.partner = 'auchan';
    btn.dataset.offer = 'firstOrder';
  }

  /**
   * Terminal 1+4: strip markdown chrome to plain RU shell text.
   * Lists become «– …»; no code fences / headings / emphasis markers.
   */
  function formatTerminalPlain(text) {
    let s = String(text || '');
    s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, body) => String(body || '').replace(/\s+$/g, ''));
    s = s.replace(/`([^`]+)`/g, '$1');
    s = s.replace(/^#{1,6}\s+/gm, '');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/\*([^*\n]+)\*/g, '$1');
    s = s.replace(/_([^_\n]+)_/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    s = s.replace(/^\s*>\s?/gm, '');
    s = s.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '');
    s = s.replace(/^\s*[-*+]\s+/gm, '– ');
    s = s.replace(/^\s*\d+[.)]\s+/gm, '– ');
    // Collapse leftover blank runs from stripped markdown blocks.
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.replace(/^\s+|\s+$/g, '');
  }

  function clearTerminalExtras(wrap) {
    if (!wrap) return;
    wrap.querySelectorAll(':scope > .cart-block, :scope > .partner, :scope > .ad-disclosure, :scope > .feedback').forEach((el) => {
      el.remove();
    });
  }

  /** Linux-style ad lines above Terminal product buttons (no English chrome). */
  function formatTermAdMark(disclosures) {
    const lines = Array.isArray(disclosures) ? disclosures.filter(Boolean) : [];
    /** @type {string[]} */
    const erids = [];
    for (const line of lines) {
      const re = /erid\s*[:=]\s*([A-Za-z0-9_-]+)/gi;
      let m;
      while ((m = re.exec(String(line)))) {
        const id = String(m[1] || '').trim();
        if (id && !erids.includes(id)) erids.push(id);
      }
    }
    if (!erids.length && !lines.length) return '';
    if (!erids.length) {
      return '# реклама';
    }
    const bits = erids.map((id) => `#   erid: ${id}`);
    return ['# реклама · Admitad', ...bits].join('\n');
  }

  /** Terminal dock: product buttons at the bottom of the output zone (composer stays on top). */
  function clearTermLinkDock() {
    if (termLinkRow) termLinkRow.replaceChildren();
    if (termLinkAd) termLinkAd.textContent = '';
    if (termLinkDock) termLinkDock.hidden = true;
  }

  function syncTermLinkDock(chips, disclosures) {
    if (!termLinkDock || !termLinkRow || !termLinkAd) return;
    if (activeTheme !== 'terminal') {
      clearTermLinkDock();
      return;
    }
    const list = Array.isArray(chips) ? chips.filter((c) => c && c.href && c.label) : [];
    if (!list.length) {
      clearTermLinkDock();
      return;
    }
    const ad = formatTermAdMark(disclosures);
    termLinkAd.textContent = ad;
    termLinkAd.hidden = !ad;
    termLinkRow.replaceChildren();
    for (const chip of list) {
      const a = document.createElement('a');
      a.className = 'term-link-btn';
      a.href = chip.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer sponsored';
      a.textContent = chip.label;
      const partnerId = storePartnerId(chip.store);
      if (partnerId) a.dataset.partner = partnerId;
      if (chip.store === 'vipfish') a.title = `${chip.label} — поиск`;
      else if (chip.store === 'auchan') a.title = `${chip.label} — поиск / товар`;
      else if (chip.store === 'befit') a.title = `${chip.label} — программа / поиск`;
      else if (chip.store === 'hvalwaters') a.title = `${chip.label} — товар / поиск`;
      else if (chip.store === 'growfood') a.title = `${chip.label} — линейка / каталог`;
      else a.title = 'ВкусВилл — поиск';
      termLinkRow.appendChild(a);
    }
    termLinkDock.hidden = false;
  }

  /** Paint assistant bubble: plain names in prose; chips + soft CTA in cart block under the message. */
  function fillAssistantBubble(bubble, text, wrap, opts = {}) {
    // First user turn (starter / opening) — never paint cart chips even if the model dumped [[tags]].
    const allowChips = opts.allowChips != null ? Boolean(opts.allowChips) : userTurns >= 2;
    const visible = stripRecipeCategoryLabels(text);

    // Terminal: clean shell text in the transcript; product links as bottom dock buttons.
    if (activeTheme === 'terminal') {
      const { chips, disclosures } = renderProductDeeplinks(visible, { allowChips });
      bubble.textContent = formatTerminalPlain(stripBracketTags(visible));
      clearTerminalExtras(wrap);
      syncTermLinkDock(chips, disclosures);
      return;
    }

    clearTermLinkDock();
    const { fragment, chips, primaryStore, disclosures } = renderProductDeeplinks(visible, { allowChips });
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

    if (role === 'assistant' && opts.feedback && activeTheme !== 'terminal') {
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
    } else if (role === 'assistant' && activeTheme === 'terminal') {
      bubble.textContent = formatTerminalPlain(text);
    } else {
      bubble.textContent = text;
    }

    messagesEl.appendChild(wrap);
    // User just sent → show their bubble. Assistant/notice → only if already near bottom.
    if (role === 'user' || isNearBottom()) scrollBottom();
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
    // Terminal keeps clean shell text — no partner cards.
    if (activeTheme === 'terminal') return;
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
    // Promo codes are hidden from chat UI; keep Admitad chips/links only.

    if (partner.disclaimer) {
      const tip = document.createElement('p');
      tip.className = 'tiny';
      tip.textContent = partner.disclaimer;
      box.appendChild(tip);
    }

    const cart = wrap.querySelector(':scope > .cart-block');
    if (cart) cart.appendChild(box);
    else insertBeforeMessageMeta(wrap, box);
    // Partner/cart growth must not yank scroll unless the user is already following.
    maybeFollowBottom();
  }

  function scheduleYandexMetrika(rawId) {
    var id = String(rawId || '').trim();
    if (!id || !/^\d{5,12}$/.test(id)) return;
    if (window.__nkMetrikaScheduled) return;
    window.__nkMetrikaScheduled = true;

    var start = function () {
      if (window.__nkMetrikaStarted) return;
      window.__nkMetrikaStarted = true;
      try {
        if (typeof window.ym === 'function') {
          window.ym(Number(id), 'init', {
            clickmap: true,
            trackLinks: true,
            accurateTrackBounce: true,
            webvisor: false,
          });
          return;
        }
      } catch (_e0) {
        /* continue to inject */
      }

      var settled = false;
      var scriptEl = document.createElement('script');
      scriptEl.async = true;
      scriptEl.defer = true;
      scriptEl.src = 'https://mc.yandex.ru/metrika/tag.js';

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try {
          if (scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
        } catch (_e1) {
          /* ignore */
        }
      }, 4000);

      scriptEl.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (typeof window.ym === 'function') {
            window.ym(Number(id), 'init', {
              clickmap: true,
              trackLinks: true,
              accurateTrackBounce: true,
              webvisor: false,
            });
          }
        } catch (_e2) {
          /* ignore */
        }
      };
      scriptEl.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
      };

      try {
        (document.body || document.documentElement).appendChild(scriptEl);
      } catch (_e3) {
        settled = true;
        clearTimeout(timer);
      }
    };

    // After first paint / chat boot: idle + short delay so iOS loading bar can finish.
    var delay = function () {
      setTimeout(start, 2000);
    };
    try {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(delay, { timeout: 4000 });
      } else {
        delay();
      }
    } catch (_e4) {
      delay();
    }
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      if (!res || !res.ok) {
        scheduleYandexMetrika(window.__nkMetrikaId || '');
        return;
      }
      const data = await res.json();
      if (data.donateUrl != null) {
        const raw = String(data.donateUrl).trim();
        donateUrl = raw || DONATE_URL_DEFAULT;
      }
      applySupportHrefs();
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
      const gf = data.growfoodDeeplink;
      if (gf && typeof gf === 'object') {
        const prefixes = Array.isArray(gf.tagPrefixes)
          ? gf.tagPrefixes.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
          : ['growfood', 'gf'];
        const aliases =
          gf.programAliases && typeof gf.programAliases === 'object' ? gf.programAliases : {};
        const aliasNorm = {};
        for (const [k, v] of Object.entries(aliases)) {
          const key = String(k || '')
            .trim()
            .toLowerCase();
          const val = String(v || '').trim();
          if (key && val) aliasNorm[key] = val;
        }
        growfoodDeeplink = {
          enabled: Boolean(gf.enabled && gf.admitadBase),
          admitadBase: String(gf.admitadBase || '').trim(),
          erid: String(gf.erid || '').trim(),
          searchPrefix: String(gf.searchPrefix || 'https://growfood.pro/new-order/').trim(),
          programPrefix: String(gf.programPrefix || 'https://growfood.pro/new-order/').trim(),
          programSlugs: Array.isArray(gf.programSlugs)
            ? gf.programSlugs.map((s) => String(s || '').trim()).filter(Boolean)
            : [],
          programAliases: aliasNorm,
          disclaimer: String(gf.disclaimer || '').trim(),
          legalName: String(gf.legalName || 'ООО «ГФ Трейд»').trim(),
          inn: String(gf.inn || '7811715411').trim(),
          name: String(gf.name || 'GrowFood').trim(),
          tagPrefixes: prefixes.length ? prefixes : ['growfood', 'gf'],
          promoCode: gf.promoCode ? String(gf.promoCode).trim() : null,
          promos: Array.isArray(gf.promos) ? gf.promos : [],
        };
      }
      const au = data.auchanDeeplink;
      if (au && typeof au === 'object') {
        const prefixes = Array.isArray(au.tagPrefixes)
          ? au.tagPrefixes.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
          : ['auchan', 'ashan'];
        const foRaw = au.firstOrder && typeof au.firstOrder === 'object' ? au.firstOrder : null;
        const foLink = foRaw ? String(foRaw.link || '').trim() : '';
        const foErid = foRaw ? String(foRaw.erid || '').trim() : '';
        const foMin = foRaw && foRaw.minOrderRub != null ? Number(foRaw.minOrderRub) : NaN;
        auchanDeeplink = {
          enabled: Boolean(au.enabled && au.admitadBase),
          admitadBase: String(au.admitadBase || '').trim(),
          erid: String(au.erid || '').trim(),
          searchPrefix: String(au.searchPrefix || 'https://www.auchan.ru/search/?query=').trim(),
          productPrefix: String(au.productPrefix || 'https://www.auchan.ru/product/').trim(),
          disclaimer: String(au.disclaimer || '').trim(),
          legalName: String(au.legalName || 'ООО «АШАН»').trim(),
          inn: String(au.inn || '7703270067').trim(),
          name: String(au.name || 'Ашан').trim(),
          tagPrefixes: prefixes.length ? prefixes : ['auchan', 'ashan'],
          firstOrder:
            foLink && /^https?:\/\//i.test(foLink)
              ? {
                  link: foLink,
                  erid: foErid,
                  minOrderRub: Number.isFinite(foMin) && foMin > 0 ? Math.round(foMin) : 4000,
                  discountHint: String(foRaw.discountHint || 'больше 800 ₽').trim(),
                  hint: String(foRaw.hint || '').trim(),
                  cta: String(foRaw.cta || 'Забрать скидку на первый заказ').trim(),
                }
              : null,
        };
      }
      scheduleYandexMetrika(data.yandexMetrikaId || window.__nkMetrikaId || '');
      if (!data.hasKey) {
        /* mock mode is fine; notice comes with first stream */
      }
    } catch {
      scheduleYandexMetrika(window.__nkMetrikaId || '');
      /* offline demo still works after server up */
    }
  }

  async function streamReply() {
    streaming = true;
    sendBtn.disabled = true;
    syncSessionChrome();
    syncTermLive();

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

    // Pin to bottom only if the user was already following the latest lines.
    // Never force scroll to message start / cart (that jump survived #30).
    streamPinBottom = isNearBottom();
    const onStreamScroll = () => {
      // Ignore our own scrollBottom writes — otherwise a short first paint re-pins
      // and later cart growth yanks the viewport to the last paragraph.
      if (ignoreScrollEvent) return;
      streamPinBottom = isNearBottom();
    };
    // Terminal scrollport is .chat; Ordinary keeps #messages.
    const streamScrollEl =
      activeTheme === 'terminal' && chatEl ? chatEl : messagesEl;
    streamScrollEl.addEventListener('scroll', onStreamScroll, { passive: true });

    const setStatus = (next, phrase) => {
      if (gotToken || stage === 'reply') return;
      // Only advance (or keep) — never flicker a new random phrase for the same stage.
      if (next === 'thinking' && stage !== 'thinking') return;
      if (stage === next) return;
      stage = next;
      bubble.dataset.stage = next;
      bubble.textContent = phrase;
      bubble.classList.add('typing');
      maybeFollowBottom();
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
      // Do NOT force scrollToMessageStart / scrollBottom here — that re-fired the
      // scroll listener in #30, re-enabled pin-to-bottom, then chased the cart.
      // Follow only via maybeFollowBottom while streamPinBottom stays true.
    };

    // Hard gate: first reply after a starter must not grow a cart/BeFit chip row.
    const allowChipsThisReply = userTurns >= 2;

    const paint = () => {
      // Snapshot before layout grows (cart under reply). Only follow if the user
      // was already pinned/near bottom — never yank a scrolled-up reader to cart.
      const follow = streamPinBottom;
      fillAssistantBubble(bubble, full, wrap, { allowChips: allowChipsThisReply });
      if (follow) scrollBottom();
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
        // Never attach soft ads on the first user turn (starter dump path).
        if (userTurns >= 2 && allowChipsThisReply) {
          partnerShown = true;
          attachPartner(wrap, payload.partner);
        }
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
      } else if (payload.type === 'done') {
        // Reconcile with server-assembled text (covers dropped trailing SSE frames).
        const serverText = typeof payload.text === 'string' ? payload.text : '';
        if (serverText && serverText.length >= full.length && serverText !== full) {
          beginReply();
          full = serverText;
          paint();
        } else if (serverText && !full) {
          beginReply();
          full = serverText;
          paint();
        }
        if (payload.truncated && full && activeTheme !== 'terminal') {
          // Soft notice only in Ordinary — Terminal stays clean shell text.
          let tip = wrap.querySelector(':scope > .stream-truncated-tip');
          if (!tip) {
            tip = document.createElement('p');
            tip.className = 'stream-truncated-tip';
            tip.textContent = 'Ответ оборвался на середине — напишите «продолжи», если нужно добить.';
            insertBeforeMessageMeta(wrap, tip);
          }
        }
      }
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
        // Persist without [[tags]] on first soft reply so restore can't resurrect chips.
        const content = allowChipsThisReply ? full : stripBracketTags(full);
        history.push({ role: 'assistant', content });
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
      streamScrollEl.removeEventListener('scroll', onStreamScroll);
      streamPinBottom = false;
      ignoreScrollEvent = false;
      if (ignoreScrollTimer) {
        window.clearTimeout(ignoreScrollTimer);
        ignoreScrollTimer = 0;
      }
      if (typingFallbackTimer) {
        clearTimeout(typingFallbackTimer);
        typingFallbackTimer = 0;
      }
      bubble.classList.remove('typing');
      streaming = false;
      sendBtn.disabled = false;
      syncSessionChrome();
      // Focus type-in (inline shell or default composer); do not scroll to cart.
      syncTermLive();
      focusActiveTypeIn();
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
    clearTermCapture();
    autoGrow();
    syncTermLive();
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

  themeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const choice = btn.getAttribute('data-theme-choice') || 'default';
      setTheme(choice);
    });
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

  // Terminal: type character-by-character in the shell window (hidden capture field).
  if (termCapture) {
    termCapture.addEventListener('input', () => {
      syncTermLive();
      markTermCaretTyping();
      // Keep the live line in view while wrapping grows / keyboard is open.
      keepTermLiveInView();
    });
    termCapture.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (streaming) return;
        sendUserText(termCapture.value);
        return;
      }
      markTermCaretTyping();
    });
    termCapture.addEventListener('focus', () => {
      syncTermKeyboardInset();
      keepTermLiveInView();
    });
    termCapture.addEventListener('blur', () => {
      // Keyboard closing — clear inset after the viewport settles.
      window.setTimeout(syncTermKeyboardInset, 120);
    });
  }

  // Mobile keyboard: shrink the Terminal output zone with visualViewport.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onTermViewportChange);
    window.visualViewport.addEventListener('scroll', onTermViewportChange);
  }
  window.addEventListener('resize', onTermViewportChange);

  // Click anywhere in the shell to keep typing focus on the live prompt.
  if (termLive) {
    termLive.addEventListener('mousedown', (e) => {
      if (activeTheme !== 'terminal' || streaming) return;
      e.preventDefault();
      focusActiveTypeIn();
    });
  }
  document.addEventListener('mousedown', (e) => {
    if (activeTheme !== 'terminal' || streaming) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.theme-toggle, .theme-btn, a, button, .term-link-dock')) return;
    if (t.closest('.shell, .term-live, .messages')) {
      // Defer so button clicks still fire; then reclaim focus for type-in.
      window.setTimeout(() => focusActiveTypeIn(), 0);
    }
  });

  async function boot() {
    setTheme(readStoredTheme(), { persist: false });
    await loadConfig();
    await loadModesFromApi();
    setMode(readStoredMode());

    const saved = HistoryStore ? HistoryStore.load(window.localStorage) : null;
    if (saved && saved.messages.some((m) => m.role === 'user')) {
      renderRestoredHistory(saved);
    } else {
      // Empty chat: brand + invite + starters + input. No bot survey, no mode/feedback noise.
      history = [];
      syncSessionChrome();
    }
    syncTermLive();
    focusActiveTypeIn();
  }

  boot();
})();
