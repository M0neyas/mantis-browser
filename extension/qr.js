// QR kód adresy (jako Chrome, Edge): pravý klik na stránku nebo odkaz → „QR kód…“, nebo paleta
// příkazů. Kód se vytvoří v počítači (qr/qrcode.js), nic se neodesílá. Na webu se ukáže přes
// stránku (qr/overlay.js), kam rozšíření nesmí (about:, addons.mozilla.org…), na vlastní kartě.

const QR_MENU_PAGE = "mantis-qr-page";
const QR_MENU_LINK = "mantis-qr-link";
browser.menus.create({ id: QR_MENU_PAGE, title: t("qr_menuPage"), contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
browser.menus.create({ id: QR_MENU_LINK, title: t("qr_menuLink"), contexts: ["link"] });

async function showQr(tab, url) {
  const target = url || tab?.url || "";
  if (tab && /^https?:/.test(tab.url || "")) {
    try {
      const [loaded] = await browser.tabs.executeScript(tab.id, { code: "typeof mantisQr === 'function'" });
      if (!loaded) {
        await browser.tabs.executeScript(tab.id, { file: "/qr/qrcode.js" });
      }
      await browser.tabs.executeScript(tab.id, { code: `window.mantisQrTarget = ${JSON.stringify(target)};` });
      await browser.tabs.executeScript(tab.id, { file: "/qr/overlay.js" });
      return;
    } catch (e) {
      // stránka bez přístupu (třeba chráněná) → vlastní karta
    }
  }
  await browser.tabs.create({
    url: browser.runtime.getURL(`qr/qr.html?u=${encodeURIComponent(target)}`),
    index: tab ? tab.index + 1 : undefined,
    windowId: tab?.windowId,
  });
}

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === QR_MENU_PAGE) {
    showQr(tab).catch(e => console.error("Mantis – QR:", e));
  } else if (info.menuItemId === QR_MENU_LINK) {
    showQr(tab, info.linkUrl).catch(e => console.error("Mantis – QR:", e));
  }
});
