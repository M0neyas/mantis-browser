// Převod měn ve výběru podle kurzu ČNB (Nastavení Mantis → Nákupy, currencyConvert, výchozí
// zapnuto). Označíte „49,99 €“ nebo „USD 120“ a v kontextové nabídce je „≈ 1 248,35 Kč
// (kurz ČNB 25. 9.)“, kliknutí výsledek zkopíruje. Částka v Kč se převede na eura.
// Kurzovní lístek (denni_kurz.txt) se stahuje jen při zapnutém převodu, nejvýš jednou za 6 h
// (ČNB vyhlašuje kurzy v pracovní dny kolem 14:30), ukládá se do storage.local → cnbRates.

const CNB_URL =
  "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt";
const CURRENCY_MENU = "mantis-currency";
const CURRENCY_ALARM = "mantis-cnb-rates";
const CNB_MAX_AGE = 6 * 60 * 60 * 1000;

// Symboly a zkratky → kód ISO (ostatní měny jen kódem: „120 CHF“, „SEK 99“)
const CURRENCY_SIGNS = [
  ["€", "EUR"], ["US$", "USD"], ["$", "USD"], ["£", "GBP"], ["¥", "JPY"], ["zł", "PLN"],
  ["Ft", "HUF"], ["Kč", "CZK"], ["₣", "CHF"], ["₹", "INR"], ["₩", "KRW"], ["₺", "TRY"], ["₴", "UAH"], // i18n-ignore
];

let cnbRates = null; // { date: "RRRR-MM-DD", fetched, rates: { EUR: Kč za 1 EUR, … } }
let currencyEnabled = true;

// ---------- Kurzovní lístek ----------

// „25.09.2026 #186“, „země|měna|množství|kód|kurz“, „EMU|euro|1|EUR|24,305“
function parseCnb(text) {
  const lines = text.trim().split("\n");
  const [d, m, y] = (lines[0].match(/^(\d{2})\.(\d{2})\.(\d{4})/) || []).slice(1);
  const rates = {};
  for (const line of lines.slice(2)) {
    const [, , amount, code, rate] = line.split("|");
    const value = Number(String(rate).replace(",", ".")) / Number(amount);
    if (/^[A-Z]{3}$/.test(code) && value > 0) {
      rates[code] = value;
    }
  }
  if (!y || !rates.EUR) {
    throw new Error("unexpected CNB format");
  }
  return { date: `${y}-${m}-${d}`, fetched: Date.now(), rates };
}

async function refreshCnbRates(force = false) {
  if (!currencyEnabled) {
    return;
  }
  if (!cnbRates) {
    ({ cnbRates } = await browser.storage.local.get("cnbRates"));
  }
  if (!force && cnbRates && Date.now() - cnbRates.fetched < CNB_MAX_AGE) {
    return;
  }
  try {
    const response = await fetch(CNB_URL, { cache: "no-store", credentials: "omit" });
    if (response.ok) {
      cnbRates = parseCnb(await response.text());
      await browser.storage.local.set({ cnbRates });
    }
  } catch (e) {
    console.warn("Mantis – kurzy ČNB:", e.message); // offline – zůstane poslední známý kurz
  }
}

// ---------- Částka ve výběru ----------

// „1 234,56“, „1.234,56“, „1,234.56“, „49,99“, „49.99“, „1.500“ (tisíce), „2,5“
function parseNumber(text) {
  let s = text.replace(/[\s  ']/g, "");
  if (!/^\d[\d.,]*$/.test(s)) {
    return null;
  }
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    s = s.split(decimal === "," ? "." : ",").join("").replace(decimal, ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const thousands = new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`);
    s = thousands.test(s) ? s.split(sep).join("") : s.split(sep).length === 2 ? s.replace(sep, ".") : null;
  }
  const n = s === null ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}

// Výběr → { amount, code } nebo null. Měna před i za číslem, s mezerou i bez.
function parseMoney(text, rates) {
  const s = String(text || "").trim().replace(/,-$|\.-$/, "");
  if (!s || s.length > 40) {
    return null;
  }
  let code = null;
  let rest = s;
  for (const [sign, iso] of CURRENCY_SIGNS) {
    if (rest.startsWith(sign) || rest.endsWith(sign)) {
      code = iso;
      rest = rest.startsWith(sign) ? rest.slice(sign.length) : rest.slice(0, -sign.length);
      break;
    }
  }
  if (!code) {
    const m = rest.match(/^([A-Za-z]{3})\s*(.+)$/) || rest.match(/^(.+?)\s*([A-Za-z]{3})$/);
    if (m) {
      const iso = (/^[A-Za-z]{3}$/.test(m[1]) ? m[1] : m[2]).toUpperCase();
      if (iso === "CZK" || rates[iso]) {
        code = iso;
        rest = /^[A-Za-z]{3}$/.test(m[1]) ? m[2] : m[1];
      }
    }
  }
  const amount = code && parseNumber(rest.trim().replace(/[,.]-$/, "")); // „1 250,- Kč“
  return amount && amount > 0 ? { amount, code } : null;
}

function formatMoney(value, code) {
  return new Intl.NumberFormat(uiLocale(), { style: "currency", currency: code, maximumFractionDigits: 2 }).format(value);
}

// { label: text do nabídky, copy: text do schránky } nebo null
function convertSelection(text) {
  if (!cnbRates) {
    return null;
  }
  const money = parseMoney(text, cnbRates.rates);
  if (!money) {
    return null;
  }
  const date = new Date(`${cnbRates.date}T12:00:00`).toLocaleDateString(uiLocale(), { day: "numeric", month: "numeric" });
  const result =
    money.code === "CZK"
      ? formatMoney(money.amount / cnbRates.rates.EUR, "EUR")
      : money.code in cnbRates.rates
        ? formatMoney(money.amount * cnbRates.rates[money.code], "CZK")
        : null;
  return result && { label: t("currency_menu", result, date), copy: result };
}

// ---------- Kontextová nabídka ----------

let currencyMenuShown = false;

async function currencyMenu() {
  ({ currencyConvert: currencyEnabled } = await browser.storage.local.get({ currencyConvert: true }));
  await browser.menus.remove(CURRENCY_MENU).catch(() => {});
  if (currencyEnabled) {
    browser.menus.create({ id: CURRENCY_MENU, title: t("currency_menuDefault"), contexts: ["selection"], visible: false });
    refreshCnbRates();
  }
}

browser.menus.onShown.addListener(info => {
  if (!currencyEnabled || !info.contexts.includes("selection")) {
    return;
  }
  const converted = convertSelection(info.selectionText);
  if (converted || currencyMenuShown) {
    currencyMenuShown = !!converted;
    browser.menus.update(CURRENCY_MENU, converted ? { visible: true, title: converted.label } : { visible: false });
    browser.menus.refresh();
  }
});

browser.menus.onClicked.addListener(info => {
  if (info.menuItemId === CURRENCY_MENU) {
    const converted = convertSelection(info.selectionText);
    if (converted) {
      copyToClipboard(converted.copy).catch(e => console.error("Mantis – převod měn:", e));
    }
  }
});

browser.alarms.create(CURRENCY_ALARM, { delayInMinutes: 2, periodInMinutes: 60 });
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CURRENCY_ALARM) {
    refreshCnbRates();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.currencyConvert) {
    currencyMenu();
  }
});

// Nastavení Mantis: datum kurzu
browser.runtime.onMessage.addListener(msg =>
  msg?.cnbRatesInfo ? refreshCnbRates().then(() => cnbRates && { date: cnbRates.date, currencies: Object.keys(cnbRates.rates).length }) : undefined
);

currencyMenu();
