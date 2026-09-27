/**
 * Worker entry point. A Cloudflare module Worker's entry file may export only
 * handlers and classes, so this file holds the default fetch handler and the
 * SpendLedger Durable Object class, and nothing else. All logic and every
 * named export (for tests) live in ./handler.ts and ./spendLedger.ts; see
 * those files' headers for route, CORS, retry, throttle and privacy behavior.
 * Cloudflare calls fetch(request, env, ctx); ctx flows through createHandler
 * so the meter can be charged after the response is sent.
 */
import { createHandler } from "./handler";

export { SpendLedger } from "./spendLedger";

export default {
  fetch: createHandler({
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }),
};
