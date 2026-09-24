// „Otevřít v jiném prohlížeči“ – pro weby, které v Mantisu nefungují. Netflix:
// licenční server chce podpis Widevine VMP, který mají jen oficiální prohlížeče.
//  - tlačítko v adresním řádku (pageAction) na webech ze seznamu (výchozí netflix.com)
//    + jednou za spuštění upozornění, kliknutím se web otevře v jiném prohlížeči
//  - kontextová nabídka stránky, karty a odkazu na všech webech
// Prohlížeče najde mantisPrefs.listBrowsers (registr Windows). Nastavení:
// storage.local → otherBrowser { browser: "auto" | id, notify } (jen tento počítač)
// a otherBrowserSites (synchronizuje se).

const OTHER_MENU = "mantis-other-browser";
const OTHER_NOTIFY = "mantis-other-browser:";
const OTHER_DEFAULTS = { browser: "auto", notify: true };
const OTHER_SITES_DEFAULT = ["netflix.com"];
const OTHER_REASONS = { "netflix.com": "Netflix v Mantisu videa nepřehraje" };

let otherBrowsers = []; // [{ id, name, isDefault }]
const otherNotified = new Set(); // weby, u kterých už upozornění bylo (do restartu)

function otherHost(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

function otherSiteOf(host, sites) {
  return sites.find(site => host === site || host.endsWith("." + site)) || null;
}

async function otherConfig() {
  const { otherBrowser, otherBrowserSites } = await browser.storage.local.get(["otherBrowser", "otherBrowserSites"]);
  return { ...OTHER_DEFAULTS, ...otherBrowser, sites: otherBrowserSites ?? OTHER_SITES_DEFAULT };
}

// Zvolený prohlížeč, jinak výchozí prohlížeč Windows, jinak první nalezený
function otherPreferred(config) {
  return otherBrowsers.find(b => b.id === config.browser) || otherBrowsers.find(b => b.isDefault) || otherBrowsers[0] || null;
}

async function openInOther(url, id) {
  const target = id ? otherBrowsers.find(b => b.id === id) : otherPreferred(await otherConfig());
  if (!target) {
    throw new Error("Nenašel jsem žádný jiný nainstalovaný prohlížeč");
  }
  return browser.mantisPrefs.openInBrowser(target.id, url);
}

function openInOtherWithFeedback(url, id) {
  return openInOther(url, id).then(name => ({ name }), e => {
    browser.notifications.create("mantis-other-browser-error", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/mantis.svg"),
      title: "Web se nepodařilo otevřít v jiném prohlížeči",
      message: e.message,
    });
    return { error: e.message };
  });
}

// ---------- Kontextová nabídka ----------

async function otherMenus() {
  await browser.menus.remove(OTHER_MENU).catch(() => {}); // odebere i podpoložky
  if (!otherBrowsers.length) {
    return;
  }
  const item = {
    contexts: ["page", "tab", "link"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
    targetUrlPatterns: ["http://*/*", "https://*/*"],
  };
  if (otherBrowsers.length === 1) {
    browser.menus.create({ ...item, id: OTHER_MENU, title: `Otevřít v prohlížeči ${otherBrowsers[0].name}` });
    return;
  }
  browser.menus.create({ ...item, id: OTHER_MENU, title: "Otevřít v jiném prohlížeči" });
  for (const b of otherBrowsers) {
    browser.menus.create({
      ...item, // podpoložky mají jinak jen kontext „page“
      id: `${OTHER_MENU}:${b.id}`,
      parentId: OTHER_MENU,
      title: b.isDefault ? `${b.name} (výchozí)` : b.name,
    });
  }
}

browser.menus.onClicked.addListener((info, tab) => {
  const menuId = String(info.menuItemId);
  if (menuId === OTHER_MENU || menuId.startsWith(OTHER_MENU + ":")) {
    const url = info.linkUrl || info.pageUrl || tab?.url;
    openInOtherWithFeedback(url, menuId.slice(OTHER_MENU.length + 1) || undefined);
  }
});

// ---------- Tlačítko v adresním řádku a upozornění ----------

async function otherUpdateTab(tab) {
  const config = await otherConfig();
  const host = otherHost(tab.url);
  const site = host && otherSiteOf(host, config.sites);
  const target = otherPreferred(config);
  if (!site || !target) {
    await browser.pageAction.hide(tab.id);
    return;
  }
  await browser.pageAction.setTitle({ tabId: tab.id, title: `Otevřít v prohlížeči ${target.name}` });
  await browser.pageAction.show(tab.id);
  if (config.notify && tab.active && !otherNotified.has(site)) {
    otherNotified.add(site);
    browser.notifications.create(OTHER_NOTIFY + tab.id, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/mantis.svg"),
      title: OTHER_REASONS[site] || `${site} otevírat v jiném prohlížeči`,
      message: `Kliknutím web otevřete v prohlížeči ${target.name}. Stejné tlačítko je vpravo v adresním řádku.`,
    });
  }
}

async function otherUpdateAllTabs() {
  for (const tab of await browser.tabs.query({})) {
    otherUpdateTab(tab).catch(() => {});
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    otherUpdateTab(tab).catch(() => {});
  }
});

browser.notifications.onClicked.addListener(async id => {
  if (!id.startsWith(OTHER_NOTIFY)) {
    return;
  }
  browser.notifications.clear(id);
  const tab = await browser.tabs.get(Number(id.slice(OTHER_NOTIFY.length))).catch(() => null);
  if (tab?.url) {
    openInOtherWithFeedback(tab.url);
  }
});

// ---------- Okno tlačítka a Nastavení Mantis ----------

async function otherRefresh() {
  otherBrowsers = await browser.mantisPrefs.listBrowsers();
  await otherMenus();
  await otherUpdateAllTabs();
}

browser.runtime.onMessage.addListener(msg => {
  if (msg?.otherBrowsers) {
    return (msg.refresh ? otherRefresh() : Promise.resolve())
      .then(otherConfig)
      .then(config => ({ browsers: otherBrowsers, preferred: otherPreferred(config)?.id ?? null }));
  }
  if (msg?.openInOther) {
    return openInOtherWithFeedback(msg.openInOther.url, msg.openInOther.id);
  }
  return undefined;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.otherBrowser || changes.otherBrowserSites)) {
    otherUpdateAllTabs();
  }
});

otherRefresh().catch(e => console.error("Mantis – jiný prohlížeč:", e));
