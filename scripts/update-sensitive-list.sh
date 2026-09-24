#!/usr/bin/env bash
# Vygeneruje extension/sensitive/adult-domains.txt – seznam webů pro dospělé,
# které Mantis neukládá do historie (Nastavení Mantis → Choulostivé stránky).
# Zdroj: StevenBlack/hosts, extensions/porn/clefspeare13 (MIT).
# Výsledek se commituje, build ho nestahuje.
set -euo pipefail
source "$(dirname "$0")/config.sh"

URL="https://raw.githubusercontent.com/StevenBlack/hosts/master/extensions/porn/clefspeare13/hosts"
OUT="$REPO_DIR/extension/sensitive/adult-domains.txt"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$URL" -o "$tmp" || die "nepodařilo se stáhnout $URL"

domains=$(awk '$1 == "0.0.0.0" && $2 != "0.0.0.0" { print tolower($2) }' "$tmp" \
  | sed 's/^www\.//' \
  | grep -E '^[a-z0-9-]+(\.[a-z0-9-]+)+$' \
  | sort -u)
count=$(printf '%s\n' "$domains" | grep -c .)
[ "$count" -gt 5000 ] || die "seznam má jen $count domén – změnil se formát zdroje?"

mkdir -p "$(dirname "$OUT")"
{
  echo "# Weby pro dospělé – Mantis je neukládá do historie."
  echo "# Vygenerováno scripts/update-sensitive-list.sh ($(date -u +%Y-%m-%d)), $count domén."
  echo "# Zdroj: $URL"
  grep -m1 '^# Last Updated' "$tmp" || true
  echo "# Clefspeare13 pornhosts, https://github.com/Clefspeare13/pornhosts"
  echo "# Copyright (c) Niclas (@Clefspeare13), Steven Black a přispěvatelé, licence MIT:"
  echo "# https://github.com/StevenBlack/hosts/blob/master/license.txt"
  echo "#"
  # MIT vyžaduje přiložit text licence ke každé kopii (seznam se přibaluje do prohlížeče)
  curl -fsSL "https://raw.githubusercontent.com/StevenBlack/hosts/master/license.txt" | sed -e 's/^/# /' -e 's/^# $/#/'
  echo "#"
  printf '%s\n' "$domains"
} > "$OUT"

info "$OUT: $count domén ($(du -h "$OUT" | cut -f1))"
