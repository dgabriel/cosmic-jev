/**
 * Canvas 2D star-particle field for the "black screen, star field fades in,
 * swirls and resolves" beats (bar-napkin "Cosmic spec"). Canvas (not SVG/DOM)
 * because hundreds of particles redrawing every frame is exactly the case
 * SVG/DOM-bound transitions handle poorly; D3 supplies the math and timing
 * (`d3.timer` as the single animation driver rather than a raw
 * `requestAnimationFrame` loop, so every animation in this module goes
 * through one library, per the project's "heavy use of D3" instruction).
 */
import { easeCubicInOut, interpolate, randomNormal, randomUniform, scaleLinear, timer as startTimer } from "d3";
import type { Timer } from "d3";
import { CONSTELLATIONS } from "../constellations";
import type { Sign } from "../../sky";

const PARTICLE_COUNT = 220;

/**
 * Depth (0 = farthest, 1 = closest) maps to both radius and opacity via the
 * same `d3.scaleLinear` domain: a single "distance from viewer" value drives
 * two visually-linked properties (closer stars read as both bigger *and*
 * brighter), rather than picking size and opacity independently, which would
 * produce dim-but-huge or tiny-but-blazing particles that don't read as depth.
 */
const MIN_RADIUS_PX = 0.4;
const MAX_RADIUS_PX = 2.2;
const MIN_OPACITY = 0.15;
const MAX_OPACITY = 1;

/** How much bigger/brighter a resolved constellation's own stars read versus the unlit background field, so the shape is legible at a glance. */
const CONSTELLATION_RADIUS_MULTIPLIER = 2.2;
const CONSTELLATION_OPACITY_FLOOR = 0.9;
/** Constellation lines are deliberately faint -- a hint of the connect-the-dots shape, not a bright diagram overpowering the stars themselves. */
const CONSTELLATION_LINE_COLOR = "#f5f7ff";
const CONSTELLATION_LINE_OPACITY = 0.35;
/** Fraction of min(width, height) the constellation's longer axis is scaled to fill. */
const CONSTELLATION_EXTENT_RATIO = 0.6;

/** Stars never fully vanish mid-twinkle; this is the floor of the twinkle multiplier. */
const TWINKLE_FLOOR = 0.4;
const TWINKLE_PERIOD_MS = 2200;

/** Range of extra full turns each particle spirals through before converging, for an organic (not laser-straight) swirl. */
const SPIRAL_TURNS_MIN = 1.5;
const SPIRAL_TURNS_MAX = 3;

const STAR_COLOR = "#f5f7ff";
/** "Cosmic latte" (#FFF8E7) -- the actual, measured average color of the universe -- reads as a warm off-white distinct from the cool-white background field, so a resolved constellation's own stars pop visually as well as by size/brightness. */
const CONSTELLATION_STAR_COLOR = "#fff8e7";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Particle {
  x: number;
  y: number;
  depth: number;
  radiusPx: number;
  baseOpacity: number;
  twinklePhase: number;
  twinkleSpeed: number;
  spiralTurns: number;
  angleInterpolator: (t: number) => number;
  radiusInterpolator: (t: number) => number;
  /** The point each particle's angle/radius interpolators are relative to -- the shared canvas center for the plain swirl, or this particle's own assigned constellation point (or, for background particles during a constellation swirl, just wherever it already was, so it's a no-op). */
  swirlCenterX: number;
  swirlCenterY: number;
  /** Set once a constellation swirl assigns this particle to be one of the shape's own stars; drawn bigger/brighter so the shape reads clearly against the background field. */
  isConstellationStar: boolean;
}

interface ResolvedConstellation {
  particles: readonly Particle[];
  segments: readonly (readonly [number, number])[];
}

type Phase =
  | { kind: "idle" }
  | { kind: "fade-in"; start: number; duration: number; resolve: () => void }
  | {
      kind: "swirl";
      start: number;
      duration: number;
      onResolve: () => void;
      resolve: () => void;
      fired: boolean;
    };

export interface StarfieldHandle {
  fadeIn(durationMs: number): Promise<void>;
  swirlAndResolve(durationMs: number, onResolve: () => void): Promise<void>;
  /**
   * Expands a subset of the field's own particles into the real constellation
   * shape for `sign` (../constellations.ts) and lets them stay lit as
   * connected stars; every other particle is left alone as an ordinary
   * twinkling background.
   */
  swirlIntoShape(sign: Sign, durationMs: number): Promise<void>;
  destroy(): void;
}

export function mountStarfield(container: HTMLElement): StarfieldHandle {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  // Purely decorative and never needs its own pointer events, but being
  // absolutely positioned means it paints (and hit-tests) *above* any
  // normal-flow sibling per CSS stacking rules, regardless of DOM order --
  // without this, it silently swallows clicks aimed at whatever's rendered
  // on top of it once it's kept alive alongside real UI (e.g. the Again
  // button, once the constellation stays lit through the final reveal).
  canvas.style.pointerEvents = "none";
  container.append(canvas);

  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("mountStarfield: 2D canvas context unavailable");
  }
  // Re-bound to a name TypeScript can keep narrowed to non-null inside the
  // closures below (the nested `resize`/`draw` functions are declared, not
  // called, before `context`'s null check would otherwise "escape" scope).
  const ctx: CanvasRenderingContext2D = context;

  let width = 0;
  let height = 0;
  let destroyed = false;
  let fadeAlpha = 0;
  let lastElapsed = 0;
  let phase: Phase = { kind: "idle" };
  let resolvedConstellation: ResolvedConstellation | null = null;

  const radiusScale = scaleLinear().domain([0, 1]).range([MIN_RADIUS_PX, MAX_RADIUS_PX]);
  const opacityScale = scaleLinear().domain([0, 1]).range([MIN_OPACITY, MAX_OPACITY]);

  const particles: Particle[] = [];

  function resize(): void {
    const rect = container.getBoundingClientRect();
    const previousWidth = width;
    const previousHeight = height;
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (particles.length === 0) {
      const randX = randomUniform(0, width);
      const randY = randomUniform(0, height);
      const randDepth = randomUniform(0, 1);
      const randTwinklePhase = randomUniform(0, Math.PI * 2);
      // `randomNormal` centered on 1 so most particles twinkle near the base
      // rate but a few run visibly faster/slower -- the per-particle variety
      // the "not all particles pulse in sync" requirement calls for, distinct
      // from the uniform phase offset above.
      const randTwinkleSpeed = randomNormal(1, 0.25);
      const randSpiralTurns = randomUniform(SPIRAL_TURNS_MIN, SPIRAL_TURNS_MAX);
      const identity = interpolate(0, 0);

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const depth = randDepth();
        const x = randX();
        const y = randY();
        particles.push({
          x,
          y,
          depth,
          radiusPx: radiusScale(depth),
          baseOpacity: opacityScale(depth),
          twinklePhase: randTwinklePhase(),
          twinkleSpeed: Math.min(1.8, Math.max(0.4, randTwinkleSpeed())),
          spiralTurns: randSpiralTurns(),
          angleInterpolator: identity,
          radiusInterpolator: identity,
          swirlCenterX: x,
          swirlCenterY: y,
          isConstellationStar: false,
        });
      }
      return;
    }

    // Simple proportional rescale on resize (no re-scatter): keeps each
    // particle's relative position stable instead of the visible "jump" a
    // full re-randomization would cause mid-animation. Resolved constellation
    // stars rescale the same way as everything else, so the shape just scales
    // with the canvas rather than snapping back out of formation.
    if (previousWidth > 0 && previousHeight > 0) {
      const scaleX = width / previousWidth;
      const scaleY = height / previousHeight;
      for (const particle of particles) {
        particle.x *= scaleX;
        particle.y *= scaleY;
        particle.swirlCenterX *= scaleX;
        particle.swirlCenterY *= scaleY;
      }
    }
  }

  resize();

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(container);

  /** `targetFor` returns each particle's own swirl center -- shared canvas center for the plain swirl, or a specific constellation point (or its own current position, i.e. a no-op) per particle otherwise. */
  function beginSwirl(targetFor: (particle: Particle) => { x: number; y: number }): void {
    for (const particle of particles) {
      const target = targetFor(particle);
      const dx = particle.x - target.x;
      const dy = particle.y - target.y;
      const fromRadius = Math.hypot(dx, dy);
      const fromAngle = Math.atan2(dy, dx);
      const toAngle = fromAngle + particle.spiralTurns * Math.PI * 2;
      particle.swirlCenterX = target.x;
      particle.swirlCenterY = target.y;
      particle.radiusInterpolator = interpolate(fromRadius, 0);
      particle.angleInterpolator = interpolate(fromAngle, toAngle);
    }
  }

  function updatePhase(elapsed: number): void {
    if (phase.kind === "fade-in") {
      const t = clamp01((elapsed - phase.start) / phase.duration);
      fadeAlpha = t;
      if (t >= 1) {
        const { resolve } = phase;
        phase = { kind: "idle" };
        resolve();
      }
      return;
    }

    if (phase.kind === "swirl") {
      const t = clamp01((elapsed - phase.start) / phase.duration);
      const eased = easeCubicInOut(t);
      for (const particle of particles) {
        const angle = particle.angleInterpolator(eased);
        const radius = particle.radiusInterpolator(eased);
        particle.x = particle.swirlCenterX + radius * Math.cos(angle);
        particle.y = particle.swirlCenterY + radius * Math.sin(angle);
      }
      if (t >= 1 && !phase.fired) {
        phase.fired = true;
        const { onResolve, resolve } = phase;
        phase = { kind: "idle" };
        onResolve();
        resolve();
      }
    }
  }

  function drawConstellationLines(): void {
    if (resolvedConstellation === null) return;
    const { particles: shapeParticles, segments } = resolvedConstellation;
    ctx.globalAlpha = fadeAlpha * CONSTELLATION_LINE_OPACITY;
    ctx.strokeStyle = CONSTELLATION_LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [fromIndex, toIndex] of segments) {
      const from = shapeParticles[fromIndex];
      const to = shapeParticles[toIndex];
      if (from === undefined || to === undefined) continue;
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
  }

  function draw(elapsed: number): void {
    ctx.clearRect(0, 0, width, height);
    drawConstellationLines();
    for (const particle of particles) {
      const twinkle =
        TWINKLE_FLOOR +
        (1 - TWINKLE_FLOOR) *
          (0.5 +
            0.5 *
              Math.sin(
                (elapsed / TWINKLE_PERIOD_MS) * particle.twinkleSpeed * Math.PI * 2 + particle.twinklePhase,
              ));
      const opacityFloor = particle.isConstellationStar ? CONSTELLATION_OPACITY_FLOOR : 0;
      const opacity = fadeAlpha * Math.max(particle.baseOpacity * twinkle, opacityFloor);
      if (opacity <= 0) continue;
      const radius = particle.isConstellationStar ? particle.radiusPx * CONSTELLATION_RADIUS_MULTIPLIER : particle.radiusPx;
      ctx.globalAlpha = opacity;
      ctx.fillStyle = particle.isConstellationStar ? CONSTELLATION_STAR_COLOR : STAR_COLOR;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // A single persistent `d3.timer` drives every frame for the handle's whole
  // lifetime; `fadeIn`/`swirlAndResolve`/`swirlIntoShape` just install a
  // `Phase` for it to advance, rather than starting/stopping their own
  // timers, so there is exactly one animation driver per the "d3.timer, not
  // raw rAF" instruction.
  const driver: Timer = startTimer((elapsed) => {
    lastElapsed = elapsed;
    updatePhase(elapsed);
    draw(elapsed);
  });

  function fadeIn(durationMs: number): Promise<void> {
    if (destroyed) return Promise.resolve();
    if (prefersReducedMotion()) {
      fadeAlpha = 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      phase = { kind: "fade-in", start: lastElapsed, duration: Math.max(durationMs, 1), resolve };
    });
  }

  function swirlAndResolve(durationMs: number, onResolve: () => void): Promise<void> {
    if (destroyed) {
      onResolve();
      return Promise.resolve();
    }
    const centerTarget = (): { x: number; y: number } => ({ x: width / 2, y: height / 2 });
    if (prefersReducedMotion()) {
      const center = centerTarget();
      for (const particle of particles) {
        particle.x = center.x;
        particle.y = center.y;
      }
      onResolve();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      beginSwirl(centerTarget);
      phase = {
        kind: "swirl",
        start: lastElapsed,
        duration: Math.max(durationMs, 1),
        onResolve,
        resolve,
        fired: false,
      };
    });
  }

  function assignConstellation(sign: Sign): { targetFor: (particle: Particle) => { x: number; y: number } } {
    const shape = CONSTELLATIONS[sign];
    const extent = Math.min(width, height) * CONSTELLATION_EXTENT_RATIO;
    const centerX = width / 2;
    const centerY = height / 2;
    const shapeParticles = particles.slice(0, shape.points.length);

    for (const particle of particles) {
      particle.isConstellationStar = false;
    }

    const targetOf = new Map<Particle, { x: number; y: number }>();
    shapeParticles.forEach((particle, index) => {
      const point = shape.points[index];
      if (point === undefined) return;
      const [nx, ny] = point;
      particle.isConstellationStar = true;
      targetOf.set(particle, { x: centerX + nx * extent, y: centerY + ny * extent });
    });

    resolvedConstellation = { particles: shapeParticles, segments: shape.segments };

    return {
      targetFor: (particle) => targetOf.get(particle) ?? { x: particle.x, y: particle.y },
    };
  }

  /** One swirl phase to `targetFor`'s positions, resolving (with no `onResolve` callback) once it settles -- the building block `swirlIntoShape` uses to animate into a constellation's positions. */
  function swirlOnce(targetFor: (particle: Particle) => { x: number; y: number }, durationMs: number): Promise<void> {
    if (destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      beginSwirl(targetFor);
      phase = {
        kind: "swirl",
        start: lastElapsed,
        duration: Math.max(durationMs, 1),
        onResolve: () => {},
        resolve,
        fired: false,
      };
    });
  }

  function swirlIntoShape(sign: Sign, durationMs: number): Promise<void> {
    if (destroyed) return Promise.resolve();
    const { targetFor } = assignConstellation(sign);
    if (prefersReducedMotion()) {
      for (const particle of particles) {
        const target = targetFor(particle);
        particle.x = target.x;
        particle.y = target.y;
      }
      return Promise.resolve();
    }
    return swirlOnce(targetFor, durationMs);
  }

  function destroy(): void {
    destroyed = true;
    driver.stop();
    resizeObserver.disconnect();
    canvas.remove();
  }

  return { fadeIn, swirlAndResolve, swirlIntoShape, destroy };
}
