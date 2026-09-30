/* global t, uiLocale */
// Nastavení Mantis → Vzhled (vlastní motiv), Zvuky (sada, vlastní zvuky) a Mody (export/import).
// Logika vzhledu a zvuků je v ../appearance.js – tady jen úprava storage.local.
//
// Mod = soubor .mantis-mod (JSON): { format: "mantis-mod", version: 1, name, created,
//   theme: { preset, custom: {frame, toolbar, text, field, accent} | null, accent },
//   sounds: { pack, volume, custom: { key, open, close } },   // data: URL audio
//   wallpaper: "data:image/…" }                                 // volitelně
// Import přijme jen barvy #rrggbb, známé hodnoty a zvuky/obrázky v povolených formátech
// a velikostech; zvuk se musí dát přehrát, obrázek se znovu uloží přes canvas (zahodí se vše
// kromě pixelů). Žádný kód ani CSS – mod nemůže nic spustit. Přepínače zvuků mod nezapíná.

const HEX = /^#[0-9a-f]{6}$/i;
const THEME_IDS = ["mantis", "night", "neon", "ocean", "violet", "sunset", "day", "custom"];
const PACK_IDS = ["soft", "keyboard", "typewriter", "bubbles", "custom"];
const COLOR_KEYS = ["frame", "toolbar", "text", "field", "accent"];
const SOUND_KINDS = ["key", "open", "close"];
const SOUND_URL = /^data:audio\/(mpeg|mp3|ogg|wav|x-wav|wave|webm|aac|mp4|x-m4a|flac);base64,[A-Za-z0-9+/=]+$/;
const SOUND_MAX_BYTES = 300 * 1024;
const SOUND_MAX_SECONDS = 2;
const IMAGE_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MOD_MAX_BYTES = 12 * 1024 * 1024;
const FALLBACK_COLORS = { frame: "#101214", toolbar: "#181b1f", text: "#e8eaed", field: "#23272c", accent: "#22c55e" };

const $ = id => document.getElementById(id);

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Zvuk se musí dát dekódovat a nesmí být delší než 2 s
async function checkSound(dataUrl) {
  if (typeof dataUrl !== "string" || !SOUND_URL.test(dataUrl) || dataUrl.length > SOUND_MAX_BYTES * 1.4) {
    return false;
  }
  const ctx = new AudioContext();
  try {
    const bytes = await (await fetch(dataUrl)).arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    return buffer.duration <= SOUND_MAX_SECONDS + 0.05;
  } catch (e) {
    return false;
  } finally {
    ctx.close();
  }
}

// Obrázek znovu přes canvas (≤ 2560 px, JPEG) – jako při výběru tapety v settings.js
async function reencodeImage(source) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

// ---------- Vlastní motiv ----------

async function showCustomColors() {
  const { themePreset, themeCustom } = await browser.storage.local.get({ themePreset: "mantis", themeCustom: null });
  const presets = await browser.runtime.sendMessage({ themePresets: true });
  const colors = themeCustom || presets[themePreset] || FALLBACK_COLORS;
  for (const input of document.querySelectorAll("[data-theme-color]")) {
    input.value = HEX.test(colors[input.dataset.themeColor] || "") ? colors[input.dataset.themeColor] : FALLBACK_COLORS[input.dataset.themeColor];
  }
}

// Přepnutí na „Vlastní“: barvy převezme z motivu, který byl vybraný (když vlastní ještě nejsou)
$("theme-preset").addEventListener("change", async event => {
  if (event.currentTarget.value !== "custom") {
    return;
  }
  const { themeCustom } = await browser.storage.local.get({ themeCustom: null });
  if (!themeCustom) {
    const presets = await browser.runtime.sendMessage({ themePresets: true });
    const from = presets[event.currentTarget.dataset.previous || "night"] || FALLBACK_COLORS;
    await browser.storage.local.set({ themeCustom: Object.fromEntries(COLOR_KEYS.map(key => [key, from[key]])) });
  }
});
$("theme-preset").addEventListener("focus", event => {
  event.currentTarget.dataset.previous = event.currentTarget.value;
});

for (const input of document.querySelectorAll("[data-theme-color]")) {
  input.addEventListener("change", async () => {
    const custom = Object.fromEntries([...document.querySelectorAll("[data-theme-color]")]
      .map(el => [el.dataset.themeColor, el.value]));
    await browser.storage.local.set({ themeCustom: custom, themePreset: "custom" });
  });
}

// ---------- Sada zvuků a vlastní zvuky ----------

async function showSounds() {
  const { soundPack, soundCustom } = await browser.storage.local.get({ soundPack: "soft", soundCustom: null });
  $("sound-pack").value = PACK_IDS.includes(soundPack) ? soundPack : "soft";
  $("sound-custom-row").hidden = soundPack !== "custom";
  for (const item of document.querySelectorAll("[data-sound-kind]")) {
    const has = !!soundCustom?.[item.dataset.soundKind];
    item.querySelector("[data-sound-state]").textContent = t(has ? "settings_soundCustomSet" : "settings_soundCustomNone");
    item.querySelector("[data-sound-remove]").hidden = !has;
    item.querySelector("[data-sound-preview]").hidden = !has;
  }
}

$("sound-pack").addEventListener("change", event => {
  browser.storage.local.set({ soundPack: event.currentTarget.value });
});

for (const button of document.querySelectorAll("[data-sound-preview]")) {
  button.addEventListener("click", () => browser.mantisPrefs.previewSound(button.dataset.soundPreview));
}

let soundTarget = null;
for (const item of document.querySelectorAll("[data-sound-kind]")) {
  item.querySelector("[data-sound-choose]").addEventListener("click", () => {
    soundTarget = item.dataset.soundKind;
    $("sound-file").click();
  });
  item.querySelector("[data-sound-remove]").addEventListener("click", async () => {
    const { soundCustom } = await browser.storage.local.get({ soundCustom: null });
    await browser.storage.local.set({ soundCustom: { ...soundCustom, [item.dataset.soundKind]: "" } });
  });
}

$("sound-file").addEventListener("change", async event => {
  const file = event.currentTarget.files[0];
  event.currentTarget.value = "";
  const error = $("sound-custom-error");
  error.hidden = true;
  if (!file || !soundTarget) {
    return;
  }
  const dataUrl = file.size <= SOUND_MAX_BYTES ? await readAsDataURL(file) : "";
  if (!(await checkSound(dataUrl))) {
    error.textContent = t("settings_soundCustomInvalid", Math.round(SOUND_MAX_BYTES / 1024), SOUND_MAX_SECONDS);
    error.hidden = false;
    return;
  }
  const { soundCustom } = await browser.storage.local.get({ soundCustom: null });
  await browser.storage.local.set({ soundCustom: { ...soundCustom, [soundTarget]: dataUrl }, soundPack: "custom" });
});

// ---------- Mody: export ----------

$("mod-export").addEventListener("click", async () => {
  const config = await browser.storage.local.get({
    themePreset: "mantis", themeCustom: null, themeAccent: "",
    soundPack: "soft", soundVolume: 40, soundCustom: null, newtabWallpaper: "",
  });
  const name = $("mod-name").value.trim().slice(0, 60) || t("settings_modNameDefault");
  const mod = {
    format: "mantis-mod",
    version: 1,
    name,
    created: new Date().toISOString().slice(0, 10),
    theme: { preset: config.themePreset, custom: config.themeCustom, accent: config.themeAccent },
    sounds: {
      pack: config.soundPack,
      volume: config.soundVolume,
      custom: config.soundPack === "custom" ? config.soundCustom : null,
    },
  };
  if ($("mod-wallpaper").checked && IMAGE_URL.test(config.newtabWallpaper)) {
    mod.wallpaper = config.newtabWallpaper;
  }
  const blob = new Blob([JSON.stringify(mod, null, 1)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${name.replace(/[\\/:*?"<>|]+/g, "").trim() || "mantis"}.mantis-mod`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  $("mod-status").textContent = t("settings_modExported", link.download);
});

// ---------- Mody: import ----------

$("mod-import").addEventListener("click", () => $("mod-file").click());

async function readMod(file) {
  if (file.size > MOD_MAX_BYTES) {
    throw new Error("size");
  }
  const mod = JSON.parse(await file.text());
  if (mod?.format !== "mantis-mod" || mod.version !== 1) {
    throw new Error("format");
  }
  const changes = {};
  const theme = mod.theme || {};
  if (THEME_IDS.includes(theme.preset)) {
    changes.themePreset = theme.preset;
  }
  if (theme.custom && COLOR_KEYS.every(key => HEX.test(theme.custom[key] || ""))) {
    changes.themeCustom = Object.fromEntries(COLOR_KEYS.map(key => [key, theme.custom[key].toLowerCase()]));
  } else if (changes.themePreset === "custom") {
    delete changes.themePreset; // vlastní motiv bez platných barev → motiv nechat
  }
  changes.themeAccent = HEX.test(theme.accent || "") ? theme.accent.toLowerCase() : "";

  const sounds = mod.sounds || {};
  if (PACK_IDS.includes(sounds.pack)) {
    changes.soundPack = sounds.pack;
  }
  const volume = Math.round(Number(sounds.volume));
  if (volume >= 5 && volume <= 100) {
    changes.soundVolume = volume;
  }
  if (sounds.custom) {
    const custom = {};
    for (const kind of SOUND_KINDS) {
      custom[kind] = (await checkSound(sounds.custom[kind])) ? sounds.custom[kind] : "";
    }
    if (SOUND_KINDS.some(kind => custom[kind])) {
      changes.soundCustom = custom;
    } else if (changes.soundPack === "custom") {
      delete changes.soundPack;
    }
  }
  if (typeof mod.wallpaper === "string" && IMAGE_URL.test(mod.wallpaper)) {
    const blob = await (await fetch(mod.wallpaper)).blob();
    changes.newtabWallpaper = await reencodeImage(blob);
  }
  return { name: String(mod.name || "").slice(0, 60), changes };
}

$("mod-file").addEventListener("change", async event => {
  const file = event.currentTarget.files[0];
  event.currentTarget.value = "";
  if (!file) {
    return;
  }
  const status = $("mod-status");
  status.textContent = t("settings_modImporting");
  try {
    const { name, changes } = await readMod(file);
    await browser.storage.local.set(changes);
    status.textContent = t("settings_modImported", name || file.name);
  } catch (e) {
    status.textContent = t(e.message === "size" ? "settings_modTooBig" : "settings_modInvalid");
  }
});

// ---------- Aktualizace stránky ----------

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.themeCustom || changes.themePreset) {
    showCustomColors();
  }
  if (changes.soundPack || changes.soundCustom) {
    showSounds();
  }
});

showCustomColors();
showSounds();
