/**
 * Background service worker: the only part of this extension that talks to
 * the network. content.ts never calls the Worker directly -- Manifest V3
 * service workers with `host_permissions` for a host bypass that host's CORS
 * policy entirely, which a content script's own fetch would not, so routing
 * every oracle call through here avoids needing any content-script-specific
 * CORS handling at all.
 *
 * Reuses this repo's own oracle/astronomy modules verbatim (askOracle,
 * JevOracle, computeNatalChart, computeTransitChart) rather than
 * reimplementing any of that logic -- the extension bundle pulls them in
 * directly from ../../src at build time (see ../build.mjs).
 */
import { askOracle } from "../../src/oracle";
import { JevOracle } from "../../src/oracle-jev";
import { computeNatalChart } from "../../src/natal";
import { computeTransitChart } from "../../src/sky";
import { loadBirthInput } from "./storage";
import type { ScoreEventRequest, ScoreEventResponse } from "./messages";

/**
 * The deployed Worker's URL (see .github/workflows/deploy.yml's
 * VITE_WORKER_URL, and src/config.ts's own copy of this same value for the
 * main app). Hardcoded here rather than read from an env var: this bundle is
 * built with esbuild, not Vite, so there is no `import.meta.env` substitution
 * step, and this is the Worker's own public URL, not a secret.
 */
const WORKER_URL = "https://cosmic-oracle-worker.cosmic-oracle.workers.dev";

const oracle = new JevOracle({ workerUrl: WORKER_URL });

async function scoreEvent(title: string): Promise<ScoreEventResponse> {
  const birthInput = await loadBirthInput();
  if (birthInput === undefined) {
    return { kind: "no-birth-input" };
  }

  try {
    const natal = computeNatalChart(birthInput);
    // `new Date()` here plays the same role as the main app's own single
    // legitimate clock read (src/experience/sequencer.ts): each event is its
    // own independent "does the sky favor this, today" question.
    const transits = computeTransitChart(new Date());
    const outcome = await askOracle(oracle, { transits, natal, activityText: title });

    if (outcome.kind === "verdict") {
      return { kind: "verdict", favor: outcome.favor, intensity: outcome.intensity };
    }
    return { kind: outcome.kind };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "Unknown error" };
  }
}

chrome.runtime.onMessage.addListener<ScoreEventRequest>((message, _sender, sendResponse) => {
  if (message?.type !== "SCORE_EVENT") {
    return false;
  }
  void scoreEvent(message.title).then(sendResponse);
  return true; // Keeps the message channel open for the async sendResponse above.
});
