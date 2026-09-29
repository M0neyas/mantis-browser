// „Upravit a uložit PDF“ (tools.js): lišta nahoře na stránce. Najetím myší se zvýrazní prvek,
// kliknutím se skryje (reklamy, lišty, obrázky…), Zpět / Ctrl+Z vrátí poslední, „Uložit jako
// PDF…“ otevře tisk (cíl „Uložit jako PDF“, měřítko a okraje jsou v dialogu tisku).
// Změny platí jen do obnovení stránky. Lišta je ve stínovém DOM, aby ji nerozbily styly webu.
// Spuštění podruhé lištu zavře.

(() => {
  if (window.__mantisPrintEdit) {
    window.__mantisPrintEdit.close();
    return;
  }
  const msg = (key, ...subs) => browser.i18n.getMessage(key, subs.map(String)) || key;

  const hidden = []; // [{ el, value, priority }] – pořadí pro Zpět
  let imagesHidden = false;
  let current = null;

  const host = document.createElement("div");
  host.setAttribute("data-mantis-print-edit", "");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
        display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-radius: 12px;
        background: #1c1f24; color: #f2f4f5; font: 13px/1.3 system-ui, sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: calc(100vw - 32px); flex-wrap: wrap; }
      .hint { padding: 0 6px; opacity: .85; }
      button { font: inherit; color: inherit; background: #2c3138; border: 1px solid #3a4048;
        border-radius: 8px; padding: 5px 10px; cursor: pointer; }
      button:hover { background: #363c44; }
      button.primary { background: #22c55e; border-color: #22c55e; color: #06270f; font-weight: 600; }
      button:disabled { opacity: .45; cursor: default; }
      .count { opacity: .7; min-width: 1.5em; text-align: center; }
      .box { position: fixed; z-index: 2147483646; pointer-events: none; display: none;
        outline: 2px solid #22c55e; background: rgba(34,197,94,.15); border-radius: 3px; }
    </style>
    <div class="box"></div>
    <div class="bar" role="toolbar">
      <span class="hint"></span>
      <button data-act="undo"></button>
      <span class="count">0</span>
      <button data-act="images"></button>
      <button data-act="reader"></button>
      <button data-act="restore"></button>
      <button data-act="print" class="primary"></button>
      <button data-act="close" aria-label="×">×</button>
    </div>`;
  const bar = root.querySelector(".bar");
  const box = root.querySelector(".box");
  const $ = act => root.querySelector(`[data-act="${act}"]`);
  root.querySelector(".hint").textContent = msg("printEdit_hint");
  $("undo").textContent = msg("printEdit_undo");
  $("reader").textContent = msg("printEdit_reader");
  $("restore").textContent = msg("printEdit_restore");
  $("print").textContent = msg("printEdit_print");
  $("close").title = msg("printEdit_close");

  function refresh() {
    $("undo").disabled = !hidden.length;
    $("restore").disabled = !hidden.length && !imagesHidden;
    root.querySelector(".count").textContent = hidden.length;
    $("images").textContent = msg(imagesHidden ? "printEdit_showImages" : "printEdit_hideImages");
  }

  function hide(el) {
    hidden.push({ el, value: el.style.getPropertyValue("display"), priority: el.style.getPropertyPriority("display") });
    el.style.setProperty("display", "none", "important");
    refresh();
  }

  function undo() {
    const last = hidden.pop();
    if (last) {
      last.el.style.setProperty("display", last.value, last.priority);
    }
    refresh();
  }

  function setImages(off) {
    imagesHidden = off;
    document.documentElement.toggleAttribute("data-mantis-print-noimg", off);
    refresh();
  }

  // ---------- Výběr prvku myší ----------

  const pickable = el => el && el !== host && el !== document.documentElement && el !== document.body;

  function onMove(event) {
    const el = event.target;
    if (!pickable(el) || event.composedPath().includes(host)) {
      box.style.display = "none";
      current = null;
      return;
    }
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function onClick(event) {
    if (event.composedPath().includes(host)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (pickable(current)) {
      hide(current);
      box.style.display = "none";
      current = null;
    }
  }

  // Kliknutí nesmí na stránce nic spustit (odkazy, tlačítka) – zachytit i stisk a puštění
  function swallow(event) {
    if (!event.composedPath().includes(host)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onKey(event) {
    if (event.key === "Escape") {
      close();
    } else if (event.key === "z" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      undo();
    }
  }

  // ---------- Tisk ----------

  function print() {
    box.style.display = "none";
    bar.style.display = "none"; // tisk ji skryje i sám (print-edit.css), tohle je pro náhled
    window.addEventListener("afterprint", () => (bar.style.display = ""), { once: true });
    setTimeout(() => window.print(), 50);
  }

  const listeners = [
    ["mousemove", onMove],
    ["click", onClick],
    ["mousedown", swallow],
    ["mouseup", swallow],
    ["auxclick", swallow],
    ["keydown", onKey],
  ];

  function close() {
    for (const [type, fn] of listeners) {
      document.removeEventListener(type, fn, true);
    }
    host.remove();
    delete window.__mantisPrintEdit;
  }

  function restore() {
    while (hidden.length) {
      undo();
    }
    setImages(false);
  }

  $("undo").addEventListener("click", undo);
  $("images").addEventListener("click", () => setImages(!imagesHidden));
  $("reader").addEventListener("click", () => {
    browser.runtime.sendMessage({ toolReaderMode: true });
    close();
  });
  $("restore").addEventListener("click", restore);
  $("print").addEventListener("click", print);
  $("close").addEventListener("click", close);

  for (const [type, fn] of listeners) {
    document.addEventListener(type, fn, true);
  }
  document.documentElement.append(host);
  refresh();
  window.__mantisPrintEdit = { close };
})();
