# VPN (WireGuard)

Tlačítko VPN ve spodní liště přepne **veškerý provoz prohlížeče** přes
WireGuard VPN. Zbytek počítače VPN neovlivní.

Funguje s **libovolným standardním profilem WireGuard** (`.conf`) – PiVPN,
komerční poskytovatelé (Mullvad, Proton VPN, …), vlastní server.
**Podporovaný je jen WireGuard**, OpenVPN ani jiné protokoly ne.

## Jak to funguje

```
tlačítko VPN (rozšíření Mantis, extension/vpn.js)
  │  native messaging (cz.mantis.vpn)
  ▼
mantis-vpn.exe (vpn/host)  ── uloží profil do %APPDATA%\mantis\vpn\wg.conf
  │  spustí / zastaví
  ▼
wireproxy.exe  ── WireGuard tunel → SOCKS5 proxy 127.0.0.1:25344
                  (se jménem a heslem, DNS přes tunel)
```

- Pomocník se spustí s prvním použitím VPN a skončí se zavřením prohlížeče
  (i s wireproxy). Žádná služba ani úloha na pozadí.
- **Klíče z profilu zůstávají jen v `%APPDATA%\mantis\vpn`** – neposílají se
  zpět do prohlížeče, nejsou v repozitáři ani v buildu.
- **Proxy je chráněná jménem a heslem**, které pomocník náhodně vygeneruje při
  každém spuštění a dá jen rozšíření Mantis – jiné programy v počítači tunel
  použít nemůžou.
- Informační HTTP rozhraní wireproxy (`-i`) se nespouští. Stav „připojeno“ =
  přes proxy jde navázat spojení skrz tunel (na první DNS server z profilu, TCP 53,
  jinak `1.1.1.1:443`).
- **Kill switch** (výchozí zapnuto, Nastavení Mantis → VPN): když je VPN zapnutá
  a pomocník nebo wireproxy spadne, provoz, který má jít přes VPN, se zablokuje
  (místo aby šel napřímo) a přijde upozornění. Mantis zkouší VPN každou minutu
  obnovit; napřímo provoz pustí až vypnutí VPN. Blokuje se i po spuštění prohlížeče,
  než se VPN připojí. `network.proxy.failover_direct` = false (`settings/mantis.cfg`)
  zabrání Firefoxu pouštět při výpadku proxy systémové požadavky napřímo.

## Použití

1. Pomocníka registrovat nemusíte: instalátor to udělá sám, přenosná verze (zip)
   a balíček MSIX (Microsoft Store) se zaregistrují při každém spuštění prohlížeče
   (`mantisPrefs.ensureVpnHost`, i po přesunutí složky). `register-vpn.ps1` zůstává
   jen jako záloha.
2. Kliknout na tlačítko VPN (štít) ve spodní liště.
3. Vložit obsah souboru `.conf` (nebo ho přetáhnout do okna,
   případně „Načíst ze souboru…“) → **Uložit a připojit**.
4. Dál už jen přepínač Zapnuto / Vypnuto. Stav si prohlížeč pamatuje.

Ikona: šedý obrys = vypnuto, zelený štít = připojeno, oranžový = zapnuto,
ale tunel neodpovídá, nebo VPN spadla a provoz je zablokovaný (kill switch).

## Soubory

| Soubor | Co dělá |
|---|---|
| `host/main.go` | pomocník `mantis-vpn.exe` (Go, bez závislostí) |
| `register-vpn.ps1` | zapíše pomocníka do registru (`HKCU\Software\Mozilla\NativeMessagingHosts\cz.mantis.vpn`) |

Build (`scripts/package-vpn.sh`, volá ho `build.sh`): pomocník se zkompiluje
v Dockeru (`golang`), wireproxy se stáhne z GitHubu (verze a sha256 v
`scripts/config.sh`) a obojí se přibalí do zipu jako `mantis/vpn/`.
