import { describe, expect, it } from "vitest";
import * as entry from "./index";

// A Cloudflare module Worker's entry file may export only handlers and classes.
// workerd refuses to start ("Incorrect type for map entry ...") if the entry
// also exports constants or helpers. Everything else lives in ./handler.ts.
// SpendLedger is the Durable Object class the SPEND_TRACKER binding requires.
describe("Worker entry module", () => {
  it("exports only the fetch handler and the SpendLedger class at runtime", () => {
    expect(Object.keys(entry).sort()).toEqual(["SpendLedger", "default"]);
  });

  it("has a callable fetch handler and a Durable Object class", () => {
    expect(typeof entry.default.fetch).toBe("function");
    expect(typeof entry.SpendLedger).toBe("function"); // a class
  });
});
