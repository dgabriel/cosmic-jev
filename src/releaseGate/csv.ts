/**
 * Minimal RFC4180-lite CSV parse/serialize, written for the release gate
 * tool (`release-gate/questions.csv`, `scripts/release-gate.mjs`) so that
 * tool has zero new npm dependencies. Deliberately small: only what the gate
 * needs, not a general-purpose CSV library.
 *
 * Supported: comma-separated fields; LF or CRLF row separators (both
 * accepted on parse); quoted fields, including embedded commas and embedded
 * newlines; embedded double-quotes doubled inside a quoted field (`""` ->
 * `"`), per RFC4180. `stringifyCsv` always writes LF row separators (not
 * CRLF) and quotes a field only when required (it contains a comma, quote,
 * or newline) -- both are deliberate simplifications, not RFC4180 strictness,
 * kept because the gate only ever round-trips its own output.
 *
 * Not supported (and not needed here): custom delimiters, comment lines, or
 * bare (non-doubled) quotes inside a quoted field.
 */

/** One parsed CSV row: every field as a raw string, in column order. */
export type CsvRow = string[];

/**
 * Parses CSV text into rows of raw string fields. The header row (if any) is
 * just the first `CsvRow` -- this module has no notion of column names.
 */
export function parseCsv(input: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const length = input.length;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < length) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      endField();
      i++;
      continue;
    }
    if (char === "\r") {
      if (input[i + 1] === "\n") {
        i++; // let the following \n end the row
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === "\n") {
      endRow();
      i++;
      continue;
    }
    field += char;
    i++;
  }

  // A trailing newline should not produce a spurious final empty row, but
  // any real trailing content (no final newline) must still be flushed.
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows;
}

function fieldNeedsQuoting(field: string): boolean {
  return field.includes(",") || field.includes('"') || field.includes("\n") || field.includes("\r");
}

function quoteField(field: string): string {
  if (!fieldNeedsQuoting(field)) {
    return field;
  }
  return `"${field.replace(/"/g, '""')}"`;
}

/** Serializes rows of raw string fields back to CSV text (LF-separated rows, no trailing newline). */
export function stringifyCsv(rows: readonly CsvRow[]): string {
  return rows.map((row) => row.map(quoteField).join(",")).join("\n");
}
