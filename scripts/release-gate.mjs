#!/usr/bin/env node
/**
 * Release gate: runs every row of release-gate/questions.csv through the
 * deterministic StubOracle's classify() -> route() pipeline (never
 * JevOracle/VITE_ORACLE -- the gate must be reproducible with no network
 * and no build-time env var), compares the actual outcome to each row's
 * expected_answer, rewrites the CSV in place with today's pass/fail status,
 * and exits non-zero if anything failed. Wired as `prebuild` in
 * package.json so it runs before every production build.
 *
 * expected_answer vocabulary: a ruling-body name (`Mars`, `Venus`, ...) for
 * an exact category match on an ordinary verdict; `recusal` and `vague` for
 * those two non-verdict outcomes; `disclaimer` for a verdict carrying the
 * oracle-2au health/money/relationship_ending/job_quitting disclaimer flag
 * (any category -- per spec those questions proceed to a real verdict, and
 * the disclaimer flag, not the ruling body, is the point of the row);
 * `verdict` for a disclaimer=false verdict at any category (used for the
 * violence-toward-an-object row: per oracle-2au that classifies normally,
 * with no special handling to pin a specific category for).
 *
 * Loads src/oracle.ts and src/releaseGate/csv.ts (both TypeScript) directly
 * via Vite's programmatic SSR module loader (server.ssrLoadModule), so this
 * script needs zero new dependencies and no separate transpile step -- it
 * runs as a plain Node ESM script (`node scripts/release-gate.mjs`).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const csvPath = path.join(projectRoot, "release-gate", "questions.csv");

const EXPECTED_HEADER = ["question", "expected_answer", "status", "last_success_date"];

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

async function loadModules() {
  const server = await createServer({
    root: projectRoot,
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const oracleModule = await server.ssrLoadModule("/src/oracle.ts");
    const csvModule = await server.ssrLoadModule("/src/releaseGate/csv.ts");
    return { oracleModule, csvModule };
  } finally {
    await server.close();
  }
}

function actualAnswerFor(routing) {
  if (routing.kind === "recusal") return "recusal";
  if (routing.kind === "needs-detail") return "vague";
  if (routing.disclaimer) return "disclaimer";
  return routing.category;
}

function matchesExpected(expectedAnswer, routing, actualAnswer) {
  if (expectedAnswer === "verdict") {
    return routing.kind === "proceed" && !routing.disclaimer;
  }
  return actualAnswer === expectedAnswer;
}

async function main() {
  const { oracleModule, csvModule } = await loadModules();
  const { StubOracle, route } = oracleModule;
  const { parseCsv, stringifyCsv } = csvModule;

  const csvText = await readFile(csvPath, "utf8");
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    throw new Error(`${csvPath} has no rows (expected at least a header row).`);
  }

  const [header, ...dataRows] = rows;
  for (const column of EXPECTED_HEADER) {
    if (!header.includes(column)) {
      throw new Error(`${csvPath}'s header is missing column "${column}". Found: ${header.join(", ")}`);
    }
  }
  const columnIndex = Object.fromEntries(EXPECTED_HEADER.map((name) => [name, header.indexOf(name)]));

  const oracle = new StubOracle();
  const results = [];

  for (const row of dataRows) {
    const question = row[columnIndex.question] ?? "";
    const expectedAnswer = row[columnIndex.expected_answer] ?? "";
    const previousLastSuccessDate = row[columnIndex.last_success_date] ?? "";

    const classification = await oracle.classify(question);
    const routing = route(classification);
    const actualAnswer = actualAnswerFor(routing);
    const passed = matchesExpected(expectedAnswer, routing, actualAnswer);

    row[columnIndex.status] = passed ? "pass" : "fail";
    row[columnIndex.last_success_date] = passed ? todayUtcDate() : previousLastSuccessDate;

    results.push({ question, expectedAnswer, actualAnswer, passed });
  }

  await writeFile(csvPath, `${stringifyCsv([header, ...dataRows])}\n`, "utf8");

  const passCount = results.filter((result) => result.passed).length;
  const failCount = results.length - passCount;

  console.log(`Release gate: ${results.length} total, ${passCount} passed, ${failCount} failed.`);
  if (failCount > 0) {
    console.log("Failures:");
    for (const result of results) {
      if (result.passed) continue;
      console.log(
        `  - "${result.question}": expected "${result.expectedAnswer}", got "${result.actualAnswer}"`,
      );
    }
  }

  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("Release gate crashed:", error);
  process.exitCode = 1;
});
