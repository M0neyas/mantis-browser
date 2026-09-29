// Nástroje v kontextové nabídce (Nastavení Mantis → Nástroje, každý jde vypnout):
//  - Kopírovat bez diakritiky: vybraný text do schránky bez háčků a čárek
//    (pravý klik na výběr, nebo klávesová zkratka – commands v manifestu)
//  - Uložit obrázek jako PNG / JPG: i z WebP/AVIF/SVG a z webů, které obrázek schovávají
//    pod průhlednou vrstvu nebo do pozadí prvku (hledá se obrázek pod místem kliknutí)
//  - Upravit a uložit PDF: tools/print-edit.js – kliknutím odstranit prvky, zvětšit/zmenšit,
//    pak tisk (v dialogu „Uložit jako PDF“)
// Nastavení: storage.local toolUnaccent / toolSaveImage / toolPrintEdit (výchozí zapnuto).

const TOOL_DEFAULTS = { toolUnaccent: true, toolSaveImage: true, toolPrintEdit: true };
const TOOL_MENU = {
  unaccent: "mantis-tool-unaccent",
  image: "mantis-tool-image",
  png: "mantis-tool-image:png",
  jpg: "mantis-tool-image:jpg",
  printEdit: "mantis-tool-print-edit",
};
const PAGE_PATTERNS = ["http://*/*", "https://*/*", "file:///*"];

function toolNotify(title, message = "") {
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/mantis.svg"),
    title,
    message,
  });
}

// ---------- Kopírovat bez diakritiky ----------

// NFD rozloží „č“ na „c“ + háček, háčky a čárky (Unicode značky) se zahodí
function withoutDiacritics(text) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // záloha: skryté pole na stránce na pozadí (oprávnění clipboardWrite)
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) {
      throw e;
    }
  }
}

// Celý výběr z karty (menus.selectionText může být zkrácený); frameId = rámec kliknutí
async function selectedText(tabId, frameId = 0) {
  const [text] = await browser.tabs.executeScript(tabId, {
    frameId,
    code: "String(window.getSelection())",
  });
  return text || "";
}

async function copyWithoutDiacritics(tabId, frameId, fallback = "") {
  let text = fallback;
  try {
    text = (await selectedText(tabId, frameId)) || fallback;
  } catch (e) {
    // stránky, kam rozšíření nesmí (about:, addons.mozilla.org) – zůstane text z nabídky
  }
  if (!text) {
    toolNotify(t("tools_unaccentNothing"));
    return;
  }
  await copyToClipboard(withoutDiacritics(text));
}

// ---------- Uložit obrázek jako PNG / JPG ----------

// Ve stránce: obrázek pod prvkem, na který uživatel klikl pravým tlačítkem
// (i když je překrytý průhlednou vrstvou nebo je jen pozadím prvku)
function findImageScript(targetElementId) {
  return `(() => {
    const target = browser.menus.getTargetElement(${JSON.stringify(targetElementId)});
    if (!target) return null;
    const box = target.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    for (const el of [target, ...document.elementsFromPoint(x, y)]) {
      if (el instanceof HTMLImageElement && (el.currentSrc || el.src)) return { url: el.currentSrc || el.src };
      if (el instanceof HTMLCanvasElement) {
        try { return { url: el.toDataURL("image/png") }; } catch (e) { continue; }
      }
      if (el instanceof SVGSVGElement) {
        return { url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(el)) };
      }
      const bg = getComputedStyle(el).backgroundImage.match(/url\\(["']?(.+?)["']?\\)/);
      if (bg) return { url: new URL(bg[1], document.baseURI).href };
    }
    return null;
  })()`;
}

function imageBaseName(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "data:") {
      return t("tools_imageDefaultName");
    }
    const name = decodeURIComponent(u.pathname.split("/").pop() || "").replace(/\.[a-z0-9]{2,5}$/i, "");
    return name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || t("tools_imageDefaultName");
  } catch (e) {
    return t("tools_imageDefaultName");
  }
}

// Stáhne obrázek (rozšíření smí na všechny weby, bez omezení CORS), převede ho přes canvas
// na PNG, nebo JPG (s bílým pozadím místo průhlednosti) a nabídne uložení
async function saveImageAs(url, format) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const source = URL.createObjectURL(blob);
  try {
    // onload, ne img.decode(): ve skryté stránce na pozadí se decode() nemusí dokončit
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(t("tools_imageUnsupported")));
      img.src = source;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 1024;
    canvas.height = img.naturalHeight || 1024;
    const ctx = canvas.getContext("2d");
    if (format === "jpg") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise(resolve =>
      canvas.toBlob(resolve, format === "jpg" ? "image/jpeg" : "image/png", 0.92)
    );
    const outUrl = URL.createObjectURL(out);
    try {
      await browser.downloads.download({
        url: outUrl,
        filename: `${imageBaseName(url)}.${format}`,
        saveAs: true,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(outUrl), 60000);
    }
  } finally {
    URL.revokeObjectURL(source);
  }
}

async function saveImageFromMenu(info, tab, format) {
  let url = info.mediaType === "image" ? info.srcUrl : null;
  if (!url && info.targetElementId !== undefined) {
    try {
      const [found] = await browser.tabs.executeScript(tab.id, {
        frameId: info.frameId || 0,
        code: findImageScript(info.targetElementId),
      });
      url = found?.url;
    } catch (e) {
      // stránka, kam rozšíření nesmí
    }
  }
  if (!url) {
    toolNotify(t("tools_imageNotFound"));
    return;
  }
  if (url.startsWith("blob:")) {
    toolNotify(t("tools_imageFailed"), t("tools_imageBlob"));
    return;
  }
  try {
    await saveImageAs(url, format);
  } catch (e) {
    if (!/cancel/i.test(e.message)) {
      toolNotify(t("tools_imageFailed"), e.message);
    }
  }
}

// ---------- Upravit a uložit PDF ----------

async function startPrintEdit(tabId) {
  try {
    await browser.tabs.insertCSS(tabId, { file: "tools/print-edit.css" });
    await browser.tabs.executeScript(tabId, { file: "tools/print-edit.js" });
  } catch (e) {
    toolNotify(t("tools_printEditUnavailable"));
  }
}

// Tlačítko „Zobrazení čtečky“ v liště (jen text a obrázky článku – i to jde vytisknout)
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.toolReaderMode && sender.tab) {
    return browser.tabs.toggleReaderMode(sender.tab.id).catch(() => {
      toolNotify(t("tools_readerUnavailable"));
    });
  }
  return undefined;
});

// ---------- Kontextová nabídka a zkratka ----------

async function toolMenus() {
  const config = await browser.storage.local.get(TOOL_DEFAULTS);
  for (const id of [TOOL_MENU.unaccent, TOOL_MENU.image, TOOL_MENU.printEdit]) {
    await browser.menus.remove(id).catch(() => {}); // odebere i podpoložky
  }
  if (config.toolUnaccent) {
    browser.menus.create({ id: TOOL_MENU.unaccent, title: t("tools_unaccentMenu"), contexts: ["selection"] });
  }
  if (config.toolSaveImage) {
    const item = { contexts: ["image", "page", "link", "frame"], documentUrlPatterns: PAGE_PATTERNS };
    browser.menus.create({ ...item, id: TOOL_MENU.image, title: t("tools_imageMenu") });
    browser.menus.create({ ...item, id: TOOL_MENU.png, parentId: TOOL_MENU.image, title: "PNG" });
    browser.menus.create({ ...item, id: TOOL_MENU.jpg, parentId: TOOL_MENU.image, title: "JPG" });
  }
  if (config.toolPrintEdit) {
    browser.menus.create({
      id: TOOL_MENU.printEdit,
      title: t("tools_printEditMenu"),
      contexts: ["page"],
      documentUrlPatterns: PAGE_PATTERNS,
    });
  }
}

browser.menus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case TOOL_MENU.unaccent:
      copyWithoutDiacritics(tab.id, info.frameId, info.selectionText).catch(e =>
        toolNotify(t("tools_unaccentFailed"), e.message)
      );
      break;
    case TOOL_MENU.png:
    case TOOL_MENU.jpg:
      saveImageFromMenu(info, tab, info.menuItemId === TOOL_MENU.png ? "png" : "jpg");
      break;
    case TOOL_MENU.printEdit:
      startPrintEdit(tab.id);
      break;
  }
});

browser.commands.onCommand.addListener(async command => {
  if (command !== "copy-without-diacritics") {
    return;
  }
  const { toolUnaccent } = await browser.storage.local.get(TOOL_DEFAULTS);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (toolUnaccent && tab) {
    // zkratka nezná rámec – výběr se hledá v hlavní stránce
    copyWithoutDiacritics(tab.id, 0).catch(e => toolNotify(t("tools_unaccentFailed"), e.message));
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(TOOL_DEFAULTS).some(k => changes[k])) {
    toolMenus();
  }
});

toolMenus();
