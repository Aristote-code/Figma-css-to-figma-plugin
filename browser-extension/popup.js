/* global chrome */
const backendInput = document.getElementById("backend");
const captureBtn = document.getElementById("capture");
const statusEl = document.getElementById("status");

// Restore saved backend URL.
chrome.storage.local.get(["backend"], (res) => {
  if (res.backend) backendInput.value = res.backend;
});
backendInput.addEventListener("change", () => {
  chrome.storage.local.set({ backend: backendInput.value.trim() });
});

function setStatus(msg, kind) {
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.textContent = msg;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");
  if (tab.url && /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
    throw new Error("Can't capture browser internal pages");
  }
  return tab;
}

async function runInjection(tabId) {
  // Run the extraction in the page's MAIN world so it can see the real document.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["inject.js"],
    world: "MAIN",
  });
  if (!results || !results[0]) throw new Error("Injection returned no result");
  return results[0].result;
}

function collectImageUrls(layers) {
  const urls = new Set();
  for (const l of layers) {
    if (l.type === "IMAGE" && l.imageUrl) urls.add(l.imageUrl);
    if (l.fills) {
      for (const f of l.fills) if (f && f.type === "IMAGE" && f.imageUrl) urls.add(f.imageUrl);
    }
  }
  return [...urls];
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function fetchImageAsDataUrl(url) {
  try {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;
    const blob = await resp.blob();
    if (blob.size > 8 * 1024 * 1024) return null; // skip huge files
    return await blobToDataUrl(blob);
  } catch (e) {
    return null;
  }
}

async function downloadImages(urls, onProgress) {
  const out = {};
  let done = 0;
  const BATCH = 6;
  for (let i = 0; i < urls.length; i += BATCH) {
    const slice = urls.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(fetchImageAsDataUrl));
    slice.forEach((u, j) => {
      if (results[j]) out[u] = results[j];
      done++;
      onProgress(done, urls.length);
    });
  }
  return out;
}

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  try {
    const backend = backendInput.value.trim().replace(/\/$/, "");
    if (!backend) throw new Error("Backend URL required");

    setStatus("Extracting layers…");
    const tab = await getActiveTab();
    const extraction = await runInjection(tab.id);
    if (!extraction || !extraction.layers) throw new Error("Extraction failed");

    const urls = collectImageUrls(extraction.layers);
    setStatus(`Downloading 0/${urls.length} images…`);
    const images = await downloadImages(urls, (d, t) => {
      setStatus(`Downloading ${d}/${t} images…`);
    });

    setStatus("Sending to backend…");
    const resp = await fetch(backend + "/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageTitle: extraction.pageTitle,
        pageUrl: extraction.pageUrl,
        documentWidth: extraction.documentWidth,
        documentHeight: extraction.documentHeight,
        layers: extraction.layers,
        images,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      throw new Error(data.error || ("HTTP " + resp.status));
    }
    setStatus(
      `Sent! ${extraction.layers.length} layers, ${Object.keys(images).length} images. Open the Figma plugin → Extension tab.`,
      "success"
    );
  } catch (err) {
    console.error(err);
    setStatus(err && err.message ? err.message : String(err), "error");
  } finally {
    captureBtn.disabled = false;
  }
});
