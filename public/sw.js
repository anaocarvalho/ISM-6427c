// Plateful service worker: makes the app open fast and work as an installed app.
// Pages: network first (so updates show up), cached copy when offline.
// Static files: cached copy first, refreshed in the background. The AI endpoint is never cached.
const CACHE = "plateful-v4";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/i18n.js", "/manifest.webmanifest", "/icon.svg", "/icons/apple-touch-icon.png", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { caches.open(CACHE).then((c) => c.put("/index.html", res.clone())); return res; })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fresh;
    }),
  );
});
