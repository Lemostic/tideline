import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
});
