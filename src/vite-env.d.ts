/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which oracle implementation to use: "stub" (default) or "jev". */
  readonly VITE_ORACLE?: string;
  /**
   * Base URL of the deployed Cloudflare Worker proxy (oracle-3em), e.g.
   * https://cosmic-oracle-worker.cosmic-oracle.workers.dev. Non-secret;
   * required only when VITE_ORACLE=jev.
   */
  readonly VITE_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
