/* global MANTIS_LW_VERSION, MANTIS_RELEASE */
// Kontrola nových verzí, jednou denně:
//  - vydání Mantis Browseru na moneyas.cz (latest.json od scripts/publish-installer.sh):
//    upozornění Windows (jednou pro každou verzi) + proužek na nové kartě s odkazem ke stažení
//  - volitelně (Nastavení Mantis → pro sestavovatele) i nové verze LibreWolfu,
//    aby sestavovatel věděl, že má udělat nový build

const LATEST_URL = "https://moneyas.cz/mantis/download/latest.json";
const DOWNLOAD_PAGE = "https://moneyas.cz/mantis/";
const DOWNLOAD_BASE = "https://moneyas.cz/mantis/download/";
const TAGS_URL = "https://librewolf.dev/api/v1/repos/librewolf/source/tags?limit=10";
const ALARM = "mantis-update-check";

// "156.0.1-1" → [156, 0, 1, 1]
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?-(\d+)$/.exec(v);
  return m ? [m[1], m[2], m[3] || 0, m[4]].map(Number) : null;
}

function isNewer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {
      return (a[i] || 0) > (b[i] || 0);
    }
  }
  return false;
}

// Verze Mantisu = verze LibreWolfu + pořadí sestavení nad ní (MANTIS_RELEASE)
function releaseNumber(r) {
  return Number.parseInt(r, 10) || 1;
}

function mantisLabel(version, release) {
  return releaseNumber(release) > 1 ? `${version} (sestavení ${releaseNumber(release)})` : version;
}

async function fetchJson(url) {
  try {
    // Bez cookies; Cloudflare může místo JSON vrátit ověřovací stránku (403) – pak nic
    const response = await fetch(url, { cache: "no-store", credentials: "omit" });
    if (!response.ok || !/json/.test(response.headers.get("content-type") || "")) {
      return null;
    }
    return await response.json();
  } catch (e) {
    return null; // offline – zkusíme příště
  }
}

async function notifyOnce(key, id, title, message) {
  const { [key]: notified } = await browser.storage.local.get(key);
  if (notified !== title) {
    await browser.notifications.create(id, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/mantis.svg"),
      title,
      message,
    });
    await browser.storage.local.set({ [key]: title });
  }
}

async function checkMantisRelease() {
  const current = parseVersion(MANTIS_LW_VERSION);
  if (!current) {
    return; // načteno mimo build (zástupný text), není s čím porovnávat
  }
  if (await browser.mantisPrefs.isPackaged()) {
    // Verzi z Microsoft Store aktualizuje Store sám; vlastní instalátor by vedle
    // nainstaloval druhou kopii.
    await browser.storage.local.remove("update");
    return;
  }
  const latest = await fetchJson(LATEST_URL);
  const latestVersion = latest && parseVersion(latest.version);
  if (!latestVersion) {
    return;
  }
  const newer = isNewer(
    [...latestVersion, releaseNumber(latest.release)],
    [...current, releaseNumber(MANTIS_RELEASE)]
  );
  if (!newer) {
    await browser.storage.local.remove("update");
    return;
  }
  const label = mantisLabel(latest.version, latest.release);
  // Jednoklikovou instalaci nabídnout jen s názvem souboru a SHA-256 z latest.json
  const installable = /^[\w.-]+\.exe$/.test(latest.file || "") && /^[0-9a-f]{64}$/i.test(latest.sha256 || "");
  await browser.storage.local.set({
    update: {
      latest: label,
      current: mantisLabel(MANTIS_LW_VERSION, MANTIS_RELEASE),
      url: DOWNLOAD_PAGE,
      installable,
      file: latest.file,
      sha256: latest.sha256,
      size: latest.size,
      version: latest.version,
      release: releaseNumber(latest.release),
    },
  });
  await notifyOnce(
    "notified",
    "mantis-update",
    `Je tu nový Mantis Browser ${label}`,
    installable
      ? "Obsahuje bezpečnostní opravy. Klikněte a Mantis instalátor stáhne, ověří a spustí – " +
          "záložky i hesla zůstanou."
      : "Obsahuje bezpečnostní opravy. Klikněte pro stažení – instalátor stačí spustit přes " +
          "současnou verzi, záložky i hesla zůstanou."
  );
}

async function checkLibreWolf() {
  const { devUpdateCheck } = await browser.storage.local.get("devUpdateCheck");
  const current = parseVersion(MANTIS_LW_VERSION);
  if (!devUpdateCheck || !current) {
    return;
  }
  const tags = await fetchJson(TAGS_URL);
  let latest = null;
  for (const { name } of tags || []) {
    const v = parseVersion(name);
    if (v && (!latest || isNewer(v, latest.v))) {
      latest = { name, v };
    }
  }
  if (latest && isNewer(latest.v, current)) {
    await notifyOnce(
      "notifiedLibreWolf",
      "mantis-librewolf",
      `Vyšel LibreWolf ${latest.name}`,
      `Mantis je z verze ${MANTIS_LW_VERSION}. Spusťte scripts/check-update.sh --apply, ` +
        "build a publish-installer.sh."
    );
  }
}

function checkForUpdates() {
  checkMantisRelease();
  checkLibreWolf();
}

// ---------- Aktualizace jedním kliknutím ----------
// Stáhne instalátor do složky pro stahování, počká na dokončení a spustí ho přes
// mantisPrefs.launchInstaller, které těsně před spuštěním ověří SHA-256.

let installing = null;

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const listener = async delta => {
      if (delta.id !== id || !delta.state) {
        return;
      }
      if (delta.state.current === "complete") {
        browser.downloads.onChanged.removeListener(listener);
        const [item] = await browser.downloads.search({ id });
        resolve(item);
      } else if (delta.state.current === "interrupted") {
        browser.downloads.onChanged.removeListener(listener);
        reject(new Error("stahování se přerušilo"));
      }
    };
    browser.downloads.onChanged.addListener(listener);
  });
}

async function installUpdate() {
  const { update } = await browser.storage.local.get("update");
  if (!update?.installable) {
    browser.tabs.create({ url: DOWNLOAD_PAGE });
    return { opened: true };
  }
  if (!installing) {
    installing = (async () => {
      const id = await browser.downloads.download({
        url: DOWNLOAD_BASE + encodeURIComponent(update.file),
        filename: `Mantis-Browser-Setup-${update.version}-${update.release}.exe`,
        conflictAction: "overwrite",
        saveAs: false,
      });
      const item = await waitForDownload(id);
      await browser.mantisPrefs.launchInstaller(item.filename, update.sha256);
      return { launched: true };
    })().finally(() => {
      installing = null;
    });
  }
  return installing;
}

async function installUpdateWithFeedback() {
  try {
    return await installUpdate();
  } catch (e) {
    await browser.notifications.create("mantis-update-error", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/mantis.svg"),
      title: "Aktualizaci se nepodařilo nainstalovat",
      message: `${e.message}. Instalátor si můžete stáhnout ručně z moneyas.cz/mantis.`,
    });
    return { error: e.message };
  }
}

browser.notifications.onClicked.addListener(id => {
  if (id === "mantis-update") {
    browser.notifications.clear(id);
    installUpdateWithFeedback();
  } else if (id === "mantis-update-error") {
    browser.tabs.create({ url: DOWNLOAD_PAGE });
  }
});

// Z nové karty a Nastavení Mantis
browser.runtime.onMessage.addListener(msg => (msg?.installUpdate ? installUpdateWithFeedback() : undefined));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.devUpdateCheck?.newValue) {
    checkLibreWolf();
  }
});

browser.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) {
    checkForUpdates();
  }
});
browser.runtime.onStartup.addListener(checkForUpdates);
browser.runtime.onInstalled.addListener(checkForUpdates);

// ---------- Uvítací stránka při prvním spuštění (nový profil) ----------
// Vestavěné rozšíření se nainstaluje dřív, než existuje okno → počkat na první okno.

const WELCOME_URL = browser.runtime.getURL("welcome/welcome.html");

async function openWelcome() {
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  if (windows.length) {
    await browser.tabs.create({ url: WELCOME_URL, windowId: windows[0].id });
    return;
  }
  const onCreated = win => {
    if (win.type === "normal") {
      browser.windows.onCreated.removeListener(onCreated);
      browser.tabs.create({ url: WELCOME_URL, windowId: win.id });
    }
  };
  browser.windows.onCreated.addListener(onCreated);
}

browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    openWelcome().catch(e => console.error("Mantis – uvítací stránka:", e));
  }
});
