// sw.js — Toepoel's Planner (v1.11)
// Doel: snel + nooit vastzitten op oude versies.
// Strategie:
// - HTML: network-first (no-store) met fallback naar cache
// - Static assets: stale-while-revalidate
// - API: nooit cachen (stations/reis/ov)
// - skipWaiting + clientsClaim voor snelle updates

const VERSION = "1.11";
const CACHE_STATIC = `toepoels-static-${VERSION}`;
const CACHE_HTML = `toepoels-html-${VERSION}`;

// Precache: minimal maar genoeg om offline te openen
const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css?v=1.11",
  "/app.js?v=1.11",
  "/manifest.json",
  "/logo-192.png",
  "/logo-512.png",
  "/toepoels_planner_optimized.webp",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_STATIC);
    // addAll faalt als 1 item niet bestaat; daarom per stuk
    await Promise.all(PRECACHE.map(async (u)=>{
      try { await cache.add(u); } catch {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k !== CACHE_STATIC && k !== CACHE_HTML) return caches.delete(k);
    }));
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function isHTMLRequest(request) {
  const url = new URL(request.url);
  if (request.mode === "navigate") return true;
  if (url.pathname === "/" || url.pathname === "/index.html") return true;
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isAPIRequest(request) {
  const url = new URL(request.url);
  return (
    url.pathname.startsWith("/stations") ||
    url.pathname.startsWith("/reis") ||
    url.pathname.startsWith("/reis-extreme-b") ||
    url.pathname.startsWith("/ov/") ||
    url.pathname.startsWith("/favorieten")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // API nooit cachen
  if (isAPIRequest(req)) {
    event.respondWith(fetch(req));
    return;
  }

  // HTML: network-first (no-store)
  if (isHTMLRequest(req)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        const cache = await caches.open(CACHE_HTML);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || caches.match("/index.html");
      }
    })());
    return;
  }

  // Static: stale-while-revalidate
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const fetchPromise = fetch(req).then(async (fresh) => {
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE_STATIC);
        cache.put(req, fresh.clone());
      }
      return fresh;
    }).catch(() => null);

    return cached || (await fetchPromise) || cached;
  })());
});
