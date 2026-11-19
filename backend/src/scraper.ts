import puppeteer, { Browser } from "puppeteer";
import { injectionScriptSource } from "../../shared/injection-script";
import type { Layer } from "../../shared/types";

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  return browserInstance;
}

interface ScrapeResult {
  layers: Layer[];
  pageTitle: string;
  pageUrl: string;
  documentWidth: number;
  documentHeight: number;
  images: Record<string, string>;
}

export interface ScrapeOptions {
  url?: string;
  html?: string;
  viewportWidth: number;
  theme: "light" | "dark";
}

export async function scrape(opts: ScrapeOptions): Promise<ScrapeResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Capture every image response the page loads. Keyed by URL.
  const imageBytes = new Map<string, { type: string; bytes: Buffer }>();

  page.on("response", async (resp) => {
    try {
      const type = resp.headers()["content-type"] || "";
      if (!type.startsWith("image/")) return;
      const url = resp.url();
      // Skip huge images (> 8MB) — likely backgrounds we don't need full-res
      const len = parseInt(resp.headers()["content-length"] || "0");
      if (len > 8 * 1024 * 1024) return;
      const buf = await resp.buffer();
      imageBytes.set(url, { type, bytes: buf });
    } catch {
      // body might be unavailable
    }
  });

  try {
    await page.setViewport({
      width: opts.viewportWidth,
      height: 900,
      deviceScaleFactor: 1,
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: opts.theme },
    ]);

    if (opts.url) {
      await page.goto(opts.url, {
        waitUntil: "networkidle2",
        timeout: 45000,
      });
    } else if (opts.html) {
      await page.setContent(opts.html, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });
    } else {
      throw new Error("Either url or html must be provided");
    }

    // Let JS-heavy SPAs settle and lazy-loaded images appear
    await new Promise((r) => setTimeout(r, 1500));

    // Scroll the whole page to trigger lazy-loaded images
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = 400;
        const max = document.documentElement.scrollHeight;
        const iv = setInterval(() => {
          y += step;
          window.scrollTo(0, y);
          if (y >= max) {
            window.scrollTo(0, 0);
            clearInterval(iv);
            resolve();
          }
        }, 80);
      });
    });

    // Ensure fonts are ready
    await page.evaluate(async () => {
      // @ts-ignore
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });

    // Execute extraction
    const extracted = (await page.evaluate(injectionScriptSource)) as Omit<
      ScrapeResult,
      "images"
    >;

    // Build image map as base64 data URLs — only for URLs referenced in the layers
    const referencedUrls = collectImageUrls(extracted.layers);
    const images: Record<string, string> = {};
    for (const url of referencedUrls) {
      const entry = imageBytes.get(url);
      if (!entry) continue;
      images[url] = `data:${entry.type};base64,${entry.bytes.toString("base64")}`;
    }

    return { ...extracted, images };
  } finally {
    await page.close();
  }
}

function collectImageUrls(layers: Layer[]): Set<string> {
  const out = new Set<string>();
  for (const l of layers) {
    if (l.type === "IMAGE") out.add(l.imageUrl);
    if ((l.type === "FRAME" || l.type === "RECTANGLE") && (l as any).fills) {
      for (const f of (l as any).fills as any[]) {
        if (f.type === "IMAGE" && f.imageUrl) out.add(f.imageUrl);
      }
    }
  }
  return out;
}

export async function shutdownBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {}
    browserInstance = null;
  }
}
