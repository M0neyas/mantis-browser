// VPN: tlačítko ve spodní liště + okno (vpn/popup.html).
// Pomocník mantis-vpn.exe (native messaging, vpn/host) spravuje profil
// a wireproxy; tady se jen přepíná proxy prohlížeče na 127.0.0.1:25344.

const VPN_HOST = "cz.mantis.vpn";
const VPN_PROXY = { type: "socks", host: "127.0.0.1", port: 25344, proxyDNS: true };
const DIRECT = { type: "direct" };

const vpn = {
  hostAvailable: true,
  hasProfile: false,
  endpoint: "",
  enabled: false, // provoz jde přes VPN
  connected: false, // tunel odpovídá
  busy: false,
  error: "",
};

// ---------- Spojení s pomocníkem ----------
// Jedno trvalé spojení: pomocník (a wireproxy) žije, dokud je otevřené.

let port = null;
const waiting = [];

function connectHost() {
  if (port) {
    return port;
  }
  port = browser.runtime.connectNative(VPN_HOST);
  port.onMessage.addListener(reply => waiting.shift()?.resolve(reply));
  port.onDisconnect.addListener(p => {
    const reason = p.error?.message || "pomocník se ukončil";
    port = null;
    while (waiting.length) {
      waiting.shift().reject(new Error(reason));
    }
    vpn.hostAvailable = false;
    vpn.connected = false;
    setEnabled(false);
    vpn.error = "";
    updateButton();
  });
  return port;
}

function hostCall(message) {
  return new Promise((resolve, reject) => {
    try {
      const p = connectHost();
      waiting.push({ resolve, reject });
      p.postMessage(message);
    } catch (e) {
      reject(e);
    }
  });
}

function applyStatus(s) {
  vpn.hostAvailable = true;
  vpn.hasProfile = s.hasProfile;
  vpn.endpoint = s.endpoint || "";
  vpn.connected = s.connected;
  vpn.error = s.ok ? "" : s.error || "neznámá chyba";
  if (!s.running) {
    setEnabled(false);
  }
}

// ---------- Proxy ----------

function setEnabled(on) {
  vpn.enabled = on;
  browser.storage.local.set({ vpnWanted: on });
}

// Co jde přes VPN (Nastavení Mantis → VPN), storage.local "vpnRouting":
//   mode "all"    – všechno (výchozí)
//   mode "only"   – jen vybrané weby / IP rozsahy / kontejnery, zbytek napřímo
//   mode "except" – všechno kromě vybraných
const VPN_ROUTING_DEFAULTS = { mode: "all", sites: [], containers: [] };
let vpnRouting = { ...VPN_ROUTING_DEFAULTS };

async function loadVpnRouting() {
  const { vpnRouting: stored } = await browser.storage.local.get("vpnRouting");
  vpnRouting = { ...VPN_ROUTING_DEFAULTS, ...stored };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vpnRouting) {
    loadVpnRouting();
  }
});

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Položka seznamu: doména (platí i pro subdomény), IPv4 adresa nebo rozsah 192.168.1.0/24
function routeMatches(host, entry) {
  if (entry.includes("/")) {
    const [net, bits] = entry.split("/");
    const ip = ipv4ToInt(host);
    const base = ipv4ToInt(net);
    const len = Number(bits);
    if (ip === null || base === null || !(len >= 0 && len <= 32)) {
      return false;
    }
    const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
    return (ip & mask) === (base & mask);
  }
  return host === entry || host.endsWith("." + entry);
}

function isSelected(host, cookieStoreId) {
  return (
    vpnRouting.sites.some(entry => routeMatches(host, entry)) ||
    (!!cookieStoreId && vpnRouting.containers.includes(cookieStoreId))
  );
}

browser.proxy.onRequest.addListener(
  info => {
    if (!vpn.enabled) {
      return DIRECT;
    }
    let host;
    try {
      host = new URL(info.url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch (e) {
      return VPN_PROXY;
    }
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return DIRECT;
    }
    if (vpnRouting.mode === "only") {
      return isSelected(host, info.cookieStoreId) ? VPN_PROXY : DIRECT;
    }
    if (vpnRouting.mode === "except") {
      return isSelected(host, info.cookieStoreId) ? DIRECT : VPN_PROXY;
    }
    return VPN_PROXY;
  },
  { urls: ["<all_urls>"] }
);

loadVpnRouting();

// ---------- Tlačítko ----------

function updateButton() {
  let title;
  let icon = "icons/vpn-off.svg";
  if (!vpn.hostAvailable) {
    title = "VPN: pomocník není nainstalovaný";
  } else if (!vpn.hasProfile) {
    title = "VPN: přidat profil";
  } else if (vpn.enabled && vpn.connected) {
    title = `VPN: připojeno (${vpn.endpoint})`;
    icon = "icons/vpn-on.svg";
  } else if (vpn.enabled) {
    title = "VPN: tunel neodpovídá";
    icon = "icons/vpn-warn.svg";
  } else {
    title = "VPN: vypnuto";
  }
  browser.browserAction.setIcon({ path: icon });
  browser.browserAction.setTitle({ title });
}

// ---------- Akce z okna ----------

async function run(message, after) {
  vpn.busy = true;
  try {
    applyStatus(await hostCall(message));
    after?.();
  } catch (e) {
    vpn.hostAvailable = false;
    vpn.error = "";
  } finally {
    vpn.busy = false;
    updateButton();
  }
}

async function start() {
  await run({ cmd: "start" }, () => {
    if (!vpn.error) {
      setEnabled(true);
    }
  });
}

async function stop() {
  setEnabled(false);
  await run({ cmd: "stop" });
}

// Ne-async posluchač: u cizích zpráv nesmí vracet Promise, jinak by přebil
// odpovědi ostatních posluchačů (forget.js, settings).
browser.runtime.onMessage.addListener(msg => (msg?.vpn ? handleVpnMessage(msg) : undefined));

async function handleVpnMessage(msg) {
  switch (msg.vpn) {
    case "state":
      await run({ cmd: "status" });
      break;
    case "toggle":
      await (vpn.enabled ? stop() : start());
      break;
    case "setProfile":
      await run({ cmd: "setProfile", conf: msg.conf });
      if (!vpn.error) {
        await start();
      }
      break;
    case "removeProfile":
      setEnabled(false);
      await run({ cmd: "removeProfile" });
      break;
  }
  return { ...vpn, routing: vpnRouting.mode };
}

// Průběžná kontrola, jestli tunel odpovídá (jen když je VPN zapnutá)
browser.alarms.create("mantis-vpn-status", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "mantis-vpn-status" && vpn.enabled) {
    run({ cmd: "status" });
  }
});

// Po spuštění prohlížeče: zaregistrovat pomocníka (přenosná verze, MSIX – NSIS to dělá
// instalátor), zjistit stav, VPN zapnout, pokud byla zapnutá
(async () => {
  updateButton();
  try {
    await browser.mantisPrefs.ensureVpnHost();
  } catch (e) {
    console.error("Mantis VPN – registrace pomocníka:", e);
  }
  const { vpnWanted } = await browser.storage.local.get("vpnWanted");
  await run({ cmd: "status" });
  if (vpnWanted && vpn.hasProfile) {
    await start();
  }
})();
