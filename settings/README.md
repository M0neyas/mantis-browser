# Nastavení

- `mantis.cfg` – preference prohlížeče (formát autoconfig jako `librewolf.cfg`).
  Při buildu se připojí za `librewolf.cfg`.
- `policies.json` – enterprise policies. **Nenahrazuje** `policies.json`
  LibreWolfu (ten mimo jiné instaluje uBlock Origin), při buildu se s ním
  **sloučí**.

## Co nastavujeme

| Oblast | Nastavení |
|---|---|
| Tmavý režim webů | vypnuté `resistFingerprinting` (vynucovalo světlý režim a UTC), místo něj mírnější `fingerprintingProtection` |
| Mapy, 3D weby | zapnutý WebGL (vypnout jde v Nastavení Mantis → Zabezpečení) |
| Škodlivé weby | uBlock Origin: uBlock Badware risks, Online Malicious URL Blocklist (`urlhaus-1`) a Phishing URL Blocklist (`curben-phishing`). Google Safe Browsing nejde – vyžaduje API klíč, který mají jen oficiální buildy Mozilly |
| VPN kill switch | `network.proxy.failover_direct` = false – při výpadku proxy VPN nejdou napřímo ani systémové požadavky |
| Zavření prohlížeče | maže jen cache; cookies (přihlášení), historie a nastavení webů zůstávají |
| Cookie lišty | filtry uBlock Origin (EasyList/AdGuard Cookie Notices) – nastavené přes `toOverwrite.filterLists`, takže se výběr seznamů v uBlocku při každém spuštění vrátí na tento (ruční změny seznamů nevydrží restart; vlastní filtry v „Moje filtry“ ano). Firefox 156 vestavěné odmítání cookie lišt už nemá |
| Vyhledávač | DuckDuckGo (výchozí v LibreWolfu, „No-AI“ varianta) |
| Rychlé hledání | v adresním řádku `@mapy`, `@heureka`, `@wiki`, `@csfd`, `@yt`, `@seznam` + hledaný text |
| Rozšíření | předinstalovaný jen uBlock Origin (z LibreWolfu). Bitwarden, Multi-Account Containers, český slovník a TTV LOL PRO **nabízí uvítací stránka** k přidání (neinstalují se samy – pravidlo Microsoft Store 10.1.5) |
| Nápověda | položka „Mantis Browser – nahlásit chybu“ (GitHub Issues) místo LibreWolfího „LibreWolf Issue Tracker“ (policy `SupportMenu`) |
| Kontrola pravopisu | česky (`spellchecker.dictionary` = `cs`) |
| Filtry reklam | navíc EasyList Czech and Slovak |
| Spuštění | obnoví karty z minula |
| Synchronizace | Firefox Sync zapnutý (LibreWolf ho vypíná) – přihlášení v Nastavení → Synchronizace |
| DRM (Netflix, Spotify…) | zapnuté, včetně stažení modulu Widevine; policy `EncryptedMediaExtensions` i prefy (jinak policy LibreWolfu DRM vypne) |
| Kontejnery | zapnuté už v LibreWolfu, správu přidává Multi-Account Containers |

## Vyzkoušení v obyčejném LibreWolfu (bez buildu)

1. `mantis.cfg` zkopírovat jako `%USERPROFILE%\.librewolf\librewolf.overrides.cfg`
   (složka `.librewolf` ve výchozím stavu neexistuje – vytvořit ji).
   Soubor se načítá až po startu prohlížeče; hodnoty čtené při startu
   (např. povolení `userChrome.css`) je nutné dát do `user.js` v profilu.
2. Policies LibreWolfu jsou v `C:\Program Files\LibreWolf\distribution\policies.json`.
   **Náš `policies.json` tam nekopírovat** – přepsal by policies LibreWolfu
   (telemetrie, aktualizace, AI, instalace uBlocku…). Build je sloučí sám
   (`prepare-source.sh`). Pro test připravte sloučený soubor
   (policies LibreWolfu + naše) a ten se zkopíruje jako správce.
3. Restartovat prohlížeč, zkontrolovat `about:policies` a `about:config`.
