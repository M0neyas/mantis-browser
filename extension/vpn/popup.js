// Okno VPN: přidání profilu, zapnutí/vypnutí, stav. Logika je ve vpn.js.
/* global t, applyI18n */

applyI18n();

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
  $("unblock").hidden = s.hostAvailable || !s.enabled;
  $("profile").hidden = !showProfile;
  $("main").hidden = !s.hostAvailable || showProfile;
  $("cancel").hidden = !s.hasProfile;
  $("endpoint").textContent = s.hasProfile ? s.endpoint : "";

  $("toggle").checked = s.enabled;
  $("toggle").disabled = s.busy;
  $("toggle-label").textContent = t(s.enabled ? "common_on" : "common_off");
  const routed = { all: "vpn_routedAll", only: "vpn_routedOnly", except: "vpn_routedExcept" };
  $("state").textContent = t(
    !s.enabled
      ? "vpn_stateDirect"
      : s.blocked
        ? "vpn_stateBlocked"
        : s.connected
          ? routed[s.routing] || routed.all
          : "vpn_stateNoResponse"
  );

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
    showError(t("vpn_fileTooBig"));
    return;
  }
  $("conf").value = await file.text();
  showError("");
}

$("save").addEventListener("click", async () => {
  const conf = $("conf").value.trim();
  if (looksLikeOpenVpn(conf)) {
    showError(t("vpn_isOpenVpn"));
    return;
  }
  if (!looksValid(conf)) {
    showError(t("vpn_notWireguard"));
    return;
  }
  $("save").disabled = true;
  $("save").textContent = t("vpn_connecting");
  editing = false;
  const s = await send({ vpn: "setProfile", conf });
  $("save").disabled = false;
  $("save").textContent = t("vpn_saveConnect");
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
$("unblock-btn").addEventListener("click", () => send({ vpn: "off" }));

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
  if (confirm(t("vpn_confirmRemove"))) {
    await send({ vpn: "removeProfile" });
  }
});

send({ vpn: "state" });
