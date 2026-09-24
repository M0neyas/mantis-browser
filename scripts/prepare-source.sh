#!/usr/bin/env bash
# Připraví zdrojáky Mantis Browseru:
#   1. stáhne a ověří zdrojový balík LibreWolfu (Firefox + patche LibreWolfu)
#   2. přejmenuje aplikaci (mantis.exe, vlastní profil – nekoliduje s LibreWolfem)
#   3. nasadí náš branding, nastavení, vzhled a patche
#   4. sestaví mozconfig pro cross-compilaci na Windows
#
# Každé spuštění začíná od čistých zdrojáků (smaže $SRC_DIR).
# Když se nějaká úprava nedá aplikovat (LibreWolf změnil strukturu),
# skript skončí chybou s popisem – nic se tiše nepřeskočí.
set -euo pipefail
source "$(dirname "$0")/config.sh"

for cmd in curl jq perl patch sha256sum tar; do
  command -v "$cmd" >/dev/null || die "chybí $cmd (spusťte scripts/setup-wsl.sh)"
done

# ---------------------------------------------------------------------------
info "1/7 Zdrojový balík LibreWolfu $LW_VERSION"
dl="$WORK_DIR/download"
tarball="$dl/librewolf-$LW_VERSION.source.tar.gz"
mkdir -p "$dl"
if [ ! -f "$tarball" ]; then
  curl -fL --retry 3 -o "$tarball.part" "$LW_SOURCE_URL"
  mv "$tarball.part" "$tarball"
fi
[[ "$LW_SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || die "v config.sh chybí LW_SOURCE_SHA256 (scripts/check-update.sh --apply ho doplní)"
actual=$(sha256sum "$tarball" | awk '{print $1}')
[ "$LW_SOURCE_SHA256" = "$actual" ] \
  || die "SHA-256 balíku nesedí s LW_SOURCE_SHA256 v config.sh – smažte $tarball a zkuste znovu; když se to opakuje, balík na serveru se změnil – nepokračujte"

info "2/7 Rozbaluji do $SRC_DIR"
if [ -e "$WORK_DIR/src" ] && [ ! -w "$WORK_DIR/src" ]; then
  sudo rm -rf "$WORK_DIR/src"   # po buildu v Dockeru mohou soubory patřit rootovi
fi
rm -rf "$WORK_DIR/src"
mkdir -p "$WORK_DIR/src"
tar xf "$tarball" -C "$WORK_DIR/src"
[ -d "$SRC_DIR" ] || die "v balíku chybí složka librewolf-$LW_VERSION"

# Překlady (--with-l10n-base=lw/l10n). Balík LibreWolfu je obsahuje; kdyby ne,
# doplníme je z Mozilly, jinak by package-multi-locale nevyrobil češtinu.
for loc in $LOCALES; do
  [ "$loc" = "en-US" ] && continue
  if [ ! -d "$SRC_DIR/lw/l10n/$loc" ]; then
    warn "v balíku chybí překlad $loc – stahuji firefox-l10n"
    command -v git >/dev/null || die "chybí git"
    rm -rf "$SRC_DIR/lw/l10n.tmp"
    git clone --depth 1 https://github.com/mozilla-l10n/firefox-l10n.git "$SRC_DIR/lw/l10n.tmp"
    mkdir -p "$SRC_DIR/lw/l10n"
    cp -rn "$SRC_DIR/lw/l10n.tmp/." "$SRC_DIR/lw/l10n/"
    rm -rf "$SRC_DIR/lw/l10n.tmp"
    [ -d "$SRC_DIR/lw/l10n/$loc" ] || die "překlad $loc se nepodařilo doplnit"
  fi
done

# ---------------------------------------------------------------------------
info "3/7 Přejmenování LibreWolf → $APP_DISPLAYNAME"
# mozconfig: název exe, branding, remoting (aby okna nekolidovala s LibreWolfem)
replace mozconfig "--with-app-name=librewolf"            "--with-app-name=$APP_NAME"
replace mozconfig "--with-branding=browser/branding/librewolf" "--with-branding=browser/branding/$APP_NAME"
replace mozconfig "MOZ_APP_REMOTINGNAME=LibreWolf"       "MOZ_APP_REMOTINGNAME=$APP_BASENAME"
# vendor a název profilu (LibreWolf je nastavuje patchem moz-configure.patch)
replace toolkit/moz.configure 'default="LibreWolf"'      "default=\"$APP_BASENAME\""
replace toolkit/moz.configure 'default="librewolf"'      "default=\"$APP_NAME\""
# cesty ke složkám aplikace (patch mozilla_dirs.patch)
replace toolkit/xre/nsXREDirProvider.cpp '"LibreWolf"'   "\"$APP_BASENAME\""
replace toolkit/xre/nsXREDirProvider.cpp '.librewolf'    ".$APP_NAME"
# uživatelský soubor s přepsáním nastavení: %USERPROFILE%\.mantis\mantis.overrides.cfg
replace extensions/pref/autoconfig/src/prefcalls.js '.librewolf/librewolf.overrides.cfg' ".$APP_NAME/$APP_NAME.overrides.cfg"

# ---------------------------------------------------------------------------
info "4/7 Branding"
brand="$SRC_DIR/browser/branding/$APP_NAME"
cp -a "$SRC_DIR/browser/branding/librewolf" "$brand"

cat > "$brand/configure.sh" <<EOF
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_NAME=$APP_NAME
MOZ_APP_BASENAME=$APP_BASENAME
MOZ_APP_DISPLAYNAME=$APP_BASENAME
MOZ_APP_REMOTINGNAME=$APP_NAME
EOF

icons="$WORK_DIR/icons"
rm -rf "$icons"
"$REPO_DIR/scripts/make-icons.sh" "$icons"
# kopírujeme jen soubory, které v brandingu LibreWolfu existují (build je očekává)
(cd "$icons" && find . -type f) | while read -r f; do
  if [ -f "$brand/$f" ]; then cp "$icons/$f" "$brand/$f"; else warn "branding nepoužívá $f – přeskočeno"; fi
done

# Texty: „LibreWolf“ → „Mantis Browser“, výrobce jen „Mantis“
brand_texts=$(find "$brand/locales" "$SRC_DIR/lw/l10n" -path '*branding*' \
  \( -name 'brand.ftl' -o -name 'brand.properties' -o -name 'brand.dtd' \) 2>/dev/null || true)
[ -n "$brand_texts" ] || die "nenašel jsem soubory brand.ftl/properties/dtd"
# Celý soubor najednou (-0777): v některých jazycích (cs) má -vendor-short-name
# víceřádkovou hodnotu s pády a atributy (odsazené řádky) – nahradí se celý term.
for f in $brand_texts; do
  NAME="$APP_DISPLAYNAME" VENDOR="$APP_BASENAME" perl -0777 -pi -e '
    s/LibreWolf/$ENV{NAME}/g;
    s/^-vendor-short-name[ \t]*=.*\n(?:[ \t]+.*\n)*/-vendor-short-name = $ENV{VENDOR}\n/mg;
    s/^(vendorShortName[ \t]*=[ \t]*).*/$1$ENV{VENDOR}/mg;
    s/(<!ENTITY\s+vendorShortName\s+")[^"]*/$1$ENV{VENDOR}/g;
  ' "$f"
done
for f in $brand_texts; do
  case "$f" in
    *.ftl) grep -qE "^-vendor-short-name = $APP_BASENAME\$" "$f" || ! grep -q '^-vendor-short-name' "$f" \
      || die "přejmenování výrobce v $f se nepovedlo" ;;
  esac
done
grep -q "$APP_DISPLAYNAME" "$brand/locales/en-US/brand.ftl" || die "přejmenování v brand.ftl se nepovedlo"

# Texty, které LibreWolf přidává do UI s názvem napevno (sekce „LibreWolf“ v nastavení,
# okno O aplikaci…) → Mantis Browser. Firefox sám „LibreWolf“ v textech nemá, takže stačí
# soubory, které to slovo obsahují (ID zpráv jako pane-librewolf-title2 zůstanou – malá
# písmena). Pravidlo Microsoft Store 10.1.1: nevydávat se za jiný produkt.
lw_texts=$(grep -rlF --include='*.ftl' --include='*.properties' --include='*.dtd' 'LibreWolf' \
  "$SRC_DIR/browser/locales/en-US" "$SRC_DIR/toolkit/locales/en-US" "$SRC_DIR/lw/l10n" 2>/dev/null \
  | grep -v '/branding/' || true)
if [ -n "$lw_texts" ]; then
  for f in $lw_texts; do
    NAME="$APP_DISPLAYNAME" perl -pi -e 's/LibreWolf/$ENV{NAME}/g' "$f"
  done
  echo "    „LibreWolf“ → „$APP_DISPLAYNAME“ v $(printf '%s\n' "$lw_texts" | grep -c .) souborech s texty"
else
  warn "v textech UI jsem nenašel „LibreWolf“ – změnila se struktura překladů LibreWolfu?"
fi

# Ikony s logem LibreWolfu / Firefoxu v UI → kudlanka (pravidlo Storu 10.1.1, známka Firefoxu):
#  - sidebar/librewolf.svg = chrome://browser/skin/sidebar/firefox.svg (jar.inc.mn): Nastavení →
#    O aplikaci, Vzhled, Jazyky, nabídka postranního panelu; sidebar/firefox.svg pro jistotu taky
#  - preferences/category-librewolf.svg: sekce Mantis Browser v Nastavení
#  - icons/window-firefox.svg (okno s logem Firefoxu): Nastavení → Domů, nová karta
#  - aboutdebugging-firefox-librewolf.svg: about:debugging → „Tento Mantis Browser“
for f in browser/themes/shared/sidebar/librewolf.svg browser/themes/shared/sidebar/firefox.svg \
         browser/themes/shared/preferences/category-librewolf.svg; do
  [ -f "$SRC_DIR/$f" ] || die "chybí $f – změnily se ikony LibreWolfu?"
  cp "$REPO_DIR/branding/logo-mono.svg" "$SRC_DIR/$f"
done
[ -f "$SRC_DIR/browser/themes/shared/icons/window-firefox.svg" ] || die "chybí icons/window-firefox.svg"
cp "$REPO_DIR/branding/window.svg" "$SRC_DIR/browser/themes/shared/icons/window-firefox.svg"
[ -f "$SRC_DIR/devtools/client/themes/images/aboutdebugging-firefox-librewolf.svg" ] || die "chybí aboutdebugging-firefox-librewolf.svg"
cp "$REPO_DIR/branding/logo.svg" "$SRC_DIR/devtools/client/themes/images/aboutdebugging-firefox-librewolf.svg"

# Obecná nápověda → stránka Mantisu ($HELP_URL): témata „preferences“ (Nastavení → Nápověda,
# Podpora → Získat pomoc, „Potřebujete pomoc?“ ve výsledcích hledání) a „firefox-help“
# (Nápověda → Získat pomoc, F1). Ostatní témata („Zjistit více“) dál přes app.support.baseURL.
replace toolkit/content/widgets/moz-support-link/moz-support-link.mjs \
  '    let base = MozSupportLink.SUPPORT_URL + supportPage;' \
  "    // Mantis: obecná nápověda na vlastní stránku
    let base = [\"preferences\", \"firefox-help\"].includes(supportPage)
      ? \"$HELP_URL\"
      : MozSupportLink.SUPPORT_URL + supportPage;"
replace browser/base/content/utilityOverlay.js \
  '  var url = Services.urlFormatter.formatURLPref("app.support.baseURL");' \
  "  // Mantis: obecná nápověda na vlastní stránku
  if (aHelpTopic == \"firefox-help\" || aHelpTopic == \"preferences\") {
    return \"$HELP_URL\";
  }
  var url = Services.urlFormatter.formatURLPref(\"app.support.baseURL\");"

# ---------------------------------------------------------------------------
info "5/7 Nastavení a policies"
cfg="$SRC_DIR/lw/librewolf.cfg"
[ -f "$cfg" ] || die "chybí lw/librewolf.cfg"
{
  printf '\n\n/** ---------- Mantis Browser (settings/mantis.cfg) ---------- */\n'
  cat "$REPO_DIR/settings/mantis.cfg"
} >> "$cfg"

pol="$SRC_DIR/lw/policies.json"
[ -f "$pol" ] || die "chybí lw/policies.json"
# hluboké sloučení objektů (naše položky se přidají k LibreWolfím)
jq -s '.[0] * .[1]' "$pol" "$REPO_DIR/settings/policies.json" > "$pol.new"
mv "$pol.new" "$pol"
jq -e '.policies.ExtensionSettings["uBlock0@raymondhill.net"]' "$pol" >/dev/null \
  || die "po sloučení policies zmizel uBlock Origin"

# ---------------------------------------------------------------------------
info "6/7 Vzhled a vlastní patche"
theme_target="$SRC_DIR/browser/themes/shared/browser-shared.css"
[ -f "$theme_target" ] || die "chybí browser/themes/shared/browser-shared.css (změnila se struktura Firefoxu?)"
{
  printf '\n/* ---------- Mantis Browser (theme/userChrome.css) ---------- */\n'
  cat "$REPO_DIR/theme/userChrome.css"
} >> "$theme_target"

# Připnutá rozšíření do 2. řádku (lišta záložek) místo horní lišty:
# tlačítko „Připnout na lištu“, zaškrtávátko po instalaci i default_area "navbar"
replace browser/base/content/browser-addons.js \
  "? CustomizableUI.AREA_NAVBAR" "? CustomizableUI.AREA_BOOKMARKS"
replace browser/base/content/browser-addons.js \
  "if (shouldPinToToolbar && area !== CustomizableUI.AREA_NAVBAR)" \
  "if (shouldPinToToolbar && area !== CustomizableUI.AREA_BOOKMARKS)"
replace browser/components/extensions/parent/ext-browserAction.js \
  "navbar: CustomizableUI.AREA_NAVBAR," "navbar: CustomizableUI.AREA_BOOKMARKS,"

# Vestavěné rozšíření Mantis (nová karta, kontrola verzí) – Firefox ho najde
# v builtin-addons/ a nainstaluje sám (generuje built_in_addons.json)
ext="$SRC_DIR/browser/extensions/$APP_NAME"
mkdir -p "$ext"
cp -a "$REPO_DIR/extension" "$ext/extension"
[ -z "$MANTIS_RELEASE_PUBKEY" ] || [[ "$MANTIS_RELEASE_PUBKEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] \
  || die "MANTIS_RELEASE_PUBKEY v config.sh není veřejný klíč Ed25519 v base64 (scripts/release-key.sh)"
[ -n "$MANTIS_RELEASE_PUBKEY" ] \
  || warn "MANTIS_RELEASE_PUBKEY je prázdný – build nebude ověřovat podpis vydání (bez instalace jedním kliknutím)"
LW="$LW_VERSION" REL="$MANTIS_RELEASE" KEY="$MANTIS_RELEASE_PUBKEY" perl -pi -e \
  's/\@LW_VERSION\@/$ENV{LW}/g; s/\@MANTIS_RELEASE\@/$ENV{REL}/g; s/\@RELEASE_PUBKEY\@/$ENV{KEY}/g' \
  "$ext/extension/version.js"
grep -q "\"$LW_VERSION\"" "$ext/extension/version.js" && grep -q "\"$MANTIS_RELEASE\"" "$ext/extension/version.js" \
  && ! grep -q "@RELEASE_PUBKEY@" "$ext/extension/version.js" \
  || die "nepodařilo se dosadit verzi do extension/version.js"
cat > "$ext/moz.build" <<'EOF'
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

JAR_MANIFESTS += ["jar.mn"]
EOF
cat > "$ext/jar.mn" <<EOF
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

browser.jar:
    builtin-addons/$APP_NAME/ (extension/**)
EOF
replace browser/extensions/moz.build "DIRS += [" "DIRS += [
    \"$APP_NAME\","

# Výchozí rozložení lišt (settings/mantis.cfg) předpokládá tuto verzi CustomizableUI
cui="$SRC_DIR/browser/components/customizableui/CustomizableUI.sys.mjs"
grep -qE 'kVersion = 26;' "$cui" || warn "CustomizableUI už nemá kVersion 26 – zkontrolujte browser.uiCustomization.state v settings/mantis.cfg"

shopt -s nullglob
for p in "$REPO_DIR"/patches/*.patch; do
  echo "    patch $(basename "$p")"
  (cd "$SRC_DIR" && patch -p1 --forward --batch -i "$p") || die "patch $(basename "$p") nejde aplikovat"
done
shopt -u nullglob

# Instalátor (NSIS): názvy, bez pingů Mozille, registrace VPN
"$REPO_DIR/scripts/prepare-installer.sh"

# MSIX (Microsoft Store, build.sh --msix). msix.py je už upravený patchem LibreWolfu
# msix.patch (identita, distribution/, verze); navíc název balíčku z MSIX_DISPLAYNAME
# („Mantis Browser“ – musí sedět s názvem v Partner Center) místo Name z application.ini.
# Jen varování: normální build (zip, NSIS) MSIX nepotřebuje.
msix_py=python/mozbuild/mozbuild/repackaging/msix.py
if grep -qF '    displayname = displayname or first' "$SRC_DIR/$msix_py" 2>/dev/null; then
  replace "$msix_py" '    displayname = displayname or first' \
    '    displayname = displayname or os.environ.get("MANTIS_MSIX_DISPLAYNAME") or first'
else
  warn "$msix_py se změnil – MSIX by se jmenoval „$APP_BASENAME“ místo „$MSIX_DISPLAYNAME“"
fi

# ---------------------------------------------------------------------------
info "7/7 mozconfig pro Windows"
winmoz="$WORK_DIR/download/windows.mozconfig"
got=""
for url in "${BSYS6_RAW_URLS[@]}"; do
  if curl -fsSL -o "$winmoz" "$url"; then got="$url"; break; fi
done
[ -n "$got" ] || die "nepodařilo se stáhnout windows.mozconfig z bsys6"
[ "$got" = "${BSYS6_RAW_URLS[0]}" ] || warn "windows.mozconfig stažen z větve master, ne z tagu $LW_VERSION"
{
  printf '\n# ---------- Windows x86_64 (bsys6 assets/windows.mozconfig) ----------\n'
  echo "ac_add_options --target=x86_64-pc-windows-msvc"
  cat "$winmoz"
} >> "$SRC_DIR/mozconfig"

info "Zdrojáky připravené: $SRC_DIR"
echo "Další krok: scripts/build.sh"
