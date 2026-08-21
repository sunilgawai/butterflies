/**
 * Distance from each inked pixel to the nearest edge of the ink.
 *
 * This is what lets a word stay legible with barely two butterflies across a
 * stroke. Sampled at random, points scatter across a stroke's width and read as
 * noise; ordered by depth-inside-the-stroke, they land along its centreline
 * first and the letter survives with far fewer of them.
 *
 * A two-pass chamfer transform with 3-4 weights: not the exact Euclidean
 * distance, but within a few percent of it, and only two linear sweeps. Exactness
 * would not buy anything here — the result is used to *order* candidates, and an
 * ordering does not care about a percent.
 *
 * Units are thirds of a pixel (the orthogonal step is 3), so the caller
 * multiplies by 1/3 to get pixels. Pure arithmetic over typed arrays.
 */

/** Orthogonal and diagonal step costs. 3 and 4 approximate 1 and √2. */
const ORTHOGONAL = 3;
const DIAGONAL = 4;

/** Large enough to act as infinity, small enough to stay well inside Int32. */
const FAR = 1 << 28;

/**
 * @param {Uint8Array} mask width*height, non-zero where the glyph inks
 * @param {number} width
 * @param {number} height
 * @returns {{field: Int32Array, max: number}} distance in thirds of a pixel
 */
export function distanceField(mask, width, height) {
  const field = new Int32Array(width * height);

  // Background is zero; ink starts at infinity and is whittled down.
  for (let i = 0; i < field.length; i++) field[i] = mask[i] ? FAR : 0;

  // Forward sweep: top-left to bottom-right, looking at already-final neighbours.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const up = row - width;

    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (field[i] === 0) continue;

      let best = field[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, field[up + x - 1] + DIAGONAL);
        best = Math.min(best, field[up + x] + ORTHOGONAL);
        if (x + 1 < width) best = Math.min(best, field[up + x + 1] + DIAGONAL);
      }
      if (x > 0) best = Math.min(best, field[i - 1] + ORTHOGONAL);
      field[i] = best;
    }
  }

  // Backward sweep: the other four neighbours, and the answer is final.
  let max = 0;
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    const down = row + width;

    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      if (field[i] === 0) continue;

      let best = field[i];
      if (y + 1 < height) {
        if (x > 0) best = Math.min(best, field[down + x - 1] + DIAGONAL);
        best = Math.min(best, field[down + x] + ORTHOGONAL);
        if (x + 1 < width) best = Math.min(best, field[down + x + 1] + DIAGONAL);
      }
      if (x + 1 < width) best = Math.min(best, field[i + 1] + ORTHOGONAL);

      field[i] = best;
      if (best > max) max = best;
    }
  }

  return { field, max };
}

/** Thirds of a pixel back to pixels. */
export const toPixels = (value) => value / ORTHOGONAL;
