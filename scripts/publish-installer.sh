#!/usr/bin/env bash
# Nahraje nejnovější instalátor na webový server jako
#   $PUBLISH_URL/Mantis-Browser-Setup.exe
# a zapíše vedle něj latest.json (verze, sestavení, velikost, SHA-256), podle
# kterého stránka ke stažení ukazuje verzi a prohlížeče hledají aktualizace.
# Spouští se ručně po úspěšném build.sh.
#
# Server a složka: PUBLISH_HOST a PUBLISH_DIR v scripts/config.local.sh.
# Ve WSL používá ssh.exe/scp.exe z Windows (klíč v %USERPROFILE%\.ssh),
# jinde běžné ssh/scp. Do cílové složky musí jít zapisovat bez sudo
# (jednorázově: sudo install -d -o <uživatel> -g www-data -m 755 <složka>).
set -euo pipefail
source "$(dirname "$0")/config.sh"
[ -n "$PUBLISH_HOST" ] && [ -n "$PUBLISH_DIR" ] \
  || die "nastavte PUBLISH_HOST a PUBLISH_DIR v scripts/config.local.sh (viz config.sh)"

shopt -s nullglob
inst=("$OUT_DIR"/*."$INSTALLER_LOCALE".win64.installer.exe)
shopt -u nullglob
[ ${#inst[@]} -eq 1 ] || die "v $OUT_DIR čekám právě jeden instalátor *.$INSTALLER_LOCALE.win64.installer.exe (nejdřív build.sh)"
inst=${inst[0]}

if command -v ssh.exe >/dev/null && command -v wslpath >/dev/null; then
  SSH=(ssh.exe -o BatchMode=yes) SCP=(scp.exe -q -o BatchMode=yes)
  local_path=$(wslpath -w "$inst")
else
  SSH=(ssh -o BatchMode=yes) SCP=(scp -q -o BatchMode=yes)
  local_path=$inst
fi

size=$(stat -c %s "$inst")
sha=$(sha256sum "$inst" | cut -d' ' -f1)
ff_version=${LW_VERSION%-*}
# Instalátor musí být z aktuálního MANTIS_RELEASE – jinak by ho prohlížeče hlásily špatně
built_release=$(unzip -p "$(ls "$OUT_DIR"/*.win64.zip | head -1)" "$APP_NAME/browser/omni.ja" 2>/dev/null \
  | { f=$(mktemp); cat > "$f"; unzip -p "$f" "chrome/browser/builtin-addons/$APP_NAME/version.js" 2>/dev/null; rm -f "$f"; } \
  | sed -n 's/^const MANTIS_RELEASE = "\([0-9]*\)".*/\1/p' || true)
[ -z "$built_release" ] && warn "nepodařilo se ověřit MANTIS_RELEASE v buildu (build před zavedením sestavení?)"
[ -n "$built_release" ] && [ "$built_release" != "$MANTIS_RELEASE" ] \
  && die "build je ze sestavení $built_release, config.sh má MANTIS_RELEASE=$MANTIS_RELEASE – udělejte nový build"

json=$(jq -n --arg v "$LW_VERSION" --argjson rel "$MANTIS_RELEASE" --arg ff "$ff_version" --arg f "$PUBLISH_FILE" \
  --argjson size "$size" --arg sha "$sha" --arg date "$(date -u +%Y-%m-%d)" \
  '{version: $v, release: $rel, firefox: $ff, file: $f, size: $size, sha256: $sha, date: $date}')

info "Nahrávám $(basename "$inst") ($((size / 1048576)) MB) na $PUBLISH_HOST:$PUBLISH_DIR"
"${SSH[@]}" "$PUBLISH_HOST" "test -w '$PUBLISH_DIR'" \
  || die "do $PUBLISH_DIR na $PUBLISH_HOST nejde zapisovat (viz hlavička skriptu)"
"${SCP[@]}" "$local_path" "$PUBLISH_HOST:$PUBLISH_DIR/$PUBLISH_FILE.part"

# Ověřit součet na serveru, pak atomicky přejmenovat (stahování nikdy nedostane půlku souboru)
printf '%s\n' "$json" | "${SSH[@]}" "$PUBLISH_HOST" "set -e; cd '$PUBLISH_DIR'
  echo '$sha  $PUBLISH_FILE.part' | sha256sum -c --quiet -
  cat > latest.json.part
  chmod 644 '$PUBLISH_FILE.part' latest.json.part
  mv -f '$PUBLISH_FILE.part' '$PUBLISH_FILE'
  mv -f latest.json.part latest.json"

info "Zveřejněno: $PUBLISH_URL/$PUBLISH_FILE (verze $LW_VERSION, SHA-256 $sha)"
