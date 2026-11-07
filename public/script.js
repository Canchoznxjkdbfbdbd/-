(() => {
  const GREETING =
    'Залог хорошего самочувствия — это сбалансированное питание. Иногда его нужно подбирать индивидуально. Приступим...';

  const FIRST_QUESTION =
    'Расскажите коротко: как вы питаетесь сейчас, есть ли аллергии или ограничения, и какую цель хотите — энергия, лёгкость, набор, поддержка после нагрузок или что-то ещё?';

  /** Show quiet donate strip only after this many user messages. */
  const DONATE_AFTER_TURNS = 3;

  const DONATE_VARIANTS = [
    { id: 'a', copy: 'Если помогло — можно поддержать автора.' },
    { id: 'b', copy: 'Сервис бесплатный. Донат — по желанию.' },
  ];

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

    let wrap = null;
    let bubble = null;
    let full = '';
    const allowPartner = !partnerShown && userTurns >= 2;

    const ensureBubble = () => {
      if (!wrap) {
        ({ wrap, bubble } = addMessage('assistant', '', { feedback: true }));
      }
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, allowPartner }),
      });

      if (!res.ok || !res.body) {
        ensureBubble();
        bubble.textContent = 'Ответ пока не пришёл. Можно повторить через минуту.';
        wrap.classList.add('error');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const line = chunk
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith('data:'));
          if (!line) continue;
          let payload;
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          if (payload.type === 'notice') {
            addMessage('assistant', payload.text, { notice: true });
          } else if (payload.type === 'token') {
            ensureBubble();
            full += payload.text || '';
            bubble.textContent = full;
            scrollBottom();
          } else if (payload.type === 'partner' && payload.partner) {
            ensureBubble();
            partnerShown = true;
            attachPartner(wrap, payload.partner);
          } else if (payload.type === 'error') {
            ensureBubble();
            if (!full) {
              bubble.textContent = payload.text || 'Ответ пока не пришёл. Можно повторить через минуту.';
              wrap.classList.add('error');
            }
          }
        }
      }

      if (full) {
        history.push({ role: 'assistant', content: full });
      } else if (bubble && !bubble.textContent) {
        bubble.textContent = 'Пусто пока. Напишите ещё раз — иногда помогает.';
      } else if (!bubble) {
        ensureBubble();
        bubble.textContent = 'Пусто пока. Напишите ещё раз — иногда помогает.';
      }
    } catch {
      ensureBubble();
      bubble.textContent = 'Связь прервалась. Проверьте сеть и напишите снова.';
      wrap.classList.add('error');
    } finally {
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
