// sw.js — Toepoel's Planner (v1.03+)
// Belangrijkste doel: iPhone/Chrome niet “vast” laten zitten op een oude versie.
// Strategie:
// - HTML (/) en /index.html: altijd vers ophalen (network-first)
// - Static assets: cache-first (sneller), maar wel met nieuwe cache versie
// - Oude caches opruimen bij activate
// - skipWaiting + clientsClaim zodat updates sneller “pakken”

const VERSION = "1.05"; // <-- verhoog dit bij elke release
const CACHE_STATIC = `toepoel-static-${VERSION}`;
const CACHE_RUNTIME = `toepoel-runtime-${VERSION}`;

// Precache: alleen echt noodzakelijke dingen
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo-192.png",
  "/logo-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_STATIC);
      await cache.addAll(PRECACHE);
      // Forceer nieuwe SW om actief te worden
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // claim clients meteen (zodat update sneller live is)
      await self.clients.claim();

      // oude caches weggooien
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => {
          if (k !== CACHE_STATIC && k !== CACHE_RUNTIME) return caches.delete(k);
        })
      );
    })()
  );
});

function isHTMLRequest(request) {
  const url = new URL(request.url);
  if (request.mode === "navigate") return true;
  // direct index.html
  if (url.pathname === "/" || url.pathname === "/index.html") return true;
  // accept header contains text/html
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isAPIRequest(request) {
  const url = new URL(request.url);
  return (
    url.pathname.startsWith("/stations") ||
    url.pathname.startsWith("/reis") ||
    url.pathname.startsWith("/reis-extreme-b") ||
    url.pathname.startsWith("/favorieten")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Alleen GET requests cachen
  if (req.method !== "GET") return;

  // 1) HTML: network-first (zodat je versie altijd update)
  if (isHTMLRequest(req)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req, { cache: "no-store" });
          const cache = await caches.open(CACHE_RUNTIME);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(req);
          return cached || caches.match("/index.html");
        }
      })()
    );
    return;
  }

  // 2) API requests: nooit cachen via SW (server-side caching doet dit al)
  if (isAPIRequest(req)) {
    event.respondWith(fetch(req));
    return;
  }

  // 3) Overige static assets: cache-first (sneller), met runtime update
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;

      const fresh = await fetch(req);
      // alleen succesvolle responses cachen
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE_STATIC);
        cache.put(req, fresh.clone());
      }
      return fresh;
    })()
  );
});

// Optioneel: vanuit de pagina een update forceren:
// navigator.serviceWorker.controller?.postMessage({type:"SKIP_WAITING"})
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
