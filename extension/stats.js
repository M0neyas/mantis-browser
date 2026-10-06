// Statistiky ochrany (jako Brave): kolik reklam a sledovačů Mantis zablokoval – požadavky
// zrušené uBlockem (NS_ERROR_ABORT) a ochranou proti sledování Firefoxu (NS_ERROR_*_URI).
// Počítá se jen v tomto počítači, nic se neodesílá; ukazuje to nová karta.
// storage.local: protectionStats { "RRRR-MM-DD": počet } za posledních 30 dní,
// newtabStats (zobrazit na nové kartě, výchozí zapnuto; synchronizuje se).

const STATS_ERRORS = new Set([
  "NS_ERROR_ABORT", // zrušeno rozšířením (uBlock Origin)
  "NS_ERROR_TRACKING_URI",
  "NS_ERROR_FINGERPRINTING_URI",
  "NS_ERROR_CRYPTOMINING_URI",
  "NS_ERROR_SOCIALTRACKING_URI",
  "NS_ERROR_EMAILTRACKING_URI",
]);
const STATS_DAYS = 30;
const STATS_FLUSH_MS = 20 * 1000;
let statsPending = 0;
let statsTimer = null;

function statsDay(date = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function statsFlush() {
  statsTimer = null;
  if (!statsPending) {
    return;
  }
  const add = statsPending;
  statsPending = 0;
  const { protectionStats } = await browser.storage.local.get({ protectionStats: {} });
  const today = statsDay();
  const oldest = statsDay(new Date(Date.now() - STATS_DAYS * 864e5));
  const next = Object.fromEntries(Object.entries(protectionStats || {}).filter(([day]) => day >= oldest));
  next[today] = (next[today] || 0) + add;
  await browser.storage.local.set({ protectionStats: next });
}

browser.webRequest.onErrorOccurred.addListener(details => {
  // jen požadavky stránek (ne hlavní dokument – zrušená navigace není zablokovaný sledovač)
  if (details.tabId < 0 || details.type === "main_frame" || !STATS_ERRORS.has(details.error)) {
    return;
  }
  statsPending++;
  statsTimer ??= setTimeout(() => statsFlush().catch(e => console.error("Mantis – statistiky:", e)), STATS_FLUSH_MS);
}, { urls: ["http://*/*", "https://*/*"] });

async function statsSummary() {
  await statsFlush();
  const { protectionStats } = await browser.storage.local.get({ protectionStats: {} });
  const week = statsDay(new Date(Date.now() - 6 * 864e5));
  let weekCount = 0;
  let total = 0;
  for (const [day, count] of Object.entries(protectionStats || {})) {
    total += count;
    if (day >= week) {
      weekCount += count;
    }
  }
  return { today: protectionStats?.[statsDay()] || 0, week: weekCount, total };
}

browser.runtime.onMessage.addListener(msg => {
  if (msg?.protectionStats) {
    return statsSummary();
  }
  return undefined;
});
