/* =====================================================================
   Bizimevler 1 · Bildirim postacısı (Cloudflare Workers, ücretsiz plan)
   Firebase veritabanı aynen kalır. Bu küçük sunucu sadece "postacı"dır:
   uygulama yeni bir görev/arıza kaydettiğinde buraya "şu kayıt eklendi" der;
   postacı kaydı Firebase'den KENDİSİ okur, doğrular ve ilgili telefonlara
   Firebase Cloud Messaging ile bildirim gönderir.

   Güvenlik:
   - Anahtar (SERVICE_ACCOUNT) sadece Cloudflare'de gizli değişken olarak durur, sitede/GitHub'da yoktur.
   - Dışarıdan gelen istek sadece "tür + kayıt numarası" söyler; içerik hep Firebase'den okunur.
   - Kayıt son 15 dakikada oluşturulmamışsa ya da daha önce bildirildiyse hiçbir şey gönderilmez
     (bildirimLog/{tür_kayıt} belgesi bir kez yazılır) → kimse sahte ya da tekrar bildirim yollayamaz.
   - Site kayıtlarını değiştirmez; sadece okur, bildirimLog'a not düşer, geçersiz telefon kimliğini siler.
     Tek istisna: gece unutulan mesai çıkışına "çıkış unutuldu" işareti (mesai kaydı, unutuldu:true) ekler.

   Zamanlı kontrol (Cloudflare → Settings → Triggers → Cron: "0,15,30,45 * * * *"), her 15 dakikada:
   - Vardiyası başladığı halde 15 dk içinde QR ile giriş yapmayan personeli amire/müdüre bildirir
   - Mesai bitiminden 30 dk sonra çıkış okutmayan personele hatırlatma gönderir; 23:00'te "çıkış unutuldu" işareti koyar
   - Her sabah 09:00'da bakımı yaklaşan/geçen ekipmanları ve azalan stoğu teknisyen ve müdüre bildirir
   - YEDEK: her gece 03:00'te son günün kayıtlarını, her ayın 1'inde (03:15–04:15) tam yedeği Telegram'a dosya olarak gönderir.
     Gerekli gizli değişkenler: TELEGRAM_TOKEN, TELEGRAM_CHAT. Fotoğraflar yedeğe girmez (yer kaplar).
   ===================================================================== */
const BAHCIVAN = "Bahçıvan / Peyzaj";
const GRUP = { "Güvenlik": "guvenlik", "Temizlik": "temizlik", [BAHCIVAN]: "bahce" };
const KAT = { p_isik: "Aydınlatma", p_kapi: "Kapı / kilit", p_asansor: "Asansör", p_su: "Su / tesisat", p_hasar: "Kırık / hasar", p_bahce: "Bahçe / peyzaj",
  p_temiz: "Temizlik / koku", p_diger: "Diğer", p_malzeme: "Malzeme talebi", elektrik: "Elektrik", su: "Su tesisatı", kombi: "Kombi / ısıtma", kapi: "Kapı / kilit", asansor: "Asansör", diger: "Diğer" };
const YONETICI = ["teknisyen", "yonetim", "tesis"];
const TAZE_MS = 15 * 60e3;
const sade = x => String(x || "").trim().toLocaleLowerCase("tr").replace(/\s+/g, " ");
const kisa = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/* ---------- Google erişim anahtarı (servis hesabıyla, 1 saat geçerli) ---------- */
let ERISIM = null;
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uMetin = s => b64u(new TextEncoder().encode(s));
async function erisim(sa) {
  if (ERISIM && ERISIM.son > Date.now() + 60e3) return ERISIM.anahtar;
  const simdi = Math.floor(Date.now() / 1000);
  const govde = b64uMetin(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64uMetin(JSON.stringify({
    iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat: simdi, exp: simdi + 3600,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging"
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const imza = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(govde));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + govde + "." + b64u(imza) });
  const j = await r.json(); if (!j.access_token) throw new Error("Google anahtarı alınamadı: " + JSON.stringify(j));
  ERISIM = { anahtar: j.access_token, son: Date.now() + (j.expires_in || 3600) * 1000 };
  return ERISIM.anahtar;
}

/* ---------- Firestore (REST) ---------- */
function deger(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(deger);
  if ("mapValue" in v) return alanlar(v.mapValue.fields || {});
  return null;
}
const alanlar = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, deger(v)]));
const belgeId = ad => decodeURIComponent(ad.split("/").pop());
function fsKok(sa) { return `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`; }
async function fsOku(sa, yol) {
  const r = await fetch(`${fsKok(sa)}/${yol}`, { headers: { authorization: "Bearer " + await erisim(sa) } });
  if (r.status === 404) return null; if (!r.ok) throw new Error("okuma " + yol + " " + r.status);
  const j = await r.json(); return { id: belgeId(j.name), ...alanlar(j.fields) };
}
async function fsListe(sa, koleksiyon, maske) {
  const L = []; let sayfa = "";
  do {
    const q = `pageSize=300${maske ? maske.map(m => "&mask.fieldPaths=" + m).join("") : ""}${sayfa ? "&pageToken=" + encodeURIComponent(sayfa) : ""}`;
    const r = await fetch(`${fsKok(sa)}/${koleksiyon}?${q}`, { headers: { authorization: "Bearer " + await erisim(sa) } });
    if (!r.ok) throw new Error("liste " + koleksiyon + " " + r.status);
    const j = await r.json(); (j.documents || []).forEach(d => L.push({ id: belgeId(d.name), ...alanlar(d.fields) })); sayfa = j.nextPageToken || "";
  } while (sayfa);
  return L;
}
/* Bir kez: bildirimLog/{anahtar} oluşturulamazsa (zaten varsa) daha önce gönderilmiştir */
async function ilkKezMi(sa, anahtar) {
  const r = await fetch(`${fsKok(sa)}/bildirimLog?documentId=${encodeURIComponent(anahtar)}`, { method: "POST",
    headers: { authorization: "Bearer " + await erisim(sa), "content-type": "application/json" },
    body: JSON.stringify({ fields: { ts: { integerValue: String(Date.now()) } } }) });
  if (r.status === 409) return false; if (!r.ok) throw new Error("log " + r.status); return true;
}
/* Basit sorgu: [[alan, "EQUAL"|"GREATER_THAN_OR_EQUAL", değer], ...] */
function fsDeger(v) { return typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { booleanValue: v } : v === null ? { nullValue: null } : { stringValue: String(v) }; }
async function fsSorgu(sa, koleksiyon, kosullar, alanlar_) {
  const filtre = kosullar.map(([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f }, op, value: fsDeger(v) } }));
  const sorgu = { from: [{ collectionId: koleksiyon }], ...(filtre.length ? { where: filtre.length === 1 ? filtre[0] : { compositeFilter: { op: "AND", filters: filtre } } } : {}),
    ...(alanlar_ ? { select: { fields: alanlar_.map(f => ({ fieldPath: f })) } } : {}) };
  const r = await fetch(`${fsKok(sa)}:runQuery`, { method: "POST", headers: { authorization: "Bearer " + await erisim(sa), "content-type": "application/json" }, body: JSON.stringify({ structuredQuery: sorgu }) });
  if (!r.ok) throw new Error("sorgu " + koleksiyon + " " + r.status);
  return (await r.json()).filter(x => x.document).map(x => ({ id: belgeId(x.document.name), ...alanlar(x.document.fields) }));
}
async function fsEkle(sa, koleksiyon, veri) {
  const fields = Object.fromEntries(Object.entries(veri).map(([k, v]) => [k, fsDeger(v)]));
  const r = await fetch(`${fsKok(sa)}/${koleksiyon}`, { method: "POST", headers: { authorization: "Bearer " + await erisim(sa), "content-type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error("ekle " + koleksiyon + " " + r.status);
}
async function fsSil(sa, yol) { await fetch(`${fsKok(sa)}/${yol}`, { method: "DELETE", headers: { authorization: "Bearer " + await erisim(sa) } }).catch(() => {}); }

/* ---------- alıcılar ve gönderim ---------- */
async function telefonlar(sa) {
  const [b, k] = await Promise.all([fsListe(sa, "bildirim"), fsListe(sa, "kod", ["aktif"])]);
  const aktif = new Set(k.filter(d => d.aktif === true).map(d => d.id));
  return b.filter(t => t.token && (t.rol !== "personel" || aktif.has(t.kod)));
}
function adres(site, t, sayfa) {
  if (sayfa) return site + sayfa;
  if (t.rol === "personel") return site + (t.grup === "guvenlik" ? "devriye.html#devriye" : "personel.html#personel");
  return site + "teknik.html#panel";
}
const ikon = (site, t) => site + "icons/" + (t.rol === "personel" ? (t.grup === "guvenlik" ? "devriye" : "personel") : "teknik") + "-192.png";
async function gonder(env, sa, hedef, icerik, sayfa) {
  const goruldu = new Set(); hedef = hedef.filter(t => !goruldu.has(t.token) && goruldu.add(t.token)).slice(0, 40);   // ücretsiz plan: istek başına 50 dış çağrı
  const anahtar = await erisim(sa);
  const sonuc = await Promise.all(hedef.map(async t => {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, { method: "POST",
      headers: { authorization: "Bearer " + anahtar, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: t.token,
        data: { title: icerik.title, body: icerik.body, url: adres(env.SITE, t, sayfa), ikon: ikon(env.SITE, t), tag: icerik.tag || "", onemli: icerik.onemli ? "1" : "0" },
        webpush: { headers: { Urgency: "high", TTL: "86400" } } } }) });
    if (r.ok) return 1;
    const j = await r.json().catch(() => ({}));
    const kod = j.error && (j.error.status || (j.error.details || []).map(d => d.errorCode).join(","));
    if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(String(kod)) || r.status === 404) await fsSil(sa, "bildirim/" + encodeURIComponent(t.id));
    return 0;
  }));
  return { hedef: hedef.length, basarili: sonuc.reduce((a, b) => a + b, 0) };
}

/* ---------- olaylar ---------- */
async function isle(env, sa, tur, id) {
  const simdi = Date.now();
  if (tur === "gorev") {
    const g = await fsOku(sa, "gorev/" + encodeURIComponent(id));
    if (!g || !g.kime || g.durum === "iptal" || !(simdi - g.ts < TAZE_MS)) return { atla: "eski ya da yok" };
    if (!(await ilkKezMi(sa, "gorev_" + id))) return { atla: "zaten bildirildi" };
    const T = (await telefonlar(sa)).filter(t => t.rol === "personel");
    const hedef = g.kime.tip === "grup" ? T.filter(t => t.grup === GRUP[g.kime.rol]) : T.filter(t => sade(t.ad) === sade(g.kime.ad));
    const talimat = g.tur === "talimat";
    return gonder(env, sa, hedef, { title: talimat ? `📢 Talimat · ${g.byAd || "Yönetim"}` : `📌 Yeni görev · ${g.byAd || "Yönetim"}`,
      body: kisa((g.yer ? g.yer + " — " : "") + (g.metin || ""), 180), tag: "gorev-" + id, onemli: talimat });
  }
  if (tur === "yapildi") {
    const g = await fsOku(sa, "gorev/" + encodeURIComponent(id));
    if (!g || g.durum !== "yapildi" || !g.uid || !(simdi - (g.yapildiTs || 0) < TAZE_MS)) return { atla: "eski ya da yok" };
    if (!(await ilkKezMi(sa, "yapildi_" + id))) return { atla: "zaten bildirildi" };
    const hedef = (await telefonlar(sa)).filter(t => t.uid === g.uid && YONETICI.includes(t.rol));
    const kim = g.yapildiAd || (g.kime && (g.kime.ad || g.kime.rol)) || "Personel";
    return gonder(env, sa, hedef, { title: `✅ Görev yapıldı · ${kisa(kim, 40)}`, body: kisa(g.metin, 160), tag: "gorev-" + id }, "teknik.html#gorev");
  }
  if (tur === "ariza") {
    const a = await fsOku(sa, "appointments/" + encodeURIComponent(id));
    if (!a || a.sample || a.status === "iptal" || !(simdi - a.createdAt < TAZE_MS)) return { atla: "eski ya da yok" };
    if (!(await ilkKezMi(sa, "ariza_" + id))) return { atla: "zaten bildirildi" };
    const T = await telefonlar(sa);
    if (a.src === "personel") {
      if (a.cat === "p_gelemiyorum") return gonder(env, sa, T.filter(t => YONETICI.includes(t.rol)), { title: `🚫 İşe gelemiyor · ${kisa(a.name, 40)}`, body: kisa(a.desc || "Sebep belirtilmedi", 160), tag: "gel-" + id, onemli: true });
      if (a.cat === "p_tasinma") return { atla: "taşınma" };
      if (a.cat === "p_malzeme") return gonder(env, sa, T.filter(t => t.rol === "teknisyen" || t.rol === "tesis"), { title: `📦 Malzeme talebi · ${kisa(a.name, 40)}`, body: kisa(a.desc || (a.issues || []).join(", "), 160), tag: "mlz-" + id });
      const yer = a.alan || (a.block ? `${a.block} Blok${a.kat ? " · " + a.kat : ""}` : "Ortak alan");
      return gonder(env, sa, T.filter(t => t.ariza !== false && t.uid !== a.uid), {
        title: `🔴 Arıza · ${kisa(yer, 40)}`,
        body: kisa(`${KAT[a.cat] || "Arıza"}${(a.issues || []).length ? " — " + a.issues.join(", ") : a.desc ? " — " + a.desc : ""} · ${a.name || ""}`, 180), tag: "ariza-" + id });
    }
    // Sakin (daire) arızası: kişisel bilgi içerir → sadece teknisyen, bildirimde isim/telefon yok
    return gonder(env, sa, T.filter(t => t.rol === "teknisyen" && t.ariza !== false), { title: `🏠 Daire arızası · ${a.block || "?"}/${a.flat || "?"}`,
      body: kisa(`${KAT[a.cat] || "Arıza"}${(a.issues || []).length ? " — " + a.issues.join(", ") : ""}`, 160), tag: "daire-" + id }, "teknik.html#panel");
  }
  // Teknisyen not yazdı ya da durumu değiştirdi → arızayı bildiren kişiye haber
  if (tur === "arizaGuncel") {
    const a = await fsOku(sa, "appointments/" + encodeURIComponent(id));
    if (!a || a.src !== "personel" || a.status === "iptal" || !(simdi - (a.guncelTs || 0) < TAZE_MS)) return { atla: "eski ya da yok" };
    if (!(await ilkKezMi(sa, `guncel_${id}_${a.guncelTs}`))) return { atla: "zaten bildirildi" };
    const hedef = (await telefonlar(sa)).filter(t => (a.kod && t.kod === a.kod) || (a.uid && t.uid === a.uid));
    if (!hedef.length) return { atla: "bildirenin telefonu kayıtlı değil" };
    const yer = a.alan || (a.block ? `${a.block} Blok${a.kat ? " · " + a.kat : ""}` : "Ortak alan");
    const baslik = a.status === "tamamlandi" ? "✅ Bildirdiğiniz arıza çözüldü" : a.status === "onaylandi" ? "🔧 Arızanızla ilgileniliyor" : `💬 Arızanıza not · ${kisa(a.karan || "Teknisyen", 30)}`;
    return gonder(env, sa, hedef, { title: baslik, body: kisa(`${KAT[a.cat] || "Arıza"} · ${yer}${a.note ? " — " + (a.karan ? a.karan + ": " : "") + a.note : ""}`, 190), tag: "guncel-" + id });
  }
  if (tur === "vardiya" || tur === "vardiyaSonuc") {
    const v = await fsOku(sa, "vardiya/" + encodeURIComponent(id));
    if (!v) return { atla: "yok" };
    const T = await telefonlar(sa);
    const gun = x => { if (!x) return ""; const [y, m, g] = x.split("-"); return `${+g} ${AYAD[+m - 1]}`; };
    if (tur === "vardiya") {
      if (v.durum !== "bekliyor" || !(simdi - v.ts < TAZE_MS)) return { atla: "eski" };
      if (!(await ilkKezMi(sa, "vardiya_" + id))) return { atla: "zaten bildirildi" };
      return gonder(env, sa, T.filter(t => t.rol === "yonetim" || t.rol === "tesis"), { title: `🔁 Vardiya değişimi · ${kisa(v.ad, 40)}`,
        body: kisa(`${gun(v.tarih)} yerine ${v.karsi} çalışsın${v.karsiTarih ? ` · karşılığında ${gun(v.karsiTarih)} kendisi çalışacak` : ""}. Onayınız bekleniyor.`, 180), tag: "vardiya-" + id, onemli: true }, "teknik.html#ik");
    }
    if (!["onay", "red"].includes(v.durum) || !(simdi - (v.karar || 0) < TAZE_MS)) return { atla: "eski" };
    if (!(await ilkKezMi(sa, "vardiyaSonuc_" + id))) return { atla: "zaten bildirildi" };
    const kisiler = [sade(v.ad), sade(v.karsi)];
    return gonder(env, sa, T.filter(t => t.rol === "personel" && (t.kod === v.kod || kisiler.includes(sade(t.ad)))), {
      title: v.durum === "onay" ? "✅ Vardiya değişimi onaylandı" : "❌ Vardiya değişimi reddedildi",
      body: kisa(`${v.ad} ⇄ ${v.karsi} · ${gun(v.tarih)}${v.karsiTarih ? " / " + gun(v.karsiTarih) : ""}${v.kararNot ? " · " + v.kararNot : ""}`, 180), tag: "vardiya-" + id, onemli: true });
  }
  return { atla: "bilinmeyen tür" };
}

/* =====================================================================
   ZAMANLI KONTROL: mesai (gelmeyen, çıkış unutma) + sabah bakım/stok özeti
   Beklenen çalışma günü puantaj.html'deki otomatik kuralın aynısıdır:
   güvenlik vardiya düzeni (G gündüz / N gece / HT izin), temizlik hafta içi + hafta sonu çalışma listesi,
   diğerleri çalışma günleri; resmi tatil (güvenlik hariç) ve İzinler'deki izin günleri çalışılmaz.
   ===================================================================== */
const AYAD = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const TR = 3 * 36e5;   // Türkiye saati (UTC+3, yaz saati yok)
const p2 = n => String(n).padStart(2, "0");
const trGun = ts => { const d = new Date(ts + TR); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; };
const trSaat = ts => { const d = new Date(ts + TR); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
const tsOf = (gun, saat) => Date.parse(`${gun}T${saat || "00:00"}:00+03:00`);
const gunEkle = (gun, n) => trGun(tsOf(gun, "12:00") + n * 864e5);
const haftaGunu = gun => new Date(tsOf(gun, "12:00") + TR).getUTCDay();
const gunFarki = (a, b) => Math.round((tsOf(a, "12:00") - tsOf(b, "12:00")) / 864e5);
const tsGun = v => typeof v === "number" ? trGun(v) : String(v || "").slice(0, 10);
const anahtar = ad => String(ad || "").trim().toLocaleLowerCase("tr").replace(/[çğıöşü]/g, c => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" }[c])).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const adKok = x => String(x || "").trim().split(/\s+/)[0].toLocaleUpperCase("tr");

const SABIT_TATIL = { "01-01": 1, "04-23": 1, "05-01": 1, "05-19": 1, "07-15": 1, "08-30": 1, "10-29": 1 };
const DINI_TATIL = new Set(["2026-03-20", "2026-03-21", "2026-03-22", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30",
  "2027-03-09", "2027-03-10", "2027-03-11", "2027-05-16", "2027-05-17", "2027-05-18", "2027-05-19"]);
const tatil = gun => DINI_TATIL.has(gun) || !!SABIT_TATIL[gun.slice(5)];
const VARDIYA_LISTE = [["1. Vardiya", ["Rüstem Eryüksel", "Ali Vesek", "Tayfun Özdemir", "Erkan Bavkir"]], ["2. Vardiya", ["Yakup Erol", "Cihan Yıldırım", "Serkan Çinibulak", "Mehmet Ünal"]],
  ["3. Vardiya", ["Nejdet Baydemir", "Yalçın Akyol", "Berke Dursun Tuncer", "Yusuf Nazlım"]], ["Joker", ["Eray Polat"]]];
const DESEN_VARSAYILAN = { "1. Vardiya": { seq: "G,G,N,N,HT,HT", baz: "2026-11-01" }, "2. Vardiya": { seq: "G,G,N,N,HT,HT", baz: "2026-10-30" }, "3. Vardiya": { seq: "G,G,N,N,HT,HT", baz: "2026-10-28" }, "Joker": { seq: "G,G,G,G,G,HT,HT", baz: "2026-11-02" } };
const SAAT_VARSAYILAN = { temizlik: { bas: "08:00", bit: "17:00" }, bahce: { bas: "08:00", bit: "17:00" }, diger: { bas: "08:00", bit: "17:00" }, G: { bas: "08:00", bit: "20:00" }, N: { bas: "20:00", bit: "08:00" }, tolerans: 15, gelmeyen: true, cikis: true };
const saatAyar = a => { const s = (a && a.saat) || {}; return { ...SAAT_VARSAYILAN, ...s, temizlik: { ...SAAT_VARSAYILAN.temizlik, ...(s.temizlik || {}) }, bahce: { ...SAAT_VARSAYILAN.bahce, ...(s.bahce || {}) },
  diger: { ...SAAT_VARSAYILAN.diger, ...(s.diger || {}) }, G: { ...SAAT_VARSAYILAN.G, ...(s.G || {}) }, N: { ...SAAT_VARSAYILAN.N, ...(s.N || {}) } }; };

/* Temizlik hafta sonu listesi (duyuru/izin) */
const cift = L => (L || []).map(r => Array.isArray(r) ? r : [r.ad || "", r.blok || ""]);
function planCoz(v) {
  if (!v) return null;
  if (v.cmt && v.paz && v.baz) return { baz: tsGun(v.baz), cmt: cift(v.cmt), paz: cift(v.paz) };
  if (!v.gunler) return null; let baz = null, cmt = [], paz = [];
  v.gunler.forEach(g => { const m = String(g.baslik || "").match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/); if (!m) return; const gun = `${m[3]}-${p2(m[2])}-${p2(m[1])}`;
    if (haftaGunu(gun) === 6) { cmt = cift(g.satir); baz = gun; } else if (haftaGunu(gun) === 0) { paz = cift(g.satir); if (!baz) baz = gunEkle(gun, -1); } });
  return baz ? { baz, cmt, paz } : null;
}
const cmtBul = gun => { const g = haftaGunu(gun); return g === 0 ? gunEkle(gun, -1) : gunEkle(gun, 6 - g); };
function haftaSonu(plan, gun) { const fark = Math.round(gunFarki(cmtBul(gun), cmtBul(plan.baz)) / 7); const tek = Math.abs(fark) % 2 === 1; return { cmtL: tek ? plan.paz : plan.cmt, pazL: tek ? plan.cmt : plan.paz }; }

function kisiListesi(ayar, plan) {
  const K = { ...((ayar && ayar.kisiler) || {}) };
  if (!Object.keys(K).length) {
    VARDIYA_LISTE.forEach(([v, L]) => L.forEach(ad => { K[anahtar(ad)] = { ad, grup: "guvenlik", vardiya: v, aktif: true }; }));
    const T = plan ? [...plan.cmt, ...plan.paz].map(r => r[0]).filter(Boolean) : [];
    [...new Set(T.map(adKok))].forEach(ad => { K[anahtar(ad)] = { ad, grup: "temizlik", duzen: "temizlik", aktif: true }; });
  }
  return Object.entries(K).filter(([, k]) => k.aktif !== false);
}
function izinli(izinler, k, gun) {
  return izinler.some(e => e.bas <= gun && (e.bit || e.bas) >= gun && (
    (k.grup === "guvenlik" && e.grup === "guvenlik" && anahtar(e.ad) === anahtar(k.ad)) ||
    (k.grup !== "guvenlik" && (e.grup || "temizlik") !== "guvenlik" && adKok(e.ad) === adKok(k.ad))));
}
/* O gün çalışıyor mu, hangi vardiyada? → null | "G" | "N" | "gunduz" (personel) */
function vardiyaTuru(ayar, plan, izinler, k, gun) {
  let tur = null;
  if (k.grup === "guvenlik") {
    const ds = ((ayar && ayar.desen) || {})[k.vardiya] || DESEN_VARSAYILAN[k.vardiya];
    if (ds) { const seq = ds.seq.split(","); const s = seq[((gunFarki(gun, tsGun(ds.baz)) % seq.length) + seq.length) % seq.length]; tur = s === "HT" ? null : s; }
    else tur = haftaGunu(gun) === 0 ? null : "G";
  } else if (k.duzen === "temizlik" || (k.grup === "temizlik" && !k.gunler)) {
    const g = haftaGunu(gun);
    if (g >= 1 && g <= 5) tur = "gunduz";
    else if (plan) { const h = haftaSonu(plan, gun), L = g === 6 ? h.cmtL : h.pazL; tur = L.some(([ad]) => adKok(ad) === adKok(k.ad)) ? "gunduz" : null; }
  } else tur = (k.gunler || [1, 2, 3, 4, 5, 6]).includes(haftaGunu(gun)) ? "gunduz" : null;
  if (tur && tatil(gun) && k.grup !== "guvenlik") tur = null;
  if (tur && izinli(izinler, k, gun)) tur = null;
  return tur;
}
/* Onaylı vardiya değişimleri: o gün kim kimin yerine */
function degisimUygula(degisim, k, gun, tur, turBul) {
  for (const v of degisim) {
    for (const [g, ben, o] of [[v.tarih, v.ad, v.karsi], [v.karsiTarih, v.karsi, v.ad]]) {
      if (!g || g !== gun) continue;
      if (anahtar(ben) === anahtar(k.ad)) return null;                              // izinli: yerine öteki çalışıyor
      if (anahtar(o) === anahtar(k.ad)) return turBul(ben) || "G";                     // ötekinin vardiyasını devralıyor
    }
  }
  return tur;
}
function vardiyaSaat(S, k, tur, gun) {
  const s = tur === "G" || tur === "N" ? S[tur] : (S[k.grup] || S.temizlik);
  const bas = tsOf(gun, s.bas); let bit = tsOf(gun, s.bit); if (bit <= bas) bit += 864e5;
  return { bas, bit };
}
const kayitKisinin = (k, r) => k.grup === "guvenlik" ? anahtar(r.ad) === anahtar(k.ad) : (r.grup !== "guvenlik" && adKok(r.ad) === adKok(k.ad));

async function mesaiKontrol(env, sa, simdi) {
  const [ayar, izinDoc, planDoc] = await Promise.all([fsOku(sa, "puantaj/ayar"), fsOku(sa, "duyuru/izinler"), fsOku(sa, "duyuru/izin")]);
  const S = saatAyar(ayar); if (!S.gelmeyen && !S.cikis) return { atla: "kapalı" };
  const plan = planCoz(planDoc), izinler = (izinDoc && izinDoc.liste) || [];
  const bugun = trGun(simdi), dun = gunEkle(bugun, -1);
  const [mesai, degisim, gelemez] = await Promise.all([
    fsSorgu(sa, "mesai", [["ts", "GREATER_THAN_OR_EQUAL", simdi - 14 * 864e5]], ["ad", "grup", "kod", "tip", "ts", "uid", "unutuldu"]),
    fsSorgu(sa, "vardiya", [["durum", "EQUAL", "onay"]], ["ad", "karsi", "tarih", "karsiTarih"]).catch(() => []),
    fsSorgu(sa, "appointments", [["cat", "EQUAL", "p_gelemiyorum"]], ["name", "rol", "createdAt", "status"]).catch(() => [])]);
  const kisiler = kisiListesi(ayar, plan);
  const turBugun = {}; const turBul = gun => ad => { const x = kisiler.find(([, k]) => anahtar(k.ad) === anahtar(ad)); return x ? vardiyaTuru(ayar, plan, izinler, x[1], gun) : null; };
  const tol = (+S.tolerans || 15) * 60e3;
  const gelmeyen = [], hatirlat = [], unut = [];
  for (const [key, k] of kisiler) {
    const R = mesai.filter(r => kayitKisinin(k, r)).sort((a, b) => a.ts - b.ts);
    if (!R.length) continue;                                         // QR kullanmaya başlamamış kişi: uyarı yok
    // 1) Gelmeyen: bugün (ve gece vardiyası için) başlangıç + tolerans geçti, giriş yok
    for (const gun of [bugun, dun]) {
      let tur = vardiyaTuru(ayar, plan, izinler, k, gun); tur = degisimUygula(degisim, k, gun, tur, turBul(gun));
      if (gun === bugun) turBugun[key] = tur;
      if (!tur) continue;
      const { bas } = vardiyaSaat(S, k, tur, gun);
      if (!(simdi >= bas + tol && simdi < bas + 4 * 36e5)) continue;
      if (R.some(r => r.tip === "giris" && r.ts >= bas - 3 * 36e5 && r.ts <= simdi)) continue;
      if (gelemez.some(a => a.status !== "iptal" && Math.abs(a.createdAt - bas) < 20 * 36e5 && (k.grup === "guvenlik" ? anahtar(a.name) === anahtar(k.ad) : adKok(a.name) === adKok(k.ad)))) continue;
      gelmeyen.push({ key, k, tur, bas, gun });
    }
    // 2) Çıkış unutma: son kayıt giriş, vardiya bitti
    const son = R[R.length - 1];
    if (son.tip === "giris" && simdi - son.ts < 30 * 36e5) {
      const gGun = trGun(son.ts), saat = trSaat(son.ts);
      let tur = k.grup === "guvenlik" ? (saat >= "16:00" || saat < "04:00" ? "N" : "G") : "gunduz";
      const gun = tur === "N" && saat < "04:00" ? gunEkle(gGun, -1) : gGun;
      const { bit } = vardiyaSaat(S, k, tur, gun);
      const unutSaat = tur === "N" ? bit + 3 * 36e5 : Math.max(bit + 3 * 36e5, tsOf(gun, "23:00"));
      if (S.cikis && simdi >= bit + 30 * 60e3 && simdi < unutSaat) hatirlat.push({ k, r: son, bit });
      if (simdi >= unutSaat) unut.push({ k, r: son, bit });
    }
  }
  const sonuc = { gelmeyen: gelmeyen.length, hatirlat: hatirlat.length, unut: unut.length };
  if (!gelmeyen.length && !hatirlat.length && !unut.length) return sonuc;
  const T = await telefonlar(sa);
  // Gelmeyenler: güvenlik → amirler + müdür; diğerleri → müdür + teknisyen. Kişi başına bir kez.
  const yeniG = [];
  if (S.gelmeyen) for (const x of gelmeyen) if (await ilkKezMi(sa, `gelmedi_${x.gun}_${x.tur}_${x.key}`.slice(0, 120))) yeniG.push(x);
  for (const [grupGuv, alici] of [[true, ["yonetim", "tesis"]], [false, ["tesis", "teknisyen"]]]) {
    const L = yeniG.filter(x => (x.k.grup === "guvenlik") === grupGuv); if (!L.length) continue;
    await gonder(env, sa, T.filter(t => alici.includes(t.rol)), { title: `⏰ İşe giriş yapılmadı · ${L.length} kişi`,
      body: kisa(L.map(x => `${x.k.ad} (${x.tur === "N" ? "gece " : x.tur === "G" ? "gündüz " : ""}${trSaat(x.bas)})`).join(", ") + " · QR ile giriş okutulmadı.", 180), tag: "gelmedi-" + bugun, onemli: true }, "puantaj.html");
  }
  for (const x of hatirlat) {
    if (!(await ilkKezMi(sa, "cikis_" + x.r.id))) continue;
    const hedef = T.filter(t => t.rol === "personel" && ((x.r.kod && t.kod === x.r.kod) || sade(t.ad) === sade(x.k.ad)));
    if (hedef.length) await gonder(env, sa, hedef, { title: "🏁 Çıkış okutmayı unuttunuz mu?", body: `Mesainiz ${trSaat(x.bit)}'de bitti. Çıkarken QR'ı okutun.`, tag: "cikis-" + x.r.id });
  }
  for (const x of unut) {
    if (!(await ilkKezMi(sa, "unutuldu_" + x.r.id))) continue;
    await fsEkle(sa, "mesai", { ad: x.r.ad || x.k.ad, grup: x.r.grup || x.k.grup, kod: x.r.kod || "", uid: x.r.uid || "", tip: "cikis", unutuldu: true, girisId: x.r.id, ts: simdi, nokta: "sistem" });
  }
  return sonuc;
}

/* =====================================================================
   YEDEK → Telegram (dosya). Firestore'dan gelen yanıt hiç çözümlenmeden (işlemci sınırı için) dosyaya eklenir.
   Sadece eklenen kayıtlar (mesai, devriye) günlük + aylık; değişebilenler son 60 gün günlük + ayda bir tümü.
   Geri yükleme: Teknisyen paneli → 💾 Yedek → "Yedekten geri yükle".
   ===================================================================== */
async function sorguHam(sa, koleksiyon, kosullar, ust) {
  const filtre = (kosullar || []).map(([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f }, op, value: fsDeger(v) } }));
  const sorgu = { from: [{ collectionId: koleksiyon }], ...(filtre.length ? { where: filtre.length === 1 ? filtre[0] : { compositeFilter: { op: "AND", filters: filtre } } } : {}) };
  const r = await fetch(`${fsKok(sa)}${ust ? "/" + ust : ""}:runQuery`, { method: "POST", headers: { authorization: "Bearer " + await erisim(sa), "content-type": "application/json" }, body: JSON.stringify({ structuredQuery: sorgu }) });
  if (!r.ok) throw new Error("yedek " + koleksiyon + " " + r.status);
  return r.arrayBuffer();
}
async function yedekGonder(env, sa, ad, parcalar, aciklama, simdi) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT) throw new Error("TELEGRAM_TOKEN / TELEGRAM_CHAT eklenmemiş");
  const govde = ['{"bicim":"bz1-yedek-rest-1","proje":' + JSON.stringify(sa.project_id) + ',"tarih":' + simdi + ',"ad":' + JSON.stringify(ad) + ',"veri":{'];
  parcalar.forEach(([k, buf], i) => { govde.push((i ? "," : "") + JSON.stringify(k) + ":", buf); });
  govde.push("}}");
  const dosya = new Blob(govde, { type: "application/json" });
  const fd = new FormData();
  fd.append("chat_id", String(env.TELEGRAM_CHAT)); fd.append("disable_notification", "true");
  fd.append("caption", `💾 ${aciklama} · ${(dosya.size / 1024).toFixed(0)} KB\nGeri yüklemek için: Teknisyen paneli → 💾 Yedek → Yedekten geri yükle`);
  fd.append("document", dosya, `${ad}.json`);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("telegram " + r.status + " " + (await r.text()).slice(0, 120));
  return dosya.size;
}
async function yedekDurumYaz(sa, veri) {
  const fields = Object.fromEntries(Object.entries(veri).map(([k, v]) => [k, fsDeger(v)]));
  const maske = Object.keys(veri).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  await fetch(`${fsKok(sa)}/ayar/yedek?${maske}`, { method: "PATCH", headers: { authorization: "Bearer " + await erisim(sa), "content-type": "application/json" }, body: JSON.stringify({ fields }) }).catch(() => {});
}
/* Değişebilen koleksiyonlar (tarih alanıyla) ve küçük koleksiyonlar (her seferinde tümü) */
const YEDEK_DEGISKEN = [["appointments", "createdAt"], ["tesis", "ts"], ["gorev", "ts"], ["tasinma", "ts"], ["vardiya", "ts"]];
const YEDEK_KUCUK = [["puantaj"], ["kod"], ["ayar"], ["duyuru"], ["muhasebe"], ["daireler", "muhasebe/veri"], ["giderler", "muhasebe/veri"]];
const YEDEK_EKLENEN = [["mesai", "ts"], ["devriye", "ts"]];
const kucukAd = ([k, ust]) => ust ? ust.replace(/\//g, "_") + "_" + k : k;
async function yedekCalis(env, sa, simdi) {
  const s = trSaat(simdi), bugun = trGun(simdi), ayBasi = bugun.endsWith("-01");
  const dilim = s >= "03:00" && s < "03:15" ? 0 : ayBasi && s >= "03:15" && s < "04:30" ? 1 + Math.floor((parseInt(s.slice(0, 2)) * 60 + parseInt(s.slice(3)) - 195) / 15) : -1;
  if (dilim < 0 || dilim > 5) return null;
  if (!(await ilkKezMi(sa, `yedek_${bugun}_${dilim}`))) return { atla: "alındı" };
  try {
    let ad, aciklama, parcalar = [];
    if (dilim === 0) {           // günlük: son 26 saatte eklenenler + son 60 günün değişebilen kayıtları + küçükler
      for (const [k, f] of YEDEK_EKLENEN) parcalar.push([k, await sorguHam(sa, k, [[f, "GREATER_THAN_OR_EQUAL", simdi - 26 * 36e5]])]);
      for (const [k, f] of YEDEK_DEGISKEN) parcalar.push([k, await sorguHam(sa, k, [[f, "GREATER_THAN_OR_EQUAL", simdi - 60 * 864e5]])]);
      for (const x of YEDEK_KUCUK) parcalar.push([kucukAd(x), await sorguHam(sa, x[0], [], x[1])]);
      ad = `yedek-gunluk-${bugun}`; aciklama = `Günlük yedek ${bugun}`;
    } else {                     // ayın 1'i: tam yedek, beş parça hâlinde
      const onceki = trGun(tsOf(bugun, "12:00") - 5 * 864e5).slice(0, 7), bas = tsOf(onceki + "-01", "00:00"), bit = tsOf(bugun, "00:00");
      if (dilim === 1) parcalar.push(["appointments", await sorguHam(sa, "appointments", [])]);
      if (dilim === 2) for (const [k] of YEDEK_DEGISKEN.slice(1)) parcalar.push([k, await sorguHam(sa, k, [])]);
      if (dilim === 3) parcalar.push(["mesai", await sorguHam(sa, "mesai", [["ts", "GREATER_THAN_OR_EQUAL", bas], ["ts", "LESS_THAN", bit]])]);
      if (dilim === 4) parcalar.push(["devriye", await sorguHam(sa, "devriye", [["ts", "GREATER_THAN_OR_EQUAL", bas], ["ts", "LESS_THAN", bit]])]);
      if (dilim === 5) for (const x of YEDEK_KUCUK) parcalar.push([kucukAd(x), await sorguHam(sa, x[0], [], x[1])]);
      const ne = ["", "arızalar (tümü)", "tesis, görev, taşınma, vardiya (tümü)", `mesai ${onceki}`, `devriye ${onceki}`, "puantaj, kodlar, ayarlar, muhasebe (tümü)"][dilim];
      ad = `yedek-aylik-${onceki}-${dilim}`; aciklama = `Aylık tam yedek ${dilim}/5 · ${ne}`;
    }
    const boyut = await yedekGonder(env, sa, ad, parcalar, aciklama, simdi);
    await yedekDurumYaz(sa, { son: simdi, sonAd: ad, sonBoyut: boyut, hata: "" });
    return { ad, boyut };
  } catch (e) {
    await yedekDurumYaz(sa, { hata: String(e.message || e).slice(0, 200), hataTs: simdi });
    throw e;
  }
}

/* Sabah 09:00: bakım takvimi (ayar/tesis.takvimOzet, uygulama hesaplar) + stok */
async function sabahOzet(env, sa, simdi) {
  const a = await fsOku(sa, "ayar/tesis"); if (!a) return { atla: "ayar yok" };
  const bugun = trGun(simdi);
  const L = ((a.takvimOzet && a.takvimOzet.liste) || []).map(x => ({ ...x, kalan: x.sonraki ? gunFarki(trGun(x.sonraki), bugun) : null }))
    .filter(x => x.sonraki && (x.kalan < 0 ? true : [30, 14, 7, 3, 1, 0].includes(x.kalan)));
  const S = Object.values(a.stok || {}).filter(x => x && x.ad && x.min != null && (+x.adet || 0) <= +x.min);
  if (!L.length && !S.length) return { atla: "yok" };
  if (!(await ilkKezMi(sa, "sabah_" + bugun))) return { atla: "zaten bildirildi" };
  const T = (await telefonlar(sa)).filter(t => t.rol === "teknisyen" || t.rol === "tesis");
  const gecen = L.filter(x => x.kalan < 0), yakin = L.filter(x => x.kalan >= 0).sort((x, y) => x.kalan - y.kalan);
  const parca = [];
  if (gecen.length) parca.push("Süresi geçti: " + gecen.map(x => x.ad).join(", "));
  if (yakin.length) parca.push(yakin.map(x => `${x.ad} ${x.kalan === 0 ? "bugün" : x.kalan + " gün"}`).join(", "));
  if (S.length) parca.push("Stok azaldı: " + S.map(x => `${x.ad} (${+x.adet || 0})`).join(", "));
  return gonder(env, sa, T, { title: gecen.length ? `🔧 Bakım zamanı geçti · ${gecen.length}` : L.length ? "📅 Yaklaşan bakımlar" : "📦 Stok azaldı", body: kisa(parca.join(" · "), 190), tag: "sabah-" + bugun }, "teknik.html#tesis");
}

async function zamanli(env, sa) {
  const simdi = Date.now(), s = trSaat(simdi), sonuc = {};
  try { sonuc.mesai = await mesaiKontrol(env, sa, simdi); } catch (e) { sonuc.mesai = { hata: String(e.message || e) }; }
  try { const y = await yedekCalis(env, sa, simdi); if (y) sonuc.yedek = y; } catch (e) { sonuc.yedek = { hata: String(e.message || e) }; }
  if (s >= "09:00" && s < "09:30") { try { sonuc.sabah = await sabahOzet(env, sa, simdi); } catch (e) { sonuc.sabah = { hata: String(e.message || e) }; } }
  return sonuc;
}

/* Hava: Atatürk Havalimanı (LTBA) gerçek ölçümü — METAR, NOAA aviationweather.gov. 10 dk önbellek.
   LTBA ölçümü yoksa İstanbul Havalimanı (LTFM). Sadece okunur, hiçbir kayıt tutulmaz. */
async function havaOlcum(ctx) {
  const anahtar = new Request("https://bizimevler-hava.local/metar-v1");
  const onbellek = caches.default;
  const eski = await onbellek.match(anahtar); if (eski) return eski.json();
  const r = await fetch("https://aviationweather.gov/api/data/metar?ids=LTBA,LTFM&format=json&hours=3", { headers: { "user-agent": "Bizimevler1-site/1.0" } });
  if (!r.ok) throw new Error("metar " + r.status);
  const L = await r.json();
  const sec = id => (Array.isArray(L) ? L : []).filter(x => x.icaoId === id && x.temp != null).sort((a, b) => (b.obsTime || 0) - (a.obsTime || 0))[0];
  const m = sec("LTBA") || sec("LTFM"); if (!m) throw new Error("ölçüm yok");
  const v = { icao: m.icaoId, obsTime: m.obsTime, reportTime: m.reportTime, temp: m.temp, dewp: m.dewp, wdir: m.wdir, wspd: m.wspd, wgst: m.wgst || null, wxString: m.wxString || "", clouds: (m.clouds || []).map(c => ({ cover: c.cover, base: c.base })), rawOb: m.rawOb };
  ctx.waitUntil(onbellek.put(anahtar, new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "max-age=600" } })));
  return v;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
function hazirla(env) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  if (!env.SITE) env = { ...env, SITE: "https://bizimevlerteknikservis.github.io/" };
  return { sa, env };
}
export default {
  // Cloudflare Cron Trigger (her 15 dakikada bir)
  async scheduled(olay, env, ctx) {
    let h; try { h = hazirla(env); } catch (e) { console.error("SERVICE_ACCOUNT eksik"); return; }
    ctx.waitUntil(zamanli(h.env, h.sa).then(s => console.log(JSON.stringify(s))));
  },
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method === "GET" && new URL(req.url).searchParams.has("hava")) {
      try { return new Response(JSON.stringify(await havaOlcum(ctx)), { headers: { "content-type": "application/json", "cache-control": "max-age=300", ...CORS } }); }
      catch (e) { return new Response(JSON.stringify({ hata: String(e.message || e) }), { status: 502, headers: { "content-type": "application/json", ...CORS } }); }
    }
    if (req.method === "GET") return new Response("Bizimevler 1 bildirim postacısı çalışıyor ✓ (sürüm 4: mesai, bakım, arıza notu, yedek)", { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
    if (req.method !== "POST") return new Response("", { status: 405, headers: CORS });
    let g; try { g = JSON.parse(await req.text()); } catch (e) { return new Response("{}", { status: 400, headers: CORS }); }
    const tur = String(g.tur || ""), id = String(g.id || "");
    if (tur === "yedekDene") {
      let sa2; try { sa2 = JSON.parse(env.SERVICE_ACCOUNT); } catch (e) { return new Response(JSON.stringify({ hata: "SERVICE_ACCOUNT" }), { status: 500, headers: { "content-type": "application/json", ...CORS } }); }
      const simdi = Date.now();
      if (!(await ilkKezMi(sa2, "yedekDene_" + Math.floor(simdi / 36e5)))) return new Response(JSON.stringify({ atla: "Son 1 saatte denendi" }), { headers: { "content-type": "application/json", ...CORS } });
      try {
        const parcalar = [];
        for (const [k, f] of YEDEK_EKLENEN) parcalar.push([k, await sorguHam(sa2, k, [[f, "GREATER_THAN_OR_EQUAL", simdi - 26 * 36e5]])]);
        for (const x of YEDEK_KUCUK) parcalar.push([kucukAd(x), await sorguHam(sa2, x[0], [], x[1])]);
        const ad = `yedek-deneme-${trGun(simdi)}`, boyut = await yedekGonder(env, sa2, ad, parcalar, "Deneme yedeği (son 26 saat + ayarlar)", simdi);
        await yedekDurumYaz(sa2, { son: simdi, sonAd: ad, sonBoyut: boyut, hata: "" });
        return new Response(JSON.stringify({ ok: true, boyut }), { headers: { "content-type": "application/json", ...CORS } });
      } catch (e) { await yedekDurumYaz(sa2, { hata: String(e.message || e).slice(0, 200), hataTs: simdi }); return new Response(JSON.stringify({ hata: String(e.message || e) }), { status: 500, headers: { "content-type": "application/json", ...CORS } }); }
    }
    if (!/^(gorev|yapildi|ariza|arizaGuncel|vardiya|vardiyaSonuc)$/.test(tur) || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return new Response("{}", { status: 400, headers: CORS });
    let sa; try { sa = JSON.parse(env.SERVICE_ACCOUNT); } catch (e) { return new Response(JSON.stringify({ hata: "SERVICE_ACCOUNT gizli değişkeni eksik" }), { status: 500, headers: CORS }); }
    if (!env.SITE) env = { ...env, SITE: "https://bizimevlerteknikservis.github.io/" };
    try { const s = await isle(env, sa, tur, id); return new Response(JSON.stringify(s), { headers: { "content-type": "application/json", ...CORS } }); }
    catch (e) { return new Response(JSON.stringify({ hata: String(e.message || e) }), { status: 500, headers: { "content-type": "application/json", ...CORS } }); }
  }
};
