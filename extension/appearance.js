// Vzhledy a zvuky (Nastavení Mantis → Vzhled, Zvuky).
//  - Motiv: barvy lišt, karet, adresního řádku a nabídek přes browser.theme (bez restartu)
//    + barva zvýraznění (--mb-accent v theme/userChrome.css) přes mantisPrefs.setAccent.
//    „Kudlanka“ = výchozí vzhled Mantisu (motiv se zruší, zvýraznění zelené).
//    „Vlastní“ (custom) = pět barev od uživatele (themeCustom), světlý/tmavý podle pozadí.
//  - Vlastní barva zvýraznění přebije barvu motivu.
//  - Zvuky psaní a karet (mantisPrefs.setSounds): sady generované v prohlížeči nebo vlastní
//    krátké soubory (soundCustom). Co se píše, se nečte.
// storage.local (synchronizuje se): themePreset, themeAccent ("" = podle motivu), themeCustom,
// soundTyping, soundTabs, soundVolume (0–100), soundPack. Jen místní (velké): tapeta nové karty
// (newtabWallpaper) a vlastní zvuky (soundCustom { key, open, close } – data: URL).
// Balíčky .mantis-mod (export/import všeho výše) řeší settings/mods.js.

const APPEARANCE_DEFAULTS = {
  themePreset: "mantis",
  themeAccent: "",
  soundTyping: false,
  soundTabs: false,
  soundVolume: 40,
  soundPack: "soft",
  themeCustom: null,
  soundCustom: null,
};

const HEX = /^#[0-9a-f]{6}$/i;

// Vlastní motiv: jen platné barvy, jinak výchozí vzhled; světlý/tmavý podle jasu pozadí
function customPreset(custom) {
  const keys = ["frame", "toolbar", "text", "field", "accent"];
  if (!custom || !keys.every(key => HEX.test(custom[key] || ""))) {
    return null;
  }
  const [r, g, b] = [1, 3, 5].map(i => parseInt(custom.frame.slice(i, i + 2), 16));
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
  return { ...Object.fromEntries(keys.map(key => [key, custom[key]])), scheme: light ? "light" : "dark" };
}

// frame = pozadí okna a karet, toolbar = lišty a vybraná karta, text, field = adresní řádek
const THEME_PRESETS = {
  mantis: null,
  night: { scheme: "dark", frame: "#101214", toolbar: "#181b1f", text: "#e8eaed", field: "#23272c", accent: "#22c55e" },
  neon: { scheme: "dark", frame: "#0e0a12", toolbar: "#1a1220", text: "#f6e9f1", field: "#2a1a31", accent: "#ff2e63" },
  ocean: { scheme: "dark", frame: "#0a1624", toolbar: "#0f2135", text: "#e2f1ff", field: "#16304b", accent: "#38bdf8" },
  violet: { scheme: "dark", frame: "#130e20", toolbar: "#1e1631", text: "#efe9ff", field: "#2b2046", accent: "#a78bfa" },
  sunset: { scheme: "dark", frame: "#1a0f0a", toolbar: "#261710", text: "#fff0e6", field: "#3a2317", accent: "#fb923c" },
  day: { scheme: "light", frame: "#e9eee9", toolbar: "#f7faf7", text: "#15261b", field: "#ffffff", accent: "#16a34a" },
};

function themeFromPreset(p) {
  // průhledná varianta barvy textu (rámečky, najetí myší) – rgba(), ne color-mix(): Firefox
  // některé barvy motivu sám parsuje
  const [r, g, b] = [1, 3, 5].map(i => parseInt(p.text.slice(i, i + 2), 16));
  const soft = alpha => `rgba(${r}, ${g}, ${b}, ${alpha / 100})`;
  return {
    colors: {
      frame: p.frame,
      frame_inactive: p.frame,
      tab_background_text: p.text,
      tab_selected: p.toolbar,
      tab_text: p.text,
      tab_line: p.accent,
      tab_loading: p.accent,
      toolbar: p.toolbar,
      toolbar_text: p.text,
      toolbar_top_separator: "transparent",
      toolbar_bottom_separator: "transparent",
      toolbar_field: p.field,
      toolbar_field_text: p.text,
      toolbar_field_border: "transparent",
      toolbar_field_focus: p.field,
      toolbar_field_text_focus: p.text,
      toolbar_field_border_focus: p.accent,
      toolbar_field_highlight: p.accent,
      popup: p.toolbar,
      popup_text: p.text,
      popup_border: soft(15),
      popup_highlight: p.accent,
      popup_highlight_text: p.scheme === "dark" ? "#0b0b0b" : "#ffffff",
      sidebar: p.toolbar,
      sidebar_text: p.text,
      sidebar_border: soft(12),
      icons: p.text,
      icons_attention: p.accent,
      button_background_hover: soft(10),
      button_background_active: soft(18),
    },
    properties: {
      color_scheme: p.scheme,
      content_color_scheme: "auto", // weby se dál řídí systémem / nastavením
    },
  };
}

async function appearanceApply() {
  const config = await browser.storage.local.get(APPEARANCE_DEFAULTS);
  const preset = config.themePreset === "custom"
    ? customPreset(config.themeCustom)
    : THEME_PRESETS[config.themePreset] ?? null;
  if (preset) {
    await browser.theme.update(themeFromPreset(preset));
  } else {
    await browser.theme.reset();
  }
  const accent = HEX.test(config.themeAccent) ? config.themeAccent : preset?.accent || "";
  await browser.mantisPrefs.setAccent(accent);
  await browser.mantisPrefs.setSounds({
    typing: config.soundTyping,
    tabs: config.soundTabs,
    volume: Math.max(0, Math.min(100, Number(config.soundVolume) || 0)) / 100,
    pack: config.soundPack,
    custom: config.soundCustom || {},
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some(key => key in APPEARANCE_DEFAULTS)) {
    appearanceApply().catch(e => console.error("Mantis – vzhled:", e));
  }
});

// Barvy motivů pro náhledy v Nastavení Mantis
browser.runtime.onMessage.addListener(msg => {
  if (msg?.themePresets) {
    return Promise.resolve(Object.fromEntries(Object.entries(THEME_PRESETS)
      .map(([id, p]) => [id, p && { frame: p.frame, toolbar: p.toolbar, text: p.text, field: p.field, accent: p.accent }])));
  }
  return undefined;
});

appearanceApply().catch(e => console.error("Mantis – vzhled:", e));
