/**
 * admin.html controller: renders the Worker's GET /api/admin/spend snapshot.
 * Unauthenticated by design (security-by-obscurity URL only). All state lives
 * in the DOM; fetched values go through textContent, never innerHTML.
 */
import { WORKER_URL } from "./config";

interface AdminBucket {
  bucket: string;
  spend_7d_usd: number;
  total_usd: number;
  last_charge_at: string | null;
}

interface AdminSnapshot {
  window_days: number;
  cap_usd: number | null;
  generated_at: string;
  total_usd: number;
  buckets: AdminBucket[];
}

const REFRESH_MS = 30_000;

/** Adaptive precision: tiny amounts show digits, big ones look like money. */
function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  return node;
}

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("admin.html is missing #app");
app.className = "app";

const header = el("header");
header.appendChild(el("h1", { text: "Cosmic JEV" }));
header.appendChild(el("p", { className: "tagline", text: "Spend ledger. The meter never lies." }));
app.appendChild(header);

const summary = el("p", { className: "ledger-summary" });
app.appendChild(summary);

const status = el("p", { className: "hint", text: "Checking the meter…" });
status.setAttribute("aria-live", "polite");
app.appendChild(status);

const tableWrap = el("div");
app.appendChild(tableWrap);

function renderSnapshot(snapshot: AdminSnapshot): void {
  tableWrap.replaceChildren();
  summary.textContent =
    `All-time spend: ${formatUsd(snapshot.total_usd)} · ` +
    `cap per network: ${snapshot.cap_usd === null ? "misconfigured" : formatUsd(snapshot.cap_usd)} ` +
    `per ${snapshot.window_days} days`;

  if (snapshot.buckets.length === 0) {
    tableWrap.appendChild(el("p", { className: "hint", text: "No charges yet. The stars have cost nothing." }));
    return;
  }
  const table = el("table", { className: "ledger-table" });
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const [label, numeric] of [
    ["Network", false],
    ["7-day spend", true],
    ["All-time", true],
    ["Last seen (UTC)", false],
  ] as const) {
    const th = document.createElement("th");
    th.textContent = label;
    if (numeric) th.className = "num";
    th.scope = "col";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const bucket of snapshot.buckets) {
    const row = document.createElement("tr");
    const network = document.createElement("th");
    network.scope = "row";
    network.textContent = bucket.bucket;
    row.appendChild(network);
    for (const [value, when] of [
      [formatUsd(bucket.spend_7d_usd), false],
      [formatUsd(bucket.total_usd), false],
      [bucket.last_charge_at ?? "—", true],
    ] as const) {
      const td = document.createElement("td");
      if (when && bucket.last_charge_at !== null) {
        const time = document.createElement("time");
        time.dateTime = bucket.last_charge_at;
        time.textContent = bucket.last_charge_at.replace("T", " ").replace(/\.\d+Z$/, "Z");
        td.appendChild(time);
      } else {
        td.textContent = value;
      }
      if (!when) td.className = "num";
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
}

async function refresh(): Promise<void> {
  if (WORKER_URL === undefined) {
    status.textContent = "VITE_WORKER_URL was not set at build time. The meter is unreachable.";
    return;
  }
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/spend`, { method: "GET" });
    const body: unknown = await res.json();
    if (!res.ok) {
      const coded = body as { error?: { message?: unknown } };
      const message = typeof coded.error?.message === "string" ? coded.error.message : res.statusText;
      status.textContent = `The ledger refused: ${message}`;
      return;
    }
    const snapshot = body as AdminSnapshot;
    renderSnapshot(snapshot);
    status.textContent = `Last checked ${new Date().toLocaleTimeString()}. Refreshing every ${REFRESH_MS / 1000}s.`;
  } catch {
    status.textContent = "Could not reach the Worker. The meter keeps running regardless.";
  }
}

void refresh();
setInterval(() => void refresh(), REFRESH_MS);
