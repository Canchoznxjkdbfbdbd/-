/* NutriKod — minimal shell cache. Chat API stays network-only / network-first. */
'use strict';

const CACHE_NAME = 'nutrikod-shell-v1';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/history-store.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isShellGet(request, url) {
  if (request.method !== 'GET') return false;
  if (isApiRequest(url)) return false;
  // Only cache same-origin navigations and static shell assets — not arbitrary GETs.
  if (request.mode === 'navigate') return true;
  const path = url.pathname;
  return (
    path === '/' ||
    path === '/index.html' ||
    path === '/style.css' ||
    path === '/script.js' ||
    path === '/history-store.js' ||
    path === '/pwa.js' ||
    path === '/manifest.webmanifest' ||
    path === '/privacy.html' ||
    path.startsWith('/icons/')
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // Streaming chat and all API: always hit the network. Never put responses in Cache Storage.
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      )
    );
    return;
  }

  if (!isShellGet(request, url)) return;

  // Network-first for shell so updates land quickly; cache only as fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && request.method === 'GET') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const home = await caches.match('/') || (await caches.match('/index.html'));
          if (home) return home;
        }
        return new Response('Нет сети', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })
  );
});
