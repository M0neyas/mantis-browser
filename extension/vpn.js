// VPN: tlačítko ve spodní liště + okno (vpn/popup.html).
// Pomocník mantis-vpn.exe (native messaging, vpn/host) spravuje profil
// a wireproxy; tady se jen přepíná proxy prohlížeče na 127.0.0.1:25344
// (se jménem a heslem, které pomocník vygeneruje při každém spuštění).
//
// Kill switch (výchozí zapnuto, Nastavení Mantis → VPN, "vpnKillSwitch"):
// když je VPN zapnutá, ale pomocník nebo wireproxy spadne, provoz, který má jít
// přes VPN, se zablokuje (nepustí se napřímo), dokud se VPN neobnoví nebo ji
// uživatel nevypne.

const VPN_HOST = "cz.mantis.vpn";
const VPN_PROXY = { type: "socks", host: "127.0.0.1", port: 25344, proxyDNS: true };
// Zablokovaný provoz: SOCKS na port, kde nic neběží (9 = discard) – spojení selže
// a DNS se také neodešle (proxyDNS)
const BLOCKED = { type: "socks", host: "127.0.0.1", port: 9, proxyDNS: true };
const DIRECT = { type: "direct" };

const vpn = {
  hostAvailable: true,
  hasProfile: false,
  endpoint: "",
  enabled: false, // provoz má jít přes VPN (přání uživatele)
  running: false, // wireproxy běží
  connected: false, // tunel odpovídá
  killSwitch: true,
  blocked: false, // VPN zapnutá, ale neběží → provoz zablokovaný
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
    vpn.error = "";
    lost();
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

let socksAuth = null; // { username, password } běžící wireproxy
let changingProfile = false; // pomocník zastavil wireproxy kvůli novému profilu

function applyStatus(s) {
  vpn.hostAvailable = true;
  vpn.hasProfile = s.hasProfile;
  vpn.endpoint = s.endpoint || "";
  vpn.error = s.ok ? "" : s.error || "neznámá chyba";
  if (s.running && s.socksUser && s.socksPass) {
    vpn.running = true;
    vpn.connected = s.connected;
    vpn.blocked = false;
    socksAuth = { username: s.socksUser, password: s.socksPass };
  } else {
    lost();
  }
}

// wireproxy neběží (spadla, pomocník se ukončil, VPN je vypnutá)
function lost() {
  const wasRunning = vpn.running;
  vpn.running = false;
  vpn.connected = false;
  socksAuth = null;
  if (!vpn.enabled) {
    vpn.blocked = false;
    return;
  }
  if (vpn.killSwitch) {
    vpn.blocked = true;
  } else {
    setEnabled(false);
  }
  if (wasRunning && !changingProfile) {
    browser.notifications.create("mantis-vpn-lost", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/vpn-warn.svg"),
      title: "VPN se odpojila",
      message: vpn.killSwitch
        ? "Provoz, který má jít přes VPN, je zablokovaný, dokud se VPN neobnoví nebo ji nevypnete."
        : "Prohlížeč teď jde přímo do internetu.",
    });
  }
}

// ---------- Proxy ----------

function setEnabled(on) {
  vpn.enabled = on;
  if (!on) {
    vpn.blocked = false;
  }
  browser.storage.local.set({ vpnWanted: on });
}

function vpnProxy() {
  return socksAuth ? { ...VPN_PROXY, ...socksAuth } : BLOCKED;
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

async function loadKillSwitch() {
  const { vpnKillSwitch } = await browser.storage.local.get("vpnKillSwitch");
  vpn.killSwitch = vpnKillSwitch !== false;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes.vpnRouting) {
    loadVpnRouting();
  }
  if (changes.vpnKillSwitch) {
    loadKillSwitch().then(() => {
      if (vpn.blocked && !vpn.killSwitch) {
        setEnabled(false);
        updateButton();
      }
    });
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

// Do načtení stavu po startu prohlížeče se požadavky odloží, aby obnovené karty
// neodešly napřímo dřív, než se zjistí, že VPN má být zapnutá.
let vpnReady = false;
let startWanted = false; // VPN byla zapnutá při zavření prohlížeče
const vpnLoaded = (async () => {
  try {
    const { vpnWanted } = await browser.storage.local.get("vpnWanted");
    startWanted = !!vpnWanted;
    await Promise.all([loadVpnRouting(), loadKillSwitch()]);
    // s kill switchem blokovat hned, bez něj pustit až po úspěšném spuštění
    vpn.enabled = startWanted && vpn.killSwitch;
    vpn.blocked = vpn.enabled;
  } finally {
    vpnReady = true;
  }
})();

function route(info) {
  if (!vpn.enabled) {
    return DIRECT;
  }
  const VPN = vpnProxy();
  let host;
  try {
    host = new URL(info.url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch (e) {
    return VPN;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return DIRECT;
  }
  if (vpnRouting.mode === "only") {
    return isSelected(host, info.cookieStoreId) ? VPN : DIRECT;
  }
  if (vpnRouting.mode === "except") {
    return isSelected(host, info.cookieStoreId) ? DIRECT : VPN;
  }
  return VPN;
}

browser.proxy.onRequest.addListener(
  info => (vpnReady ? route(info) : vpnLoaded.then(() => route(info))),
  { urls: ["<all_urls>"] }
);

// ---------- Tlačítko ----------

function updateButton() {
  let title;
  let icon = "icons/vpn-off.svg";
  if (!vpn.hostAvailable) {
    title = "VPN: pomocník není nainstalovaný";
  } else if (!vpn.hasProfile) {
    title = "VPN: přidat profil";
  } else if (vpn.blocked) {
    title = "VPN: odpojeno – provoz je zablokovaný";
    icon = "icons/vpn-warn.svg";
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
    lost();
  } finally {
    vpn.busy = false;
    updateButton();
  }
}

async function start() {
  await run({ cmd: "start" }, () => {
    if (vpn.running) {
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
    case "off":
      await stop();
      break;
    case "setProfile":
      changingProfile = true;
      try {
        await run({ cmd: "setProfile", conf: msg.conf });
        if (!vpn.error) {
          await start();
        }
      } finally {
        changingProfile = false;
      }
      break;
    case "removeProfile":
      setEnabled(false);
      await run({ cmd: "removeProfile" });
      break;
  }
  return { ...vpn, routing: vpnRouting.mode };
}

// Průběžná kontrola, jestli tunel odpovídá (jen když je VPN zapnutá);
// spadlou VPN (zablokovaný provoz) zkusí znovu spustit
browser.alarms.create("mantis-vpn-status", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== "mantis-vpn-status" || !vpn.enabled || vpn.busy) {
    return;
  }
  run({ cmd: vpn.blocked && vpn.hasProfile ? "start" : "status" });
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
  await vpnLoaded;
  await run({ cmd: "status" });
  if (startWanted && vpn.hasProfile) {
    await start();
  } else if (vpn.enabled && !vpn.hasProfile) {
    setEnabled(false); // profil mezitím zmizel
    updateButton();
  }
})();
