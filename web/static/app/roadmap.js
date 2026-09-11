/* REKT · the roadmap page: chrome only. The list itself is rendered by the API into {{content}}. */

import { $, initChrome } from "./common.js";

initChrome();

const box = $("#roadmap");
if (box && /^\s*\{\{content\}\}\s*$/.test(box.textContent)) {
  box.innerHTML = "";
  const p = document.createElement("p");
  p.className = "roadmap-fallback";
  p.textContent = "The roadmap is rendered by the API from ROADMAP.md. On a plain file server this list stays empty.";
  box.append(p);
}
