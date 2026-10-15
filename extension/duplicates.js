// Zdvojené karty (jako Arc, Zen): když nová karta načte adresu, která už je v tomto okně otevřená
// (stejný kontejner, viditelná karta), Mantis přepne na tu původní a novou zavře. Platí jen pro
// nově otevřené karty – procházení v existující kartě se nehlídá. Výjimky: duplikování karty
// (původní karta = otvírač), karty v rozděleném zobrazení, obnova relace po spuštění.
// Paleta: „Zavřít zdvojené karty“ v okně. storage.local: dedupeTabs (výchozí zapnuto).

const DEDUPE_WATCH_MS = 120000; // jak dlouho po otevření karty hlídat první adresu (psaní do nové karty)
const DEDUPE_REDIRECT_MS = 3000; // po první adrese ještě hlídat přesměrování (t.co → cíl)
const DEDUPE_STARTUP_MS = 15000; // po spuštění se obnovují karty – nehlídat
const dedupeStarted = Date.now();
const dedupePending = new Map(); // tabId → { created, firstUrlAt }
let dedupeEnabled = true;

browser.storage.local.get({ dedupeTabs: true }).then(({ dedupeTabs }) => { dedupeEnabled = dedupeTabs; });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.dedupeTabs) {
    dedupeEnabled = changes.dedupeTabs.newValue !== false;
  }
});

const DEDUPE_URL = /^https?:/;

function dedupeKey(tab) {
  return `${tab.cookieStoreId || ""}\n${tab.url}`;
}

browser.tabs.onCreated.addListener(tab => {
  if (dedupeEnabled && Date.now() - dedupeStarted > DEDUPE_STARTUP_MS) {
    dedupePending.set(tab.id, { created: Date.now(), firstUrlAt: 0 });
  }
});

browser.tabs.onRemoved.addListener(tabId => dedupePending.delete(tabId));

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const pending = dedupePending.get(tabId);
  if (!pending || !changeInfo.url) {
    return;
  }
  const now = Date.now();
  if (now - pending.created > DEDUPE_WATCH_MS || (pending.firstUrlAt && now - pending.firstUrlAt > DEDUPE_REDIRECT_MS)) {
    dedupePending.delete(tabId);
    return;
  }
  if (!dedupeEnabled || !DEDUPE_URL.test(changeInfo.url) || tab.hidden) {
    return;
  }
  pending.firstUrlAt ||= now;
  const key = dedupeKey(tab);
  const existing = (await browser.tabs.query({ windowId: tab.windowId, hidden: false }))
    .find(other => other.id !== tabId && other.id !== tab.openerTabId && dedupeKey(other) === key);
  if (!existing || !dedupePending.has(tabId)) {
    return;
  }
  const inSplit = await Promise.all([tabId, existing.id].map(id => browser.mantisPrefs.tabInSplitView(id).catch(() => false)));
  if (inSplit.some(Boolean)) {
    return;
  }
  dedupePending.delete(tabId);
  const current = await browser.tabs.get(tabId).catch(() => null);
  if (!current || current.url !== tab.url) {
    return; // mezitím přešla jinam
  }
  if (current.active) {
    await browser.tabs.update(existing.id, { active: true });
  }
  await browser.tabs.remove(tabId);
}, { properties: ["url"] });

// Paleta: zavřít zdvojené karty v okně – nechá aktivní, připnutou, jinak první zleva
async function closeDuplicateTabs(windowId) {
  const tabs = (await browser.tabs.query({ windowId, hidden: false })).filter(tab => DEDUPE_URL.test(tab.url || ""));
  const keep = new Map();
  const rank = tab => (tab.active ? 0 : tab.pinned ? 1 : 2);
  for (const tab of tabs) {
    const key = dedupeKey(tab);
    const kept = keep.get(key);
    if (!kept || rank(tab) < rank(kept)) {
      keep.set(key, tab);
    }
  }
  const keptIds = new Set([...keep.values()].map(tab => tab.id));
  const close = [];
  for (const tab of tabs.filter(tab => !keptIds.has(tab.id) && !tab.pinned)) {
    if (!(await browser.mantisPrefs.tabInSplitView(tab.id).catch(() => false))) {
      close.push(tab.id);
    }
  }
  if (close.length) {
    await browser.tabs.remove(close);
  }
  return close.length;
}
