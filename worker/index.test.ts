import { describe, expect, it } from "vitest";
import * as entry from "./index";

// A Cloudflare module Worker's entry file may export only handlers and classes.
// workerd refuses to start ("Incorrect type for map entry ...") if the entry
// also exports constants or helpers. Everything else lives in ./handler.ts.
describe("Worker entry module", () => {
  it("exports only `default` at runtime", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
  });

  it("has a callable fetch handler", () => {
    expect(typeof entry.default.fetch).toBe("function");
  });
});
