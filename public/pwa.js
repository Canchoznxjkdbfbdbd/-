(() => {
  'use strict';

  const DISMISS_KEY = 'nutrikod_pwa_hint_dismissed';
  const DISMISS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIosSafari() {
    const ua = window.navigator.userAgent || '';
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const webkit = /WebKit/i.test(ua);
    // iOS Safari (not Chrome/Firefox/Edge wrappers)
    return iOS && webkit && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  }

  function wasDismissed() {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (!raw) return false;
      const ts = Number(raw);
      if (!Number.isFinite(ts)) return true;
      return Date.now() - ts < DISMISS_MS;
    } catch {
      return false;
    }
  }

  function markDismissed() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  }

  function ensureHintEl() {
    let el = document.getElementById('pwa-install-hint');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'pwa-install-hint';
    el.className = 'pwa-hint';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<p class="pwa-hint-copy"></p>' +
      '<button type="button" class="pwa-hint-action" hidden></button>' +
      '<button type="button" class="pwa-hint-dismiss" aria-label="Скрыть">×</button>';
    document.body.appendChild(el);
    el.querySelector('.pwa-hint-dismiss').addEventListener('click', () => {
      markDismissed();
      el.hidden = true;
    });
    return el;
  }

  function showHint({ copy, actionLabel, onAction }) {
    if (isStandalone() || wasDismissed()) return;
    const el = ensureHintEl();
    const copyEl = el.querySelector('.pwa-hint-copy');
    const actionEl = el.querySelector('.pwa-hint-action');
    copyEl.textContent = copy;
    if (actionLabel && onAction) {
      actionEl.hidden = false;
      actionEl.textContent = actionLabel;
      actionEl.onclick = () => {
        onAction();
      };
    } else {
      actionEl.hidden = true;
      actionEl.onclick = null;
    }
    el.hidden = false;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* SW optional — chat still works without it */
      });
    });
  }

  function setupInstallHint() {
    if (isStandalone()) return;

    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      showHint({
        copy: 'Можно добавить НутриКод на экран Домой — как приложение, с той же историей чата.',
        actionLabel: 'На экран Домой',
        onAction: async () => {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          try {
            await deferredPrompt.userChoice;
          } catch {
            /* ignore */
          }
          deferredPrompt = null;
          markDismissed();
          const el = document.getElementById('pwa-install-hint');
          if (el) el.hidden = true;
        },
      });
    });

    // iOS Safari has no beforeinstallprompt — quiet Share → Home Screen tip.
    if (isIosSafari() && !wasDismissed()) {
      // Delay so it doesn’t compete with first paint / greeting.
      setTimeout(() => {
        if (deferredPrompt) return;
        showHint({
          copy: 'На iPhone: «Поделиться» → «На экран «Домой»». История чата останется в этом браузере.',
        });
      }, 4000);
    }
  }

  registerServiceWorker();
  setupInstallHint();
})();
