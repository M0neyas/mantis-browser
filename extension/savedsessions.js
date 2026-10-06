// Uložené relace (jako Vivaldi, Opera): všechny viditelné karty okna pod názvem, později
// jedním kliknutím zpátky v novém okně. Z palety příkazů (Uložit relaci / Relace: …)
// a z Nastavení Mantis → Uložené relace. Karty se po obnovení načítají až při otevření.
// storage.local (jen tento počítač): savedSessions [{ id, name, created, tabs: [{ url, title, pinned }] }].

const SESS_MAX = 50;
// jen http(s): file: rozšíření otevřít nesmí (windows.create/tabs.create ho odmítne)
const SESS_URL = /^https?:/;

async function sessList() {
  const { savedSessions } = await browser.storage.local.get({ savedSessions: [] });
  return Array.isArray(savedSessions) ? savedSessions : [];
}

async function sessSave(windowId, name) {
  const tabs = (await browser.tabs.query({ windowId }))
    .filter(tab => !tab.hidden && SESS_URL.test(tab.url || ""))
    .map(tab => ({ url: tab.url, title: (tab.title || "").slice(0, 200), pinned: tab.pinned }));
  if (!tabs.length) {
    return null;
  }
  const created = Date.now();
  const session = {
    id: Math.random().toString(36).slice(2, 10),
    name: (name || "").trim().slice(0, 80) ||
      t("sess_defaultName", new Date(created).toLocaleString(browser.i18n.getUILanguage(), { dateStyle: "medium", timeStyle: "short" })),
    created,
    tabs,
  };
  await browser.storage.local.set({ savedSessions: [session, ...(await sessList())].slice(0, SESS_MAX) });
  return session;
}

async function sessRestore(id) {
  const session = (await sessList()).find(s => s.id === id);
  const tabs = (session?.tabs || []).filter(tab => SESS_URL.test(tab.url || ""));
  if (!tabs.length) {
    return false;
  }
  const win = await browser.windows.create({ url: tabs[0].url });
  const first = win.tabs[0];
  if (tabs[0].pinned) {
    await browser.tabs.update(first.id, { pinned: true });
  }
  for (const tab of tabs.slice(1)) {
    // ostatní karty uspané – načtou se, až na ně uživatel klikne
    await browser.tabs.create({ windowId: win.id, url: tab.url, title: tab.title || undefined, discarded: !tab.pinned, active: false, pinned: tab.pinned })
      .catch(() => browser.tabs.create({ windowId: win.id, url: tab.url, active: false }));
  }
  return true;
}

async function sessRemove(id) {
  await browser.storage.local.set({ savedSessions: (await sessList()).filter(s => s.id !== id) });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.sessSave) {
    return (async () => {
      const windowId = msg.windowId ?? sender.tab?.windowId;
      return sessSave(windowId, msg.name);
    })();
  }
  if (msg?.sessRestore) {
    return sessRestore(String(msg.sessRestore));
  }
  if (msg?.sessRemove) {
    return sessRemove(String(msg.sessRemove));
  }
  return undefined;
});
