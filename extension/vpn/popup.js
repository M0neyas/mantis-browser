// Okno VPN: přidání profilu, zapnutí/vypnutí, stav. Logika je ve vpn.js.

const $ = id => document.getElementById(id);
const inTab = new URLSearchParams(location.search).has("tab");
let editing = false;

if (inTab) {
  document.body.classList.add("tab");
}

function showError(text) {
  $("error").textContent = text || "";
  $("error").hidden = !text;
}

function render(s) {
  const showProfile = s.hostAvailable && (!s.hasProfile || editing);
  $("no-host").hidden = s.hostAvailable;
  $("profile").hidden = !showProfile;
  $("main").hidden = !s.hostAvailable || showProfile;
  $("cancel").hidden = !s.hasProfile;
  $("endpoint").textContent = s.hasProfile ? s.endpoint : "";

  $("toggle").checked = s.enabled;
  $("toggle").disabled = s.busy;
  $("toggle-label").textContent = s.enabled ? "Zapnuto" : "Vypnuto";
  const routed = {
    all: "Provoz prohlížeče jde přes VPN.",
    only: "Přes VPN jdou jen vybrané weby a kontejnery, zbytek napřímo.",
    except: "Přes VPN jde všechno kromě vybraných webů a kontejnerů.",
  };
  $("state").textContent = !s.enabled
    ? "Prohlížeč jde přímo do internetu."
    : s.connected
      ? routed[s.routing] || routed.all
      : "Tunel zatím neodpovídá – zkontrolujte připojení k internetu a VPN server.";

  showError(s.error);
}

async function send(message) {
  const s = await browser.runtime.sendMessage({ vpn: message.vpn, conf: message.conf });
  render(s);
  return s;
}

// ---------- Profil ----------

// OpenVPN (.ovpn): „remote …“ + „client“ nebo <ca>
function looksLikeOpenVpn(text) {
  return /^\s*remote\s+\S+/im.test(text) && (/^\s*client\s*$/im.test(text) || /<ca>/i.test(text));
}

function looksValid(text) {
  return /\[Interface\]/i.test(text) && /PrivateKey\s*=/i.test(text) &&
    /\[Peer\]/i.test(text) && /Endpoint\s*=/i.test(text);
}

async function readFile(file) {
  if (file.size > 64 * 1024) {
    showError("Soubor je příliš velký – je to opravdu konfigurace WireGuard?");
    return;
  }
  $("conf").value = await file.text();
  showError("");
}

$("save").addEventListener("click", async () => {
  const conf = $("conf").value.trim();
  if (looksLikeOpenVpn(conf)) {
    showError("Tohle je konfigurace OpenVPN. Mantis Browser zatím podporuje jen WireGuard.");
    return;
  }
  if (!looksValid(conf)) {
    showError("Tohle nevypadá jako konfigurace WireGuard (chybí [Interface], PrivateKey, [Peer] nebo Endpoint).");
    return;
  }
  $("save").disabled = true;
  $("save").textContent = "Připojuji…";
  editing = false;
  const s = await send({ vpn: "setProfile", conf });
  $("save").disabled = false;
  $("save").textContent = "Uložit a připojit";
  if (s.error) {
    editing = true;
    render(s);
  } else {
    $("conf").value = "";
    if (inTab) {
      window.close();
    }
  }
});

$("conf").addEventListener("input", () => showError(""));

// Přetažení souboru do pole
$("conf").addEventListener("dragover", e => {
  e.preventDefault();
  $("conf").classList.add("drag");
});
$("conf").addEventListener("dragleave", () => $("conf").classList.remove("drag"));
$("conf").addEventListener("drop", e => {
  e.preventDefault();
  $("conf").classList.remove("drag");
  const file = e.dataTransfer.files[0];
  if (file) {
    readFile(file);
  }
});

// Výběr souboru: z vyskakovacího okna by ho Firefox zavřel → otevřít v kartě
$("load").addEventListener("click", () => {
  if (inTab) {
    $("file").click();
  } else {
    browser.tabs.create({ url: browser.runtime.getURL("vpn/popup.html?tab=1") });
    window.close();
  }
});
$("file").addEventListener("change", () => {
  if ($("file").files[0]) {
    readFile($("file").files[0]);
  }
});

$("cancel").addEventListener("click", async () => {
  editing = false;
  render(await send({ vpn: "state" }));
});

// ---------- Zapnutí / vypnutí ----------

$("toggle").addEventListener("change", () => send({ vpn: "toggle" }));

$("routing").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("settings/settings.html#vpn") });
  if (!inTab) {
    window.close();
  }
});

$("change").addEventListener("click", async () => {
  editing = true;
  render(await send({ vpn: "state" }));
});

$("remove").addEventListener("click", async () => {
  if (confirm("Odebrat VPN profil z tohoto počítače?")) {
    await send({ vpn: "removeProfile" });
  }
});

send({ vpn: "state" });
