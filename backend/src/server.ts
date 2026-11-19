import express from "express";
import cors from "cors";
import importRouter from "./routes/import";
import captureRouter from "./routes/capture";
import { shutdownBrowser } from "./scraper";

const PORT = 3333;

const app = express();

// Figma plugin iframes have origin: null — accept everything since this is a personal local server.
app.use(cors({ origin: (_o, cb) => cb(null, true) }));
app.use(express.json({ limit: "50mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/", importRouter);
app.use("/", captureRouter);

const server = app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
});

async function shutdown() {
  console.log("[backend] shutting down...");
  await shutdownBrowser();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
