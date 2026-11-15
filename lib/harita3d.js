/* =====================================================================
   Bizimevler 1 · 3D ARIZA HARİTASI (Kontrol Merkezi)
   İki zemin:
   📷 Fotoğraf: mevcut hava fotoğrafı (harita-hd.jpg), 2D haritayla aynı 1063×661 koordinatlar.
      2D etiketleri fotoğrafta kulelerin ÇATISINDADIR; fotoğraf eğik olduğu için çatı tabandan yukarıda
      görünür. 3D bina tabana oturtulur: taban = tabanBul(çatı) (22 kulenin fotoğraf ölçümünden).
   🛰️ Uydu: sitenin koordinatı (41.062055, 28.703734) çevresindeki tepeden uydu görüntüsü (Esri World
      Imagery) + OpenStreetMap bina tabanları (gerçek şekil ve kat bilgisiyle yükseltilir).
      Hangi binanın hangi blok olduğu bir kez "Blokları eşleştir" ile işaretlenir; Firestore
      duyuru/harita3d belgesinde saklanır, her cihazda aynı görünür.
   Arıza renkleri ve sayıları 2D ile aynı kural (ARZ.list). Sadece gerektiğinde çizer.
   ===================================================================== */
(function(){
const G3_ZS = 1.5;                         // fotoğraf zemini: derinlik yönünde basıklık düzeltmesi
const G3_H = 175, G3_W = 60, G3_D = 52;    // fotoğraf zemininde kule ölçüleri (fotoğraf pikseli)
const MERKEZ = {lat:41.062055, lng:28.703734};
const U = 2;                               // uydu zemini: 1 metre = 2 birim (fotoğraf sahnesiyle benzer ölçek)
const KULE_M = 52;                         // OSM'de kat bilgisi olmayan blok kulesi yüksekliği (m)
const TZ = 18, TN = 8;                     // uydu karoları: yakınlaştırma 18, 8×8 karo (~920 m)
const KARO = (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const OVERPASS = "https://overpass-api.de/api/interpreter";
const RENK = {bos:0xf3f5f8, digerBina:0xb7c0ca, bad:0xff8a80, warn:0xffc77a, ok:0x9fdcb0};

function tabanBul(cx, cy){ return [cx - 0.07*(cx - 531), Math.min(PH - 6, cy + 87 + 0.23*cy - 12)]; }
const fx = x => x - PW/2, fz = y => (y - PH/2) * G3_ZS;
const kos = Math.cos(MERKEZ.lat*Math.PI/180);
const mx = lng => (lng - MERKEZ.lng) * kos * 111320 * U;
const mz = lat => -(lat - MERKEZ.lat) * 110540 * U;
const gLng = x => MERKEZ.lng + x / (kos*111320*U);
const gLat = z => MERKEZ.lat - z / (110540*U);
const lon2t = (l, z) => (l + 180) / 360 * 2**z;
const lat2t = (a, z) => { const r = a*Math.PI/180; return (1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2 * 2**z; };
const t2lon = (x, z) => x / 2**z * 360 - 180;
const t2lat = (y, z) => { const n = Math.PI - 2*Math.PI*y / 2**z; return 180/Math.PI * Math.atan(0.5*(Math.exp(n) - Math.exp(-n))); };
const yazabilir = () => !window.FB_CONFIG || window.ROL === "teknisyen";

Object.assign(G3, {r:null, sahne:null, kamera:null, kontrol:null, kok:null, binalar:{}, etiket:{}, tepe:{}, alanlar:[], hedef:[], ciz:false,
  zemin:null, kurulu:null, uydu:{karo:null, osm:null, yer:{}, yerGeldi:false, hata:"", yukleniyor:null}, esle:null});
try { G3.zemin = localStorage.getItem("bz1-3dzemin"); } catch(e){}

window.g3Kur = async function(){
  const kap = $("#map3d");
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  const r = new THREE.WebGLRenderer({antialias: dpr < 1.5, alpha:false});
  r.setPixelRatio(dpr); r.outputEncoding = THREE.sRGBEncoding;
  kap.insertBefore(r.domElement, kap.firstChild);
  const sahne = new THREE.Scene(); sahne.background = new THREE.Color(0x0e1a28); sahne.fog = new THREE.Fog(0x0e1a28, 1500, 2800);
  const kamera = new THREE.PerspectiveCamera(42, 1, 5, 6000);
  sahne.add(new THREE.HemisphereLight(0xffffff, 0x51606f, 0.85));
  const gun = new THREE.DirectionalLight(0xffffff, 0.75); gun.position.set(-500, 900, 600); sahne.add(gun);
  const kok = new THREE.Group(); sahne.add(kok);
  const kont = new THREE.OrbitControls(kamera, r.domElement);
  kont.enableDamping = true; kont.dampingFactor = 0.12; kont.screenSpacePanning = false;
  kont.minDistance = 160; kont.maxDistance = 1900; kont.maxPolarAngle = Math.PI*0.44; kont.minPolarAngle = 0.05;
  kont.addEventListener("change", g3Istek);
  kont.addEventListener("start", () => $("#g3ipucu").classList.add("gizle"));
  Object.assign(G3, {r, sahne, kamera, kontrol:kont, kok});
  // araç çubuğu: zemin seçimi, eşleştirme, atıf
  const arac = document.createElement("div"); arac.className = "g3arac"; arac.id = "g3arac";
  arac.innerHTML = `<div class="g3seg"><button data-zemin="foto">📷 Fotoğraf</button><button data-zemin="uydu">🛰️ Uydu</button></div><button class="g3esleBtn" id="g3esleBtn" hidden>📍 Blokları eşleştir</button>`;
  kap.appendChild(arac);
  const atif = document.createElement("div"); atif.className = "g3atif"; atif.id = "g3atif"; kap.appendChild(atif);
  const esle = document.createElement("div"); esle.className = "g3esle"; esle.id = "g3esle"; esle.hidden = true; kap.appendChild(esle);
  const alanL = document.createElement("div"); alanL.className = "g3alanl"; alanL.id = "g3alanl"; kap.appendChild(alanL);
  arac.addEventListener("click", e => {
    const z = e.target.closest("[data-zemin]"); if (z){ G3.zemin = z.dataset.zemin; try { localStorage.setItem("bz1-3dzemin", G3.zemin); } catch(_){} g3Goster(); return; }
    if (e.target.closest("#g3esleBtn")) esleBasla();
  });
  esle.addEventListener("click", e => { const b = e.target.closest("[data-esle]"); if (b) esleKomut(b.dataset.esle); });
  alanL.addEventListener("click", e => { const b = e.target.closest("[data-alan]"); if (b) blokDetay(null, b.dataset.alan); });
  $("#g3et").addEventListener("click", e => { const t = e.target.closest(".g3e"); if (!t) return; if (G3.esle) return; if (t.dataset.blok) blokDetay(t.dataset.blok); else if (t.dataset.alan) blokDetay(null, t.dataset.alan); });
  new ResizeObserver(g3Boyut).observe(kap);
  let bas = null;
  r.domElement.addEventListener("pointerdown", e => { bas = {x:e.clientX, y:e.clientY, t:Date.now()}; });
  r.domElement.addEventListener("pointerup", e => {
    if (!bas || Math.hypot(e.clientX - bas.x, e.clientY - bas.y) > 8 || Date.now() - bas.t > 700) return;
    const hit = isinla(e);
    if (G3.esle){ esleDokun(hit); return; }
    const id = hit && hit.object.userData.blok; if (id) blokDetay(id); else blokDetayKapat();
  });
  r.domElement.addEventListener("dblclick", kameraSifirla);
  document.addEventListener("visibilitychange", g3Istek);
  // eşleştirmeler (bulut ya da bu cihaz)
  if (window.G3_DB) G3_DB.dinle(v => { G3.uydu.yer = (v && v.bloklar) || {}; G3.uydu.yerGeldi = true; if (G3.kurulu === "uydu" && !G3.esle) uyduAta(); aracCiz(); });
  else { try { G3.uydu.yer = JSON.parse(localStorage.getItem("bz1-harita3d") || "{}"); } catch(_){ G3.uydu.yer = {}; } G3.uydu.yerGeldi = true; }
};

/* Seçili zemini kur (gerekirse) ve göster */
window.g3Goster = async function(){
  if (!G3.r) return;
  const yerSay = Object.keys(G3.uydu.yer || {}).length;
  if (!G3.zemin) G3.zemin = yerSay ? "uydu" : (yazabilir() ? "uydu" : "foto");
  aracCiz();
  if (G3.zemin === "uydu"){
    if (G3.kurulu !== "uydu"){ $("#g3yuk").hidden = false; $("#g3yuk").textContent = "Uydu görüntüsü yükleniyor…";
      try { await uyduKur(); } catch(e){ console.error(e); $("#g3yuk").textContent = "Uydu görüntüsü alınamadı (" + (e.message || "bağlantı") + "). Fotoğraf zeminine dönülüyor."; await new Promise(r => setTimeout(r, 2000)); G3.zemin = "foto"; aracCiz(); fotoKur(); }
      $("#g3yuk").hidden = true; }
  } else if (G3.kurulu !== "foto") fotoKur();
  else fotoYerlestir();
  g3Boyut(); G3.guncelle();
};
function aracCiz(){
  const a = $("#g3arac"); if (!a) return;
  a.querySelectorAll("[data-zemin]").forEach(b => b.setAttribute("aria-pressed", b.dataset.zemin === G3.zemin));
  const eb = $("#g3esleBtn"); eb.hidden = !(G3.zemin === "uydu" && yazabilir() && G3.kurulu === "uydu");
  const n = Object.keys(G3.uydu.yer || {}).filter(k => B[k]).length;
  eb.textContent = n ? `📍 Eşleştirme (${n}/${BLOK.length})` : "📍 Blokları eşleştir";
  $("#g3atif").innerHTML = G3.zemin === "uydu" ? "Uydu: Esri, Maxar, Earthstar · Binalar: © OpenStreetMap" : "";
}

/* ---------------- ortak temizlik ---------------- */
function temizle(){
  G3.kok.traverse(o => { if (o.geometry && !o.geometry.ortak) o.geometry.dispose(); if (o.material && !o.material.ortak){ if (o.material.map && !o.material.map.ortak) o.material.map.dispose(); o.material.dispose(); } });
  G3.kok.clear ? G3.kok.clear() : G3.kok.children.slice().forEach(c => G3.kok.remove(c));
  $("#g3et").innerHTML = ""; G3.binalar = {}; G3.etiket = {}; G3.tepe = {}; G3.alanlar = []; G3.hedef = [];
}
function etiketYap(id){ const e = document.createElement("div"); e.className = "g3e"; e.innerHTML = `<i hidden></i><b>${esc(id)}</b>`; e.dataset.blok = id; $("#g3et").appendChild(e); G3.etiket[id] = e; return e; }

/* ---------------- 📷 fotoğraf zemini ---------------- */
let FOTO_TEX = null, GOV = null, CAT = null;
function fotoKur(){
  temizle(); G3.kurulu = "foto";
  if (!FOTO_TEX){ FOTO_TEX = new THREE.TextureLoader().load(FOTO, g3Istek); FOTO_TEX.encoding = THREE.sRGBEncoding; FOTO_TEX.anisotropy = Math.min(4, G3.r.capabilities.getMaxAnisotropy()); FOTO_TEX.ortak = true; }
  const zemin = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH*G3_ZS), new THREE.MeshBasicMaterial({map:FOTO_TEX})); zemin.rotation.x = -Math.PI/2; zemin.userData.zemin = true; G3.kok.add(zemin); G3.zeminM = zemin;
  const kenar = new THREE.Mesh(new THREE.PlaneGeometry(PW*4, PH*G3_ZS*4), new THREE.MeshBasicMaterial({color:0x2c4a2e})); kenar.rotation.x = -Math.PI/2; kenar.position.y = -0.6; G3.kok.add(kenar);
  if (!GOV){ GOV = new THREE.BoxGeometry(G3_W, G3_H, G3_D); GOV.translate(0, G3_H/2, 0); GOV.ortak = true; CAT = new THREE.BoxGeometry(G3_W + 4, 5, G3_D + 4); CAT.translate(0, G3_H + 2.5, 0); CAT.ortak = true; }
  BLOK.forEach(b => {
    const govM = new THREE.MeshLambertMaterial({color:RENK.bos}), catM = new THREE.MeshLambertMaterial({color:0x9aa7b5});
    const g = new THREE.Group(); const m1 = new THREE.Mesh(GOV, govM), m2 = new THREE.Mesh(CAT, catM); m1.userData.blok = m2.userData.blok = b.id; g.add(m1, m2);
    G3.kok.add(g); G3.binalar[b.id] = {g, govM, catM}; G3.hedef.push(m1, m2); etiketYap(b.id);
  });
  fotoYerlestir(); kameraSifirla();
}
function fotoYerlestir(){
  if (G3.kurulu !== "foto") return;
  BLOK.forEach(b => { const o = G3.binalar[b.id]; if (!o) return; const [cx, cy] = ctr(b), [tx, ty] = tabanBul(cx, cy); o.g.position.set(fx(tx), 0, fz(ty)); G3.tepe[b.id] = new THREE.Vector3(fx(tx), G3_H + 10, fz(ty)); });
  g3Istek();
}

/* ---------------- 🛰️ uydu zemini ---------------- */
async function karoYukle(){
  if (G3.uydu.karo) return G3.uydu.karo;
  const xt = lon2t(MERKEZ.lng, TZ), yt = lat2t(MERKEZ.lat, TZ), x0 = Math.floor(xt) - TN/2 + 1, y0 = Math.floor(yt) - TN/2 + 1;
  const cv = document.createElement("canvas"); cv.width = cv.height = TN*256; const cx = cv.getContext("2d");
  cx.fillStyle = "#3a4a3a"; cx.fillRect(0, 0, cv.width, cv.height);
  let ok = 0;
  await Promise.all(Array.from({length:TN*TN}, (_, i) => new Promise(res => {
    const dx = i % TN, dy = Math.floor(i / TN), im = new Image(); im.crossOrigin = "anonymous";
    im.onload = () => { cx.drawImage(im, dx*256, dy*256); ok++; res(); }; im.onerror = () => res();
    im.src = KARO(TZ, y0 + dy, x0 + dx);
  })));
  if (ok < TN*TN/2) throw new Error(ok ? "eksik karo" : "uydu sunucusuna ulaşılamadı");
  const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = Math.min(4, G3.r.capabilities.getMaxAnisotropy()); tex.ortak = true;
  const sol = mx(t2lon(x0, TZ)), sag = mx(t2lon(x0 + TN, TZ)), ust = mz(t2lat(y0, TZ)), alt = mz(t2lat(y0 + TN, TZ));
  return (G3.uydu.karo = {tex, sol, sag, ust, alt});
}
async function osmYukle(){
  if (G3.uydu.osm) return G3.uydu.osm;
  try { const c = JSON.parse(localStorage.getItem("bz1-osm-v1") || "null"); if (c && Date.now() - c.ts < 30*864e5) return (G3.uydu.osm = c.b); } catch(_){}
  const q = `[out:json][timeout:25];(way["building"](around:520,${MERKEZ.lat},${MERKEZ.lng}););out geom tags;`;
  let L = [];
  try {
    const res = await fetch(OVERPASS + "?data=" + encodeURIComponent(q)); if (!res.ok) throw new Error("osm " + res.status);
    const j = await res.json();
    L = (j.elements || []).filter(e => e.type === "way" && e.geometry && e.geometry.length > 3).map(e => {
      const t = e.tags || {}, h = parseFloat(t.height) || (parseFloat(t["building:levels"]) ? parseFloat(t["building:levels"])*3.1 + 2 : 0);
      return {id:e.id, p:e.geometry.map(g => [+g.lat.toFixed(7), +g.lon.toFixed(7)]), h, ad:t.name || t["addr:housename"] || ""};
    });
    try { localStorage.setItem("bz1-osm-v1", JSON.stringify({ts:Date.now(), b:L})); } catch(_){}
  } catch(e){ console.warn("OSM binaları alınamadı", e); G3.uydu.hata = "osm"; }
  return (G3.uydu.osm = L);
}
const merkezOf = p => { let a = 0, x = 0, z = 0; for (let i = 0; i < p.length - 1; i++){ const [x1, z1] = p[i], [x2, z2] = p[i+1], c = x1*z2 - x2*z1; a += c; x += (x1 + x2)*c; z += (z1 + z2)*c; } a /= 2; return Math.abs(a) < 1e-6 ? p[0] : [x/(6*a), z/(6*a)]; };
async function uyduKur(){
  const [k, osm] = await Promise.all([karoYukle(), osmYukle()]);
  temizle(); G3.kurulu = "uydu";
  const zm = new THREE.Mesh(new THREE.PlaneGeometry(k.sag - k.sol, k.alt - k.ust), new THREE.MeshBasicMaterial({map:k.tex}));
  zm.rotation.x = -Math.PI/2; zm.position.set((k.sol + k.sag)/2, 0, (k.ust + k.alt)/2); zm.userData.zemin = true; G3.kok.add(zm); G3.zeminM = zm; G3.hedef.push(zm);
  // OSM binaları: taban şekli → yükseltme (yükseklik mesh.scale.y ile ayarlanır)
  G3.uydu.mesh = {};
  const ortakM = new THREE.MeshLambertMaterial({color:RENK.digerBina});
  osm.forEach(o => {
    const pts = o.p.map(([la, lo]) => [mx(lo), mz(la)]);
    const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(sh, {depth:1, bevelEnabled:false}); geo.rotateX(-Math.PI/2);
    const m = new THREE.Mesh(geo, ortakM); m.userData.osm = o.id; m.userData.h = o.h; m.scale.y = Math.max(4, (o.h || 7)) * U;
    const [cx, cz] = merkezOf(pts); m.userData.mrk = [cx, cz];
    G3.kok.add(m); G3.hedef.push(m); G3.uydu.mesh[o.id] = m;
  });
  G3.uydu.ortakM = ortakM;
  G3.uydu.kutular = new THREE.Group(); G3.kok.add(G3.uydu.kutular);
  uyduAta(); kameraSifirla();
  if (G3.uydu.hata === "osm" && !osm.length) bilgi("Bina tabanları (OpenStreetMap) alınamadı; eşleştirmede binaya değil zemindeki yerine dokunun, kule kutusu konur.");
}
/* Blok eşleştirmelerini uygula: eşleşen OSM binası blok olur (renk + etiket), OSM yoksa noktaya kule kutusu */
function uyduAta(){
  if (G3.kurulu !== "uydu") return;
  const yer = G3.uydu.yer || {};
  Object.values(G3.uydu.mesh || {}).forEach(m => { if (m.userData.blok){ m.material.dispose(); m.material = G3.uydu.ortakM; delete m.userData.blok; m.scale.y = Math.max(4, (m.userData.h || 7)) * U; } });
  G3.uydu.kutular.children.slice().forEach(c => { G3.uydu.kutular.remove(c); c.geometry.dispose(); c.material.dispose(); G3.hedef = G3.hedef.filter(h => h !== c); });
  $("#g3et").innerHTML = ""; G3.binalar = {}; G3.etiket = {}; G3.tepe = {};
  BLOK.forEach(b => {
    const y = yer[b.id]; if (!y) return;
    const govM = new THREE.MeshLambertMaterial({color:RENK.bos}); let h;
    const m = y.osm != null && G3.uydu.mesh[y.osm];
    if (m){ m.material = govM; m.userData.blok = b.id; h = (m.userData.h || KULE_M) * U; m.scale.y = h; const [cx, cz] = m.userData.mrk; G3.tepe[b.id] = new THREE.Vector3(cx, h + 10, cz); }
    else { h = KULE_M * U; const g = new THREE.BoxGeometry(24*U, h, 24*U); g.translate(0, h/2, 0); const k = new THREE.Mesh(g, govM); k.position.set(mx(y.lng), 0, mz(y.lat)); k.userData.blok = b.id; G3.uydu.kutular.add(k); G3.hedef.push(k); G3.tepe[b.id] = new THREE.Vector3(k.position.x, h + 10, k.position.z); }
    G3.binalar[b.id] = {govM, catM:null}; etiketYap(b.id);
  });
  G3.guncelle(); aracCiz();
}

/* ---------------- 📍 eşleştirme (bir kez, teknisyen) ---------------- */
function esleBasla(){ G3.uydu.yerYedek = JSON.parse(JSON.stringify(G3.uydu.yer || {})); G3.esle = {i:0, yer:JSON.parse(JSON.stringify(G3.uydu.yer || {}))}; blokDetayKapat(); esleCiz(); }
function esleCiz(){
  const e = $("#g3esle"), s = G3.esle; if (!s){ e.hidden = true; return; }
  const b = BLOK[s.i], var_ = s.yer[b.id];
  e.hidden = false;
  const [bx, by] = ctr(b);
  e.innerHTML = `<div class="g3esle-ip" title="Fotoğrafta ${esc(b.id)}" style="background-image:url(${FOTO})"><i style="left:${(bx/PW*100).toFixed(1)}%;top:${(by/PH*100).toFixed(1)}%"></i></div><div><small>${s.i + 1} / ${BLOK.length}</small><b>${esc(b.id)}</b> bloğu hangisi? Uydu görüntüsünde o binaya dokunun.${var_ ? " <em>(şu an işaretli — dokunursanız değişir, Atla ile korunur)</em>" : ""}</div>
    <div class="g3esle-b"><button data-esle="geri"${s.i ? "" : " disabled"}>‹ Geri</button><button data-esle="atla">Atla ›</button>${var_ ? `<button data-esle="sil">Kaldır</button>` : ""}<button data-esle="bitti" class="ana">Kaydet ve bitir</button><button data-esle="vazgec">Vazgeç</button></div>`;
  // seçili bloğu ve eşleşenleri göster
  Object.values(G3.uydu.mesh || {}).forEach(m => { if (!m.userData.blok) m.material = G3.uydu.ortakM; });
  g3Istek();
}
function esleDokun(hit){
  const s = G3.esle; if (!s || !hit) return;
  const b = BLOK[s.i], o = hit.object;
  let v;
  if (o.userData.osm != null){ const [cx, cz] = o.userData.mrk; v = {osm:o.userData.osm, lat:+gLat(cz).toFixed(7), lng:+gLng(cx).toFixed(7)}; }
  else { const p = hit.point; v = {lat:+gLat(p.z).toFixed(7), lng:+gLng(p.x).toFixed(7)}; }
  Object.keys(s.yer).forEach(k => { if (k !== b.id && v.osm != null && s.yer[k].osm === v.osm) delete s.yer[k]; });   // aynı bina iki bloğa verilemez
  s.yer[b.id] = v; G3.uydu.yer = s.yer; uyduAta();
  ticker(`📍 ${b.id} işaretlendi`);
  if (s.i < BLOK.length - 1){ s.i++; esleCiz(); } else esleKomut("bitti");
}
async function esleKomut(k){
  const s = G3.esle; if (!s) return;
  if (k === "geri"){ s.i = Math.max(0, s.i - 1); esleCiz(); }
  else if (k === "atla"){ if (s.i < BLOK.length - 1){ s.i++; esleCiz(); } else esleKomut("bitti"); }
  else if (k === "sil"){ delete s.yer[BLOK[s.i].id]; G3.uydu.yer = s.yer; uyduAta(); esleCiz(); }
  else if (k === "vazgec"){ G3.esle = null; esleCiz(); G3.uydu.yer = G3.uydu.yerYedek || G3.uydu.yer; uyduAta(); }
  else if (k === "bitti"){
    G3.esle = null; esleCiz(); G3.uydu.yer = s.yer; uyduAta();
    try {
      if (window.G3_DB) await G3_DB.yaz({bloklar:s.yer, ts:Date.now()});
      else localStorage.setItem("bz1-harita3d", JSON.stringify(s.yer));
      ticker(`✓ Blok eşleştirmesi kaydedildi (${Object.keys(s.yer).length}/${BLOK.length}) · her cihazda aynı görünür`);
    } catch(e){ console.error(e); ticker("⚠️ Eşleştirme kaydedilemedi: " + (e.code || e.message)); }
  }
}
function bilgi(m, basla){ const e = $("#g3esle"); if (G3.esle) return; e.hidden = false;
  e.innerHTML = `<div>${esc(m)}</div><div class="g3esle-b">${basla ? `<button data-bilgi-basla class="ana">📍 Eşleştirmeye başla</button>` : ""}<button data-esle-kapat>${basla ? "Sonra" : "Tamam"}</button></div>`;
  e.querySelector("[data-esle-kapat]").onclick = () => { e.hidden = true; };
  const b = e.querySelector("[data-bilgi-basla]"); if (b) b.onclick = esleBasla; }

/* ---------------- ortak: renk, etiket, kamera, çizim ---------------- */
function durumlar(){
  const grup = {};
  ARZ.list.forEach(a => { if (a.s==="bitti" && Date.now() - (a.bitis||0) > 60*6e4) return; const key = B[a.b] ? a.b : "alan:" + (a.alan || "Diğer"); (grup[key] ||= []).push(a); });
  return grup;
}
G3.guncelle = function(){
  if (!G3.r) return;
  const grup = durumlar(), renk = {bad:cssv("--bad"), warn:cssv("--warn"), ok:cssv("--ok")};
  Object.entries(G3.binalar).forEach(([id, o]) => {
    const e = G3.etiket[id], arr = grup[id], i = e && e.querySelector("i");
    if (!arr){ o.govM.color.set(RENK.bos); if (o.catM) o.catM.color.set(0x9aa7b5); if (i) i.hidden = true; return; }
    const d = arr.some(a=>a.s==="yeni") ? "bad" : arr.some(a=>a.s==="isleniyor") ? "warn" : "ok";
    if (o.catM){ o.catM.color.set(renk[d]); o.govM.color.set(d==="bad" ? 0xffe1df : d==="warn" ? 0xffefd6 : 0xe2f6e9); }
    else o.govM.color.set(RENK[d]);
    if (i){ i.hidden = false; i.className = d; i.textContent = d==="ok" ? "✓" : arr.filter(a=>a.s!=="bitti").length; }
  });
  // ortak alan bildirimleri: fotoğraf zemininde iğne, uydu zemininde liste
  G3.alanlar.forEach(x => x.e.remove()); G3.alanlar = [];
  const alanlar = Object.entries(grup).filter(([k]) => k.startsWith("alan:"));
  const dOf = arr => arr.some(a=>a.s==="yeni") ? "bad" : arr.some(a=>a.s==="isleniyor") ? "warn" : "ok";
  const alanL = $("#g3alanl");
  if (G3.kurulu === "foto"){
    alanL.innerHTML = "";
    alanlar.forEach(([k, arr]) => { const ad = k.slice(5), [x, y] = ALAN_POS[ad] || ALAN_POS["Diğer"], d = dOf(arr);
      const e = document.createElement("div"); e.className = "g3e alan"; e.dataset.alan = ad; e.innerHTML = `<i class="${d}">${d==="ok" ? "✓" : arr.filter(a=>a.s!=="bitti").length}</i><b>${esc(ad)}</b>`;
      $("#g3et").appendChild(e); G3.alanlar.push({e, p:new THREE.Vector3(fx(x), 4, fz(y))}); });
  } else {
    alanL.innerHTML = alanlar.map(([k, arr]) => { const d = dOf(arr); return `<button data-alan="${esc(k.slice(5))}"><i class="${d}"></i>${esc(k.slice(5))} · ${d==="ok" ? "✓" : arr.filter(a=>a.s!=="bitti").length}</button>`; }).join("");
  }
  if (G3.kurulu === "uydu" && !Object.keys(G3.binalar).length && !G3.esle && !G3.bilgiOldu){ G3.bilgiOldu = true;
    if (yazabilir()) bilgi("Uydu görüntüsü hazır. Arızaların binalarda görünmesi için bir kez her bloğun binasına dokunarak eşleştirin (22 dokunuş, bir kez yapılır).", true);
    else bilgi("Bloklar uydu görüntüsünde henüz eşleştirilmedi. Fotoğraf zeminini kullanabilirsiniz.");
  }
  const koyu = typeof koyuMu === "function" && koyuMu();
  if (G3.zeminM) G3.zeminM.material.color.set(koyu ? 0x8f9aa8 : 0xffffff);
  g3Istek();
};
function kameraSifirla(){
  if (!G3.kamera) return;
  const k = Math.max(1, 1.65 / (G3.kamera.aspect || 1.6));
  if (G3.kurulu === "uydu"){
    // eşleşen blokların ortasına bak
    const T = Object.values(G3.tepe); const c = T.length ? T.reduce((a, v) => a.add(new THREE.Vector3(v.x, 0, v.z)), new THREE.Vector3()).multiplyScalar(1/T.length) : new THREE.Vector3();
    G3.kontrol.target.set(c.x, 0, c.z); G3.kamera.position.set(c.x, 820*k, c.z + 560*k);
  } else { G3.kontrol.target.set(0, 0, 40); G3.kamera.position.set(0, 760*k, 40 + 660*k); }
  G3.kontrol.update(); g3Istek();
}
function g3Boyut(){
  const kap = $("#map3d"), w = kap.clientWidth, h = kap.clientHeight; if (!w || !h || !G3.r) return;
  const ilk = !G3.boyutTamam; G3.boyutTamam = true;
  G3.r.setSize(w, h, false); G3.kamera.aspect = w / h; G3.kamera.updateProjectionMatrix();
  if (ilk) kameraSifirla(); g3Istek();
}
function isinla(e){
  const rc = G3.r.domElement.getBoundingClientRect(), v = new THREE.Vector2(((e.clientX - rc.left)/rc.width)*2 - 1, -((e.clientY - rc.top)/rc.height)*2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(v, G3.kamera);
  const hits = ray.intersectObjects(G3.hedef);
  return hits.find(h => h.object.userData.blok || h.object.userData.osm != null) || hits[0] || null;
}
function g3Istek(){ if (!G3.acik || G3.ciz) return; G3.ciz = true; requestAnimationFrame(kare); }
window.g3Istek = g3Istek;
function kare(){
  G3.ciz = false; if (!G3.acik || document.hidden || !G3.r) return;
  const hareket = G3.kontrol.update();
  G3.r.render(G3.sahne, G3.kamera);
  const w = G3.r.domElement.clientWidth, h = G3.r.domElement.clientHeight, v = new THREE.Vector3();
  const yaz = (e, p) => { if (!e || !p) return; v.copy(p).project(G3.kamera); const gor = v.z < 1 && v.x > -1.2 && v.x < 1.2 && v.y > -1.2 && v.y < 1.3;
    e.classList.toggle("uzak", !gor); if (gor) e.style.transform = `translate(${((v.x+1)/2*w).toFixed(1)}px,${((1-v.y)/2*h).toFixed(1)}px) translate(-50%,-100%)`; };
  Object.keys(G3.etiket).forEach(id => yaz(G3.etiket[id], G3.tepe[id]));
  G3.alanlar.forEach(x => yaz(x.e, x.p));
  if (hareket) g3Istek();
}
})();
