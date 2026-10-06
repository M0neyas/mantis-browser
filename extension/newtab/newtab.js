// Nová karta Mantis Browseru: vyhledávání, nejnavštěvovanější stránky,
// upozornění na novou verzi.
/* global t, applyI18n, versionLabel, uiLocale, MANTIS_LW_VERSION, MANTIS_RELEASE */

applyI18n();

const form = document.getElementById("search");
const query = document.getElementById("query");

// Adresa = bez mezer a s tečkou (seznam.cz, https://…), nebo localhost[:port]
function asUrl(text) {
  if (/\s/.test(text)) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text;
  }
  if (/^[^./]+(\.[^./]+)+(:\d+)?(\/.*)?$/.test(text) || /^localhost(:\d+)?(\/.*)?$/.test(text)) {
    return "https://" + text;
  }
  return null;
}

// „@mapy praha“ → vyhledávač se zkratkou @mapy (policies.json), jinak null
function aliasSearch(text, engines) {
  const m = /^(@\S+)\s+(.+)$/.exec(text);
  const engine = m && engines.find(e => e.alias?.toLowerCase() === m[1].toLowerCase());
  return engine ? { engine, query: m[2] } : null;
}

async function openText(text) {
  const url = asUrl(text);
  if (url) {
    browser.tabs.update({ url });
    return;
  }
  const alias = aliasSearch(text, await getEngines());
  if (alias) {
    browser.search.search({ query: alias.query, engine: alias.engine.name });
  } else {
    browser.search.search({ query: text }); // výchozí vyhledávač (DuckDuckGo)
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const selected = suggestionItems[selectedIndex];
  if (selected) {
    selected.run();
    return;
  }
  const text = query.value.trim();
  if (text) {
    openText(text);
  }
});

// ---------- Našeptávač ----------
// Jako adresní řádek: historie, záložky, otevřené karty a zkratky vyhledávačů (@mapy…).
// Jen z tohoto počítače – nic se neodesílá (online návrhy vyhledávače LibreWolf vypíná,
// browser.search.suggest.enabled = false, a Mantis to dodržuje).

const list = document.getElementById("suggestions");
const SUGGEST_MAX = 7;
let suggestionItems = [];
let selectedIndex = -1;
let suggestTimer = null;
let suggestRun = 0;
let enginesCache = null;

async function getEngines() {
  if (!enginesCache) {
    const [engines, aliases] = await Promise.all([
      browser.search.get().catch(() => []),
      browser.mantisPrefs.searchAliases().catch(() => ({})),
    ]);
    enginesCache = engines.map(e => ({ ...e, alias: e.alias || aliases[e.name] }));
  }
  return enginesCache;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return url;
  }
}

const WEB_URL = /^(https?|file):/;

function matches(text, ...fields) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = fields.join(" ").toLowerCase();
  return words.every(word => hay.includes(word));
}

async function buildSuggestions(text) {
  const items = [];
  const seen = new Set();
  const add = item => {
    if (item.url && seen.has(item.url)) {
      return;
    }
    if (item.url) {
      seen.add(item.url);
    }
    items.push(item);
  };
  const engines = await getEngines();

  // Zkratky vyhledávačů: „@m“ → @mapy, „@mapy praha“ → hledat na Mapy.cz
  if (text.startsWith("@")) {
    const alias = aliasSearch(text, engines);
    if (alias) {
      add({ kind: "search", icon: alias.engine.favIconUrl, title: alias.query,
        detail: t("newtab_suggestSearchIn", alias.engine.name), run: () => openText(text) });
    } else {
      for (const engine of engines.filter(e => e.alias?.toLowerCase().startsWith(text.toLowerCase()))) {
        add({ kind: "alias", icon: engine.favIconUrl, title: engine.alias, detail: engine.name,
          run: () => { query.value = engine.alias + " "; query.focus(); updateSuggestions(); } });
      }
    }
    return items;
  }

  // První řádek = co udělá Enter: otevřít adresu, nebo hledat výchozím vyhledávačem
  const url = asUrl(text);
  const defaultEngine = engines.find(e => e.isDefault);
  add(url
    ? { kind: "url", title: text, detail: t("newtab_suggestOpen"), run: () => openText(text) }
    : { kind: "search", icon: defaultEngine?.favIconUrl, title: text,
      detail: t("newtab_suggestSearchIn", defaultEngine?.name || "DuckDuckGo"), run: () => openText(text) });

  const [tabs, bookmarks, history] = await Promise.all([
    browser.tabs.query({}).catch(() => []),
    browser.bookmarks.search(text).catch(() => []),
    browser.history.search({ text, startTime: 0, maxResults: 40 }).catch(() => []),
  ]);
  const current = await browser.tabs.getCurrent();
  for (const tab of tabs.filter(tab => tab.id !== current?.id && WEB_URL.test(tab.url || "") && matches(text, tab.title || "", tab.url))
    .slice(0, 2)) {
    add({ kind: "tab", url: tab.url, title: tab.title || tab.url, detail: t("newtab_suggestSwitchTab"),
      run: async () => {
        await browser.tabs.update(tab.id, { active: true });
        await browser.windows.update(tab.windowId, { focused: true });
        if (current) {
          browser.tabs.remove(current.id); // prázdnou novou kartu po přepnutí zavřít, jako Firefox
        }
      } });
  }
  for (const bookmark of bookmarks.filter(b => b.url && WEB_URL.test(b.url)).slice(0, 3)) {
    add({ kind: "bookmark", url: bookmark.url, title: bookmark.title || bookmark.url, detail: hostOf(bookmark.url),
      run: () => browser.tabs.update({ url: bookmark.url }) });
  }
  for (const item of history.filter(h => WEB_URL.test(h.url || ""))
    .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0))) {
    if (items.length >= SUGGEST_MAX) {
      break;
    }
    add({ kind: "history", url: item.url, title: item.title || item.url, detail: hostOf(item.url),
      run: () => browser.tabs.update({ url: item.url }) });
  }
  return items.slice(0, SUGGEST_MAX);
}

const KIND_ICONS = { search: "🔍", alias: "🔍", url: "🌐", tab: "🗂️", bookmark: "⭐", history: "🕘" };

function renderSuggestions(items) {
  suggestionItems = items;
  selectedIndex = -1;
  list.replaceChildren(...items.map((item, index) => {
    const row = document.createElement("li");
    row.id = `suggestion-${index}`;
    row.role = "option";
    row.className = `suggestion ${item.kind}`;
    const icon = document.createElement("span");
    icon.className = "suggestion-icon";
    // ikony vyhledávačů jsou data: URL z prohlížeče, weby se nenačítají (nic se neodesílá)
    if (item.icon && /^data:image\//.test(item.icon)) {
      const img = document.createElement("img");
      img.src = item.icon;
      img.alt = "";
      icon.append(img);
    } else {
      icon.textContent = KIND_ICONS[item.kind];
    }
    const title = document.createElement("span");
    title.className = "suggestion-title";
    title.textContent = item.title;
    const detail = document.createElement("span");
    detail.className = "suggestion-detail";
    detail.textContent = item.detail;
    row.append(icon, title, detail);
    row.addEventListener("mousedown", event => event.preventDefault()); // pole nesmí ztratit fokus
    row.addEventListener("click", () => item.run());
    row.addEventListener("mousemove", () => select(index));
    return row;
  }));
  const open = items.length > 0;
  list.hidden = !open;
  query.setAttribute("aria-expanded", String(open));
  query.removeAttribute("aria-activedescendant");
}

function select(index) {
  selectedIndex = index;
  for (const [i, row] of [...list.children].entries()) {
    row.toggleAttribute("aria-selected", i === index);
  }
  if (index >= 0) {
    query.setAttribute("aria-activedescendant", `suggestion-${index}`);
  } else {
    query.removeAttribute("aria-activedescendant");
  }
}

function closeSuggestions() {
  renderSuggestions([]);
}

function updateSuggestions() {
  clearTimeout(suggestTimer);
  const text = query.value.trim();
  if (!text) {
    closeSuggestions();
    return;
  }
  const run = ++suggestRun;
  suggestTimer = setTimeout(async () => {
    const items = await buildSuggestions(text);
    if (run === suggestRun) { // mezitím se psalo dál
      renderSuggestions(items);
    }
  }, 60);
}

query.addEventListener("input", updateSuggestions);
query.addEventListener("focus", updateSuggestions);
query.addEventListener("blur", () => setTimeout(() => {
  if (document.activeElement !== query) { // jen opravdu opuštěné pole (klik jinam, Tab)
    closeSuggestions();
  }
}, 100));
query.addEventListener("keydown", event => {
  if (list.hidden) {
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    // šipkami dokola: −1 = zpět v poli (Enter pak hledá napsaný text)
    let next = selectedIndex + (event.key === "ArrowDown" ? 1 : -1);
    if (next >= suggestionItems.length) {
      next = -1;
    } else if (next < -1) {
      next = suggestionItems.length - 1;
    }
    select(next);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSuggestions();
  }
});

// ---------- Nejnavštěvovanější stránky ----------

async function renderSites() {
  let sites = [];
  try {
    sites = await browser.topSites.get({
      limit: 8,
      onePerDomain: true,
      includeFavicon: true,
    });
  } catch (e) {
    return;
  }

  const nav = document.getElementById("sites");
  for (const site of sites) {
    let host;
    try {
      host = new URL(site.url).hostname.replace(/^www\./, "");
    } catch (e) {
      continue;
    }

    const link = document.createElement("a");
    link.className = "site";
    link.href = site.url;
    link.title = site.title || host;

    const icon = document.createElement("span");
    icon.className = "site-icon";
    if (site.favicon) {
      const img = document.createElement("img");
      img.src = site.favicon;
      img.alt = "";
      icon.append(img);
    } else {
      icon.textContent = host.charAt(0).toUpperCase();
    }

    const title = document.createElement("span");
    title.className = "site-title";
    title.textContent = host;

    link.append(icon, title);
    nav.append(link);
  }
}

// ---------- Upozornění na novou verzi (viz background.js) ----------

async function renderUpdate() {
  const { update } = await browser.storage.local.get("update");
  // Verzi z Microsoft Store aktualizuje Store (proužek by mohl zůstat z doby před instalací)
  if (update && !(await browser.mantisPrefs.isPackaged())) {
    const el = document.getElementById("update");
    const latest = versionLabel(update.version, update.release);
    const current = versionLabel(MANTIS_LW_VERSION, MANTIS_RELEASE);
    el.textContent = t(update.installable ? "newtab_updateInstall" : "newtab_updateDownload", latest, current);
    if (update.url) {
      el.href = update.url;
    }
    if (update.installable) {
      // stáhne, ověří SHA-256 a spustí instalátor (background.js)
      el.addEventListener("click", async event => {
        event.preventDefault();
        el.textContent = t("common_installing");
        const reply = await browser.runtime.sendMessage({ installUpdate: true });
        el.textContent = reply?.error ? t("newtab_updateFailed", reply.error) : t("newtab_installerRunning");
        if (reply?.error) {
          el.addEventListener("click", () => browser.tabs.create({ url: update.url }), { once: true });
        }
      }, { once: true });
    }
    el.hidden = false;
  }
}

// ---------- Hodiny, pozadí, nastavení (Nastavení Mantis) ----------

function tick() {
  const now = new Date();
  document.getElementById("time").textContent =
    now.toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString(uiLocale(), { weekday: "long", day: "numeric", month: "long" });
  document.getElementById("date").textContent = date.charAt(0).toUpperCase() + date.slice(1);
}

async function renderLook() {
  const { newtabClock, newtabBackground, newtabWallpaper } =
    await browser.storage.local.get({ newtabClock: true, newtabBackground: true, newtabWallpaper: "" });
  // vlastní tapeta (Nastavení Mantis → Nová karta) má přednost před zeleným pozadím
  if (/^data:image\/(jpeg|png|webp);base64,/.test(newtabWallpaper)) {
    document.body.style.backgroundImage = `url("${newtabWallpaper}")`;
    document.body.classList.add("wallpaper");
  } else {
    document.body.classList.toggle("tinted", newtabBackground);
  }
  if (newtabClock) {
    tick();
    document.getElementById("clock").hidden = false;
    setInterval(tick, 1000);
  }
}

document.getElementById("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

// ---------- Statistiky ochrany (počítá ../stats.js, jen v tomto počítači) ----------

// ~50 ms na zablokovaný požadavek (odhad, jak ho používá Brave)
const STATS_MS_PER_BLOCK = 50;

async function renderStats() {
  const { newtabStats } = await browser.storage.local.get({ newtabStats: true });
  if (!newtabStats) {
    return;
  }
  const stats = await browser.runtime.sendMessage({ protectionStats: true });
  if (!stats?.week) {
    return;
  }
  const el = document.getElementById("stats");
  const count = document.createElement("b");
  count.textContent = stats.week.toLocaleString(uiLocale());
  const minutes = Math.round(stats.week * STATS_MS_PER_BLOCK / 60000);
  const [before, after] = t("newtab_stats", "\u0000").split("\u0000");
  el.replaceChildren(before, count, after, minutes >= 1 ? t("newtab_statsSaved", String(minutes)) : "");
  el.hidden = false;
}

renderLook();
renderStats();
renderSites();
renderUpdate();
