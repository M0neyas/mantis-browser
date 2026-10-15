// YouTube (www. a m.youtube.com, ne YouTube Music): výchozí rychlost přehrávání a skrytí Shorts.
// storage.local: ytSpeed (1 = beze změny), ytHideShorts (false). Rychlost se nastaví jednou na začátku
// každého videa – když ji uživatel během videa změní v přehrávači, Mantis do toho nesahá.
// Skrytí Shorts dělá youtube.css podle atributu data-mantis-no-shorts na <html>.

let ytSpeed = 1;

function ytApply(values) {
  if ("ytSpeed" in values) {
    ytSpeed = Number(values.ytSpeed) || 1;
  }
  if ("ytHideShorts" in values) {
    document.documentElement.toggleAttribute("data-mantis-no-shorts", values.ytHideShorts === true);
  }
}

browser.storage.local.get({ ytSpeed: 1, ytHideShorts: false }).then(ytApply);
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.ytSpeed || changes.ytHideShorts)) {
    ytApply(Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])));
  }
});

// Nové video = nový zdroj přehrávače. YouTube po načtení někdy vrátí svou uloženou rychlost,
// proto se to zkusí ještě při prvním „playing“ téhož zdroje.
function ytSetSpeed(event) {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement) || ytSpeed === 1) {
    return;
  }
  const src = video.currentSrc || video.src;
  if (event.type === "loadedmetadata") {
    video.dataset.mantisSpeedSrc = src;
    video.dataset.mantisSpeedTries = "2";
  }
  if (video.dataset.mantisSpeedSrc !== src || video.dataset.mantisSpeedTries === "0") {
    return;
  }
  video.dataset.mantisSpeedTries = String(Number(video.dataset.mantisSpeedTries) - 1);
  if (video.playbackRate === 1) {
    video.playbackRate = ytSpeed;
  }
}

document.addEventListener("loadedmetadata", ytSetSpeed, true);
document.addEventListener("playing", ytSetSpeed, true);
