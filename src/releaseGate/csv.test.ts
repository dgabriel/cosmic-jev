import { describe, expect, it } from "vitest";
import { parseCsv, stringifyCsv, type CsvRow } from "./csv";

describe("parseCsv / stringifyCsv round trips", () => {
  it("round-trips plain unquoted fields", () => {
    const rows: CsvRow[] = [
      ["question", "expected_answer", "status", "last_success_date"],
      ["Should I clean my bathroom", "Moon", "pass", "2026-09-27"],
    ];
    const csv = stringifyCsv(rows);
    expect(csv).toBe(
      "question,expected_answer,status,last_success_date\nShould I clean my bathroom,Moon,pass,2026-09-27",
    );
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("round-trips a field with an embedded comma (gets quoted)", () => {
    const rows: CsvRow[] = [["Should I buy eggs, milk, and bread", "Moon"]];
    const csv = stringifyCsv(rows);
    expect(csv).toBe('"Should I buy eggs, milk, and bread",Moon');
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("round-trips a field with an embedded quote (doubled inside quotes)", () => {
    const rows: CsvRow[] = [['She said "hello" to me', "Venus"]];
    const csv = stringifyCsv(rows);
    expect(csv).toBe('"She said ""hello"" to me",Venus');
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("round-trips an empty field", () => {
    const rows: CsvRow[] = [["Should I nap", "Moon", "", ""]];
    const csv = stringifyCsv(rows);
    expect(csv).toBe("Should I nap,Moon,,");
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("round-trips a field with an embedded newline", () => {
    const rows: CsvRow[] = [["line one\nline two", "Sun"]];
    const csv = stringifyCsv(rows);
    expect(csv).toBe('"line one\nline two",Sun');
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("accepts CRLF row separators on parse", () => {
    const csv = "a,b\r\nc,d\r\n";
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not produce a spurious trailing row for a final newline", () => {
    const csv = "a,b\nc,d\n";
    expect(parseCsv(csv)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses empty input as zero rows", () => {
    expect(parseCsv("")).toEqual([]);
  });
});
