#!/usr/bin/env bash
# Připraví složku vpn/ pro Mantis Browser:
#   - zkompiluje VPN pomocníka (vpn/host, Go) pro Windows v Dockeru
#   - stáhne a ověří wireproxy (WireGuard → SOCKS5 proxy)
#   - přidá registrační skript
# Výstup: $OUT_DIR/vpn/ (build.sh ji přibalí do zipu s prohlížečem).
set -euo pipefail
source "$(dirname "$0")/config.sh"

vpn_out="$OUT_DIR/vpn"
rm -rf "$vpn_out"
mkdir -p "$vpn_out"

info "VPN: kompiluji pomocníka mantis-vpn.exe ($GO_IMAGE)"
docker run --rm \
  -v "$REPO_DIR/vpn/host":/src:ro -v "$vpn_out":/out -w /src \
  -e GOOS=windows -e GOARCH=amd64 -e CGO_ENABLED=0 -e GOFLAGS=-trimpath \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$GO_IMAGE" \
  sh -c 'go build -ldflags "-s -w -H windowsgui" -o /out/mantis-vpn.exe . && chown "$HOST_UID:$HOST_GID" /out/mantis-vpn.exe'

info "VPN: stahuji wireproxy $WIREPROXY_VERSION"
dl="$WORK_DIR/download"
mkdir -p "$dl"
tgz="$dl/wireproxy_windows_amd64-$WIREPROXY_VERSION.tar.gz"
if [ ! -f "$tgz" ]; then
  curl -fL --retry 3 -o "$tgz.part" "$WIREPROXY_URL"
  mv "$tgz.part" "$tgz"
fi
echo "$WIREPROXY_SHA256  $tgz" | sha256sum -c --quiet - || die "kontrolní součet wireproxy nesedí – smažte $tgz"
tar xzf "$tgz" -C "$vpn_out" wireproxy.exe || die "v balíku wireproxy chybí wireproxy.exe"
# Licence wireproxy (ISC) musí být u každé kopie – v balíku releasu chybí
lic="$dl/wireproxy-LICENSE-$WIREPROXY_VERSION.txt"
[ -s "$lic" ] || curl -fsSL --retry 3 -o "$lic" "$WIREPROXY_LICENSE_URL" || die "nepodařilo se stáhnout licenci wireproxy"
grep -q "Permission to use, copy, modify" "$lic" || die "licence wireproxy nevypadá jako ISC – zkontrolujte $WIREPROXY_LICENSE_URL"
cp "$lic" "$vpn_out/wireproxy-LICENSE.txt"

cp "$REPO_DIR/vpn/register-vpn.ps1" "$vpn_out/"

# Manifest pro native messaging s cestou relativní k manifestu (Firefox to na Windows umí).
# Instalátor ho jen zaregistruje; register-vpn.ps1 (zip) ho přepíše s absolutní cestou.
jq -n '{
  name: "cz.mantis.vpn",
  description: "Mantis Browser VPN (WireGuard pres wireproxy)",
  path: "mantis-vpn.exe",
  type: "stdio",
  allowed_extensions: ["mantis@mantis.browser"]
}' > "$vpn_out/cz.mantis.vpn.json"
info "VPN: hotovo ($vpn_out)"
