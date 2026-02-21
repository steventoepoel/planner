// sw.js — Toepoel's Planner (v1.09)
// HTML: network-first; API: no-cache; Static: stale-while-revalidate

const VERSION = "1.09";
const CACHE_STATIC  = `toepoel-static-${VERSION}`;
const CACHE_RUNTIME = `toepoel-runtime-${VERSION}`;

const PRECACHE = [
  "/",
  "/index.html",
  "/over.html",
  "/manifest.json",
  "/robots.txt",
  "/sitemap.xml",
  "/logo-192.png",
  "/logo-512.png",
  "/toepoels_planner_optimized.webp",
  "/styles.css",
  "/app.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_STATIC);
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k !== CACHE_STATIC && k !== CACHE_RUNTIME) return caches.delete(k);
    }));
  })());
});

function isHTMLRequest(request) {
  const url = new URL(request.url);
  if (request.mode === "navigate") return true;
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

async function handleStatic(req) {
  const cached = await caches.match(req);
  const fetchPromise = fetch(req).then(async (fresh) => {
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(req, fresh.clone());
    }
    return fresh;
  }).catch(() => null);

  if (cached) {
    fetchPromise.catch(()=>{});
    return cached;
  }
  const fresh = await fetchPromise;
  return fresh || cached;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (isHTMLRequest(req)) {
    event.respondWith(handleHTML(req));
    return;
  }
  if (isAPIRequest(req)) {
    event.respondWith(fetch(req));
    return;
  }
  event.respondWith(handleStatic(req));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
