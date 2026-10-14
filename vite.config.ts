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
    // WebView2 是常青 Chromium，无需语法降级；target esnext 让 vite 跳过 esbuild 的
    // renderChunk 降级环节（该环节对 >1MB 的 chunk 走「写临时文件→Go 进程读后删除」路径，
    // 在本机进程沙箱下删除被拒会报 Access is denied）
    target: "esnext",
    outDir: "dist",
    // 压缩用 terser：在 rollup 进程内运行，不经过 esbuild 服务
    minify: "terser",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
