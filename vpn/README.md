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
                  (DNS přes tunel, stav tunelu na 127.0.0.1:25345/readyz)
```

- Pomocník se spustí s prvním použitím VPN a skončí se zavřením prohlížeče
  (i s wireproxy). Žádná služba ani úloha na pozadí.
- **Klíče z profilu zůstávají jen v `%APPDATA%\mantis\vpn`** – neposílají se
  zpět do prohlížeče, nejsou v repozitáři ani v buildu.
- Stav „připojeno“ = wireproxy dostává odpověď z `1.1.1.1` přes tunel.

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
ale tunel neodpovídá.

## Soubory

| Soubor | Co dělá |
|---|---|
| `host/main.go` | pomocník `mantis-vpn.exe` (Go, bez závislostí) |
| `register-vpn.ps1` | zapíše pomocníka do registru (`HKCU\Software\Mozilla\NativeMessagingHosts\cz.mantis.vpn`) |

Build (`scripts/package-vpn.sh`, volá ho `build.sh`): pomocník se zkompiluje
v Dockeru (`golang`), wireproxy se stáhne z GitHubu (verze a sha256 v
`scripts/config.sh`) a obojí se přibalí do zipu jako `mantis/vpn/`.
