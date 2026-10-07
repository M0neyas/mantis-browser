// Stránka „VPN je odpojená – provoz je zablokovaný“ (kill switch). Ukáže ji vpn.js místo
// chyby „Proxy server odmítá spojení“, když kill switch zablokuje načtení stránky.

applyI18n();

const target = new URLSearchParams(location.search).get("url") || "";
const safeTarget = /^https?:\/\//i.test(target) ? target : "";
document.getElementById("url").textContent = safeTarget;

const status = document.getElementById("status");
const buttons = [...document.querySelectorAll("button")];

async function act(message, okText) {
  buttons.forEach(b => { b.disabled = true; });
  status.textContent = "";
  try {
    const state = await browser.runtime.sendMessage({ vpn: message });
    if (!state.blocked) {
      if (safeTarget) {
        location.replace(safeTarget);
      } else {
        status.textContent = t(okText);
      }
      return;
    }
    status.textContent = state.error || t("vpnBlocked_stillBlocked");
  } catch (e) {
    status.textContent = String(e?.message || e);
  }
  buttons.forEach(b => { b.disabled = false; });
}

document.getElementById("off").addEventListener("click", () => act("off", "vpnBlocked_offDone"));
document.getElementById("retry").addEventListener("click", () => act("retry", "vpnBlocked_retryDone"));
