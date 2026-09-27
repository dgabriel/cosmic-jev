/**
 * SpendLedger: per-network spend accounting for the /api/decide proxy, backed
 * by a single SQLite-storage Durable Object (available on the Workers free
 * plan). One singleton object holds every bucket, so enforcement checks and
 * the admin snapshot read the same strongly-consistent store.
 *
 * Data model:
 *   charges(bucket, ts_ms, usd)  -- one row per proxied upstream call, kept
 *                                   for the rolling SPEND_WINDOW only.
 *   totals(bucket, total_usd)    -- pruned charges folded in, so an all-time
 *                                   total survives window pruning.
 *
 * Buckets are derived from CF-Connecting-IP: IPv4 addresses keep their exact
 * address, IPv6 addresses are collapsed to their /64 prefix (otherwise one
 * client gets 2^64 fresh "networks"), and a missing or malformed header lands
 * in a shared "unknown" bucket that is still capped. The bucket is all the
 * Worker stores: no request content (birthdates, activity text) is kept.
 *
 * This file deliberately has no Cloudflare imports: the storage surface is
 * hand-written like worker/handler.ts's Env, and the object is driven over
 * the classic fetch protocol (`stub.fetch`) rather than RPC, which would
 * require `extends DurableObject` from "cloudflare:workers" plus test shims.
 * The SQL shell is kept thin; all bucketing/window/merge logic is in plain
 * exported functions so spendLedger.test.ts covers it, and handler tests
 * drive the same wire protocol through in-memory fakes.
 *
 * Wire protocol (all JSON, timestamps taken inside the object):
 *   POST /check    { bucket }                    -> 200 { spent }
 *   POST /charge   { bucket, usd }               -> 204
 *   GET  /snapshot {}                            -> 200 { buckets: LedgerBucket[] }
 */

/** Rolling window length (also exported as days for the admin API). */
export const SPEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SPEND_WINDOW_DAYS = 7;

/** Cap applied when SPEND_CAP_USD_PER_IP is unset. Roughly 800 typical calls. */
export const DEFAULT_CAP_USD = 0.01;

/**
 * Charged when a proxied upstream success carries no numeric usage.cost. Set
 * well above the observed typical cost (~$0.000012/call) so malformed replies
 * are never a discount.
 */
export const FALLBACK_CHARGE_USD = 0.0001;

/** Bucket used when CF-Connecting-IP is absent or unparseable. Still capped. */
export const UNKNOWN_BUCKET = "unknown";

/** Round display sums to nano-dollars so float dust never reaches the UI. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e8) / 1e8;
}

/** Parse a dotted-quad IPv4 address; returns it normalized, or null. */
function parseIpv4(raw: string): string | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets.join(".");
}

/**
 * Expand an IPv6 address to eight lowercase four-digit groups, or null if it
 * is not an IPv6 address. Handles "::" compression, zone ids, and an embedded
 * IPv4 tail (e.g. ::ffff:1.2.3.4) by converting the tail to two groups.
 */
function expandIpv6(input: string): string[] | null {
  let addr = input.trim().toLowerCase().split("%", 1)[0] ?? "";
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const normalized = parseIpv4(addr.slice(lastColon + 1));
    if (normalized === null) return null;
    // parseIpv4 guarantees four octets; defaults only satisfy the type system.
    const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = normalized.split(".").map(Number);
    const hi = ((o0 << 8) | o1).toString(16);
    const lo = ((o2 << 8) | o3).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }
  if (addr === "") return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const leftRaw = halves[0] ?? "";
  const rightRaw = halves[1] ?? "";
  const left = leftRaw === "" ? [] : leftRaw.split(":");
  const right = halves.length === 2 ? (rightRaw === "" ? [] : rightRaw.split(":")) : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : left;
  if (groups.length !== 8) return null;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  }
  return groups.map((g) => g.padStart(4, "0"));
}

/**
 * Map a CF-Connecting-IP value to its spend bucket. IPv4 addresses bucket by
 * exact address, IPv6 by /64 prefix (an abuser with a single /64 gets one
 * $0.01 budget for all 2^64 addresses in it). Anything missing or
 * unparseable lands in the shared UNKNOWN_BUCKET, which is still capped --
 * a malformed header is never a bypass.
 */
export function ipBucket(ip: string | null): string {
  const raw = ip?.trim() ?? "";
  if (raw === "") return UNKNOWN_BUCKET;
  if (raw.includes(":")) {
    const groups = expandIpv6(raw);
    if (groups === null) return UNKNOWN_BUCKET;
    // groups has exactly 8 members; defaults only satisfy the type system.
    const [g0 = "", g1 = "", g2 = "", g3 = "", g4 = "", g5 = "", g6 = "0", g7 = "0"] = groups;
    const first64 = [g0, g1, g2, g3];
    // IPv4-mapped addresses (::ffff:a.b.c.d) bucket as their IPv4 address.
    if ([g0, g1, g2, g3, g4].every((g) => g === "0000") && g5 === "ffff") {
      const hi = parseInt(g6, 16);
      const lo = parseInt(g7, 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return `${first64.join(":")}::/64`;
  }
  return parseIpv4(raw) ?? UNKNOWN_BUCKET;
}

/**
 * Parse THROTTLE_EXEMPT_IPS (comma-separated; IPv4 exact addresses, IPv6 as
 * /64 prefixes like "2001:db8:1234::/64") and report whether `bucket` is
 * exempt from enforcement. Malformed entries are ignored, never matched.
 * Exempt buckets are still metered -- the page shows their spend in the
 * all-time total even though they never get a 429.
 */
export function isExemptBucket(bucket: string, rawList: string | undefined): boolean {
  const entries = (rawList ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  for (const entry of entries) {
    if (entry.toLowerCase().endsWith("/64")) {
      const groups = expandIpv6(entry.slice(0, -3));
      if (groups === null) continue;
      const [g0 = "", g1 = "", g2 = "", g3 = ""] = groups;
      if (ipBucket(`${g0}:${g1}:${g2}:${g3}::`) === bucket) return true;
    } else {
      const v4 = parseIpv4(entry);
      if (v4 !== null && v4 === bucket) return true;
    }
  }
  return false;
}

/**
 * Parse SPEND_CAP_USD_PER_IP. Unset means DEFAULT_CAP_USD; a non-numeric or
 * non-positive value returns null, which the handler treats as misconfigured
 * and fails closed (503) rather than silently uncapping spend.
 */
export function parseCap(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return DEFAULT_CAP_USD;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One bucket's numbers on the admin snapshot (display-rounded). */
export interface LedgerBucket {
  bucket: string;
  spend7dUsd: number;
  totalUsd: number;
  lastChargeMs: number | null;
}

/**
 * Merge the two tables' rows into per-bucket totals. A bucket's all-time
 * total is its pruned history (totals.total) plus everything still in the
 * charges table; its window figure is the recent part of the charges table.
 */
export function mergeLedger(
  totalsRows: Array<{ bucket: string; total: number }>,
  chargeRows: Array<{
    bucket: string;
    chargesTotal: number;
    windowTotal: number;
    lastMs: number | null;
  }>,
): LedgerBucket[] {
  const merged = new Map<string, LedgerBucket>();
  for (const row of totalsRows) {
    merged.set(row.bucket, {
      bucket: row.bucket,
      spend7dUsd: 0,
      totalUsd: row.total,
      lastChargeMs: null,
    });
  }
  for (const row of chargeRows) {
    const existing = merged.get(row.bucket) ?? {
      bucket: row.bucket,
      spend7dUsd: 0,
      totalUsd: 0,
      lastChargeMs: null,
    };
    existing.spend7dUsd = roundUsd(row.windowTotal);
    existing.totalUsd = roundUsd(existing.totalUsd + row.chargesTotal);
    existing.lastChargeMs = row.lastMs;
    merged.set(row.bucket, existing);
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Durable Object shell (thin; logic above is what gets unit-tested)
// ---------------------------------------------------------------------------

/** Hand-rolled SQLite DO storage surface, like handler.ts's hand-rolled Env. */
interface SqlCursor {
  toArray(): Array<Record<string, unknown>>;
}
interface SqlStorage {
  exec(query: string, ...params: Array<string | number>): SqlCursor;
}
export interface DurableObjectStateLike {
  storage: {
    sql: SqlStorage;
    transactionSync<T>(fn: () => T): T;
  };
}

function numberOf(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The single SPEND_TRACKER object, driven by `stub.fetch` (see the wire
 * protocol in the file header). Any throw here propagates to the caller,
 * which fails closed (503) rather than proxying unbilled traffic.
 */
export class SpendLedger {
  constructor(private readonly ctx: DurableObjectStateLike) {
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS charges (bucket TEXT NOT NULL, ts_ms INTEGER NOT NULL, usd REAL NOT NULL)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS charges_bucket_ts ON charges (bucket, ts_ms)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS totals (bucket TEXT PRIMARY KEY, total_usd REAL NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/check") {
      const body: unknown = await request.json();
      if (!isRecordWithStringBucket(body)) return new Response("invalid body", { status: 400 });
      return Response.json({ spent: this.checkSpend(body.bucket, Date.now()) });
    }
    if (request.method === "POST" && url.pathname === "/charge") {
      const body: unknown = await request.json();
      if (
        !isRecordWithStringBucket(body) ||
        typeof body.usd !== "number" ||
        !Number.isFinite(body.usd) ||
        body.usd < 0
      ) {
        return new Response("invalid body", { status: 400 });
      }
      this.recordCharge(body.bucket, body.usd, Date.now());
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      return Response.json({ buckets: this.snapshotRows(Date.now()) });
    }
    return new Response("not found", { status: 404 });
  }

  /** USD charged to `bucket` inside the rolling window. */
  checkSpend(bucket: string, nowMs: number): number {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT COALESCE(SUM(usd), 0) AS spent FROM charges WHERE bucket = ? AND ts_ms > ?",
        bucket,
        nowMs - SPEND_WINDOW_MS,
      )
      .toArray();
    return numberOf(rows[0], "spent");
  }

  /**
   * Record a charge, then lazily prune this bucket's rows older than the
   * window by folding their sum into totals. Buckets that go idle keep their
   * old charge rows until their next charge, so snapshot counts both tables
   * for the all-time figure.
   */
  recordCharge(bucket: string, usd: number, nowMs: number): void {
    const sql = this.ctx.storage.sql;
    const cutoff = nowMs - SPEND_WINDOW_MS;
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO charges (bucket, ts_ms, usd) VALUES (?, ?, ?)", bucket, nowMs, usd);
      const fold = numberOf(
        sql
          .exec(
            "SELECT COALESCE(SUM(usd), 0) AS fold FROM charges WHERE bucket = ? AND ts_ms <= ?",
            bucket,
            cutoff,
          )
          .toArray()[0],
        "fold",
      );
      if (fold > 0) {
        sql.exec("DELETE FROM charges WHERE bucket = ? AND ts_ms <= ?", bucket, cutoff);
        sql.exec(
          "INSERT INTO totals (bucket, total_usd) VALUES (?, ?) " +
            "ON CONFLICT (bucket) DO UPDATE SET total_usd = total_usd + excluded.total_usd",
          bucket,
          fold,
        );
      }
    });
  }

  /** Per-bucket window and all-time spend for the admin snapshot. */
  snapshotRows(nowMs: number): LedgerBucket[] {
    const sql = this.ctx.storage.sql;
    const totalsRows = sql
      .exec("SELECT bucket, total_usd AS total FROM totals")
      .toArray()
      .map((row) => ({ bucket: String(row.bucket), total: numberOf(row, "total") }));
    const chargeRows = sql
      .exec(
        "SELECT bucket, COALESCE(SUM(usd), 0) AS charges_total, " +
          "COALESCE(SUM(CASE WHEN ts_ms > ? THEN usd ELSE 0 END), 0) AS window_total, " +
          "MAX(ts_ms) AS last_ms FROM charges GROUP BY bucket",
        nowMs - SPEND_WINDOW_MS,
      )
      .toArray()
      .map((row) => ({
        bucket: String(row.bucket),
        chargesTotal: numberOf(row, "charges_total"),
        windowTotal: numberOf(row, "window_total"),
        lastMs: typeof row.last_ms === "number" ? row.last_ms : null,
      }));
    return mergeLedger(totalsRows, chargeRows);
  }
}

function isRecordWithStringBucket(
  body: unknown,
): body is { bucket: string; usd?: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { bucket?: unknown }).bucket === "string"
  );
}
