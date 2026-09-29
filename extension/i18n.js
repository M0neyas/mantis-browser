// Překlady rozšíření (browser.i18n, texty v _locales/<jazyk>/messages.json).
// Jazyk se řídí jazykem prohlížeče (= Windows): čeština, jinak angličtina.
//
// Stránky: applyI18n() doplní texty do prvků s atributy
//   data-i18n="klíč"              text prvku
//   data-i18n-html="klíč"         text s jednoduchými značkami <b>, <i>, <code>, <br>, <a href>
//                                 (jen tyto – nic jiného se z překladu do stránky nedostane)
//   data-i18n-placeholder / -title / -aria-label / -alt="klíč"   atributy
// Skripty: t("klíč", ...hodnoty za $1, $2…).

function t(key, ...subs) {
  const text = browser.i18n.getMessage(key, subs.map(String));
  if (!text) {
    console.warn("Mantis – chybí překlad:", key);
  }
  return text || key;
}

// Verze Mantisu: "156.0.1-1" a sestavení 3 → "156.0.1-1 (sestavení 3)"
function versionLabel(version, release) {
  const n = Number.parseInt(release, 10) || 1;
  return n > 1 ? t("versionRelease", version, n) : version;
}

// Datum a čas v jazyce prohlížeče
function uiLocale() {
  return browser.i18n.getUILanguage();
}

const I18N_TAGS = new Set(["B", "I", "CODE", "BR", "A"]);

function i18nMarkup(target, text) {
  const doc = new DOMParser().parseFromString(`<body>${text}</body>`, "text/html");
  const copy = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.append(node.data);
      } else if (node.nodeType === Node.ELEMENT_NODE && I18N_TAGS.has(node.tagName)) {
        const el = document.createElement(node.tagName.toLowerCase());
        if (node.tagName === "A") {
          const href = node.getAttribute("href") || "";
          if (/^https:\/\//.test(href)) {
            el.href = href;
            el.target = "_blank";
            el.rel = "noopener";
          } else if (/^\.\.\/[\w/.-]+$/.test(href)) {
            el.href = href; // stránka rozšíření
          }
        }
        copy(node, el);
        to.append(el);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        copy(node, to); // nepovolená značka – jen její text
      }
    }
  };
  target.replaceChildren();
  copy(doc.body, target);
}

function applyI18n(root = document) {
  document.documentElement.lang = uiLocale();
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-html]")) {
    i18nMarkup(el, t(el.dataset.i18nHtml));
  }
  for (const attr of ["placeholder", "title", "aria-label", "alt"]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
    }
  }
}
