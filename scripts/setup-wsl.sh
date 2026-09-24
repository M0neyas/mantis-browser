#!/usr/bin/env bash
# Jednorázová příprava WSL2 (Ubuntu) pro build.
# Nainstaluje Docker a nástroje, stáhne buildovací image LibreWolfu.
set -euo pipefail
source "$(dirname "$0")/config.sh"

grep -qi microsoft /proc/version || warn "tohle nevypadá na WSL – skript je psaný pro WSL2 Ubuntu"

case "$REPO_DIR" in
  /mnt/*) die "repozitář je na disku Windows ($REPO_DIR). Naklonujte ho do WSL: cd ~ && git clone https://github.com/M0neyas/mantis-browser" ;;
esac

info "Instaluji balíčky (Docker, git, jq, převod SVG → PNG/ICO)…"
sudo apt-get update
sudo apt-get install -y docker.io git curl jq perl patch pigz xz-utils zip unzip \
  librsvg2-bin imagemagick

info "Spouštím Docker…"
sudo systemctl enable --now docker 2>/dev/null || sudo service docker start
sudo usermod -aG docker "$USER"

info "Kontroluji prostředky…"
mem_gb=$(free -g | awk '/^Mem:/ {print $2}')
echo "    paměť WSL: ${mem_gb} GB (doporučeno 16+ GB, ideálně 24+ GB)"
[ "$mem_gb" -ge 16 ] || warn "málo paměti – zvyšte memory= v %USERPROFILE%\\.wslconfig (viz BUILD.md)"
# df ve WSL ukazuje velikost virtuálního disku, ne volné místo ve Windows
echo "    místo: build potřebuje ~80 GB na disku Windows, kde leží ext4.vhdx"
echo "           Ubuntu (viz BUILD.md) – zkontrolujte ve Windows"

mkdir -p "$WORK_DIR"

info "Stahuji buildovací image $BSYS6_IMAGE (jednotky GB, chvíli to potrvá)…"
sudo docker pull "$BSYS6_IMAGE"
sudo docker pull "$GO_IMAGE"   # kompilace VPN pomocníka

info "Hotovo."
echo "Teď ve Windows spusťte 'wsl --shutdown', znovu otevřete Ubuntu"
echo "(aby platilo členství ve skupině docker) a pokračujte podle BUILD.md."
