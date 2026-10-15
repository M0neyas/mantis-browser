/* global t */
// Nastavení Mantis po kategoriích: vlevo seznam kategorií, vpravo jen sekce vybrané kategorie
// (section[data-category]). Adresa #kategorie nebo #id-sekce (odkazy z panelu, VPN, prostorů)
// otevře správnou kategorii a sjede na sekci. Hledání ukáže odpovídající volby ze všech kategorií.

const CATEGORIES = [
  { id: "general", icon: "🧭" },
  { id: "appearance", icon: "🎨" },
  { id: "tabs", icon: "🗂️" },
  { id: "performance", icon: "⚡" },
  { id: "privacy", icon: "🛡️" },
  { id: "vpn", icon: "🔒" },
  { id: "web", icon: "🧰" },
];

const navList = document.getElementById("nav-list");
const search = document.getElementById("settings-search");
const sections = [...document.querySelectorAll("section[data-category]")];
let currentCategory = "general";

for (const category of CATEGORIES) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nav-item";
  button.dataset.category = category.id;
  button.setAttribute("role", "tab");
  const icon = document.createElement("span");
  icon.className = "nav-icon";
  icon.textContent = category.icon;
  icon.setAttribute("aria-hidden", "true");
  button.append(icon, t(`settings_cat_${category.id}`));
  button.addEventListener("click", () => {
    search.value = "";
    showCategory(category.id);
    history.replaceState(null, "", `#${category.id}`);
    window.scrollTo(0, 0);
  });
  navList.append(button);
}

function showCategory(id) {
  currentCategory = CATEGORIES.some(c => c.id === id) ? id : "general";
  document.body.classList.remove("searching");
  document.getElementById("search-empty").hidden = true;
  for (const section of sections) {
    section.classList.toggle("off", section.dataset.category !== currentCategory);
    for (const row of section.children) {
      row.classList.remove("search-miss");
    }
  }
  for (const button of navList.children) {
    const active = button.dataset.category === currentCategory;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

// #vpn, #messengers… = sekce; #privacy… = kategorie
function openFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const section = sections.find(s => s.id === id);
  if (section) {
    showCategory(section.dataset.category);
    if (section !== sections.find(s => s.dataset.category === section.dataset.category)) {
      requestAnimationFrame(() => section.scrollIntoView({ block: "start" }));
    }
  } else {
    showCategory(id);
  }
}

// ---------- Hledání (bez diakritiky, jako paleta příkazů) ----------

const fold = text => String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function rowText(row) {
  const extra = [...row.querySelectorAll("option")].map(o => o.textContent).join(" ");
  return fold(`${row.textContent} ${extra}`);
}

function runSearch() {
  const words = fold(search.value).split(/\s+/).filter(Boolean);
  if (!words.length) {
    showCategory(currentCategory);
    return;
  }
  document.body.classList.add("searching");
  let any = false;
  for (const section of sections) {
    const title = fold(section.querySelector("h2")?.textContent);
    const titleHit = words.every(w => title.includes(w));
    let hits = 0;
    for (const row of section.children) {
      if (row.tagName === "H2") {
        continue;
      }
      const hit = titleHit || words.every(w => rowText(row).includes(w));
      row.classList.toggle("search-miss", !hit);
      hits += hit && !row.hidden ? 1 : 0;
    }
    section.classList.toggle("off", hits === 0);
    any ||= hits > 0;
  }
  document.getElementById("search-empty").hidden = any;
  for (const button of navList.children) {
    button.classList.remove("active");
    button.setAttribute("aria-selected", "false");
  }
}

search.addEventListener("input", runSearch);
search.addEventListener("keydown", event => {
  if (event.key === "Escape" && search.value) {
    search.value = "";
    runSearch();
  }
});
window.addEventListener("hashchange", openFromHash);
openFromHash();
