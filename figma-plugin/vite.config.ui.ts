import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "path";

export default defineConfig({
  root: "src/ui",
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../shared"),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    assetsInlineLimit: Infinity,
    chunkSizeWarningLimit: 10000,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/index.html"),
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
