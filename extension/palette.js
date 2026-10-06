// Paleta příkazů (jako Vivaldi, Arc): Ctrl+Shift+Mezerník otevře jedno pole, které najde
// otevřenou kartu, záložku, historii, pracovní prostor i příkaz Mantisu (uspat karty, VPN,
// úsporný režim…). Panel kreslí experiment (mantisPrefs.showPalette), výsledky dodává tenhle
// skript (onPaletteInput → setPaletteResults), volbu provede onPaletteChoose.
// Vše jen z tohoto počítače – nic se neodesílá.

const PALETTE_MAX = 12;
let paletteActions = new Map();

// Bez diakritiky a velikosti písmen: „usp“ najde „Uspat“, „usporny“ najde „Úsporný“
function paletteFold(text) {
  return String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function paletteMatch(words, ...fields) {
  const hay = paletteFold(fields.join(" "));
  return words.every(word => hay.includes(word));
}

async function activeTab(windowId) {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  return tab;
}

// Otevřít adresu: prázdnou novou kartu přepsat, jinak nová karta
async function paletteOpenUrl(url, windowId) {
  const tab = await activeTab(windowId);
  const blank = !tab || /^(about:(newtab|home|blank)|moz-extension:.*\/newtab\/)/.test(tab.url || "");
  if (blank && tab) {
    await browser.tabs.update(tab.id, { url });
  } else {
    await browser.tabs.create({ url, windowId });
  }
}

// Příkazy: title je text v paletě, words navíc pro hledání (i anglicky)
function paletteCommands() {
  return [
    { id: "settings", icon: "⚙️", title: t("palette_settings"), words: "settings nastaveni",
      run: () => browser.runtime.openOptionsPage() },
    { id: "sidebar", icon: "💬", title: t("palette_sidebar"), words: "aplikace apps whatsapp messenger discord instagram spotify tiktok chat poznamky notes",
      run: windowId => browser.mantisPrefs.toggleSidebar(windowId) },
    { id: "newWorkspace", icon: "➕", title: t("palette_newWorkspace"), words: "workspace prostor",
      run: windowId => wsCreate(windowId) },
    { id: "sleepBackground", icon: "💤", title: t("palette_sleepBackground"), words: "sleep discard pamet",
      run: async () => {
        const tabs = (await browser.tabs.query({ active: false, discarded: false, pinned: false, audible: false }))
          .filter(tab => /^(https?|file):/.test(tab.url || "") && !tab.mutedInfo?.muted);
        if (tabs.length) {
          await browser.tabs.discard(tabs.map(tab => tab.id));
        }
      } },
    { id: "minimizeMemory", icon: "🧹", title: t("palette_minimizeMemory"), words: "memory ram pamet",
      run: () => browser.mantisPrefs.minimizeMemory() },
    { id: "eco", icon: "🔋", title: t("palette_eco"), words: "eco battery baterie usporny",
      run: async () => {
        const { ecoMode } = await browser.storage.local.get({ ecoMode: "off" });
        await browser.storage.local.set({ ecoMode: ecoMode === "on" ? "off" : "on" });
      } },
    { id: "vpn", icon: "🛡️", title: t("palette_vpn"), words: "vpn wireguard",
      run: () => handleVpnMessage({ vpn: "toggle" }) }, // vpn.js
    { id: "glow", icon: "✨", title: t("palette_glow"), words: "neon glow zare",
      run: async () => {
        const { themeGlow } = await browser.storage.local.get({ themeGlow: false });
        await browser.storage.local.set({ themeGlow: !themeGlow });
      } },
    { id: "reader", icon: "📖", title: t("palette_reader"), words: "reader ctecka",
      run: async windowId => browser.tabs.toggleReaderMode((await activeTab(windowId))?.id) },
    { id: "pin", icon: "📌", title: t("palette_pin"), words: "pin pripnout",
      run: async windowId => {
        const tab = await activeTab(windowId);
        await browser.tabs.update(tab.id, { pinned: !tab.pinned });
      } },
    { id: "mute", icon: "🔇", title: t("palette_mute"), words: "mute ztlumit zvuk",
      run: async windowId => {
        const tab = await activeTab(windowId);
        await browser.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
      } },
    { id: "volume", icon: "🔊", title: t("palette_volume"), words: "volume hlasitost",
      run: async windowId => browser.mantisPrefs.showTabVolume((await activeTab(windowId))?.id) },
    { id: "duplicate", icon: "📄", title: t("palette_duplicate"), words: "duplicate duplikovat",
      run: async windowId => browser.tabs.duplicate((await activeTab(windowId))?.id) },
    { id: "saveSession", icon: "💾", title: t("palette_saveSession"), words: "session relace ulozit save",
      run: windowId => sessSave(windowId) }, // savedsessions.js
    { id: "reopen", icon: "↩️", title: t("palette_reopen"), words: "reopen undo zavrena obnovit",
      run: async () => {
        const [last] = await browser.sessions.getRecentlyClosed({ maxResults: 1 });
        const sessionId = last?.tab?.sessionId || last?.window?.sessionId;
        if (sessionId) {
          await browser.sessions.restore(sessionId);
        }
      } },
  ];
}

async function paletteResults(text, windowId) {
  const words = paletteFold(text).split(/\s+/).filter(Boolean);
  const items = [];
  const seen = new Set();
  const add = (item, run) => {
    if (item.url && seen.has(item.url)) {
      return;
    }
    if (item.url) {
      seen.add(item.url);
    }
    items.push(item);
    paletteActions.set(item.id, run);
  };
  paletteActions = new Map();

  // Pracovní prostory
  const list = await wsList();
  const currentWs = await wsOfWindow(windowId, list);
  for (const w of list) {
    if (w.id !== currentWs && paletteMatch(words, w.name, "prostor workspace")) {
      add({ id: `ws:${w.id}`, icon: w.icon || "🗂️", title: t("palette_workspace", w.name), detail: t("palette_kindWorkspace") },
        () => wsSwitch(windowId, w.id));
    }
  }

  // Uložené relace (savedsessions.js)
  if (words.length) {
    for (const session of (await sessList()).filter(s => paletteMatch(words, s.name, "relace session")).slice(0, 4)) {
      add({ id: `sess:${session.id}`, icon: "🗂️", title: t("palette_session", session.name),
        detail: t("palette_kindSession", String(session.tabs.length)) }, () => sessRestore(session.id));
    }
  }

  // Příkazy
  for (const command of paletteCommands()) {
    if (!words.length || paletteMatch(words, command.title, command.words)) {
      add({ id: `cmd:${command.id}`, icon: command.icon, title: command.title, detail: t("palette_kindCommand") },
        () => command.run(windowId));
    }
  }

  // Otevřené karty (i schované v jiných prostorech – přepnutí prostor přepne)
  const tabs = await browser.tabs.query({});
  for (const tab of tabs.filter(tab => !tab.active && /^(https?|file):/.test(tab.url || "") &&
    words.length && paletteMatch(words, tab.title, tab.url)).slice(0, 4)) {
    add({ id: `tab:${tab.id}`, url: tab.url, title: tab.title || tab.url, detail: t("palette_kindTab") }, async () => {
      if (tab.hidden) {
        await wsSwitch(tab.windowId, await wsOfTab(tab.id, list));
      }
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
    });
  }

  if (words.length && text.trim().length >= 2) {
    const [bookmarks, history] = await Promise.all([
      browser.bookmarks.search(text.trim()).catch(() => []),
      browser.history.search({ text: text.trim(), startTime: 0, maxResults: 30 }).catch(() => []),
    ]);
    for (const bookmark of bookmarks.filter(b => b.url && /^(https?|file):/.test(b.url)).slice(0, 3)) {
      add({ id: `bm:${bookmark.id}`, url: bookmark.url, title: bookmark.title || bookmark.url, detail: t("palette_kindBookmark") },
        () => paletteOpenUrl(bookmark.url, windowId));
    }
    for (const item of history.filter(h => /^(https?|file):/.test(h.url || ""))
      .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0)).slice(0, 4)) {
      add({ id: `h:${item.id}`, url: item.url, title: item.title || item.url, detail: t("palette_kindHistory") },
        () => paletteOpenUrl(item.url, windowId));
    }
    // Poslední možnost: hledat na webu
    add({ id: "search", icon: "🔍", title: t("palette_search", text.trim()), detail: t("palette_kindSearch") },
      async () => {
        const tab = await activeTab(windowId);
        const blank = /^(about:(newtab|home|blank)|moz-extension:.*\/newtab\/)/.test(tab?.url || "");
        await browser.search.search(blank
          ? { query: text.trim(), tabId: tab.id }
          : { query: text.trim(), disposition: "NEW_TAB" });
      });
  }
  return items.slice(0, PALETTE_MAX);
}

browser.mantisPrefs.onPaletteInput.addListener(async (text, requestId, windowId) => {
  try {
    await browser.mantisPrefs.setPaletteResults(requestId, await paletteResults(text, windowId));
  } catch (e) {
    console.error("Mantis – paleta:", e);
  }
});

browser.mantisPrefs.onPaletteChoose.addListener(id => {
  Promise.resolve(paletteActions.get(id)?.()).catch(e => console.error("Mantis – paleta:", e));
});

browser.commands.onCommand.addListener(async command => {
  if (command === "command-palette") {
    const win = await browser.windows.getLastFocused();
    await browser.mantisPrefs.showPalette(win.id, t("palette_placeholder"));
  }
});
