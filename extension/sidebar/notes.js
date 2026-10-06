// Poznámky v bočním panelu (jako Vivaldi, Edge): seznam poznámek a editor, ukládá se
// průběžně. Označený text + pravý klik → „Přidat do poznámek“ (../messengers.js) založí
// poznámku s odkazem na stránku. storage.local (jen tento počítač – storage.sync unese
// jen 8 kB na položku): notes [{ id, text, url?, title?, created, updated }].
/* global t, uiLocale */

const NOTES_MAX = 500;
const NOTE_MAX_CHARS = 20000;

async function notesLoad() {
  const { notes } = await browser.storage.local.get({ notes: [] });
  return Array.isArray(notes) ? notes : [];
}

function notesSave(notes) {
  return browser.storage.local.set({ notes: notes.slice(0, NOTES_MAX) });
}

function noteTitle(note) {
  const first = (note.text || "").split("\n").find(line => line.trim()) || "";
  return first.trim().slice(0, 80) || t("notes_untitled");
}

function noteDate(ms) {
  return new Date(ms).toLocaleString(uiLocale(), { dateStyle: "medium", timeStyle: "short" });
}

function createNotesView() {
  const view = document.createElement("section");
  view.className = "notes";
  let editing = null; // ID otevřené poznámky
  let saveTimer = null;

  const header = document.createElement("header");
  const heading = document.createElement("b");
  heading.textContent = t("notes_title");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "notes-button";
  add.textContent = t("notes_new");
  header.append(heading, add);

  const list = document.createElement("ol");
  list.className = "notes-list";

  const editor = document.createElement("div");
  editor.className = "notes-editor";
  editor.hidden = true;
  const bar = document.createElement("div");
  bar.className = "notes-bar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "notes-button";
  back.textContent = t("notes_back");
  const source = document.createElement("a");
  source.className = "notes-source";
  source.target = "_blank";
  source.rel = "noopener";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "notes-button danger";
  remove.textContent = t("notes_delete");
  bar.append(back, source, remove);
  const area = document.createElement("textarea");
  area.maxLength = NOTE_MAX_CHARS;
  area.setAttribute("aria-label", t("notes_title"));
  area.placeholder = t("notes_placeholder");
  editor.append(bar, area);

  const empty = document.createElement("p");
  empty.className = "notes-empty";
  empty.textContent = t("notes_empty");

  view.append(header, list, empty, editor);

  async function showList() {
    editing = null;
    editor.hidden = true;
    list.hidden = false;
    header.hidden = false;
    const notes = await notesLoad();
    empty.hidden = notes.length > 0;
    list.replaceChildren(...notes.map(note => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const title = document.createElement("span");
      title.className = "note-title";
      title.textContent = noteTitle(note);
      const meta = document.createElement("span");
      meta.className = "note-meta";
      meta.textContent = [noteDate(note.updated || note.created), note.title].filter(Boolean).join(" · ");
      button.append(title, meta);
      button.addEventListener("click", () => openNote(note.id));
      item.append(button);
      return item;
    }));
  }

  async function openNote(id) {
    const note = (await notesLoad()).find(n => n.id === id);
    if (!note) {
      showList();
      return;
    }
    editing = id;
    header.hidden = true;
    list.hidden = true;
    empty.hidden = true;
    editor.hidden = false;
    area.value = note.text || "";
    const safe = /^https?:\/\//.test(note.url || "");
    source.hidden = !safe;
    if (safe) {
      source.href = note.url;
      source.textContent = note.title || new URL(note.url).hostname;
      source.title = note.url;
    }
    area.focus();
  }

  async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!editing) {
      return;
    }
    const notes = await notesLoad();
    const note = notes.find(n => n.id === editing);
    if (note && note.text !== area.value) {
      note.text = area.value;
      note.updated = Date.now();
      // naposledy upravená nahoru
      await notesSave([note, ...notes.filter(n => n !== note)]);
    }
  }

  area.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  });
  area.addEventListener("blur", flush);
  addEventListener("pagehide", flush);

  add.addEventListener("click", async () => {
    const now = Date.now();
    const note = { id: Math.random().toString(36).slice(2, 10), text: "", created: now, updated: now };
    await notesSave([note, ...(await notesLoad())]);
    openNote(note.id);
  });
  back.addEventListener("click", async () => {
    await flush();
    // prázdnou poznámku po návratu zahodit
    const notes = await notesLoad();
    const note = notes.find(n => n.id === editing);
    if (note && !note.text.trim()) {
      await notesSave(notes.filter(n => n !== note));
    }
    showList();
  });
  remove.addEventListener("click", async () => {
    const id = editing;
    editing = null;
    await notesSave((await notesLoad()).filter(n => n.id !== id));
    showList();
  });

  // nová poznámka z kontextové nabídky (jiná část rozšíření) → seznam obnovit / otevřít ji
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.notes || editing) {
      return;
    }
    const before = new Set((changes.notes.oldValue || []).map(n => n.id));
    const added = (changes.notes.newValue || []).find(n => !before.has(n.id) && n.text);
    if (added) {
      openNote(added.id);
    } else {
      showList();
    }
  });

  showList();
  return view;
}
