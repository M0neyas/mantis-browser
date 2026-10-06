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

// ---------- Hlasitost karty (mixér) ----------
// BrowsingContext.mediaVolume z patches/tab-volume.patch (0–2): Gecko ztiší/zesílí video, audio
// i Web Audio celé karty, web nic nevidí. Panel s posuvníky je v okně prohlížeče (ne na webu).

const VOLUME_PANEL_ID = "mantis-volume-panel";
const HTML_NS = "http://www.w3.org/1999/xhtml";

function tabVolumeOf(tab) {
  const bc = tab?.linkedBrowser?.browsingContext;
  return bc && typeof bc.mediaVolume === "number" ? bc.mediaVolume : null;
}

function setNativeTabVolume(tab, percent) {
  const bc = tab?.linkedBrowser?.browsingContext;
  if (!bc || typeof bc.mediaVolume !== "number") {
    return false;
  }
  const value = Number.isFinite(percent) ? Math.min(200, Math.max(0, Math.round(percent))) : 100;
  bc.mediaVolume = value / 100;
  return true;
}

function volumeRow(doc, tab, localize) {
  const row = doc.createElementNS(HTML_NS, "div");
  row.style.cssText = "display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 4px 8px;";
  const icon = doc.createElementNS(HTML_NS, "img");
  icon.style.cssText = "width: 16px; height: 16px;";
  const image = tab.getAttribute("image");
  if (image) {
    icon.src = image;
  }
  const title = doc.createElementNS(HTML_NS, "span");
  title.textContent = tab.label;
  title.style.cssText = "overflow: hidden; white-space: nowrap; text-overflow: ellipsis;";
  const value = doc.createElementNS(HTML_NS, "button");
  value.title = localize("volume_reset");
  value.style.cssText = "min-width: 4.5em; margin: 0; padding: 2px 6px; border: none; border-radius: 4px; background: transparent; color: inherit; font: inherit; font-variant-numeric: tabular-nums; text-align: end; cursor: pointer;";
  const slider = doc.createElementNS(HTML_NS, "input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "200";
  slider.step = "5";
  slider.setAttribute("aria-label", tab.label);
  slider.style.cssText = "grid-column: 1 / -1; width: 100%; margin: 0; accent-color: var(--mb-accent, AccentColor);";
  const show = percent => {
    slider.value = String(percent);
    value.textContent = localize("volume_level", [String(percent)]);
    value.style.color = percent > 100 ? "var(--mb-accent, AccentColor)" : "inherit";
  };
  show(Math.round((tabVolumeOf(tab) ?? 1) * 100));
  slider.addEventListener("input", () => {
    setNativeTabVolume(tab, Number(slider.value));
    show(Number(slider.value));
  });
  value.addEventListener("click", () => {
    setNativeTabVolume(tab, 100);
    show(100);
  });
  row.append(icon, title, value, slider);
  return { row, slider };
}

function showTabVolume(tab, localize) {
  const win = tab.ownerDocument.defaultView;
  const doc = win.document;
  let panel = doc.getElementById(VOLUME_PANEL_ID);
  if (!panel) {
    panel = doc.createXULElement("panel");
    panel.id = VOLUME_PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("noautofocus", "true");
    const box = doc.createElementNS(HTML_NS, "div");
    box.className = "mantis-volume-box";
    box.style.cssText = "display: flex; flex-direction: column; gap: 12px; width: 300px; padding: 12px 14px; font: menu;";
    panel.append(box);
    (doc.getElementById("mainPopupSet") || doc.documentElement).append(panel);
    panel.addEventListener("popuphidden", () => box.replaceChildren());
  }
  const box = panel.querySelector(".mantis-volume-box");
  const heading = text => {
    const h = doc.createElementNS(HTML_NS, "div");
    h.textContent = text;
    h.style.cssText = "font-weight: 600;";
    return h;
  };
  const main = volumeRow(doc, tab, localize);
  box.replaceChildren(heading(localize("volume_title")), main.row);
  // mixér: další karty, které hrají nebo mají změněnou hlasitost
  const others = win.gBrowser.tabs.filter(t => t !== tab &&
    (t.hasAttribute("soundplaying") || Math.abs((tabVolumeOf(t) ?? 1) - 1) > 0.001));
  if (others.length) {
    box.append(heading(localize("volume_others")), ...others.slice(0, 8).map(t => volumeRow(doc, t, localize).row));
  }
  panel.setAttribute("aria-label", localize("volume_title"));
  const anchor = tab.visible !== false && !tab.hidden && tab.getBoundingClientRect().width > 0
    ? tab : win.gBrowser.tabContainer;
  panel.addEventListener("popupshown", () => main.slider.focus(), { once: true });
  panel.openPopup(anchor, "after_start");
}

function removeVolumePanels() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    win.document.getElementById(VOLUME_PANEL_ID)?.remove();
  }
}

// ---------- Události pro rozšíření (paleta příkazů, pracovní prostory) ----------
// Prvky v okně prohlížeče (panel palety, tlačítko prostorů) hlásí volby rozšíření přes
// události mantisPrefs.onPaletteInput / onPaletteChoose / onWorkspaceAction.

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
const mantisListeners = { paletteInput: new Set(), paletteChoose: new Set(), workspaceAction: new Set(), sidebarRailChoose: new Set() };

function mantisEmit(name, ...args) {
  for (const listener of mantisListeners[name]) {
    try {
      listener(...args);
    } catch (e) {
      console.error("Mantis:", e);
    }
  }
}

function mantisEvent(context, name) {
  return new ExtensionCommon.EventManager({
    context,
    name: `mantisPrefs.${name}`,
    register: fire => {
      const listener = (...args) => fire.async(...args);
      const key = name.charAt(2).toLowerCase() + name.slice(3); // onPaletteInput → paletteInput
      mantisListeners[key].add(listener);
      return () => mantisListeners[key].delete(listener);
    },
  }).api();
}

// ---------- Paleta příkazů ----------
// Jedno pole uprostřed nahoře (jako ve Vivaldi/Arcu): karty, záložky, historie, prostory
// a příkazy Mantisu. Výsledky dodává rozšíření (setPaletteResults), panel je jen zobrazuje.
// Ikony stránek přes page-icon: (favicony z historie prohlížeče, nic se nestahuje).

const PALETTE_ID = "mantis-palette";
const palette = { panel: null, windowId: null, requestId: 0, items: [], selected: 0 };

function paletteSelect(index) {
  const list = palette.panel?.querySelector(".mantis-palette-list");
  if (!list || !palette.items.length) {
    return;
  }
  palette.selected = (index + palette.items.length) % palette.items.length;
  for (const [i, row] of [...list.children].entries()) {
    const on = i === palette.selected;
    row.setAttribute("aria-selected", String(on));
    row.style.background = on ? "color-mix(in srgb, var(--mb-accent, AccentColor) 22%, transparent)" : "transparent";
    if (on) {
      row.scrollIntoView({ block: "nearest" });
    }
  }
}

function paletteChoose(index) {
  const item = palette.items[index];
  if (!item) {
    return;
  }
  palette.panel?.hidePopup();
  mantisEmit("paletteChoose", item.id, palette.windowId);
}

function paletteQuery(text) {
  palette.requestId++;
  mantisEmit("paletteInput", text, palette.requestId, palette.windowId);
}

function showPalette(win, windowId, placeholder) {
  const doc = win.document;
  let panel = doc.getElementById(PALETTE_ID);
  if (!panel) {
    panel = doc.createXULElement("panel");
    panel.id = PALETTE_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("noautofocus", "true");
    panel.style.cssText = "--panel-padding: 0; --panel-background: transparent; --panel-border-color: transparent; --panel-shadow: none;";
    const box = doc.createElementNS(HTML_NS, "div");
    box.style.cssText = "width: 640px; padding: 8px; border: 1px solid var(--panel-border-color, var(--border-color, ThreeDShadow)); border-radius: 14px; background: var(--background-color-box, var(--toolbar-background-color, Menu)); color: var(--text-color, var(--toolbar-color, MenuText)); box-shadow: 0 12px 40px rgb(0 0 0 / 0.35); font: menu; font-size: 13.5px;";
    const input = doc.createElementNS(HTML_NS, "input");
    input.className = "mantis-palette-input";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-controls", "mantis-palette-list");
    input.setAttribute("aria-autocomplete", "list");
    input.style.cssText = "box-sizing: border-box; width: 100%; margin: 0; padding: 10px 12px; border: none; border-radius: 9px; outline: none; background: var(--toolbar-field-background-color-focus, var(--toolbar-field-focus-background-color, Field)); color: var(--toolbar-field-text-color-focus, var(--toolbar-field-color, FieldText)); font: inherit; font-size: 15px;";
    const list = doc.createElementNS(HTML_NS, "ul");
    list.id = "mantis-palette-list";
    list.className = "mantis-palette-list";
    list.setAttribute("role", "listbox");
    list.style.cssText = "max-height: 430px; margin: 6px 0 0; padding: 0; overflow-y: auto; list-style: none;";
    box.append(input, list);
    panel.append(box);
    (doc.getElementById("mainPopupSet") || doc.documentElement).append(panel);
    input.addEventListener("input", () => paletteQuery(input.value));
    input.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        paletteSelect(palette.selected + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        paletteChoose(palette.selected);
      } else if (event.key === "Escape") {
        event.preventDefault();
        panel.hidePopup();
      }
    });
    panel.addEventListener("popupshown", () => input.focus());
    panel.addEventListener("popuphidden", () => {
      palette.items = [];
      list.replaceChildren();
    });
  }
  palette.panel = panel;
  palette.windowId = windowId;
  const input = panel.querySelector(".mantis-palette-input");
  input.value = "";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  panel.setAttribute("aria-label", placeholder);
  const x = Math.round(win.mozInnerScreenX + (win.innerWidth - 640) / 2);
  const y = Math.round(win.mozInnerScreenY + Math.min(90, win.innerHeight / 8));
  panel.openPopupAtScreen(x, y, false);
  paletteQuery("");
}

// items: [{ id, title, detail?, url? (ikona stránky), icon? (emoji) }]
function setPaletteResults(requestId, items) {
  const panel = palette.panel;
  if (requestId !== palette.requestId || !panel || panel.state === "closed") {
    return; // mezitím se psalo dál, nebo je paleta zavřená
  }
  const doc = panel.ownerDocument;
  const list = panel.querySelector(".mantis-palette-list");
  palette.items = items.slice(0, 14);
  list.replaceChildren(...palette.items.map((item, index) => {
    const row = doc.createElementNS(HTML_NS, "li");
    row.setAttribute("role", "option");
    row.style.cssText = "display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; cursor: default;";
    const icon = doc.createElementNS(HTML_NS, "span");
    icon.style.cssText = "display: flex; flex: none; justify-content: center; width: 20px; font-size: 14px;";
    if (item.url && /^(https?|file):/.test(item.url)) {
      const img = doc.createElementNS(HTML_NS, "img");
      img.src = "page-icon:" + item.url;
      img.style.cssText = "width: 16px; height: 16px;";
      img.addEventListener("error", () => img.replaceWith(item.icon || "🌐"), { once: true });
      icon.append(img);
    } else {
      icon.textContent = item.icon || "•";
    }
    const title = doc.createElementNS(HTML_NS, "span");
    title.textContent = item.title;
    title.style.cssText = "overflow: hidden; white-space: nowrap; text-overflow: ellipsis;";
    const detail = doc.createElementNS(HTML_NS, "span");
    detail.textContent = item.detail || "";
    detail.style.cssText = "flex: none; max-width: 40%; margin-inline-start: auto; overflow: hidden; opacity: 0.65; font-size: 12px; white-space: nowrap; text-overflow: ellipsis;";
    row.append(icon, title, detail);
    row.addEventListener("mousemove", () => {
      if (palette.selected !== index) {
        paletteSelect(index);
      }
    });
    row.addEventListener("click", () => paletteChoose(index));
    return row;
  }));
  paletteSelect(0);
}

function removePalettes() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    win.document.getElementById(PALETTE_ID)?.remove();
  }
  palette.panel = null;
}

// ---------- Pracovní prostory: tlačítko v liště karet ----------
// Logika (které karty jsou v jakém prostoru, tabs.hide/show) je v rozšíření (workspaces.js);
// tady jen tlačítko vlevo od karet s názvem aktivního prostoru a nabídka pro přepnutí.

const WS_WIDGET_ID = "mantis-workspaces-button";
const ws = { list: [], active: new Map(), texts: {}, created: false };

function wsDot(color) {
  const safe = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#22c55e";
  return "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="${safe}"/></svg>`);
}

function wsWindowId(win) {
  return ws.windowIds?.get(win) ?? null;
}

function wsUpdateButton(node) {
  const win = node.ownerDocument.defaultView;
  const current = ws.list.find(w => w.id === ws.active.get(wsWindowId(win))) || ws.list[0];
  if (!current) {
    return;
  }
  node.setAttribute("label", `${current.icon || ""} ${current.name}`.trim());
  node.setAttribute("tooltiptext", ws.texts.tooltip || current.name);
  node.setAttribute("image", wsDot(current.color));
  node.style.setProperty("--mb-ws-color", /^#[0-9a-f]{6}$/i.test(current.color || "") ? current.color : "");
}

function wsUpdateAll() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    const node = win.document.getElementById(WS_WIDGET_ID);
    if (node) {
      wsUpdateButton(node);
    }
  }
}

function wsOpenMenu(button) {
  const win = button.ownerDocument.defaultView;
  const doc = win.document;
  const windowId = wsWindowId(win);
  let popup = doc.getElementById("mantis-workspaces-menu");
  if (!popup) {
    popup = doc.createXULElement("menupopup");
    popup.id = "mantis-workspaces-menu";
    (doc.getElementById("mainPopupSet") || doc.documentElement).append(popup);
  }
  const item = (label, action, id, checked) => {
    const menuitem = doc.createXULElement("menuitem");
    menuitem.setAttribute("label", label);
    if (checked !== undefined) {
      menuitem.setAttribute("type", "radio");
      if (checked) {
        menuitem.setAttribute("checked", "true");
      }
    }
    menuitem.addEventListener("command", () => mantisEmit("workspaceAction", action, windowId, id ?? ""));
    return menuitem;
  };
  const activeId = ws.active.get(windowId) || ws.list[0]?.id;
  popup.replaceChildren(
    ...ws.list.map(w => item(`${w.icon || ""} ${w.name}`.trim(), "switch", w.id, w.id === activeId)),
    doc.createXULElement("menuseparator"),
    item(ws.texts.add || "+", "new"),
    item(ws.texts.edit || "…", "edit"),
  );
  popup.openPopup(button, "after_start");
}

function wsEnsureWidget() {
  if (ws.created) {
    wsUpdateAll();
    return;
  }
  const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
  CustomizableUI.createWidget({
    id: WS_WIDGET_ID,
    type: "button",
    label: ws.texts.label || "Workspaces",
    tooltiptext: ws.texts.tooltip || "",
    defaultArea: CustomizableUI.AREA_TABSTRIP,
    onCreated: node => {
      wsUpdateButton(node);
      node.addEventListener("command", () => wsOpenMenu(node));
    },
  });
  ws.created = true;
  // Jednou na začátek lišty karet (uživatel ho pak může přesunout nebo odebrat)
  if (!Services.prefs.getBoolPref("mantis.workspaces.placed", false)) {
    CustomizableUI.addWidgetToArea(WS_WIDGET_ID, CustomizableUI.AREA_TABSTRIP, 0);
    Services.prefs.setBoolPref("mantis.workspaces.placed", true);
  }
  wsUpdateAll();
}

function wsRemoveWidget() {
  if (!ws.created) {
    return;
  }
  const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
  CustomizableUI.destroyWidget(WS_WIDGET_ID);
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    win.document.getElementById("mantis-workspaces-menu")?.remove();
  }
  ws.created = false;
}

// ---------- Boční panel (messengery) ----------
// sidebarAction.open() rozšíření smí jen z kliknutí – paleta a klávesová zkratka to nejsou.

function toggleExtensionSidebar(win, extensionId) {
  const controller = win.SidebarController || win.SidebarUI;
  controller?.toggle(extensionSidebarId(extensionId));
}

function extensionSidebarId(extensionId) {
  return `${ExtensionCommon.makeWidgetId(extensionId)}-sidebar-action`;
}

// Messengery potřebují víc místa než výchozích ~220 px panelu; širší (roztažený) panel nechat
const SIDEBAR_MIN_WIDTH = 420;

async function showExtensionSidebar(win, extensionId) {
  const controller = win.SidebarController || win.SidebarUI;
  const id = extensionSidebarId(extensionId);
  if (!(controller?.isOpen && controller.currentID === id)) {
    await controller?.show(id);
  }
  const box = win.document.getElementById("sidebar-box");
  if (box && box.getBoundingClientRect().width < SIDEBAR_MIN_WIDTH) {
    box.style.width = `${SIDEBAR_MIN_WIDTH}px`;
  }
}

// ---------- Lišta messengerů u levého okraje (překryv) ----------
// Najetím myší k levému okraji stránky vyjede plovoucí lišta s ikonami služeb – PŘES stránku,
// nic neodsune. Teprve kliknutí na službu otevře boční panel (sidebar_action), který stránku
// zúží. Při otevřeném panelu, celé obrazovce a úpravě lišt se lišta neukazuje.

const RAIL_ID = "mantis-messenger-rail";
const rail = { services: [], texts: {}, windowIdOf: null, extensionId: "" };

function railOpen(win, root, open) {
  if (open) {
    const controller = win.SidebarController || win.SidebarUI;
    const docked = controller?.isOpen && controller.currentID === extensionSidebarId(rail.extensionId);
    const doc = win.document;
    if (docked || doc.fullscreenElement || win.fullScreen || doc.documentElement.hasAttribute("customizing")) {
      return;
    }
  }
  win.clearTimeout(root._mantisHide);
  root.toggleAttribute("open", open);
  const nav = root.querySelector(".mantis-rail");
  nav.style.transform = open ? "translate(0, -50%)" : "translate(calc(-100% - 12px), -50%)";
  nav.style.opacity = open ? "1" : "0";
  nav.style.pointerEvents = open ? "auto" : "none";
}

function railBuild(win) {
  const doc = win.document;
  if (doc.readyState !== "complete") {
    win.addEventListener("load", () => railBuild(win), { once: true });
    return;
  }
  const box = doc.getElementById("tabbrowser-tabbox");
  let root = doc.getElementById(RAIL_ID);
  if (!box || !rail.services.length) {
    root?.remove();
    return;
  }
  if (!root) {
    root = doc.createElementNS(HTML_NS, "div");
    root.id = RAIL_ID;
    root.style.cssText = "position: absolute; inset: 0 auto 0 0; width: 0; z-index: 10; pointer-events: none;";
    // neviditelný pruh u okraje, který lištu vysune
    const edge = doc.createElementNS(HTML_NS, "div");
    edge.style.cssText = "position: absolute; inset: 0 auto 0 0; width: 4px; pointer-events: auto;";
    const nav = doc.createElementNS(HTML_NS, "nav");
    nav.className = "mantis-rail";
    nav.style.cssText = "position: absolute; top: 50%; left: 8px; display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--panel-border-color, var(--border-color, ThreeDShadow)); border-radius: 16px; background: var(--background-color-box, var(--toolbar-background-color, Menu)); color: var(--text-color, var(--toolbar-color, MenuText)); box-shadow: 0 10px 30px rgb(0 0 0 / 0.35); transition: transform 160ms ease, opacity 160ms ease;";
    root.append(edge, nav);
    if (win.getComputedStyle(box).position === "static") {
      box.style.position = "relative";
    }
    box.append(root);
    edge.addEventListener("mouseenter", () => railOpen(win, root, true));
    root.addEventListener("mouseleave", () => {
      win.clearTimeout(root._mantisHide);
      root._mantisHide = win.setTimeout(() => railOpen(win, root, false), 350);
    });
    nav.addEventListener("mouseenter", () => win.clearTimeout(root._mantisHide));
  }
  const nav = root.querySelector(".mantis-rail");
  const button = (label, icon, color, id) => {
    const b = doc.createElementNS(HTML_NS, "button");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.style.cssText = "display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: none; border-radius: 11px; background: color-mix(in srgb, currentColor 7%, transparent); color: inherit; font: 15px/1 system-ui, sans-serif; cursor: pointer; transition: background-color 120ms ease;";
    if (/^moz-extension:\/\/[^/]+\/icons\/services\/[a-z]+\.svg$/.test(icon)) {
      const img = doc.createElementNS(HTML_NS, "img");
      img.src = icon;
      img.alt = "";
      img.style.cssText = "width: 20px; height: 20px; pointer-events: none;";
      b.append(img);
    } else {
      b.textContent = icon;
    }
    const hover = /^#[0-9a-f]{6}$/i.test(color) ? `color-mix(in srgb, ${color} 22%, transparent)` : "color-mix(in srgb, currentColor 14%, transparent)";
    b.addEventListener("mouseenter", () => { b.style.background = hover; });
    b.addEventListener("mouseleave", () => { b.style.background = "color-mix(in srgb, currentColor 7%, transparent)"; });
    b.addEventListener("click", () => {
      railOpen(win, root, false);
      const windowId = rail.windowIdOf?.(win);
      if (windowId !== undefined && windowId !== null) {
        mantisEmit("sidebarRailChoose", id, windowId);
      }
    });
    return b;
  };
  nav.replaceChildren(
    ...rail.services.map(s => button(s.name, s.icon, s.color, s.id)),
    button(rail.texts.settings || "⚙", "⚙", "", "settings"),
  );
  nav.setAttribute("aria-label", rail.texts.title || "");
  railOpen(win, root, false);
}

function railUpdateAll() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    railBuild(win);
  }
}

function removeRails() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    win.document.getElementById(RAIL_ID)?.remove();
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
    try { removeVolumePanels(); } catch (e) {}
    try { removePalettes(); } catch (e) {}
    try { wsRemoveWidget(); } catch (e) {}
    try { removeRails(); } catch (e) {}
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

        // Hlasitost karty (mixér) v % (0–200); null/false = build bez patches/tab-volume.patch
        async getTabVolume(tabId) {
          const volume = tabVolumeOf(context.extension.tabManager.get(tabId).nativeTab);
          return volume === null ? null : Math.round(volume * 100);
        },

        async setTabVolume(tabId, percent) {
          return setNativeTabVolume(context.extension.tabManager.get(tabId).nativeTab, percent);
        },

        async showTabVolume(tabId) {
          const tab = context.extension.tabManager.get(tabId).nativeTab;
          if (tabVolumeOf(tab) === null) {
            return false;
          }
          showTabVolume(tab, (key, subs = []) => context.extension.localizeMessage(key, subs));
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

        onPaletteInput: mantisEvent(context, "onPaletteInput"),
        onPaletteChoose: mantisEvent(context, "onPaletteChoose"),
        onWorkspaceAction: mantisEvent(context, "onWorkspaceAction"),

        async showPalette(windowId, placeholder) {
          const win = context.extension.windowManager.get(windowId, context).window;
          showPalette(win, windowId, String(placeholder || ""));
        },

        async setPaletteResults(requestId, items) {
          setPaletteResults(requestId, (items || []).map(item => ({
            id: String(item.id),
            title: String(item.title ?? ""),
            detail: item.detail ? String(item.detail) : "",
            url: item.url ? String(item.url) : "",
            icon: item.icon ? String(item.icon) : "",
          })));
        },

        // Seznam prostorů [{id, name, icon, color}], aktivní prostor podle ID okna, texty tlačítka
        async setWorkspaces(list, active, texts) {
          ws.list = (list || []).map(w => ({ id: String(w.id), name: String(w.name), icon: String(w.icon || ""), color: String(w.color || "") }));
          ws.active = new Map(Object.entries(active || {}).map(([id, wsId]) => [Number(id), String(wsId)]));
          ws.texts = texts || {};
          ws.windowIds = new Map();
          for (const win of Services.wm.getEnumerator("navigator:browser")) {
            try {
              ws.windowIds.set(win, context.extension.windowManager.wrapWindow(win).id);
            } catch (e) {} // anonymní okno bez povolení
          }
          wsEnsureWidget();
        },

        async toggleSidebar(windowId) {
          const win = context.extension.windowManager.get(windowId, context).window;
          toggleExtensionSidebar(win, context.extension.id);
        },

        async showSidebar(windowId) {
          const win = context.extension.windowManager.get(windowId, context).window;
          await showExtensionSidebar(win, context.extension.id);
        },

        onSidebarRailChoose: mantisEvent(context, "onSidebarRailChoose"),

        // Plovoucí lišta u levého okraje: služby [{id, name, icon (moz-extension URL loga), color}], prázdné = vypnuto
        async setSidebarRail(services, texts) {
          rail.services = (services || []).map(s => ({
            id: String(s.id), name: String(s.name), icon: String(s.icon || ""), color: String(s.color || ""),
          }));
          rail.texts = texts || {};
          rail.extensionId = context.extension.id;
          rail.windowIdOf = win => {
            try {
              return context.extension.windowManager.wrapWindow(win).id;
            } catch (e) {
              return null; // anonymní okno bez povolení
            }
          };
          railUpdateAll();
        },
      },
    };
  }
};
