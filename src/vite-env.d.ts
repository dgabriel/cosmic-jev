/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which oracle implementation to use: "stub" (default) or "jev". */
  readonly VITE_ORACLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
