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
function isPackaged() {
  try {
    return Services.sysinfo.getProperty("hasWinPackageId");
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

// ---------- Zvuky (sounds.js) ----------
// Krátké zvuky generované přes WebAudio (žádné cizí soubory): psaní – stisk klávesy v okně
// prohlížeče i ve webech (posluchač v okně prohlížeče, co se píše, se nečte), otevření
// a zavření karty. Klávesy s Ctrl/Alt a samotné modifikátory se ignorují.
const sounds = { typing: false, tabs: false, volume: 0.4, windows: new Map(), listening: false };
const SOUND_SKIP_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Tab", "Escape"]);

function soundPlay(win, kind) {
  const state = sounds.windows.get(win);
  if (!state) {
    return;
  }
  try {
    const ctx = (state.ctx ||= new win.AudioContext());
    if (ctx.state === "suspended") {
      ctx.resume();
    }
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const volume = sounds.volume;
    if (kind === "key") {
      // krátké „klapnutí“: filtrovaný šum 25 ms
      const length = Math.round(ctx.sampleRate * 0.025);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = 0.9 + Math.random() * 0.25;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 2400;
      filter.Q.value = 0.8;
      src.connect(filter).connect(gain);
      gain.gain.value = volume * 0.9;
      src.start(t);
    } else {
      // otevření karty stoupavý, zavření klesavý tón 90 ms
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const [from, to] = kind === "open" ? [520, 880] : [700, 380];
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume * 0.35, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + 0.13);
    }
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
  state.ctx?.close();
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

function setSounds({ typing, tabs, volume }) {
  sounds.typing = !!typing;
  sounds.tabs = !!tabs;
  sounds.volume = Math.max(0, Math.min(1, Number(volume) || 0));
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
// Jen barva #rrggbb, prázdná = výchozí zelená.
let accentColor = "";
let accentListening = false;

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
}

const accentWindowObserver = {
  observe(subject, topic) {
    if (topic === "domwindowopened") {
      subject.addEventListener("load", () => accentApply(subject), { once: true });
    }
  },
};

function setAccent(color) {
  accentColor = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "";
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    accentApply(win);
  }
  if (accentColor && !accentListening) {
    Services.ww.registerNotification(accentWindowObserver);
    accentListening = true;
  } else if (!accentColor && accentListening) {
    Services.ww.unregisterNotification(accentWindowObserver);
    accentListening = false;
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
    try { setAccent(""); } catch (e) {}
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
          setSounds({ typing: options?.typing, tabs: options?.tabs, volume: options?.volume });
        },

        // Barva zvýraznění #rrggbb, "" = výchozí zelená
        async setAccent(color) {
          setAccent(String(color || ""));
        },
      },
    };
  }
};
