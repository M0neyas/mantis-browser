// Výkon (Nastavení Mantis → Výkon): omezení paměti, CPU a sítě, podobně jako v herních
// prohlížečích.
//  - Paměť: když Mantis zabírá víc než limit, uspí nejdéle nepoužívané karty na pozadí
//    (stejná pravidla jako uspávání karet v tabsleep.js – ne aktivní, připnuté, hrající
//    a weby z výjimek). Měkký limit: bez karet k uspání může být krátce překročen.
//  - CPU (experimentální): tvrdý strop pro procesy webů přes Job Object Windows
//    (mantisPrefs.setCpuLimit). Okno prohlížeče zůstává svižné, omezené weby se zpomalí.
//  - Síť: rychlost stahování i odesílání přes HTTP(S) (mantisPrefs.setNetworkLimit).
// storage.local, jen tento počítač (každý má jinou paměť a připojení): ramLimit, ramLimitMB,
// cpuLimit, cpuLimitPercent, netLimit, netLimitKBps; perfCpuFailed = Windows strop odmítly.

const PERF_DEFAULTS = {
  ramLimit: false,
  ramLimitMB: 4096,
  cpuLimit: false,
  cpuLimitPercent: 50,
  netLimit: false,
  netLimitKBps: 2048,
};
const PERF_RAM_INTERVAL = 15 * 1000;
let perfRamTimer = null;

async function perfRamCheck() {
  const config = await browser.storage.local.get({ ...PERF_DEFAULTS, tabSleepExceptions: [] });
  if (!config.ramLimit) {
    return;
  }
  const stats = await browser.mantisPrefs.processStats();
  if (stats.memoryMB <= config.ramLimitMB) {
    return;
  }
  const tabs = await browser.tabs.query({ discarded: false, active: false, pinned: false, audible: false });
  const candidates = tabs
    .filter(tab =>
      /^(https?|file):/.test(tab.url || "") &&
      !tab.mutedInfo?.muted &&
      !tabSleepExcepted(tab.url, config.tabSleepExceptions)) // tabsleep.js
    .sort((a, b) => a.lastAccessed - b.lastAccessed);
  // Paměť se po uspání uvolní se zpožděním – uspat jen pár karet a znovu změřit příště
  const count = Math.min(candidates.length, stats.memoryMB - config.ramLimitMB > 1024 ? 3 : 1);
  if (count) {
    await browser.tabs.discard(candidates.slice(0, count).map(tab => tab.id));
  }
}

async function perfApply() {
  const config = await browser.storage.local.get(PERF_DEFAULTS);

  const cpuOk = await browser.mantisPrefs.setCpuLimit(config.cpuLimit ? config.cpuLimitPercent : 0);
  await browser.storage.local.set({ perfCpuFailed: config.cpuLimit && !cpuOk });

  await browser.mantisPrefs.setNetworkLimit(config.netLimit ? config.netLimitKBps : 0);

  if (config.ramLimit && !perfRamTimer) {
    perfRamTimer = setInterval(() => perfRamCheck().catch(e => console.error("Mantis – limit paměti:", e)),
      PERF_RAM_INTERVAL);
    perfRamCheck().catch(() => {});
  } else if (!config.ramLimit && perfRamTimer) {
    clearInterval(perfRamTimer);
    perfRamTimer = null;
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some(key => key in PERF_DEFAULTS)) {
    perfApply().catch(e => console.error("Mantis – výkon:", e));
  }
});

// Nastavení Mantis ukazuje živé využití
browser.runtime.onMessage.addListener(msg => {
  if (msg?.perfStats) {
    return browser.mantisPrefs.processStats();
  }
  return undefined;
});

perfApply().catch(e => console.error("Mantis – výkon:", e));
