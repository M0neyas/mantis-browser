// „Zapomenout tento web“ – v kontextové nabídce stránky a karty.
// Smaže historii, cookies, cache, data a oprávnění webu (celé základní domény).

const FORGET_MENU = "mantis-forget-site";

function siteOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : null;
  } catch (e) {
    return null;
  }
}

browser.menus.create({
  id: FORGET_MENU,
  title: t("forget_menu"),
  contexts: ["page", "tab"],
  documentUrlPatterns: ["http://*/*", "https://*/*"],
});

// Název položky podle aktuálního webu
browser.menus.onShown.addListener((info, tab) => {
  const site = siteOf(info.pageUrl || tab?.url);
  if (info.menuIds.includes(FORGET_MENU) && site) {
    browser.menus.update(FORGET_MENU, { title: t("forget_menuSite", site) });
    browser.menus.refresh();
  }
});

async function forgetSite(url) {
  const base = await browser.mantisPrefs.forgetSite(url);
  await browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/mantis.svg"),
    title: t("forget_doneTitle", base),
    message: t("forget_doneMessage"),
  });
  return base;
}

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === FORGET_MENU) {
    forgetSite(info.pageUrl || tab.url).catch(e => console.error(e));
  }
});

// Ze stránky Nastavení Mantis
browser.runtime.onMessage.addListener(msg => {
  if (msg?.forgetSite) {
    return forgetSite(msg.forgetSite).then(base => ({ base }), e => ({ error: e.message }));
  }
  return undefined;
});
