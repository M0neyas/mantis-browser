#!/usr/bin/env bash
# Vygeneruje extension/eshops/coi-risky.txt – rizikové e-shopy podle České obchodní
# inspekce (https://coi.gov.cz/pro-spotrebitele/rizikove-e-shopy/). Mantis na nich ukáže
# varování (Nastavení Mantis → Nákupy). Výsledek se commituje, build ho nestahuje –
# spouštět před každým vydáním (seznam ČOI přibývá každý týden).
#
# Formát řádku: doména[/cesta]<TAB>datum zařazení (RRRR-MM-DD). S cestou platí jen pro
# tu část webu (ČOI občas varuje jen před sekcí jinak běžného webu).
set -euo pipefail
source "$(dirname "$0")/config.sh"

URL="https://coi.gov.cz/pro-spotrebitele/rizikove-e-shopy/"
OUT="$REPO_DIR/extension/eshops/coi-risky.txt"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL -A "Mozilla/5.0 (Mantis Browser list update)" "$URL" -o "$tmp" || die "nepodařilo se stáhnout $URL"

# Každý záznam: <article class="information-row"> … <p class = "list_titles"> <span>doména</span> …
# (DD. MM. RRRR). Adresy bez schématu, www a parametrů; nesmyslné položky se zahodí.
entries=$(perl -0777 -ne '
  while (/<article class="information-row".*?<\/article>/sg) {
    my $a = $&;
    my ($titles) = $a =~ /class\s*=\s*"list_titles">(.*?)<\/p>/s or next;
    my ($d, $m, $y) = $a =~ /\((\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\)/;
    my $date = defined $y ? sprintf("%04d-%02d-%02d", $y, $m, $d) : "";
    while ($titles =~ /<span>(.*?)<\/span>/sg) {
      (my $text = $1) =~ s/<[^>]+>/ /g;
      for my $e (split /[\s,;]+/, $text) {
        $e = lc $e;
        $e =~ s{^https?://}{}; $e =~ s{^www\.}{}; $e =~ s{[?#].*$}{}; $e =~ s{&amp;.*$}{}; $e =~ s{[/.]+$}{};
        next unless $e =~ m{^[a-z0-9-]+(\.[a-z0-9-]+)+(/[\w./-]*)?$};
        print "$e\t$date\n";
      }
    }
  }' "$tmp" | sort -t$'\t' -k1,1 -u)
count=$(printf '%s\n' "$entries" | grep -c .)
[ "$count" -gt 500 ] || die "seznam má jen $count položek – změnila se stránka ČOI?"

mkdir -p "$(dirname "$OUT")"
{
  echo "# Rizikové e-shopy podle České obchodní inspekce – Mantis na nich ukáže varování."
  echo "# Vygenerováno scripts/update-eshop-list.sh ($(date -u +%Y-%m-%d)), $count položek."
  echo "# Zdroj: $URL"
  echo "# Informace zveřejněná orgánem státní správy (Česká obchodní inspekce)."
  echo "# Formát: doména[/cesta]<TAB>datum zařazení ČOI"
  printf '%s\n' "$entries"
} > "$OUT"

info "$OUT: $count položek ($(du -h "$OUT" | cut -f1))"
