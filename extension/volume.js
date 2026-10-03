// Hlasitost karty – mixér přímo v prohlížeči. Pravý klik na kartu → „Hlasitost karty…“
// otevře u karty panel s posuvníkem 0–200 % (a dalšími kartami, které hrají).
// Nastavuje BrowsingContext.mediaVolume (patches/tab-volume.patch) přes mantisPrefs:
// Gecko ztiší/zesílí všechna videa, audio i Web Audio v kartě a web o tom neví – na rozdíl
// od rozšíření, která zvuk stránky přesměrují přes vlastní Web Audio (rozbitá celá
// obrazovka, CORS). Hlasitost platí, dokud je karta otevřená, i po přechodu na jiný web.

const VOLUME_MENU = "mantis-tab-volume";

browser.menus.create({ id: VOLUME_MENU, title: t("volume_menu"), contexts: ["tab"] });

// Aktuální hlasitost v názvu položky; build bez patche ji skryje
browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.menuIds.includes(VOLUME_MENU) || !tab) {
    return;
  }
  const volume = await browser.mantisPrefs.getTabVolume(tab.id).catch(() => null);
  browser.menus.update(VOLUME_MENU, {
    visible: volume !== null,
    title: volume === null || volume === 100 ? t("volume_menu") : t("volume_menuValue", String(volume)),
  });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === VOLUME_MENU && tab) {
    browser.mantisPrefs.showTabVolume(tab.id).catch(e => console.error(e));
  }
});
