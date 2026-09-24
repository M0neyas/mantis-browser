# Vestavěné rozšíření Mantis

Při buildu se zabuduje přímo do prohlížeče (`browser/extensions/mantis`,
v `omni.ja` jako `builtin-addons/mantis/`) a Firefox ho nainstaluje sám.
Nejde odinstalovat, v `about:addons` je vidět jako „Mantis“.

| Soubor | Co dělá |
|---|---|
| `newtab/` | nová karta: logo, hodiny a datum, jemné zelené pozadí, vyhledávání (výchozí vyhledávač), nejnavštěvovanější stránky, upozornění na novou verzi, ozubené kolo → Nastavení Mantis |
| `welcome/` | **uvítací stránka** při prvním spuštění (`runtime.onInstalled` → `install`, počká na první okno) a z Nastavení Mantis: co už funguje, přepínač šifrovaného DNS (výchozí vypnuto), **doporučená rozšíření** – „Přidat“ otevře stránku na addons.mozilla.org, nic se neinstaluje samo (pravidlo Storu 10.1.5); stav přes `mantisPrefs.addonsInstalled` |
| `settings/` | **Nastavení Mantis** (`options_ui`; z nové karty nebo about:addons): obraz v obraze při přepnutí karty, automatické přehrávání, plynulé rolování, hodiny/pozadí nové karty, zapomenout web, choulostivé stránky, šifrované DNS, co jde přes VPN, synchronizace, aktualizace |
| `forget.js` | „Zapomenout web …“ v kontextové nabídce stránky a karty (Firefoxí `ForgetAboutSite` – historie, cookies, cache, data, oprávnění celé domény) |
| `sensitive.js`, `sensitive/` | **Choulostivé stránky**: navštívené stránky ze seznamu se hned mažou z historie (`history.onVisited` → `deleteUrl`) a z nedávno zavřených karet/oken (`sessions.forget*`). Kategorie „Pro dospělé“ = `sensitive/adult-domains.txt` (generuje `scripts/update-sensitive-list.sh`, MIT) + klíčová slova v hostname; vlastní weby, výjimky, úklid dosavadní historie; kontextová nabídka „Neukládat web do historie“. Nastavení v `storage.local` → `sensitive` |
| `experiments/` | privilegované API `mantisPrefs` (vestavěná rozšíření smí): čtení/změna **jen vyjmenovaných** nastavení, zapomenutí webu, spuštění staženého instalátoru (jen `Mantis-Browser-Setup*.exe` ze složky pro stahování a jen se sedícím SHA-256), `isPackaged` (běh z MSIX → bez vlastních aktualizací) a `ensureVpnHost` (registrace VPN pomocníka pro zip a MSIX) |
| `background.js` | jednou denně zjistí nové vydání Mantisu (`moneyas.cz/mantis/download/latest.json`), volitelně i LibreWolfu; upozornění Windows + proužek na nové kartě. **Aktualizace jedním kliknutím**: stáhne instalátor, ověří SHA-256 z `latest.json` a spustí ho |
| `doh.js` | **šifrované DNS** (DNS over HTTPS, `network.trr.*`): výchozí **vypnuto**; *Automaticky* zapne DoH, jen když síť nezablokuje kanárkovou doménu `use-application-dns.net` (Pi-hole, firemní sítě ji blokují); kontrola při startu, při změně sítě (`networkStatus`) a každých 10 min. Poskytovatelé Quad9, Mullvad, Cloudflare |
| `sync.js` | **synchronizace Nastavení Mantis** přes účet Firefoxu (`storage.sync`): přepínače, choulostivé stránky, DNS, směrování VPN. VPN profil ne |
| `version.js` | verze LibreWolfu, ze které je build – `prepare-source.sh` dosadí `LW_VERSION` místo `@LW_VERSION@` |
| `vpn.js`, `vpn/` | tlačítko VPN ve spodní liště a jeho okno (profil WireGuard, zapnout/vypnout); přepíná proxy prohlížeče, tunel obstarává pomocník z [../vpn](../vpn/README.md). **Směrování**: přes VPN všechno (výchozí), jen vybrané weby/IP rozsahy/kontejnery, nebo všechno kromě nich (`storage.local` → `vpnRouting`) |

## Vyzkoušení bez buildu

Celé rozšíření **nejde** načíst v obyčejném LibreWolfu přes `about:debugging`:
používá privilegované `experiment_apis` (Nastavení Mantis, Zapomenout web),
které release verze povoluje jen vestavěným rozšířením. Funguje až v buildu.

Samotnou novou kartu nebo okno VPN lze prohlédnout tak, že se z `manifest.json`
dočasně odstraní `experiment_apis` a `forget.js` a doplněk se pak načte přes
`about:debugging` → Tento LibreWolf → **Načíst dočasný doplněk…** (VPN bez
pomocníka ukáže jen hlášku, že pomocník chybí).
