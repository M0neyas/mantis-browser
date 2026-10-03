/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global ExtensionAPI, Services, ChromeUtils, Cc, Ci, IOUtils, PathUtils */

"use strict";

// ExtensionError není v globálech ext-*.js skriptů (ExtensionCommon._createExtGlobal)
var { ExtensionError } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
).ExtensionUtils;

// Privilegované API vestavěného rozšíření Mantis (běží v rodičovském procesu).
// Nastavení jde měnit jen z tohoto seznamu – nic jiného.
const ALLOWED_PREFS = {
  "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled": "bool",
  "media.autoplay.default": "int",
  "general.smoothScroll.msdPhysics.enabled": "bool",
  "webgl.disabled": "bool",
  "mantis.urlbar.compact": "bool", // sbalený adresní řádek (theme/userChrome.css)
  // Žádosti webů o upozornění a polohu: 0 = ptát se, 2 = blokovat
  "permissions.default.desktop-notification": "int",
  "permissions.default.geo": "int",
  // Šifrované DNS (doh.js)
  "network.trr.mode": "int",
  "network.trr.uri": "string",
};

// Instalátor z aktualizace: jen tento název souboru a jen ze složky pro stahování
const INSTALLER_NAME = /^Mantis-Browser-Setup[\w.-]*\.exe$/i;

// Registrace VPN pomocníka pro native messaging (klíč hledá NativeManifests.sys.mjs)
const VPN_HOST_KEY = "Software\\Mozilla\\NativeMessagingHosts\\cz.mantis.vpn";

// Jiné prohlížeče (otherbrowser.js): registr, kam se prohlížeče zapisují pro
// dialog Výchozí aplikace. Vynechá se Mantis sám a Internet Explorer (Windows 11
// ho stejně přesměrují do Edge).
const BROWSERS_KEY = "Software\\Clients\\StartMenuInternet";
const SKIP_BROWSERS = /^iexplore\.exe$/i;
const DEFAULT_HTTPS_KEYS = [
  "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoiceLatest",
  "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
];

function readRegString(root, path, name = "", view = 0) {
  const key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(Ci.nsIWindowsRegKey);
  try {
    key.open(root, path, Ci.nsIWindowsRegKey.ACCESS_READ | view);
    return key.readStringValue(name);
  } catch (e) {
    return "";
  } finally {
    key.close();
  }
}

// "C:\…\brave.exe" --arg  /  C:\Program Files\…\x.exe  /  %ProgramFiles%\…
function exeFromCommand(command) {
  const cmd = command.trim().replace(/%([^%]+)%/g, (m, name) => Services.env.get(name) || m);
  const match = cmd.startsWith('"') ? cmd.match(/^"([^"]+)"/) : cmd.match(/^(.+?\.exe)(?=\s|$)/i);
  return match ? match[1] : "";
}

// [{ id, name, exe, isDefault }] – výchozí prohlížeč Windows první, pak podle názvu
function findBrowsers() {
  const R = Ci.nsIWindowsRegKey;
  const own = Services.dirsvc.get("XREExeF", Ci.nsIFile).path.toLowerCase();
  const found = new Map();
  for (const [root, view] of [
    [R.ROOT_KEY_CURRENT_USER, 0],
    [R.ROOT_KEY_LOCAL_MACHINE, R.WOW64_64],
    [R.ROOT_KEY_LOCAL_MACHINE, R.WOW64_32],
  ]) {
    const key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(R);
    try {
      key.open(root, BROWSERS_KEY, R.ACCESS_READ | view);
    } catch (e) {
      continue;
    }
    for (let i = 0; i < key.childCount; i++) {
      const id = key.getChildName(i);
      if (found.has(id) || SKIP_BROWSERS.test(id)) {
        continue;
      }
      const exe = exeFromCommand(readRegString(root, `${BROWSERS_KEY}\\${id}\\shell\\open\\command`, "", view));
      if (!/\.exe$/i.test(exe) || exe.toLowerCase() === own || !fileExists(exe)) {
        continue;
      }
      found.set(id, { id, name: readRegString(root, `${BROWSERS_KEY}\\${id}`, "", view) || id, exe });
    }
    key.close();
  }

  let defaultExe = "";
  for (const path of DEFAULT_HTTPS_KEYS) {
    const progId = readRegString(R.ROOT_KEY_CURRENT_USER, path, "ProgId");
    if (progId) {
      defaultExe = exeFromCommand(readRegString(R.ROOT_KEY_CLASSES_ROOT, `${progId}\\shell\\open\\command`)).toLowerCase();
      break;
    }
  }
  const list = [...found.values()].map(b => ({ ...b, isDefault: b.exe.toLowerCase() === defaultExe }));
  return list.sort((a, b) => b.isDefault - a.isDefault || a.name.localeCompare(b.name, Services.locale.appLocaleAsBCP47));
}

// Běží z balíčku MSIX (Microsoft Store)? Stejná kontrola jako ShellService.sys.mjs.
// Verze z Microsoft Store (MSIX). Vlastnost hasWinPackageId nemusí v nsSystemInfo být
// (Firefox ji sám čte s výchozí hodnotou) – pojistka: Store instaluje do …\WindowsApps\.
function isPackaged() {
  try {
    if (Services.sysinfo.getProperty("hasWinPackageId", false)) {
      return true;
    }
  } catch (e) {}
  try {
    return /\\WindowsApps\\/i.test(Services.dirsvc.get("XREExeF", Ci.nsIFile).path);
  } catch (e) {
    return false;
  }
}

function fileExists(path) {
  try {
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    return f.exists();
  } catch (e) {
    return false;
  }
}

function checkPref(name, fail) {
  const type = ALLOWED_PREFS[name];
  if (!type) {
    fail("err_prefNotAllowed", name);
  }
  return type;
}

function sha256Hex(bytes) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(bytes, bytes.length);
  const binary = hash.finish(false);
  return Array.from(binary, c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

// ---------- Výkon: statistiky, omezení CPU a sítě (performance.js) ----------
// Stav je na úrovni modulu – sdílí ho všechny stránky rozšíření a uklidí onShutdown.

let lastCpuSample = null; // { time, cpuNs } pro výpočet vytížení mezi dvěma voláními
let cpuCores = 0;

async function processStats() {
  if (!cpuCores) {
    try {
      cpuCores = (await Services.sysinfo.processInfo).count || 1; // logické procesory
    } catch (e) {
      cpuCores = 1;
    }
  }
  const info = await ChromeUtils.requestProcInfo();
  const all = [info, ...info.children];
  const memory = all.reduce((sum, p) => sum + (p.memory || 0), 0);
  const cpuNs = all.reduce((sum, p) => sum + (p.cpuTime || 0), 0);
  const now = Date.now();
  let cpuPercent = null;
  if (lastCpuSample && now > lastCpuSample.time) {
    const busyMs = (cpuNs - lastCpuSample.cpuNs) / 1e6;
    cpuPercent = Math.max(0, Math.min(100, (busyMs / (now - lastCpuSample.time) / cpuCores) * 100));
  }
  lastCpuSample = { time: now, cpuNs };
  return {
    memoryMB: Math.round(memory / 1048576),
    cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent),
    processes: all.length,
  };
}

const delay = ms => new Promise(resolve => {
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(() => resolve(), ms, Ci.nsITimer.TYPE_ONE_SHOT);
});

async function totalMemoryMB() {
  const info = await ChromeUtils.requestProcInfo();
  return Math.round([info, ...info.children].reduce((sum, p) => sum + (p.memory || 0), 0) / 1048576);
}

// Žrouti karet (jako about:processes): paměť a CPU procesů webů a karty, které v nich běží.
// S Fission má každý web vlastní proces – karty stejného webu ho sdílejí, ukazují se spolu.
// Rámce z jiných webů (reklamy, vložená videa) běží ve svých procesech a počítají se tam.
// Uspané karty proces nemají. Anonymní okna jen s povolením rozšíření pro anonymní okna.
let lastTabSample = new Map(); // pid → { time, cpuNs }

async function tabStats(extension) {
  if (!cpuCores) {
    try {
      cpuCores = (await Services.sysinfo.processInfo).count || 1;
    } catch (e) {
      cpuCores = 1;
    }
  }
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");
  const info = await ChromeUtils.requestProcInfo();
  const byPid = new Map(info.children.map(p => [p.pid, p]));
  const groups = new Map();
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.gBrowser || (PrivateBrowsingUtils.isWindowPrivate(win) && !extension.privateBrowsingAllowed)) {
      continue;
    }
    for (const tab of win.gBrowser.tabs) {
      const browser = tab.linkedBrowser;
      const pid = browser?.browsingContext?.currentWindowGlobal?.osPid || browser?.frameLoader?.remoteTab?.osPid;
      const proc = byPid.get(pid);
      if (!proc) {
        continue;
      }
      let group = groups.get(pid);
      if (!group) {
        group = { pid, memoryMB: Math.round((proc.memory || 0) / 1048576), cpuNs: proc.cpuTime || 0, tabIds: [] };
        groups.set(pid, group);
      }
      try {
        group.tabIds.push(extension.tabManager.getWrapper(tab).id);
      } catch (e) {}
    }
  }
  const now = Date.now();
  const sample = new Map();
  const result = [];
  for (const group of groups.values()) {
    const last = lastTabSample.get(group.pid);
    sample.set(group.pid, { time: now, cpuNs: group.cpuNs });
    let cpuPercent = null;
    if (last && now > last.time) {
      const busyMs = (group.cpuNs - last.cpuNs) / 1e6;
      cpuPercent = Math.round(Math.max(0, Math.min(100, busyMs / (now - last.time) / cpuCores * 100)) * 10) / 10;
    }
    if (group.tabIds.length) {
      result.push({ pid: group.pid, memoryMB: group.memoryMB, cpuPercent, tabIds: group.tabIds });
    }
  }
  lastTabSample = sample;
  return result.sort((a, b) => b.memoryMB - a.memoryMB);
}

// Uvolnění paměti jako about:memory → „Minimize memory usage“: úklid JS paměti (GC/CC),
// zahození mezipaměti obrázků a fontů ve všech procesech. Weby i karty zůstávají.
let minimizeRunning = null;

function minimizeMemory() {
  minimizeRunning ??= (async () => {
    const beforeMB = await totalMemoryMB();
    Services.obs.notifyObservers(null, "child-mmu-request"); // procesy webů
    const mgr = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);
    await new Promise(resolve => mgr.minimizeMemoryUsage(() => resolve()));
    await delay(1500); // procesy webů uklízí samy, chvíli to trvá
    const afterMB = await totalMemoryMB();
    return { beforeMB, afterMB };
  })().finally(() => {
    minimizeRunning = null;
  });
  return minimizeRunning;
}

// Úsporný režim: méně procesů pro weby (méně paměti; platí pro nově otevřené procesy),
// max. 60 snímků/s (méně práce GPU/CPU na 120–240Hz monitorech) a ukládání relace
// 1× za minutu místo 15 s. Uspávání karet po 15 min řeší tabsleep.js (ecoState).
// Režim "battery" = jen na baterii (Battery API okna prohlížeče – skryté okno na Windows
// není; při zavření okna se přejde na jiné). Počítač bez baterie se hlásí jako nabíjený
// → úsporný režim se nezapne.
const ECO_PREFS = {
  "dom.ipc.processCount": 4,
  "layout.frame_rate": 60,
  "browser.sessionstore.interval": 60000,
};
const eco = { mode: "off", active: false, battery: null, batteryWin: null, waiting: false };

function ecoSetPrefs(on) {
  for (const [name, value] of Object.entries(ECO_PREFS)) {
    if (on) {
      Services.prefs.setIntPref(name, value);
    } else if (Services.prefs.prefHasUserValue(name) && Services.prefs.getIntPref(name, 0) === value) {
      Services.prefs.clearUserPref(name); // jen naše hodnota – vlastní úpravu uživatele nechat
    }
  }
}

const ecoWanted = () => eco.mode === "on" || (eco.mode === "battery" && eco.battery?.charging === false);

function ecoUpdate() {
  const active = ecoWanted();
  if (active !== eco.active) {
    eco.active = active;
    ecoSetPrefs(active);
  }
}

function ecoBatteryWindowClosed() {
  eco.battery = null; // posluchače zmizí s oknem
  eco.batteryWin = null;
  if (eco.mode === "battery") {
    ecoWatchBattery(true).then(ecoUpdate, () => {});
  }
}

// Ještě žádné okno (start prohlížeče) → počkat na první
const ecoWindowObserver = {
  observe(subject, topic) {
    if (topic === "domwindowopened") {
      subject.addEventListener("load", () => {
        if (eco.mode === "battery" && !eco.battery) {
          ecoWatchBattery(true).then(ecoUpdate, () => {});
        }
      }, { once: true });
    }
  },
};

async function ecoWatchBattery(on) {
  if (eco.battery) {
    eco.battery.removeEventListener("chargingchange", ecoUpdate);
    eco.batteryWin?.removeEventListener("unload", ecoBatteryWindowClosed);
    eco.battery = null;
    eco.batteryWin = null;
  }
  const win = on ? [...Services.wm.getEnumerator("navigator:browser")].find(w => !w.closed) : null;
  if (win) {
    try {
      const battery = await win.navigator.getBattery();
      eco.battery = battery;
      eco.batteryWin = win;
      battery.addEventListener("chargingchange", ecoUpdate);
      win.addEventListener("unload", ecoBatteryWindowClosed, { once: true });
    } catch (e) {
      eco.battery = null; // bez Battery API se „jen na baterii“ nikdy nezapne
    }
  }
  const wait = on && !win;
  if (wait !== eco.waiting) {
    eco.waiting = wait;
    if (wait) {
      Services.ww.registerNotification(ecoWindowObserver);
    } else {
      Services.ww.unregisterNotification(ecoWindowObserver);
    }
  }
}

async function setEcoMode(mode) {
  eco.mode = ["on", "battery"].includes(mode) ? mode : "off";
  await ecoWatchBattery(eco.mode === "battery");
  // vždy zapsat/uklidit – po startu mohou v prefs.js zůstat hodnoty z minula
  eco.active = ecoWanted();
  ecoSetPrefs(eco.active);
  return ecoState();
}

function ecoState() {
  return { mode: eco.mode, active: eco.active, battery: eco.battery ? !eco.battery.charging : null };
}

// Omezení CPU: procesy s obsahem webů v Job Objectu Windows s tvrdým stropem
// (JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, procento výkonu celého počítače). Okno prohlížeče,
// GPU, síť ani dekódování videa se neomezují. Proces z jobu vyjmout nejde – vypnutí jen zruší strop.
const CPU_LIMITED_TYPES = /^(web|webIsolated|webServiceWorker|withCoopCoep|webLargeAllocation|file|preallocated)$/;
const cpuLimit = { percent: 0, job: null, api: null, assigned: new Set(), timer: null };

function cpuApi() {
  if (!cpuLimit.api) {
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    const k32 = ctypes.open("kernel32.dll");
    const HANDLE = ctypes.voidptr_t, BOOL = ctypes.int32_t, DWORD = ctypes.uint32_t;
    const RATE = ctypes.StructType("JOBOBJECT_CPU_RATE_CONTROL_INFORMATION", [{ ControlFlags: DWORD }, { CpuRate: DWORD }]);
    cpuLimit.api = {
      k32, RATE,
      CreateJobObjectW: k32.declare("CreateJobObjectW", ctypes.winapi_abi, HANDLE, ctypes.voidptr_t, ctypes.char16_t.ptr),
      SetInformationJobObject: k32.declare("SetInformationJobObject", ctypes.winapi_abi, BOOL, HANDLE, ctypes.int32_t, ctypes.voidptr_t, DWORD),
      OpenProcess: k32.declare("OpenProcess", ctypes.winapi_abi, HANDLE, DWORD, BOOL, DWORD),
      AssignProcessToJobObject: k32.declare("AssignProcessToJobObject", ctypes.winapi_abi, BOOL, HANDLE, HANDLE),
      CloseHandle: k32.declare("CloseHandle", ctypes.winapi_abi, BOOL, HANDLE),
    };
  }
  return cpuLimit.api;
}

function cpuApplyRate() {
  const api = cpuApi();
  if (!cpuLimit.job) {
    cpuLimit.job = api.CreateJobObjectW(null, null);
    if (cpuLimit.job.isNull()) {
      cpuLimit.job = null;
      return false;
    }
  }
  // ENABLE (1) | HARD_CAP (4); CpuRate v setinách procenta
  const rate = cpuLimit.percent
    ? new api.RATE(1 | 4, Math.round(cpuLimit.percent * 100))
    : new api.RATE(0, 0);
  return !!api.SetInformationJobObject(cpuLimit.job, 15, rate.address(), api.RATE.size);
}

async function cpuAssignNew() {
  if (!cpuLimit.percent || !cpuLimit.job) {
    return;
  }
  const api = cpuApi();
  const info = await ChromeUtils.requestProcInfo();
  const alive = new Set();
  for (const child of info.children) {
    alive.add(child.pid);
    if (!CPU_LIMITED_TYPES.test(child.type) || cpuLimit.assigned.has(child.pid)) {
      continue;
    }
    const handle = api.OpenProcess(0x0100 | 0x0001, 0, child.pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (!handle.isNull()) {
      if (api.AssignProcessToJobObject(cpuLimit.job, handle)) {
        cpuLimit.assigned.add(child.pid);
      }
      api.CloseHandle(handle);
    }
  }
  for (const pid of cpuLimit.assigned) {
    if (!alive.has(pid)) {
      cpuLimit.assigned.delete(pid);
    }
  }
}

async function setCpuLimit(percent) {
  cpuLimit.percent = percent;
  if (!cpuApplyRate()) {
    return false;
  }
  if (percent && !cpuLimit.timer) {
    // nové karty = nové procesy → přiřazovat průběžně
    cpuLimit.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    cpuLimit.timer.initWithCallback(() => cpuAssignNew().catch(() => {}), 3000, Ci.nsITimer.TYPE_REPEATING_SLACK);
  } else if (!percent && cpuLimit.timer) {
    cpuLimit.timer.cancel();
    cpuLimit.timer = null;
  }
  await cpuAssignNew();
  return true;
}

function cpuShutdown() {
  cpuLimit.timer?.cancel();
  cpuLimit.timer = null;
  if (cpuLimit.job) {
    cpuLimit.percent = 0;
    cpuApplyRate();
    cpuApi().CloseHandle(cpuLimit.job);
    cpuLimit.job = null;
  }
  cpuLimit.api?.k32.close();
  cpuLimit.api = null;
}

// Omezení sítě: stahování přes NetworkThrottleManager z DevTools (vloží se mezi síť a stránku
// a pouští data danou rychlostí; data z mezipaměti se neomezují), odesílání přes throttle queue.
// Platí pro HTTP(S) včetně stahování souborů – ne pro WebSocket a WebRTC.
const netLimit = { manager: null, observer: null };

function setNetworkLimit(kBps) {
  if (netLimit.observer) {
    Services.obs.removeObserver(netLimit.observer, "http-on-modify-request");
    Services.obs.removeObserver(netLimit.observer, "http-on-examine-response");
    netLimit.observer = null;
  }
  netLimit.manager?.destroy?.();
  netLimit.manager = null;
  if (!kBps) {
    return;
  }
  const { NetworkThrottleManager } = ChromeUtils.importESModule(
    "resource://devtools/shared/network-observer/NetworkThrottleManager.sys.mjs"
  );
  const bps = Math.round(kBps * 1024);
  const manager = new NetworkThrottleManager({
    latencyMean: 0, latencyMax: 0,
    downloadBPSMean: bps, downloadBPSMax: bps,
    uploadBPSMean: bps, uploadBPSMax: bps,
  });
  netLimit.manager = manager;
  netLimit.observer = {
    observe(subject, topic) {
      try {
        const channel = subject.QueryInterface(Ci.nsIHttpChannel);
        if (topic === "http-on-modify-request") {
          manager.manageUpload(channel);
        } else {
          manager.manage(channel.QueryInterface(Ci.nsITraceableChannel));
        }
      } catch (e) {
        // kanál bez podpory (např. už zrušený) – nechat být
      }
    },
  };
  Services.obs.addObserver(netLimit.observer, "http-on-modify-request");
  Services.obs.addObserver(netLimit.observer, "http-on-examine-response");
}

// ---------- Zvuky (appearance.js) ----------
// Stisk klávesy (v okně prohlížeče i ve webech – posluchač v okně prohlížeče, co se píše,
// se nečte), otevření a zavření karty. Klávesy s Ctrl/Alt a samotné modifikátory se ignorují.
// Sady generované přes WebAudio (žádné cizí soubory): soft, keyboard, typewriter, bubbles;
// custom = vlastní krátké soubory uživatele (data: URL, audio, nejvýš ~300 kB), chybějící
// událost v custom hraje soft.
const sounds = {
  typing: false, tabs: false, volume: 0.4, pack: "soft",
  custom: { key: "", open: "", close: "" },
  windows: new Map(), listening: false,
};
const SOUND_SKIP_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Tab", "Escape"]);
const SOUND_PACKS = new Set(["soft", "keyboard", "typewriter", "bubbles", "custom"]);
const SOUND_DATA_URL = /^data:audio\/(mpeg|mp3|ogg|wav|x-wav|wave|webm|aac|mp4|x-m4a|flac);base64,[A-Za-z0-9+/=]+$/;
const SOUND_MAX_CHARS = 420 * 1024; // ~300 kB v base64

function soundNoise(ctx, seconds, shape = 3) {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** shape;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  return src;
}

function soundTone(ctx, out, t, type, from, to, duration, level) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + Math.min(0.01, duration / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.03);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

function soundFiltered(ctx, out, t, seconds, type, frequency, q, level, rate = 1) {
  const src = soundNoise(ctx, seconds);
  src.playbackRate.value = rate;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.value = level;
  src.connect(filter).connect(gain).connect(out);
  src.start(t);
}

// Generované zvuky jednotlivých sad
function soundSynth(ctx, out, pack, kind) {
  const t = ctx.currentTime;
  const jitter = 0.9 + Math.random() * 0.25;
  if (kind === "key") {
    if (pack === "keyboard") {
      // mechanická klávesnice: ostré cvaknutí + tlumený doraz
      soundFiltered(ctx, out, t, 0.018, "highpass", 3200, 0.7, 1.1, jitter);
      soundTone(ctx, out, t + 0.004, "triangle", 190 * jitter, 90, 0.035, 0.5);
    } else if (pack === "typewriter") {
      // psací stroj: úder typu + kovový dozvuk
      soundFiltered(ctx, out, t, 0.03, "bandpass", 1600, 1.2, 1.3, jitter);
      soundTone(ctx, out, t, "square", 2600 * jitter, 2400, 0.05, 0.06);
    } else if (pack === "bubbles") {
      soundTone(ctx, out, t, "sine", 700 * jitter + Math.random() * 300, 260, 0.06, 0.45);
    } else {
      soundFiltered(ctx, out, t, 0.025, "bandpass", 2400, 0.8, 0.9, jitter);
    }
    return;
  }
  const open = kind === "open";
  if (pack === "typewriter") {
    // otevření = „cink“, zavření = posun válce
    if (open) {
      soundTone(ctx, out, t, "sine", 1900, 1850, 0.35, 0.3);
    } else {
      soundFiltered(ctx, out, t, 0.16, "bandpass", 900, 0.6, 0.7, 0.8);
    }
  } else if (pack === "bubbles") {
    soundTone(ctx, out, t, "sine", open ? 300 : 900, open ? 1100 : 250, 0.12, 0.4);
  } else if (pack === "keyboard") {
    soundFiltered(ctx, out, t, 0.03, "highpass", 2500, 0.7, 0.9);
    soundTone(ctx, out, t, "triangle", open ? 440 : 330, open ? 660 : 220, 0.08, 0.3);
  } else {
    soundTone(ctx, out, t, "sine", open ? 520 : 700, open ? 880 : 380, 0.09, 0.35);
  }
}

// Vlastní soubor: data: URL → ArrayBuffer → AudioBuffer (dekódovaný jednou pro každé okno)
async function soundCustomBuffer(state, ctx, kind) {
  const url = sounds.custom[kind];
  if (!url) {
    return null;
  }
  state.buffers ||= new Map();
  if (state.buffers.has(url)) {
    return state.buffers.get(url);
  }
  let buffer = null;
  try {
    const base64url = url.slice(url.indexOf(",") + 1).replace(/\+/g, "-").replace(/\//g, "_");
    const bytes = ChromeUtils.base64URLDecode(base64url, { padding: "ignore" });
    buffer = await ctx.decodeAudioData(bytes);
  } catch (e) {
    // nepodporovaný nebo poškozený soubor → zahraje se generovaný zvuk
  }
  state.buffers.set(url, buffer);
  return buffer;
}

// Přehrání na zkoušku (Nastavení Mantis) funguje i se zvuky vypnutými – bez posluchačů kláves
const soundPreviewStates = new WeakMap();

async function soundPlay(win, kind) {
  let state = sounds.windows.get(win);
  if (!state && kind.startsWith("preview:")) {
    state = soundPreviewStates.get(win) || {};
    soundPreviewStates.set(win, state);
  }
  kind = kind.replace("preview:", "");
  if (!state) {
    return;
  }
  try {
    const ctx = (state.ctx ||= new win.AudioContext());
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const out = ctx.createGain();
    out.gain.value = sounds.volume;
    out.connect(ctx.destination);
    if (sounds.pack === "custom") {
      const buffer = await soundCustomBuffer(state, ctx, kind);
      if (buffer) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(out);
        src.start();
        src.stop(ctx.currentTime + Math.min(buffer.duration, 2)); // nejvýš 2 s
        return;
      }
    }
    soundSynth(ctx, out, sounds.pack === "custom" ? "soft" : sounds.pack, kind);
  } catch (e) {
    // bez zvukového zařízení apod.
  }
}

function soundAttach(win) {
  if (sounds.windows.has(win) || !win.gBrowser) {
    return;
  }
  const state = {
    ctx: null,
    lastKey: 0,
    onKey(event) {
      if (!sounds.typing || event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
          SOUND_SKIP_KEYS.has(event.key)) {
        return;
      }
      const now = Date.now();
      if (now - state.lastKey < 30) {
        return;
      }
      state.lastKey = now;
      soundPlay(win, "key");
    },
    onTabOpen() {
      if (sounds.tabs) {
        soundPlay(win, "open");
      }
    },
    onTabClose() {
      if (sounds.tabs) {
        soundPlay(win, "close");
      }
    },
  };
  sounds.windows.set(win, state);
  win.addEventListener("keydown", state.onKey, { capture: true, mozSystemGroup: true });
  win.gBrowser.tabContainer.addEventListener("TabOpen", state.onTabOpen);
  win.gBrowser.tabContainer.addEventListener("TabClose", state.onTabClose);
}

function soundDetach(win) {
  const state = sounds.windows.get(win);
  if (!state) {
    return;
  }
  win.removeEventListener("keydown", state.onKey, { capture: true, mozSystemGroup: true });
  win.gBrowser?.tabContainer.removeEventListener("TabOpen", state.onTabOpen);
  win.gBrowser?.tabContainer.removeEventListener("TabClose", state.onTabClose);
  state.ctx?.close().catch(() => {}); // zavření před dokončeným resume() je v pořádku
  sounds.windows.delete(win);
}

const soundWindowObserver = {
  observe(subject, topic) {
    if (topic !== "domwindowopened") {
      return;
    }
    subject.addEventListener("load", () => {
      if (subject.document.documentElement.getAttribute("windowtype") === "navigator:browser") {
        soundAttach(subject);
      }
    }, { once: true });
  },
};

function setSounds({ typing, tabs, volume, pack, custom }) {
  sounds.typing = !!typing;
  sounds.tabs = !!tabs;
  sounds.volume = Math.max(0, Math.min(1, Number(volume) || 0));
  sounds.pack = SOUND_PACKS.has(pack) ? pack : "soft";
  for (const kind of ["key", "open", "close"]) {
    const url = String(custom?.[kind] || "");
    sounds.custom[kind] = url.length <= SOUND_MAX_CHARS && SOUND_DATA_URL.test(url) ? url : "";
  }
  const want = sounds.typing || sounds.tabs;
  if (want && !sounds.listening) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      soundAttach(win);
    }
    Services.ww.registerNotification(soundWindowObserver);
    sounds.listening = true;
  } else if (!want && sounds.listening) {
    Services.ww.unregisterNotification(soundWindowObserver);
    for (const win of [...sounds.windows.keys()]) {
      soundDetach(win);
    }
    sounds.listening = false;
  }
}

// ---------- Vzhledy: barva zvýraznění (themes.js) ----------
// Přepíše proměnnou --mb-accent z theme/userChrome.css přímo na oknech prohlížeče (ne
// stylem pro celou aplikaci – ten by viděly i weby a šla by podle něj poznat barva).
// Jen barva #rrggbb, prázdná = výchozí zelená. Stejně neonová záře (atribut mantisglow,
// --mb-glow = druhá barva přechodu), prázdná = vypnuto, "auto" = obě barvy záře
// (--mb-glow-start, --mb-glow) dopočítané z barvy lišty – sedí i k motivům z AMO.
let accentColor = "";
let glowColor = "";
let accentListening = false;
let glowAutoListening = false;
const DEFAULT_ACCENT = "#22c55e";

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) {
    return { h: 0, s: 0, l, chroma: 0 };
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? (g - b) / d % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l, chroma: d };
}

function hslToHex(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return "#" + [0, 8, 4].map(n => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("");
}

// Spočítaná barva: rgb()/rgba(), u color-mix() i color(srgb …). InspectorUtils z okna –
// v sandboxu experimentu nemusí být.
function parseColor(win, text) {
  try {
    const c = win.InspectorUtils.colorToRGBA(text);
    if (c) {
      return c;
    }
  } catch (e) {}
  const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(text || "");
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(text || "");
  return srgb ? { r: srgb[1] * 255, g: srgb[2] * 255, b: srgb[3] * 255, a: srgb[4] === undefined ? 1 : +srgb[4] } : null;
}

// Neon k barvě lišty: stejný odstín, plná sytost, druhá barva o 45° dál (přechod jako
// růžová → oranžová). Šedá / průhledná lišta nemá odstín → odstín barvy zvýraznění.
function glowFromBackground(win) {
  const doc = win.document;
  let probe = doc.getElementById("mantis-glow-probe");
  if (!probe) {
    probe = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    probe.id = "mantis-glow-probe";
    probe.hidden = true;
    probe.style.backgroundColor = "var(--toolbar-background-color, var(--toolbar-bgcolor))";
    probe.style.color = "var(--lwt-accent-color, transparent)";
    doc.documentElement.append(probe);
  }
  const style = win.getComputedStyle(probe);
  let bg = parseColor(win, style.backgroundColor);
  if (!bg || bg.a < 0.1) {
    bg = parseColor(win, style.color); // pozadí okna z motivu
  }
  const accent = parseColor(win, accentColor || DEFAULT_ACCENT);
  const base = bg && bg.a >= 0.1 ? rgbToHsl(bg.r, bg.g, bg.b) : { chroma: 0, l: 0.15 };
  const hue = base.chroma >= 0.04 ? base.h : rgbToHsl(accent.r, accent.g, accent.b).h;
  const light = base.l > 0.6; // světlá lišta → tmavší neon, aby byl vidět
  return [hslToHex(hue, 1, light ? 0.45 : 0.62), hslToHex((hue + 45) % 360, 1, light ? 0.42 : 0.58)];
}

const glowThemeObserver = {
  observe() {
    // nový motiv se do stylů propíše až po překreslení
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      win.requestAnimationFrame(() => accentApply(win));
    }
  },
};

function glowSchemeChanged(event) {
  const win = event.target.ownerGlobal ?? null;
  for (const w of Services.wm.getEnumerator("navigator:browser")) {
    if (!win || w === win) {
      w.requestAnimationFrame(() => accentApply(w));
    }
  }
}

const glowSchemeQueries = new WeakMap();

function glowWatchScheme(win, on) {
  let query = glowSchemeQueries.get(win);
  if (on && !query) {
    query = win.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", glowSchemeChanged);
    glowSchemeQueries.set(win, query);
  } else if (!on && query) {
    query.removeEventListener("change", glowSchemeChanged);
    glowSchemeQueries.delete(win);
  }
}

function accentApply(win) {
  const root = win.document?.documentElement;
  if (root?.getAttribute("windowtype") !== "navigator:browser") {
    return;
  }
  if (accentColor) {
    root.style.setProperty("--mb-accent", accentColor, "important");
  } else {
    root.style.removeProperty("--mb-accent");
  }
  glowWatchScheme(win, glowColor === "auto");
  if (glowColor === "auto") {
    const [start, end] = glowFromBackground(win);
    root.style.setProperty("--mb-glow-start", start);
    root.style.setProperty("--mb-glow", end);
    root.setAttribute("mantisglow", "true");
  } else if (glowColor) {
    root.style.removeProperty("--mb-glow-start");
    root.style.setProperty("--mb-glow", glowColor);
    root.setAttribute("mantisglow", "true");
  } else {
    root.style.removeProperty("--mb-glow-start");
    root.style.removeProperty("--mb-glow");
    root.removeAttribute("mantisglow");
  }
  if (glowColor !== "auto") {
    win.document.getElementById("mantis-glow-probe")?.remove();
  }
}

const accentWindowObserver = {
  observe(subject, topic) {
    if (topic === "domwindowopened") {
      subject.addEventListener("load", () => accentApply(subject), { once: true });
    }
  },
};

function setAccent(color, glow = glowColor) {
  accentColor = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "";
  glowColor = glow === "auto" || /^#[0-9a-f]{6}$/i.test(glow || "") ? glow : "";
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    accentApply(win);
  }
  const needed = !!(accentColor || glowColor);
  if (needed && !accentListening) {
    Services.ww.registerNotification(accentWindowObserver);
    accentListening = true;
  } else if (!needed && accentListening) {
    Services.ww.unregisterNotification(accentWindowObserver);
    accentListening = false;
  }
  if (glowColor === "auto" && !glowAutoListening) {
    Services.obs.addObserver(glowThemeObserver, "lightweight-theme-styling-update");
    glowAutoListening = true;
  } else if (glowColor !== "auto" && glowAutoListening) {
    Services.obs.removeObserver(glowThemeObserver, "lightweight-theme-styling-update");
    glowAutoListening = false;
  }
}

this.mantisPrefs = class extends ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    // rozšíření se vypíná/aktualizuje za běhu – nic nesmí zůstat viset
    try { cpuShutdown(); } catch (e) {}
    try { setNetworkLimit(0); } catch (e) {}
    try { setSounds({ typing: false, tabs: false, volume: 0 }); } catch (e) {}
    try { setAccent("", ""); } catch (e) {}
    try { setEcoMode("off"); } catch (e) {}
  }

  getAPI(context) {
    // Chyby pro uživatele v jazyce prohlížeče (texty z _locales rozšíření)
    const fail = (key, ...subs) => {
      throw new ExtensionError(context.extension.localizeMessage(key, subs.map(String)));
    };
    return {
      mantisPrefs: {
        async get(name) {
          const type = checkPref(name, fail);
          if (type === "bool") {
            return Services.prefs.getBoolPref(name, false);
          }
          if (type === "int") {
            return Services.prefs.getIntPref(name, 0);
          }
          return Services.prefs.getStringPref(name, "");
        },

        async set(name, value) {
          const type = checkPref(name, fail);
          if (type === "bool") {
            Services.prefs.setBoolPref(name, !!value);
          } else if (type === "int") {
            Services.prefs.setIntPref(name, Math.trunc(Number(value)));
          } else {
            const text = String(value);
            if (name === "network.trr.uri" && !/^https:\/\/[^\s]+$/.test(text)) {
              fail("err_dohUri");
            }
            Services.prefs.setStringPref(name, text);
          }
        },

        async forgetSite(url) {
          let host;
          try {
            host = Services.io.newURI(url).host;
          } catch (e) {
            host = String(url).trim();
          }
          if (!host) {
            fail("err_noSite");
          }
          let base;
          try {
            base = Services.eTLD.getBaseDomainFromHost(host);
          } catch (e) {
            base = host; // IP adresa, localhost…
          }
          const { ForgetAboutSite } = ChromeUtils.importESModule(
            "moz-src:///toolkit/components/forgetaboutsite/ForgetAboutSite.sys.mjs"
          );
          await ForgetAboutSite.removeDataFromBaseDomain(base);
          return base;
        },

        async isPackaged() {
          return isPackaged();
        },

        // Zkratky vyhledávačů (@mapy…) – search.get() je u vyhledávačů z policies.json
        // nevrací (Firefox je drží v aliases, ne v alias). Jen název → první zkratka.
        async searchAliases() {
          const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
          await SearchService.promiseInitialized;
          const engines = await SearchService.getVisibleEngines();
          return Object.fromEntries(engines.filter(e => e.aliases.length).map(e => [e.name, e.aliases[0]]));
        },

        // Které z doporučených doplňků (uvítací stránka) jsou nainstalované –
        // i slovníky, které management API rozšíření nevidí. Jen ano/ne, nic dalšího.
        async addonsInstalled(ids) {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const addons = await AddonManager.getAddonsByIDs(ids.slice(0, 20).map(String));
          return Object.fromEntries(ids.slice(0, 20).map((id, i) => [id, !!addons[i]]));
        },

        // Zaregistruje VPN pomocníka (vpn\cz.mantis.vpn.json vedle mantis.exe) v HKCU.
        //  - NSIS instalace: klíč zapsal instalátor a ukazuje na existující manifest → nic.
        //  - přenosná verze (zip): klíč chybí nebo ukazuje na přesunutou složku → zapsat.
        //  - MSIX: zápisy do HKCU jdou do soukromého registru balíčku (vidí je jen Mantis)
        //    a instalační složka se mění s každou aktualizací → hlídat při každém startu.
        async ensureVpnHost() {
          const manifest = Services.dirsvc.get("GreD", Ci.nsIFile);
          manifest.append("vpn");
          manifest.append("cz.mantis.vpn.json");
          if (!manifest.exists()) {
            return { registered: false, reason: "helper not bundled" };
          }
          const key = Cc["@mozilla.org/windows-registry-key;1"].createInstance(Ci.nsIWindowsRegKey);
          let current = "";
          try {
            key.open(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER, VPN_HOST_KEY, Ci.nsIWindowsRegKey.ACCESS_READ);
            current = key.readStringValue("");
            key.close();
          } catch (e) {
            // klíč ještě neexistuje
          }
          const packaged = isPackaged();
          if (current === manifest.path || (!packaged && current && fileExists(current))) {
            return { registered: true, changed: false, packaged };
          }
          key.create(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER, VPN_HOST_KEY, Ci.nsIWindowsRegKey.ACCESS_WRITE);
          key.writeStringValue("", manifest.path);
          key.close();
          return { registered: true, changed: true, packaged };
        },

        // Spustí stažený instalátor aktualizace – jen když sedí název, složka
        // pro stahování a SHA-256 z latest.json (ověří se přímo před spuštěním).
        async launchInstaller(path, sha256) {
          if (isPackaged()) {
            fail("err_storeUpdates");
          }
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          try {
            file.initWithPath(path);
          } catch (e) {
            fail("err_installerPath");
          }
          if (!file.exists() || !file.isFile() || !INSTALLER_NAME.test(file.leafName)) {
            fail("err_installerMissing");
          }
          const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
          const allowedDirs = [
            await Downloads.getPreferredDownloadsDirectory(),
            await Downloads.getSystemDownloadsDirectory(),
          ].map(d => PathUtils.normalize(d).toLowerCase());
          if (!allowedDirs.includes(PathUtils.normalize(file.parent.path).toLowerCase())) {
            fail("err_installerFolder");
          }
          const actual = sha256Hex(await IOUtils.read(file.path));
          if (!/^[0-9a-f]{64}$/i.test(sha256) || actual !== sha256.toLowerCase()) {
            fail("err_installerHash");
          }
          file.launch();
        },

        // Nainstalované prohlížeče kromě Mantisu (bez cest k programům)
        async listBrowsers() {
          return findBrowsers().map(({ id, name, isDefault }) => ({ id, name, isDefault }));
        },

        // Otevře http(s) adresu v prohlížeči ze seznamu listBrowsers – jen jako
        // jediný argument programu, nic dalšího se mu nepředá.
        async openInBrowser(id, url) {
          if (!/^https?:\/\/[^\s]+$/i.test(url)) {
            fail("err_webAddressOnly");
          }
          const target = findBrowsers().find(b => b.id === id);
          if (!target) {
            fail("err_browserNotFound");
          }
          const exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          exe.initWithPath(target.exe);
          const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
          process.init(exe);
          process.runwAsync([url], 1);
          return target.name;
        },

        // ---------- Výkon a vzhled ----------

        // Paměť všech procesů Mantisu (MB) a vytížení CPU od minulého volání (% celého počítače)
        async processStats() {
          return processStats();
        },

        async tabStats() {
          return tabStats(context.extension);
        },

        // Hlasitost karty (mixér): pole BrowsingContext.mediaVolume z patche
        // patches/tab-volume.patch – platí pro video, audio i Web Audio, weby ho nevidí.
        // null = build bez patche (nabídka se pak neukáže).
        async getTabVolume(tabId) {
          const bc = context.extension.tabManager.get(tabId).nativeTab.linkedBrowser?.browsingContext;
          return bc && typeof bc.mediaVolume === "number" ? Math.round(bc.mediaVolume * 100) : null;
        },

        async setTabVolume(tabId, percent) {
          const bc = context.extension.tabManager.get(tabId).nativeTab.linkedBrowser?.browsingContext;
          if (!bc || typeof bc.mediaVolume !== "number") {
            return false;
          }
          bc.mediaVolume = Math.min(100, Math.max(0, Math.round(percent))) / 100;
          return true;
        },

        async minimizeMemory() {
          return minimizeMemory();
        },

        async setEcoMode(mode) {
          return setEcoMode(String(mode || ""));
        },

        async ecoState() {
          return ecoState();
        },

        // Tvrdý strop CPU pro procesy webů, 5–95 % výkonu počítače; 0 = bez omezení
        async setCpuLimit(percent) {
          const value = Math.round(Number(percent) || 0);
          return setCpuLimit(value > 0 ? Math.max(5, Math.min(95, value)) : 0);
        },

        // Omezení rychlosti stahování i odesílání v kB/s (64 kB/s – 1 GB/s); 0 = bez omezení
        async setNetworkLimit(kBps) {
          const value = Math.round(Number(kBps) || 0);
          setNetworkLimit(value > 0 ? Math.max(64, Math.min(1024 * 1024, value)) : 0);
        },

        async setSounds(options) {
          setSounds({
            typing: options?.typing, tabs: options?.tabs, volume: options?.volume,
            pack: options?.pack, custom: options?.custom,
          });
        },

        // Přehraje zvuk (key/open/close) s aktuální sadou a hlasitostí v posledním okně
        async previewSound(kind) {
          if (!["key", "open", "close"].includes(kind)) {
            return;
          }
          const win = Services.wm.getMostRecentWindow("navigator:browser");
          if (win) {
            await soundPlay(win, "preview:" + kind);
          }
        },

        // Barva zvýraznění #rrggbb, "" = výchozí zelená
        async setAccent(color) {
          setAccent(String(color || ""));
        },

        async setGlow(color) {
          setAccent(accentColor, String(color || ""));
        },
      },
    };
  }
};
