// Keeps the app shell on the phone so Hermes opens instantly, even before the tailnet connects.
// The page is fetched fresh whenever the network answers; hashed assets are immutable, so they are
// served from the cache. API calls and the live socket are never cached.
const SHELL = 'hermes-shell-v1'
const ASSETS = 'hermes-assets-v1'

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then(cache => cache.addAll(['/', '/manifest.webmanifest', '/icons/icon-180.png']))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== SHELL && key !== ASSETS).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hm/')) {
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.open(ASSETS).then(cache =>
        cache.match(event.request).then(
          hit =>
            hit ||
            fetch(event.request).then(response => {
              if (response.ok) {
                cache.put(event.request, response.clone())
              }

              return response
            })
        )
      )
    )

    return
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(
              caches
                .open(SHELL)
                .then(cache => cache.put('/', copy.clone()))
                .then(() => copy.text())
                .then(pruneAssets)
            )
          }

          // While the app's service restarts the proxy answers 502: open the app from its copy (it
          // reconnects by itself) rather than show an error page.
          if (response.status >= 500) {
            return caches.match('/').then(shell => shell || response)
          }

          return response
        })
        .catch(() => caches.match('/'))
    )
  }
})

// Every deploy brings new hashed bundles; keep only the ones the current page loads.
async function pruneAssets(html) {
  const wanted = new Set(Array.from(html.matchAll(/\/assets\/[^"']+/g), match => new URL(match[0], self.location.origin).href))
  const cache = await caches.open(ASSETS)

  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname.startsWith('/assets/') && !wanted.has(request.url)) {
      await cache.delete(request)
    }
  }
}
