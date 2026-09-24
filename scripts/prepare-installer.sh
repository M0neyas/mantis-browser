#!/usr/bin/env bash
# Úpravy instalátoru Firefoxu (NSIS) pro Mantis Browser. Volá ho prepare-source.sh,
# jde spustit i samostatně nad už připraveným $SRC_DIR (je idempotentní).
#   - branding.nsi: název, výrobce, odkazy
#   - defines.nsi.in: AppName/AppRegName (klíče v registru) místo napevno „Firefox“
#   - vypnutý instalační a odinstalační ping Mozille
#   - registrace VPN pomocníka (native messaging) a jeho ukončení před přepsáním souborů
# Bitmapy wizHeader/wizWatermark vyrábí make-icons.sh.
set -euo pipefail
source "$(dirname "$0")/config.sh"

REPO_URL="https://github.com/M0neyas/mantis-browser"
NSIS="browser/installer/windows/nsis"
MARK="; Mantis:"  # značka našich vložených řádků (idempotence)

# !define JMÉNO "hodnota" – přepíše hodnotu; selže, když define v souboru není
nsis_define() {
  local file="$SRC_DIR/$1" name="$2" value="$3"
  grep -qE "^!define[[:space:]]+$name[[:space:]]" "$file" || die "v $1 chybí !define $name (změnila se struktura Firefoxu?)"
  NAME="$name" VALUE="$value" perl -pi -e \
    's/^(!define\s+\Q$ENV{NAME}\E\s+)".*"/$1"$ENV{VALUE}"/' "$file"
}

# Vloží text za/před kotvu, jen pokud tam ještě není (podle první řádky vkládaného textu)
insert_once() {
  local where="$1" file="$2" anchor="$3" text="$4"
  grep -qF -- "$(head -n1 <<<"$text")" "$SRC_DIR/$file" && return 0
  [ "$(grep -cF -- "$anchor" "$SRC_DIR/$file")" = 1 ] \
    || die "kotva '$anchor' není v $file právě jednou (změnila se struktura Firefoxu?)"
  if [ "$where" = after ]; then
    replace "$file" "$anchor" "$anchor
$text"
  else
    replace "$file" "$anchor" "$text
$anchor"
  fi
}

info "Instalátor: branding a názvy"
brand_nsi="browser/branding/$APP_NAME/branding.nsi"
nsis_define "$brand_nsi" BrandFullNameInternal "$APP_DISPLAYNAME"
nsis_define "$brand_nsi" BrandFullName "$APP_DISPLAYNAME"
nsis_define "$brand_nsi" CompanyName "$APP_BASENAME"
for d in URLInfoAbout HelpLink URLManualDownload URLSystemRequirements \
         URLStubDownloadX86 URLStubDownloadAMD64 URLStubDownloadAArch64; do
  nsis_define "$brand_nsi" "$d" "$REPO_URL"
done

# Klíče Software\Mozilla\<AppName>, StartMenuInternet\<AppRegName>-<hash>, RegisteredApplications –
# prohlížeč používá MOZ_APP_BASENAME, Firefox tu má napevno „Firefox“ (kolize s nainstalovaným Firefoxem)
for d in AppName DDEApplication AppRegName BrandProductName; do
  nsis_define "$NSIS/defines.nsi.in" "$d" "$APP_BASENAME"
done
grep -qF "Title=\"$APP_DISPLAYNAME\"" "$SRC_DIR/browser/installer/windows/app.tag" \
  || replace browser/installer/windows/app.tag 'Title="Mozilla Firefox"' "Title=\"$APP_DISPLAYNAME\""
grep -qF 'HKCU "Software\Mozilla\${AppName}" "Uninstalled-' "$SRC_DIR/$NSIS/uninstaller.nsi" \
  || replace "$NSIS/uninstaller.nsi" 'HKCU "Software\Mozilla\Firefox" "Uninstalled-' 'HKCU "Software\Mozilla\${AppName}" "Uninstalled-'

info "Instalátor: bez pingů Mozille"
insert_once after "$NSIS/installer.nsi" "Function SendPingIfApplicable" \
"  Return $MARK instalační ping Mozille neposíláme"
grep -qF "$MARK odinstalační ping" "$SRC_DIR/$NSIS/uninstaller.nsi" || replace "$NSIS/uninstaller.nsi" \
  '    HttpPostFile::Post $6 "Content-Type: application/json$\r$\n" $5' \
  "    Push \"disabled\" $MARK odinstalační ping Mozille neposíláme"

info "Instalátor: VPN pomocník"
# Ukončí mantis-vpn.exe a wireproxy.exe spuštěné z této instalace (jinak nejdou přepsat/smazat).
# 32bitový instalátor → 64bitový PowerShell přes sysnative (jinak nevidí cestu 64bitových procesů).
kill_vpn() {
  cat <<'EOF'
  ; Mantis: ukončit VPN (mantis-vpn.exe, wireproxy.exe) z této instalace
  StrCpy $0 "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$0"
    StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::Exec `"$0" -NoProfile -NonInteractive -Command "Get-Process wireproxy,mantis-vpn -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\vpn\*' } | Stop-Process -Force"`
  Pop $0
EOF
}
insert_once after "$NSIS/installer.nsi" 'Section "-InstallStartCleanup"' "$(kill_vpn)"
insert_once after "$NSIS/uninstaller.nsi" 'Section "Uninstall"' "$(kill_vpn)"

# Registrace pro aktuálního uživatele (stejně jako vpn/register-vpn.ps1); cesta v manifestu
# je relativní k němu, takže manifest je v balíku hotový (package-vpn.sh)
insert_once after "$NSIS/installer.nsi" \
  "ExecWait '\"\$INSTDIR\\\${FileMainEXE}\" --backgroundtask install' \$UnusedExecCatchReturn" \
'; Mantis: registrace VPN pomocníka (native messaging)
${If} ${FileExists} "$INSTDIR\vpn\cz.mantis.vpn.json"
  WriteRegStr HKCU "Software\Mozilla\NativeMessagingHosts\cz.mantis.vpn" "" "$INSTDIR\vpn\cz.mantis.vpn.json"
${EndIf}'
insert_once before "$NSIS/uninstaller.nsi" '  ${un.IsFirewallSvcRunning}' \
'  ; Mantis: odregistrovat VPN pomocníka (jen když ukazuje na tuto instalaci), smazat složku vpn
  ReadRegStr $0 HKCU "Software\Mozilla\NativeMessagingHosts\cz.mantis.vpn" ""
  ${If} $0 == "$INSTDIR\vpn\cz.mantis.vpn.json"
    DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\cz.mantis.vpn"
  ${EndIf}
  RmDir /r /REBOOTOK "$INSTDIR\vpn"'

info "Instalátor: připraven"
