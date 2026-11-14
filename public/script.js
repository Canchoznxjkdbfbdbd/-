(() => {
  const GREETING =
    'Залог хорошего самочувствия — это сбалансированное питание. Иногда его нужно подбирать индивидуально. Приступим...';

  const FIRST_QUESTION =
    'Расскажите коротко: как вы питаетесь сейчас, есть ли аллергии или ограничения, и какую цель хотите — энергия, лёгкость, набор, поддержка после нагрузок или что-то ещё?';

  /** Show quiet donate strip only after this many user messages. */
  const DONATE_AFTER_TURNS = 3;

  /**
   * One user message cap — JS string .length (same as server MAX_USER_MESSAGE_CHARS).
   * Synced from /api/config when available; maxlength attribute stays in lockstep.
   */
  let maxUserMessageChars = 2000;

  /** Calm Russian wait stages — rotate short variants so it doesn’t feel canned. */
  const THINKING_STATUS = ['Думает…', 'Что-то прикидывает…', 'Собирает мысли…'];
  const TYPING_STATUS = ['Печатает…', 'Набирает ответ…', 'Подбирает слова…'];

  const DONATE_SOFT_COPY = 'Хотите поддержать проект или дать обратную связь?';
  /** Fallback if /api/config has no communityVkUrl — keep in sync with server COMMUNITY_VK_URL. */
  const COMMUNITY_VK_URL_DEFAULT = 'https://vk.ru/ai.nutricode';

  function pickStatus(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  const WAIT_STATUS_EXTRA = [
    'Ещё думаю…',
    'Модель отвечает дольше обычного…',
    'Модель отвечает дольше обычного — почти готово…',
    'Почти готово, ещё чуть-чуть…',
    'Думает…',
    'Печатает…',
  ];

  function isStatusPhrase(text) {
    const t = String(text || '');
    return (
      THINKING_STATUS.includes(t) ||
      TYPING_STATUS.includes(t) ||
      WAIT_STATUS_EXTRA.includes(t)
    );
  }

  const MODE_STORAGE_KEY = 'nutrikod_mode';
  const MODE_IDS = ['normal', 'kids', 'notime', 'grocery'];
  const HistoryStore = window.NutriKodHistory;

  /** WKWebView / VK in-app: localStorage/sessionStorage may throw SecurityError. */
  function safeLocalStorage() {
    try {
      var s = window.localStorage;
      var k = '__nk_probe';
      s.setItem(k, '1');
      s.removeItem(k);
      return s;
    } catch (e) {
      return null;
    }
  }

  function safeSessionStorage() {
    try {
      var s = window.sessionStorage;
      var k = '__nk_probe';
      s.setItem(k, '1');
      s.removeItem(k);
      return s;
    } catch (e) {
      return null;
    }
  }

  function clearElementChildren(el) {
    if (!el) return;
    if (typeof el.replaceChildren === 'function') {
      el.replaceChildren();
      return;
    }
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function requestFormSubmit(formEl) {
    if (!formEl) return;
    if (typeof formEl.requestSubmit === 'function') {
      try {
        formEl.requestSubmit();
        return;
      } catch (e) {
        /* fall through */
      }
    }
    var ev;
    try {
      ev = new Event('submit', { bubbles: true, cancelable: true });
    } catch (e2) {
      ev = document.createEvent('Event');
      ev.initEvent('submit', true, true);
    }
    if (!formEl.dispatchEvent(ev)) return;
    if (typeof formEl.submit === 'function') {
      /* native submit would navigate; prefer clicking the send button */
    }
    if (sendBtn && typeof sendBtn.click === 'function') sendBtn.click();
  }

  function preferXhrSse() {
    if (window.NutriKodForceXhrSse === true) return true;
    try {
      var ua = navigator.userAgent || '';
      // iOS WKWebView / in-app (VK, Google) often hang or buffer fetch() SSE until complete.
      if (/iPhone|iPad|iPod/i.test(ua)) return true;
      if (/VKAndroid|VKiOS|; wv\)/i.test(ua)) return true;
    } catch (_e) { /* ignore */ }
    try {
      if (!window.ReadableStream) return true;
      if (!Response || !('body' in Response.prototype)) return true;
    } catch (_e2) {
      return true;
    }
    return false;
  }

  function fetchWithTimeout(url, options, ms) {
    var opts = options || {};
    var timeoutMs = typeof ms === 'number' ? ms : 8000;
    if (typeof AbortController === 'function') {
      var ctrl = new AbortController();
      var timer = setTimeout(function () {
        try { ctrl.abort(); } catch (e) { /* ignore */ }
      }, timeoutMs);
      var merged = {};
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k];
      }
      merged.signal = ctrl.signal;
      return fetch(url, merged).finally(function () {
        clearTimeout(timer);
      });
    }
    return Promise.race([
      fetch(url, opts),
      new Promise(function (_resolve, reject) {
        setTimeout(function () {
          reject(new Error('timeout'));
        }, timeoutMs);
      }),
    ]);
  }



  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const composerHint = document.getElementById('composer-hint');
  const sendBtn = document.getElementById('send');
  const clearChatBtn = document.getElementById('clear-chat');
  const donateBanner = document.getElementById('donate-banner');
  const donateCopy = document.getElementById('donate-copy');
  const donateCta = document.getElementById('donate-cta');
  const donateDismiss = document.getElementById('donate-dismiss');
  const communityVkLink = document.getElementById('community-vk');
  const modeChips = Array.from(document.querySelectorAll('.mode-chip'));

  function tooLongMessageText(limit = maxUserMessageChars) {
    return `Сообщение слишком длинное — сократите до ${limit} символов и отправьте снова.`;
  }

  function syncComposerLimit() {
    if (!input) return;
    input.setAttribute('maxlength', String(maxUserMessageChars));
    updateComposerHint();
  }

  function updateComposerHint() {
    if (!composerHint || !input) return;
    const len = input.value.length;
    const limit = maxUserMessageChars;
    if (len >= limit) {
      composerHint.hidden = false;
      composerHint.classList.add('warn');
      composerHint.textContent = tooLongMessageText(limit);
      return;
    }
    if (len >= Math.floor(limit * 0.9)) {
      composerHint.hidden = false;
      composerHint.classList.remove('warn');
      composerHint.textContent = `${len} из ${limit} символов`;
      return;
    }
    composerHint.hidden = true;
    composerHint.classList.remove('warn');
    composerHint.textContent = '';
  }

  /** @type {{role: string, content: string}[]} */
  let history = [];
  let streaming = false;
  let partnerShown = false;
  let donateUrl = '#donate';
  let communityVkUrl = COMMUNITY_VK_URL_DEFAULT;
  let userTurns = 0;
  let selectedMode = 'normal';

  function persistChat() {
    if (!HistoryStore) return;
    // Keep localStorage empty until the person actually writes — greeting alone is not a session.
    if (!history.some((m) => m.role === 'user')) {
      HistoryStore.clear(safeLocalStorage());
    } else {
      HistoryStore.save(safeLocalStorage(), { messages: history, partnerShown, userTurns });
    }
    syncClearButton();
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
    const hasUser = history.some((m) => m.role === 'user');
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
    addMessage('assistant', FIRST_QUESTION, { feedback: true });
    history.push({ role: 'assistant', content: `${GREETING}\n\n${FIRST_QUESTION}` });
    if (HistoryStore) HistoryStore.clear(safeLocalStorage());
    syncClearButton();
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

    for (const msg of history) {
      if (msg.role === 'user') {
        addMessage('user', msg.content);
      } else {
        const text = HistoryStore
          ? HistoryStore.displayAssistantText(GREETING, FIRST_QUESTION, msg.content)
          : msg.content;
        addMessage('assistant', text, { feedback: true });
      }
    }
    syncClearButton();
    showDonateBanner();
  }

  function normalizeMode(id) {
    const value = String(id || '').trim().toLowerCase();
    return MODE_IDS.includes(value) ? value : 'normal';
  }

  function readStoredMode() {
    try {
      var ss = safeSessionStorage();
      if (!ss) return 'normal';
      return normalizeMode(ss.getItem(MODE_STORAGE_KEY));
    } catch (_e) {
      return 'normal';
    }
  }

  function persistMode(id) {
    try {
      var ss = safeSessionStorage();
      if (!ss) return;
      ss.setItem(MODE_STORAGE_KEY, id);
    } catch (_e) {
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

  /** Near the bottom of the transcript (user is following the latest lines). */
  function isNearBottom(threshold = 72) {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
  }

  /** Keep the start of a streaming reply in view (first paragraph), not the growing tail. */
  function scrollToMessageStart(wrap) {
    if (!wrap || !messagesEl) return;
    const parentRect = messagesEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const delta = wrapRect.top - parentRect.top;
    messagesEl.scrollTop += delta - 6;
  }

  /** While streaming: pin to bottom only if the user is (or stays) at the bottom. */
  let streamPinBottom = false;

  function showClientError(text) {
    try {
      addMessage('assistant', text || 'Не удалось отправить. Попробуйте ещё раз.', {
        error: true,
        notice: true,
      });
    } catch (_e) {
      try {
        if (composerHint) {
          composerHint.hidden = false;
          composerHint.classList.add('warn');
          composerHint.textContent = text || 'Не удалось отправить.';
        }
      } catch (_e2) { /* ignore */ }
    }
  }

  function addMessage(role, text, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}${opts.notice ? ' notice' : ''}${opts.error ? ' error' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'assistant' && !opts.notice && !opts.error) {
      fillAssistantBubble(bubble, text);
    } else {
      bubble.textContent = text;
    }
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
          const store = safeLocalStorage();
          if (!store) return;
          const prev = JSON.parse(store.getItem(key) || '[]');
          prev.push({ v: btn.dataset.v, t: Date.now() });
          store.setItem(key, JSON.stringify(prev.slice(-100)));
        } catch (_e) {
          /* ignore */
        }
      });
      wrap.appendChild(fb);
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

  /** Strip hidden model mark [[partner:id]] from visible bubble text. */
  function stripPartnerMark(text) {
    return String(text || '')
      .replace(/\[\[\s*partner\s*:\s*[a-z0-9_-]+\s*\]\]/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }

  function isSafeHttpUrl(url) {
    return /^https?:\/\/[^\s<>"']+$/i.test(String(url || '').trim());
  }

  /**
   * Fill assistant bubble: keep plain text + clickable markdown links [label](https://…).
   * Also turns a bare DONATE_URL into «Поддержать НутриКод» if the model still dumps it.
   */
  function fillAssistantBubble(bubble, text) {
    const cleaned = stripPartnerMark(text);
    clearElementChildren(bubble);

    const mdRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    /** @type {{start:number,end:number,label:string,href:string}[]} */
    const hits = [];
    let m;
    while ((m = mdRe.exec(cleaned))) {
      const href = m[2].trim();
      if (!isSafeHttpUrl(href)) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, label: m[1], href });
    }

    // Defensive: bare donate URL → friendly link (only exact match of configured URL).
    const bareDonate = String(donateUrl || '').trim();
    if (bareDonate && isSafeHttpUrl(bareDonate) && !bareDonate.startsWith('#')) {
      let from = 0;
      while (from < cleaned.length) {
        const idx = cleaned.indexOf(bareDonate, from);
        if (idx === -1) break;
        const end = idx + bareDonate.length;
        const covered = hits.some((h) => idx < h.end && end > h.start);
        if (!covered) {
          hits.push({
            start: idx,
            end,
            label: 'Поддержать НутриКод',
            href: bareDonate,
          });
        }
        from = end;
      }
      hits.sort((a, b) => a.start - b.start || b.end - a.end);
    }

    if (!hits.length) {
      bubble.textContent = cleaned;
      return;
    }

    let cursor = 0;
    for (const hit of hits) {
      if (hit.start < cursor) continue;
      if (hit.start > cursor) {
        bubble.appendChild(document.createTextNode(cleaned.slice(cursor, hit.start)));
      }
      const a = document.createElement('a');
      a.className = 'bubble-link';
      a.href = hit.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = hit.label;
      bubble.appendChild(a);
      cursor = hit.end;
    }
    if (cursor < cleaned.length) {
      bubble.appendChild(document.createTextNode(cleaned.slice(cursor)));
    }
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Blurb without secondary «Также/Другие» promo lists. */
  function partnerBlurbPrimary(partner) {
    let blurb = String((partner && partner.blurb) || '').trim();
    // Avoid \\b — JS word boundaries break on Cyrillic.
    return blurb
      .replace(/\.\s*(?:Также|Другие)(?:\s.*)?$/i, '')
      .replace(/\s+(?:Также|Другие)\s*:.*$/i, '')
      .trim();
  }

  /** Product lead for the plaque (what it is) — not the promo conditions. */
  function partnerOfferLine(partner) {
    const code = partner && partner.promo_code ? String(partner.promo_code).trim() : '';
    const blurb = partnerBlurbPrimary(partner);

    let clean = blurb
      .replace(/Промокод\s+\S+(?:\s*[—\-]\s*)?.*$/i, '')
      .replace(/(?:^|[\s.])Реклама\.?(?=\s|$)/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim();
    if (clean) return clean;

    if (code) return 'Скидка по промокоду';
    if (partner && partner.offer_type === 'promo') return 'Партнёрское предложение';
    return 'Готовый вариант рядом';
  }

  /** Never show expiry dates on the plaque. */
  function stripPromoExpiryPhrase(terms) {
    return String(terms || '')
      .replace(/,?\s*до\s+\d{1,2}[./]\d{1,2}[./]\d{2,4}\s*$/i, '')
      .replace(/,?\s*до\s+\d{4}-\d{2}-\d{2}\s*$/i, '')
      .trim()
      .replace(/[,\s—–-]+$/g, '')
      .trim();
  }

  function promoExpiresOn(value) {
    const raw = String(value || '').trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function isPromoExpired(expires) {
    const end = promoExpiresOn(expires);
    if (!end) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return end < today;
  }

  /**
   * Active promos for the plaque: prefer payload.promos[], else legacy promo_code/terms,
   * else light extract from blurb. Expired rows are dropped; terms have no dates.
   */
  function partnerActivePromos(partner) {
    const rows = [];
    if (Array.isArray(partner && partner.promos)) {
      for (const raw of partner.promos) {
        if (!raw || typeof raw !== 'object') continue;
        const code = String(raw.code || '').trim();
        if (!code) continue;
        if (isPromoExpired(raw.expires)) continue;
        rows.push({
          code,
          terms: stripPromoExpiryPhrase(raw.terms || raw.promo_terms || ''),
        });
      }
    }
    if (!rows.length) {
      const code = partner && partner.promo_code ? String(partner.promo_code).trim() : '';
      if (code) {
        let terms = stripPromoExpiryPhrase(
          partner.promo_terms != null ? String(partner.promo_terms) : ''
        );
        if (!terms) {
          const blurb = partnerBlurbPrimary(partner);
          const promoPat = new RegExp(
            `Промокод\\s+${escapeRegExp(code)}\\s*(?:[—\\-]\\s*)?(.+)$`,
            'i'
          );
          const hit = blurb.match(promoPat);
          if (hit && hit[1]) {
            terms = stripPromoExpiryPhrase(hit[1].replace(/\.$/, '').trim());
            if (terms.length > 120) terms = '';
          }
        }
        rows.push({ code, terms });
      }
    }
    return rows;
  }

  /** Short condition for the primary promo (no expiry). */
  function partnerPromoTerms(partner) {
    const active = partnerActivePromos(partner);
    if (active[0] && active[0].terms) return active[0].terms;
    return stripPromoExpiryPhrase(
      partner && partner.promo_terms != null ? String(partner.promo_terms) : ''
    );
  }

  function copyPartnerPromo(code, button) {
    const value = String(code || '');
    if (!value || !button) return;

    const done = () => {
      const prev = button.textContent;
      button.textContent = 'Скопировано';
      button.classList.add('is-copied');
      button.disabled = true;
      window.setTimeout(() => {
        button.textContent = prev || 'Скопировать';
        button.classList.remove('is-copied');
        button.disabled = false;
      }, 1600);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(() => {
        // Fallback below.
        fallbackCopy(value, done);
      });
      return;
    }
    fallbackCopy(value, done);
  }

  function fallbackCopy(value, onDone) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      onDone();
    } catch (_) {
      /* ignore */
    }
  }

  /** Quiet structural offer below the assistant bubble — owns URL + promo. */
  function attachPartner(wrap, partner) {
    if (!partner || !wrap) return;
    if (!isRealPartnerLink(partner.link)) return;

    const box = document.createElement('div');
    box.className = 'partner';
    box.setAttribute('role', 'complementary');
    box.setAttribute('aria-label', 'Партнёрское предложение');

    const brand = document.createElement('div');
    brand.className = 'partner-brand';
    brand.textContent = String(partner.name || 'Партнёр');

    const offer = document.createElement('p');
    offer.className = 'partner-offer';
    offer.textContent = partnerOfferLine(partner);

    box.appendChild(brand);
    box.appendChild(offer);

    const cta = document.createElement('a');
    cta.className = 'partner-cta';
    cta.href = partner.link;
    cta.target = '_blank';
    cta.rel = 'noopener noreferrer';
    cta.textContent = 'Открыть';
    box.appendChild(cta);

    const promos = partnerActivePromos(partner);
    const primary = promos[0] || null;
    if (primary) {
      const row = document.createElement('div');
      row.className = 'partner-promo-row';

      const code = document.createElement('code');
      code.className = 'partner-code';
      code.textContent = primary.code;

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'partner-copy';
      copyBtn.textContent = 'Скопировать';
      copyBtn.setAttribute('aria-label', `Скопировать промокод ${primary.code}`);
      copyBtn.addEventListener('click', () => copyPartnerPromo(primary.code, copyBtn));

      row.appendChild(code);
      row.appendChild(copyBtn);
      box.appendChild(row);

      const termsText = primary.terms || partnerPromoTerms(partner);
      if (termsText) {
        const terms = document.createElement('p');
        terms.className = 'partner-terms';
        terms.textContent = termsText;
        box.appendChild(terms);
      }
    }

    const extras = promos.slice(1);
    if (extras.length) {
      const details = document.createElement('details');
      details.className = 'partner-more';

      const summary = document.createElement('summary');
      summary.className = 'partner-more-toggle';
      summary.textContent = 'Подробнее';
      details.appendChild(summary);

      const list = document.createElement('ul');
      list.className = 'partner-more-list';
      for (const item of extras) {
        const li = document.createElement('li');
        li.className = 'partner-more-item';

        const code = document.createElement('code');
        code.className = 'partner-code partner-code-sm';
        code.textContent = item.code;
        li.appendChild(code);

        if (item.terms) {
          const t = document.createElement('span');
          t.className = 'partner-more-terms';
          t.textContent = item.terms;
          li.appendChild(t);
        }

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'partner-copy partner-copy-sm';
        copyBtn.textContent = 'Скопировать';
        copyBtn.setAttribute('aria-label', `Скопировать промокод ${item.code}`);
        copyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          copyPartnerPromo(item.code, copyBtn);
        });
        li.appendChild(copyBtn);
        list.appendChild(li);
      }
      details.appendChild(list);
      box.appendChild(details);
    }

    if (partner.disclaimer) {
      const tip = document.createElement('p');
      tip.className = 'partner-legal';
      tip.textContent = partner.disclaimer;
      box.appendChild(tip);
    }

    wrap.appendChild(box);
    if (streamPinBottom) scrollBottom();
  }

  /** CloudTips pay pages accept optional ?amount= to prefill the tip. */
  function donateHrefForAmount(amount) {
    const base = donateUrl || '#donate';
    if (base === '#donate' || base.startsWith('#')) {
      return amount ? `#donate-${amount}` : '#donate';
    }
    if (!amount) return base;
    return base.includes('?') ? `${base}&amount=${amount}` : `${base}?amount=${amount}`;
  }

  function applyDonateLink(anchor, amount) {
    if (!anchor) return;
    const base = donateUrl || '#donate';
    const isPlaceholder = base === '#donate' || base.startsWith('#');
    anchor.href = donateHrefForAmount(amount);
    if (isPlaceholder) {
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
    } else {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function showDonateBanner() {
    try {
      var ssHide = safeSessionStorage();
      if (ssHide && ssHide.getItem('nutrikod_donate_hide') === '1') return;
    } catch (_e) {
      /* ignore */
    }
    if (userTurns < DONATE_AFTER_TURNS) return;
    if (!donateBanner.hidden) return;
    if (donateCopy) donateCopy.textContent = DONATE_SOFT_COPY;
    donateBanner.hidden = false;
    applyDonateLink(donateCta, null);
    donateBanner.querySelectorAll('.donate-btn').forEach((a) => {
      applyDonateLink(a, a.getAttribute('data-amount'));
    });
  }

  if (donateDismiss) {
    donateDismiss.addEventListener('click', () => {
      donateBanner.hidden = true;
      try {
        var ss = safeSessionStorage();
        if (ss) ss.setItem('nutrikod_donate_hide', '1');
      } catch (_e) {
        /* ignore */
      }
    });
  }

  async function loadConfig() {
    try {
      const res = await fetchWithTimeout('/api/config', { method: 'GET', credentials: 'same-origin' }, 5000);
      if (!res || !res.ok) {
        syncComposerLimit();
        return;
      }
      const data = await res.json();
      donateUrl = data.donateUrl || '#donate';
      if (data.communityVkUrl) {
        communityVkUrl = String(data.communityVkUrl).trim() || COMMUNITY_VK_URL_DEFAULT;
      }
      if (communityVkLink && communityVkUrl) {
        communityVkLink.href = communityVkUrl;
      }
      const cfgLimit = Number(data.maxUserMessageChars);
      if (Number.isFinite(cfgLimit) && cfgLimit >= 200) {
        maxUserMessageChars = Math.floor(cfgLimit);
      }
      syncComposerLimit();
      if (!data.hasKey) {
        /* mock mode is fine; notice comes with first stream */
      }
    } catch (_e) {
      syncComposerLimit();
      /* never block UI if config/SSE path is slow in WKWebView */
    }
  }

  async function streamReply() {
    streaming = true;
    sendBtn.disabled = true;
    syncClearButton();

    let full = '';
    let gotToken = false;
    let sawDone = false;
    let streamIncomplete = false;
    /** @type {'thinking' | 'typing' | 'reply'} */
    let stage = 'thinking';
    let typingFallbackTimer = 0;
    // Soft CPA: one offer per reply. Allow a new pick on later turns if the person asks for something else.
    const allowPartner = userTurns >= 2;

    // Stage 1: calm “thinking” so the wait never looks like a blank chat or fake typing.
    const { wrap, bubble } = addMessage('assistant', pickStatus(THINKING_STATUS), { feedback: true });
    bubble.classList.add('typing');
    bubble.dataset.stage = 'thinking';

    // Pin to bottom only if the user was already following the latest lines.
    streamPinBottom = isNearBottom();
    const onStreamScroll = () => {
      streamPinBottom = isNearBottom();
    };
    messagesEl.addEventListener('scroll', onStreamScroll, { passive: true });

    const setStatus = (next, phrase) => {
      if (gotToken || stage === 'reply') return;
      // Never go backwards from typing → thinking.
      if (next === 'thinking' && stage === 'typing') return;
      // Same stage: refresh progressive / heartbeat copy without flicker of stage.
      if (stage === next) {
        if (phrase && bubble.textContent !== phrase) {
          bubble.textContent = phrase;
          if (streamPinBottom) scrollBottom();
        }
        return;
      }
      stage = next;
      bubble.dataset.stage = next;
      bubble.textContent = phrase;
      bubble.classList.add('typing');
      if (streamPinBottom) scrollBottom();
    };

    const waitTimers = [];
    const clearWaitTimers = () => {
      for (const id of waitTimers) clearTimeout(id);
      waitTimers.length = 0;
      if (typingFallbackTimer) {
        clearTimeout(typingFallbackTimer);
        typingFallbackTimer = 0;
      }
    };

    const beginReply = () => {
      if (gotToken) return;
      gotToken = true;
      stage = 'reply';
      bubble.dataset.stage = 'reply';
      clearWaitTimers();
      bubble.classList.remove('typing');
      // Only clear the placeholder once — never wipe accumulated tokens later.
      bubble.textContent = '';
      // Stay on the first paragraph while tokens arrive; do not chase the growing tail.
      // Pin-to-bottom resumes only if the user themselves scrolls to the bottom.
      scrollToMessageStart(wrap);
      streamPinBottom = false;
    };

    const paint = () => {
      fillAssistantBubble(bubble, full);
      if (streamPinBottom) scrollBottom();
    };

    // Progressive local copy while Gemini TTFB is slow — do NOT fake «печатает» early.
    for (const hint of [
      { at: 3500, text: 'Ещё думаю…' },
      { at: 8000, text: 'Модель отвечает дольше обычного…' },
      { at: 16000, text: 'Почти готово, ещё чуть-чуть…' },
    ]) {
      waitTimers.push(
        window.setTimeout(() => {
          if (!gotToken) setStatus('thinking', hint.text);
        }, hint.at)
      );
    }
    // Only as a last resort if the server never signals typing/tokens.
    typingFallbackTimer = window.setTimeout(() => {
      setStatus('typing', pickStatus(TYPING_STATUS));
    }, 22000);

    const handlePayload = (payload) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'status') {
        if (payload.stage === 'thinking') {
          setStatus('thinking', payload.text || pickStatus(THINKING_STATUS));
        } else if (payload.stage === 'typing') {
          clearWaitTimers();
          setStatus('typing', payload.text || pickStatus(TYPING_STATUS));
        }
      } else if (payload.type === 'notice') {
        const { wrap: noticeWrap } = addMessage('assistant', payload.text, { notice: true });
        // Keep the live status/reply bubble last so stages stay in view.
        if (wrap && wrap.parentNode && noticeWrap) {
          wrap.parentNode.insertBefore(noticeWrap, wrap);
        }
      } else if (payload.type === 'token') {
        // Ignore empty token frames so we never clear the status into a blank bubble.
        if (!payload.text) return;
        clearWaitTimers();
        beginReply();
        full += payload.text;
        paint();
      } else if (payload.type === 'partner' && payload.partner) {
        // Do not treat partner as the start of reply text — avoids wiping status into empty.
        partnerShown = true;
        attachPartner(wrap, payload.partner);
      } else if (payload.type === 'error') {
        clearWaitTimers();
        bubble.classList.remove('typing');
        if (!full) {
          bubble.textContent = payload.text || 'Ответ пока не пришёл. Можно повторить через минуту.';
          wrap.classList.add('error');
          stage = 'reply';
          bubble.dataset.stage = 'reply';
        } else {
          // Partial answer already on screen — mark as incomplete, never look like a clean end.
          streamIncomplete = true;
          wrap.classList.add('error');
        }
      } else if (payload.type === 'done') {
        sawDone = true;
        if (payload.incomplete || payload.truncated) {
          streamIncomplete = true;
          wrap.classList.add('error');
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
      } catch (_e) {
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

    const decoder = new TextDecoder();
    const state = { buffer: '' };

    const runXhrSse = function () {
      return new Promise(function (resolve, reject) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/chat');
          xhr.timeout = 90000;
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.setRequestHeader('Accept', 'text/event-stream');
          var seen = 0;
          var settled = false;
          var onChunk = function () {
            var t = xhr.responseText || '';
            if (t.length <= seen) return;
            state.buffer += t.slice(seen);
            seen = t.length;
            drainBuffer(state, false);
          };
          xhr.onprogress = onChunk;
          xhr.onreadystatechange = function () {
            if (xhr.readyState >= 3) onChunk();
          };
          xhr.onload = function () {
            if (settled) return;
            settled = true;
            onChunk();
            drainBuffer(state, true);
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error('xhr ' + xhr.status));
          };
          xhr.ontimeout = function () {
            if (settled) return;
            settled = true;
            reject(new Error('xhr timeout'));
          };
          xhr.onerror = function () {
            if (settled) return;
            settled = true;
            reject(new Error('xhr network'));
          };
          xhr.send(JSON.stringify({ messages: history, allowPartner: allowPartner, mode: selectedMode }));
        } catch (err) {
          reject(err);
        }
      });
    };

    try {
      if (preferXhrSse()) {
        await runXhrSse();
      } else {
        const res = await fetchWithTimeout(
          '/api/chat',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify({ messages: history, allowPartner, mode: selectedMode }),
          },
          90000
        );

        if (!res.ok) {
          clearWaitTimers();
          bubble.classList.remove('typing');
          let errText = 'Ответ пока не пришёл. Можно повторить через минуту.';
          if (res.status === 413 || res.status === 400) {
            try {
              const errBody = await res.json();
              if (errBody && typeof errBody.text === 'string' && errBody.text.trim()) {
                errText = errBody.text.trim();
              } else {
                errText = tooLongMessageText();
              }
            } catch (_e) {
              errText = tooLongMessageText();
            }
          }
          bubble.textContent = errText;
          wrap.classList.add('error');
          return;
        }

        const body = res.body;
        const canStream = body && typeof body.getReader === 'function';
        if (!canStream) {
          await runXhrSse();
        } else {
          try {
            const reader = body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              state.buffer += decoder.decode(value, { stream: true });
              drainBuffer(state, false);
            }
            state.buffer += decoder.decode();
            drainBuffer(state, true);
          } catch (_streamErr) {
            await runXhrSse();
          }
        }
      }

      if (full) {
        const cleaned = stripPartnerMark(full);
        history.push({ role: 'assistant', content: cleaned });
        full = cleaned;
        persistChat();
        paint();
      } else if (!wrap.classList.contains('error')) {
        // Never leave a blank or stuck status bubble after the stream ends.
        bubble.classList.remove('typing');
        if (!bubble.textContent || isStatusPhrase(bubble.textContent)) {
          bubble.textContent = 'Пусто пока. Напишите ещё раз — иногда помогает.';
        }
      }

      // Stream ended without done / marked incomplete — never look like a normal finish.
      if (full && (!sawDone || streamIncomplete)) {
        wrap.classList.add('error');
        const note =
          'Ответ оборвался на середине — это не полный текст. Напишите «продолжи» или повторите вопрос.';
        const already = [...messagesEl.querySelectorAll('.msg.notice .bubble')].some(
          (el) => el.textContent === note
        );
        if (!already) {
          const { wrap: noticeWrap } = addMessage('assistant', note, { notice: true });
          if (wrap && wrap.parentNode && noticeWrap) {
            wrap.parentNode.appendChild(noticeWrap);
          }
        }
      }
    } catch (_e) {
      bubble.classList.remove('typing');
      if (!full) {
        bubble.textContent = 'Связь прервалась. Проверьте сеть и напишите снова.';
        wrap.classList.add('error');
      } else {
        // Keep partial answer visible if the connection dropped mid-stream.
        paint();
        wrap.classList.add('error');
        addMessage(
          'assistant',
          'Ответ оборвался на середине — это не полный текст. Напишите «продолжи» или повторите вопрос.',
          { notice: true }
        );
      }
    } finally {
      messagesEl.removeEventListener('scroll', onStreamScroll);
      streamPinBottom = false;
      clearWaitTimers();
      bubble.classList.remove('typing');
      streaming = false;
      sendBtn.disabled = false;
      syncClearButton();
      input.focus();
      showDonateBanner();
    }
  }

  async function handleSend(triggerEvent) {
    if (triggerEvent && typeof triggerEvent.preventDefault === 'function') {
      try {
        triggerEvent.preventDefault();
        triggerEvent.stopPropagation();
      } catch (_e) { /* ignore */ }
    }
    if (streaming) return;
    if (!input) {
      showClientError('Поле ввода недоступно в этом браузере.');
      return;
    }

    const text = String(input.value || '').trim();
    if (!text) return;
    if (text.length > maxUserMessageChars) {
      updateComposerHint();
      if (composerHint) {
        composerHint.hidden = false;
        composerHint.classList.add('warn');
        composerHint.textContent = tooLongMessageText();
      }
      return;
    }

    // Append user bubble BEFORE clearing the field (iOS Google/VK: clear-without-bubble looked like “send ate text”).
    let painted = false;
    try {
      addMessage('user', text);
      painted = true;
      history.push({ role: 'user', content: text });
      userTurns += 1;
      persistChat();
    } catch (_e) {
      showClientError('Сообщение не попало в чат. Обновите страницу и попробуйте снова.');
      return;
    }

    try {
      input.value = '';
      autoGrow();
      updateComposerHint();
    } catch (_e) { /* ignore */ }

    if (!painted) return;

    try {
      await streamReply();
    } catch (_e) {
      streaming = false;
      if (sendBtn) sendBtn.disabled = false;
      showClientError('Сбой отправки. Проверьте сеть и нажмите отправить ещё раз.');
    }
  }

  if (form) {
    form.addEventListener(
      'submit',
      function (e) {
        handleSend(e);
        return false;
      },
      false
    );
  }
  if (sendBtn) {
    sendBtn.addEventListener(
      'click',
      function (e) {
        handleSend(e);
      },
      false
    );
  }

  if (clearChatBtn) clearChatBtn.addEventListener('click', () => {
    if (streaming) return;
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    if (HistoryStore) HistoryStore.clear(safeLocalStorage());
    setClearArmed(false);
    resetToFreshChat();
  });

  // Tap elsewhere cancels the armed clear — avoids accidental wipe.
  document.addEventListener('click', (e) => {
    if (!clearArmed || !clearChatBtn) return;
    if (e.target === clearChatBtn || clearChatBtn.contains(e.target)) return;
    setClearArmed(false);
  });

  if (input) {
    input.addEventListener('input', () => {
      autoGrow();
      updateComposerHint();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend(e);
      }
    });
  }
  syncComposerLimit();
  syncComposerLimit();

  async function boot() {
    // Paint chat FIRST — never await network before the first bubble (WKWebView hang → white screen / stuck bar).
    try {
      setMode(readStoredMode(), { persist: false });
    } catch (_e) {
      selectedMode = 'normal';
    }

    try {
      const saved = HistoryStore ? HistoryStore.load(safeLocalStorage()) : null;
      if (saved && saved.messages && saved.messages.some((m) => m.role === 'user')) {
        renderRestoredHistory(saved);
      } else {
        // Hero already shows the greeting line; first AI turn asks the intake question.
        addMessage('assistant', FIRST_QUESTION, { feedback: true });
        history.push({ role: 'assistant', content: `${GREETING}\n\n${FIRST_QUESTION}` });
        // Fresh greeting alone is not persisted — only after the person writes.
        syncClearButton();
      }
      // Recover text if an older build did a native GET ?message= submit.
      try {
        var params = new URLSearchParams(window.location.search || '');
        var orphan = String(params.get('message') || '').trim();
        if (orphan && input && !String(input.value || '').trim()) {
          input.value = orphan.slice(0, maxUserMessageChars);
          autoGrow();
          updateComposerHint();
          if (window.history && typeof window.history.replaceState === 'function') {
            window.history.replaceState(null, '', window.location.pathname || '/');
          }
        }
      } catch (_orphan) { /* ignore */ }
    } catch (_e) {
      try {
        if (messagesEl && !messagesEl.childElementCount) {
          addMessage('assistant', FIRST_QUESTION, { feedback: true });
          history = [{ role: 'assistant', content: `${GREETING}\n\n${FIRST_QUESTION}` }];
          syncClearButton();
        }
      } catch (_e2) {
        /* last resort: leave shell visible */
      }
    }

    try {
      if (input) input.focus();
    } catch (_e) {
      /* VK WebView may block focus */
    }

    // Config in background with timeout — must not leave a hanging fetch.
    try {
      await loadConfig();
    } catch (_e) {
      try { syncComposerLimit(); } catch (_e2) { /* ignore */ }
    }
  }

  try {
    boot();
  } catch (_e) {
    try {
      if (messagesEl && !messagesEl.childElementCount) {
        addMessage('assistant', FIRST_QUESTION, { feedback: true });
      }
    } catch (_e2) { /* ignore */ }
  }
})();
