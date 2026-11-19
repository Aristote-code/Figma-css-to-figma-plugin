import React, { useState } from "react";
import type {
  ImportRequest,
  ImportResponse,
  Layer,
  UIToPluginMessage,
} from "../../../shared/types";

const BACKEND_URL = "http://localhost:3333";

type Mode = "url" | "html" | "extension";

const VIEWPORTS = [
  { label: "Mobile 390", value: 390 },
  { label: "Tablet 768", value: 768 },
  { label: "Desktop 1280", value: 1280 },
  { label: "Wide 1440", value: 1440 },
];

export function App() {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("https://example.com");
  const [html, setHtml] = useState(
    `<div style="background:#4f46e5;padding:40px;color:white;font-family:sans-serif;border-radius:12px">
  <h1 style="margin:0 0 12px;font-size:32px">Hello Figma</h1>
  <p style="margin:0;font-size:16px;opacity:.9">Imported from HTML</p>
</div>`
  );
  const [viewport, setViewport] = useState(1280);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [status, setStatus] = useState<string>("Ready.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLoadExtensionCapture() {
    setError(null);
    setBusy(true);
    try {
      setStatus("Fetching latest capture from backend...");
      const resp = await fetch(`${BACKEND_URL}/capture/latest`).catch(() => {
        throw new Error("Could not reach backend on :3333. Is it running?");
      });
      if (!resp.ok) {
        if (resp.status === 404) {
          throw new Error("No captures yet. Click the extension icon in Chrome first.");
        }
        throw new Error("HTTP " + resp.status);
      }
      const data = await resp.json();
      if (!data.success || !data.capture) throw new Error("No capture");
      const cap = data.capture;

      setStatus(`Capture "${cap.pageTitle}" — processing images...`);
      const imageMap = await processImages(
        cap.layers,
        cap.images || {},
        (done, total) => setStatus(`Processing images (${done}/${total})...`)
      );

      setStatus("Building Figma layers...");
      const msg: UIToPluginMessage = {
        type: "CREATE_DESIGN",
        layers: cap.layers,
        imageMap,
        pageTitle: cap.pageTitle || "Captured Page",
      };
      parent.postMessage({ pluginMessage: msg }, "*");
    } catch (err: any) {
      setError(err.message || String(err));
      setStatus("Failed.");
      setBusy(false);
    }
  }

  async function handleImport() {
    if (mode === "extension") return handleLoadExtensionCapture();
    setError(null);
    setBusy(true);
    try {
      setStatus("Connecting to local backend...");
      const payload: ImportRequest = {
        mode,
        url: mode === "url" ? url : undefined,
        html: mode === "html" ? html : undefined,
        viewportWidth: viewport,
        theme,
      };

      const resp = await fetch(`${BACKEND_URL}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch((err) => {
        throw new Error(
          "Could not reach backend on :3333. Is the backend server running?"
        );
      });

      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as ImportResponse;
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as ImportResponse;
      if (!data.success || !data.layers) {
        throw new Error(data.error || "No layers returned");
      }

      setStatus(`Fetched ${data.layers.length} layers. Processing images...`);

      // Prefer backend-captured images (no CORS), fall back to UI fetch.
      const imageMap = await processImages(
        data.layers,
        data.images || {},
        (done, total) => setStatus(`Processing images (${done}/${total})...`)
      );

      setStatus("Building Figma layers...");

      const msg: UIToPluginMessage = {
        type: "CREATE_DESIGN",
        layers: data.layers,
        imageMap,
        pageTitle: data.pageTitle || "Imported Page",
      };
      parent.postMessage({ pluginMessage: msg }, "*");
    } catch (err: any) {
      setError(err.message || String(err));
      setStatus("Failed.");
    } finally {
      setBusy(false);
    }
  }

  // Listen for messages from the Figma sandbox
  React.useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data.pluginMessage;
      if (!msg) return;
      if (msg.type === "PROGRESS") {
        setStatus(msg.step);
      } else if (msg.type === "DONE") {
        setStatus("Done! Layers created in Figma.");
        setBusy(false);
      } else if (msg.type === "ERROR") {
        setError(msg.error);
        setStatus("Failed in sandbox.");
        setBusy(false);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>HTML → Figma</div>
        <div style={styles.subtitle}>Personal import plugin</div>
      </div>

      {/* Mode tabs */}
      <div style={styles.tabRow}>
        <button
          style={{ ...styles.tab, ...(mode === "url" ? styles.tabActive : {}) }}
          onClick={() => setMode("url")}
        >
          URL
        </button>
        <button
          style={{ ...styles.tab, ...(mode === "html" ? styles.tabActive : {}) }}
          onClick={() => setMode("html")}
        >
          HTML
        </button>
        <button
          style={{ ...styles.tab, ...(mode === "extension" ? styles.tabActive : {}) }}
          onClick={() => setMode("extension")}
        >
          Extension
        </button>
      </div>

      <div style={styles.section}>
        {mode === "url" && (
          <>
            <label style={styles.label}>URL to import</label>
            <input
              style={styles.input}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
            />
          </>
        )}
        {mode === "html" && (
          <>
            <label style={styles.label}>HTML source</label>
            <textarea
              style={{ ...styles.input, height: 140, fontFamily: "monospace", fontSize: 11 }}
              value={html}
              onChange={(e) => setHtml(e.target.value)}
            />
          </>
        )}
        {mode === "extension" && (
          <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.5 }}>
            <p style={{ margin: "0 0 6px" }}>
              Capture login-protected pages using your browser session.
            </p>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>Load <code>browser-extension/</code> in chrome://extensions (Developer mode → Load unpacked).</li>
              <li>Open any page in your browser, click the extension icon, press <b>Capture</b>.</li>
              <li>Press <b>Import latest capture</b> below.</li>
            </ol>
          </div>
        )}
      </div>

      {mode !== "extension" && <div style={styles.section}>
        <label style={styles.label}>Viewport width</label>
        <div style={styles.row}>
          {VIEWPORTS.map((v) => (
            <button
              key={v.value}
              style={{
                ...styles.chip,
                ...(viewport === v.value ? styles.chipActive : {}),
              }}
              onClick={() => setViewport(v.value)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>}

      {mode !== "extension" && <div style={styles.section}>
        <label style={styles.label}>Theme</label>
        <div style={styles.row}>
          {(["light", "dark"] as const).map((t) => (
            <button
              key={t}
              style={{ ...styles.chip, ...(theme === t ? styles.chipActive : {}) }}
              onClick={() => setTheme(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>}

      <button style={styles.importBtn} disabled={busy} onClick={handleImport}>
        {busy
          ? "Importing..."
          : mode === "extension"
          ? "Import latest capture"
          : "Import"}
      </button>

      <div style={styles.status}>
        {error ? (
          <span style={{ color: "#e11d48" }}>{error}</span>
        ) : (
          status
        )}
      </div>
    </div>
  );
}

async function processImages(
  layers: Layer[],
  backendImages: Record<string, string>,
  onProgress: (done: number, total: number) => void
): Promise<Record<string, number[]>> {
  const urls = new Set<string>();
  for (const l of layers) {
    if (l.type === "IMAGE") urls.add(l.imageUrl);
    if ((l.type === "FRAME" || l.type === "RECTANGLE") && (l as any).fills) {
      for (const f of (l as any).fills as any[]) {
        if (f.type === "IMAGE" && f.imageUrl) urls.add(f.imageUrl);
      }
    }
  }
  const map: Record<string, number[]> = {};
  const list = [...urls];
  let done = 0;

  for (const url of list) {
    try {
      let bytes: Uint8Array | null = null;
      // First try backend-captured base64 (no CORS)
      const dataUrl = backendImages[url];
      if (dataUrl) {
        bytes = await processDataUrl(dataUrl);
      }
      // Fallback: try fetching from UI (works for same-origin / CORS-enabled)
      if (!bytes) {
        bytes = await fetchAndConvertImage(url);
      }
      if (bytes) map[url] = Array.from(bytes);
    } catch {}
    done++;
    onProgress(done, list.length);
  }
  return map;
}

async function processDataUrl(dataUrl: string): Promise<Uint8Array | null> {
  try {
    // Extract mime and bytes from data URL
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1];
    const base64 = m[2];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Figma accepts PNG/JPEG/GIF natively
    if (/^image\/(png|jpeg|jpg|gif)$/.test(mime)) return bytes;
    // Convert everything else (WebP/AVIF/SVG) via canvas
    const blob = new Blob([bytes], { type: mime });
    return await convertToPng(blob);
  } catch {
    return null;
  }
}

async function fetchAndConvertImage(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url, { mode: "cors" });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const type = blob.type || "";
    if (/^image\/(png|jpeg|jpg|gif)$/.test(type)) {
      return new Uint8Array(await blob.arrayBuffer());
    }
    return await convertToPng(blob);
  } catch {
    return null;
  }
}

async function convertToPng(blob: Blob): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const newBlob: Blob | null = await new Promise((res) =>
      canvas.toBlob((b) => res(b), "image/png")
    );
    if (!newBlob) return null;
    return new Uint8Array(await newBlob.arrayBuffer());
  } catch {
    return null;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    height: "100%",
    overflow: "auto",
  },
  header: { marginBottom: 4 },
  title: { fontWeight: 600, fontSize: 14 },
  subtitle: { color: "#6b7280", fontSize: 11, marginTop: 2 },
  tabRow: { display: "flex", gap: 4, borderBottom: "1px solid #e5e7eb" },
  tab: {
    flex: 1,
    padding: "8px 0",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 500,
    color: "#6b7280",
  },
  tabActive: { color: "#1a1a1a", borderBottom: "2px solid #1a1a1a" },
  section: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontWeight: 500, fontSize: 11, color: "#374151" },
  input: {
    padding: "8px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: 12,
    outline: "none",
    fontFamily: "inherit",
    width: "100%",
  },
  row: { display: "flex", flexWrap: "wrap", gap: 4 },
  chip: {
    padding: "6px 10px",
    fontSize: 11,
    border: "1px solid #d1d5db",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
  },
  chipActive: {
    borderColor: "#1a1a1a",
    background: "#1a1a1a",
    color: "#fff",
  },
  importBtn: {
    padding: "10px 14px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  status: { fontSize: 11, color: "#6b7280", minHeight: 16 },
};
