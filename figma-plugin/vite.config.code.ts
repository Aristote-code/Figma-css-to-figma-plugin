import { defineConfig } from "vite";
import { resolve } from "path";

// Build config for the Figma sandbox code entry (code.ts).
// Must produce a plain, standalone JS file at dist/code.js.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../shared"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    target: "es2017",
    lib: {
      entry: resolve(__dirname, "src/plugin/code.ts"),
      formats: ["iife"],
      name: "code",
      fileName: () => "code.js",
    },
    rollupOptions: {
      output: {
        // IIFE keeps it as one self-contained script
        inlineDynamicImports: true,
      },
    },
  },
});
