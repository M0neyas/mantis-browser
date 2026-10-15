// Hraje jen jedna karta: když se rozezní karta, která je právě otevřená (uživatel pustil video
// nebo hudbu), ostatní hrající karty se pozastaví. Karta na pozadí, která začne hrát sama
// (další skladba, reklama), nikoho nepozastaví. Karty s mikrofonem nebo kamerou (hovory) a
// ztlumené karty se nechají být. Když není co pozastavit (stránka bez přístupu, Web Audio),
// karta se ztlumí a po přepnutí na ni se zase zesílí.
// storage.local: autoPause (výchozí zapnuto, sync).

let autoPauseEnabled = true;
const autoPauseMuted = new Set(); // karty ztlumené touto funkcí

browser.storage.local.get({ autoPause: true }).then(({ autoPause }) => { autoPauseEnabled = autoPause; });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.autoPause) {
    autoPauseEnabled = changes.autoPause.newValue !== false;
  }
});

const AUTOPAUSE_CODE = `(() => {
  let paused = 0;
  for (const media of document.querySelectorAll("video, audio")) {
    if (!media.paused && !media.muted && media.volume > 0) {
      media.pause();
      paused++;
    }
  }
  return paused;
})();`;

async function autoPausePause(tab) {
  let paused = 0;
  if (/^https?:/.test(tab.url || "")) {
    try {
      paused = (await browser.tabs.executeScript(tab.id, { code: AUTOPAUSE_CODE, allFrames: true }))
        .reduce((sum, n) => sum + (Number(n) || 0), 0);
    } catch (e) {
      paused = 0;
    }
  }
  // Nebylo co pozastavit (Web Audio, stránka bez přístupu) → ztlumit. Po pozastavení se příznak
  // „hraje“ drží ještě pár sekund, proto se podle něj neztlumuje.
  if (!paused) {
    await browser.tabs.update(tab.id, { muted: true });
    autoPauseMuted.add(tab.id);
  }
}

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!autoPauseEnabled || changeInfo.audible !== true || !tab.active || tab.mutedInfo?.muted) {
    return;
  }
  const others = (await browser.tabs.query({ audible: true }))
    .filter(other => other.id !== tabId && !other.mutedInfo?.muted &&
      !other.sharingState?.microphone && !other.sharingState?.camera);
  for (const other of others) {
    autoPausePause(other).catch(e => console.error("Mantis – hraje jen jedna karta:", e));
  }
}, { properties: ["audible"] });

// Ztlumenou kartu po přepnutí na ni zase zesílit (pozastavenou pustí uživatel sám)
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  if (autoPauseMuted.delete(tabId)) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab?.mutedInfo?.muted && tab.mutedInfo.reason === "extension") {
      await browser.tabs.update(tabId, { muted: false });
    }
  }
});

browser.tabs.onRemoved.addListener(tabId => autoPauseMuted.delete(tabId));
