/* =====================================================================
   Bizimevler 1 · Halı saha ışıkları kartı (WT32-ETH01)
   - Ethernet ile -1'deki switch'e bağlanır (Wi-Fi kullanmaz)
   - Firebase Realtime Database'i canlı dinler: telefondan "aç/kapat" anında gelir
   - Otomatik program (hafta içi / hafta sonu saatleri) kartın içinde çalışır;
     internet giderse de son bilinen programla devam eder
   - Röle IO4: kontaktör bobinini (A1) sürer
   - Durumunu ve geçmişi sisteme yazar; güncellemeler internetten gelir

   İlk kurulumda seri porttan bir kez ayar gönderilir (kurulum sayfası yapar):
     AYAR {"email":"...","sifre":"...","db":"xxx.firebasedatabase.app","cihaz":"halisaha","dusuk":1}
   Şifre karta kaydedilir, GitHub'da / sitede durmaz.
   ===================================================================== */
#include <ETH.h>
#include <NetworkClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <time.h>
#include "sertifika.h"

#define SURUM "1.0.0"
#define ROLE_PIN 4
#define LED_PIN 2            // kart üstünde yoksa sorun değil
static const char *API_KEY = "AIzaSyAAtGK76Oanri1T9nCK4bm6dDJCLVzWp5c";   // sitedeki açık anahtar (gizli değil)
static const char *GUNCELLEME_KOK = "https://bizimevlerteknikservis.github.io/";

/* ---------- ayarlar ---------- */
Preferences P;
String aEmail, aSifre, aDb, aCihaz;
bool roleDusuk = true;       // çoğu röle modülü: IN=LOW → çeker

/* ---------- durum ---------- */
volatile bool agVar = false;
String token; uint32_t tokenMs = 0;
bool roleAcik = false;
String kaynak = "baslangic";

struct Istek { bool var = false; bool acik = false; int64_t bitis = 0; int64_t ts = 0; String kim; } ist;
struct Program { bool aktif = false; int hiBas = -1, hiBit = -1, hsBas = -1, hsBit = -1; } prg;
int64_t istekSonu = 0;       // elle komutun geçerli olduğu son an (ms)
bool istekBuAcilista = false; // saat yokken gelen canlı komut
String gUrl, gSurum;

NetworkClientSecure akisIstemci;
bool akisAcik = false; uint32_t akisSonVeri = 0, akisDeneme = 0;
uint32_t sonNabiz = 0, sonKomutOku = 0;
bool komutOkunmali = true;
bool ilkOkumaBitti = false;

/* ---------- yardımcılar ---------- */
static bool saatTamam() { return time(nullptr) > 1700000000; }
static int64_t simdiMs() { struct timeval tv; gettimeofday(&tv, nullptr); return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000; }
static int dkCoz(const char *s) { int h, m; if (!s || sscanf(s, "%d:%d", &h, &m) != 2) return -1; return h * 60 + m; }
static void araligiCoz(const char *s, int &bas, int &bit) {
  bas = bit = -1; if (!s) return; const char *t = strchr(s, '-'); if (!t) return;
  bas = dkCoz(s); bit = dkCoz(t + 1);
}

static void roleYaz(bool ac) {
  roleAcik = ac;
  digitalWrite(ROLE_PIN, (ac ^ roleDusuk) ? HIGH : LOW);
  digitalWrite(LED_PIN, ac ? HIGH : LOW);
}

/* belirli bir anda program "açık" diyor mu */
static bool programAcikMi(time_t t) {
  if (!prg.aktif) return false;
  struct tm z; localtime_r(&t, &z);
  bool hs = (z.tm_wday == 0 || z.tm_wday == 6);
  int bas = hs ? prg.hsBas : prg.hiBas, bit = hs ? prg.hsBit : prg.hiBit;
  if (bas < 0 || bit < 0 || bas == bit) return false;
  int d = z.tm_hour * 60 + z.tm_min;
  // gece yarısını geçen aralık (ör. 18:00-01:00): sabahki kısım önceki günün programıdır
  if (bit < bas) {
    if (d >= bas) return true;
    time_t dun = t - 86400; struct tm y; localtime_r(&dun, &y);
    bool yhs = (y.tm_wday == 0 || y.tm_wday == 6);
    int yb = yhs ? prg.hsBas : prg.hiBas, ye = yhs ? prg.hsBit : prg.hiBit;
    return ye < yb && d < ye;
  }
  return d >= bas && d < bit;
}

/* ts'den sonraki ilk program değişimi (en çok 'enCok' saniye ileri bakar) */
static int64_t sonrakiDegisim(int64_t tsMs, int enCok) {
  time_t t0 = tsMs / 1000; bool ilk = programAcikMi(t0);
  for (int s = 60; s <= enCok; s += 60) if (programAcikMi(t0 + s) != ilk) return (int64_t)(t0 + s) * 1000;
  return (int64_t)(t0 + enCok) * 1000;
}

static void istekSonuHesapla() {
  if (!ist.var || ist.ts <= 0) { istekSonu = 0; return; }
  if (ist.bitis > 0) { istekSonu = ist.bitis; return; }
  // süre verilmemiş: bir sonraki program değişimine kadar (açmada en çok 6 saat, kapatmada en çok 24 saat)
  istekSonu = sonrakiDegisim(ist.ts, ist.acik ? 6 * 3600 : 24 * 3600);
}

/* ---------- ayar kaydet / yükle ---------- */
static void ayarYukle() {
  P.begin("ayar", true);
  aEmail = P.getString("email", ""); aSifre = P.getString("sifre", "");
  aDb = P.getString("db", ""); aCihaz = P.getString("cihaz", "halisaha");
  roleDusuk = P.getBool("dusuk", true);
  P.end();
  P.begin("prg", true);   // internet yokken de çalışsın diye son program
  prg.aktif = P.getBool("aktif", false);
  prg.hiBas = P.getInt("hiBas", -1); prg.hiBit = P.getInt("hiBit", -1);
  prg.hsBas = P.getInt("hsBas", -1); prg.hsBit = P.getInt("hsBit", -1);
  P.end();
}
static void programKaydet() {
  P.begin("prg", false);
  P.putBool("aktif", prg.aktif); P.putInt("hiBas", prg.hiBas); P.putInt("hiBit", prg.hiBit);
  P.putInt("hsBas", prg.hsBas); P.putInt("hsBit", prg.hsBit); P.end();
}

static void seriOku() {
  static String s;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      s.trim();
      if (s.startsWith("AYAR ")) {
        JsonDocument d;
        if (deserializeJson(d, s.substring(5))) { Serial.println("AYAR HATA json"); }
        else {
          P.begin("ayar", false);
          if (d["email"].is<const char *>()) P.putString("email", d["email"].as<const char *>());
          if (d["sifre"].is<const char *>()) P.putString("sifre", d["sifre"].as<const char *>());
          if (d["db"].is<const char *>()) P.putString("db", d["db"].as<const char *>());
          if (d["cihaz"].is<const char *>()) P.putString("cihaz", d["cihaz"].as<const char *>());
          if (!d["dusuk"].isNull()) P.putBool("dusuk", d["dusuk"].as<int>() != 0);
          P.end();
          Serial.println("AYAR OK"); delay(300); ESP.restart();
        }
      } else if (s == "DURUM") {
        Serial.printf("SURUM %s | cihaz %s | ag %d | ip %s | saat %d | giris %d | akis %d | role %s | kaynak %s\n",
          SURUM, aCihaz.c_str(), agVar, ETH.localIP().toString().c_str(), saatTamam(), token.length() > 0, akisAcik,
          roleAcik ? "ACIK" : "KAPALI", kaynak.c_str());
      } else if (s == "TEST") {   // röleyi 2 sn çektir: kablolama kontrolü
        bool e = roleAcik; roleYaz(!e); delay(2000); roleYaz(e); Serial.println("TEST OK");
      } else if (s == "SIFIRLA") {
        P.begin("ayar", false); P.clear(); P.end(); P.begin("prg", false); P.clear(); P.end();
        Serial.println("SIFIRLANDI"); delay(300); ESP.restart();
      }
      s = "";
    } else if (s.length() < 600) s += c;
  }
}

/* ---------- Firebase ---------- */
static bool girisYap() {
  if (!aEmail.length() || !aSifre.length()) return false;
  NetworkClientSecure c; c.setCACert(KOK_SERTIFIKA);
  HTTPClient h;
  if (!h.begin(c, String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=") + API_KEY)) return false;
  h.addHeader("content-type", "application/json");
  JsonDocument b; b["email"] = aEmail; b["password"] = aSifre; b["returnSecureToken"] = true;
  String g; serializeJson(b, g);
  int kod = h.POST(g); String y = h.getString(); h.end();
  if (kod != 200) { Serial.printf("giris hata %d %s\n", kod, y.substring(0, 160).c_str()); return false; }
  JsonDocument d; if (deserializeJson(d, y)) return false;
  token = d["idToken"].as<String>(); tokenMs = millis();
  Serial.println("giris tamam");
  return token.length() > 0;
}

static String yol(const char *alt) { return "https://" + aDb + "/cihaz/" + aCihaz + alt + ".json?auth=" + token; }

static int istekAt(const char *yontem, const char *alt, const String &govde, String *yanit = nullptr) {
  NetworkClientSecure c; c.setCACert(KOK_SERTIFIKA);
  HTTPClient h; h.setTimeout(8000);
  if (!h.begin(c, yol(alt))) return -1;
  h.addHeader("content-type", "application/json");
  int kod = h.sendRequest(yontem, govde);
  if (yanit) *yanit = h.getString();
  h.end();
  if (kod == 401) token = "";
  return kod;
}

static void durumYaz(bool kayitEkle) {
  if (!token.length()) return;
  JsonDocument d;
  d["acik"] = roleAcik; d["kaynak"] = kaynak; d["son"][".sv"] = "timestamp";
  d["ip"] = ETH.localIP().toString(); d["surum"] = SURUM; d["saat"] = saatTamam();
  if (istekSonu > 0 && saatTamam() && simdiMs() < istekSonu) d["elleBitis"] = istekSonu; else d["elleBitis"] = 0;
  String g; serializeJson(d, g);
  istekAt("PUT", "/durum", g);
  if (kayitEkle) {
    JsonDocument l; l["acik"] = roleAcik; l["kaynak"] = kaynak; l["ts"][".sv"] = "timestamp";
    if (kaynak == "telefon" && ist.kim.length()) l["kim"] = ist.kim;
    String lg; serializeJson(l, lg);
    istekAt("POST", "/log", lg);
  }
}

static void komutUygula(JsonVariant k) {
  // elle komut
  JsonVariant i = k["istek"];
  Istek yeni;
  if (!i.isNull()) {
    yeni.var = true; yeni.acik = i["acik"] | false; yeni.bitis = i["bitis"] | (int64_t)0;
    yeni.ts = i["ts"] | (int64_t)0; yeni.kim = i["kim"] | "";
  }
  bool istekDegisti = yeni.ts != ist.ts || yeni.acik != ist.acik || yeni.bitis != ist.bitis || yeni.var != ist.var;
  if (istekDegisti && ilkOkumaBitti) istekBuAcilista = true;   // açılıştan sonra gelen canlı komut
  ist = yeni;
  // program
  JsonVariant p = k["program"];
  if (!p.isNull()) {
    Program n; n.aktif = p["aktif"] | false;
    araligiCoz(p["hi"] | "", n.hiBas, n.hiBit); araligiCoz(p["hs"] | "", n.hsBas, n.hsBit);
    if (n.aktif != prg.aktif || n.hiBas != prg.hiBas || n.hiBit != prg.hiBit || n.hsBas != prg.hsBas || n.hsBit != prg.hsBit) { prg = n; programKaydet(); }
  }
  istekSonuHesapla();
  // güncelleme
  JsonVariant u = k["guncelle"];
  gUrl = u["url"] | ""; gSurum = u["surum"] | "";
}

static void komutOku() {
  String y; int kod = istekAt("GET", "/komut", "", &y);
  if (kod != 200) { Serial.printf("komut okunamadi %d\n", kod); return; }
  JsonDocument d;
  if (deserializeJson(d, y)) return;
  komutUygula(d.as<JsonVariant>());
  komutOkunmali = false; ilkOkumaBitti = true;
}

/* Realtime Database canlı akış (Server-Sent Events) */
static void akisBaslat() {
  akisIstemci.stop(); akisAcik = false;
  akisIstemci.setCACert(KOK_SERTIFIKA);
  if (!akisIstemci.connect(aDb.c_str(), 443)) { Serial.println("akis baglanamadi"); return; }
  akisIstemci.printf("GET /cihaz/%s/komut.json?auth=%s HTTP/1.1\r\nHost: %s\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n",
                     aCihaz.c_str(), token.c_str(), aDb.c_str());
  String ilk = akisIstemci.readStringUntil('\n');
  if (ilk.indexOf(" 200") < 0) {
    Serial.printf("akis yanit: %s\n", ilk.c_str());
    if (ilk.indexOf(" 401") >= 0) token = "";
    // 307 yönlendirmesi: başka sunucuya git
    if (ilk.indexOf(" 307") >= 0) {
      while (akisIstemci.connected()) {
        String s = akisIstemci.readStringUntil('\n'); s.trim();
        if (s.startsWith("Location:") || s.startsWith("location:")) {
          String u = s.substring(9); u.trim(); int a = u.indexOf("//") + 2, b = u.indexOf('/', a);
          if (a > 1 && b > a) { aDb = u.substring(a, b); Serial.printf("yeni adres %s\n", aDb.c_str()); }
          break;
        }
        if (!s.length()) break;
      }
    }
    akisIstemci.stop(); return;
  }
  while (akisIstemci.connected()) { String s = akisIstemci.readStringUntil('\n'); if (s == "\r" || s.length() == 0) break; }
  akisAcik = true; akisSonVeri = millis();
  Serial.println("akis acik");
}

static void akisOku() {
  static String olay;
  while (akisIstemci.available()) {
    String s = akisIstemci.readStringUntil('\n'); s.trim();
    akisSonVeri = millis();
    if (s.startsWith("event:")) { olay = s.substring(6); olay.trim(); }
    else if (s.startsWith("data:")) {
      if (olay == "put" || olay == "patch") komutOkunmali = true;     // değişti → tamamını oku
      else if (olay == "auth_revoked" || olay == "cancel") { token = ""; akisIstemci.stop(); akisAcik = false; }
    }
  }
  if (!akisIstemci.connected()) akisAcik = false;
}

static void guncellemeBak() {
  if (!gUrl.length() || !gSurum.length() || gSurum == SURUM) return;
  if (!gUrl.startsWith(GUNCELLEME_KOK)) { Serial.println("guncelleme adresi kabul edilmedi"); gUrl = ""; return; }
  Serial.printf("guncelleniyor %s -> %s\n", SURUM, gSurum.c_str());
  kaynak = "guncelleme"; durumYaz(false);
  NetworkClientSecure c;
  c.setInsecure();   // adres yalnızca kendi sitemiz olabilir (yukarıda denetlendi); dosya bozuksa kart eski sürümde kalır
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return r = httpUpdate.update(c, gUrl);
  Serial.printf("guncelleme sonucu %d %s\n", r, httpUpdate.getLastErrorString().c_str());
  gUrl = "";
}

/* ---------- karar ---------- */
static void karar() {
  bool hedef = roleAcik; String yeniKaynak = kaynak;
  bool saat = saatTamam();
  if (ist.var && saat && simdiMs() < istekSonu) { hedef = ist.acik; yeniKaynak = "telefon"; }
  else if (ist.var && !saat && istekBuAcilista) { hedef = ist.acik; yeniKaynak = "telefon"; }
  else if (saat) { hedef = programAcikMi(time(nullptr)); yeniKaynak = prg.aktif ? "program" : "bekleme"; }
  else { yeniKaynak = "saat-yok"; }   // saat bilinmiyor: olduğu gibi kal
  if (hedef != roleAcik || yeniKaynak != kaynak) {
    bool degisti = hedef != roleAcik;
    roleYaz(hedef); kaynak = yeniKaynak;
    Serial.printf("isik %s (%s)\n", roleAcik ? "ACIK" : "KAPALI", kaynak.c_str());
    durumYaz(degisti);
  }
}

static void agOlayi(arduino_event_id_t e) {
  if (e == ARDUINO_EVENT_ETH_GOT_IP) { agVar = true; Serial.printf("ag tamam %s\n", ETH.localIP().toString().c_str()); }
  if (e == ARDUINO_EVENT_ETH_DISCONNECTED || e == ARDUINO_EVENT_ETH_LOST_IP) { agVar = false; akisAcik = false; Serial.println("ag yok"); }
}

void setup() {
  ayarYukle();
  // açılışta röle bırakık kalsın (kıpırdamasın)
  digitalWrite(ROLE_PIN, roleDusuk ? HIGH : LOW); pinMode(ROLE_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT); digitalWrite(LED_PIN, LOW);
  Serial.begin(115200); delay(200);
  Serial.printf("\nBizimevler hali saha karti %s · cihaz %s\n", SURUM, aCihaz.c_str());
  if (!aEmail.length() || !aDb.length()) Serial.println("AYAR YOK: kurulum sayfasindan ayar gonderin");
  configTzTime("<+03>-3", "time.google.com", "pool.ntp.org");
  Network.onEvent(agOlayi);
  ETH.begin(ETH_PHY_LAN8720, 1, 23, 18, 16, ETH_CLOCK_GPIO0_IN);
}

void loop() {
  seriOku();
  static uint32_t sonKarar = 0;
  if (millis() - sonKarar > 1000) { sonKarar = millis(); karar(); }

  if (!agVar || !aEmail.length() || !aDb.length()) { delay(20); return; }

  if (!token.length() || millis() - tokenMs > 50UL * 60 * 1000) {
    static uint32_t sonGiris = 0;
    if (millis() - sonGiris > 15000 || !sonGiris) { sonGiris = millis(); akisIstemci.stop(); akisAcik = false; if (girisYap()) { komutOkunmali = true; durumYaz(false); } }
    delay(20); return;
  }

  if (!akisAcik) {
    if (millis() - akisDeneme > 5000) { akisDeneme = millis(); akisBaslat(); komutOkunmali = true; }
  } else {
    akisOku();
    if (millis() - akisSonVeri > 75000) { Serial.println("akis sessiz, yeniden"); akisIstemci.stop(); akisAcik = false; }
  }

  if (komutOkunmali || millis() - sonKomutOku > 10UL * 60 * 1000) { sonKomutOku = millis(); komutOku(); karar(); guncellemeBak(); }
  if (millis() - sonNabiz > 60000) { sonNabiz = millis(); durumYaz(false); }
  delay(5);
}
