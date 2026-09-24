# Mantis Browser v Microsoft Store

Balíček **MSIX** z Microsoft Store Microsoft sám podepíše, takže se instaluje bez
varování SmartScreen a aktualizuje se automaticky (stejnou cestou jde do Storu
i LibreWolf). Postup: nejdřív balíček vyzkoušet místně, pak ho odeslat.

## Krok 1: vyzkoušet MSIX místně (bez Storu)

Nepodepsaný prohlížeč Windows nainstalovat nedovolí (manifest Firefoxu má „Executable
activations“ – COM server pro upozornění, startovní úlohu, alias – a ty nepodepsaný balíček
mít nesmí, chyba 0x80073D2B). Pro místní test se proto kopie balíčku podepíše vlastním
testovacím certifikátem se stejným vydavatelem jako ve Storu:

```bash
./scripts/prepare-source.sh
./scripts/build.sh --msix          # balíček pro Store (MSIX_STORE=true, výchozí)
./scripts/sign-msix-test.sh        # podepsaná kopie + certifikát (potřebuje osslsigncode)
```

Ve `Stažené soubory\Mantis` pak je `mantis-<verze>.x64.msix` (pro Store),
`…-test-signed.msix` a `mantis-msix-test.cer`. Na **Windows** jednou přidat certifikát
mezi důvěryhodné osoby (PowerShell **jako správce**) a nainstalovat:

```powershell
Import-Certificate -FilePath "$env:USERPROFILE\Downloads\Mantis\mantis-msix-test.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople
Add-AppxPackage "$env:USERPROFILE\Downloads\Mantis\mantis-156.1.10300.0.x64-test-signed.msix"
```

(Verze A.B.C.D = X.(100Y+Z).(100R).0 pro LibreWolf X.Y.Z-rel, R = 100 × rel + `MANTIS_RELEASE`;
přesný název vypíše `build.sh`.) Po testu certifikát odebrat:
`Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Subject -eq '<MSIX_PUBLISHER>' | Remove-Item`.

Mantis pak najdete v nabídce Start. Běží vedle verze z instalátoru a má vlastní
profil (Firefox má pro každou instalační složku samostatný profil). Nové soubory
v `%APPDATA%` a `%LOCALAPPDATA%` si MSIX ukládá do soukromé složky balíčku – VPN
profil (zašifrovaný v `%LOCALAPPDATA%\mantis\vpn`) proto bude potřeba vložit znovu. Odinstalace: Nastavení → Aplikace, nebo
`Get-AppxPackage *Mantis* | Remove-AppxPackage`.

**Co ověřit** (hlavně VPN):

- [ ] Spustí se, čeština, ikony a dlaždice v nabídce Start
- [ ] Nikde v UI „LibreWolf“: sekce v `about:preferences`, okno O aplikaci, nabídka Nápověda
      („Mantis Browser – nahlásit chybu“)
- [ ] `about:policies` – aktivní policies (uBlock, vyhledávače…);
      MSIX bere `distribution/policies.json` díky patchi LibreWolfu `msix.patch`
- [ ] Uvítací stránka, nová karta, Nastavení Mantis (Aktualizace: „Nainstalováno
      z Microsoft Store…“)
- [ ] **VPN**: tlačítko najde pomocníka (registruje se sám při startu), vložit profil,
      zapnout, ověřit IP, vypnout, restart prohlížeče; kill switch: se zapnutou VPN
      ukončit `wireproxy.exe` ve Správci úloh → weby se nenačtou, přijde upozornění,
      do minuty se VPN obnoví
- [ ] Šifrované DNS: stav v Nastavení Mantis
- [ ] Výchozí prohlížeč: Nastavení Windows → Aplikace → Výchozí aplikace

## Krok 2: odeslání do Storu

1. **Účet vývojáře** (pro jednotlivce zdarma): začít na
   https://storedeveloper.microsoft.com (jiné cesty nabízejí starý placený postup).
   Přihlášení osobním účtem Microsoft, ověření dokladem totožnosti a selfie.
2. **Rezervovat název** aplikace (Partner Center → Nová aplikace).
3. **Identita:** Partner Center → produkt → *Product identity* – hodnoty opsat přesně
   (i velikost písmen) do `scripts/config.sh`: `MSIX_IDENTITY_NAME`
   (Package/Identity/Name), `MSIX_PUBLISHER` (Package/Identity/Publisher, `CN=…`),
   `MSIX_PUBLISHER_DISPLAY_NAME`; `MSIX_DISPLAYNAME` musí odpovídat rezervovanému
   názvu. V repozitáři je identita oficiálního vydání Mantisu – pro vlastní účet ji
   nahraďte. Build `--msix` pak vyrobí balíček pro Store (nepodepsaný, Store ho podepíše;
   do Storu se nahrává tento, ne `…-test-signed.msix`).
4. **Žádost v Partner Center:**
   - *Pricing and availability* – viditelnost podle potřeby: veřejně, „Available but
     not discoverable“ (jen přes přímý odkaz), nebo soukromé publikum (vybrané účty
     Microsoft). Veřejně vydanou aplikaci už nejde vrátit do soukromého publika.
   - *Properties* – kategorie, **zásady ochrany osobních údajů** (povinné pro aplikace
     s `runFullTrust`, pravidlo 10.5.1; URL musí jít otevřít bez ověřovací výzvy),
     kontakt na podporu.
   - *Product declarations* – u prohlížeče rozumně: zálohy do OneDrive a nahrávání/vysílání
     (jen pro hry) nezaškrtávat, generativní AI ne (LibreWolf AI funkce blokuje).
   - *Age ratings (IARC)* – odpovídat podle obsahu aplikace samotné, ne podle webů:
     „All Other App Types“, obsahové otázky No, „web browser or search engine“ Yes →
     nejnižší hodnocení se štítkem „Unrestricted Internet“.
   - *Packages* – nahrát `.msix`.
   - *Store listings* – popis a aspoň 1 snímek obrazovky (PNG, min. 1366×768).
   - *Submission options* – zdůvodnění **runFullTrust** (viz níže); doporučeno publikovat
     ručně až po certifikaci.
5. **Každé další vydání:** `MANTIS_RELEASE` +1 (nebo nová `LW_VERSION`), build `--msix`,
   nahrát nový balíček. **Pravidlo 10.2.1:** prohlížeč smí být nejvýš 2 hlavní verze za
   aktuálním Firefoxem/Chromiem (~8 týdnů).

Verze z Microsoft Store vlastní aktualizace nekontroluje ani neinstaluje
(`mantisPrefs.isPackaged()`), jinak by vedle nainstalovala druhou kopii.

## Na co si dát pozor (pravidla Storu 7.20)

- **10.1.1** – nevydávat se za Mozillu ani LibreWolf: vlastní název a logo, v popisu
  „založeno na open-source technologii Mozilly“ jen s upozorněním, že nejde o produkt
  Mozilly (ochranná známka „Firefox“ nesmí být v názvu, ikonách ani snímcích).
- **10.1.5** – rozšíření jen se souhlasem uživatele: Mantis je proto nabízí na uvítací
  stránce a sám neinstaluje (výjimka: uBlock Origin, součást LibreWolfu).
- **10.5.2** – údaje třetím stranám jen po souhlasu: šifrované DNS je ve výchozím stavu
  vypnuté, TTV LOL PRO jen jako doporučené rozšíření s upozorněním.
- **11.2** – licence: vlastní kód MPL 2.0, zdrojové kódy veřejně (splněno).

## Zdůvodnění runFullTrust (vzor)

> Mantis Browser je webový prohlížeč (Gecko, odvozený od Firefoxu přes LibreWolf) jako
> klasická desktopová aplikace s vícoprocesovou architekturou, stejně jako Firefox
> a LibreWolf v Microsoft Store. Potřebuje spouštět vlastní podprocesy (obsah, GPU,
> síť) a přibalený pomocný program pro VPN, který běží jen lokálně.
