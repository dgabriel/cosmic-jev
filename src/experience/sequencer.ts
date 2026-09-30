/**
 * Orchestrates the full "does haruspicy" sequence on a single page: intake
 * form -> chart/oracle calls -> the result replaces the form in place, while
 * the page's own starfield swirls into the natal Sun's constellation behind
 * it ("instant results while the constellation resolves"). Per the project
 * owner, the answer stays on the same page -- it used to open a separate
 * full-viewport overlay. "Needs-detail" and oracle failures keep the form up
 * with a message instead; recusal and verdict only branch at the result
 * itself. "Again" rebuilds the page with a fresh form.
 *
 * There is no separate splash/cover screen or stop-sign consent gate
 * anymore -- both were cut per the project owner. The brownie photo sits
 * behind the "Cosmic JEV" title, and the starfield is the page background.
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
import { mountStarfield, type StarfieldHandle } from "./steps/starfield";
import brownieUrl from "./assets/images/brownie.png";

/** Gentler than the reveal's fade-in: the landing page should settle quickly, not perform. */
const INTAKE_SKY_FADE_IN_MS = 800;

/** Everything the result needs; "needs-detail" is resolved before this type is ever produced. */
type ResolvableOutcome = Exclude<OracleOutcome, { kind: "needs-detail" }>;

interface ResolvedIntake {
  intake: IntakeResult;
  natal: NatalChart;
  transits: TransitChart;
  outcome: ResolvableOutcome;
  sky: StarfieldHandle;
  formHost: HTMLDivElement;
}

/**
 * Builds the intake page (starfield background, brownie-backed "Cosmic JEV"
 * title, then the notice/form area) and loops the form until it produces an
 * outcome worth showing. "Needs-detail" and oracle-call
 * failures both loop back to a fresh form (clearing only `formHost`, not
 * `notice`, so the message stays visible above the re-rendered form) rather
 * than ending the flow -- there's nothing else useful to show the user in
 * either case.
 */
async function runIntakeUntilOutcome(stage: HTMLElement): Promise<ResolvedIntake> {
  // Static markup only -- brownieUrl is a build-time constant, nothing
  // user-supplied is interpolated here. Layout per the owner's landing-page
  // sketch (oracle-rq3): a black starfield fills the page, the brownie sits
  // behind the sparkly, arched, sprinkle-colored "Cosmic JEV" title only, and the form floats below.
  stage.innerHTML = `
    <div id="intake-page" class="intake-page">
      <div id="intake-sky" class="intake-sky" aria-hidden="true"></div>
      <header id="intake-title-box" class="intake-title-box">
        <h1 class="intake-title" aria-label="Cosmic JEV">
          <svg class="intake-title-arch" viewBox="0 0 400 108" aria-hidden="true" focusable="false">
            <path id="intake-title-arc" d="M 30 100 A 300 300 0 0 1 370 100" fill="none" />
            <text text-anchor="middle"><textPath href="#intake-title-arc" startOffset="50%"><tspan class="sprinkle-red">C</tspan><tspan class="sprinkle-yellow">o</tspan><tspan class="sprinkle-blue">s</tspan><tspan class="sprinkle-lime">m</tspan><tspan class="sprinkle-pink">i</tspan><tspan class="sprinkle-orange">c</tspan> <tspan class="sprinkle-periwinkle">J</tspan><tspan class="sprinkle-blue">E</tspan><tspan class="sprinkle-red">V</tspan></textPath></text>
          </svg>
        </h1>
      </header>
      <div id="intake-notice"></div>
      <div id="intake-form-host"></div>
      <a class="about-link" href="https://github.com/dgabriel/cosmic-jev#readme" target="_blank" rel="noopener noreferrer">About this project</a>
      <p class="intake-credit">City data from <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a> (CC BY 4.0)</p>
    </div>
  `;
  requireElementOfType("intake-title-box", HTMLElement).style.backgroundImage = `url(${brownieUrl})`;
  const sky = mountStarfield(requireElementOfType("intake-sky", HTMLDivElement));
  void sky.fadeIn(INTAKE_SKY_FADE_IN_MS);
  try {
    return { ...(await loopIntakeForm()), sky };
  } catch (error) {
    sky.destroy();
    throw error;
  }
}

async function loopIntakeForm(): Promise<Omit<ResolvedIntake, "sky">> {
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
    return { intake, natal, transits, outcome, formHost };
  }
}

export async function startExperience(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="experience-stage"></div>`;
  const stage = requireElementOfType("experience-stage", HTMLDivElement);

  const { intake, natal, outcome, sky, formHost } = await runIntakeUntilOutcome(stage);

  // The result takes the form's place on the same page. A live region so
  // assistive tech announces it, since focus was on the (now removed) form.
  clearChildren(formHost);
  const result = document.createElement("div");
  result.className = "intake-result";
  result.setAttribute("aria-live", "polite");
  formHost.append(result);

  if (outcome.kind === "recusal") {
    await runRecusalBeat(result);
  } else {
    await runVerdictResolveBeat(result, outcome, intake.activityText);
  }
  // Named under the result, while the sky behind swirls into that sign.
  runSignResolveBeat(sky, result, natal);

  // A plain link-styled button (per the project owner: "change the again
  // button to be a link, no brownie sprinkles").
  const again = document.createElement("button");
  again.type = "button";
  again.className = "again-link";
  again.textContent = "Again";
  again.addEventListener("click", () => {
    sky.destroy();
    void startExperience(root);
  });
  result.append(again);
  again.focus({ preventScroll: true });
}
