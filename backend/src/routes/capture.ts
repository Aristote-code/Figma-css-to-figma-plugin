import { Router } from "express";
import type { Layer } from "../../../shared/types";

/**
 * Extension capture storage.
 * The Chrome extension POSTs captures here; the Figma plugin GETs the most recent one.
 * In-memory, personal-use only.
 */

interface StoredCapture {
  id: string;
  capturedAt: number;
  pageTitle: string;
  pageUrl: string;
  documentWidth: number;
  documentHeight: number;
  layers: Layer[];
  images: Record<string, string>; // url → data URL
}

const captures: StoredCapture[] = [];
const MAX_STORED = 10;

const router = Router();

router.post("/capture", (req, res) => {
  try {
    const body = req.body as Partial<StoredCapture>;
    if (!body || !Array.isArray(body.layers)) {
      res.status(400).json({ success: false, error: "Missing layers" });
      return;
    }
    const entry: StoredCapture = {
      id: "cap_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      capturedAt: Date.now(),
      pageTitle: body.pageTitle || "Captured Page",
      pageUrl: body.pageUrl || "",
      documentWidth: body.documentWidth || 1280,
      documentHeight: body.documentHeight || 900,
      layers: body.layers,
      images: body.images || {},
    };
    captures.unshift(entry);
    if (captures.length > MAX_STORED) captures.length = MAX_STORED;
    console.log(
      `[backend] Capture received: "${entry.pageTitle}" (${entry.layers.length} layers, ${
        Object.keys(entry.images).length
      } images)`
    );
    res.json({ success: true, id: entry.id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

router.get("/capture/latest", (_req, res) => {
  if (captures.length === 0) {
    res.status(404).json({ success: false, error: "No captures yet" });
    return;
  }
  const c = captures[0];
  res.json({
    success: true,
    capture: c,
  });
});

router.get("/capture/list", (_req, res) => {
  res.json({
    success: true,
    captures: captures.map((c) => ({
      id: c.id,
      capturedAt: c.capturedAt,
      pageTitle: c.pageTitle,
      pageUrl: c.pageUrl,
      layerCount: c.layers.length,
    })),
  });
});

export default router;
