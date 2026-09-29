// Varování před rizikovými e-shopy podle České obchodní inspekce (eshops/coi-risky.txt,
// generuje scripts/update-eshop-list.sh). Na takovém webu se nahoře ukáže lišta s varováním
// (eshops/warning.js). „Rozumím, pokračovat“ web přidá do výjimek (storage.local →
// eshopDismissed). Vypnout: Nastavení Mantis → Nákupy (eshopWarning, výchozí zapnuto).
// Nic se nikam neposílá – seznam je součástí prohlížeče.

const ESHOP_LIST_URL = "https://coi.gov.cz/pro-spotrebitele/rizikove-e-shopy/";
let eshopList = null; // Map doména → [{ path, date }]
let eshopListInfo = { generated: "", count: 0 };

async function loadEshopList() {
  if (eshopList) {
    return eshopList;
  }
  const text = await (await fetch(browser.runtime.getURL("eshops/coi-risky.txt"))).text();
  eshopList = new Map();
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) {
      const m = line.match(/\((\d{4}-\d{2}-\d{2})\), (\d+)/);
      if (m) {
        eshopListInfo = { generated: m[1], count: Number(m[2]) };
      }
      continue;
    }
    const [entry, date = ""] = line.trim().split("\t");
    if (!entry) {
      continue;
    }
    const slash = entry.indexOf("/");
    const domain = slash < 0 ? entry : entry.slice(0, slash);
    const path = slash < 0 ? "" : entry.slice(slash);
    if (!eshopList.has(domain)) {
      eshopList.set(domain, []);
    }
    eshopList.get(domain).push({ path, date });
  }
  return eshopList;
}

// Záznam pro adresu: doména i subdomény; záznam s cestou jen pro tu část webu
async function riskyEshop(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) {
    return null;
  }
  const list = await loadEshopList();
  const labels = u.hostname.toLowerCase().replace(/^www\./, "").split(".");
  const path = u.pathname.toLowerCase();
  for (let i = 0; i < labels.length - 1; i++) {
    const domain = labels.slice(i).join(".");
    for (const item of list.get(domain) || []) {
      if (!item.path || path.startsWith(item.path)) {
        return { site: domain + item.path, date: item.date };
      }
    }
  }
  return null;
}

async function checkEshopTab(tabId, url) {
  const { eshopWarning, eshopDismissed } = await browser.storage.local.get({ eshopWarning: true, eshopDismissed: [] });
  if (!eshopWarning) {
    return;
  }
  const hit = await riskyEshop(url);
  if (!hit || eshopDismissed.includes(hit.site)) {
    return;
  }
  const date = hit.date ? new Date(`${hit.date}T12:00:00`).toLocaleDateString(uiLocale()) : "";
  const data = {
    title: t("eshop_title"),
    text: date ? t("eshop_text", hit.site, date) : t("eshop_textNoDate", hit.site),
    coi: t("eshop_coi"),
    leave: t("eshop_leave"),
    dismiss: t("eshop_dismiss"),
    url: ESHOP_LIST_URL,
    site: hit.site,
  };
  try {
    await browser.tabs.executeScript(tabId, { code: `window.__mantisEshop = ${JSON.stringify(data)};` });
    await browser.tabs.executeScript(tabId, { file: "eshops/warning.js" });
  } catch (e) {
    // stránka se mezitím zavřela nebo změnila
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    checkEshopTab(tabId, tab.url).catch(e => console.error("Mantis – e-shopy:", e));
  }
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.eshopDismiss && typeof msg.eshopDismiss === "string") {
    return browser.storage.local.get({ eshopDismissed: [] }).then(({ eshopDismissed }) =>
      browser.storage.local.set({ eshopDismissed: [...new Set([...eshopDismissed, msg.eshopDismiss])] })
    );
  }
  if (msg?.eshopLeave && sender.tab) {
    // zpět, a když není kam, prázdná nová karta
    return browser.tabs.goBack(sender.tab.id).catch(() => browser.tabs.update(sender.tab.id, { url: "about:newtab" }));
  }
  if (msg?.eshopListInfo) {
    return loadEshopList().then(() => eshopListInfo);
  }
  return undefined;
});
