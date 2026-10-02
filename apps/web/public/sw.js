// Minimal service worker — satisfies PWA installability criteria.
// Deliberately cache-less: this is a wallet, stale responses would be worse
// than none. The fetch handler is a passthrough.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
  // Intentionally empty — not calling respondWith() lets the request hit the
  // network exactly as if no service worker were installed.
})
