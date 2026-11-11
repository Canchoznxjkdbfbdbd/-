(() => {
  const GREETING =
    'Залог хорошего самочувствия — это сбалансированное питание. Иногда его нужно подбирать индивидуально. Приступим...';

  const FIRST_QUESTION =
    'Расскажите коротко: как вы питаетесь сейчас, есть ли аллергии или ограничения, и какую цель хотите — энергия, лёгкость, набор, поддержка после нагрузок или что-то ещё?';

  /** Show quiet donate strip only after this many user messages. */
  const DONATE_AFTER_TURNS = 3;

  /** Calm Russian wait stages — rotate short variants so it doesn’t feel canned. */
  const THINKING_STATUS = ['Думает…', 'Что-то прикидывает…', 'Собирает мысли…'];
  const TYPING_STATUS = ['Печатает…', 'Набирает ответ…', 'Подбирает слова…'];

  const DONATE_SOFT_COPY = 'Хотите поддержать проект или дать обратную связь?';
  /** Fallback if /api/config has no communityVkUrl — keep in sync with server COMMUNITY_VK_URL. */
  const COMMUNITY_VK_URL_DEFAULT = 'https://vk.ru/ai.nutricode';

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
  const donateCta = document.getElementById('donate-cta');
  const donateDismiss = document.getElementById('donate-dismiss');
  const communityVkLink = document.getElementById('community-vk');
  const modeChips = Array.from(document.querySelectorAll('.mode-chip'));

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
      HistoryStore.clear(window.localStorage);
    } else {
      HistoryStore.save(window.localStorage, { messages: history, partnerShown, userTurns });
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
    if (HistoryStore) HistoryStore.clear(window.localStorage);
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
          const prev = JSON.parse(localStorage.getItem(key) || '[]');
          prev.push({ v: btn.dataset.v, t: Date.now() });
          localStorage.setItem(key, JSON.stringify(prev.slice(-100)));
        } catch {
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
    bubble.replaceChildren();

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
    if (sessionStorage.getItem('nutrikod_donate_hide') === '1') return;
    if (userTurns < DONATE_AFTER_TURNS) return;
    if (!donateBanner.hidden) return;
    if (donateCopy) donateCopy.textContent = DONATE_SOFT_COPY;
    donateBanner.hidden = false;
    applyDonateLink(donateCta, null);
    donateBanner.querySelectorAll('.donate-btn').forEach((a) => {
      applyDonateLink(a, a.getAttribute('data-amount'));
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
    syncClearButton();

    let full = '';
    let gotToken = false;
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
      // Only advance (or keep) — never flicker a new random phrase for the same stage.
      if (next === 'thinking' && stage !== 'thinking') return;
      if (stage === next) return;
      stage = next;
      bubble.dataset.stage = next;
      bubble.textContent = phrase;
      bubble.classList.add('typing');
      if (streamPinBottom) scrollBottom();
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
      // Stay on the first paragraph while tokens arrive; do not chase the growing tail.
      // Pin-to-bottom resumes only if the user themselves scrolls to the bottom.
      scrollToMessageStart(wrap);
      streamPinBottom = false;
    };

    const paint = () => {
      fillAssistantBubble(bubble, full);
      if (streamPinBottom) scrollBottom();
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
      messagesEl.removeEventListener('scroll', onStreamScroll);
      streamPinBottom = false;
      if (typingFallbackTimer) {
        clearTimeout(typingFallbackTimer);
        typingFallbackTimer = 0;
      }
      bubble.classList.remove('typing');
      streaming = false;
      sendBtn.disabled = false;
      syncClearButton();
      input.focus();
      showDonateBanner();
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (streaming) return;
    const text = input.value.trim();
    if (!text) return;

    addMessage('user', text);
    history.push({ role: 'user', content: text });
    userTurns += 1;
    persistChat();
    input.value = '';
    autoGrow();
    await streamReply();
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
      // Hero already shows the greeting line; first AI turn asks the intake question.
      addMessage('assistant', FIRST_QUESTION, { feedback: true });
      history.push({ role: 'assistant', content: `${GREETING}\n\n${FIRST_QUESTION}` });
      // Fresh greeting alone is not persisted — only after the person writes.
      syncClearButton();
    }
    input.focus();
  }

  boot();
})();
