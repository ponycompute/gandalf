import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    // electron-vite builds main as SSR, and Vite drops a top-level resolve.conditions for SSR.
    ssr: { resolve: { conditions: ["source"] } },
    build: { externalizeDeps: { exclude: ["@gandalf/skills"] } },
  },
  preload: {
    // A sandboxed preload must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // The page's CSP allows images from 'self' only, so assets stay files instead of data: URLs.
    build: { assetsInlineLimit: 0 },
  },
});
