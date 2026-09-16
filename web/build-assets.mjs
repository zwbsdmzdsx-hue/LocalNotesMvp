import { copyFileSync, readFileSync } from "node:fs";

for (const asset of ["index.html", "style.css"]) {
  copyFileSync(new URL(`src/${asset}`, import.meta.url), new URL(`dist/${asset}`, import.meta.url));
}

// A stale HTML shell can make the editor render while its later event setup fails.
const html = readFileSync(new URL("dist/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("dist/main.js", import.meta.url), "utf8");
for (const match of js.matchAll(/document\.querySelector\("#([\w-]+)"\)/g)) {
  if (!html.includes(`id="${match[1]}"`)) throw new Error(`Missing editor element: #${match[1]}`);
}
console.log("Editor HTML/CSS copied and script element IDs verified.");
