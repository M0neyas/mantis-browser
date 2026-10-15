// Výkon v bočním panelu (jako GX Control v Opeře GX): živé využití, Uvolnit paměť, úsporný
// režim, omezení paměti / procesoru / sítě a nejnáročnější karty – přímo v panelu, bez stránky
// nastavení. Stejné klíče storage.local jako Nastavení Mantis → Výkon, logika v ../performance.js.
/* global t, uiLocale */

const PERF_VIEW_DEFAULTS = {
  ramLimit: false, ramLimitMB: 4096,
  cpuLimit: false, cpuLimitPercent: 50,
  netLimit: false, netLimitKBps: 2048,
  ecoMode: "off", perfCpuFailed: false,
};
const PERF_RAM_OPTIONS = [2048, 3072, 4096, 6144, 8192, 12288, 16384];
const PERF_CPU_OPTIONS = [20, 30, 40, 50, 60, 75, 90];
const PERF_NET_OPTIONS = [256, 512, 1024, 2048, 5120, 10240, 25600, 51200];
const PERF_HOT_SHOWN = 5;
const PERF_WEB_URL = /^(https?|file):/;

function perfMemory(mb) {
  return mb >= 1024
    ? t("settings_perfGB", (mb / 1024).toLocaleString(uiLocale(), { maximumFractionDigits: 1 }))
    : t("settings_perfMB", mb);
}

function perfSpeed(kbps) {
  return kbps >= 1024 ? `${(kbps / 1024).toLocaleString(uiLocale())} MB/s` : `${kbps} kB/s`;
}

function perfEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function createPerformanceView() {
  const view = perfEl("section", "perf");

  const header = perfEl("header");
  header.append(perfEl("b", "", t("perf_title")));
  const more = perfEl("button", "notes-button", t("perf_more"));
  more.type = "button";
  more.addEventListener("click", () =>
    browser.tabs.create({ url: browser.runtime.getURL("settings/settings.html#performance") }));
  header.append(more);

  const body = perfEl("div", "perf-body");

  // Využití + Uvolnit paměť
  const usage = perfEl("div", "perf-card perf-usage");
  const memValue = perfEl("b", "perf-big", "–");
  const cpuValue = perfEl("b", "perf-big", "–");
  const memBox = perfEl("div");
  memBox.append(perfEl("span", "perf-label", t("perf_memory")), memValue);
  const cpuBox = perfEl("div");
  cpuBox.append(perfEl("span", "perf-label", t("perf_cpu")), cpuValue);
  const meters = perfEl("div", "perf-meters");
  meters.append(memBox, cpuBox);
  const minimize = perfEl("button", "notes-button", t("settings_minimize"));
  minimize.type = "button";
  minimize.title = t("settings_minimizeHint");
  const minimizeStatus = perfEl("span", "perf-hint");
  minimizeStatus.setAttribute("role", "status");
  minimize.addEventListener("click", async () => {
    minimize.disabled = true;
    minimizeStatus.textContent = t("settings_minimizeRunning");
    try {
      const { beforeMB, afterMB } = await browser.mantisPrefs.minimizeMemory();
      minimizeStatus.textContent = beforeMB > afterMB
        ? t("settings_minimizeDone", perfMemory(beforeMB - afterMB))
        : t("settings_minimizeNothing");
      refreshUsage();
    } catch (e) {
      minimizeStatus.textContent = e.message;
    } finally {
      minimize.disabled = false;
    }
  });
  const actions = perfEl("div", "perf-actions");
  actions.append(minimize, minimizeStatus);
  usage.append(meters, actions);

  // Úsporný režim
  const eco = perfEl("div", "perf-card");
  const ecoRow = perfEl("label", "perf-row");
  const ecoSelect = perfEl("select");
  for (const [value, key] of [["off", "settings_ecoOff"], ["battery", "settings_ecoBattery"], ["on", "settings_ecoOn"]]) {
    const option = perfEl("option", "", t(key));
    option.value = value;
    ecoSelect.append(option);
  }
  ecoSelect.addEventListener("change", () => browser.storage.local.set({ ecoMode: ecoSelect.value }));
  ecoRow.append(perfEl("b", "", t("settings_eco")), ecoSelect);
  const ecoState = perfEl("span", "perf-hint");
  eco.append(ecoRow, ecoState);

  // Omezení: přepínač + hodnota
  function limitCard(title, hint, switchKey, valueKey, options, label) {
    const card = perfEl("div", "perf-card");
    const row = perfEl("label", "perf-row");
    const toggle = perfEl("input", "switch");
    toggle.type = "checkbox";
    toggle.setAttribute("aria-label", title);
    toggle.addEventListener("change", () => browser.storage.local.set({ [switchKey]: toggle.checked }));
    row.append(perfEl("b", "", title), toggle);
    const select = perfEl("select");
    select.setAttribute("aria-label", title);
    for (const value of options) {
      const option = perfEl("option", "", label(value));
      option.value = String(value);
      select.append(option);
    }
    select.addEventListener("change", () => browser.storage.local.set({ [valueKey]: Number(select.value) }));
    const hintEl = perfEl("span", "perf-hint", hint);
    card.append(row, select, hintEl);
    return { card, toggle, select };
  }
  const ram = limitCard(t("settings_ramLimit"), t("perf_ramHint"), "ramLimit", "ramLimitMB", PERF_RAM_OPTIONS, perfMemory);
  const cpu = limitCard(t("settings_cpuLimit"), t("perf_cpuHint"), "cpuLimit", "cpuLimitPercent", PERF_CPU_OPTIONS, v => `${v} %`);
  const cpuFailed = perfEl("span", "perf-hint warn", t("settings_cpuLimitFailed"));
  cpu.card.append(cpuFailed);
  const net = limitCard(t("settings_netLimit"), t("perf_netHint"), "netLimit", "netLimitKBps", PERF_NET_OPTIONS, perfSpeed);

  // Nejnáročnější karty
  const hot = perfEl("div", "perf-card");
  const hotHead = perfEl("div", "perf-row");
  const sleepAll = perfEl("button", "notes-button", t("perf_sleepAll"));
  sleepAll.type = "button";
  sleepAll.title = t("settings_sleepBackground");
  hotHead.append(perfEl("b", "", t("settings_hotTabs")), sleepAll);
  const hotList = perfEl("ol", "perf-hot");
  const hotEmpty = perfEl("span", "perf-hint", t("settings_hotTabsEmpty"));
  hot.append(hotHead, hotList, hotEmpty);
  sleepAll.addEventListener("click", async () => {
    const tabs = (await browser.tabs.query({ active: false, discarded: false, pinned: false, audible: false }))
      .filter(tab => PERF_WEB_URL.test(tab.url || "") && !tab.mutedInfo?.muted);
    if (tabs.length) {
      await browser.tabs.discard(tabs.map(tab => tab.id));
    }
    minimizeStatus.textContent = t("settings_sleepBackgroundDone", tabs.length);
    refreshHot();
  });

  body.append(usage, eco, ram.card, cpu.card, net.card, hot);
  view.append(header, body);

  async function refreshSettings() {
    const config = await browser.storage.local.get(PERF_VIEW_DEFAULTS);
    ecoSelect.value = ["on", "battery"].includes(config.ecoMode) ? config.ecoMode : "off";
    ram.toggle.checked = config.ramLimit;
    ram.select.value = String(config.ramLimitMB);
    cpu.toggle.checked = config.cpuLimit;
    cpu.select.value = String(config.cpuLimitPercent);
    net.toggle.checked = config.netLimit;
    net.select.value = String(config.netLimitKBps);
    cpuFailed.hidden = !config.perfCpuFailed;
  }

  async function refreshUsage() {
    const stats = await browser.runtime.sendMessage({ perfStats: true });
    memValue.textContent = perfMemory(stats.memoryMB);
    cpuValue.textContent = stats.cpuPercent === null ? "–" : `${stats.cpuPercent} %`;
    const state = await browser.mantisPrefs.ecoState();
    let key = "";
    if (state.mode === "battery") {
      key = state.battery === null ? "settings_ecoBatteryUnknown"
        : state.active ? "settings_ecoBatteryActive" : "settings_ecoBatteryCharging";
    }
    ecoState.textContent = key ? t(key) : t("perf_ecoHint");
  }

  async function refreshHot() {
    const groups = await browser.mantisPrefs.tabStats();
    const rows = [];
    for (const group of groups) {
      const tabs = (await Promise.all(group.tabIds.map(id => browser.tabs.get(id).catch(() => null))))
        .filter(tab => tab && PERF_WEB_URL.test(tab.url || ""));
      if (tabs.length) {
        rows.push({ group, tabs });
      }
      if (rows.length >= PERF_HOT_SHOWN) {
        break;
      }
    }
    hotList.replaceChildren(...rows.map(({ group, tabs }) => {
      const li = perfEl("li");
      const text = perfEl("span", "perf-hot-text");
      const title = perfEl("span", "perf-hot-title", tabs[0].title || tabs[0].url);
      title.title = tabs.map(tab => tab.title || tab.url).join("\n");
      const load = group.cpuPercent === null
        ? perfMemory(group.memoryMB)
        : t("settings_hotTabLoad", perfMemory(group.memoryMB),
          group.cpuPercent.toLocaleString(uiLocale(), { maximumFractionDigits: 1 }));
      text.append(title, perfEl("span", "perf-hint", tabs.length > 1 ? `${load} · ${tabs.length}×` : load));
      const background = tabs.filter(tab => !tab.active);
      const sleep = perfEl("button", "notes-button", t("settings_hotTabSleep"));
      sleep.type = "button";
      sleep.disabled = !background.length;
      sleep.title = background.length ? "" : t("settings_hotTabActive");
      sleep.addEventListener("click", async () => {
        await browser.tabs.discard(background.map(tab => tab.id));
        refreshHot();
      });
      li.append(text, sleep);
      return li;
    }));
    hotEmpty.hidden = rows.length > 0;
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some(key => key in PERF_VIEW_DEFAULTS)) {
      refreshSettings();
    }
  });

  // Měřit jen když je výkon v panelu vidět (panel otevřený a tahle služba vybraná)
  let tick = 0;
  setInterval(() => {
    if (document.hidden || view.hidden) {
      return;
    }
    refreshUsage().catch(() => {});
    if (++tick % 3 === 0) {
      refreshHot().catch(() => {});
    }
  }, 2000);
  view.refresh = () => {
    refreshSettings();
    refreshUsage().catch(() => {});
    refreshHot().catch(() => {});
  };
  view.refresh();
  return view;
}
