/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_BUILD_TIME__: string;

interface ImportMetaEnv {
  readonly VITE_LAB_LOGIN_URL?: string;
  readonly VITE_LAB_HOME_URL?: string;
  readonly VITE_SUPPORT_EMAIL?: string;
  readonly VITE_LOG_LEVEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
