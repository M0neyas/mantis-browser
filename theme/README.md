# Vzhled

`userChrome.css` – prototyp minimalistického vzhledu (Arc × Safari):
karty nahoře, kompaktní zaoblený adresní řádek uprostřed, malá lišta záložek.
Barvy se berou z tématu prohlížeče (funguje světlý i tmavý režim).

Až bude vzhled odladěný, zapečeme ho do buildu jako patch témat Firefoxu.

## Rozložení lišt

- 1. řádek: ← → ⟳, adresní řádek, ☰ | karty, + | tlačítka okna
- 2. řádek: záložky vlevo | stahování, rozšíření, uBlock… vpravo

Přesun tlačítek do lišty záložek CSS neumí – je to nastavení rozložení lišt
(`browser.uiCustomization.state` v profilu). Ručně: pravý klik na lištu →
Přizpůsobit lištu… → přetáhnout tlačítka (stahování, rozšíření, uBlock)
z horní lišty do lišty záložek. Tlačítko ☰ ani 🧩 (rozšíření) přesunout nejde;
🧩 je proto v CSS schované. Nově připnutá rozšíření se objeví nahoře –
je potřeba je přetáhnout dolů stejně.
Ve vlastním buildu nastavíme výchozí rozložení patchem a připnutá rozšíření
budou rovnou chodit do spodní lišty.

## Vyzkoušení v obyčejném LibreWolfu

1. V `about:support` → „Složka profilu“ → Otevřít složku
   (na Windows `%APPDATA%\librewolf\Profiles\<profil>`).
2. Do složky profilu uložit `user.js` s řádkem:
   ```js
   user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
   ```
   (nebo to ručně přepnout v `about:config`). **Nestačí** to mít
   v `librewolf.overrides.cfg` – ten se načítá až po startu, pozdě.
3. Vytvořit ve složce profilu složku `chrome` a zkopírovat do ní `userChrome.css`.
4. Restartovat prohlížeč.
