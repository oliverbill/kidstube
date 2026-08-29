// KidTube service worker — cache-first para o app shell, network-only para API.
'use strict';

const CACHE_VERSION = 'kidtube-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/app.css',
  '/admin.html',
  '/admin.js',
  '/admin.css',
  '/manifest.webmanifest',
  '/icons/icon-180.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll falharia tudo se um shell asset faltar; cachear um a um tolera ausências.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-only: API e thumbnails mock — nunca servir do cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mock-thumb/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Cache-first para os estáticos do app shell.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return resp;
      });
    })
  );
});
