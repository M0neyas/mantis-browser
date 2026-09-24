#!/usr/bin/env bash
# Klíč Ed25519 pro podpis vydání (latest.json, viz publish-installer.sh).
#   release-key.sh   vytvoří klíč (pokud ještě není) a vypíše veřejný klíč
#
# Soukromý klíč: $MANTIS_RELEASE_KEY (výchozí ~/.config/mantis/release-key.pem),
# jen pro vlastníka. Nikdy ho nedávejte do repozitáře ani nikomu neposílejte –
# kdo ho má, může uživatelům podstrčit vlastní „aktualizaci“. Zazálohujte si ho
# (např. do správce hesel); bez něj nové vydání prohlížeče se starým klíčem
# nenainstalují jedním kliknutím (jen odkazem na stránku ke stažení).
#
# Veřejný klíč patří do scripts/config.sh jako MANTIS_RELEASE_PUBKEY.
set -euo pipefail
source "$(dirname "$0")/config.sh"

command -v openssl >/dev/null || die "chybí openssl"
key=${MANTIS_RELEASE_KEY:-$HOME/.config/mantis/release-key.pem}

if [ -f "$key" ]; then
  info "Klíč už existuje: $key"
else
  mkdir -p "$(dirname "$key")"
  chmod 700 "$(dirname "$key")"
  (umask 077 && openssl genpkey -algorithm ed25519 -out "$key")
  info "Vytvořen nový klíč: $key – zazálohujte si ho"
fi
chmod 600 "$key"

pub=$(openssl pkey -in "$key" -pubout -outform DER | tail -c 32 | base64 -w0)
echo
echo "Veřejný klíč (do scripts/config.sh):"
echo "  MANTIS_RELEASE_PUBKEY=\"$pub\""
if [ "$MANTIS_RELEASE_PUBKEY" = "$pub" ]; then
  info "config.sh už tento klíč má."
elif [ -n "$MANTIS_RELEASE_PUBKEY" ]; then
  warn "config.sh má JINÝ klíč – prohlížeče sestavené s ním nové podpisy nepřijmou."
fi
