<p align="center">
  <img src="branding/logo.svg" width="96" height="96" alt="">
</p>

# Mantis Browser

Rychlý a soukromý webový prohlížeč pro Windows postavený na [LibreWolfu](https://librewolf.net/)
(a tedy na Firefoxu). Česky, bez telemetrie, s blokováním reklam a vestavěnou VPN.

**Stažení instalátoru:** https://moneyas.cz/mantis

## Co umí

- **Soukromí** – LibreWolf bez telemetrie, ochrana proti sledování a otiskům prohlížeče,
  která nerozbíjí weby (tmavý režim, mapy a WebGL fungují).
- **Bez reklam a cookie lišt** – předinstalovaný uBlock Origin s filtry na cookie lišty,
  na Twitchi navíc TTV LOL PRO.
- **VPN jedním klikem** – WireGuard jen pro prohlížeč (libovolný `.conf` profil),
  přes [wireproxy](https://github.com/windtf/wireproxy) a malého pomocníka v Go.
  Přes VPN může jít všechno, nebo jen vybrané weby a kontejnery. Kill switch: když VPN
  spadne, provoz se zablokuje místo toho, aby šel napřímo.
- **Ochrana před podvodnými weby** – seznamy škodlivých a phishingových adres v uBlock
  Origin; WebGL jde v Nastavení Mantis jedním přepínačem vypnout.
- **Šifrované DNS, když dává smysl** – po zapnutí režimu *Automaticky* se na cizích sítích
  zapne samo, doma s Pi-holem nebo ve firemní síti zůstane DNS sítě.
- **Vzhled** – kompaktní dvouřádková lišta, stránka přes celou plochu, zelený akcent,
  vlastní nová karta s hodinami.
- **Soukromá historie** – vybrané weby se neukládají do historie, „Zapomenout web“ jedním klikem.
- **Připravený k použití** – čeština, doporučená rozšíření jedním kliknutím (Bitwarden,
  kontejnery karet, český slovník, TTV LOL PRO – nic se neinstaluje samo),
  rychlé hledání `@mapy @heureka @csfd @yt @wiki @seznam`, DRM (Netflix, Spotify),
  synchronizace přes účet Firefoxu (včetně Nastavení Mantis).
- **Instalátor v češtině** a aktualizace jedním kliknutím (podepsané vydání – Ed25519,
  ověření SHA-256, spuštění).

## Jak je to postavené

Repozitář obsahuje jen vlastní vrstvu nad LibreWolfem – zdrojové kódy Firefoxu/LibreWolfu
si build skripty stahují samy:

- `patches/` – úpravy zdrojového kódu
- `branding/` – logo, nápisy a obrázky instalátoru (zdroj všech ikon)
- `settings/` – výchozí nastavení a policies
- `theme/` – vzhled (`userChrome.css`, zapečený do prohlížeče)
- `extension/` – vestavěné rozšíření (nová karta, Nastavení Mantis, kontrola verzí, VPN, soukromí)
- `vpn/` – VPN pomocník (Go) a registrace pro přenosnou verzi
- `scripts/` – příprava prostředí, build, instalátor a vydání

## Build

Build probíhá ve WSL2 (Ubuntu) v Docker image LibreWolfu s cross-compilací pro Windows:

```bash
./scripts/setup-wsl.sh        # jednou: Docker a nástroje
./scripts/prepare-source.sh   # stáhne LibreWolf a nasadí naše úpravy
./scripts/build.sh            # kompilace → instalátor + zip s mantis.exe
```

Celý návod včetně přípravy WSL, vydání a řešení problémů je v [BUILD.md](BUILD.md),
balíček pro Microsoft Store (MSIX) v [STORE.md](STORE.md).

## Licence

Mantis Browser je neoficiální prohlížeč, není spojený s Mozillou ani s projektem LibreWolf.
Firefox je ochranná známka Mozilla Foundation.

- **Vlastní kód Mantisu** (skripty, rozšíření, vzhled, VPN pomocník, nastavení) je pod
  [Mozilla Public License 2.0](LICENSE), stejně jako Firefox a LibreWolf.
- Firefox a LibreWolf jsou šířené pod [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/);
  upravené soubory vznikají skripty z tohoto repozitáře nad veřejným
  [zdrojovým balíkem LibreWolfu](https://librewolf.dev/librewolf/source).
- wireproxy – licence ISC (přibaluje se jako `vpn/wireproxy-LICENSE.txt`).
- Seznam webů pro dospělé (`extension/sensitive/adult-domains.txt`) – MIT,
  [StevenBlack/hosts](https://github.com/StevenBlack/hosts); text licence je v hlavičce souboru.
