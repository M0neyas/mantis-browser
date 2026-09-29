// Uvítací stránka (otevře se při prvním spuštění, znovu z Nastavení Mantis).
// Rozšíření se neinstalují samy (pravidlo Microsoft Store 10.1.5 – jen se souhlasem):
// „Přidat“ otevře stránku rozšíření na addons.mozilla.org, instalaci potvrdí uživatel.
/* global t, applyI18n, uiLocale */

applyI18n();

// Texty: welcome_addon_<key>_name / _text / _warn (warn jen u TTV LOL PRO)
const RECOMMENDED = [
  { key: "bitwarden", id: "{446900e4-71c2-419f-a6a7-df9c091e268b}", slug: "bitwarden-password-manager", icon: "🔑" },
  { key: "containers", id: "@testpilot-containers", slug: "multi-account-containers", icon: "🗂️" },
  { key: "czechDictionary", id: "cs@dictionaries.addons.mozilla.org", slug: "czech-spell-checking-dictionar", icon: "✍️" },
  { key: "ttvLolPro", id: "{76ef94a4-e3d0-4c6f-961a-d38a429a332b}", slug: "ttv-lol-pro", icon: "📺", warn: true },
];

// Jazyk stránek addons.mozilla.org podle prohlížeče
const AMO_LOCALE = uiLocale().startsWith("cs") ? "cs" : "en-US";

// ---------- Rozšíření ----------

async function renderAddons() {
  let installed = {};
  try {
    installed = await browser.mantisPrefs.addonsInstalled(RECOMMENDED.map(a => a.id));
  } catch (e) {
    // bez informace o instalaci se ukážou tlačítka u všech
  }
  const list = document.getElementById("addons");
  list.replaceChildren();
  for (const addon of RECOMMENDED) {
    const row = document.createElement("div");
    row.className = "option addon";

    const icon = document.createElement("span");
    icon.className = "addon-icon";
    icon.textContent = addon.icon;

    const text = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = t(`welcome_addon_${addon.key}_name`);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = t(`welcome_addon_${addon.key}_text`);
    text.append(name, hint);
    if (addon.warn) {
      const warn = document.createElement("span");
      warn.className = "hint warn";
      warn.textContent = t(`welcome_addon_${addon.key}_warn`);
      text.append(warn);
    }

    let action;
    if (installed[addon.id]) {
      action = document.createElement("span");
      action.className = "badge";
      action.textContent = t("welcome_installed");
    } else {
      action = document.createElement("button");
      action.type = "button";
      action.textContent = t("welcome_add");
      action.addEventListener("click", () => {
        browser.tabs.create({ url: `https://addons.mozilla.org/${AMO_LOCALE}/firefox/addon/${addon.slug}/` });
      });
    }
    row.append(icon, text, action);
    list.append(row);
  }
}

// Po instalaci na vedlejší kartě a návratu sem ukázat „Nainstalováno“
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    renderAddons();
  }
});

// ---------- Šifrované DNS (logika v ../doh.js) ----------

const dohBox = document.getElementById("doh-auto");

async function showDoh() {
  const { doh } = await browser.storage.local.get("doh");
  dohBox.checked = (doh?.mode || "off") !== "off";
}

dohBox.addEventListener("change", async () => {
  const { doh } = await browser.storage.local.get("doh");
  await browser.storage.local.set({
    doh: { mode: "off", provider: "quad9", ...doh, mode: dohBox.checked ? "auto" : "off" },
  });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.doh) {
    showDoh();
  }
});

renderAddons();
showDoh();
