/**
 * Browser-only chat history (localStorage). No accounts, no server PII.
 * Works in the browser as NutriKodHistory and in Node via require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.NutriKodHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'nutrikod_chat';
  const VERSION = 1;
  const MAX_MESSAGES = 80;

  /**
   * @param {unknown} raw
   * @returns {{role: string, content: string}[]}
   */
  function sanitizeMessages(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const role = item.role === 'user' || item.role === 'assistant' ? item.role : null;
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!role || !content) continue;
      // Cap each message so a huge paste cannot blow localStorage.
      out.push({ role, content: content.slice(0, 8000) });
      if (out.length >= MAX_MESSAGES) break;
    }
    return out;
  }

  /**
   * @param {{messages?: unknown, partnerShown?: unknown, userTurns?: unknown}} state
   * @returns {string}
   */
  function serialize(state) {
    const messages = sanitizeMessages(state && state.messages);
    const payload = {
      v: VERSION,
      messages,
      partnerShown: Boolean(state && state.partnerShown),
      userTurns: Math.max(0, Math.min(Number(state && state.userTurns) || 0, 9999)),
      savedAt: Date.now(),
    };
    return JSON.stringify(payload);
  }

  /**
   * @param {string|null|undefined} raw
   * @returns {{messages: {role: string, content: string}[], partnerShown: boolean, userTurns: number}|null}
   */
  function parse(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    if (data.v !== VERSION) return null;
    const messages = sanitizeMessages(data.messages);
    if (!messages.length) return null;
    return {
      messages,
      partnerShown: Boolean(data.partnerShown),
      userTurns: Math.max(0, Math.min(Number(data.userTurns) || 0, 9999)),
    };
  }

  /**
   * @param {Storage} storage
   * @param {{messages: unknown, partnerShown?: boolean, userTurns?: number}} state
   * @returns {boolean}
   */
  function save(storage, state) {
    if (!storage) return false;
    try {
      const messages = sanitizeMessages(state && state.messages);
      if (!messages.length) {
        storage.removeItem(STORAGE_KEY);
        return true;
      }
      storage.setItem(STORAGE_KEY, serialize(state));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {Storage} storage
   * @returns {{messages: {role: string, content: string}[], partnerShown: boolean, userTurns: number}|null}
   */
  function load(storage) {
    if (!storage) return null;
    try {
      return parse(storage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }

  /**
   * @param {Storage} storage
   */
  function clear(storage) {
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /**
   * UI text for a stored assistant turn (hero already shows the greeting).
   * @param {string} greeting
   * @param {string} firstQuestion
   * @param {string} content
   */
  function displayAssistantText(greeting, firstQuestion, content) {
    const text = String(content || '');
    const bundled = `${greeting}\n\n${firstQuestion}`;
    if (text === bundled || text === firstQuestion) return firstQuestion;
    if (text.startsWith(`${greeting}\n\n`)) {
      const rest = text.slice(greeting.length + 2).trim();
      return rest || firstQuestion;
    }
    return text;
  }

  return {
    STORAGE_KEY,
    VERSION,
    MAX_MESSAGES,
    sanitizeMessages,
    serialize,
    parse,
    save,
    load,
    clear,
    displayAssistantText,
  };
});
