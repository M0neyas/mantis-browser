#!/usr/bin/env bash
# Zjistí, jestli vyšel novější LibreWolf, než na kterém stavíme.
#   check-update.sh          jen vypíše stav
#   check-update.sh --apply  přepne LW_VERSION v config.sh na nejnovější verzi
# Pak: prepare-source.sh + build.sh (a commit config.sh).
set -euo pipefail
source "$(dirname "$0")/config.sh"

command -v jq >/dev/null || die "chybí jq (spusťte scripts/setup-wsl.sh)"

latest=$(curl -fsSL "$LW_FORGE/api/v1/repos/librewolf/source/tags?limit=20" \
  | jq -r '.[].name' | grep -E '^[0-9]+\.[0-9]+(\.[0-9]+)?-[0-9]+$' \
  | sort -t- -k1,1V -k2,2n | tail -1)
[ -n "$latest" ] || die "nepodařilo se zjistit nejnovější verzi LibreWolfu"

echo "Aktuální build:  $LW_VERSION"
echo "Nejnovější:      $latest"

if [ "$latest" = "$LW_VERSION" ]; then
  info "Máte nejnovější verzi."
  exit 0
fi

newest=$(printf '%s\n%s\n' "$LW_VERSION" "$latest" | sort -t- -k1,1V -k2,2n | tail -1)
if [ "$newest" != "$latest" ]; then
  info "config.sh má novější verzi, než je na librewolf.dev – nic nedělám."
  exit 0
fi

if [ "${1:-}" != "--apply" ]; then
  echo "Je dostupná nová verze. Přepnout: scripts/check-update.sh --apply"
  exit 0
fi

# SHA-256 nového balíku: z .sha256sum na serveru, ověřený stažením celého balíku.
# Zapíše se do config.sh – při commitu zkontrolujte, že diff mění jen verzi a součet.
url="$LW_FORGE/api/packages/librewolf/generic/librewolf-source/$latest/librewolf-$latest.source.tar.gz"
dl="$WORK_DIR/download"
tarball="$dl/librewolf-$latest.source.tar.gz"
mkdir -p "$dl"
info "Stahuji zdrojový balík $latest kvůli kontrolnímu součtu"
if [ ! -f "$tarball" ]; then
  curl -fL --retry 3 -o "$tarball.part" "$url"
  mv "$tarball.part" "$tarball"
fi
published=$(curl -fsSL "$url.sha256sum" | awk '{print $1}')
new_sha=$(sha256sum "$tarball" | awk '{print $1}')
[[ "$new_sha" =~ ^[0-9a-f]{64}$ ]] && [ "$published" = "$new_sha" ] \
  || die "SHA-256 staženého balíku ($new_sha) nesedí se zveřejněným ($published) – smažte $tarball a zkuste znovu"

sed -i -e "s/^LW_VERSION=\"[^\"]*\"/LW_VERSION=\"$latest\"/" \
  -e "s/^LW_SOURCE_SHA256=\"[^\"]*\"/LW_SOURCE_SHA256=\"$new_sha\"/" \
  -e "s/^MANTIS_RELEASE=[0-9]*/MANTIS_RELEASE=1/" "$REPO_DIR/scripts/config.sh"
grep -q "^LW_VERSION=\"$latest\"" "$REPO_DIR/scripts/config.sh" \
  && grep -q "^LW_SOURCE_SHA256=\"$new_sha\"" "$REPO_DIR/scripts/config.sh" \
  || die "úprava config.sh se nepovedla"
info "LW_VERSION přepnuto na $latest, LW_SOURCE_SHA256 = $new_sha, MANTIS_RELEASE = 1."
echo "Další kroky:"
echo "  ./scripts/prepare-source.sh && ./scripts/build.sh"
echo "  git commit -am \"Update to LibreWolf $latest\" && git push"
