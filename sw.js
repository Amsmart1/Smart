const VERSION = "9";
const CACHE_NAME = `smartlms-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './teacher.html',
  './student.html',
  './js/core.js',
  './js/network-stability.js',
  './js/admin.js',
  './js/teacher.js',
  './js/student.js',
  './js/auth.js',
  './js/supabase-config.js',
  './js/anti-cheat.js',
  './js/proctor-engine.js',
  './js/countdown.js',
  './js/landing.js',
  './calendar_logic.js',
  './CSS/base.css',
  './CSS/components.css',
  './CSS/landing.css',
  './CSS/layout.css',
  './CSS/themes.css',
  './CSS/calendar.css',
  './manifest.json',
  './favicon.ico',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://meet.jit.si/external_api.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[SW] Caching shell assets securely...');
      const cachePromises = ASSETS.map(async (asset) => {
        try {
          const request = new Request(asset, { cache: 'reload' });
          const response = await fetch(request);
          if (response && response.ok) {
            await cache.put(request, response);
          } else {
            console.warn(`[SW] Skipping caching of invalid asset: ${asset} (Status: ${response ? response.status : 'no response'})`);
          }
        } catch (err) {
          console.error(`[SW] Failed to fetch and cache asset: ${asset}`, err);
        }
      });
      await Promise.all(cachePromises);
      return self.skipWaiting();
    })
  );
});

// Activate Event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all([
        ...keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        self.clients.claim()
      ]);
    })
  );
});

// Fetch Event - Strategy-based Routing
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests. All non-GET requests bypass the Service Worker completely.
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Check if it's an API request (Supabase or custom /api/)
  const isAPI = url.origin.includes('supabase.co') || url.pathname.includes('/api/');

  // 1. API Requests (Network-Only strategy, no cache reading/writing, with robust synthetic fallback on failure)
  if (isAPI) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ error: "Offline: Network unavailable." }),
          { status: 503, statusText: "Service Unavailable", headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // HTML -> Network First
  const isHTML = request.mode === 'navigate' ||
                 (request.headers.get('accept') && request.headers.get('accept').includes('text/html'));

  if (isHTML) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
          const indexResponse = await caches.match('./index.html');
          if (indexResponse) {
            return indexResponse;
          }
          // Return a robust synthetic offline HTML to prevent respondWith(undefined) crash
          return new Response(
            "<!DOCTYPE html><html><head><title>Offline - SmartLMS</title></head><body><h1>Offline</h1><p>You are currently offline, and this page has not been cached.</p></body></html>",
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  // CSS, JS, Images, Fonts -> Cache First
  const isAsset =
    url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|otf)$/) ||
    url.host.includes('gstatic.com') ||
    url.host.includes('googleapis.com') ||
    url.host.includes('cdnjs.cloudflare.com') ||
    url.host.includes('cdn.jsdelivr.net');

  if (isAsset) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const copy = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return networkResponse;
          })
          .catch(() => {
            // Return synthetic offline response instead of undefined to avoid crash
            return new Response(null, { status: 503, statusText: "Service Unavailable (Offline)" });
          });
      })
    );
    return;
  }

  // Default -> Network First
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        // Return synthetic offline response instead of undefined to avoid crash
        return new Response(null, { status: 503, statusText: "Service Unavailable (Offline)" });
      })
  );
});

// Push Notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const options = {
      body: data.body || 'New update from SmartLMS',
      icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/3135/3135665.png',
      badge: '/favicon.ico',
      data: {
        link: data.link || './index.html'
      },
      tag: 'smartlms-push',
      renotify: true,
      vibrate: [100, 50, 100]
    };

    event.waitUntil(
      self.registration.showNotification(data.title || 'SmartLMS', options)
    );
  } catch (err) {
    console.error('[SW] Push processing failed:', err);
  }
});

// Notification Click Event
self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const link = notification.data?.link;

  notification.close();

  if (link) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        // 1. Try to find an existing window with the same URL
        for (const client of clientList) {
          const url = new URL(client.url);
          const targetUrl = new URL(link, self.location.origin);

          if (url.pathname === targetUrl.pathname && client.focus) {
            return client.focus();
          }
        }

        // 2. If no matching window, open a new one
        if (clients.openWindow) {
          return clients.openWindow(link);
        }
      })
    );
  }
});
