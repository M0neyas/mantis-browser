#!/usr/bin/env bash
# Podepíše kopii balíčku MSIX testovacím certifikátem, aby šel nainstalovat místně
# (nepodepsaný prohlížeč Windows odmítne – manifest má „Executable activations“).
# Balíček pro Store zůstane nepodepsaný, Store ho podepíše sám.
#
#   sign-msix-test.sh [balíček.msix]   (výchozí: jediný *.msix v $OUT_DIR)
#
# Certifikát se vytvoří jednou: předmět = MSIX_PUBLISHER (musí přesně sedět s manifestem),
# soukromý klíč v $MANTIS_MSIX_TEST_DIR (výchozí ~/.config/mantis/msix-test), jen pro
# vlastníka, nikdy do repozitáře. Veřejná část (.cer) se zkopíruje vedle balíčku – ve
# Windows ji jednou přidejte mezi důvěryhodné osoby (PowerShell jako správce):
#   Import-Certificate -FilePath <cesta>\mantis-msix-test.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
# a po testu zase odeberte:
#   Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Subject -eq '<MSIX_PUBLISHER>' | Remove-Item
set -euo pipefail
source "$(dirname "$0")/config.sh"

command -v osslsigncode >/dev/null || die "chybí osslsigncode (sudo apt install osslsigncode)"
command -v openssl >/dev/null || die "chybí openssl"

if [ $# -ge 1 ]; then
  msix=$1
else
  shopt -s nullglob
  all=("$OUT_DIR"/*.x64.msix)
  shopt -u nullglob
  msix=""
  for f in "${all[@]}"; do case "$f" in *-test-signed.msix) ;; *) msix=$f ;; esac; done
  [ -n "$msix" ] || die "v $OUT_DIR není balíček *.x64.msix (build.sh --msix)"
fi
[ -f "$msix" ] || die "balíček $msix neexistuje"

# Podepsat lze jen balíček s vydavatelem bez OID pro nepodepsané (MSIX_STORE=true)
publisher=$(unzip -p "$msix" AppxManifest.xml | grep -o 'Publisher="[^"]*"' | head -1 | cut -d'"' -f2)
[ "$publisher" = "$MSIX_PUBLISHER" ] \
  || die "vydavatel v balíčku ($publisher) není $MSIX_PUBLISHER – sestavte s MSIX_STORE=true"

dir=${MANTIS_MSIX_TEST_DIR:-$HOME/.config/mantis/msix-test}
key=$dir/test.key
crt=$dir/test.crt
if [ ! -f "$key" ] || [ ! -f "$crt" ]; then
  mkdir -p "$dir"; chmod 700 "$dir"
  cnf=$(mktemp)
  cat > "$cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${MSIX_PUBLISHER#CN=}
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
EOF
  (umask 077 && openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
    -config "$cnf" -extensions ext -keyout "$key" -out "$crt" 2>/dev/null)
  rm -f "$cnf"
  info "Vytvořen testovací certifikát $crt (platí 1 rok)"
fi
subject=$(openssl x509 -in "$crt" -noout -subject -nameopt RFC2253 | sed 's/^subject=//')
[ "$subject" = "$MSIX_PUBLISHER" ] || die "certifikát má předmět $subject, čekám $MSIX_PUBLISHER"

out=${msix%.msix}-test-signed.msix
rm -f "$out"
osslsigncode sign -certs "$crt" -key "$key" -h sha256 -in "$msix" -out "$out" >/dev/null \
  || die "podepsání se nepovedlo"
osslsigncode verify -CAfile "$crt" -in "$out" >/dev/null 2>&1 || warn "osslsigncode verify hlásí problém – zkuste instalaci"
cer=$(dirname "$out")/mantis-msix-test.cer
openssl x509 -in "$crt" -outform DER -out "$cer"
info "Podepsáno: $out"
info "Certifikát pro Windows: $cer"

# Kopie do Windows (Stažené soubory\Mantis), stejně jako build.sh
if command -v wslpath >/dev/null && command -v cmd.exe >/dev/null; then
  win_home=$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')
  if [ -n "$win_home" ]; then
    target="$(wslpath "$win_home")/Downloads/Mantis"
    mkdir -p "$target"
    cp "$out" "$cer" "$target/"
    info "Zkopírováno do Windows: $win_home\\Downloads\\Mantis"
  fi
fi
