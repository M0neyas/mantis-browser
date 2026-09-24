// Šifrované DNS (DNS over HTTPS) – Nastavení Mantis → Šifrované DNS.
//  - "auto": zapne se, jen když to síť dovolí. Pi-hole i mnoho firemních sítí
//    blokují kanárkovou doménu use-application-dns.net – pak zůstane DNS sítě
//    (Pi-hole dál blokuje, firemní DNS se neobchází). Kontrola při startu, při změně
//    sítě (networkStatus) a každých 10 minut.
//  - "on": vždy zapnuto, "off" (výchozí – DNS dotazy nejdou třetí straně bez souhlasu,
//    pravidlo Storu 10.5.2): vždy DNS sítě. Zapíná uživatel (uvítací stránka, Nastavení Mantis).
// Režim TRR 2 = šifrované DNS s návratem k DNS sítě, když poskytovatel neodpovídá.
// Se zapnutou VPN jde DNS tunelem (proxyDNS) a tohle nastavení se nepoužije.

const DOH_PROVIDERS = {
  quad9: { name: "Quad9", uri: "https://dns.quad9.net/dns-query" },
  mullvad: { name: "Mullvad", uri: "https://dns.mullvad.net/dns-query" },
  "mullvad-adblock": { name: "Mullvad (blokuje reklamy)", uri: "https://adblock.dns.mullvad.net/dns-query" },
  cloudflare: { name: "Cloudflare", uri: "https://mozilla.cloudflare-dns.com/dns-query" },
};
const DOH_DEFAULTS = { mode: "off", provider: "quad9" }; // výchozí vypnuto – zapíná uživatel
const DOH_CANARY = "use-application-dns.net";
const DOH_ALARM = "mantis-doh-check";
const TRR_FIRST = 2;
const TRR_OFF = 5;

// Kanárková doména: zablokovaná (NXDOMAIN, 0.0.0.0) = síť nechce šifrované DNS
async function networkAllowsDoh() {
  try {
    const record = await browser.dns.resolve(DOH_CANARY, ["disable_trr", "bypass_cache"]);
    const blocked = ["0.0.0.0", "::", "127.0.0.1", "::1"];
    const addresses = record.addresses || [];
    return addresses.length > 0 && !addresses.every(a => blocked.includes(a));
  } catch (e) {
    return false; // NXDOMAIN (Pi-hole, firemní síť) nebo offline
  }
}

let dohChecking = false;

async function applyDoh() {
  if (dohChecking) {
    return;
  }
  dohChecking = true;
  try {
    const { doh } = await browser.storage.local.get("doh");
    const config = { ...DOH_DEFAULTS, ...doh };
    const provider = DOH_PROVIDERS[config.provider] || DOH_PROVIDERS.quad9;

    let active;
    let reason;
    if (config.mode === "off") {
      active = false;
      reason = "vypnuto v nastavení";
    } else if (config.mode === "on") {
      active = true;
      reason = "zapnuto v nastavení";
    } else if (await networkAllowsDoh()) {
      active = true;
      reason = "síť ho dovoluje";
    } else {
      active = false;
      reason = "síť si ho nepřeje (Pi-hole, firemní síť) – používá se DNS sítě";
    }

    await browser.mantisPrefs.set("network.trr.uri", provider.uri);
    await browser.mantisPrefs.set("network.trr.mode", active ? TRR_FIRST : TRR_OFF);
    await browser.storage.local.set({
      dohState: { active, reason, provider: provider.name, checked: Date.now() },
    });
  } catch (e) {
    console.error("Mantis DoH:", e);
  } finally {
    dohChecking = false;
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.doh) {
    applyDoh();
  }
});

// Nová Wi-Fi, odpojení kabelu… → znovu zjistit, jestli jsme doma
browser.networkStatus.onConnectionChanged.addListener(() => {
  setTimeout(applyDoh, 3000); // chvíli počkat, než síť naběhne (DHCP, DNS)
});

browser.alarms.create(DOH_ALARM, { delayInMinutes: 10, periodInMinutes: 10 });
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === DOH_ALARM) {
    applyDoh();
  }
});

// Ze stránky Nastavení Mantis („Zkontrolovat teď“)
browser.runtime.onMessage.addListener(msg => (msg?.dohCheck ? applyDoh().then(() => true) : undefined));

applyDoh();
