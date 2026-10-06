// Messengery v bočním panelu (jako Opera): WhatsApp, Messenger, Discord… vedle stránky.
// Panel je sidebar/sidebar.html (sidebar_action), služby v něm běží v rámcích (iframe).
// Weby rámce zakazují (X-Frame-Options, CSP frame-ancestors) – kvůli clickjackingu na cizích
// webech. Tady je rámec náš vlastní panel, takže zákaz zrušíme JEN pro rámce, jejichž
// nadřazený dokument je stránka panelu Mantisu. Na ostatních webech zůstává ochrana beze změny.
// Panel otevře zkratka Alt+Shift+M (manifest „_execute_sidebar_action“), paleta příkazů nebo
// Zobrazit → Postranní lišta. storage.local (sync): sidebarServices = ID zapnutých služeb.

const SIDEBAR_PAGE = browser.runtime.getURL("sidebar/sidebar.html");

// Služby: jen oficiální webové verze (https), žádné vlastní adresy – panel ruší ochranu
// rámců, proto jen pro tyto weby a jen uvnitř panelu. domains = weby služby včetně
// přihlášení (Messenger se přihlašuje přes facebook.com).
const MESSENGER_SERVICES = [
  { id: "whatsapp", name: "WhatsApp", url: "https://web.whatsapp.com/", domains: ["whatsapp.com"], color: "#25d366", letter: "W" },
  { id: "messenger", name: "Messenger", url: "https://www.messenger.com/", domains: ["messenger.com", "facebook.com"], color: "#0866ff", letter: "M" },
  { id: "discord", name: "Discord", url: "https://discord.com/app", domains: ["discord.com"], color: "#5865f2", letter: "D" },
  { id: "instagram", name: "Instagram", url: "https://www.instagram.com/direct/inbox/", domains: ["instagram.com"], color: "#e1306c", letter: "I" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/", domains: ["spotify.com"], color: "#1db954", letter: "S" },
];
const MESSENGER_DEFAULTS = ["whatsapp", "messenger", "discord", "spotify"];
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
