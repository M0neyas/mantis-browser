// Pracovní prostory (jako Arc, Zen, Edge, Vivaldi): oddělené sady karet v jednom okně.
// Karty ostatních prostorů se jen schovají (tabs.hide) – dál existují, uspávají se podle
// pravidel uspávání karet a po přepnutí jsou zpátky. Připnuté karty jsou ve všech prostorech.
// Tlačítko s názvem prostoru vlevo od karet dělá experiment (mantisPrefs.setWorkspaces),
// přepínat jde i zkratkou (Ctrl+Alt+PageDown/PageUp), z palety příkazů a z nabídky karty.
// storage.local (jen tento počítač – karty se mezi počítači liší): workspaces [{id, name, icon, color}].
// Prostor karty a okna si pamatuje obnova relace (sessions.setTabValue / setWindowValue).

const WS_TAB_KEY = "mantisWs";
const WS_WINDOW_KEY = "mantisWs";
const WS_LAST_KEY = "mantisWsLast"; // { prostor: ID poslední aktivní karty }
const WS_MENU = "mantis-ws-move";
const WS_COLORS = ["#22c55e", "#38bdf8", "#f472b6", "#fb923c", "#a78bfa", "#facc15", "#f43f5e", "#2dd4bf"];
const WS_ICONS = ["🏠", "💼", "🎮", "🎵", "🛒", "📚", "✈️", "💬"];
const WS_MAX = 12;

let wsCache = null;
let wsMenuIds = [];
let wsBusy = Promise.resolve();

// Přepínání nesmí běžet souběžně (rychlé mačkání zkratky), jinak se schovají špatné karty
function wsQueue(task) {
  wsBusy = wsBusy.then(task, task).catch(e => console.error("Mantis – prostory:", e));
  return wsBusy;
}

function wsValid(list) {
  return Array.isArray(list) && list.length > 0 &&
    list.every(w => w && typeof w.id === "string" && typeof w.name === "string");
}

async function wsList() {
  if (!wsCache) {
    const { workspaces } = await browser.storage.local.get({ workspaces: null });
    wsCache = wsValid(workspaces)
      ? workspaces
      : [{ id: "home", name: t("ws_defaultName"), icon: WS_ICONS[0], color: WS_COLORS[0] }];
  }
  return wsCache;
}

async function wsSave(list) {
  wsCache = list;
  await browser.storage.local.set({ workspaces: list });
}

async function wsOfTab(tabId, list) {
  const id = await browser.sessions.getTabValue(tabId, WS_TAB_KEY).catch(() => undefined);
  return list.some(w => w.id === id) ? id : list[0].id; // neznámý (smazaný) prostor → první
}

async function wsOfWindow(windowId, list) {
  const id = await browser.sessions.getWindowValue(windowId, WS_WINDOW_KEY).catch(() => undefined);
  return list.some(w => w.id === id) ? id : list[0].id;
}

// Okno do stavu prostoru: ukázat jeho karty, aktivovat poslední použitou, ostatní schovat
async function wsApply(windowId, wsId) {
  const list = await wsList();
  const tabs = await browser.tabs.query({ windowId });
  const owners = await Promise.all(tabs.map(tab => wsOfTab(tab.id, list)));
  const previous = await wsOfWindow(windowId, list);
  const last = (await browser.sessions.getWindowValue(windowId, WS_LAST_KEY).catch(() => null)) || {};
  const active = tabs.find(tab => tab.active);
  if (active && !active.pinned) {
    last[previous] = active.id;
  }
  await browser.sessions.setWindowValue(windowId, WS_WINDOW_KEY, wsId);
  await browser.sessions.setWindowValue(windowId, WS_LAST_KEY, last);

  const mine = tabs.filter((tab, i) => !tab.pinned && owners[i] === wsId);
  const others = tabs.filter((tab, i) => !tab.pinned && owners[i] !== wsId);
  const hiddenMine = mine.filter(tab => tab.hidden).map(tab => tab.id);
  if (hiddenMine.length) {
    await browser.tabs.show(hiddenMine);
  }
  let target = mine.find(tab => tab.id === last[wsId]) ||
    [...mine].sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
  if (!active || active.pinned || owners[tabs.indexOf(active)] !== wsId) {
    if (target) {
      await browser.tabs.update(target.id, { active: true });
    } else {
      target = await browser.tabs.create({ windowId, active: true }); // prázdný prostor → nová karta
      await browser.sessions.setTabValue(target.id, WS_TAB_KEY, wsId);
    }
  }
  const hide = others.filter(tab => !tab.hidden).map(tab => tab.id);
  if (hide.length) {
    await browser.tabs.hide(hide);
  }
  await wsPush();
}

function wsSwitch(windowId, wsId) {
  return wsQueue(() => wsApply(windowId, wsId));
}

async function wsStep(windowId, step) {
  const list = await wsList();
  const current = await wsOfWindow(windowId, list);
  const index = list.findIndex(w => w.id === current);
  await wsSwitch(windowId, list[(index + step + list.length) % list.length].id);
}

async function wsCreate(windowId, name) {
  const list = await wsList();
  if (list.length >= WS_MAX) {
    return null;
  }
  const workspace = {
    id: Math.random().toString(36).slice(2, 10),
    name: name || t("ws_newName", String(list.length + 1)),
    icon: WS_ICONS[list.length % WS_ICONS.length],
    color: WS_COLORS[list.length % WS_COLORS.length],
  };
  await wsSave([...list, workspace]);
  if (windowId !== undefined) {
    await wsSwitch(windowId, workspace.id);
  }
  return workspace;
}

// Smazání prostoru: jeho karty přejdou do prvního prostoru (nic se nezavírá)
async function wsRemove(wsId) {
  const list = await wsList();
  if (list.length < 2 || !list.some(w => w.id === wsId)) {
    return;
  }
  const rest = list.filter(w => w.id !== wsId);
  for (const tab of await browser.tabs.query({})) {
    if (await browser.sessions.getTabValue(tab.id, WS_TAB_KEY).catch(() => undefined) === wsId) {
      await browser.sessions.setTabValue(tab.id, WS_TAB_KEY, rest[0].id);
    }
  }
  await wsSave(rest);
  await wsRefreshAll();
}

// Karta do jiného prostoru (nabídka karty); aktivní karta se před schováním vystřídá
function wsMoveTab(tab, wsId) {
  return wsQueue(async () => {
    const list = await wsList();
    await browser.sessions.setTabValue(tab.id, WS_TAB_KEY, wsId);
    await wsApply(tab.windowId, await wsOfWindow(tab.windowId, list));
  });
}

async function wsRefreshAll() {
  const list = await wsList();
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    await wsQueue(async () => wsApply(win.id, await wsOfWindow(win.id, list)));
  }
  await wsPush();
}

// Tlačítko v liště a podnabídka „Přesunout do prostoru“
async function wsPush() {
  const list = await wsList();
  const active = {};
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    active[win.id] = await wsOfWindow(win.id, list);
  }
  await browser.mantisPrefs.setWorkspaces(list, active, {
    label: t("ws_label"),
    tooltip: t("ws_tooltip"),
    add: t("ws_add"),
    edit: t("ws_edit"),
  });
  // jen vlastní položky – menus.removeAll() by smazal i nabídky ostatních částí Mantisu
  for (const id of wsMenuIds.reverse()) {
    await browser.menus.remove(id).catch(() => {});
  }
  wsMenuIds = [];
  if (list.length > 1) {
    wsMenuIds.push(browser.menus.create({ id: WS_MENU, title: t("ws_moveTab"), contexts: ["tab"] }));
    for (const w of list) {
      wsMenuIds.push(browser.menus.create({
        id: `${WS_MENU}:${w.id}`, parentId: WS_MENU, title: `${w.icon || ""} ${w.name}`.trim(), contexts: ["tab"],
      }));
    }
  }
}

browser.menus.onClicked.addListener((info, tab) => {
  const prefix = `${WS_MENU}:`;
  if (tab && String(info.menuItemId).startsWith(prefix)) {
    wsMoveTab(tab, String(info.menuItemId).slice(prefix.length));
  }
});

// Nová karta patří do prostoru svého okna (obnovené karty už svůj prostor mají)
browser.tabs.onCreated.addListener(async tab => {
  const list = await wsList();
  if (list.length < 2) {
    return;
  }
  const own = await browser.sessions.getTabValue(tab.id, WS_TAB_KEY).catch(() => undefined);
  if (!own) {
    await browser.sessions.setTabValue(tab.id, WS_TAB_KEY, await wsOfWindow(tab.windowId, list)).catch(() => {});
  }
});

// Karta přetažená do jiného okna přejde do jeho prostoru
browser.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  const list = await wsList();
  await browser.sessions.setTabValue(tabId, WS_TAB_KEY, await wsOfWindow(newWindowId, list)).catch(() => {});
  await browser.tabs.show(tabId).catch(() => {});
});

browser.windows.onCreated.addListener(() => wsPush().catch(() => {}));

browser.mantisPrefs.onWorkspaceAction.addListener((action, windowId, id) => {
  if (action === "switch") {
    wsSwitch(windowId, id);
  } else if (action === "new") {
    wsCreate(windowId);
  } else if (action === "edit") {
    browser.tabs.create({ url: browser.runtime.getURL("settings/settings.html#workspaces") });
  }
});

browser.commands.onCommand.addListener(async command => {
  if (command === "workspace-next" || command === "workspace-previous") {
    const win = await browser.windows.getLastFocused();
    wsStep(win.id, command === "workspace-next" ? 1 : -1);
  }
});

// Nastavení Mantis (settings/settings.js) mění seznam přes storage
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.workspaces) {
    wsCache = wsValid(changes.workspaces.newValue) ? changes.workspaces.newValue : null;
    wsRefreshAll().catch(e => console.error("Mantis – prostory:", e));
  }
});

browser.runtime.onMessage.addListener(msg => {
  if (msg?.wsRemove) {
    return wsRemove(String(msg.wsRemove));
  }
  return undefined;
});

// Po startu: schovat karty neaktivních prostorů (obnova relace je vrací viditelné)
wsRefreshAll().catch(e => console.error("Mantis – prostory:", e));
