/* global applyI18n, t, mantisQr, mantisQrSvg */
// QR kód na vlastní kartě (stránky, kam rozšíření nesmí vložit okno)
applyI18n();
const url = new URLSearchParams(location.search).get("u") || "";
const web = /^https?:\/\//.test(url);
const qr = web ? mantisQr(url) : null;
document.getElementById("url").textContent = url;
document.getElementById("url").title = url;
document.getElementById("hint").textContent = t(!web ? "qr_notWeb" : qr ? "qr_hint" : "qr_tooLong");
if (qr) {
  const svg = new DOMParser().parseFromString(mantisQrSvg(qr), "image/svg+xml").documentElement;
  document.getElementById("code").append(document.importNode(svg, true));
} else {
  document.getElementById("code").hidden = true;
}
