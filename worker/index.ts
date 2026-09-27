/**
 * Worker entry point. A Cloudflare module Worker's entry file may export only
 * handlers and classes, so this file has a default export and nothing else.
 * All logic and every named export (for tests) live in ./handler.ts. See that
 * file's header for the route, CORS, retry and privacy behavior.
 */
import { createHandler } from "./handler";

export default {
  fetch: createHandler({
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }),
};
