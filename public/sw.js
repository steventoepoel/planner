// sw.js — Toepoel's Planner (v1.08)
// Doel: nooit “vast” blijven zitten op oude versies (iOS/Chrome)
// Strategie:
// - HTML pagina’s: network-first (altijd nieuwste)
// - API: nooit cachen (server doet caching/rate limiting)
// - Static assets: stale-while-revalidate (snel + stil updaten)
// - Oude caches opruimen
// - skipWaiting + clients.claim voor snelle updates

const VERSION = "1.08";
const CACHE_STATIC  = `toepoel-static-${VERSION}`;
const CACHE_RUNTIME = `toepoel-runtime-${VERSION}`;

// Precache: essentials + SEO files + share image
const PRECACHE = [
  "/",
  "/index.html",
  "/over.html",
  "/manifest.json",
  "/robots.txt",
  "/sitemap.xml",
  "/logo-192.png",
  "/logo-512.png",
  "/toepoels_planner_optimized.webp"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_STATIC);
    await cache.addAll(PRECACHE);
    // nieuwe SW zo snel mogelijk actief
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();

    // oude caches weggooien
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k !== CACHE_STATIC && k !== CACHE_RUNTIME) return caches.delete(k);
    }));
  })());
});

function isHTMLRequest(request) {
  const url = new URL(request.url);

  if (request.mode === "navigate") return true;

  // direct html routes
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/over.html") return true;

  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isAPIRequest(request) {
  const url = new URL(request.url);
  return (
    url.pathname.startsWith("/stations") ||
    url.pathname.startsWith("/reis") ||
    url.pathname.startsWith("/reis-extreme-b") ||
    url.pathname.startsWith("/favorieten") ||
    url.pathname.startsWith("/ov")
  );
}

// Network-first voor HTML (altijd nieuwste)
async function handleHTML(req) {
  try {
    const fresh = await fetch(req, { cache: "no-store" });
    const cache = await caches.open(CACHE_RUNTIME);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(req);
    return cached || caches.match("/index.html");
  }
}

// Stale-while-revalidate voor static assets
async function handleStatic(req) {
  const cached = await caches.match(req);
  const fetchPromise = fetch(req).then(async (fresh) => {
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(req, fresh.clone());
    }
    return fresh;
  }).catch(() => null);

  // als er cache is: direct tonen, ondertussen updaten
  if (cached) {
    fetchPromise.catch(() => {});
    return cached;
  }

  // geen cache: wacht op netwerk
  const fresh = await fetchPromise;
  return fresh || cached;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  // HTML: network-first
  if (isHTMLRequest(req)) {
    event.respondWith(handleHTML(req));
    return;
  }

  // API: nooit cachen via SW
  if (isAPIRequest(req)) {
    event.respondWith(fetch(req));
    return;
  }

  // static: stale-while-revalidate
  event.respondWith(handleStatic(req));
});

// Update forceren vanuit pagina (banner-knop)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});