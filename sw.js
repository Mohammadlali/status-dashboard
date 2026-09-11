/**
 * Claud-Cloud Operations Feed Service Worker
 * Handles static asset caching and Web Push notifications.
 */

const CACHE_NAME = 'claud-status-v1';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vapid_public.json'
];

// Install: pre-cache application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Pre-cache partial warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old cache versions & take immediate control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-first for status data; Cache-first for app shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Status JSON and API requests should NEVER be served stale from cache
  if (url.pathname.endsWith('status.json') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell & static assets: Cache-first falling back to network
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch update in background for next time
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});

// Push notification received
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { title: 'Claud-Cloud Status Alert', body: event.data.text() };
    }
  } else {
    payload = {
      title: 'Claud-Cloud Alert',
      body: 'A red or stuck item was detected in operations.'
    };
  }

  const title = payload.title || 'Claud-Cloud Alert';
  const options = {
    body: payload.body || 'A red or stuck operations item requires attention.',
    icon: payload.icon || 'icons/icon-192.png',
    badge: payload.badge || 'icons/icon-192.png',
    tag: payload.tag || 'claud-cloud-alert',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300],
    data: {
      url: (payload.data && payload.data.url) || payload.url || '/#stuck-section'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click: focus existing window or open target
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/#stuck-section';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          if (client.navigate) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
