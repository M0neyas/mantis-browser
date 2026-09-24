# Společné nastavení build skriptů (načítá se přes `source`).

# Verze LibreWolfu, nad kterou stavíme (= Firefox 156.0.1, LibreWolf release 1).
# Při přechodu na novou verzi změnit tady a ověřit, že prepare-source.sh projde.
LW_VERSION="156.0.1-1"
# Pořadí sestavení Mantisu nad touto verzí LibreWolfu. Zvýšit při každém zveřejnění
# buildu se stejnou LW_VERSION (jinak ho nainstalované prohlížeče nepoznají jako nový),
# při změně LW_VERSION vrátit na 1. (1 = první build 2026-09-23, bez kontroly moneyas.cz)
MANTIS_RELEASE=2
LW_FORGE="https://librewolf.dev"
LW_SOURCE_URL="$LW_FORGE/api/packages/librewolf/generic/librewolf-source/$LW_VERSION/librewolf-$LW_VERSION.source.tar.gz"
# SHA-256 zdrojového balíku, zapsaný v repozitáři (check-update.sh --apply ho aktualizuje).
# Balík se ověřuje proti této hodnotě, ne jen proti souboru .sha256sum ze stejného
# serveru – podvržený server by musel podvrhnout i commit v tomto repozitáři.
LW_SOURCE_SHA256="93b6d0189fa1171b9ce9ee42c95f8721f7f10df0c1214922ee965a4efbc64f46"

# Veřejný klíč Ed25519 pro podpis vydání (latest.json), base64 z scripts/release-key.sh.
# Prohlížeč s tímto klíčem nabídne instalaci jedním kliknutím jen u podepsaného vydání.
# Prázdný = build bez ověřování podpisu (aktualizace jen odkazem na stránku ke stažení).
# Soukromý klíč nikdy do repozitáře – leží jen u vydavatele (~/.config/mantis/release-key.pem).
MANTIS_RELEASE_PUBKEY=""
# windows.mozconfig z buildovacího systému LibreWolfu (bsys6), stejná verze
BSYS6_RAW_URLS=(
  "$LW_FORGE/librewolf/bsys6/raw/tag/$LW_VERSION/assets/windows.mozconfig"
  "$LW_FORGE/librewolf/bsys6/raw/branch/master/assets/windows.mozconfig"
)
# Docker image se všemi nástroji pro cross-compilaci na Windows
BSYS6_IMAGE="librewolf.dev/librewolf/bsys6:windows"

# VPN: wireproxy (WireGuard → SOCKS5), binárka pro Windows z GitHub releases
WIREPROXY_VERSION="v1.1.3"
WIREPROXY_URL="https://github.com/windtf/wireproxy/releases/download/$WIREPROXY_VERSION/wireproxy_windows_amd64.tar.gz"
WIREPROXY_LICENSE_URL="https://raw.githubusercontent.com/windtf/wireproxy/$WIREPROXY_VERSION/LICENSE"
WIREPROXY_SHA256="bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f"
# Docker image s Go pro kompilaci VPN pomocníka (vpn/host)
GO_IMAGE="golang:1"

# Názvy – interní názvy bez mezer (exe, profil), zobrazovaný název s mezerou.
APP_NAME="mantis"                 # mantis.exe, %APPDATA%\mantis
APP_BASENAME="Mantis"             # vendor, remoting, registry
APP_DISPLAYNAME="Mantis Browser"  # název v UI (brand.ftl)

# Jazyky, které se přibalí (UI se řídí jazykem Windows)
LOCALES="cs en-US"
# Jazyk instalátoru (NSIS umí jen jeden)
INSTALLER_LOCALE="cs"

# Microsoft Store (MSIX): ./scripts/build.sh --msix
# Identita z Partner Center → Mantis Browser → Product identity (opsaná 2026-09-24).
# MSIX_STORE=false: testovací balíček pro místní instalaci na Windows 11
# (Add-AppxPackage -AllowUnsigned – k vydavateli se přidá OID pro nepodepsané balíčky).
# MSIX_STORE=true: balíček k nahrání do Storu (Store ho podepíše).
MSIX_STORE=false
MSIX_IDENTITY_NAME="Moneyas.MantisBrowser"
MSIX_PUBLISHER="CN=C7B646C8-A659-496B-ABF8-666877012789"
MSIX_PUBLISHER_DISPLAY_NAME="Moneyas"
# Název balíčku (Start, Store) – musí odpovídat názvu rezervovanému v Partner Center
MSIX_DISPLAYNAME="Mantis Browser"

# Zveřejnění instalátoru na webu (scripts/publish-installer.sh).
# Server a složku nastavte v scripts/config.local.sh (není v gitu), např.:
#   PUBLISH_HOST="uzivatel@server"
#   PUBLISH_DIR="/var/www/web/mantis/download"
PUBLISH_HOST=""
PUBLISH_DIR=""
PUBLISH_FILE="Mantis-Browser-Setup.exe"
PUBLISH_URL="https://moneyas.cz/mantis/download"

# Pracovní složka – musí být na disku WSL (ext4), ne na /mnt/c
WORK_DIR="${WORK_DIR:-$HOME/mantis-work}"
SRC_DIR="$WORK_DIR/src/librewolf-$LW_VERSION"
OUT_DIR="$WORK_DIR/out"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Místní přepsání (soukromé údaje, jiné cesty) – v .gitignore
# shellcheck source=/dev/null
[ -f "$REPO_DIR/scripts/config.local.sh" ] && source "$REPO_DIR/scripts/config.local.sh"

die()  { echo "CHYBA: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "Varování: $*" >&2; }

# Nahradí text v souboru v $SRC_DIR; selže, pokud tam hledaný text není.
replace() {
  local file="$SRC_DIR/$1" from="$2" to="$3"
  [ -f "$file" ] || die "soubor $1 neexistuje (změnila se struktura LibreWolfu?)"
  grep -qF -- "$from" "$file" || die "v $1 chybí '$from' (změnila se struktura LibreWolfu?)"
  FROM="$from" TO="$to" perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/g' "$file"
}
