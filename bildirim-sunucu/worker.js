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
  return { atla: "bilinmeyen tür" };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method === "GET") return new Response("Bizimevler 1 bildirim postacısı çalışıyor ✓", { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });
    if (req.method !== "POST") return new Response("", { status: 405, headers: CORS });
    let g; try { g = JSON.parse(await req.text()); } catch (e) { return new Response("{}", { status: 400, headers: CORS }); }
    const tur = String(g.tur || ""), id = String(g.id || "");
    if (!/^(gorev|yapildi|ariza)$/.test(tur) || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return new Response("{}", { status: 400, headers: CORS });
    let sa; try { sa = JSON.parse(env.SERVICE_ACCOUNT); } catch (e) { return new Response(JSON.stringify({ hata: "SERVICE_ACCOUNT gizli değişkeni eksik" }), { status: 500, headers: CORS }); }
    if (!env.SITE) env = { ...env, SITE: "https://bizimevlerteknikservis.github.io/" };
    try { const s = await isle(env, sa, tur, id); return new Response(JSON.stringify(s), { headers: { "content-type": "application/json", ...CORS } }); }
    catch (e) { return new Response(JSON.stringify({ hata: String(e.message || e) }), { status: 500, headers: { "content-type": "application/json", ...CORS } }); }
  }
};
