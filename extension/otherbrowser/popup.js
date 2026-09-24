// Okno tlačítka „Otevřít v jiném prohlížeči“ v adresním řádku (logika v ../otherbrowser.js)

const error = document.getElementById("error");

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    host = new URL(tab.url).hostname;
  } catch (e) {
    // jiná než webová adresa
  }
  document.getElementById("reason").hidden = !/(^|\.)netflix\.com$/i.test(host);

  const { browsers, preferred } = await browser.runtime.sendMessage({ otherBrowsers: true });
  const list = document.getElementById("browsers");
  document.getElementById("none").hidden = browsers.length > 0;
  for (const b of browsers) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = b.isDefault ? `${b.name} (výchozí prohlížeč)` : b.name;
    if (b.id === preferred) {
      button.className = "primary";
    }
    button.addEventListener("click", async () => {
      const reply = await browser.runtime.sendMessage({ openInOther: { url: tab.url, id: b.id } });
      if (reply?.error) {
        error.textContent = reply.error;
        error.hidden = false;
      } else {
        window.close();
      }
    });
    list.append(button);
  }
})();

document.getElementById("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});
