/**
 * Orchestrates the full "does haruspicy" sequence: intake form -> chart/
 * oracle calls, then a full-viewport dark `.experience-overlay` where the
 * star field resolves into the natal Sun's constellation while the actual
 * result (verdict/recusal) is shown at the same time -- "instant results
 * while the constellation resolves," per the project owner, who also cut the
 * haruspicy placeholder-card beat that used to sit between them entirely.
 * "Needs-detail" short-circuits before the overlay ever mounts (no verdict to
 * build drama toward); recusal and verdict both get the same overlay
 * treatment and only branch at the reveal itself. "Again" tears down the
 * overlay and restarts everything.
 *
 * There is no separate splash/cover screen or stop-sign consent gate
 * anymore -- both were cut per the project owner. The brownie photo and the
 * "Cosmic JEV" title (originally the cover page's whole content) now live as
 * the intake page's own background and heading instead ("no cover page,
 * brownie as background for the form, Cosmic JEV is the title on the form
 * page").
 */
import { ORACLE_KIND } from "../config";
import { computeNatalChart, type NatalChart } from "../natal";
import { askOracle, createOracle, type OracleOutcome } from "../oracle";
import { computeTransitChart, type TransitChart } from "../sky";
import { clearChildren, renderMessage, requireElementOfType } from "./dom";
import { renderIntakeForm, type IntakeResult } from "./steps/intakeForm";
import { runSignResolveBeat } from "./steps/signResolve";
import { runVerdictResolveBeat } from "./steps/verdictResolve";
import { runRecusalBeat } from "./steps/recusal";
import { renderNeedsDetailBeat } from "./steps/needsDetail";
import brownieUrl from "./assets/images/brownie.png";

/** Everything the overlay sequence needs; "needs-detail" is resolved before this type is ever produced. */
type ResolvableOutcome = Exclude<OracleOutcome, { kind: "needs-detail" }>;

interface ResolvedIntake {
  intake: IntakeResult;
  natal: NatalChart;
  transits: TransitChart;
  outcome: ResolvableOutcome;
}

/**
 * Builds the intake page (brownie background + "Cosmic JEV" title, wrapping
 * the notice/form area) and loops the form until it produces an outcome
 * worth building the overlay sequence around. "Needs-detail" and oracle-call
 * failures both loop back to a fresh form (clearing only `formHost`, not
 * `notice`, so the message stays visible above the re-rendered form) rather
 * than ending the flow -- there's nothing else useful to show the user in
 * either case.
 */
async function runIntakeUntilOutcome(stage: HTMLElement): Promise<ResolvedIntake> {
  // Static markup only -- brownieUrl is a build-time constant, nothing
  // user-supplied is interpolated here.
  stage.innerHTML = `
    <div id="intake-page" class="intake-page">
      <h1 class="intake-title">Cosmic JEV</h1>
      <div id="intake-notice"></div>
      <div id="intake-form-host"></div>
    </div>
  `;
  const page = requireElementOfType("intake-page", HTMLDivElement);
  page.style.backgroundImage = `url(${brownieUrl})`;

  const notice = requireElementOfType("intake-notice", HTMLDivElement);
  const formHost = requireElementOfType("intake-form-host", HTMLDivElement);
  const oracle = createOracle(ORACLE_KIND);

  for (;;) {
    const intake = await renderIntakeForm(formHost);
    const natal = computeNatalChart(intake.birthInput);
    // `new Date()` is called exactly once, right before `computeTransitChart`:
    // per docs/spec.md, sky.ts/natal.ts/aspects.ts/oracle.ts all take dates as
    // parameters and never read the clock themselves, so this is the one
    // legitimate place in the app that does.
    const transits = computeTransitChart(new Date());

    let outcome: OracleOutcome;
    try {
      outcome = await askOracle(oracle, { transits, natal, activityText: intake.activityText });
    } catch (error) {
      console.error("Cosmic JEV: failed to produce an outcome", error);
      renderMessage(notice, "The oracle couldn't be reached just now. Please try again in a moment.", "error");
      continue;
    }

    if (outcome.kind === "needs-detail") {
      renderNeedsDetailBeat(notice);
      continue;
    }

    clearChildren(notice);
    return { intake, natal, transits, outcome };
  }
}

export async function startExperience(root: HTMLElement): Promise<void> {
  root.style.display = "";
  root.innerHTML = `<div id="experience-stage"></div>`;
  const stage = requireElementOfType("experience-stage", HTMLDivElement);

  const { intake, natal, outcome } = await runIntakeUntilOutcome(stage);

  // The overlay is appended to `document.body` (a sibling of `#app`/`root`),
  // not into `stage`, so `position: fixed` can't be broken by any ancestor
  // transform/overflow; `root` is hidden underneath rather than removed,
  // since a restart reuses it.
  root.style.display = "none";
  const overlay = document.createElement("div");
  overlay.className = "experience-overlay";
  // The whole sequence rebuilds this element's contents repeatedly (starfield,
  // then the resolved constellation, then the final reveal, both at once);
  // marking it once as a live region means assistive tech announces each
  // swap, not just whatever happened to be in the DOM when it first got
  // focus.
  overlay.setAttribute("aria-live", "polite");
  document.body.append(overlay);

  // Not awaited: runSignResolveBeat mounts the starfield and returns
  // immediately, resolving into the constellation in the background, while
  // the reveal below shows the actual result right away over it.
  const starfieldHandle = runSignResolveBeat(overlay, natal);

  const restart = (): void => {
    starfieldHandle.destroy();
    overlay.remove();
    void startExperience(root);
  };

  if (outcome.kind === "recusal") {
    await runRecusalBeat(overlay, { onAgain: restart });
  } else {
    await runVerdictResolveBeat(overlay, outcome, intake.activityText, { onAgain: restart });
  }
}
