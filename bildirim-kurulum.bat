@echo off
chcp 65001 >nul
title Bizimevler 1 - Bildirim kurulumu
cd /d "%~dp0"
echo.
echo  ==============================================
echo   Bizimevler 1 - Telefon bildirimi kurulumu
echo  ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  [!] Node.js kurulu degil.
  echo      https://nodejs.org adresinden "LTS" surumunu indirip kurun,
  echo      sonra bu dosyaya tekrar cift tiklayin.
  start https://nodejs.org
  pause
  exit /b
)
echo  [1/4] Firebase araci kuruluyor...
call npm install -g firebase-tools
echo.
echo  [2/4] Google hesabinizla giris (tarayici acilacak, teknisyenzeynel91 hesabini secin)...
call firebase login
echo.
echo  [3/4] Bildirim fonksiyonu hazirlaniyor...
cd functions
call npm install
cd ..
echo.
echo  [4/4] Firebase'e yukleniyor (ilk seferde 3-5 dakika surebilir)...
call firebase deploy --only functions --project bizimevler-teknik-servis
echo.
echo  Bitti. Yukarida "Deploy complete!" yaziyorsa kurulum tamam.
echo  Hata varsa bu pencerenin ekran goruntusunu gonderin.
pause
