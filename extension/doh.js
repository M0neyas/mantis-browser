// Šifrované DNS (DNS over HTTPS) – Nastavení Mantis → Šifrované DNS.
//  - "auto": zapne se, jen když to síť dovolí. Pi-hole i mnoho firemních sítí
//    blokují kanárkovou doménu use-application-dns.net – pak zůstane DNS sítě
//    (Pi-hole dál blokuje, firemní DNS se neobchází). Kontrola při startu, při změně
//    sítě (networkStatus) a každých 10 minut.
//  - "on": vždy zapnuto, "off" (výchozí – DNS dotazy nejdou třetí straně bez souhlasu,
//    pravidlo Storu 10.5.2): vždy DNS sítě. Zapíná uživatel (uvítací stránka, Nastavení Mantis).
// Režim TRR 2 = šifrované DNS s návratem k DNS sítě, když poskytovatel neodpovídá.
// Se zapnutou VPN jde DNS tunelem (proxyDNS) a tohle nastavení se nepoužije.

// Názvy pro uživatele jsou v Nastavení Mantis (settings.html), tady jen adresy
const DOH_PROVIDERS = {
  quad9: "https://dns.quad9.net/dns-query",
  mullvad: "https://dns.mullvad.net/dns-query",
  "mullvad-adblock": "https://adblock.dns.mullvad.net/dns-query",
  cloudflare: "https://mozilla.cloudflare-dns.com/dns-query",
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
    const provider = Object.hasOwn(DOH_PROVIDERS, config.provider) ? config.provider : "quad9";

    // reason: kód, text podle něj ukáže Nastavení Mantis (doh_reason_<kód>)
    let active;
    let reason;
    if (config.mode === "off") {
      active = false;
      reason = "off";
    } else if (config.mode === "on") {
      active = true;
      reason = "on";
    } else if (await networkAllowsDoh()) {
      active = true;
      reason = "allowed";
    } else {
      active = false;
      reason = "blocked"; // Pi-hole, firemní síť – používá se DNS sítě
    }

    await browser.mantisPrefs.set("network.trr.uri", DOH_PROVIDERS[provider]);
    await browser.mantisPrefs.set("network.trr.mode", active ? TRR_FIRST : TRR_OFF);
    await browser.storage.local.set({
      dohState: { active, reason, provider, checked: Date.now() },
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
