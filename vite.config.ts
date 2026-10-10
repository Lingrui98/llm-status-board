/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // WebView2 (Chromium) 目标
    target: "chrome105",
    outDir: "dist",
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
