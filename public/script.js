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
   * Base must be Admitad webmaster (kdbov… / dorinebeaumont…), never raw merchant landing.
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
      if (fishPrefixes.includes(prefix)) {
        return { kind: 'product', label, store: 'vipfish' };
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

  /**
   * Turn [[product]] / [[vipfish:name]] into chips; leave [[partner:id]] alone.
   * Incomplete trailing [[… is left as plain text while streaming.
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
      } else if (hit.href) {
        const a = document.createElement('a');
        a.className = 'product-chip';
        a.href = hit.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer sponsored';
        a.textContent = hit.label;
        a.title =
          hit.store === 'vipfish'
            ? `${vipfishDeeplink.name || 'Важная рыба'} — поиск`
            : 'ВкусВилл — поиск';
        if (hit.store === 'vipfish') a.dataset.partner = 'vazhnaya-ryba';
        else if (hit.store === 'vkusvill') a.dataset.partner = 'vkusvill';
        root.appendChild(a);
        if (hit.store === 'vipfish') fishCount += 1;
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

    return {
      fragment: root,
      linkCount: vvCount + fishCount,
      disclosures,
      erid:
        fishCount >= 1
          ? vipfishDeeplink.erid || ''
          : vvCount >= 1
            ? vkusvillDeeplink.erid || ''
            : '',
    };
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

  /** Paint assistant bubble: product chips from [[name]] / [[vipfish:name]]; plain text otherwise. */
  function fillAssistantBubble(bubble, text, wrap) {
    const { fragment, disclosures } = renderProductDeeplinks(text);
    bubble.replaceChildren(fragment);
    if (wrap) syncAdDisclosure(wrap, disclosures);
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

  /** Quiet offer below the assistant bubble — not inside medical advice text. */
  function attachPartner(wrap, partner) {
    if (!partner || !wrap) return;
    if (!isRealPartnerLink(partner.link)) return;

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

    wrap.appendChild(box);
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
