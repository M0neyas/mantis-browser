// Choulostivé stránky: vybrané weby se neukládají do historie.
// Po návštěvě se adresa hned smaže z historie (history.onVisited → deleteUrl),
// po zavření karty/okna se zapomene i v „Nedávno zavřených“.
// Nastavení v storage.local pod klíčem "sensitive" (Nastavení Mantis).

const SENSITIVE_DEFAULTS = {
  enabled: true,
  adult: true, // seznam sensitive/adult-domains.txt + klíčová slova
  custom: [], // vlastní weby (domény, platí i pro subdomény)
  exceptions: [], // výjimky – tyto weby se ukládají vždy
};
const SENSITIVE_MENU = "mantis-sensitive-site";

// Části hostname (oddělené tečkou nebo pomlčkou), které stačí obsahovat
const KEYWORD_PARTS = ["porn", "hentai", "nsfw", "xvideo", "xnxx", "xhamster"];
// Celé části hostname (substring by chytil i „essex“, „sussex“…)
const KEYWORD_TOKENS = new Set([
  "xxx", "sex", "sexy", "nude", "nudes", "milf", "erotic", "erotika", "erotik",
  "camgirl", "camgirls", "onlyfans", "fansly",
]);
// Domény nejvyššího řádu pro dospělé
const ADULT_TLDS = new Set(["xxx", "porn", "sex", "sexy", "adult"]);

let sensitiveConfig = { ...SENSITIVE_DEFAULTS };
let adultDomains = null; // Set, načte se až při zapnuté kategorii

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch (e) {
    return null;
  }
}

// "a.b.example.com" → ["a.b.example.com", "b.example.com", "example.com"]
function domainChain(host) {
  const labels = host.split(".");
  const chain = [];
  for (let i = 0; i < labels.length - 1; i++) {
    chain.push(labels.slice(i).join("."));
  }
  return chain.length ? chain : [host];
}

function inList(chain, list) {
  return chain.some(d => list.includes(d));
}

function hasKeyword(host) {
  if (ADULT_TLDS.has(host.slice(host.lastIndexOf(".") + 1))) {
    return true;
  }
  const tokens = host.split(/[.-]/);
  return tokens.some(t => KEYWORD_TOKENS.has(t) || KEYWORD_PARTS.some(k => t.includes(k)));
}

async function loadAdultDomains() {
  if (!adultDomains) {
    const text = await (await fetch(browser.runtime.getURL("sensitive/adult-domains.txt"))).text();
    adultDomains = new Set(text.split("\n").filter(l => l && !l.startsWith("#")));
  }
  return adultDomains;
}

// Nepoužívá config.enabled – „vymazat z dosavadní historie“ funguje i s vypnutým hlídáním
async function isSensitiveUrl(url) {
  const config = sensitiveConfig;
  const host = hostOf(url);
  if (!host) {
    return false;
  }
  const chain = domainChain(host);
  if (inList(chain, config.exceptions)) {
    return false;
  }
  if (inList(chain, config.custom)) {
    return true;
  }
  if (config.adult) {
    if (hasKeyword(host)) {
      return true;
    }
    const domains = await loadAdultDomains();
    return chain.some(d => domains.has(d));
  }
  return false;
}

async function loadSensitiveConfig() {
  const { sensitive } = await browser.storage.local.get("sensitive");
  sensitiveConfig = { ...SENSITIVE_DEFAULTS, ...sensitive };
  if (sensitiveConfig.enabled && sensitiveConfig.adult) {
    loadAdultDomains().catch(e => console.error(e));
  }
}

async function saveSensitiveConfig(changes) {
  await browser.storage.local.set({ sensitive: { ...sensitiveConfig, ...changes } });
  // storage.onChanged zavolá loadSensitiveConfig
}

// ---------- Hlídání ----------

browser.history.onVisited.addListener(async item => {
  if (sensitiveConfig.enabled && (await isSensitiveUrl(item.url))) {
    await browser.history.deleteUrl({ url: item.url });
  }
});

// Nedávno zavřené karty a okna (Ctrl+Shift+T, nabídka Historie)
async function forgetClosedSensitive() {
  if (!sensitiveConfig.enabled) {
    return;
  }
  for (const session of await browser.sessions.getRecentlyClosed()) {
    if (session.tab) {
      if (await isSensitiveUrl(session.tab.url)) {
        await browser.sessions.forgetClosedTab(session.tab.windowId, session.tab.sessionId);
      }
    } else if (session.window) {
      // Okno se zapomene celé, i když v něm byly i jiné karty
      for (const tab of session.window.tabs || []) {
        if (await isSensitiveUrl(tab.url)) {
          await browser.sessions.forgetClosedWindow(session.window.sessionId);
          break;
        }
      }
    }
  }
}

// Záznam v „nedávno zavřených“ vzniká až po onRemoved – chvíli počkat
function scheduleForgetClosed() {
  setTimeout(() => forgetClosedSensitive().catch(e => console.error(e)), 500);
}
browser.tabs.onRemoved.addListener(scheduleForgetClosed);
browser.windows.onRemoved.addListener(scheduleForgetClosed);

// ---------- Úklid dosavadní historie ----------

async function cleanSensitiveHistory() {
  const items = await browser.history.search({ text: "", startTime: 0, maxResults: 1000000 });
  let removed = 0;
  for (const item of items) {
    if (await isSensitiveUrl(item.url)) {
      await browser.history.deleteUrl({ url: item.url });
      removed++;
    }
  }
  await forgetClosedSensitive();
  return removed;
}

// Smaže z historie všechny adresy webu (včetně subdomén)
async function removeSiteFromHistory(site) {
  const items = await browser.history.search({ text: site, startTime: 0, maxResults: 1000000 });
  for (const item of items) {
    const host = hostOf(item.url);
    if (host && domainChain(host).includes(site)) {
      await browser.history.deleteUrl({ url: item.url });
    }
  }
}

// ---------- Kontextová nabídka ----------

browser.menus.create({
  id: SENSITIVE_MENU,
  title: "Neukládat tento web do historie",
  contexts: ["page", "tab"],
  documentUrlPatterns: ["http://*/*", "https://*/*"],
});

browser.menus.onShown.addListener((info, tab) => {
  const host = hostOf(info.pageUrl || tab?.url);
  if (info.menuIds.includes(SENSITIVE_MENU) && host) {
    browser.menus.update(SENSITIVE_MENU, { title: `Neukládat web ${host} do historie` });
    browser.menus.refresh();
  }
});

async function addSensitiveSite(site) {
  const custom = [...new Set([...sensitiveConfig.custom, site])];
  const exceptions = sensitiveConfig.exceptions.filter(d => d !== site);
  await saveSensitiveConfig({ enabled: true, custom, exceptions });
  await removeSiteFromHistory(site);
  await forgetClosedSensitive();
}

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== SENSITIVE_MENU) {
    return;
  }
  const site = hostOf(info.pageUrl || tab.url);
  if (!site) {
    return;
  }
  try {
    await addSensitiveSite(site);
    await browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/mantis.svg"),
      title: `Web ${site} se neukládá do historie`,
      message: "Dosavadní historie webu je smazaná. Změnit: Nastavení Mantis → Choulostivé stránky.",
    });
  } catch (e) {
    console.error(e);
  }
});

// ---------- Zprávy ze stránky Nastavení Mantis ----------

browser.runtime.onMessage.addListener(msg => {
  if (msg?.sensitiveClean) {
    return cleanSensitiveHistory().then(removed => ({ removed }), e => ({ error: e.message }));
  }
  return undefined;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sensitive) {
    loadSensitiveConfig();
  }
});

loadSensitiveConfig();
