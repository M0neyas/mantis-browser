// Řazení stažených souborů (jako Vivaldi, Opera): obrázky, dokumenty, videa, hudba, archivy
// a programy do podsložek ve složce pro stahování. Přesun dělá experiment
// (mantisPrefs.setDownloadSorting) – rozšíření samo soubory přesouvat nesmí.
// storage.local: downloadSort (výchozí vypnuto, sync). Názvy složek podle jazyka prohlížeče.

const DOWNLOAD_GROUPS = {
  images: ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "heic", "heif", "tif", "tiff", "ico", "jxl"],
  documents: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "epub"],
  videos: ["mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv"],
  music: ["mp3", "flac", "wav", "ogg", "oga", "m4a", "aac", "opus", "wma"],
  archives: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "zst", "iso"],
  programs: ["exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "bat", "cmd", "ps1", "apk"],
};

async function downloadSortApply() {
  const { downloadSort } = await browser.storage.local.get({ downloadSort: false });
  if (!downloadSort) {
    await browser.mantisPrefs.setDownloadSorting();
    return;
  }
  const map = {};
  for (const [group, exts] of Object.entries(DOWNLOAD_GROUPS)) {
    const folder = t(`downloads_folder_${group}`);
    for (const ext of exts) {
      map[ext] = folder;
    }
  }
  await browser.mantisPrefs.setDownloadSorting(map);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.downloadSort) {
    downloadSortApply().catch(e => console.error("Mantis – řazení stažených:", e));
  }
});
downloadSortApply().catch(e => console.error("Mantis – řazení stažených:", e));
