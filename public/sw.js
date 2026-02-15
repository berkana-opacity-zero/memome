const CACHE_VERSION = 'memome-pwa-v1'
const APP_SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.svg',
  '/icon-512.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL_FILES)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone()
          void caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', responseClone))
          return response
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_VERSION)
          return cache.match('/index.html')
        }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse
      }
      return fetch(request).then((networkResponse) => {
        const copy = networkResponse.clone()
        void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
        return networkResponse
      })
    }),
  )
})
