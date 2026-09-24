# Build Mantis Browseru

Build běží ve **WSL2 (Ubuntu)** v Docker image LibreWolfu, který obsahuje
všechny nástroje pro cross-compilaci na Windows. Výsledkem je instalátor
a přenosný zip s prohlížečem (`mantis.exe`).

**Doporučený počítač:** 8 jader / 16 vláken, 32 GB RAM, ~80 GB volného místa
na SSD (na libovolném disku, viz níže). První build trvá na takovém stroji
zhruba **30–60 minut**; na HDD počítejte se 2–4× delší dobou (build pracuje
se stovkami tisíc malých souborů).

**Ve Windows se nic dalšího instalovat nemusí** – Docker, Git i všechny
build nástroje se instalují uvnitř Ubuntu. Potřeba je jen WSL (krok 2)
a připojení k internetu (stáhne se ~15 GB).

## 1. Jednorázová příprava

### Krok 1: Zapnutá virtualizace

WSL potřebuje virtualizaci procesoru. Kontrola: Správce úloh (Ctrl+Shift+Esc)
→ Výkon → Procesor → vpravo dole **Virtualizace: Povoleno**.

Pokud je **Zakázáno**: restart → vstup do BIOSu (obvykle klávesa Del
nebo F2 při startu) → najít **SVM Mode** (AMD) nebo **Intel VT-x** (bývá
v sekci Advanced → CPU Configuration) → **Enabled** → uložit a restartovat.

### Krok 2: WSL

PowerShell **jako správce** (Start → napsat „PowerShell“ → pravý klik →
Spustit jako správce):
```powershell
wsl --install --no-distribution
```
Po dokončení **restartovat počítač**. Pak znovu PowerShell jako správce:
```powershell
wsl --update
```

### Krok 3: Ubuntu na vhodný disk

Všechno (Docker image, zdrojáky, výsledky buildu) bude ve virtuálním disku
Ubuntu (`ext4.vhdx`). Může ležet na libovolném disku s ~80 GB volného místa.
**Pokud můžete, zvolte SSD.** Virtuální disk je jeden soubor, takže je celý
buď na SSD, nebo celý na HDD.

Instalace na D: (písmeno upravte; bez `--location` se Ubuntu nainstaluje na C:):
```powershell
wsl --install -d Ubuntu --location D:\WSL\Ubuntu
```
Otevře se okno Ubuntu a zeptá se na **uživatelské jméno a heslo** (pro Linux,
nemusí být stejné jako do Windows; heslo si zapamatujte – chce ho `sudo`).

> Už máte Ubuntu na C: a chcete ho přesunout? `wsl --shutdown` a pak
> `wsl --manage Ubuntu --move D:\WSL\Ubuntu` (data zůstanou).

Virtuální disk jen roste – místo po smazaných souborech se do Windows samo
nevrátí. Uvolnit ho jde po `wsl --shutdown` přes
`Optimize-VHD` / `diskpart` (`compact vdisk`).

Pracovní složku na `/mnt/d/…` **nepoužívejte** – přístup z WSL na disky
Windows je řádově pomalejší a build Firefoxu na něm může selhat.

### Krok 4: Paměť a procesor pro WSL

Poznámkový blok → uložit jako `%USERPROFILE%\.wslconfig`
(při ukládání zvolit „Všechny soubory“, aby nevznikl `.wslconfig.txt`) –
hodnoty pro 16 vláken a 32 GB RAM:
```ini
[wsl2]
memory=24GB
swap=16GB
processors=14
```
- `memory=24GB` – build dostane 24 GB, Windows zůstane 8 GB. Build se do toho
  vejde (nejnáročnější je finální linkování, ~10 GB), občas bude swapovat.
- `swap=16GB` – rezerva, kdyby paměť přece jen došla (build pak nespadne,
  jen zpomalí). Swap leží ve Windows na C: (`%TEMP%\swap.vhdx`).
- `processors=14` – dvě vlákna zůstanou Windows, aby se u buildu dalo pracovat.
  Kdo chce build rychleji, dá všechna.

Na jiném počítači hodnoty upravte: `memory` zhruba 75 % RAM, `processors` počet
vláken procesoru (nebo o 2 méně).

Pak v PowerShellu `wsl --shutdown`.

### Krok 5: Repozitář a build nástroje

Otevřete Ubuntu (Start → „Ubuntu“) a naklonujte repozitář **do domovské
složky WSL**, ne na `/mnt/c`:
```bash
sudo apt update && sudo apt install -y git
cd ~
git clone https://github.com/M0neyas/mantis-browser
cd mantis-browser
./scripts/setup-wsl.sh
```
`setup-wsl.sh` nainstaluje Docker a nástroje a stáhne build image (jednotky GB).
Na konci v PowerShellu `wsl --shutdown` a Ubuntu znovu otevřít.

Pro posílání změn na GitHub se v Ubuntu přihlaste (`sudo apt install -y gh`,
`gh auth login`, `gh auth setup-git`) a nastavte `git config user.name` / `user.email`.

### Krok 6 (volitelně): Claude Code v Ubuntu

Aby Claude mohl sám spouštět skripty a opravovat chyby buildu, nainstalujte
Claude Code přímo do Ubuntu a spouštějte ho ve složce repozitáře:
```bash
curl -fsSL https://claude.ai/install.sh | bash
cd ~/mantis-browser
claude
```

## 2. Build

```bash
cd ~/mantis-browser
git pull
./scripts/prepare-source.sh   # stáhne LibreWolf, nasadí naše úpravy (pár minut)
./scripts/build.sh            # kompilace + balení + instalátor (30–60 min)
```

Výsledek v `~/mantis-work/out/` a kopie ve Windows ve `Stažené soubory\Mantis`:

- **`mantis-….cs.win64.installer.exe`** – instalátor (česky). Nainstaluje do
  `Program Files\Mantis Browser`, vytvoří zástupce, zapíše se do Aplikace →
  Výchozí aplikace a rovnou zaregistruje VPN pomocníka. Odinstalace přes
  Nastavení Windows → Aplikace (profil v `%APPDATA%\mantis` zůstane).
  Nová verze se instaluje přes starou.
- `mantis-….en-US.win64.zip` – přenosná verze (rozbalit a spustit `mantis.exe`;
  obsahuje češtinu i angličtinu, „en-US“ je jen v názvu).

Windows SmartScreen bude varovat (nepodepsaná aplikace) → „Další informace“ →
„Přesto spustit“.

Mantis Browser má vlastní profil (`%APPDATA%\mantis`) a nekoliduje
s nainstalovaným LibreWolfem ani Firefoxem.

**VPN:** registrovat se nic nemusí – instalátor to udělá sám a přenosná verze
(zip) i balíček MSIX se zaregistrují při spuštění prohlížeče. Stačí kliknout na
tlačítko VPN (štít) ve spodní liště a vložit profil WireGuard. Podrobnosti ve
[vpn/README.md](vpn/README.md).

**Microsoft Store:** `./scripts/build.sh --msix` vyrobí navíc balíček MSIX –
vyzkoušení i odeslání do Storu popisuje [STORE.md](STORE.md).

## Aktualizace na novou verzi LibreWolfu

Firefox vydává bezpečnostní opravy zhruba každé 4 týdny a LibreWolf krátce po něm.
Kdo Mantis sestavuje, může si v **Nastavení Mantis → Aktualizace** zapnout
„Hlídat i nové verze LibreWolfu“ – prohlížeč pak upozorní, že je potřeba nový build.

```bash
cd ~/mantis-browser
git pull
./scripts/check-update.sh --apply   # přepne LW_VERSION, LW_SOURCE_SHA256 a MANTIS_RELEASE=1 v config.sh
./scripts/prepare-source.sh
./scripts/build.sh
```

`prepare-source.sh` ověřuje zdrojový balík proti **`LW_SOURCE_SHA256` zapsanému
v `config.sh`** (ne jen proti součtu ze stejného serveru). `check-update.sh --apply`
nový součet zjistí, ověří stažením balíku a zapíše – při commitu zkontrolujte, že
diff `config.sh` mění jen verzi a součet.

## Vydání vlastního buildu

**Číslo verze** = `LW_VERSION` + `MANTIS_RELEASE` (obojí v `scripts/config.sh`):
- **nový LibreWolf** → `LW_VERSION` přepne `check-update.sh --apply`, `MANTIS_RELEASE=1`
- **jen vlastní změny** (stejný LibreWolf) → `MANTIS_RELEASE` o 1 zvýšit, jinak
  nainstalované prohlížeče nový build nepoznají

**Kontrola nových verzí v prohlížeči:** nainstalované prohlížeče (mimo Microsoft Store)
se jednou denně podívají na `latest.json` na adrese `LATEST_URL` v
`extension/background.js` a nabídnou aktualizaci jedním kliknutím (stažení, ověření
SHA-256, spuštění instalátoru). Pro vlastní vydání změňte v `extension/` adresy
`moneyas.cz` (oficiální vydání Mantisu) na svůj web a `PUBLISH_URL` v `config.sh`.

**Podpis vydání (Ed25519):** instalaci jedním kliknutím prohlížeč nabídne jen tehdy,
když je `latest.json` podepsaný klíčem vydavatele. Jednorázově:
```bash
./scripts/release-key.sh   # vytvoří ~/.config/mantis/release-key.pem a vypíše veřejný klíč
```
Veřejný klíč zapište do `config.sh` jako `MANTIS_RELEASE_PUBKEY` (commit) – dostane se
do buildu. Soukromý klíč nikam nenahrávejte a zazálohujte si ho. `publish-installer.sh`
pak každé vydání podepíše; build s klíčem nepodepsaný nebo špatně podepsaný
`latest.json` ignoruje. S prázdným `MANTIS_RELEASE_PUBKEY` se podpis neověřuje a nové
verze se nabízejí jen odkazem na stránku ke stažení. **Pro vlastní vydání si vytvořte
vlastní klíč** – s klíčem oficiálního vydání vaše `latest.json` neprojde.

**Zveřejnění:** `./scripts/publish-installer.sh` nahraje instalátor přes SSH na webový
server a vedle něj zapíše `latest.json` (verze, velikost, SHA-256, podpis). Server a složku
nastavte v `scripts/config.local.sh` (není v gitu):
```bash
PUBLISH_HOST="uzivatel@server"
PUBLISH_DIR="/var/www/web/mantis/download"
```
Ve WSL se použije SSH klíč z Windows (`%USERPROFILE%\.ssh`). Skript odmítne instalátor,
jehož `MANTIS_RELEASE` nesedí s `config.sh`. Pokud je web za Cloudflare nebo podobnou
ochranou, musí `latest.json` a instalátor jít stáhnout bez ověřovací výzvy.

Nový instalátor se spouští přes starou instalaci (nebo se nový zip rozbalí přes starý);
profil a data zůstávají v `%APPDATA%\mantis`.

## Co dělají skripty

| Skript | Co dělá |
|---|---|
| `scripts/config.sh` | verze LibreWolfu, názvy, cesty |
| `scripts/setup-wsl.sh` | nainstaluje Docker a nástroje, stáhne build image |
| `scripts/prepare-source.sh` | stáhne a ověří zdrojáky LibreWolfu, přejmenuje aplikaci, nasadí `branding/`, `settings/`, `theme/`, `extension/`, `patches/`, připnutá rozšíření přesměruje do 2. řádku, sestaví mozconfig pro Windows |
| `scripts/prepare-installer.sh` | úpravy instalátoru Firefoxu (NSIS): názvy a klíče v registru, bez pingů Mozille, registrace VPN – volá ho `prepare-source.sh` |
| `scripts/make-icons.sh` | z `branding/logo.svg` vyrobí PNG/ICO ikony a z `branding/installer-*.svg` obrázky instalátoru |
| `scripts/build.sh` | `mach build` + `mach package-multi-locale` + přibalení VPN + instalátor, vše v Dockeru; s `--msix` i balíček pro Microsoft Store |
| `scripts/package-vpn.sh` | zkompiluje VPN pomocníka (Go v Dockeru), stáhne a ověří wireproxy – volá ho `build.sh` |
| `scripts/check-update.sh` | zjistí nejnovější LibreWolf, s `--apply` přepne `LW_VERSION` a zapíše `LW_SOURCE_SHA256` |
| `scripts/release-key.sh` | vytvoří klíč Ed25519 pro podpis vydání a vypíše veřejný klíč |
| `scripts/publish-installer.sh` | podepíše a nahraje instalátor a `latest.json` na vlastní web (server v `config.local.sh`) |

`prepare-source.sh` začíná vždy od čistých zdrojáků, takže každý build
je zatím celý (bez inkrementálního překladu).

## Když něco selže

- **`wsl --install` hlásí chybu s virtualizací** (např. 0x80370102) – není
  zapnutá virtualizace v BIOSu, viz krok 1.
- **`wsl --install --location` „neznámá volba“** –
  WSL je zastaralé, spusťte `wsl --update` a zkuste znovu.
- **`prepare-source.sh` skončí „změnila se struktura LibreWolfu?“** – nová
  verze LibreWolfu přesunula soubor nebo text, který upravujeme – podle
  hlášky upravte `prepare-source.sh` (případně `prepare-installer.sh`).
- **Build spadne** – celý výpis je v `~/mantis-work/out/build.log`, chyba bývá
  kousek nad posledním řádkem `Error`.
- **Málo paměti** (`Killed`, `signal 9`) – zvyšte `memory`/`swap` v `.wslconfig`.
