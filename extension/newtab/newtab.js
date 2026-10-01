// Nová karta Mantis Browseru: vyhledávání, nejnavštěvovanější stránky,
// upozornění na novou verzi.
/* global t, applyI18n, versionLabel, uiLocale, MANTIS_LW_VERSION, MANTIS_RELEASE */

applyI18n();

const form = document.getElementById("search");
const query = document.getElementById("query");

// Adresa = bez mezer a s tečkou (seznam.cz, https://…), nebo localhost[:port]
function asUrl(text) {
  if (/\s/.test(text)) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text;
  }
  if (/^[^./]+(\.[^./]+)+(:\d+)?(\/.*)?$/.test(text) || /^localhost(:\d+)?(\/.*)?$/.test(text)) {
    return "https://" + text;
  }
  return null;
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const text = query.value.trim();
  if (!text) {
    return;
  }
  const url = asUrl(text);
  if (url) {
    browser.tabs.update({ url });
  } else {
    browser.search.search({ query: text }); // výchozí vyhledávač (DuckDuckGo)
  }
});

// ---------- Nejnavštěvovanější stránky ----------

async function renderSites() {
  let sites = [];
  try {
    sites = await browser.topSites.get({
      limit: 8,
      onePerDomain: true,
      includeFavicon: true,
    });
  } catch (e) {
    return;
  }

  const nav = document.getElementById("sites");
  for (const site of sites) {
    let host;
    try {
      host = new URL(site.url).hostname.replace(/^www\./, "");
    } catch (e) {
      continue;
    }

    const link = document.createElement("a");
    link.className = "site";
    link.href = site.url;
    link.title = site.title || host;

    const icon = document.createElement("span");
    icon.className = "site-icon";
    if (site.favicon) {
      const img = document.createElement("img");
      img.src = site.favicon;
      img.alt = "";
      icon.append(img);
    } else {
      icon.textContent = host.charAt(0).toUpperCase();
    }

    const title = document.createElement("span");
    title.className = "site-title";
    title.textContent = host;

    link.append(icon, title);
    nav.append(link);
  }
}

// ---------- Upozornění na novou verzi (viz background.js) ----------

async function renderUpdate() {
  const { update } = await browser.storage.local.get("update");
  // Verzi z Microsoft Store aktualizuje Store (proužek by mohl zůstat z doby před instalací)
  if (update && !(await browser.mantisPrefs.isPackaged())) {
    const el = document.getElementById("update");
    const latest = versionLabel(update.version, update.release);
    const current = versionLabel(MANTIS_LW_VERSION, MANTIS_RELEASE);
    el.textContent = t(update.installable ? "newtab_updateInstall" : "newtab_updateDownload", latest, current);
    if (update.url) {
      el.href = update.url;
    }
    if (update.installable) {
      // stáhne, ověří SHA-256 a spustí instalátor (background.js)
      el.addEventListener("click", async event => {
        event.preventDefault();
        el.textContent = t("common_installing");
        const reply = await browser.runtime.sendMessage({ installUpdate: true });
        el.textContent = reply?.error ? t("newtab_updateFailed", reply.error) : t("newtab_installerRunning");
        if (reply?.error) {
          el.addEventListener("click", () => browser.tabs.create({ url: update.url }), { once: true });
        }
      }, { once: true });
    }
    el.hidden = false;
  }
}

// ---------- Hodiny, pozadí, nastavení (Nastavení Mantis) ----------

function tick() {
  const now = new Date();
  document.getElementById("time").textContent =
    now.toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString(uiLocale(), { weekday: "long", day: "numeric", month: "long" });
  document.getElementById("date").textContent = date.charAt(0).toUpperCase() + date.slice(1);
}

async function renderLook() {
  const { newtabClock, newtabBackground, newtabWallpaper } =
    await browser.storage.local.get({ newtabClock: true, newtabBackground: true, newtabWallpaper: "" });
  // vlastní tapeta (Nastavení Mantis → Nová karta) má přednost před zeleným pozadím
  if (/^data:image\/(jpeg|png|webp);base64,/.test(newtabWallpaper)) {
    document.body.style.backgroundImage = `url("${newtabWallpaper}")`;
    document.body.classList.add("wallpaper");
  } else {
    document.body.classList.toggle("tinted", newtabBackground);
  }
  if (newtabClock) {
    tick();
    document.getElementById("clock").hidden = false;
    setInterval(tick, 1000);
  }
}

document.getElementById("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

renderLook();
renderSites();
renderUpdate();
