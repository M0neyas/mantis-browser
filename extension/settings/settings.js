/* global MANTIS_LW_VERSION */
// Stránka Nastavení Mantis: přepínače nastavení prohlížeče (přes mantisPrefs),
// volby nové karty (storage), zapomenutí webu, odkaz na VPN.

const STORE_DEFAULTS = { newtabClock: true, newtabBackground: true, devUpdateCheck: false };

// ---------- Nastavení prohlížeče ----------

for (const el of document.querySelectorAll("[data-pref]")) {
  const name = el.dataset.pref;
  browser.mantisPrefs.get(name).then(value => {
    if (el.type === "checkbox") {
      el.checked = value;
    } else {
      el.value = String(value);
    }
  });
  el.addEventListener("change", async () => {
    const value = el.type === "checkbox" ? el.checked : Number(el.value);
    await browser.mantisPrefs.set(name, value);
    // uložit i do storage – odtud se přepínače synchronizují na další počítače (sync.js)
    const { browserPrefs } = await browser.storage.local.get("browserPrefs");
    await browser.storage.local.set({ browserPrefs: { ...browserPrefs, [name]: value } });
  });
}

// ---------- Místní volby (nesynchronizují se) ----------

browser.storage.local.get({ syncSettings: true }).then(values => {
  for (const el of document.querySelectorAll("[data-local]")) {
    el.checked = values[el.dataset.local];
    el.addEventListener("change", () => browser.storage.local.set({ [el.dataset.local]: el.checked }));
  }
});

// ---------- Šifrované DNS (logika v ../doh.js) ----------

const DOH_DEFAULTS = { mode: "off", provider: "quad9" }; // výchozí vypnuto – zapíná uživatel

async function showDoh() {
  const { doh, dohState } = await browser.storage.local.get(["doh", "dohState"]);
  const config = { ...DOH_DEFAULTS, ...doh };
  for (const el of document.querySelectorAll("[data-doh]")) {
    el.value = config[el.dataset.doh];
  }
  document.querySelector('[data-doh="provider"]').disabled = config.mode === "off";
  const state = document.getElementById("doh-state");
  if (dohState) {
    const time = new Date(dohState.checked).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
    state.textContent = dohState.active
      ? `Zapnuto (${dohState.provider}) – ${dohState.reason}. Zkontrolováno v ${time}.`
      : `Vypnuto – ${dohState.reason}. Zkontrolováno v ${time}.`;
  }
}

for (const el of document.querySelectorAll("[data-doh]")) {
  el.addEventListener("change", async () => {
    const { doh } = await browser.storage.local.get("doh");
    await browser.storage.local.set({ doh: { ...DOH_DEFAULTS, ...doh, [el.dataset.doh]: el.value } });
  });
}

document.getElementById("doh-check").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  document.getElementById("doh-state").textContent = "Zjišťuji…";
  await browser.runtime.sendMessage({ dohCheck: true });
  event.currentTarget.disabled = false;
  showDoh();
});

// ---------- Co jde přes VPN (logika v ../vpn.js) ----------

const ROUTING_DEFAULTS = { mode: "all", sites: [], containers: [] };

// doména, IPv4 adresa nebo rozsah (192.168.1.0/24)
function normalizeRoute(text) {
  const entry = text.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[?#\s]/)[0];
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(entry)) {
    return entry;
  }
  return normalizeSite(entry);
}

async function saveRouting(changes) {
  const { vpnRouting } = await browser.storage.local.get("vpnRouting");
  await browser.storage.local.set({ vpnRouting: { ...ROUTING_DEFAULTS, ...vpnRouting, ...changes } });
}

async function showRouting() {
  const { vpnRouting } = await browser.storage.local.get("vpnRouting");
  const config = { ...ROUTING_DEFAULTS, ...vpnRouting };
  document.querySelector('[data-routing="mode"]').value = config.mode;
  for (const el of document.querySelectorAll("[data-routing-detail]")) {
    el.hidden = config.mode === "all";
  }
  const sites = document.getElementById("routing-sites");
  if (document.activeElement !== sites) {
    sites.value = config.sites.join("\n");
  }

  const list = document.getElementById("routing-containers");
  let containers = [];
  try {
    containers = await browser.contextualIdentities.query({});
  } catch (e) {
    // kontejnery vypnuté
  }
  list.replaceChildren();
  if (!containers.length) {
    list.textContent = "Žádné kontejnery – vytvoříte je tlačítkem kontejnerů ve spodní liště.";
    list.classList.add("hint");
  }
  for (const c of containers) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = config.containers.includes(c.cookieStoreId);
    box.addEventListener("change", async () => {
      const { vpnRouting: now } = await browser.storage.local.get("vpnRouting");
      const current = new Set({ ...ROUTING_DEFAULTS, ...now }.containers);
      box.checked ? current.add(c.cookieStoreId) : current.delete(c.cookieStoreId);
      saveRouting({ containers: [...current] });
    });
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = c.colorCode;
    label.append(box, dot, c.name);
    list.append(label);
  }
}

document.querySelector('[data-routing="mode"]').addEventListener("change", event => {
  saveRouting({ mode: event.currentTarget.value });
});

document.getElementById("routing-sites").addEventListener("change", event => {
  const entries = [...new Set(event.currentTarget.value.split(/[\n,]/).map(normalizeRoute).filter(Boolean))];
  event.currentTarget.value = entries.join("\n");
  saveRouting({ sites: entries });
});

// ---------- Nová karta ----------

browser.storage.local.get(STORE_DEFAULTS).then(values => {
  for (const el of document.querySelectorAll("[data-store]")) {
    el.checked = values[el.dataset.store];
    el.addEventListener("change", () => {
      browser.storage.local.set({ [el.dataset.store]: el.checked });
    });
  }
});

// ---------- Zapomenout web ----------

document.getElementById("forget").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.getElementById("forget-site");
  const result = document.getElementById("forget-result");
  const site = input.value.trim().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site) && site !== "localhost") {
    result.textContent = "Zadejte adresu webu, např. example.com.";
    return;
  }
  if (!confirm(`Zapomenout web ${site}? Smaže se jeho historie, cookies, cache a data.`)) {
    return;
  }
  const reply = await browser.runtime.sendMessage({ forgetSite: "https://" + site });
  result.textContent = reply?.error ? `Nepodařilo se: ${reply.error}` : `Web ${reply.base} je zapomenutý.`;
  if (!reply?.error) {
    input.value = "";
  }
});

// ---------- Choulostivé stránky (logika v ../sensitive.js) ----------

const SENSITIVE_DEFAULTS = { enabled: true, adult: true, custom: [], exceptions: [] };

// "https://www.Example.com/x" → "example.com"
function normalizeSite(text) {
  const site = text.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#:\s]/)[0].replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site) ? site : null;
}

async function saveSensitive(changes) {
  const { sensitive } = await browser.storage.local.get("sensitive");
  await browser.storage.local.set({ sensitive: { ...SENSITIVE_DEFAULTS, ...sensitive, ...changes } });
}

async function showSensitive() {
  const { sensitive } = await browser.storage.local.get("sensitive");
  const values = { ...SENSITIVE_DEFAULTS, ...sensitive };
  for (const el of document.querySelectorAll("[data-sensitive]")) {
    el.checked = values[el.dataset.sensitive];
  }
  for (const el of document.querySelectorAll("[data-sensitive-list]")) {
    if (document.activeElement !== el) {
      el.value = values[el.dataset.sensitiveList].join("\n");
    }
  }
  document.querySelector('[data-sensitive="adult"]').disabled = !values.enabled;
}

for (const el of document.querySelectorAll("[data-sensitive]")) {
  el.addEventListener("change", () => saveSensitive({ [el.dataset.sensitive]: el.checked }));
}

for (const el of document.querySelectorAll("[data-sensitive-list]")) {
  el.addEventListener("change", () => {
    const sites = el.value.split(/[\n,]/).map(normalizeSite).filter(Boolean);
    saveSensitive({ [el.dataset.sensitiveList]: [...new Set(sites)] });
    el.value = [...new Set(sites)].join("\n");
  });
}

document.getElementById("sensitive-clean").addEventListener("click", async event => {
  const button = event.currentTarget;
  const result = document.getElementById("sensitive-result");
  if (!confirm("Projít celou historii a smazat z ní choulostivé stránky?")) {
    return;
  }
  button.disabled = true;
  result.textContent = "Procházím historii…";
  const reply = await browser.runtime.sendMessage({ sensitiveClean: true });
  button.disabled = false;
  result.textContent = reply?.error
    ? `Nepodařilo se: ${reply.error}`
    : `Hotovo, smazáno stránek: ${reply.removed}.`;
});

// Změna z kontextové nabídky, synchronizace nebo kontroly DNS se ukáže i na otevřené stránce
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.sensitive) {
    showSensitive();
  }
  if (changes.doh || changes.dohState) {
    showDoh();
  }
  if (changes.vpnRouting) {
    showRouting();
  }
});
showSensitive();
showDoh();
showRouting();

// ---------- VPN a verze ----------

document.getElementById("open-vpn").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("vpn/popup.html?tab=1") });
});

browser.storage.local.get("update").then(({ update }) => {
  const release = Number.parseInt(MANTIS_RELEASE, 10) || 1;
  const base = /^\d/.test(MANTIS_LW_VERSION)
    ? `založeno na LibreWolf ${MANTIS_LW_VERSION}${release > 1 ? `, sestavení ${release}` : ""}`
    : "vývojová verze";
  document.getElementById("version").textContent = update
    ? `${base} · je dostupná nová verze ${update.latest}`
    : base;
  if (update) {
    document.getElementById("update-status").textContent = update.installable
      ? `Je dostupná nová verze ${update.latest}. „Nainstalovat“ ji stáhne, ověří a spustí instalátor.`
      : `Je dostupná nová verze ${update.latest} – stáhněte ji a nainstalujte přes současnou.`;
    document.getElementById("update-install").hidden = !update.installable;
  }
});

// Verze z Microsoft Store: aktualizace řeší Store (background.js je nekontroluje)
browser.mantisPrefs.isPackaged().then(packaged => {
  if (packaged) {
    document.getElementById("update-status").textContent =
      "Nainstalováno z Microsoft Store – nové verze instaluje Store automaticky.";
    document.getElementById("update-install").hidden = true;
  }
});

document.getElementById("update-install").addEventListener("click", async event => {
  const button = event.currentTarget;
  const status = document.getElementById("update-status");
  button.disabled = true;
  status.textContent = "Stahuji a ověřuji instalátor…";
  const reply = await browser.runtime.sendMessage({ installUpdate: true });
  button.disabled = false;
  status.textContent = reply?.error
    ? `Nepodařilo se: ${reply.error}`
    : "Instalátor je spuštěný – dokončete instalaci v jeho okně (Mantis se při ní zavře).";
});
