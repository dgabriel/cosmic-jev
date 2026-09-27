import { defineConfig } from "vitest/config";

/** File path for a sibling of this config, without needing @types/node. */
function here(rel: string): string {
  return decodeURIComponent(new URL(rel, import.meta.url).pathname);
}

/**
 * The app is two static pages: index.html (the oracle) and admin.html (the
 * unauthenticated spend ledger that reads GET /api/admin/spend on the Worker).
 * admin.html is deliberately not linked from index.html.
 *
 * Deployed as a GitHub Pages project site, so production builds serve from
 * /cosmic-jev/; dev keeps the root base.
 */
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/cosmic-jev/" : "/",
  build: {
    rollupOptions: {
      input: {
        main: here("./index.html"),
        admin: here("./admin.html"),
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts", "worker/**/*.test.ts"],
  },
}));
