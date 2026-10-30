/// Vite 注入的构建常量（见 vite.config.ts）
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
