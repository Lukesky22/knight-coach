// Cache-first service worker for the app shell so Knight Coach opens
// instantly (and offline) from the home screen. Chess.com API calls are
// never cached here - game data lives in IndexedDB.

const VERSION = 'kc-v6';

const PRECACHE = [
  '.',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/chesscom.js',
  'js/board.js',
  'js/analysis.js',
  'js/trainer.js',
  'js/openings.js',
  'js/explain.js',
  'vendor/openings.json',
  'vendor/chess.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-512.png',
  ...['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'].map((p) => `pieces/${p}.svg`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Big vendored assets never change, so serve them from cache immediately.
// App code must NOT be cache-first, or an update never reaches the phone.
const IMMUTABLE = /\/(vendor|pieces|icons)\//;

function cacheFirst(req) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  }));
}

// Fresh when online, cached when not.
function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')));
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(IMMUTABLE.test(url.pathname) ? cacheFirst(e.request) : networkFirst(e.request));
});
