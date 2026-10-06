// Domovská stránka: about:home je v LibreWolfu prázdná („Nový panel“) – ukazuje se při prvním
// spuštění, po tlačítku Domů a v obnovených kartách. Nahradí ji nová karta Mantisu (bez nového
// záznamu v historii, Zpět nevede na prázdnou stránku). Vlastní domovskou stránku uživatele
// to nemění – týká se jen karet, které opravdu načetly about:home.

const HOME_URL = "about:home";
const MANTIS_NEWTAB = browser.runtime.getURL("newtab/newtab.html");

function showMantisNewtab(tabId) {
  browser.tabs.update(tabId, { url: MANTIS_NEWTAB, loadReplace: true }).catch(() => {});
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === HOME_URL) {
    showMantisNewtab(tabId);
  }
});

// Karty s about:home, které se otevřely dřív, než se rozšíření spustilo (první spuštění)
browser.tabs.query({}).then(tabs => {
  for (const tab of tabs) {
    if (tab.url === HOME_URL && !tab.discarded) {
      showMantisNewtab(tab.id);
    }
  }
}).catch(() => {});
