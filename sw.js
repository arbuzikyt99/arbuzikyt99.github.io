/* ArbMusic service worker — оффлайн-запас приложения.
   Стратегия: сначала сеть (всегда свежая версия), кэш — только когда сети нет. */
'use strict';
const CACHE = 'arbmusic-v2';
const SHELL = [
  './index.html',
  './css/style.css',
  './js/app.js',
  './icon-192.png',
  './icon-512.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;           // сторонние — мимо
  if (req.headers.has('range')) return;                 // media range — мимо

  // навигация: сначала сеть
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const cp = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', cp));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // прочие ресурсы: сначала сеть, при ошибке — кэш
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put(req, cp));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
