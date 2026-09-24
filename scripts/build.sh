#!/usr/bin/env bash
# Zkompiluje připravené zdrojáky v Docker image LibreWolfu a zabalí je do zipu.
# Předpoklad: scripts/prepare-source.sh proběhl.
#
# Výstup: $OUT_DIR/mantis-*.win64.zip (rozbalit a spustit mantis.exe),
# $OUT_DIR/mantis-*.win64.installer.exe (instalátor) a kopie do složky
# Stažené soubory ve Windows. Celý výpis: $OUT_DIR/build.log
#
# --msix: navíc balíček MSIX pro Microsoft Store (viz STORE.md). S MSIX_STORE=false
#         testovací (nepodepsaný, Add-AppxPackage -AllowUnsigned na Windows 11).
set -euo pipefail
source "$(dirname "$0")/config.sh"

build_msix=false
for arg in "$@"; do
  case "$arg" in
    --msix) build_msix=true ;;
    *) die "neznámý parametr $arg (umím jen --msix)" ;;
  esac
done

# Verze MSIX: msix.patch LibreWolfu převádí „X.Y.Z-R“ na X.(100Y+Z).(100R).0, Store chce
# rostoucí čísla ≤ 65535 → R = 100 × release LibreWolfu + MANTIS_RELEASE
lw_rel=${LW_VERSION##*-}
msix_version="${LW_VERSION%-*}-$(( lw_rel * 100 + MANTIS_RELEASE ))"
msix_unsigned=""
$MSIX_STORE || msix_unsigned="--unsigned"

[ -f "$SRC_DIR/mozconfig" ] || die "chybí připravené zdrojáky – nejdřív spusťte scripts/prepare-source.sh"

# Docker: bez systemd ve WSL se po restartu sám nespustí
if ! docker info >/dev/null 2>&1; then
  info "Spouštím Docker…"
  sudo service docker start >/dev/null 2>&1 || sudo systemctl start docker || true
  sleep 3
  docker info >/dev/null 2>&1 || die "Docker neběží nebo nemáte oprávnění (po setup-wsl.sh je potřeba 'wsl --shutdown' a znovu otevřít Ubuntu)"
fi

mkdir -p "$OUT_DIR"
log="$OUT_DIR/build.log"
start=$(date +%s)

# ---------------------------------------------------------------------------
# 1) VPN (pomocník + wireproxy) – trvá chvilku, proto před dlouhým buildem.
#    Když selže, prohlížeč se zabalí i tak, jen bez VPN.
vpn_ok=true
if ! "$REPO_DIR/scripts/package-vpn.sh"; then
  vpn_ok=false
  warn "VPN se nepodařilo připravit – prohlížeč se zabalí bez složky vpn (tlačítko VPN ohlásí chybějícího pomocníka)"
fi

# ---------------------------------------------------------------------------
# 2) Prohlížeč
info "Build v Dockeru ($BSYS6_IMAGE) – první build na 8jádrovém CPU se SSD zhruba 30–60 min"
info "Výpis se ukládá do $log"

# Vše v jednom běhu kontejneru: virtualenv mach je v /root/.mozbuild a --rm ho smaže.
#   build → zip (cs + en-US) → přibalit VPN (/out/vpn) → instalátor (NSIS, česky)
# Selhání instalátoru build nezastaví, zip zůstane (značka /out/installer-failed).
rm -f "$OUT_DIR/installer-failed" "$OUT_DIR/msix-failed" "$OUT_DIR"/*.msix
if ! docker run --rm \
  -v "$SRC_DIR":/src -v "$OUT_DIR":/out -w /src \
  -e MOZBUILD=/root/.mozbuild \
  -e MOZBUILD_STATE_PATH=/root/.mozbuild \
  -e LOCALES="$LOCALES" -e APP_NAME="$APP_NAME" -e VPN_OK="$vpn_ok" \
  -e INSTALLER_LOCALE="$INSTALLER_LOCALE" \
  -e BUILD_MSIX="$build_msix" -e MSIX_VERSION="$msix_version" -e MSIX_UNSIGNED="$msix_unsigned" \
  -e MSIX_IDENTITY_NAME="$MSIX_IDENTITY_NAME" -e MSIX_PUBLISHER="$MSIX_PUBLISHER" \
  -e MSIX_PUBLISHER_DISPLAY_NAME="$MSIX_PUBLISHER_DISPLAY_NAME" \
  -e MANTIS_MSIX_DISPLAYNAME="$MSIX_DISPLAYNAME" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$BSYS6_IMAGE" \
  bash -euo pipefail -c '
    export PATH="/root/.cargo/bin:$PATH"
    trap "chown -R \"$HOST_UID:$HOST_GID\" /src /out" EXIT
    obj=/src/obj-x86_64-pc-windows-msvc
    ./mach --no-interactive build
    rm -f "$obj"/dist/*.win64.zip "$obj"/dist/*.installer.exe
    ./mach --no-interactive package-multi-locale --locales $LOCALES
    zip=$(ls "$obj"/dist/*.win64.zip)
    unzip -l "$zip" "$APP_NAME/$APP_NAME.exe" >/dev/null || { echo "zip nemá složku $APP_NAME/"; exit 1; }
    if [ "$VPN_OK" = true ]; then
      stage=$(mktemp -d)
      mkdir "$stage/$APP_NAME" && cp -a /out/vpn "$stage/$APP_NAME/vpn"
      (cd "$stage" && zip -qr "$zip" "$APP_NAME/vpn")
      rm -rf "$stage"
    fi
    echo "==> Instalátor ($INSTALLER_LOCALE)"
    # texty z adresáře sloučeného při package-multi-locale (jinak ho nastavuje jen l10n.mk)
    gmake -C "$obj/browser/installer/windows" installer ZIP_IN="$zip" AB_CD="$INSTALLER_LOCALE" \
      REAL_LOCALE_MERGEDIR="$obj/browser/locales/merge-dir/$INSTALLER_LOCALE" \
      || touch /out/installer-failed
    if [ "$BUILD_MSIX" = true ]; then
      # Microsoft Store: ze stejného zipu (i s VPN), makemsix z image (linux64-msix-packaging)
      echo "==> MSIX $MSIX_VERSION (${MSIX_UNSIGNED:-pro Store})"
      makemsix=/root/.mozbuild/msix-packaging/makemsix
      [ -x "$makemsix" ] || makemsix=$(command -v makemsix || true)
      ./mach --no-interactive repackage msix --input "$zip" --channel unofficial --arch x86_64 \
        --version "$MSIX_VERSION" --identity-name "$MSIX_IDENTITY_NAME" \
        --publisher "$MSIX_PUBLISHER" --publisher-display-name "$MSIX_PUBLISHER_DISPLAY_NAME" \
        --makeappx "$makemsix" $MSIX_UNSIGNED \
        --output "/out/$APP_NAME-$MSIX_VERSION.x64.msix" \
        || touch /out/msix-failed
    fi
  ' 2>&1 | tee "$log"; then
  echo
  warn "build selhal – posledních 40 řádků:"
  tail -n 40 "$log" >&2
  die "celý výpis je v $log (pošlete ho Claudovi)"
fi

dist="$SRC_DIR/obj-x86_64-pc-windows-msvc/dist"
shopt -s nullglob
# package-multi-locale si sám udělá i anglický instalátor ze zipu bez VPN – ten nechceme
outputs=("$dist"/*.win64.zip "$dist"/*."$INSTALLER_LOCALE".win64.installer.exe)
[ ${#outputs[@]} -gt 0 ] || die "v $dist nevznikl žádný zip"
rm -f "$OUT_DIR"/*.win64.zip "$OUT_DIR"/*.installer.exe
cp "${outputs[@]}" "$OUT_DIR/"
for i in "${!outputs[@]}"; do outputs[$i]="$OUT_DIR/$(basename "${outputs[$i]}")"; done
msix_files=("$OUT_DIR"/*.msix)   # MSIX zapisuje kontejner rovnou do $OUT_DIR
shopt -u nullglob
outputs+=("${msix_files[@]}")

mins=$(( ($(date +%s) - start) / 60 ))
info "Hotovo za $mins min:"
printf '    %s\n' "${outputs[@]}"
$vpn_ok || warn "zip je bez VPN – viz chyba z package-vpn.sh výše"
[ -f "$OUT_DIR/installer-failed" ] && warn "instalátor se nepodařilo sestavit (zip je v pořádku) – chyba v $log"
[ -f "$OUT_DIR/msix-failed" ] && warn "MSIX se nepodařilo sestavit (zip a instalátor jsou v pořádku) – chyba v $log"
if $build_msix && [ ${#msix_files[@]} -gt 0 ] && ! $MSIX_STORE; then
  info "Testovací MSIX (Windows 11, PowerShell): Add-AppxPackage -AllowUnsigned <cesta k .msix>"
fi

# Kopie do Windows (Stažené soubory\Mantis)
if command -v wslpath >/dev/null && command -v cmd.exe >/dev/null; then
  win_home=$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')
  if [ -n "$win_home" ]; then
    target="$(wslpath "$win_home")/Downloads/Mantis"
    mkdir -p "$target"
    rm -f "$target"/*.win64.zip "$target"/*.installer.exe "$target"/*.msix
    cp "${outputs[@]}" "$target/"
    info "Zkopírováno do Windows: $win_home\Downloads\Mantis"
  fi
fi
