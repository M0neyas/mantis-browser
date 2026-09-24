#!/usr/bin/env bash
# Vyrobí z branding/logo.svg všechny ikony, které potřebuje branding Firefoxu.
# Použití: make-icons.sh <výstupní složka>
set -euo pipefail
source "$(dirname "$0")/config.sh"

out="${1:?Použití: make-icons.sh <výstupní složka>}"
logo="$REPO_DIR/branding/logo.svg"
mkdir -p "$out/content"

command -v rsvg-convert >/dev/null || die "chybí rsvg-convert (spusťte scripts/setup-wsl.sh)"
if command -v magick >/dev/null; then IM=(magick); else IM=(convert); fi

png() { rsvg-convert -w "$1" -h "$1" "$logo" -o "$2"; }

info "Generuji ikony z branding/logo.svg…"
for s in 16 22 24 32 48 64 128 256; do
  png "$s" "$out/default$s.png"
done

# .ico pro Windows (všechny velikosti v jednom souboru)
"${IM[@]}" "$out"/default{16,24,32,48,64,128,256}.png "$out/firefox.ico"
cp "$out/firefox.ico" "$out/firefox64.ico"
cp "$out/firefox.ico" "$out/document.ico"

# Dlaždice v nabídce Start
png 70  "$out/VisualElements_70.png"
png 150 "$out/VisualElements_150.png"

# Okno „O aplikaci“
png 192 "$out/content/about-logo.png"
png 384 "$out/content/about-logo@2x.png"
cp "$logo" "$out/content/about-logo.svg"
cp "$REPO_DIR/branding/about-wordmark.svg" "$out/content/about-wordmark.svg"
cp "$REPO_DIR/branding/about-wordmark.svg" "$out/content/firefox-wordmark.svg"
png 128 "$out/content/about.png"

# MSIX (Microsoft Store, Start): logo na průhledném plátně W×H, logo zabírá P % kratší strany
tile() {
  local w="$1" h="$2" pct="$3" name="$4" side
  side=$(( (w < h ? w : h) * pct / 100 ))
  rsvg-convert -w "$side" -h "$side" "$logo" -o "$out/msix/Assets/.tmp.png"
  "${IM[@]}" "$out/msix/Assets/.tmp.png" -background none -gravity center -extent "${w}x${h}" \
    "$out/msix/Assets/$name"
  rm "$out/msix/Assets/.tmp.png"
}
mkdir -p "$out/msix/Assets"
tile 88 88 100   Square44x44Logo.scale-200.png
tile 256 256 100 Square44x44Logo.targetsize-256.png
tile 256 256 100 Square44x44Logo.altform-unplated_targetsize-256.png
tile 256 256 100 Square44x44Logo.altform-lightunplated_targetsize-256.png
tile 88 88 100   Document44x44.png
tile 142 142 70  SmallTile.scale-200.png
tile 300 300 60  Square150x150Logo.scale-200.png
tile 620 300 60  Wide310x150Logo.scale-200.png
tile 620 620 50  LargeTile.scale-200.png
tile 100 100 100 StoreLogo.scale-200.png

# Instalátor (NSIS): 24bitové BMP bez průhlednosti
bmp() {
  rsvg-convert "$REPO_DIR/branding/$1" -o "$out/$2.png"
  "${IM[@]}" "$out/$2.png" -background white -alpha remove -alpha off -type TrueColor "BMP3:$out/$2"
  rm "$out/$2.png"
}
bmp installer-watermark.svg wizWatermark.bmp
bmp installer-header.svg wizHeader.bmp
"${IM[@]}" "$out/wizHeader.bmp" -flop -type TrueColor "BMP3:$out/wizHeaderRTL.bmp"
