// Neuspávat panel: pravý klik na kartu → „Neuspávat panel“ (zaškrtávací). Karta se pak
// neuspí uspáváním karet (tabsleep.js), limitem paměti a úsporným režimem (performance.js)
// ani hromadným „Uspat karty na pozadí“ (paleta, Nastavení, panel Výkon). Nastavuje
// tabs.update({ autoDiscardable: false }) – Firefox kartu pak nevyřadí ani sám při nedostatku
// paměti (TabUnloader). Ruční „Uvolnit panel“ z nabídky Firefoxu funguje dál.
// Příznak Firefox po restartu nepamatuje → ukládá se i k relaci karty (sessions, klíč
// mantisNoSleep) a při startu / obnovení karty se nastaví znovu.

const NO_SLEEP_MENU = "mantis-tab-nosleep";
const NO_SLEEP_KEY = "mantisNoSleep";

browser.menus.create({ id: NO_SLEEP_MENU, type: "checkbox", title: t("nosleep_menu"), contexts: ["tab"] });

browser.menus.onShown.addListener((info, tab) => {
  if (!info.menuIds.includes(NO_SLEEP_MENU) || !tab) {
    return;
  }
  browser.menus.update(NO_SLEEP_MENU, { checked: tab.autoDiscardable === false });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== NO_SLEEP_MENU || !tab) {
    return;
  }
  await browser.tabs.update(tab.id, { autoDiscardable: !info.checked });
  if (info.checked) {
    await browser.sessions.setTabValue(tab.id, NO_SLEEP_KEY, true);
  } else {
    await browser.sessions.removeTabValue(tab.id, NO_SLEEP_KEY);
  }
});

async function noSleepRestore(tab) {
  if (tab.autoDiscardable !== false && await browser.sessions.getTabValue(tab.id, NO_SLEEP_KEY)) {
    await browser.tabs.update(tab.id, { autoDiscardable: false });
  }
}

// Obnovené karty (start, Znovu otevřít zavřenou kartu) mají hodnoty relace až chvíli po vytvoření
browser.tabs.onCreated.addListener(tab => {
  setTimeout(() => noSleepRestore(tab).catch(() => {}), 1000);
});
browser.tabs.query({}).then(tabs => Promise.all(tabs.map(tab => noSleepRestore(tab).catch(() => {}))))
  .catch(e => console.error("Mantis – neuspávat panel:", e));
