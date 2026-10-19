const CACHE_PREFIX = "ielts-coach-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./model.js",
  "./curriculum.js",
  "./cloud.js",
  "./cloud-config.js",
  "./vendor/supabase.min.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
const SCOPE = new URL(self.registration.scope);
const SHELL_PATHS = new Set(SHELL.map((path) => new URL(path, SCOPE).pathname));
const INDEX_URL = new URL("./index.html", SCOPE).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  // Account/API traffic and audio never enter the offline shell cache.
  if (/\/(auth|rest|storage)\/v1\//.test(url.pathname) ||
      event.request.destination === "audio" || /\.(mp3|m4a|ogg|wav)$/i.test(url.pathname)) return;
  const navigate = event.request.mode === "navigate";
  if (!navigate && !SHELL_PATHS.has(url.pathname)) return;
  const cacheKey = navigate ? INDEX_URL : `${url.origin}${url.pathname}`;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cachedResponse = response.clone();
        event.waitUntil(caches.open(CACHE_NAME)
          .then((cache) => cache.put(cacheKey, cachedResponse))
          .catch(() => {}));
      }
      // HTTP failures remain visible; fallback is only for an actual network failure.
      return response;
    } catch {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      return new Response("当前离线且此页面尚未缓存。请联网打开一次后再试。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  })());
});
