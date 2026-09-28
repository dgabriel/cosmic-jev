/**
 * SVG zodiac wheel (oracle-tix): natal planets on an inner ring, transits on
 * an outer ring, retrograde transits marked with a literal "℞", and aspect
 * lines from each transiting body to the natal Sun/Moon it aspects.
 *
 * Renders with D3 (per this project's "make heavy use of D3" instruction)
 * into a responsive `viewBox`-scaled `<svg>`; wiring this into the actual
 * sign-resolve beat (alongside `explainAmbiguity`'s caption list) is a
 * separate, later beads issue -- this module only builds and returns the
 * wheel element.
 *
 * Angle convention: ecliptic longitude 0deg is drawn at the top of the
 * wheel, increasing clockwise (i.e. the same convention `d3.arc`'s own
 * `startAngle`/`endAngle` use, so the sign wedges and the body markers stay
 * trivially consistent with each other using one shared angle scale).
 */
import * as d3 from "d3";
import type { NatalChart, NatalBodyPosition } from "../natal";
import type { TransitChart, BodyPosition, Sign } from "../sky";
import { TRANSIT_BODIES, ZODIAC_SIGNS, type TransitBodyName } from "../sky";
import type { Aspect, AspectType } from "../aspects";

const VIEWBOX_SIZE = 480;
const CENTER = VIEWBOX_SIZE / 2;

const SIGN_RING_OUTER_RADIUS = 230;
const SIGN_RING_INNER_RADIUS = 195;
const SIGN_LABEL_RADIUS = (SIGN_RING_OUTER_RADIUS + SIGN_RING_INNER_RADIUS) / 2;
const TRANSIT_RING_RADIUS = 175;
const NATAL_RING_RADIUS = 125;
const MARKER_RADIUS = 6;

// Dark, desaturated wedge fills so the ring reads as background structure
// rather than competing with the body markers/aspect lines drawn over it;
// alternating tone (not color) keeps sign boundaries visible without a
// rainbow of hues to also track.
const SIGN_WEDGE_FILLS = ["#1c1330", "#251a3f"];
const SIGN_LABEL_COLOR = "#e9e2ff";
const RING_GUIDE_COLOR = "rgba(255, 255, 255, 0.18)";
const NATAL_MARKER_FILL = "#8ecdf8";
const TRANSIT_MARKER_FILL = "#ffb86b";
const RETROGRADE_LABEL_COLOR = "#ffdf6b";
const AMBIGUOUS_MARKER_STROKE = "#8ecdf8";

const BODY_ABBREVIATIONS: Record<TransitBodyName, string> = {
  Sun: "Su",
  Moon: "Mo",
  Mercury: "Me",
  Venus: "Ve",
  Mars: "Ma",
  Jupiter: "Ju",
  Saturn: "Sa",
};

/**
 * Groups the five aspect types into three color families rather than one hue
 * per type: this wheel is read at a glance against a busy black overlay
 * background, so "is this pulling with me or against me" (harmonious vs.
 * tense) is the useful signal, with conjunction (neither, contextual) as a
 * neutral third bucket. Colors are light/saturated so the thin lines stay
 * legible on black.
 */
const ASPECT_CATEGORY: Record<AspectType, "harmonious" | "tense" | "neutral"> = {
  trine: "harmonious",
  sextile: "harmonious",
  square: "tense",
  opposition: "tense",
  conjunction: "neutral",
};

const aspectColorScale = d3
  .scaleOrdinal<string, string>()
  .domain(["harmonious", "tense", "neutral"])
  .range(["#8cffb0", "#ff7a8a", "#ffe066"]);

const angleScale = d3.scaleLinear().domain([0, 360]).range([0, 2 * Math.PI]);

interface Point {
  x: number;
  y: number;
}

/**
 * Converts an angle (radians, 0 at top / clockwise per this module's
 * convention) and a radius into wheel-local SVG coordinates. SVG's y-axis
 * points down, so "up" (angle 0) is -cos, and "clockwise toward +x" is +sin.
 */
function angleToPoint(angleRad: number, radius: number): Point {
  return { x: radius * Math.sin(angleRad), y: -radius * Math.cos(angleRad) };
}

interface SignWedgeDatum {
  sign: Sign;
  startAngle: number;
  endAngle: number;
}

function signWedges(): SignWedgeDatum[] {
  return ZODIAC_SIGNS.map((sign, index) => ({
    sign,
    startAngle: angleScale(index * 30),
    endAngle: angleScale((index + 1) * 30),
  }));
}

function summarizeNatalPositions(natal: NatalChart): string {
  return TRANSIT_BODIES.map((body) => {
    const position = natal.bodies[body];
    return `${body} in ${position.sign}${position.ambiguous ? " (uncertain)" : ""}`;
  }).join(", ");
}

function summarizeRetrogrades(transits: TransitChart): string {
  const retrograde = TRANSIT_BODIES.filter((body) => transits.bodies[body].retrograde);
  if (retrograde.length === 0) {
    return "No transiting bodies are currently retrograde.";
  }
  const verb = retrograde.length === 1 ? "is" : "are";
  return `${retrograde.join(", ")} ${verb} currently retrograde.`;
}

function describeChart(natal: NatalChart, transits: TransitChart, aspects: Aspect[]): string {
  const aspectCount = aspects.length;
  const aspectNoun = aspectCount === 1 ? "aspect" : "aspects";
  return (
    `Natal positions: ${summarizeNatalPositions(natal)}. ${summarizeRetrogrades(transits)} ` +
    `${aspectCount} ${aspectNoun} shown between transiting bodies and the natal Sun/Moon.`
  );
}

export function renderZodiacWheel(
  container: HTMLElement,
  data: { natal: NatalChart; transits: TransitChart; aspects: Aspect[] },
): SVGSVGElement {
  const { natal, transits, aspects } = data;

  const svgSelection = d3
    .select(container)
    .append("svg")
    .attr("viewBox", `${-CENTER} ${-CENTER} ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`)
    .attr("role", "img");

  svgSelection.append("title").text("Natal and transit zodiac wheel");
  svgSelection.append("desc").text(describeChart(natal, transits, aspects));

  const arcGenerator = d3
    .arc<SignWedgeDatum>()
    .innerRadius(SIGN_RING_INNER_RADIUS)
    .outerRadius(SIGN_RING_OUTER_RADIUS);

  svgSelection
    .append("g")
    .attr("class", "zodiac-wheel-signs")
    .selectAll("path")
    .data(signWedges())
    .join("path")
    .attr("d", (wedge) => arcGenerator(wedge))
    .attr("fill", (_wedge, index) => SIGN_WEDGE_FILLS[index % SIGN_WEDGE_FILLS.length] ?? "#1c1330")
    .attr("stroke", RING_GUIDE_COLOR)
    .attr("stroke-width", 1);

  svgSelection
    .append("g")
    .attr("class", "zodiac-wheel-sign-labels")
    .selectAll("text")
    .data(signWedges())
    .join("text")
    .attr("x", (wedge) => angleToPoint(wedge.startAngle + (wedge.endAngle - wedge.startAngle) / 2, SIGN_LABEL_RADIUS).x)
    .attr("y", (wedge) => angleToPoint(wedge.startAngle + (wedge.endAngle - wedge.startAngle) / 2, SIGN_LABEL_RADIUS).y)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("font-size", 12)
    .attr("fill", SIGN_LABEL_COLOR)
    .text((wedge) => wedge.sign);

  svgSelection
    .append("g")
    .attr("class", "zodiac-wheel-ring-guides")
    .selectAll("circle")
    .data([TRANSIT_RING_RADIUS, NATAL_RING_RADIUS])
    .join("circle")
    .attr("cx", 0)
    .attr("cy", 0)
    .attr("r", (radius) => radius)
    .attr("fill", "none")
    .attr("stroke", RING_GUIDE_COLOR)
    .attr("stroke-width", 1);

  const aspectLinesGroup = svgSelection.append("g").attr("class", "zodiac-wheel-aspect-lines");
  aspectLinesGroup
    .selectAll("line")
    .data(aspects)
    .join("line")
    .attr("x1", (aspect) => angleToPoint(angleScale(transits.bodies[aspect.transit].longitude), TRANSIT_RING_RADIUS).x)
    .attr("y1", (aspect) => angleToPoint(angleScale(transits.bodies[aspect.transit].longitude), TRANSIT_RING_RADIUS).y)
    .attr("x2", (aspect) => angleToPoint(angleScale(natal.bodies[aspect.natal].longitude), NATAL_RING_RADIUS).x)
    .attr("y2", (aspect) => angleToPoint(angleScale(natal.bodies[aspect.natal].longitude), NATAL_RING_RADIUS).y)
    .attr("stroke", (aspect) => aspectColorScale(ASPECT_CATEGORY[aspect.aspect]))
    .attr("stroke-width", 1.5)
    .attr("opacity", 0.75);

  const natalGroup = svgSelection.append("g").attr("class", "zodiac-wheel-natal-bodies");
  for (const body of TRANSIT_BODIES) {
    renderNatalMarker(natalGroup, body, natal.bodies[body]);
  }

  const transitGroup = svgSelection.append("g").attr("class", "zodiac-wheel-transit-bodies");
  for (const body of TRANSIT_BODIES) {
    renderTransitMarker(transitGroup, body, transits.bodies[body]);
  }

  const svgNode = svgSelection.node();
  if (svgNode === null) {
    throw new Error("renderZodiacWheel: failed to create the svg element");
  }
  return svgNode;
}

function renderNatalMarker(
  group: d3.Selection<SVGGElement, unknown, null, undefined>,
  body: TransitBodyName,
  position: NatalBodyPosition,
): void {
  const point = angleToPoint(angleScale(position.longitude), NATAL_RING_RADIUS);
  const bodyGroup = group.append("g").attr("transform", `translate(${point.x}, ${point.y})`);

  const circle = bodyGroup.append("circle").attr("r", MARKER_RADIUS);
  if (position.ambiguous) {
    circle.attr("fill", "none").attr("stroke", AMBIGUOUS_MARKER_STROKE).attr("stroke-width", 1.5).attr("stroke-dasharray", "3 2");
  } else {
    circle.attr("fill", NATAL_MARKER_FILL);
  }

  bodyGroup
    .append("text")
    .attr("x", 0)
    .attr("y", -MARKER_RADIUS - 3)
    .attr("text-anchor", "middle")
    .attr("font-size", 10)
    .attr("fill", NATAL_MARKER_FILL)
    .text(BODY_ABBREVIATIONS[body]);
}

function renderTransitMarker(
  group: d3.Selection<SVGGElement, unknown, null, undefined>,
  body: TransitBodyName,
  position: BodyPosition,
): void {
  const point = angleToPoint(angleScale(position.longitude), TRANSIT_RING_RADIUS);
  const bodyGroup = group.append("g").attr("transform", `translate(${point.x}, ${point.y})`);

  bodyGroup.append("circle").attr("r", MARKER_RADIUS).attr("fill", TRANSIT_MARKER_FILL);

  bodyGroup
    .append("text")
    .attr("x", 0)
    .attr("y", -MARKER_RADIUS - 3)
    .attr("text-anchor", "middle")
    .attr("font-size", 10)
    .attr("fill", TRANSIT_MARKER_FILL)
    .text(BODY_ABBREVIATIONS[body]);

  if (position.retrograde) {
    bodyGroup
      .append("text")
      .attr("x", MARKER_RADIUS + 3)
      .attr("y", MARKER_RADIUS)
      .attr("font-size", 11)
      .attr("fill", RETROGRADE_LABEL_COLOR)
      .text("℞");
  }
}
