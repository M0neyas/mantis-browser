// Synchronizace Nastavení Mantis mezi počítači přes účet Firefoxu (storage.sync).
// Synchronizuje přepínače a seznamy z Nastavení Mantis – NE VPN profil (ten je jen
// v tomto počítači, zašifrovaný), stav VPN, údaje o aktualizacích ani choulostivé
// stránky (seznam vlastních webů by se jinak objevil na každém počítači se stejným
// účtem, třeba i na pracovním).
// Vyžaduje přihlášení k účtu Firefoxu se zapnutou synchronizací „Doplňky“.
// Přepínač syncSettings (výchozí zapnuto) je jen místní.

const SYNC_KEYS = [
  "newtabClock",
  "newtabBackground",
  "devUpdateCheck",
  "doh", // šifrované DNS: režim a poskytovatel
  "vpnRouting", // co jde přes VPN (kontejnery se mezi počítači můžou lišit)
  "vpnKillSwitch",
  "browserPrefs", // přepínače nastavení prohlížeče (obraz v obraze, autoplay, rolování, WebGL)
];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function syncEnabled() {
  const { syncSettings } = await browser.storage.local.get({ syncSettings: true });
  return syncSettings;
}

async function applyBrowserPrefs(prefs) {
  for (const [name, value] of Object.entries(prefs || {})) {
    try {
      await browser.mantisPrefs.set(name, value);
    } catch (e) {
      console.error("Mantis sync – nastavení", name, e);
    }
  }
}

// Místní změna → do synchronizace
async function pushLocal(keys) {
  if (!(await syncEnabled())) {
    return;
  }
  const local = await browser.storage.local.get(keys);
  const remote = await browser.storage.sync.get(keys);
  const changed = {};
  for (const key of keys) {
    if (key in local && !same(local[key], remote[key])) {
      changed[key] = local[key];
    }
  }
  if (Object.keys(changed).length) {
    await browser.storage.sync.set(changed);
  }
}

// Změna z jiného počítače → do místního nastavení
async function pullRemote(keys) {
  if (!(await syncEnabled())) {
    return;
  }
  const remote = await browser.storage.sync.get(keys);
  const local = await browser.storage.local.get(keys);
  const changed = {};
  for (const key of keys) {
    if (key in remote && !same(remote[key], local[key])) {
      changed[key] = remote[key];
    }
  }
  if (Object.keys(changed).length) {
    await browser.storage.local.set(changed); // same() v pushLocal zabrání ozvěně
    if (changed.browserPrefs) {
      await applyBrowserPrefs(changed.browserPrefs);
    }
  }
}

// Chyby (např. limit 8 KB na položku u dlouhých seznamů) nesmí nic rozbít
const logSyncError = e => console.error("Mantis sync:", e);

browser.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes).filter(k => SYNC_KEYS.includes(k));
  if (area === "local" && changes.syncSettings?.newValue) {
    // synchronizace znovu zapnuta: nejdřív převzít vzdálené, pak poslat zbytek
    pullRemote(SYNC_KEYS).then(() => pushLocal(SYNC_KEYS)).catch(logSyncError);
  } else if (keys.length && area === "local") {
    pushLocal(keys).catch(logSyncError);
  } else if (keys.length && area === "sync") {
    pullRemote(keys).catch(logSyncError);
  }
});

// Po spuštění: vzdálené nastavení má přednost (jiný počítač mohl mezitím něco změnit),
// co ve synchronizaci ještě není, se tam pošle.
(async () => {
  // Sestavení 2 choulostivé stránky synchronizovalo – smazat je i z účtu
  // (smazání se přenese na ostatní počítače; místní nastavení zůstává)
  await browser.storage.sync.remove("sensitive");
  await pullRemote(SYNC_KEYS);
  await pushLocal(SYNC_KEYS);
})().catch(logSyncError);
