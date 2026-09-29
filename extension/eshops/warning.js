// Lišta s varováním před rizikovým e-shopem (eshops.js). Texty a web dostane přes
// window.__mantisEshop (přeložené v jazyce prohlížeče). Ve stínovém DOM, aby ji styly
// webu nerozbily; web ji nemůže přečíst ani skrýt přes CSS.

(() => {
  const data = window.__mantisEshop;
  delete window.__mantisEshop;
  if (!data || document.querySelector("[data-mantis-eshop]")) {
    return;
  }
  const host = document.createElement("div");
  host.setAttribute("data-mantis-eshop", "");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; display: flex; gap: 12px;
        align-items: center; flex-wrap: wrap; padding: 12px 16px; background: #7f1d1d; color: #fff;
        font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
      .icon { font-size: 22px; }
      .text { flex: 1 1 320px; }
      b { display: block; font-size: 15px; }
      a, button { font: inherit; color: #fff; border-radius: 8px; padding: 6px 12px; cursor: pointer;
        text-decoration: none; border: 1px solid rgba(255,255,255,.55); background: transparent; }
      .leave { background: #fff; color: #7f1d1d; border-color: #fff; font-weight: 600; }
      a:hover, button:hover { background: rgba(255,255,255,.15); }
      .leave:hover { background: #fee2e2; }
    </style>
    <div class="bar" role="alert">
      <span class="icon">⚠️</span>
      <span class="text"><b class="title"></b><span class="body"></span></span>
      <button class="leave" type="button"></button>
      <a class="coi" target="_blank" rel="noopener"></a>
      <button class="dismiss" type="button"></button>
    </div>`;
  root.querySelector(".title").textContent = data.title;
  root.querySelector(".body").textContent = data.text;
  root.querySelector(".leave").textContent = data.leave;
  const coi = root.querySelector(".coi");
  coi.textContent = data.coi;
  coi.href = data.url;
  root.querySelector(".dismiss").textContent = data.dismiss;

  root.querySelector(".leave").addEventListener("click", () => {
    browser.runtime.sendMessage({ eshopLeave: true });
  });
  root.querySelector(".dismiss").addEventListener("click", () => {
    browser.runtime.sendMessage({ eshopDismiss: data.site });
    host.remove();
  });
  document.documentElement.append(host);
})();
