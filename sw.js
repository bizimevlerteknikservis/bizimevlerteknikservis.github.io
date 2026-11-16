/* Bizimevler 1 · çevrimdışı destek
   Sayfa internet yokken de açılsın diye site dosyaları telefonda saklanır.
   Sayfanın kendisi önce internetten alınır (güncel kalsın), internet yoksa saklanan sürüm açılır. */
const SURUM = "bz1-v3";
const ONCEDEN = ["./", "./index.html", "./personel.html", "./devriye.html", "./teknik.html"];
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

/* ---------- Telefon bildirimi (Firebase Cloud Messaging) ----------
   Sunucu sadece veri gönderir; bildirimi burada gösteririz (iPhone dahil her telefonda aynı görünür). */
self.addEventListener("push", e => {
  let d = {};
  try { const j = e.data ? e.data.json() : {}; d = Object.assign({}, j.notification || {}, j.data || {}); }
  catch(_){ d = {body: e.data ? e.data.text() : ""}; }
  const ikon = d.ikon || "icons/personel-192.png";
  e.waitUntil(self.registration.showNotification(d.title || "Bizimevler 1", {
    body: d.body || "", icon: ikon, badge: ikon, tag: d.tag || undefined, renotify: !!d.tag,
    vibrate: [250, 120, 250], requireInteraction: d.onemli === "1", data: {url: d.url || "./"}
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(L => {
    const c = L.find(x => x.url.split("#")[0] === url.split("#")[0]);
    if (c){ return c.focus().then(w => (w && w.navigate && w.url !== url) ? w.navigate(url) : w).catch(() => self.clients.openWindow(url)); }
    return self.clients.openWindow(url);
  }));
});
