// Extracts the IIFE body from shared/injection-script.ts into inject.js
// so the Chrome extension can run it via chrome.scripting.executeScript.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, "../shared/injection-script.ts");
const src = readFileSync(srcPath, "utf8");

// Pull out the string inside the top-level backticks.
const m = src.match(/injectionScriptSource\s*=\s*`([\s\S]*?)`;\s*$/m);
if (!m) {
  console.error("Could not locate template literal in injection-script.ts");
  process.exit(1);
}

// TS template string used \\( to represent \( — un-escape it for real JS.
const unescaped = m[1].replace(/\\\\/g, "\\").replace(/\\`/g, "`");

const out = `// AUTO-GENERATED from shared/injection-script.ts — do not edit by hand.
// Regenerate with:  node browser-extension/build-inject.mjs
${unescaped}
`;

writeFileSync(resolve(here, "inject.js"), out);
console.log("[build-inject] wrote inject.js (" + out.length + " bytes)");
