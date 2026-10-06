// Aplikace v bočním panelu (jako Opera): WhatsApp, Messenger, Discord, Spotify, TikTok, poznámky vedle stránky.
// Panel je sidebar/sidebar.html (sidebar_action), služby v něm běží v rámcích (iframe).
// Weby rámce zakazují (X-Frame-Options, CSP frame-ancestors) – kvůli clickjackingu na cizích
// webech. Tady je rámec náš vlastní panel, takže zákaz zrušíme JEN pro rámce, jejichž
// nadřazený dokument je stránka panelu Mantisu. Na ostatních webech zůstává ochrana beze změny.
// Najetím k levému okraji stránky vyjede plovoucí lišta s ikonami služeb (mantisPrefs.setSidebarRail –
// překrývá stránku, nic neodsune); kliknutí na službu teprve otevře panel, který stránku zúží.
// Panel otevře i zkratka Alt+Shift+M (manifest „_execute_sidebar_action“), paleta příkazů nebo
// Zobrazit → Postranní lišta. storage.local (sync): sidebarServices = ID zapnutých služeb,
// sidebarRail = lišta u okraje (výchozí zapnuto); jen místně sidebarLast = poslední služba.

const SIDEBAR_PAGE = browser.runtime.getURL("sidebar/sidebar.html");

// Služby: jen oficiální webové verze (https), žádné vlastní adresy – panel ruší ochranu
// rámců, proto jen pro tyto weby a jen uvnitř panelu. domains = weby služby včetně
// přihlášení. Messenger je od dubna 2026 jen na facebook.com/messages (messenger.com Meta zrušila). Loga v icons/services/<id>.svg (Simple Icons, CC0).
const MESSENGER_SERVICES = [
  { id: "whatsapp", name: "WhatsApp", url: "https://web.whatsapp.com/", domains: ["whatsapp.com"], color: "#25d366" },
  { id: "messenger", name: "Messenger", url: "https://www.facebook.com/messages/", domains: ["facebook.com", "messenger.com"], color: "#0866ff" },
  { id: "discord", name: "Discord", url: "https://discord.com/app", domains: ["discord.com"], color: "#5865f2" },
  { id: "instagram", name: "Instagram", url: "https://www.instagram.com/direct/inbox/", domains: ["instagram.com"], color: "#e1306c" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/", domains: ["spotify.com"], color: "#1db954" },
  { id: "tiktok", name: "TikTok", url: "https://www.tiktok.com/", domains: ["tiktok.com"], color: "#ff0050" },
  // Poznámky nejsou web – kreslí je stránka panelu (sidebar/notes.js)
  { id: "notes", name: t("notes_title"), kind: "notes", domains: [], color: "#eab308" },
];
const MESSENGER_DEFAULTS = ["whatsapp", "messenger", "discord", "spotify", "tiktok", "notes"];
const MESSENGER_DOMAINS = MESSENGER_SERVICES.flatMap(s => s.domains);

function messengerDomain(host) {
  return MESSENGER_DOMAINS.some(domain => host === domain || host.endsWith("." + domain));
}

function inMantisSidebar(details) {
  // přímý rámec panelu: documentUrl = stránka panelu; vnořené: některý z nadřazených
  return (details.documentUrl || "").startsWith(SIDEBAR_PAGE) ||
    (details.frameAncestors || []).some(frame => (frame.url || "").startsWith(SIDEBAR_PAGE));
}

browser.webRequest.onHeadersReceived.addListener(details => {
  let host;
  try {
    host = new URL(details.url).hostname;
  } catch (e) {
    return undefined;
  }
  // jen weby služeb ze seznamu a jen v panelu
  if (!messengerDomain(host)) {
    return undefined;
  }
  if (!inMantisSidebar(details)) {
    return undefined;
  }
  const responseHeaders = [];
  for (const header of details.responseHeaders) {
    const name = header.name.toLowerCase();
    if (name === "x-frame-options") {
      continue;
    }
    if (name === "content-security-policy" && /frame-ancestors/i.test(header.value || "")) {
      // víc hlaviček CSP Firefox spojí čárkou → každou politiku zvlášť, z ní jen frame-ancestors pryč
      const value = header.value.split(",")
        .map(policy => policy.split(";").filter(part => !/^\s*frame-ancestors\b/i.test(part)).join(";"))
        .filter(policy => policy.trim())
        .join(",");
      if (value.trim()) {
        responseHeaders.push({ name: header.name, value });
      }
      continue;
    }
    responseHeaders.push(header);
  }
  return { responseHeaders };
}, { urls: ["https://*/*"], types: ["sub_frame"] }, ["blocking", "responseHeaders"]);

// WhatsApp rámec odmítá už na serveru (Sec-Fetch-Dest: iframe → 400). V panelu se proto
// služby ptají jako dokument – stejně se k nim chová Opera. Jen weby služeb, jen v panelu.
browser.webRequest.onBeforeSendHeaders.addListener(details => {
  let host;
  try {
    host = new URL(details.url).hostname;
  } catch (e) {
    return undefined;
  }
  if (!messengerDomain(host) || !inMantisSidebar(details)) {
    return undefined;
  }
  const requestHeaders = details.requestHeaders.map(header =>
    header.name.toLowerCase() === "sec-fetch-dest" ? { name: header.name, value: "document" } : header);
  return { requestHeaders };
}, { urls: ["https://*/*"], types: ["sub_frame"] }, ["blocking", "requestHeaders"]);

// Lišta u okraje: zapnuté služby, nebo nic (vypnuto / žádná služba)
async function messengerRailPush() {
  const { sidebarServices, sidebarRail } = await browser.storage.local.get({ sidebarServices: MESSENGER_DEFAULTS, sidebarRail: true });
  const services = sidebarRail
    ? MESSENGER_SERVICES.filter(s => sidebarServices.includes(s.id))
      .map(({ domains, ...service }) => ({ ...service, icon: browser.runtime.getURL(`icons/services/${service.id}.svg`) }))
    : [];
  await browser.mantisPrefs.setSidebarRail(services, { title: t("sidebar_title"), settings: t("sidebar_settings") });
}

browser.mantisPrefs.onSidebarRailChoose.addListener(async (id, windowId) => {
  if (id === "settings") {
    await browser.tabs.create({ windowId, url: browser.runtime.getURL("settings/settings.html#messengers") });
    return;
  }
  await browser.storage.local.set({ sidebarLast: id }); // stránka panelu přepne na tuto službu
  await browser.mantisPrefs.showSidebar(windowId);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.sidebarServices || changes.sidebarRail)) {
    messengerRailPush().catch(e => console.error("Mantis – lišta messengerů:", e));
  }
});
browser.windows.onCreated.addListener(() => messengerRailPush().catch(() => {}));
messengerRailPush().catch(e => console.error("Mantis – lišta messengerů:", e));

// Označený text → nová poznámka s odkazem na stránku, panel se otevře na poznámkách
const NOTES_MENU = "mantis-add-note";
browser.menus.create({ id: NOTES_MENU, title: t("notes_menu"), contexts: ["selection"] });

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== NOTES_MENU) {
    return;
  }
  // panel otevřít hned – sidebarAction.open() smí jen přímo z kliknutí
  browser.sidebarAction.open().catch(() => {});
  (async () => {
    const { notes } = await browser.storage.local.get({ notes: [] });
    const now = Date.now();
    const page = /^https?:/.test(tab?.url || "") ? { url: tab.url, title: (tab.title || "").slice(0, 120) } : {};
    const note = { id: Math.random().toString(36).slice(2, 10), text: String(info.selectionText || "").slice(0, 20000), ...page, created: now, updated: now };
    await browser.storage.local.set({ sidebarLast: "notes", notes: [note, ...(Array.isArray(notes) ? notes : [])].slice(0, 500) });
  })().catch(e => console.error("Mantis – poznámky:", e));
});

// Stránka panelu si bere seznam služeb odsud (jeden zdroj pravdy)
browser.runtime.onMessage.addListener(msg => {
  if (msg?.messengerServices) {
    return browser.storage.local.get({ sidebarServices: MESSENGER_DEFAULTS }).then(({ sidebarServices }) => ({
      services: MESSENGER_SERVICES.map(({ domains, ...service }) => service),
      enabled: sidebarServices.filter(id => MESSENGER_SERVICES.some(s => s.id === id)),
    }));
  }
  return undefined;
});
