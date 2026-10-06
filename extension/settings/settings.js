/* global MANTIS_LW_VERSION, MANTIS_RELEASE, t, applyI18n, versionLabel, uiLocale */
// Stránka Nastavení Mantis: přepínače nastavení prohlížeče (přes mantisPrefs),
// volby nové karty (storage), zapomenutí webu, odkaz na VPN.

applyI18n();

const STORE_DEFAULTS = {
  newtabClock: true,
  newtabBackground: true,
  devUpdateCheck: false,
  vpnKillSwitch: true,
  toolUnaccent: true, // nástroje v kontextové nabídce (tools.js)
  toolSaveImage: true,
  toolPrintEdit: true,
  tabSleep: true, // uspávání karet (tabsleep.js)
  eshopWarning: true, // rizikové e-shopy (eshops.js)
  currencyConvert: true, // převod měn (currency.js)
  ramLimit: false, // výkon (performance.js)
  cpuLimit: false,
  netLimit: false,
  soundTyping: false, // zvuky (appearance.js)
  soundTabs: false,
  sidebarRail: true, // lišta messengerů u okraje (messengers.js)
  newtabStats: true, // statistiky ochrany na nové kartě (stats.js)
};

// Číselné volby (výběr nebo posuvník, data-store-number) – výchozí hodnoty jako v performance.js
// a appearance.js
const STORE_NUMBER_DEFAULTS = {
  ramLimitMB: 4096,
  cpuLimitPercent: 50,
  netLimitKBps: 2048,
  soundVolume: 40,
};

browser.storage.local.get(STORE_NUMBER_DEFAULTS).then(values => {
  for (const el of document.querySelectorAll("[data-store-number]")) {
    const key = el.dataset.storeNumber;
    el.value = String(values[key]);
    el.addEventListener("change", () => browser.storage.local.set({ [key]: Number(el.value) }));
  }
});

// ---------- Výkon (logika v ../performance.js) ----------

function formatMemory(mb) {
  return mb >= 1024
    ? t("settings_perfGB", (mb / 1024).toLocaleString(uiLocale(), { maximumFractionDigits: 1 }))
    : t("settings_perfMB", mb);
}

async function showPerfUsage() {
  const stats = await browser.runtime.sendMessage({ perfStats: true });
  const memory = formatMemory(stats.memoryMB);
  document.getElementById("perf-usage").textContent = stats.cpuPercent === null
    ? t("settings_perfUsageMemory", memory)
    : t("settings_perfUsageValue", memory, stats.cpuPercent);
}

showPerfUsage().catch(() => {});
setInterval(() => {
  if (!document.hidden) {
    showPerfUsage().catch(() => {});
    showEcoState().catch(() => {});
  }
}, 2000);

// Uvolnit paměť (jako about:memory → Minimize memory usage)
document.getElementById("perf-minimize").addEventListener("click", async event => {
  const button = event.currentTarget;
  const status = document.getElementById("perf-minimize-status");
  button.disabled = true;
  status.textContent = t("settings_minimizeRunning");
  try {
    const { beforeMB, afterMB } = await browser.mantisPrefs.minimizeMemory();
    status.textContent = beforeMB > afterMB
      ? t("settings_minimizeDone", formatMemory(beforeMB - afterMB))
      : t("settings_minimizeNothing");
    showPerfUsage().catch(() => {});
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
});

// Žrouti karet: procesy webů podle paměti (karty stejného webu sdílejí proces)
const HOT_TABS_SHOWN = 8;
const WEB_URL = /^(https?|file):/;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch (e) {
    return url;
  }
}

function hotTabRow({ group, tabs }) {
  const row = document.createElement("li");
  row.className = "hot-tab";
  const text = document.createElement("span");
  const title = document.createElement("span");
  title.className = "hot-tab-title";
  title.textContent = tabs.length > 1
    ? t("settings_hotTabMore", tabs[0].title || tabs[0].url, tabs.length - 1)
    : tabs[0].title || tabs[0].url;
  title.title = tabs.map(tab => tab.title || tab.url).join("\n");
  const host = document.createElement("span");
  host.className = "hint";
  host.textContent = [...new Set(tabs.map(tab => hostOf(tab.url)))].join(", ");
  text.append(title, host);

  const load = document.createElement("span");
  load.className = "hot-tab-load";
  load.textContent = group.cpuPercent === null
    ? formatMemory(group.memoryMB)
    : t("settings_hotTabLoad", formatMemory(group.memoryMB),
      group.cpuPercent.toLocaleString(uiLocale(), { maximumFractionDigits: 1 }));

  const background = tabs.filter(tab => !tab.active);
  const sleep = document.createElement("button");
  sleep.type = "button";
  sleep.className = "secondary";
  sleep.textContent = t("settings_hotTabSleep");
  sleep.disabled = !background.length;
  sleep.title = background.length ? "" : t("settings_hotTabActive");
  sleep.addEventListener("click", async () => {
    await browser.tabs.discard(background.map(tab => tab.id));
    showHotTabs().catch(() => {});
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "secondary";
  close.textContent = tabs.length > 1 ? t("settings_hotTabCloseCount", tabs.length) : t("settings_hotTabClose");
  close.addEventListener("click", async () => {
    await browser.tabs.remove(tabs.map(tab => tab.id));
    showHotTabs().catch(() => {});
  });

  row.append(text, load, sleep, close);
  return row;
}

async function showHotTabs() {
  const groups = await browser.mantisPrefs.tabStats();
  const rows = [];
  for (const group of groups) {
    const tabs = (await Promise.all(group.tabIds.map(id => browser.tabs.get(id).catch(() => null))))
      .filter(tab => tab && WEB_URL.test(tab.url || ""));
    if (tabs.length) {
      rows.push({ group, tabs });
    }
    if (rows.length >= HOT_TABS_SHOWN) {
      break;
    }
  }
  document.getElementById("hot-tabs").replaceChildren(...rows.map(hotTabRow));
  document.getElementById("hot-tabs-empty").hidden = rows.length > 0;
}

showHotTabs().catch(() => {});
setInterval(() => {
  // tlačítko pod kurzorem se nesmí posunout zrovna při kliknutí
  if (!document.hidden && !document.getElementById("hot-tabs").matches(":hover")) {
    showHotTabs().catch(() => {});
  }
}, 3000);

document.getElementById("sleep-background").addEventListener("click", async () => {
  const tabs = (await browser.tabs.query({ active: false, discarded: false, pinned: false, audible: false }))
    .filter(tab => WEB_URL.test(tab.url || "") && !tab.mutedInfo?.muted);
  if (tabs.length) {
    await browser.tabs.discard(tabs.map(tab => tab.id));
  }
  document.getElementById("sleep-background-status").textContent = t("settings_sleepBackgroundDone", tabs.length);
  showHotTabs().catch(() => {});
});

// ---------- Pracovní prostory (logika v ../workspaces.js) ----------

const WS_COLOR = /^#[0-9a-f]{6}$/i;

async function showWorkspaces() {
  const { workspaces } = await browser.storage.local.get({ workspaces: null });
  const list = Array.isArray(workspaces) && workspaces.length
    ? workspaces
    : [{ id: "home", name: t("ws_defaultName"), icon: "🏠", color: "#22c55e" }];
  const save = next => browser.storage.local.set({ workspaces: next });
  document.getElementById("ws-list").replaceChildren(...list.map((w, index) => {
    const row = document.createElement("li");
    row.className = "ws-item";
    const icon = document.createElement("input");
    icon.type = "text";
    icon.className = "ws-icon";
    icon.value = w.icon || "";
    icon.maxLength = 4;
    icon.setAttribute("aria-label", t("settings_wsIcon"));
    const name = document.createElement("input");
    name.type = "text";
    name.className = "ws-name";
    name.value = w.name;
    name.maxLength = 40;
    name.setAttribute("aria-label", t("settings_wsName"));
    const color = document.createElement("input");
    color.type = "color";
    color.value = WS_COLOR.test(w.color || "") ? w.color : "#22c55e";
    color.setAttribute("aria-label", t("settings_wsColor"));
    const update = () => save(list.map((item, i) => i !== index ? item : {
      ...item,
      icon: icon.value.trim().slice(0, 4),
      name: name.value.trim().slice(0, 40) || item.name,
      color: color.value,
    }));
    for (const input of [icon, name, color]) {
      input.addEventListener("change", update);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = t("settings_wsRemove");
    remove.disabled = list.length < 2;
    remove.title = list.length < 2 ? t("settings_wsRemoveLast") : t("settings_wsRemoveHint");
    // karty smazaného prostoru přesune do prvního (workspaces.js)
    remove.addEventListener("click", () => browser.runtime.sendMessage({ wsRemove: w.id }));
    row.append(icon, name, color, remove);
    return row;
  }));
}

document.getElementById("ws-add").addEventListener("click", async () => {
  const { workspaces } = await browser.storage.local.get({ workspaces: null });
  const list = Array.isArray(workspaces) && workspaces.length
    ? workspaces
    : [{ id: "home", name: t("ws_defaultName"), icon: "🏠", color: "#22c55e" }];
  const colors = ["#22c55e", "#38bdf8", "#f472b6", "#fb923c", "#a78bfa", "#facc15", "#f43f5e", "#2dd4bf"];
  const icons = ["🏠", "💼", "🎮", "🎵", "🛒", "📚", "✈️", "💬"];
  if (list.length >= 12) {
    return;
  }
  await browser.storage.local.set({ workspaces: [...list, {
    id: Math.random().toString(36).slice(2, 10),
    name: t("ws_newName", String(list.length + 1)),
    icon: icons[list.length % icons.length],
    color: colors[list.length % colors.length],
  }] });
});

showWorkspaces();

// ---------- Uložené relace (logika v ../savedsessions.js) ----------

async function showSessions() {
  const { savedSessions } = await browser.storage.local.get({ savedSessions: [] });
  const list = Array.isArray(savedSessions) ? savedSessions : [];
  document.getElementById("sess-empty").hidden = list.length > 0;
  document.getElementById("sess-list").replaceChildren(...list.map(session => {
    const row = document.createElement("li");
    row.className = "ws-item";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "ws-name";
    name.value = session.name;
    name.maxLength = 80;
    name.setAttribute("aria-label", t("settings_sessName"));
    name.addEventListener("change", async () => {
      const { savedSessions: current } = await browser.storage.local.get({ savedSessions: [] });
      await browser.storage.local.set({ savedSessions: current.map(s => s.id !== session.id ? s : { ...s, name: name.value.trim().slice(0, 80) || s.name }) });
    });
    const info = document.createElement("span");
    info.className = "hint";
    info.textContent = t("settings_sessInfo", String(session.tabs.length),
      new Date(session.created).toLocaleDateString(uiLocale(), { day: "numeric", month: "numeric", year: "numeric" }));
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = t("settings_sessOpen");
    restore.addEventListener("click", () => browser.runtime.sendMessage({ sessRestore: session.id }));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = t("settings_wsRemove");
    remove.addEventListener("click", () => browser.runtime.sendMessage({ sessRemove: session.id }));
    row.append(name, info, restore, remove);
    return row;
  }));
}

document.getElementById("sess-save").addEventListener("click", async () => {
  const session = await browser.runtime.sendMessage({ sessSave: true });
  document.getElementById("sess-status").textContent = session
    ? t("settings_sessSaved", String(session.tabs.length))
    : t("settings_sessNothing");
});

showSessions();

// ---------- Messengery v bočním panelu (../messengers.js, ../sidebar/) ----------

async function showMessengers() {
  const { services, enabled } = await browser.runtime.sendMessage({ messengerServices: true });
  document.getElementById("messenger-list").replaceChildren(...services.map(service => {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = enabled.includes(service.id);
    box.addEventListener("change", async () => {
      const current = (await browser.runtime.sendMessage({ messengerServices: true })).enabled;
      const next = box.checked ? [...new Set([...current, service.id])] : current.filter(id => id !== service.id);
      await browser.storage.local.set({ sidebarServices: next });
    });
    label.append(box, ` ${service.name}`);
    return label;
  }));
}

showMessengers();

// Úsporný režim (performance.js → mantisPrefs.setEcoMode)
async function showEcoState() {
  const state = await browser.mantisPrefs.ecoState();
  let key = "";
  if (state.mode === "battery") {
    key = state.battery === null ? "settings_ecoBatteryUnknown"
      : state.active ? "settings_ecoBatteryActive" : "settings_ecoBatteryCharging";
  }
  document.getElementById("eco-state").textContent = key ? t(key) : "";
}

browser.storage.local.get({ ecoMode: "off" }).then(({ ecoMode }) => {
  const select = document.getElementById("eco-mode");
  select.value = ["on", "battery"].includes(ecoMode) ? ecoMode : "off";
  select.addEventListener("change", () => browser.storage.local.set({ ecoMode: select.value }));
  showEcoState().catch(() => {});
});

async function showCpuFailed() {
  const { perfCpuFailed } = await browser.storage.local.get({ perfCpuFailed: false });
  document.getElementById("cpu-limit-failed").hidden = !perfCpuFailed;
}
showCpuFailed();

// ---------- Vzhled (logika v ../appearance.js) ----------

async function showTheme() {
  const { themePreset, themeAccent, themeCustom, themeGlow, themeGlowColors } = await browser.storage.local.get({
    themePreset: "mantis", themeAccent: "", themeCustom: null, themeGlow: false, themeGlowColors: "background",
  });
  const presets = await browser.runtime.sendMessage({ themePresets: true });
  const preset = themePreset in presets || themePreset === "custom" ? themePreset : "mantis";
  document.getElementById("theme-preset").value = preset;
  document.getElementById("theme-custom-row").hidden = preset !== "custom"; // barvy řeší mods.js
  const custom = /^#[0-9a-f]{6}$/i.test(themeAccent);
  const color = document.getElementById("theme-accent-color");
  document.getElementById("theme-accent-custom").checked = custom;
  color.value = custom
    ? themeAccent
    : (preset === "custom" ? themeCustom?.accent : presets[preset]?.accent) || "#22c55e";
  color.disabled = !custom;
  document.getElementById("theme-glow").checked = themeGlow;
  document.getElementById("theme-glow-colors").value = themeGlowColors === "theme" ? "theme" : "background";
  document.getElementById("theme-glow-colors-row").hidden = !themeGlow;
}

document.getElementById("theme-preset").addEventListener("change", event => {
  const themePreset = event.currentTarget.value;
  // Synthwave bez záře nedává smysl → zapne ji (vypnout jde zvlášť)
  browser.storage.local.set(themePreset === "synthwave" ? { themePreset, themeGlow: true } : { themePreset });
});

document.getElementById("theme-glow").addEventListener("change", event => {
  browser.storage.local.set({ themeGlow: event.currentTarget.checked });
});

document.getElementById("theme-glow-colors").addEventListener("change", event => {
  browser.storage.local.set({ themeGlowColors: event.currentTarget.value });
});

document.getElementById("theme-accent-custom").addEventListener("change", event => {
  browser.storage.local.set({
    themeAccent: event.currentTarget.checked ? document.getElementById("theme-accent-color").value : "",
  });
});

document.getElementById("theme-accent-color").addEventListener("change", event => {
  if (document.getElementById("theme-accent-custom").checked) {
    browser.storage.local.set({ themeAccent: event.currentTarget.value });
  }
});

showTheme();

// ---------- Tapeta nové karty ----------
// Obrázek se zmenší na nejvýš 2560 px a uloží jako JPEG jen v tomto počítači (newtabWallpaper).

async function showWallpaper() {
  const { newtabWallpaper } = await browser.storage.local.get({ newtabWallpaper: "" });
  document.getElementById("wallpaper-remove").hidden = !newtabWallpaper;
  document.getElementById("wallpaper-state").textContent =
    t(newtabWallpaper ? "settings_wallpaperSet" : "settings_wallpaperHint");
}

document.getElementById("wallpaper-choose").addEventListener("click", () => {
  document.getElementById("wallpaper-file").click();
});

document.getElementById("wallpaper-file").addEventListener("change", async event => {
  const file = event.currentTarget.files[0];
  event.currentTarget.value = "";
  if (!file) {
    return;
  }
  const state = document.getElementById("wallpaper-state");
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    await browser.storage.local.set({ newtabWallpaper: canvas.toDataURL("image/jpeg", 0.85) });
  } catch (e) {
    state.textContent = t("settings_wallpaperFailed");
  }
});

document.getElementById("wallpaper-remove").addEventListener("click", () => {
  browser.storage.local.remove("newtabWallpaper");
});

showWallpaper();

// ---------- Uspávání karet (logika v ../tabsleep.js) ----------

browser.storage.local.get({ tabSleepMinutes: 60, tabSleepExceptions: [] }).then(values => {
  const minutes = document.getElementById("tab-sleep-minutes");
  minutes.value = String(values.tabSleepMinutes);
  minutes.addEventListener("change", () => browser.storage.local.set({ tabSleepMinutes: Number(minutes.value) }));
  const exceptions = document.getElementById("tab-sleep-exceptions");
  exceptions.value = values.tabSleepExceptions.join("\n");
  exceptions.addEventListener("change", () => {
    const sites = [...new Set(exceptions.value.split(/[\n,]/).map(normalizeSite).filter(Boolean))];
    exceptions.value = sites.join("\n");
    browser.storage.local.set({ tabSleepExceptions: sites });
  });
});

// ---------- Nákupy (logika v ../eshops.js a ../currency.js) ----------

browser.runtime.sendMessage({ eshopListInfo: true }).then(info => {
  if (info?.count && info.generated) {
    const date = new Date(`${info.generated}T12:00:00`).toLocaleDateString(uiLocale());
    document.getElementById("eshop-info").textContent = t("settings_eshopInfo", info.count.toLocaleString(uiLocale()), date);
  }
});

function showCurrencyInfo() {
  browser.runtime.sendMessage({ cnbRatesInfo: true }).then(info => {
    document.getElementById("currency-info").textContent = info?.date
      ? t("settings_currencyInfo", new Date(`${info.date}T12:00:00`).toLocaleDateString(uiLocale()))
      : "";
  });
}
showCurrencyInfo();

// ---------- Nastavení prohlížeče ----------
// data-pref-invert: zaškrtnuto = pref false (např. webgl.disabled)
// data-pref-on / data-pref-off: číselný pref jako přepínač (např. 2 = blokovat, 0 = ptát se)

for (const el of document.querySelectorAll("[data-pref]")) {
  const name = el.dataset.pref;
  const invert = el.hasAttribute("data-pref-invert");
  const onOff = "prefOn" in el.dataset ? [Number(el.dataset.prefOn), Number(el.dataset.prefOff)] : null;
  browser.mantisPrefs.get(name).then(value => {
    if (el.type === "checkbox") {
      el.checked = onOff ? value === onOff[0] : invert ? !value : value;
    } else {
      el.value = String(value);
    }
  });
  el.addEventListener("change", async () => {
    const value =
      el.type !== "checkbox" ? Number(el.value) : onOff ? onOff[el.checked ? 0 : 1] : el.checked !== invert;
    await browser.mantisPrefs.set(name, value);
    // uložit i do storage – odtud se přepínače synchronizují na další počítače (sync.js)
    const { browserPrefs } = await browser.storage.local.get("browserPrefs");
    await browser.storage.local.set({ browserPrefs: { ...browserPrefs, [name]: value } });
  });
}

// ---------- Místní volby (nesynchronizují se) ----------

browser.storage.local.get({ syncSettings: true }).then(values => {
  for (const el of document.querySelectorAll("[data-local]")) {
    el.checked = values[el.dataset.local];
    el.addEventListener("change", () => browser.storage.local.set({ [el.dataset.local]: el.checked }));
  }
});

// ---------- Šifrované DNS (logika v ../doh.js) ----------

const DOH_DEFAULTS = { mode: "off", provider: "quad9" }; // výchozí vypnuto – zapíná uživatel
const DOH_REASONS = ["off", "on", "allowed", "blocked"];

// Název poskytovatele podle výběru ve stránce (Mullvad s blokováním je přeložený)
function dohProviderName(key) {
  const option = document.querySelector(`[data-doh="provider"] option[value="${CSS.escape(key)}"]`);
  return option ? option.textContent : key;
}

async function showDoh() {
  const { doh, dohState } = await browser.storage.local.get(["doh", "dohState"]);
  const config = { ...DOH_DEFAULTS, ...doh };
  for (const el of document.querySelectorAll("[data-doh]")) {
    el.value = config[el.dataset.doh];
  }
  document.querySelector('[data-doh="provider"]').disabled = config.mode === "off";
  const state = document.getElementById("doh-state");
  // dohState od doh.js: reason = off | on | allowed | blocked, provider = klíč poskytovatele
  if (dohState && DOH_REASONS.includes(dohState.reason)) {
    const time = new Date(dohState.checked).toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" });
    const reason = t(`doh_reason_${dohState.reason}`);
    state.textContent = dohState.active
      ? t("settings_dohStateOn", dohProviderName(dohState.provider), reason, time)
      : t("settings_dohStateOff", reason, time);
  }
}

for (const el of document.querySelectorAll("[data-doh]")) {
  el.addEventListener("change", async () => {
    const { doh } = await browser.storage.local.get("doh");
    await browser.storage.local.set({ doh: { ...DOH_DEFAULTS, ...doh, [el.dataset.doh]: el.value } });
  });
}

document.getElementById("doh-check").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  document.getElementById("doh-state").textContent = t("settings_checking");
  await browser.runtime.sendMessage({ dohCheck: true });
  event.currentTarget.disabled = false;
  showDoh();
});

// ---------- Co jde přes VPN (logika v ../vpn.js) ----------

const ROUTING_DEFAULTS = { mode: "all", sites: [], containers: [] };

// doména, IPv4 adresa nebo rozsah (192.168.1.0/24)
function normalizeRoute(text) {
  const entry = text.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[?#\s]/)[0];
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(entry)) {
    return entry;
  }
  return normalizeSite(entry);
}

async function saveRouting(changes) {
  const { vpnRouting } = await browser.storage.local.get("vpnRouting");
  await browser.storage.local.set({ vpnRouting: { ...ROUTING_DEFAULTS, ...vpnRouting, ...changes } });
}

async function showRouting() {
  const { vpnRouting } = await browser.storage.local.get("vpnRouting");
  const config = { ...ROUTING_DEFAULTS, ...vpnRouting };
  document.querySelector('[data-routing="mode"]').value = config.mode;
  for (const el of document.querySelectorAll("[data-routing-detail]")) {
    el.hidden = config.mode === "all";
  }
  const sites = document.getElementById("routing-sites");
  if (document.activeElement !== sites) {
    sites.value = config.sites.join("\n");
  }

  const list = document.getElementById("routing-containers");
  let containers = [];
  try {
    containers = await browser.contextualIdentities.query({});
  } catch (e) {
    // kontejnery vypnuté
  }
  list.replaceChildren();
  if (!containers.length) {
    list.textContent = t("settings_routingNoContainers");
    list.classList.add("hint");
  }
  for (const c of containers) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = config.containers.includes(c.cookieStoreId);
    box.addEventListener("change", async () => {
      const { vpnRouting: now } = await browser.storage.local.get("vpnRouting");
      const current = new Set({ ...ROUTING_DEFAULTS, ...now }.containers);
      box.checked ? current.add(c.cookieStoreId) : current.delete(c.cookieStoreId);
      saveRouting({ containers: [...current] });
    });
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = c.colorCode;
    label.append(box, dot, c.name);
    list.append(label);
  }
}

document.querySelector('[data-routing="mode"]').addEventListener("change", event => {
  saveRouting({ mode: event.currentTarget.value });
});

document.getElementById("routing-sites").addEventListener("change", event => {
  const entries = [...new Set(event.currentTarget.value.split(/[\n,]/).map(normalizeRoute).filter(Boolean))];
  event.currentTarget.value = entries.join("\n");
  saveRouting({ sites: entries });
});

// ---------- Jiný prohlížeč (logika v ../otherbrowser.js) ----------

const OTHER_DEFAULTS = { browser: "auto", notify: true };
const OTHER_SITES_DEFAULT = ["netflix.com"];

async function saveOther(changes) {
  const { otherBrowser } = await browser.storage.local.get("otherBrowser");
  await browser.storage.local.set({ otherBrowser: { ...OTHER_DEFAULTS, ...otherBrowser, ...changes } });
}

// refresh: znovu projít registr (nově nainstalovaný prohlížeč) – při otevření stránky
async function showOther(refresh = false) {
  const { otherBrowser, otherBrowserSites } = await browser.storage.local.get(["otherBrowser", "otherBrowserSites"]);
  const config = { ...OTHER_DEFAULTS, ...otherBrowser };
  const { browsers } = await browser.runtime.sendMessage({ otherBrowsers: true, refresh });
  const select = document.getElementById("other-browser-select");
  const fallback = browsers.find(b => b.isDefault) || browsers[0];
  const auto = new Option(
    !fallback
      ? t("settings_otherNone")
      : fallback.isDefault
        ? t("settings_otherAutoDefault", fallback.name)
        : t("settings_otherAuto", fallback.name),
    "auto"
  );
  select.replaceChildren(auto, ...browsers.map(b => new Option(b.name, b.id)));
  select.value = browsers.some(b => b.id === config.browser) ? config.browser : "auto";
  select.disabled = !browsers.length;
  document.getElementById("other-browser-notify").checked = config.notify;
  const sites = document.getElementById("other-browser-sites");
  if (document.activeElement !== sites) {
    sites.value = (otherBrowserSites ?? OTHER_SITES_DEFAULT).join("\n");
  }
}

document.getElementById("other-browser-select").addEventListener("change", event => {
  saveOther({ browser: event.currentTarget.value });
});

document.getElementById("other-browser-notify").addEventListener("change", event => {
  saveOther({ notify: event.currentTarget.checked });
});

document.getElementById("other-browser-sites").addEventListener("change", event => {
  const sites = [...new Set(event.currentTarget.value.split(/[\n,]/).map(normalizeSite).filter(Boolean))];
  event.currentTarget.value = sites.join("\n");
  browser.storage.local.set({ otherBrowserSites: sites });
});

// ---------- Nová karta ----------

browser.storage.local.get(STORE_DEFAULTS).then(values => {
  for (const el of document.querySelectorAll("[data-store]")) {
    el.checked = values[el.dataset.store];
    el.addEventListener("change", () => {
      browser.storage.local.set({ [el.dataset.store]: el.checked });
    });
  }
});

// ---------- Zapomenout web ----------

document.getElementById("forget").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.getElementById("forget-site");
  const result = document.getElementById("forget-result");
  const site = input.value.trim().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site) && site !== "localhost") {
    result.textContent = t("settings_forgetInvalid");
    return;
  }
  if (!confirm(t("settings_forgetConfirm", site))) {
    return;
  }
  const reply = await browser.runtime.sendMessage({ forgetSite: "https://" + site });
  result.textContent = reply?.error ? t("common_failed", reply.error) : t("settings_forgetDone", reply.base);
  if (!reply?.error) {
    input.value = "";
  }
});

// ---------- Choulostivé stránky (logika v ../sensitive.js) ----------

const SENSITIVE_DEFAULTS = { enabled: true, adult: true, custom: [], exceptions: [] };

// "https://www.Example.com/x" → "example.com"
function normalizeSite(text) {
  const site = text.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:\s]/)[0].replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site) ? site : null;
}

async function saveSensitive(changes) {
  const { sensitive } = await browser.storage.local.get("sensitive");
  await browser.storage.local.set({ sensitive: { ...SENSITIVE_DEFAULTS, ...sensitive, ...changes } });
}

async function showSensitive() {
  const { sensitive } = await browser.storage.local.get("sensitive");
  const values = { ...SENSITIVE_DEFAULTS, ...sensitive };
  for (const el of document.querySelectorAll("[data-sensitive]")) {
    el.checked = values[el.dataset.sensitive];
  }
  for (const el of document.querySelectorAll("[data-sensitive-list]")) {
    if (document.activeElement !== el) {
      el.value = values[el.dataset.sensitiveList].join("\n");
    }
  }
  document.querySelector('[data-sensitive="adult"]').disabled = !values.enabled;
}

for (const el of document.querySelectorAll("[data-sensitive]")) {
  el.addEventListener("change", () => saveSensitive({ [el.dataset.sensitive]: el.checked }));
}

for (const el of document.querySelectorAll("[data-sensitive-list]")) {
  el.addEventListener("change", () => {
    const sites = el.value.split(/[\n,]/).map(normalizeSite).filter(Boolean);
    saveSensitive({ [el.dataset.sensitiveList]: [...new Set(sites)] });
    el.value = [...new Set(sites)].join("\n");
  });
}

document.getElementById("sensitive-clean").addEventListener("click", async event => {
  const button = event.currentTarget;
  const result = document.getElementById("sensitive-result");
  if (!confirm(t("settings_sensitiveCleanConfirm"))) {
    return;
  }
  button.disabled = true;
  result.textContent = t("settings_sensitiveCleaning");
  const reply = await browser.runtime.sendMessage({ sensitiveClean: true });
  button.disabled = false;
  result.textContent = reply?.error
    ? t("common_failed", reply.error)
    : t("settings_sensitiveCleaned", reply.removed.toLocaleString(uiLocale()));
});

// Změna z kontextové nabídky, synchronizace nebo kontroly DNS se ukáže i na otevřené stránce
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.sensitive) {
    showSensitive();
  }
  if (changes.doh || changes.dohState) {
    showDoh();
  }
  if (changes.vpnRouting) {
    showRouting();
  }
  if (changes.otherBrowser || changes.otherBrowserSites) {
    showOther();
  }
  if (changes.cnbRates || changes.currencyConvert) {
    showCurrencyInfo();
  }
  if (changes.perfCpuFailed) {
    showCpuFailed();
  }
  if (changes.themePreset || changes.themeAccent || changes.themeCustom || changes.themeGlow || changes.themeGlowColors) {
    showTheme();
  }
  if (changes.workspaces) {
    showWorkspaces();
  }
  if (changes.sidebarServices) {
    showMessengers();
  }
  if (changes.savedSessions) {
    showSessions();
  }
  if (changes.newtabWallpaper) {
    showWallpaper();
  }
});
showSensitive();
showDoh();
showRouting();
showOther(true);

// ---------- VPN a verze ----------

document.getElementById("open-vpn").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("vpn/popup.html?tab=1") });
});

Promise.all([browser.storage.local.get("update"), browser.mantisPrefs.isPackaged()]).then(([{ update: stored }, packaged]) => {
  const update = packaged ? null : stored; // Store: aktualizace řeší Store, viz níže
  const release = Number.parseInt(MANTIS_RELEASE, 10) || 1;
  const base = !/^\d/.test(MANTIS_LW_VERSION)
    ? t("settings_versionDev")
    : release > 1
      ? t("settings_versionBuild", MANTIS_LW_VERSION, release)
      : t("settings_version", MANTIS_LW_VERSION);
  const latest = update && versionLabel(update.version, update.release);
  document.getElementById("version").textContent = update ? t("settings_versionNew", base, latest) : base;
  if (update) {
    document.getElementById("update-status").textContent = update.installable
      ? t("settings_updateInstallable", latest)
      : t("settings_updateDownload", latest);
    document.getElementById("update-install").hidden = !update.installable;
  }
});

// Verze z Microsoft Store: aktualizace řeší Store (background.js je nekontroluje)
browser.mantisPrefs.isPackaged().then(packaged => {
  if (packaged) {
    document.getElementById("update-status").textContent = t("settings_updateStore");
    document.getElementById("update-install").hidden = true;
  }
});

document.getElementById("update-install").addEventListener("click", async event => {
  const button = event.currentTarget;
  const status = document.getElementById("update-status");
  button.disabled = true;
  status.textContent = t("common_installing");
  const reply = await browser.runtime.sendMessage({ installUpdate: true });
  button.disabled = false;
  status.textContent = reply?.error ? t("common_failed", reply.error) : t("settings_installerRunning");
});
