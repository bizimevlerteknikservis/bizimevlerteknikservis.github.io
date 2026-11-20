/* Bizimevler 1 · masaüstü kabuğu (≥1100 px)
   Puantaj, Raporlar (BizKontrol), Muhasebe ve Canlı Kontrol sayfalarına ana sayfadaki sol menüyü ve gündüz/gece seçimini getirir.
   Telefonda ve TV/gömülü modda hiçbir şey yapmaz. Rol bilgisini ana sayfa (teknik.html) bu cihaza yazar. */
(function(){
  var H = document.documentElement;
  function rol(){ try { return JSON.parse(localStorage.getItem("bz1-masa-rol") || "null"); } catch(e){ return null; } }
  function gunduz(){ try { return localStorage.getItem("bz1-masa-tema") === "gunduz"; } catch(e){ return false; } }
  var R = rol(), MQ = matchMedia("(min-width:1100px)");
  var gomulu = /[?&]gomulu=1/.test(location.search);
  if (!R || gomulu) return;
  var dosya = (location.pathname.split("/").pop() || "").toLowerCase();
  var kontrol = dosya === "kontrol.html";
  function tema(){
    if (!MQ.matches) return;
    if (kontrol){ try { localStorage.setItem("bz1-tema3", gunduz() ? "acik" : "koyu"); } catch(e){} }
    else H.setAttribute("data-theme", gunduz() ? "light" : "dark");
  }
  tema();
  var IC = {"tutanak": "<path d=\"M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z\"/><path d=\"M14 3v6h6M8 13h8M8 17h5\"/>", "home": "<path d=\"m3 11 9-8 9 8\"/><path d=\"M5 10v10h14V10\"/>", "radar": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"12\" cy=\"12\" r=\"5\"/><circle cx=\"12\" cy=\"12\" r=\"1.4\"/>", "alert": "<path d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\"/><path d=\"M12 9v4M12 17h.01\"/>", "clip": "<rect x=\"5\" y=\"4\" width=\"14\" height=\"17\" rx=\"2\"/><path d=\"M9 4V3h6v1M9 13l2 2 4-4\"/>", "wrench": "<path d=\"M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z\"/>", "shield": "<path d=\"M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z\"/><path d=\"M9 12l2 2 4-4\"/>", "cal": "<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 10h18M8 3v4M16 3v4M8 14h2M12 14h2M16 14h.01M8 17h2M12 17h2\"/>", "izin": "<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4\"/>", "broom": "<path d=\"M15 3 11 11\"/><path d=\"M6 12h10l2 9H4z\"/><path d=\"M9 16v5M12.5 16v5\"/>", "users": "<circle cx=\"9\" cy=\"8\" r=\"3.2\"/><path d=\"M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6\"/><circle cx=\"17\" cy=\"9\" r=\"2.5\"/><path d=\"M16 14.2c2.8.2 5 2.6 5 5.8\"/>", "building": "<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"2\"/><path d=\"M9 21v-4h6v4M8 7h2M14 7h2M8 11h2M14 11h2\"/>", "chart": "<path d=\"M5 20V11M11 20V5M17 20v-7M3 20h18\"/>", "wallet": "<rect x=\"3\" y=\"6\" width=\"18\" height=\"14\" rx=\"3\"/><path d=\"M3 10h18M16 15h2\"/>", "gear": "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1\"/>", "kul": "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8\"/>", "sag": "<path d=\"M5 12h14M13 6l6 6-6 6\"/>"};
  function ic(k){ return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (IC[k] || "") + '</svg>'; }
  var CSS = "\n.yan-menu{display:none}\n@media (min-width:1100px){\nhtml.masa-kabuk:not(.tv) body{padding-left:260px}\nhtml.masa-kabuk:not(.tv) .yan-menu{display:flex}\nhtml.masa-kabuk:not(.tv) .tvakis,html.masa-kabuk:not(.tv) .tvbar{left:276px !important}\nhtml.masa-kabuk[data-theme=\"dark\"]{--bg:#0a1328;--panel:#14223f;--panel2:#0f1b33;--line:rgba(140,170,220,.16);--ink:#e8eef8;--muted:#9db0cb;--accent:#4c9bff}\nhtml.masa-kabuk[data-theme=\"dark\"] body{background:radial-gradient(1200px 600px at 70% -10%,rgba(40,90,170,.20),transparent 60%),linear-gradient(180deg,#0b1730 0%,#081124 100%) fixed}\n.yan-menu{flex-direction:column;position:fixed;inset:0 auto 0 0;width:260px;z-index:60;padding:22px 14px 16px;background:linear-gradient(180deg,rgba(13,26,52,.97),rgba(8,17,36,.99));border-right:1px solid rgba(140,170,220,.13);overflow-y:auto;font-family:\"Inter\",\"Segoe UI\",system-ui,sans-serif;box-sizing:border-box}\n.yan-menu *{box-sizing:border-box}\n.ym-marka{display:flex;align-items:center;gap:12px;padding:4px 10px 18px;color:#8fc3ff;text-decoration:none;border-bottom:1px solid rgba(140,170,220,.13);margin-bottom:12px}\n.ym-marka svg{width:42px;height:42px;flex:none}.ym-marka b{display:block;color:#fff;font:800 19px/1 \"Bricolage Grotesque\",\"Segoe UI\",system-ui,sans-serif;letter-spacing:.02em}\n.ym-marka small{display:block;color:#9db0cb;font-size:12.5px;margin-top:5px}\n.ym-nav{display:grid;gap:2px}\n.ym-nav a{display:flex;align-items:center;gap:13px;padding:6px 12px;border-radius:12px;color:#c9d6ea;text-decoration:none;font:600 15px/1.2 \"Inter\",\"Segoe UI\",system-ui,sans-serif}\n.ym-nav a:hover{background:rgba(120,160,230,.08);color:#fff}\n.ym-nav a[aria-current=\"page\"]{background:linear-gradient(90deg,rgba(60,130,240,.30),rgba(60,130,240,.10));color:#fff;box-shadow:inset 3px 0 0 #4c9bff}\n.ym-ik{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--ic)}\n.ym-ik svg{width:19px;height:19px;stroke:#fff;fill:none;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}\n.ym-ik.mavi{--ic:linear-gradient(140deg,#1d6ff2,#4aa3ff)}.ym-ik.kirmizi{--ic:linear-gradient(140deg,#e7253a,#ff6a6a)}.ym-ik.turuncu{--ic:linear-gradient(140deg,#f2750c,#ffb02e)}\n.ym-ik.mor{--ic:linear-gradient(140deg,#7c3aed,#a78bfa)}.ym-ik.camgobegi{--ic:linear-gradient(140deg,#0e9f9a,#2fd0c3)}.ym-ik.yesil{--ic:linear-gradient(140deg,#12a150,#3ad07a)}\n.ym-ik.lacivert{--ic:linear-gradient(140deg,#1e3a8a,#3b82f6)}.ym-ik.altin{--ic:linear-gradient(140deg,#b7791f,#f2c14e)}.ym-ik.pembe{--ic:linear-gradient(140deg,#9333ea,#e05cd3)}.ym-ik.gri{--ic:linear-gradient(140deg,#475569,#8193ab)}\n.ym-kul{margin-top:auto;display:flex;align-items:center;gap:11px;padding:12px;border-radius:14px;background:rgba(120,160,230,.07);border:1px solid rgba(140,170,220,.13)}\n.ym-av{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(140deg,#1f6fe0,#5aa8ff);flex:none}.ym-av svg{width:22px;height:22px;stroke:#fff;fill:#fff;stroke-width:1.5}\n.ym-kul b{display:block;color:#fff;font:700 15px/1.2 system-ui,sans-serif}.ym-kul small{color:#9db0cb;font-size:12.5px}\n.ym-alt{display:grid;grid-template-columns:1fr 1fr;gap:8px}\n.ym-cikis{margin-top:10px;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 8px;border-radius:12px;border:1px solid rgba(140,170,220,.13);background:transparent;color:#c9d6ea;font:600 14px system-ui,sans-serif;cursor:pointer;text-decoration:none}\n.ym-cikis:hover{background:rgba(76,155,255,.12)}\n.ym-cikis svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}\nhtml.masa-gunduz .yan-menu{background:#fff;border-right-color:#dfe7f1}\nhtml.masa-gunduz .ym-marka{color:#1f6fe0;border-bottom-color:#dfe7f1}html.masa-gunduz .ym-marka b{color:#13243b}html.masa-gunduz .ym-marka small{color:#5d7088}\nhtml.masa-gunduz .ym-nav a{color:#33475f}html.masa-gunduz .ym-nav a:hover{background:#f0f5fc;color:#13243b}\nhtml.masa-gunduz .ym-nav a[aria-current=\"page\"]{background:#e8f1ff;color:#0f3d8a;box-shadow:inset 3px 0 0 #1f6fe0}\nhtml.masa-gunduz .ym-kul{background:#f3f7fb;border-color:#dfe7f1}html.masa-gunduz .ym-kul b{color:#13243b}html.masa-gunduz .ym-kul small{color:#5d7088}\nhtml.masa-gunduz .ym-cikis{color:#33475f;border-color:#dfe7f1}\n@media (max-height:940px){.yan-menu{padding-top:14px}.ym-marka{padding-bottom:12px;margin-bottom:8px}.ym-marka svg{width:36px;height:36px}.ym-nav a{padding:4px 12px;font-size:14.5px}.ym-ik{width:30px;height:30px;border-radius:9px}.ym-ik svg{width:17px;height:17px}.ym-kul{padding:8px 10px}.ym-av{width:34px;height:34px}.ym-cikis{margin-top:8px;padding:8px}}\n}\n";
  function kur(){
    if (document.getElementById("yanMenu")) return;
    var st = document.createElement("style"); st.id = "masaKabukStil"; st.textContent = CSS; document.head.appendChild(st);
    var tech = R.rol === "tech", tesis = R.rol === "tesis";
    var L = function(href, k, ad, renk, aktif){ return '<a href="' + href + '"' + (aktif ? ' aria-current="page"' : '') + '><i class="ym-ik ' + renk + '">' + ic(k) + '</i><span>' + ad + '</span></a>'; };
    var T = "teknik.html";
    var html = '<a class="ym-marka" href="' + T + '#panel"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M5 35V19h7v16M14 35V9h9v26M25 35V15h8v20M3 35h34" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M17 13h3M17 17h3M17 21h3M17 25h3M27 19h2M27 23h2M27 27h2M7 23h2M7 27h2" stroke="currentColor" stroke-width="1.8"/></svg><span><b>BİZİMEVLER 1</b><small>Site Yönetim Sistemi</small></span></a>'
      + '<nav class="ym-nav">'
      + L(T + "#panel", "home", "Ana Sayfa", "mavi")
      + L("kontrol.html", "radar", "Canlı Kontrol", "pembe", kontrol)
      + (tech ? L(T + "#panel", "alert", "Arıza Listesi", "kirmizi") : L(T + "#personel", "alert", "Arıza Bildir", "kirmizi"))
      + (tech ? L(T + "#personel", "clip", "Personel Bildirimi", "turuncu") : "")
      + L(T + "#tesis", "wrench", tech || tesis ? "Tesis &amp; Bakım" : "Asansör Takip", "turuncu")
      + L(T + "#devriye", "shield", "Devriye", "mavi")
      + L(T + "#gorev", "clip", "Görev Ver", "camgobegi")
      + L("puantaj.html", "cal", "Puantaj", "mor", dosya === "puantaj.html")
      + L(T + "#izinler", "izin", "İzinler", "mor")
      + L(T + "#tutanak", "tutanak", "Olay Tutanağı", "kirmizi")
      + (tech || tesis ? L(T + "#calisma", "broom", "Temizlik", "yesil") : "")
      + L(T + "#ik", "users", "Personel İşleri", "mor")
      + L(T + "#tasinma", "building", "Taşınma &amp; Tadilat", "lacivert")
      + L("bizkontrol.html", "chart", "Raporlar", "lacivert", dosya === "bizkontrol.html")
      + (tech ? L("muhasebe.html", "wallet", "Muhasebe", "altin", dosya === "muhasebe.html") : "")
      + L(T + "#panel", "gear", "Ayarlar", "gri")
      + '</nav>'
      + '<div class="ym-kul"><span class="ym-av">' + ic("kul") + '</span><div><b>' + String(R.ad || "").replace(/[<>&"]/g, "") + '</b><small>' + (tech ? "Teknisyen" : tesis ? "Tesis yetkilisi" : "Yönetim · Amir") + '</small></div></div>'
      + '<div class="ym-alt"><button type="button" class="ym-cikis" id="ymTema"></button><a class="ym-cikis" href="' + T + '#panel">' + ic("home") + '<span>Ana sayfa</span></a></div>';
    var a = document.createElement("aside"); a.id = "yanMenu"; a.className = "yan-menu"; a.setAttribute("aria-label", "Yönetim menüsü"); a.innerHTML = html;
    document.body.insertBefore(a, document.body.firstChild);
    H.classList.add("masa-kabuk");
    var tb = document.getElementById("ymTema");
    var ciz = function(){ tb.innerHTML = gunduz() ? '<svg viewBox="0 0 24 24"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg><span>Gece</span>' : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><span>Gündüz</span>'; H.classList.toggle("masa-gunduz", gunduz()); };
    ciz();
    tb.onclick = function(){
      try { localStorage.setItem("bz1-masa-tema", gunduz() ? "gece" : "gunduz"); } catch(e){}
      ciz();
      if (kontrol){ try { localStorage.setItem("bz1-tema3", gunduz() ? "acik" : "koyu"); } catch(e){} var b = document.getElementById("temaBtn"); if (b && ((H.getAttribute("data-tema") === "koyu") === gunduz())) b.click(); }
      else H.setAttribute("data-theme", gunduz() ? "light" : "dark");
    };
    /* Sayfanın kendi ☀/🌙 düğmesi de aynı seçimi değiştirsin */
    var pb = document.getElementById("temaBtn");
    if (pb && !kontrol) pb.addEventListener("click", function(e){ if (!MQ.matches) return; e.stopImmediatePropagation(); tb.onclick(); }, true);
    if (pb && kontrol) pb.addEventListener("click", function(){ if (!MQ.matches) return; setTimeout(function(){ var k = H.getAttribute("data-tema") === "koyu"; try { localStorage.setItem("bz1-masa-tema", k ? "gece" : "gunduz"); } catch(e){} ciz(); }, 0); });
  }
  function bak(){ if (MQ.matches){ tema(); kur(); H.classList.add("masa-kabuk"); } else H.classList.remove("masa-kabuk"); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bak); else bak();
  try { MQ.addEventListener("change", bak); } catch(e){}
})();
