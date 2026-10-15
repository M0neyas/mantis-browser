// QR kód adresy přes stránku (vkládá ../qrcode.js → qr.js přes tabs.executeScript).
// Adresa: window.mantisQrTarget (odkaz z kontextové nabídky), jinak adresa stránky.
// Shadow DOM, aby styly stránky okno nerozbily. Zavře se Esc, křížkem nebo klikem vedle.
/* global mantisQr, mantisQrSvg */

(() => {
  document.getElementById("mantis-qr-host")?.remove();
  const url = typeof window.mantisQrTarget === "string" ? window.mantisQrTarget : location.href;
  delete window.mantisQrTarget;
  const msg = key => browser.i18n.getMessage(key) || key;

  const host = document.createElement("div");
  host.id = "mantis-qr-host";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .dim { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
      background: rgb(0 0 0 / 0.45); font: 14px/1.45 system-ui, "Segoe UI", sans-serif; }
    .card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px;
      width: min(340px, calc(100vw - 32px)); padding: 22px 22px 18px; border-radius: 16px;
      background: #fff; color: #1a2e22; box-shadow: 0 18px 50px rgb(0 0 0 / 0.35); }
    b { font-size: 16px; font-weight: 600; }
    .code { width: 100%; aspect-ratio: 1; }
    .code svg { display: block; width: 100%; height: 100%; }
    .url { max-width: 100%; overflow: hidden; color: #5b6b61; font-size: 12.5px; white-space: nowrap;
      text-overflow: ellipsis; }
    .hint { color: #5b6b61; font-size: 12.5px; text-align: center; }
    .close { position: absolute; top: 8px; right: 8px; width: 30px; height: 30px; border: none;
      border-radius: 8px; background: transparent; color: #5b6b61; font: 20px/1 system-ui; cursor: pointer; }
    .close:hover { background: rgb(0 0 0 / 0.07); }
    .close:focus-visible { outline: 2px solid #22c55e; }
    .card:focus { outline: none; }
  `;
  const dim = document.createElement("div");
  dim.className = "dim";
  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", msg("qr_title"));
  card.tabIndex = -1;
  const title = document.createElement("b");
  title.textContent = msg("qr_title");
  const code = document.createElement("div");
  code.className = "code";
  const qr = mantisQr(url);
  if (qr) {
    const svg = new DOMParser().parseFromString(mantisQrSvg(qr), "image/svg+xml").documentElement;
    code.append(document.importNode(svg, true));
  } else {
    code.hidden = true;
  }
  const address = document.createElement("span");
  address.className = "url";
  address.textContent = url;
  address.title = url;
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = msg(qr ? "qr_hint" : "qr_tooLong");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.textContent = "×";
  close.setAttribute("aria-label", msg("qr_close"));
  card.append(close, title, code, address, hint);
  dim.append(card);
  root.append(style, dim);

  const remove = () => {
    host.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      remove();
    }
  };
  close.addEventListener("click", remove);
  dim.addEventListener("click", event => {
    if (event.target === dim) {
      remove();
    }
  });
  document.addEventListener("keydown", onKey, true);
  (document.body || document.documentElement).append(host);
  card.focus({ preventScroll: true }); // Esc funguje hned, bez rámečku na křížku
})();
