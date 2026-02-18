const CACHE_NAME = "toepoel-planner-v1.02";

const FILES_TO_CACHE = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo-192.png",
  "/logo-512.png"
];

// Install: cache basisbestanden
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
});

// Activate: verwijder oude caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("toepoel-planner-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - index.html -> network-first (altijd nieuwste versie)
// - rest -> cache-first (snel)
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Alleen dezelfde origin cachen
  if (url.origin !== self.location.origin) return;

  // HTML altijd network-first voor updates
  if (url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Overig: cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
        return res;
      });
    })
  );
});
