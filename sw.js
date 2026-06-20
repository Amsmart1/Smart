const CACHE_NAME = 'smartlms-v6';
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
  './calendar_logic.js',
  './css/base.css',
  './css/components.css',
  './css/landing.css',
  './css/layout.css',
  './css/themes.css',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://meet.jit.si/external_api.js'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching shell assets');
      return cache.addAll(ASSETS);
    })
  );
});

// Activate Event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
});

// Fetch Event - Network First Strategy for shell assets, skip Supabase
self.addEventListener('fetch', (event) => {
  // Skip cross-origin requests for Supabase API (handled by client)
  if (event.request.url.includes('supabase.co')) {
    return;
  }

  // Only handle GET requests for caching
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(event.request).then((fetchRes) => {
      // Network worked, update cache and return
      if (fetchRes && fetchRes.status === 200 && event.request.url.startsWith(self.location.origin)) {
        const resClone = fetchRes.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request.url, resClone);
        });
      }
      return fetchRes;
    }).catch(() => {
      // Network failed, try cache
      return caches.match(event.request).then((cacheRes) => {
        if (cacheRes) return cacheRes;

        // Final fallback
        if (event.request.url.indexOf('.html') > -1) {
          return caches.match('./index.html');
        }
      });
    })
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
