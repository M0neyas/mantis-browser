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
  // Šifrované DNS (doh.js)
  "network.trr.mode": "int",
  "network.trr.uri": "string",
};

// Instalátor z aktualizace: jen tento název souboru a jen ze složky pro stahování
const INSTALLER_NAME = /^Mantis-Browser-Setup[\w.-]*\.exe$/i;

// Registrace VPN pomocníka pro native messaging (klíč hledá NativeManifests.sys.mjs)
const VPN_HOST_KEY = "Software\\Mozilla\\NativeMessagingHosts\\cz.mantis.vpn";

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

function checkPref(name) {
  const type = ALLOWED_PREFS[name];
  if (!type) {
    throw new ExtensionError(`Nastavení ${name} není povolené`);
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

this.mantisPrefs = class extends ExtensionAPI {
  getAPI() {
    return {
      mantisPrefs: {
        async get(name) {
          const type = checkPref(name);
          if (type === "bool") {
            return Services.prefs.getBoolPref(name, false);
          }
          if (type === "int") {
            return Services.prefs.getIntPref(name, 0);
          }
          return Services.prefs.getStringPref(name, "");
        },

        async set(name, value) {
          const type = checkPref(name);
          if (type === "bool") {
            Services.prefs.setBoolPref(name, !!value);
          } else if (type === "int") {
            Services.prefs.setIntPref(name, Math.trunc(Number(value)));
          } else {
            const text = String(value);
            if (name === "network.trr.uri" && !/^https:\/\/[^\s]+$/.test(text)) {
              throw new ExtensionError("Adresa DNS serveru musí začínat https://");
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
            throw new ExtensionError("Chybí adresa webu");
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
            return { registered: false, reason: "pomocník není přibalený" };
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
            throw new ExtensionError("Verzi z Microsoft Store aktualizuje Store");
          }
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          try {
            file.initWithPath(path);
          } catch (e) {
            throw new ExtensionError("Neplatná cesta k instalátoru");
          }
          if (!file.exists() || !file.isFile() || !INSTALLER_NAME.test(file.leafName)) {
            throw new ExtensionError("Instalátor nebyl nalezen");
          }
          const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
          const allowedDirs = [
            await Downloads.getPreferredDownloadsDirectory(),
            await Downloads.getSystemDownloadsDirectory(),
          ].map(d => PathUtils.normalize(d).toLowerCase());
          if (!allowedDirs.includes(PathUtils.normalize(file.parent.path).toLowerCase())) {
            throw new ExtensionError("Instalátor není ve složce pro stahování");
          }
          const actual = sha256Hex(await IOUtils.read(file.path));
          if (!/^[0-9a-f]{64}$/i.test(sha256) || actual !== sha256.toLowerCase()) {
            throw new ExtensionError("Kontrolní součet instalátoru nesedí – stáhněte ho ručně z moneyas.cz/mantis");
          }
          file.launch();
        },
      },
    };
  }
};
