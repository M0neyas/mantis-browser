# Branding

- **Název:** Mantis Browser
- `logo.svg` – hlavní logo (písmeno M jako kudlanka: krajní tahy = nohy, střed = trojúhelníková hlava s očima a tykadly; zaoblený čtverec, zelený přechod `#4ADE80` → `#166534`). Zdroj pro všechny ikony.
- `wordmark.svg` – logo s názvem pro okno „O aplikaci“. Text je zatím
  písmem systému – před buildem převést na křivky, aby nezávisel na fontech.

## Co z loga vyrobí build skript (ve WSL)

| Soubor v brandingu Firefoxu | Z čeho |
|---|---|
| `default16/22/24/32/48/64/128/256.png` | `logo.svg` |
| `firefox.ico`, `document.ico` (Windows, 16–256 px) | `logo.svg` |
| `VisualElements_70.png`, `VisualElements_150.png` (dlaždice Start) | `logo.svg` |
| `content/about-logo.png`, `about-logo@2x.png` | `logo.svg` |
| `content/about-wordmark.svg` | `wordmark.svg` |
| obrázky instalátoru (`wizHeader.bmp`, `wizWatermark.bmp`) | `logo.svg` |
