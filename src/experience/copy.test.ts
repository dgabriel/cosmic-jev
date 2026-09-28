import { describe, expect, it } from "vitest";
import { headlineFor, thumbDirectionFor } from "./copy";

describe("thumbDirectionFor", () => {
  it("is up when Firmly favored", () => {
    expect(thumbDirectionFor(0.9)).toBe("up");
  });

  it("is down when Firmly disfavored", () => {
    expect(thumbDirectionFor(0.1)).toBe("down");
  });

  it("is sideways when Tentatively favored", () => {
    expect(thumbDirectionFor(0.55)).toBe("sideways");
  });

  it("is sideways when Tentatively disfavored", () => {
    expect(thumbDirectionFor(0.45)).toBe("sideways");
  });
});

describe("headlineFor", () => {
  it("is 'Do it, lady!' when Firmly favored", () => {
    expect(headlineFor(0.9)).toBe("Do it, lady!");
  });

  it("is 'Girl, NO' when Firmly disfavored", () => {
    expect(headlineFor(0.1)).toBe("Girl, NO");
  });

  it("is 'Hmmm yah' when Tentatively favored", () => {
    expect(headlineFor(0.55)).toBe("Hmmm yah");
  });

  it("is 'Hmmm nah' when Tentatively disfavored", () => {
    expect(headlineFor(0.45)).toBe("Hmmm nah");
  });
});
