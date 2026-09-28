/**
 * Reusable canvas-based "deep-fry meme" image filter, shared by the splash
 * (brownie) and gate (stop sign) screens.
 */

const DEFAULT_PASSES = 4;
const RECOMPRESS_QUALITY = 0.08;
const NOISE_AMOUNT = 35;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`deepFry: failed to load image at ${url}`));
    image.src = url;
  });
}

function require2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("deepFry: 2D canvas context unavailable");
  }
  return ctx;
}

function addNoise(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const offset = (Math.random() - 0.5) * NOISE_AMOUNT;
    // Indices i, i+1, i+2 are R, G, B (i+3 is alpha, left untouched); TypeScript
    // can't prove these array accesses are in-bounds, hence the `?? 0` fallbacks
    // to satisfy noUncheckedIndexedAccess without changing the pixel math.
    pixels[i] = clampChannel((pixels[i] ?? 0) + offset);
    pixels[i + 1] = clampChannel((pixels[i + 1] ?? 0) + offset);
    pixels[i + 2] = clampChannel((pixels[i + 2] ?? 0) + offset);
  }
  ctx.putImageData(imageData, 0, 0);
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

/**
 * Loads `imageUrl`, boosts saturation/contrast/brightness, adds a dusting of
 * per-pixel noise, then runs `opts?.passes ?? 3` rounds of aggressive JPEG
 * re-compression -- the standard "deep-fry meme" technique, where repeatedly
 * saving a lossy JPEG at a very low quality (0.15) compounds its compression
 * artifacts each pass instead of just re-applying the same ones. Resolves
 * with the final frame as a JPEG data URL.
 */
export function deepFry(imageUrl: string, opts?: { passes?: number }): Promise<string> {
  const passes = opts?.passes ?? DEFAULT_PASSES;

  return loadImage(imageUrl).then((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = require2dContext(canvas);

    // `ctx.filter` only affects pixels drawn *after* it is set -- it does not
    // retroactively reprocess whatever is already on the canvas -- so it must
    // be assigned before this first (and only) `drawImage` of the source photo.
    ctx.filter = "saturate(5.5) contrast(2.2) brightness(1.15)";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";

    addNoise(ctx, canvas.width, canvas.height);

    return recompress(canvas, ctx, passes);
  });
}

function recompress(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  remainingPasses: number,
): Promise<string> {
  const dataUrl = canvas.toDataURL("image/jpeg", RECOMPRESS_QUALITY);
  if (remainingPasses <= 1) {
    return Promise.resolve(dataUrl);
  }
  return loadImage(dataUrl).then((reloaded) => {
    ctx.drawImage(reloaded, 0, 0, canvas.width, canvas.height);
    return recompress(canvas, ctx, remainingPasses - 1);
  });
}
