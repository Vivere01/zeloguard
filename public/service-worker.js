// ZeloGuard Service Worker v2
// Handles: caching, background keepalive, persistent notification

const CACHE_NAME = 'zeloguard-v2';
const CACHED_ASSETS = [
  '/child.html',
  '/css/style.css',
  '/js/child.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// ─── Install: cache assets ───────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHED_ASSETS).catch((err) => {
        console.warn('[SW] Cache addAll partial failure:', err);
      });
    })
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches ──────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: serve from cache when offline ────────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Only handle same-origin requests, skip Socket.io polling
  if (
    event.request.url.includes('/socket.io/') ||
    event.request.url.includes('/api/')
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});

// ─── Message from client (child.js) ──────────────────────────────────────────
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'START_TRACKING') {
    // Show a persistent notification so Android keeps SW alive
    showTrackingNotification(payload?.name || 'ZeloGuard');
  }

  if (type === 'STOP_TRACKING') {
    self.registration.getNotifications({ tag: 'zeloguard-tracking' }).then((notes) => {
      notes.forEach((n) => n.close());
    });
  }

  if (type === 'ACCESS_REVOKED') {
    self.registration.getNotifications({ tag: 'zeloguard-tracking' }).then((notes) => {
      notes.forEach((n) => n.close());
    });
    // Show a one-time notification to inform the user
    self.registration.showNotification('ZeloGuard', {
      body: 'Seu acesso de rastreamento foi revogado pelo responsável.',
      icon: '/icons/icon-192.png',
      tag: 'zeloguard-revoked',
      requireInteraction: false
    });
  }
});

// ─── Persistent notification helper ──────────────────────────────────────────
function showTrackingNotification(name) {
  // Only show if we have permission
  self.registration.showNotification('ZeloGuard — Rastreamento ativo 🛡️', {
    body: `Localização de ${name} está sendo compartilhada com o responsável.`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'zeloguard-tracking',      // Single tag so it replaces rather than stacks
    renotify: false,
    silent: true,                    // No sound - just keep it alive
    requireInteraction: true         // Stays visible until dismissed (Android keepalive key)
  });
}

// ─── Notification click: reopen app ──────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Bring existing tab to front
      for (const client of clients) {
        if (client.url.includes('child.html') && 'focus' in client) {
          return client.focus();
        }
      }
      // Or open new tab
      return self.clients.openWindow('/child.html');
    })
  );
});
