/*
 * AttendanceSecure service worker.
 *
 * Only static application resources are cached. Nothing under /api/ is ever cached or
 * replayed: an attendance submission is a live decision by the server (session status,
 * biometric freshness, duplicate detection), so it can never be queued offline.
 */
const VERSION = "attendsecure-v1";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

const PRECACHE = [
  "/",
  "/index.html",
  "/offline.html",
  "/manifest.webmanifest",
  "/login.html",
  "/checkin.html",
  "/dashboard.html",
  "/create-session.html",
  "/live.html",
  "/records.html",
  "/flagged.html",
  "/export.html",
  "/css/style.css",
  "/js/app.js",
  "/js/pwa.js",
  "/student/",
  "/student/index.html",
  "/student/styles.css",
  "/student/app.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // One missing file must not break the whole installation.
      await Promise.all(
        PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

const isApi = (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/private_uploads");
const isStatic = (url) =>
  /\.(css|js|png|jpg|jpeg|svg|webp|ico|woff2?|webmanifest)$/i.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // POST/PATCH/DELETE always go to the network

  const url = new URL(request.url);

  // Live data must always come from the server. No cache, no offline fallback.
  if (url.origin === self.location.origin && isApi(url)) return;

  // Page navigations: fresh when online, cached shell when not, offline page as last resort.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL);
          cache.put(request, response.clone());
          return response;
        } catch {
          const cached = (await caches.match(request)) || (await caches.match("/"));
          return cached || caches.match("/offline.html");
        }
      })(),
    );
    return;
  }

  // Static assets: serve from cache instantly, refresh in the background.
  if (url.origin === self.location.origin && isStatic(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })(),
    );
    return;
  }

  // Fonts and other third-party assets: cache the result the first time it is used.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request).catch(() => null);
        if (response && response.ok) cache.put(request, response.clone());
        return response || Response.error();
      })(),
    );
  }
});
