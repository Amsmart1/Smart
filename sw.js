const VERSION = "6";
const CACHE_NAME = `smartlms-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './teacher.html',
  './student.html',
  './js/core.js',
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
      console.log('Caching shell assets');
      await Promise.allSettled(
        ASSETS.map(asset => cache.add(asset))
      );
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
  const url = new URL(request.url);

  // API Requests -> Network Only
  if (url.origin.includes('supabase.co') || url.pathname.includes('/api/')) {
    return;
  }

  // Only handle GET requests for caching
  if (request.method !== 'GET') {
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
        .catch(() => caches.match(request).then((res) => res || caches.match('./index.html')))
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
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
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
      .catch(() => caches.match(request))
  );
});

// Background Sync
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-db-ops') {
    event.waitUntil(syncDatabaseOperations());
  }
});

async function syncDatabaseOperations() {
  console.log('Background sync in progress...');
  // Check for queued operations in Cache API (as a simple key-value store alternative to IndexedDB)
  const cache = await caches.open('sync-queue');
  const requests = await cache.keys();

  for (const request of requests) {
    try {
      const response = await fetch(request.clone());
      if (response.ok) {
        await cache.delete(request);
        console.log('Successfully synced operation:', request.url);
      }
    } catch (e) {
      console.warn('Sync failed for request:', request.url, e);
    }
  }
}

// Push Notifications
self.addEventListener('push', (event) => {
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: 'https://cdn-icons-png.flaticon.com/512/3135/3135665.png'
  };
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});
