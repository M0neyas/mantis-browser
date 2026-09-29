#!/usr/bin/env node
// Kontrola překladů rozšíření Mantis (extension/_locales). Spouští se z kořene repozitáře:
//   node scripts/check-i18n.js
// Hlídá: stejné klíče ve všech jazycích, stejné zástupce ($1…) a značky (<b>…) v překladech,
// klíče použité v kódu existují (HTML data-i18n*, JS řetězce, manifest __MSG__, kódy chyb
// VPN pomocníka), nepoužité klíče, a české texty, které zůstaly napevno v kódu.
"use strict";
const fs = require("fs");
const path = require("path");

const EXT = "extension";
const LOCALES = fs.readdirSync(path.join(EXT, "_locales"));
const problems = [];
const bad = msg => problems.push(msg);

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name).split(path.sep).join("/")]);
const files = walk(EXT).filter(f => /\.(js|html|json)$/.test(f) && !f.includes("/_locales/"));

// ---------- Překlady ----------

const messages = {};
for (const locale of LOCALES) {
  messages[locale] = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", locale, "messages.json"), "utf8"));
}
const [base, ...others] = LOCALES;
const keys = Object.keys(messages[base]);

const lower = new Map();
for (const key of keys) {
  if (lower.has(key.toLowerCase())) {
    bad(`klíče ${key} a ${lower.get(key.toLowerCase())} se liší jen velikostí písmen (Firefox je nerozliší)`);
  }
  lower.set(key.toLowerCase(), key);
  if (!/^\w+$/.test(key)) {
    bad(`klíč ${key}: jen písmena, číslice a _`);
  }
}

const placeholders = text => [...new Set(text.match(/\$\d/g) || [])].sort().join(",");
const tags = text => (text.match(/<\/?[a-z]+/gi) || []).map(t => t.toLowerCase()).sort().join(",");
for (const locale of others) {
  const theirs = Object.keys(messages[locale]);
  for (const key of keys.filter(k => !theirs.includes(k))) bad(`${locale}: chybí ${key}`);
  for (const key of theirs.filter(k => !keys.includes(k))) bad(`${locale}: navíc ${key} (není v ${base})`);
  for (const key of keys.filter(k => theirs.includes(k))) {
    const a = messages[base][key].message;
    const b = messages[locale][key].message;
    if (placeholders(a) !== placeholders(b)) bad(`${key}: zástupci ${base} [${placeholders(a)}] × ${locale} [${placeholders(b)}]`);
    if (tags(a) !== tags(b)) bad(`${key}: značky ${base} [${tags(a)}] × ${locale} [${tags(b)}]`);
  }
}
for (const locale of LOCALES) {
  for (const [key, { message }] of Object.entries(messages[locale])) {
    for (const tag of message.match(/<\/?([a-z]+)/gi) || []) {
      if (!/^<\/?(b|i|code|br|a)$/i.test(tag)) bad(`${locale} ${key}: nepovolená značka ${tag} (i18n.js ji zahodí)`);
    }
    if (/\$(?!\d|\$)/.test(message)) bad(`${locale} ${key}: samotné $ – napsat $$`);
  }
}

// ---------- Použití v kódu ----------

const used = new Set();
const prefixes = new Set();
const KEY_LIKE = /^(common|update|err|forget|sensitive|doh|other|vpn|vpnErr|newtab|welcome|settings|tools|printEdit|eshop|currency)_\w+$/;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  if (file.endsWith(".html")) {
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  }
  if (file.endsWith(".js")) {
    for (const m of src.matchAll(/["'`]([A-Za-z]\w*)["'`]/g)) {
      if (KEY_LIKE.test(m[1]) || keys.includes(m[1])) used.add(m[1]);
    }
    for (const m of src.matchAll(/`(\w+_)\$\{/g)) prefixes.add(m[1]);
  }
  for (const m of src.matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
}
// Kódy chyb VPN pomocníka (Go) → vpnErr_<kód>
for (const m of fs.readFileSync("vpn/host/main.go", "utf8").matchAll(/fail\("(\w+)"/g)) used.add(`vpnErr_${m[1]}`);
used.add("vpnErr_io"); // chyby bez kódu (soubory, registr)

for (const key of used) {
  if (!keys.includes(key)) bad(`v kódu použitý klíč ${key} chybí v překladech`);
}
for (const prefix of prefixes) {
  if (!keys.some(k => k.startsWith(prefix))) bad(`v kódu skládaný klíč ${prefix}… nemá žádný překlad`);
}
const unused = keys.filter(k => !used.has(k) && ![...prefixes].some(p => k.startsWith(p)));
for (const key of unused) console.log(`info nepoužitý klíč ${key}`);

// ---------- Čeština napevno v kódu (mimo komentáře) ----------
// Řádek s komentářem „i18n-ignore“ se přeskočí (data, ne text pro uživatele – např. „Kč“).

const CZECH = /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;
for (const file of files.filter(f => /\.(js|html)$/.test(f))) {
  let src = fs.readFileSync(file, "utf8");
  src = src.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  src.split("\n").forEach((line, i) => {
    if (line.includes("i18n-ignore")) {
      return;
    }
    const code = line.replace(/(^|\s)\/\/.*$/, "");
    if (CZECH.test(code) && !/console\.(error|warn|log)\(/.test(code)) {
      bad(`${file}:${i + 1}: český text napevno: ${code.trim().slice(0, 90)}`);
    }
  });
}

console.log(`${LOCALES.join(" + ")}: ${keys.length} klíčů, v kódu ${used.size} + skládané ${[...prefixes].join(", ") || "–"}`);
console.log(problems.length ? `\n${problems.map(p => "CHYBA " + p).join("\n")}\n\n!!! ${problems.length} problémů` : "Překlady v pořádku");
process.exit(problems.length ? 1 : 0);
