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

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const donateBanner = document.getElementById('donate-banner');
  const donateCopy = document.getElementById('donate-copy');
  const donateDismiss = document.getElementById('donate-dismiss');

  /** @type {{role: string, content: string}[]} */
  let history = [];
  let streaming = false;
  let partnerShown = false;
  let donateUrl = '#donate';
  let userTurns = 0;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, text, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}${opts.notice ? ' notice' : ''}${opts.error ? ' error' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
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

  function attachPartner(wrap, partner) {
    if (!partner || !wrap) return;
    const box = document.createElement('div');
    box.className = 'partner';
    box.innerHTML =
      `<strong>Вариант готового рациона</strong><br>` +
      `${esc(partner.name)} — ${esc(partner.blurb)} ` +
      `<a href="${esc(partner.link)}" target="_blank" rel="noopener noreferrer">открыть</a>` +
      `<p class="tiny">${esc(partner.disclaimer || '')}</p>`;
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
      bubble.textContent = full;
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
        body: JSON.stringify({ messages: history, allowPartner }),
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
    input.value = '';
    autoGrow();
    await streamReply();
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
    // Hero already shows the greeting line; first AI turn asks the intake question.
    addMessage('assistant', FIRST_QUESTION, { feedback: true });
    history.push({ role: 'assistant', content: `${GREETING}\n\n${FIRST_QUESTION}` });
    input.focus();
  }

  boot();
})();
