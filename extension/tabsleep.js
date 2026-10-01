// Uspávání karet (Nastavení Mantis → Prohlížení): karty, na které uživatel X minut nesáhl,
// se uspí (tabs.discard – uvolní paměť, stránka se po kliknutí znovu načte, formuláře obnoví
// obnova relace). Neuspávají se: aktivní karty, připnuté (pošta, chat…), přehrávající zvuk,
// právě načítané a weby z výjimek. Firefox navíc sám uspává karty, když dochází paměť.
// V úsporném režimu (performance.js) se uspává nejpozději po 15 minutách.
// storage.local: tabSleep (výchozí zapnuto), tabSleepMinutes (60), tabSleepExceptions [].

const TAB_SLEEP_DEFAULTS = { tabSleep: true, tabSleepMinutes: 60, tabSleepExceptions: [] };
const TAB_SLEEP_ALARM = "mantis-tab-sleep";
const TAB_SLEEP_ECO_MINUTES = 15;

function tabSleepExcepted(url, exceptions) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return exceptions.some(site => host === site || host.endsWith("." + site));
  } catch (e) {
    return false;
  }
}

async function sleepIdleTabs() {
  const config = await browser.storage.local.get(TAB_SLEEP_DEFAULTS);
  if (!config.tabSleep) {
    return;
  }
  let minutes = Math.max(5, Number(config.tabSleepMinutes) || 60);
  if ((await browser.mantisPrefs.ecoState()).active) {
    minutes = Math.min(minutes, TAB_SLEEP_ECO_MINUTES);
  }
  const limit = Date.now() - minutes * 60 * 1000;
  const tabs = await browser.tabs.query({ discarded: false, active: false, pinned: false, audible: false, status: "complete" });
  const idle = tabs.filter(tab =>
    tab.lastAccessed < limit &&
    /^(https?|file):/.test(tab.url || "") &&
    !tab.mutedInfo?.muted && // ztlumená karta nejspíš něco přehrává
    !tabSleepExcepted(tab.url, config.tabSleepExceptions)
  );
  if (idle.length) {
    await browser.tabs.discard(idle.map(tab => tab.id));
  }
}

browser.alarms.create(TAB_SLEEP_ALARM, { delayInMinutes: 5, periodInMinutes: 5 });
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TAB_SLEEP_ALARM) {
    sleepIdleTabs().catch(e => console.error("Mantis – uspávání karet:", e));
  }
});
