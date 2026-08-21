import { samplePoints, PACKING_EFFICIENCY } from './blueNoise.js';
import { distanceField } from './distanceField.js';

/**
 * Turns a string into a set of world-space points a swarm can stand on.
 *
 * The browser does the hard part. Rasterising through canvas means every script
 * the system has a font for — Devanagari, Arabic, Thai, CJK — arrives correctly
 * shaped and laid out for free, which no hand-rolled glyph path would manage.
 * We only read back which pixels ended up inked.
 *
 * The sizing runs backwards from the butterflies, not from the type. Given how
 * many of them there are and how far apart they must stay, there is exactly one
 * word size whose inked area holds them all:
 *
 *     inkArea(world) = count · spacing² / PACKING_EFFICIENCY
 *     worldPerPixel  = √( inkArea(world) / inkPixels )
 *
 * So the word is scaled to the swarm rather than the swarm being crammed into
 * the word. Only when that size overflows the frame does anything give — and
 * then it is the spacing, reported back so the caller can shrink the
 * butterflies to match and keep them from overlapping anyway.
 */

const FALLBACK_STACK =
  'system-ui, -apple-system, "Segoe UI", "Noto Sans", "Helvetica Neue", Arial, sans-serif';

/**
 * Heavy on purpose. A word is legible here in proportion to how much ink it has
 * per unit of stroke length, and the boldest weight available is the cheapest way
 * to buy that — the difference between a readable word and a suggestion of one.
 */
const DEFAULT_WEIGHT = 900;

/** Alpha above which a pixel counts as inked. Antialiased edges are excluded. */
const INK_THRESHOLD = 110;

/** Below this there is no glyph — a missing font, or a string of nothing. */
const MIN_INK_PIXELS = 400;

/**
 * A codepoint no font has a glyph for. Measuring against it is how we find out
 * whether this system can actually draw a script: a missing glyph is not blank,
 * it is a tofu box, which has plenty of ink and would happily be spelled out by
 * a swarm of butterflies as a row of rectangles.
 */
const NOTDEF = '\uFFFF';

export class TextSampler {
  constructor({ fontStack = FALLBACK_STACK, weight = DEFAULT_WEIGHT, fontSize = 180 } = {}) {
    this.fontStack = fontStack;
    this.weight = weight;
    this.fontSize = fontSize;

    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * Can this system draw every glyph in `text`?
   *
   * Substituted glyphs all come out as the same tofu box with the same advance,
   * so a string measures glyph-for-glyph identical to a codepoint that certainly
   * has no glyph. Deliberately conservative — it only rejects a string when
   * *every* glyph looks like tofu, which is the case that matters (a whole script
   * missing) and cannot be a coincidence. A word where one mark happens to share
   * the notdef advance is left alone rather than wrongly thrown away.
   */
  supports(text) {
    const ctx = this.context;
    ctx.font = `${this.weight} ${this.fontSize}px ${this.fontStack}`;

    const notdef = ctx.measureText(NOTDEF).width;
    if (notdef === 0) return true; // nothing to compare against; let the ink check decide

    for (const glyph of text) {
      if (glyph === ' ') continue;
      if (Math.abs(ctx.measureText(glyph).width - notdef) > 0.5) return true;
    }

    return false;
  }

  /** Waits for system fonts to settle, so the first word is not measured early. */
  static async ready() {
    try {
      await document.fonts?.ready;
    } catch {
      /* Font Loading API is optional; system fonts are there regardless. */
    }
  }

  /**
   * Rasterises `text` and returns the inked mask plus its tight bounding box.
   * The box comes from the pixels, not from TextMetrics: metrics disagree with
   * the raster often enough (and by enough) to skew the sizing.
   */
  rasterise(text) {
    const { context: ctx, canvas } = this;
    const font = `${this.weight} ${this.fontSize}px ${this.fontStack}`;

    // Measure on a correctly-sized context before committing to canvas dimensions.
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const pad = Math.ceil(this.fontSize * 0.5);
    const width = Math.ceil(metrics.width + pad * 2) || pad * 2;
    const height = Math.ceil(this.fontSize * 2.2) + pad * 2;

    canvas.width = width;
    canvas.height = height;

    // Resizing a canvas resets its context state, so the font is set again.
    ctx.clearRect(0, 0, width, height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, width / 2, height / 2);

    const pixels = ctx.getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);

    let inkPixels = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (pixels[i * 4 + 3] < INK_THRESHOLD) continue;
        mask[i] = 1;
        inkPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (inkPixels < MIN_INK_PIXELS) return null;

    return {
      mask,
      width,
      height,
      inkPixels,
      boxX: minX,
      boxY: minY,
      boxWidth: maxX - minX + 1,
      boxHeight: maxY - minY + 1,
    };
  }

  /**
   * Samples `text` into world-space slots centred on the origin.
   *
   * The returned `strokeRatio` is how many butterflies fit across a typical
   * stroke. It is the one number that predicts whether the word will be readable,
   * and it cannot be known in advance: it depends on the script. Eight Latin
   * letters and two Chinese characters can carry the same glyph count and the same
   * width while differing threefold in total stroke length — so the caller is
   * given the measurement and decides.
   *
   * @param {string} text
   * @param {object} options
   * @param {number} options.count how many slots are needed
   * @param {number} options.spacing the world-space gap to aim for
   * @param {number} options.maxWidth world extents the word must fit inside
   * @param {number} options.maxHeight
   * @param {number} options.depth ± world z given to the word, for volume
   * @param {Function} options.rng
   * @returns {?{points: Float32Array, count: number, spacing: number, width: number,
   *             height: number, strokeRatio: number}}
   */
  sample(text, { count, spacing, maxWidth, maxHeight, depth = 0, rng }) {
    const raster = this.rasterise(text);
    if (raster === null || count <= 0) return null;

    const { mask, width, height, inkPixels, boxX, boxY, boxWidth, boxHeight } = raster;

    // Size the word so its ink can hold `count` points `spacing` apart.
    const requiredInkArea = (count * spacing * spacing) / PACKING_EFFICIENCY;
    const idealWorldPerPixel = Math.sqrt(requiredInkArea / inkPixels);

    // Then give way to the frame. Both the word and the spacing shrink together,
    // which is what lets the caller keep the butterflies proportional.
    const fit = Math.min(
      1,
      maxWidth / (boxWidth * idealWorldPerPixel),
      maxHeight / (boxHeight * idealWorldPerPixel),
    );
    const worldPerPixel = idealWorldPerPixel * fit;

    // Pixel spacing is invariant under that fit — both terms carry the same
    // factor — so it is derived from the ideal scale.
    const spacingPixels = spacing / idealWorldPerPixel;

    // Depth inside the stroke decides who gets placed first. With barely two
    // butterflies across a stroke, that ordering is the difference between a
    // letter and a smudge — they line up along the spine instead of straggling
    // across the width and off the edges.
    const depthInStroke = distanceField(mask, width, height);

    const sampled = samplePoints(mask, width, height, {
      count,
      minDistance: spacingPixels,
      rng,
      priority: depthInStroke.field,
      maxPriority: depthInStroke.max,
    });
    if (sampled.count === 0) return null;

    const centreX = boxX + boxWidth / 2;
    const centreY = boxY + boxHeight / 2;

    const points = new Float32Array(sampled.count * 3);
    for (let i = 0; i < sampled.count; i++) {
      const px = sampled.points[i * 2];
      const py = sampled.points[i * 2 + 1];

      const x = (px - centreX) * worldPerPixel;
      const y = -(py - centreY) * worldPerPixel; // canvas y runs down, world runs up

      // A shallow fold across the word so it reads as a cloud with a front and a
      // back rather than a decal, without ever hiding a letter behind another.
      const z = Math.sin(x * 0.42 + 0.7) * depth * 0.55 + (rng() * 2 - 1) * depth * 0.45;

      points[i * 3] = x;
      points[i * 3 + 1] = y;
      points[i * 3 + 2] = z;
    }

    return {
      points,
      count: sampled.count,
      spacing: sampled.spacing * worldPerPixel,
      width: boxWidth * worldPerPixel,
      height: boxHeight * worldPerPixel,
      strokeRatio: meanStrokeWidth(depthInStroke.field, mask) / sampled.spacing,
    };
  }
}

/**
 * Mean stroke width across the ink, in pixels.
 *
 * The distance transform gives every pixel its distance to the nearest edge, so
 * the mean of that over a stroke is a quarter of its width (averaging a linear
 * ramp from 0 at each edge to half-width at the centre) — hence the factor of
 * four. Cheap, and robust across scripts in a way that counting glyphs is not.
 */
function meanStrokeWidth(field, mask) {
  let sum = 0;
  let inked = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    sum += field[i];
    inked++;
  }
  if (inked === 0) return 0;
  // Field units are thirds of a pixel.
  return (4 * (sum / inked)) / 3;
}
