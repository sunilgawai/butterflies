/**
 * Blue-noise point sampling over a binary mask.
 *
 * Given the pixels a glyph actually inks, this picks `count` of them that are
 * all at least `minDistance` apart. That guarantee is the whole point: the
 * butterflies get their slots from this, so "they must not overlap" stops being
 * a force that fights itself and becomes a property of the arrangement.
 *
 * Dart-throwing over a shuffled candidate list, which is O(P) rather than the
 * O(P·k) of a naive radius scan: a uniform grid with cells of minDistance/√2
 * holds at most one accepted point each, so a 5×5 block of cells covers every
 * point that could possibly be too close.
 *
 * Pure arithmetic over typed arrays — no canvas, no DOM — so it is testable in
 * plain Node, which is where its guarantee is actually checked.
 */

/**
 * Fraction of the theoretical hexagonal-packing density that dart-throwing
 * actually reaches. Random sequential adsorption jams at roughly 0.70/d² points
 * per unit area against hexagonal packing's 1.155/d², so the honest figure is
 * about 0.60. Deliberately rounded down: this number's job is to predict a
 * spacing that *will* fit, and an optimistic estimate shows up as a word that
 * quietly comes out denser than asked for.
 */
export const PACKING_EFFICIENCY = 0.6;

/**
 * Minimum spacing that should fit `count` points into `area`.
 * The inverse of the density relation above, and the reason the caller can size
 * a word before sampling it rather than by trial and error.
 */
export const spacingForArea = (area, count) =>
  count > 0 ? Math.sqrt((PACKING_EFFICIENCY * area) / count) : 0;

/** In-place Fisher-Yates, so candidate order carries no bias from the raster. */
function shuffle(list, length, rng) {
  for (let i = length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
}

/**
 * Reorders already-shuffled candidates by descending priority, stably — so
 * equal priorities keep their random order.
 *
 * Dart-throwing accepts candidates in the order it is given them, so this is the
 * whole mechanism by which a word stays readable: hand it the deep interior of
 * each stroke first and the points land along a centreline, hand it a shuffle
 * and they scatter across the stroke's width instead.
 *
 * A counting sort, because priorities are small integers and there may be a
 * hundred thousand candidates.
 */
function orderByPriority(candidates, count, priority, maxPriority, scratch) {
  const buckets = new Int32Array(maxPriority + 2);

  // Key ascending on (max - priority) gives descending priority.
  for (let i = 0; i < count; i++) buckets[maxPriority - priority[candidates[i]]]++;

  let running = 0;
  for (let b = 0; b <= maxPriority + 1; b++) {
    const size = buckets[b];
    buckets[b] = running;
    running += size;
  }

  for (let i = 0; i < count; i++) {
    const index = candidates[i];
    scratch[buckets[maxPriority - priority[index]]++] = index;
  }

  candidates.set(scratch.subarray(0, count));
}

/**
 * One dart-throwing pass.
 *
 * @param {Int32Array} candidates flat pixel indices, pre-shuffled
 * @param {number} candidateCount how many of `candidates` are valid
 * @param {number} width mask width, to turn an index back into x/y
 * @param {number} height mask height, to size the lookup grid
 * @param {number} minDistance in pixels
 * @param {number} limit stop once this many points are accepted
 * @param {Float32Array} out xy pairs, length >= limit * 2
 * @returns {number} how many points were accepted
 */
function dartThrow(candidates, candidateCount, width, height, minDistance, limit, out) {
  const cell = minDistance / Math.SQRT2; // at most one accepted point per cell
  const inverseCell = 1 / cell;
  const minDistance2 = minDistance * minDistance;

  // The grid spans the mask; +1 for the fencepost at the far edge.
  const gridW = Math.ceil(width * inverseCell) + 1;
  const gridH = Math.ceil(height * inverseCell) + 1;

  const grid = new Int32Array(gridW * gridH).fill(-1);

  let accepted = 0;

  for (let i = 0; i < candidateCount && accepted < limit; i++) {
    const index = candidates[i];
    const x = index % width;
    const y = (index / width) | 0;

    const gx = (x * inverseCell) | 0;
    const gy = (y * inverseCell) | 0;

    let free = true;

    // 5×5 block reaches 2 cells = √2·minDistance, so nothing closer is missed.
    for (let oy = -2; oy <= 2 && free; oy++) {
      const ny = gy + oy;
      if (ny < 0 || ny >= gridH) continue;
      const row = ny * gridW;

      for (let ox = -2; ox <= 2; ox++) {
        const nx = gx + ox;
        if (nx < 0 || nx >= gridW) continue;

        const slot = grid[row + nx];
        if (slot < 0) continue;

        const dx = x - out[slot * 2];
        const dy = y - out[slot * 2 + 1];
        if (dx * dx + dy * dy < minDistance2) {
          free = false;
          break;
        }
      }
    }

    if (!free) continue;

    out[accepted * 2] = x;
    out[accepted * 2 + 1] = y;
    grid[gy * gridW + gx] = accepted;
    accepted++;
  }

  return accepted;
}

/**
 * Samples up to `count` well-spaced points from the inked pixels of a mask.
 *
 * Starts at `minDistance` and relaxes it in steps if the mask cannot hold that
 * many points that far apart — so the caller always gets the count it asked
 * for, and is told, in `spacing`, what that cost. A caller that needs the
 * spacing honoured should size its geometry from `spacing`, not from the
 * requested value.
 *
 * @param {Uint8Array} mask width*height, non-zero where the glyph inks
 * @param {number} width
 * @param {number} height
 * @param {object} options
 * @param {number} options.count how many points are wanted
 * @param {number} options.minDistance starting spacing, in pixels
 * @param {Function} options.rng () => [0,1)
 * @param {Int32Array} [options.priority] per-pixel preference; higher goes first
 * @param {number} [options.maxPriority] the largest value in `priority`
 * @param {number} [options.relaxation] multiplier applied per retry
 * @param {number} [options.maxPasses]
 * @returns {{points: Float32Array, count: number, spacing: number, passes: number}}
 */
export function samplePoints(mask, width, height, options) {
  const {
    count,
    minDistance,
    rng,
    priority = null,
    maxPriority = 0,
    relaxation = 0.88,
    maxPasses = 8,
  } = options;

  const total = width * height;
  const candidates = new Int32Array(total);
  let candidateCount = 0;
  for (let i = 0; i < total; i++) {
    if (mask[i]) candidates[candidateCount++] = i;
  }

  const out = new Float32Array(Math.max(count, 1) * 2);

  if (candidateCount === 0 || count <= 0) {
    return { points: out, count: 0, spacing: minDistance, passes: 0 };
  }

  shuffle(candidates, candidateCount, rng);

  if (priority !== null && maxPriority > 0) {
    orderByPriority(candidates, candidateCount, priority, maxPriority, new Int32Array(candidateCount));
  }

  // The inked pixel count *is* the available area, so the largest spacing that
  // can hold `count` points is known up front. Starting there instead of at the
  // requested value means the usual case succeeds on the first pass, and an
  // impossible request degrades in one step rather than eight.
  const feasible = spacingForArea(candidateCount, count);
  let spacing = Math.max(Math.min(minDistance, feasible), 0.5);
  let accepted = 0;
  let passes = 0;

  // Concave masks pack slightly worse than the area estimate predicts — a glyph
  // is mostly edges — so relax if the first pass still falls short. Each pass
  // reuses the same shuffled order, so the result only ever gains points.
  for (; passes < maxPasses; passes++) {
    accepted = dartThrow(candidates, candidateCount, width, height, spacing, count, out);
    if (accepted >= count || spacing <= 0.75) break;
    spacing = Math.max(0.75, spacing * relaxation);
  }

  return { points: out, count: accepted, spacing, passes: passes + 1 };
}
