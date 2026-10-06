// Boční panel s messengery (seznam služeb a úprava hlaviček v ../messengers.js).
// Vlevo lišta s ikonami, vpravo služba v rámci. Rámec se vytvoří při prvním otevření
// služby a pak zůstává (přepnutí neztratí rozepsanou zprávu ani přehrávání Spotify).
// Rámce jsou sandbox bez allow-top-navigation: web nemůže přesměrovat stránku panelu.
/* global t, applyI18n */

applyI18n();

const rail = document.getElementById("rail");
const frames = document.getElementById("frames");
const frameOf = new Map();
let current = null;

function serviceButton(service) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "service";
  button.title = service.name;
  button.setAttribute("aria-label", service.name);
  button.style.setProperty("--service-color", service.color);
  button.textContent = service.letter;
  button.addEventListener("click", () => open(service));
  button.dataset.id = service.id;
  return button;
}

function open(service) {
  let frame = frameOf.get(service.id);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.src = service.url;
    frame.title = service.name;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals");
    frame.setAttribute("allow", "autoplay; encrypted-media; clipboard-read; clipboard-write; microphone; camera");
    frames.append(frame);
    frameOf.set(service.id, frame);
  }
  for (const [id, other] of frameOf) {
    other.hidden = id !== service.id;
  }
  for (const button of rail.querySelectorAll(".service")) {
    button.toggleAttribute("aria-current", button.dataset.id === service.id);
  }
  current = service.id;
  browser.storage.local.set({ sidebarLast: service.id });
}

async function render() {
  const [{ services, enabled }, { sidebarLast }] = await Promise.all([
    browser.runtime.sendMessage({ messengerServices: true }),
    browser.storage.local.get({ sidebarLast: "" }),
  ]);
  const shown = services.filter(s => enabled.includes(s.id));
  rail.replaceChildren(...shown.map(serviceButton));
  const settings = document.createElement("button");
  settings.type = "button";
  settings.className = "settings";
  settings.title = t("sidebar_settings");
  settings.setAttribute("aria-label", t("sidebar_settings"));
  settings.textContent = "⚙";
  settings.addEventListener("click", () =>
    browser.tabs.create({ url: browser.runtime.getURL("settings/settings.html#messengers") }));
  rail.append(settings);
  // vypnuté služby zavřít (i se svým rámcem)
  for (const [id, frame] of frameOf) {
    if (!shown.some(s => s.id === id)) {
      frame.remove();
      frameOf.delete(id);
    }
  }
  document.getElementById("empty").hidden = shown.length > 0;
  const start = shown.find(s => s.id === (current || sidebarLast)) || shown[0];
  if (start) {
    open(start);
  }
}

render();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sidebarServices) {
    render();
  }
});
