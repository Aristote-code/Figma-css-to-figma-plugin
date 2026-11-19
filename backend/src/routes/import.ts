import { Router } from "express";
import { z } from "zod";
import { scrape } from "../scraper";
import type { ImportResponse } from "../../../shared/types";

const router = Router();

const ImportSchema = z.object({
  mode: z.enum(["url", "html"]),
  url: z.string().url().optional(),
  html: z.string().optional(),
  viewportWidth: z.number().int().min(320).max(3840).default(1280),
  theme: z.enum(["light", "dark"]).default("light"),
});

router.post("/import", async (req, res) => {
  const parse = ImportSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      success: false,
      error: "Invalid request: " + parse.error.message,
    } satisfies ImportResponse);
    return;
  }

  const body = parse.data;

  if (body.mode === "url" && !body.url) {
    res.status(400).json({ success: false, error: "url is required for mode=url" });
    return;
  }
  if (body.mode === "html" && !body.html) {
    res.status(400).json({ success: false, error: "html is required for mode=html" });
    return;
  }

  try {
    const result = await scrape({
      url: body.mode === "url" ? body.url : undefined,
      html: body.mode === "html" ? body.html : undefined,
      viewportWidth: body.viewportWidth,
      theme: body.theme,
    });
    const response: ImportResponse = {
      success: true,
      layers: result.layers,
      pageTitle: result.pageTitle,
      pageUrl: result.pageUrl,
      documentWidth: result.documentWidth,
      documentHeight: result.documentHeight,
      images: result.images,
    };
    res.json(response);
  } catch (err: any) {
    console.error("Import failed:", err);
    res.status(500).json({
      success: false,
      error: err?.message || "Unknown error",
    } satisfies ImportResponse);
  }
});

export default router;
