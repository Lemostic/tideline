import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 相对路径产物，便于 Tauri 以自定义协议加载
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      // 开发辅助目录 / Rust 构建产物 / 编辑器原子写入的临时文件不参与热更新，
      // 避免 Chrome profile、target 目录锁文件、临时目录导致 watcher EBUSY 崩溃
      ignored: [
        '**/.verify/**',
        '**/src-tauri/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/.*.tmpdir/**',
        '**/*.tmp',
      ],
    },
  },
  build: {
    target: 'chrome110',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    server: {
      deps: {
        // exceljs 是体量很大的 CJS 包：走 vite 的 SSR 转换要把整棵依赖树逐个转换，
        // 单次 import 要十几秒，测试直接撞上默认 5s 超时。交给 Node 原生加载即可。
        external: [/exceljs/],
      },
    },
  },
});
