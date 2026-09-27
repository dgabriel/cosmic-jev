/**
 * Build-time configuration. Only non-secret values belong here: anything read
 * from `import.meta.env` is bundled into the client. The OpenRouter API key
 * lives only in the Worker and must never be added to this file.
 */

export const ORACLE_KINDS = ["stub", "jev"] as const;

export type OracleKind = (typeof ORACLE_KINDS)[number];

/** Parses the VITE_ORACLE value. Unset or empty means "stub". */
export function parseOracleKind(value: string | undefined): OracleKind {
  if (value === undefined || value === "") {
    return "stub";
  }
  const match = ORACLE_KINDS.find((kind) => kind === value);
  if (match === undefined) {
    throw new Error(
      `Invalid VITE_ORACLE "${value}". Expected one of: ${ORACLE_KINDS.join(", ")}.`,
    );
  }
  return match;
}

export const ORACLE_KIND: OracleKind = parseOracleKind(import.meta.env.VITE_ORACLE);

/**
 * Build-time base URL for the deployed Cloudflare Worker proxy (oracle-3em),
 * e.g. `https://cosmic-oracle-worker.cosmic-oracle.workers.dev`. Read from
 * `VITE_WORKER_URL`; non-secret (it is only the Worker's own public URL --
 * the OpenRouter key never appears here or anywhere client-side). Left
 * `undefined` when unset or empty; `JevOracle` (src/oracle-jev.ts) requires a
 * value, but `StubOracle` never reads this, so leaving it unset is fine for
 * `VITE_ORACLE=stub` (the default).
 */
export const WORKER_URL: string | undefined =
  import.meta.env.VITE_WORKER_URL === undefined || import.meta.env.VITE_WORKER_URL === ""
    ? undefined
    : import.meta.env.VITE_WORKER_URL;
