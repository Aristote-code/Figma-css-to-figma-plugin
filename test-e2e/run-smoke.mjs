import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  uniqueIds,
  parentRefsResolve,
  noOrphanCycles,
  geometryFinite,
  styleRunsWellFormed,
  noSkippedTags,
  autoLayoutSanity,
  textNotFragmented,
  imageCoverage,
  pseudoMaterialized,
  hiddenContentExcluded,
  counts,
} from "./validators.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const BACKEND = "http://localhost:3333";

// ---- utils ----

function log(s) { process.stdout.write(s + "\n"); }
function fmt(ok) { return ok ? "\u2713" : "\u2717"; }

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BACKEND + "/health");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("backend never became healthy");
}

async function hitImport(body) {
  const r = await fetch(BACKEND + "/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.success) {
    throw new Error("import failed: " + (j.error || r.status));
  }
  return j;
}

function runChecks(checks, scenarioName) {
  let allPassed = true;
  for (const c of checks) {
    const symbol = fmt(c.ok);
    const extra = c.detail ? `  ${c.detail}` : "";
    log(`  ${symbol} ${c.name}${extra}`);
    if (!c.ok) allPassed = false;
  }
  return allPassed;
}

// ---- scenarios ----

async function scenarioSimpleHtml() {
  log("\nSCENARIO 1  simple.html (mode: html)");
  const html = readFileSync(resolve(here, "fixtures/simple.html"), "utf8");
  const resp = await hitImport({ mode: "html", html, viewportWidth: 1280, theme: "light" });
  const { layers, images = {} } = resp;
  const c = counts(layers);
  log(`  layers: ${layers.length}   text: ${c.TEXT||0}   frames: ${c.FRAME||0}   images: ${c.IMAGE||0}   svgs: ${c.SVG||0}`);

  const checks = [
    uniqueIds(layers),
    parentRefsResolve(layers),
    noOrphanCycles(layers),
    geometryFinite(layers),
    styleRunsWellFormed(layers),
    noSkippedTags(layers),
    autoLayoutSanity(layers),
    textNotFragmented(layers, { minChars: 2, label: "simple" }),
    pseudoMaterialized(layers),
    hiddenContentExcluded(layers),
    imageCoverage(layers, images),
  ];
  return runChecks(checks, "simple.html");
}

async function scenarioExampleCom() {
  log("\nSCENARIO 2  https://example.com (mode: url)");
  const resp = await hitImport({ mode: "url", url: "https://example.com", viewportWidth: 1280, theme: "light" });
  const { layers, images = {} } = resp;
  const c = counts(layers);
  log(`  layers: ${layers.length}   text: ${c.TEXT||0}   frames: ${c.FRAME||0}   images: ${c.IMAGE||0}   svgs: ${c.SVG||0}`);

  const checks = [
    uniqueIds(layers),
    parentRefsResolve(layers),
    noOrphanCycles(layers),
    geometryFinite(layers),
    styleRunsWellFormed(layers),
    noSkippedTags(layers),
    autoLayoutSanity(layers),
    // example.com: "Example Domain" + one paragraph + "More information..." link = ~3 text layers
    textNotFragmented(layers, { minChars: 2, maxTextLayers: 8, label: "example.com" }),
    imageCoverage(layers, images),
  ];
  return runChecks(checks, "example.com");
}

async function scenarioRepeatedCapture() {
  log("\nSCENARIO 3  repeated capture — pseudo-element cleanup leak check");
  const html = readFileSync(resolve(here, "fixtures/simple.html"), "utf8");
  const r1 = await hitImport({ mode: "html", html, viewportWidth: 1280, theme: "light" });
  const r2 = await hitImport({ mode: "html", html, viewportWidth: 1280, theme: "light" });
  const delta = Math.abs(r1.layers.length - r2.layers.length);
  const pct = delta / r1.layers.length;
  const ok = pct < 0.05;
  log(`  run 1: ${r1.layers.length} layers   run 2: ${r2.layers.length} layers   delta: ${delta} (${(pct * 100).toFixed(1)}%)`);
  log(`  ${fmt(ok)} pseudo-element cleanup is idempotent`);
  return ok;
}

async function scenarioStripe() {
  log("\nSCENARIO 4  https://stripe.com (warnings only, not a failing gate)");
  try {
    const resp = await hitImport({ mode: "url", url: "https://stripe.com", viewportWidth: 1280, theme: "light" });
    const { layers, images = {} } = resp;
    const c = counts(layers);
    log(`  layers: ${layers.length}   text: ${c.TEXT||0}   frames: ${c.FRAME||0}   images: ${c.IMAGE||0}   svgs: ${c.SVG||0}`);
    const checks = [
      uniqueIds(layers),
      parentRefsResolve(layers),
      noOrphanCycles(layers),
      geometryFinite(layers),
      styleRunsWellFormed(layers),
      autoLayoutSanity(layers),
      imageCoverage(layers, images),
    ];
    for (const c of checks) log(`  ${fmt(c.ok)} ${c.name}${c.detail ? "  " + c.detail : ""}`);
    // always return true — informational scenario
    return true;
  } catch (err) {
    log(`  (skipped: ${err.message})`);
    return true;
  }
}

// ---- main ----

async function main() {
  const backendCmd = "npm";
  const backendArgs = ["run", "dev", "--workspace=backend"];
  log(`Starting backend: ${backendCmd} ${backendArgs.join(" ")}`);
  const child = spawn(backendCmd, backendArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });

  let results = [];
  try {
    await waitForHealth();
    log("Backend healthy.");

    results.push(await scenarioSimpleHtml());
    results.push(await scenarioExampleCom());
    results.push(await scenarioRepeatedCapture());
    results.push(await scenarioStripe());
  } catch (err) {
    log("\nFATAL: " + err.message);
    results.push(false);
  } finally {
    log("\nShutting down backend…");
    try { child.kill("SIGTERM"); } catch {}
    // Wait briefly for it to stop
    await new Promise((r) => setTimeout(r, 500));
    try { child.kill("SIGKILL"); } catch {}
  }

  const passed = results.every(Boolean);
  log("\n" + (passed ? "ALL GREEN" : "FAILURES present — see above"));
  process.exit(passed ? 0 : 1);
}

main();
