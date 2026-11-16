/* Bizimevler 1 · Telefon bildirimleri
   Firestore'a yeni kayıt düşünce ilgili kişilerin telefonuna bildirim gönderir. Sadece okur ve bildirim yollar;
   hiçbir site kaydını değiştirmez (yalnız geçersiz olmuş telefon kimliklerini "bildirim" listesinden siler).
   Telefon kimlikleri: bildirim/{token} = {rol: personel|teknisyen|yonetim|tesis, grup, ad, kod, ariza, uid} */
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const fn = functions.region("europe-west1").runWith({ memory: "256MB", timeoutSeconds: 60 });

const SITE = "https://bizimevlerteknikservis.github.io/";
const BAHCIVAN = "Bahçıvan / Peyzaj";
const GRUP = { "Güvenlik": "guvenlik", "Temizlik": "temizlik", [BAHCIVAN]: "bahce" };
const KAT = { p_isik: "Aydınlatma", p_kapi: "Kapı / kilit", p_asansor: "Asansör", p_su: "Su / tesisat", p_hasar: "Kırık / hasar", p_bahce: "Bahçe / peyzaj",
  p_temiz: "Temizlik / koku", p_diger: "Diğer", p_malzeme: "Malzeme talebi", elektrik: "Elektrik", su: "Su tesisatı", kombi: "Kombi / ısıtma", kapi: "Kapı / kilit", asansor: "Asansör", diger: "Diğer" };
const sade = x => String(x || "").trim().toLocaleLowerCase("tr").replace(/\s+/g, " ");
const kisa = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const YONETICI = ["teknisyen", "yonetim", "tesis"];

/* Kayıtlı telefonlar; pasif kodlu personelin telefonu atlanır */
async function telefonlar() {
  const [b, k] = await Promise.all([db.collection("bildirim").get(), db.collection("kod").get()]);
  const aktif = new Set(k.docs.filter(d => d.data().aktif === true).map(d => d.id));
  return b.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => t.token && (t.rol !== "personel" || aktif.has(t.kod)));
}
function adres(t, sayfa) {
  if (sayfa) return SITE + sayfa;
  if (t.rol === "personel") return SITE + (t.grup === "guvenlik" ? "devriye.html#devriye" : "personel.html#personel");
  return SITE + (t.rol === "teknisyen" ? "teknik.html#panel" : "teknik.html#panel");
}
const ikon = t => SITE + "icons/" + (t.rol === "personel" ? (t.grup === "guvenlik" ? "devriye" : "personel") : "teknik") + "-192.png";

/* Gönder: aynı içerik, telefon başına doğru sayfa adresiyle; geçersiz kimlikleri temizle */
async function gonder(hedef, icerik, sayfa) {
  const goruldu = new Set(); hedef = hedef.filter(t => !goruldu.has(t.token) && goruldu.add(t.token));
  if (!hedef.length) return 0;
  const gruplar = {};
  hedef.forEach(t => { const k = adres(t, sayfa) + "|" + ikon(t); (gruplar[k] ||= []).push(t); });
  let n = 0;
  for (const [k, L] of Object.entries(gruplar)) {
    const [url, ik] = k.split("|");
    for (let i = 0; i < L.length; i += 500) {
      const parca = L.slice(i, i + 500);
      const r = await admin.messaging().sendEachForMulticast({
        tokens: parca.map(t => t.token),
        data: { title: icerik.title, body: icerik.body, url, ikon: ik, tag: icerik.tag || "", onemli: icerik.onemli ? "1" : "0" },
        webpush: { headers: { Urgency: "high", TTL: String(icerik.ttl || 86400) } }
      });
      n += r.successCount;
      await Promise.all(r.responses.map((x, j) => {
        const c = x.error && x.error.code;
        if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token" || c === "messaging/invalid-argument")
          return db.collection("bildirim").doc(parca[j].id).delete().catch(() => {});
      }));
    }
  }
  functions.logger.info("bildirim", { baslik: icerik.title, hedef: hedef.length, basarili: n });
  return n;
}

/* 1) Görev / talimat verildi → ilgili personel */
exports.gorevBildirim = fn.firestore.document("gorev/{id}").onCreate(async snap => {
  const g = snap.data(); if (!g || !g.kime || g.durum === "iptal") return;
  const T = (await telefonlar()).filter(t => t.rol === "personel");
  const hedef = g.kime.tip === "grup" ? T.filter(t => t.grup === GRUP[g.kime.rol]) : T.filter(t => sade(t.ad) === sade(g.kime.ad));
  const talimat = g.tur === "talimat";
  await gonder(hedef, {
    title: talimat ? `📢 Talimat · ${g.byAd || "Yönetim"}` : `📌 Yeni görev · ${g.byAd || "Yönetim"}`,
    body: kisa((g.yer ? g.yer + " — " : "") + (g.metin || ""), 180), tag: "gorev-" + snap.id, onemli: talimat
  });
});

/* 2) Görev yapıldı → görevi veren */
exports.gorevYapildi = fn.firestore.document("gorev/{id}").onUpdate(async ch => {
  const a = ch.before.data(), b = ch.after.data();
  if (!b || a.durum === b.durum || b.durum !== "yapildi" || !b.uid) return;
  const hedef = (await telefonlar()).filter(t => t.uid === b.uid && YONETICI.includes(t.rol));
  const kim = b.yapildiAd || (b.kime && (b.kime.ad || b.kime.rol)) || "Personel";
  await gonder(hedef, { title: `✅ Görev yapıldı · ${kisa(kim, 40)}`, body: kisa(b.metin, 160), tag: "gorev-" + ch.after.id }, "teknik.html#gorev");
});

/* 3) Arıza ve personel bildirimleri */
exports.arizaBildirim = fn.firestore.document("appointments/{id}").onCreate(async snap => {
  const a = snap.data(); if (!a || a.sample || a.status === "iptal") return;
  const T = await telefonlar();
  if (a.src === "personel") {
    if (a.cat === "p_gelemiyorum") {
      return gonder(T.filter(t => YONETICI.includes(t.rol)), { title: `🚫 İşe gelemiyor · ${kisa(a.name, 40)}`, body: kisa(a.desc || "Sebep belirtilmedi", 160), tag: "gel-" + snap.id, onemli: true });
    }
    if (a.cat === "p_tasinma") return;                      // taşınma/tadilat bilgisi bildirim gerektirmez
    if (a.cat === "p_malzeme") {
      return gonder(T.filter(t => t.rol === "teknisyen" || t.rol === "tesis"), { title: `📦 Malzeme talebi · ${kisa(a.name, 40)}`, body: kisa(a.desc || (a.issues || []).join(", "), 160), tag: "mlz-" + snap.id });
    }
    const yer = a.alan || (a.block ? `${a.block} Blok${a.kat ? " · " + a.kat : ""}` : "Ortak alan");
    const hedef = T.filter(t => t.ariza !== false && t.uid !== a.uid);
    return gonder(hedef, {
      title: `🔴 Arıza · ${kisa(yer, 40)}`,
      body: kisa(`${KAT[a.cat] || "Arıza"}${(a.issues || []).length ? " — " + a.issues.join(", ") : a.desc ? " — " + a.desc : ""} · ${a.name || ""}`, 180),
      tag: "ariza-" + snap.id, onemli: a.cat === "p_asansor" && /mahsur/i.test(a.desc || "")
    }, null);
  }
  // Sakin (daire) arızası: kişisel bilgi içerir → sadece teknisyen
  return gonder(T.filter(t => t.rol === "teknisyen" && t.ariza !== false), {
    title: `🏠 Daire arızası · ${a.block || "?"}/${a.flat || "?"}`, body: kisa(`${KAT[a.cat] || "Arıza"}${(a.issues || []).length ? " — " + a.issues.join(", ") : ""}`, 160), tag: "daire-" + snap.id
  }, "teknik.html#panel");
});
