// Hlasitost karty – mixér přímo v prohlížeči (kontextová nabídka karty).
// Nastavuje BrowsingContext.mediaVolume (patches/tab-volume.patch) přes mantisPrefs:
// Gecko ztiší všechna videa, audio i Web Audio v kartě a web o tom neví – na rozdíl
// od rozšíření, která zvuk stránky přesměrují přes vlastní Web Audio (rozbité celé
// obrazovky, CORS). Hlasitost platí, dokud je karta otevřená, i po přechodu na jiný web.

const VOLUME_MENU = "mantis-tab-volume";
const VOLUME_LEVELS = [100, 75, 50, 25, 10];
const volumeItem = level => `${VOLUME_MENU}-${level}`;

browser.menus.create({ id: VOLUME_MENU, title: t("volume_menu"), contexts: ["tab"] });
for (const level of VOLUME_LEVELS) {
  browser.menus.create({
    id: volumeItem(level),
    parentId: VOLUME_MENU,
    type: "radio",
    title: t("volume_level", String(level)),
    contexts: ["tab"],
  });
}

// Aktuální hlasitost karty v nabídce; build bez patche nabídku skryje
browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.menuIds.includes(VOLUME_MENU) || !tab) {
    return;
  }
  const volume = await browser.mantisPrefs.getTabVolume(tab.id).catch(() => null);
  if (volume === null) {
    browser.menus.update(VOLUME_MENU, { visible: false });
    browser.menus.refresh();
    return;
  }
  browser.menus.update(VOLUME_MENU, {
    visible: true,
    title: volume === 100 ? t("volume_menu") : t("volume_menuValue", String(volume)),
  });
  // nejbližší úroveň (hlasitost mohla přijít i odjinud)
  const nearest = VOLUME_LEVELS.reduce((a, b) => (Math.abs(b - volume) < Math.abs(a - volume) ? b : a));
  for (const level of VOLUME_LEVELS) {
    browser.menus.update(volumeItem(level), { checked: level === nearest });
  }
  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info, tab) => {
  const level = VOLUME_LEVELS.find(l => info.menuItemId === volumeItem(l));
  if (level !== undefined && tab) {
    browser.mantisPrefs.setTabVolume(tab.id, level).catch(e => console.error(e));
  }
});
