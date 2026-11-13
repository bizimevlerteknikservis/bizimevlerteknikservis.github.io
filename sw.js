/* Bizimevler 1 · çevrimdışı destek
   Sayfa internet yokken de açılsın diye site dosyaları telefonda saklanır.
   Sayfanın kendisi önce internetten alınır (güncel kalsın), internet yoksa saklanan sürüm açılır. */
const SURUM = "bz1-v1";
const ONCEDEN = ["./", "./index.html"];
const DIS = ["https://www.gstatic.com/firebasejs/", "https://cdn.jsdelivr.net/npm/jsqr@"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SURUM).then(c => c.addAll(ONCEDEN)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SURUM).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  // Sayfa: önce internet, olmazsa saklanan
  if (r.mode === "navigate" || (u.origin === location.origin && /\.html$|\/$/.test(u.pathname))) {
    e.respondWith(
      fetch(r).then(res => { if (res.ok) { const k = res.clone(); caches.open(SURUM).then(c => c.put(u.pathname.endsWith("/") ? "./" : r, k)); } return res; })
        .catch(() => caches.match(r, {ignoreSearch: true}).then(m => m || caches.match("./")))
    );
    return;
  }
  // Firebase ve QR kütüphanesi: sürüm numaralı, değişmez → önce saklanan
  if (DIS.some(p => r.url.startsWith(p))) {
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { if (res.ok) { const k = res.clone(); caches.open(SURUM).then(c => c.put(r, k)); } return res; })));
  }
});
