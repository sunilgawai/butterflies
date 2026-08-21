/**
 * Checks the pieces the formation is built on: the blue-noise sampler's spacing
 * guarantee (which is what keeps butterflies from overlapping) and the greeting
 * list. `node test/text.test.mjs`
 */
import { samplePoints, spacingForArea, PACKING_EFFICIENCY } from '../src/experience/text/blueNoise.js';
import { distanceField, toPixels } from '../src/experience/text/distanceField.js';
import { GREETINGS, glyphCount, pickGreeting } from '../src/experience/greetings.js';
import { makeRandom } from '../src/experience/utils/math.js';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** Closest pair among the returned points, by brute force. */
function closestPair(points, count) {
  let best = Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = points[i * 2] - points[j * 2];
      const dy = points[i * 2 + 1] - points[j * 2 + 1];
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
  }
  return best;
}

/* -- 1. the spacing guarantee -------------------------------------- */
{
  const w = 400, h = 200;
  const mask = new Uint8Array(w * h).fill(1);
  const rng = makeRandom(7);
  const result = samplePoints(mask, w, h, { count: 300, minDistance: 12, rng });

  check('fills the requested count on an open mask', result.count === 300, `got ${result.count}`);
  const min = closestPair(result.points, result.count);
  check('no two points closer than the reported spacing', min >= result.spacing - 1e-6,
    `closest=${min.toFixed(2)} spacing=${result.spacing.toFixed(2)}`);
  check('spacing was not relaxed when it did not need to be', result.spacing === 12, `spacing=${result.spacing}`);
}

/* -- 2. points land only on inked pixels --------------------------- */
{
  // A ring: tests that nothing is placed in the hole or outside the annulus.
  const w = 200, h = 200;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - 100, y - 100);
      if (r > 55 && r < 90) mask[y * w + x] = 1;
    }
  }
  const rng = makeRandom(11);
  const result = samplePoints(mask, w, h, { count: 120, minDistance: 9, rng });

  let offMask = 0;
  for (let i = 0; i < result.count; i++) {
    const x = result.points[i * 2];
    const y = result.points[i * 2 + 1];
    if (!mask[y * w + x]) offMask++;
  }
  check('every point sits on an inked pixel', offMask === 0, `off=${offMask}`);
  const min = closestPair(result.points, result.count);
  check('spacing holds on a concave mask', min >= result.spacing - 1e-6,
    `closest=${min.toFixed(2)} spacing=${result.spacing.toFixed(2)}`);
}

/* -- 3. relaxation when the mask is too small ---------------------- */
{
  const w = 60, h = 60;
  const mask = new Uint8Array(w * h).fill(1);
  const rng = makeRandom(3);
  // 400 points at 20px apart cannot fit in 60x60 — it must back off and say so.
  const result = samplePoints(mask, w, h, { count: 400, minDistance: 20, rng });

  check('reduces spacing rather than returning too few', result.count === 400, `got ${result.count}`);
  check('reports the spacing it actually used', result.spacing < 20, `spacing=${result.spacing.toFixed(2)}`);
  check('does it in one pass, not by grinding down', result.passes <= 2, `passes=${result.passes}`);
  const min = closestPair(result.points, result.count);
  check('relaxed spacing is still honoured', min >= result.spacing - 1e-6,
    `closest=${min.toFixed(2)} spacing=${result.spacing.toFixed(2)}`);
}

/* -- 4. empty mask degrades quietly -------------------------------- */
{
  const mask = new Uint8Array(100);
  const result = samplePoints(mask, 10, 10, { count: 50, minDistance: 4, rng: makeRandom(1) });
  check('an empty mask yields no points instead of throwing', result.count === 0);
}

/* -- 5. the density estimate is honest ----------------------------- */
{
  // spacingForArea is what sizes a word before it is sampled: if it lies, words
  // come out the wrong size. Check the prediction against reality.
  const w = 300, h = 300;
  const mask = new Uint8Array(w * h).fill(1);
  const count = 500;
  const predicted = spacingForArea(w * h, count);
  const result = samplePoints(mask, w, h, { count, minDistance: predicted, rng: makeRandom(5) });
  check('predicted spacing fits the requested count without relaxing',
    result.count === count && result.spacing === predicted,
    `predicted=${predicted.toFixed(2)} got=${result.count} spacing=${result.spacing.toFixed(2)}`);
  check('packing estimate is not wildly conservative', PACKING_EFFICIENCY > 0.5);
}

/* -- 6. determinism ------------------------------------------------ */
{
  const w = 128, h = 128;
  const mask = new Uint8Array(w * h).fill(1);
  const a = samplePoints(mask, w, h, { count: 80, minDistance: 8, rng: makeRandom(42) });
  const b = samplePoints(mask, w, h, { count: 80, minDistance: 8, rng: makeRandom(42) });
  let same = a.count === b.count;
  for (let i = 0; same && i < a.count * 2; i++) same = a.points[i] === b.points[i];
  check('same seed gives the same arrangement', same);
}

/* -- 7. the greeting list ------------------------------------------ */
{
  check('every entry has a language and a word',
    GREETINGS.every((g) => typeof g.language === 'string' && g.language.length > 0 && [...g.text].length > 0));
  check('no duplicate words', new Set(GREETINGS.map((g) => g.text)).size === GREETINGS.length);
  check('enough languages to not repeat quickly', GREETINGS.length >= 20, `${GREETINGS.length} entries`);

  const rng = makeRandom(19);
  let repeats = 0;
  let previous = 'Hello';
  for (let i = 0; i < 500; i++) {
    const next = pickGreeting(rng, { exclude: previous });
    if (next.text === previous) repeats++;
    previous = next.text;
  }
  check('never picks the word already on screen', repeats === 0, `repeats=${repeats}`);

  const shortOnly = new Set();
  for (let i = 0; i < 400; i++) shortOnly.add(pickGreeting(rng, { maxGlyphs: 4 }).text);
  check('maxGlyphs keeps long words off narrow screens',
    [...shortOnly].every((t) => glyphCount(t) <= 4), [...shortOnly].join(' '));
}

/* -- 8. the distance field --------------------------------------- */
{
  // A 21px-wide bar: the centre column is 11 pixels from the outside.
  const w = 60, h = 40;
  const mask = new Uint8Array(w * h);
  for (let y = 10; y < 31; y++) for (let x = 10; x < 51; x++) mask[y * w + x] = 1;

  const { field, max } = distanceField(mask, w, h);
  check('background is zero', field[0] === 0 && field[w * h - 1] === 0);
  check('an edge pixel is one step in', toPixels(field[10 * w + 20]) === 1,
    `got ${toPixels(field[10 * w + 20])}`);
  check('the centre of a 21px bar is 11 from the edge', toPixels(field[20 * w + 30]) === 11,
    `got ${toPixels(field[20 * w + 30])}`);
  check('max is reported', toPixels(max) === 11, `max=${toPixels(max)}`);
}

/* -- 9. priority puts points on the stroke centreline ------------- */
{
  // A thin horizontal stroke, the case that decides whether a word reads: with
  // only ~2 points across it, they have to land on the spine.
  const w = 300, h = 60;
  const mask = new Uint8Array(w * h);
  const top = 22, bottom = 38; // a 16px stroke, centre row 30
  for (let y = top; y < bottom; y++) for (let x = 10; x < w - 10; x++) mask[y * w + x] = 1;

  const field = distanceField(mask, w, h);
  const spread = (result) => {
    let sum = 0;
    for (let i = 0; i < result.count; i++) sum += Math.abs(result.points[i * 2 + 1] - 29.5);
    return sum / result.count;
  };

  const plain = samplePoints(mask, w, h, { count: 60, minDistance: 12, rng: makeRandom(31) });
  const guided = samplePoints(mask, w, h, {
    count: 60, minDistance: 12, rng: makeRandom(31),
    priority: field.field, maxPriority: field.max,
  });

  check('priority pulls points toward the stroke centre',
    spread(guided) < spread(plain) * 0.6,
    `centreline offset ${spread(plain).toFixed(2)}px -> ${spread(guided).toFixed(2)}px`);
  check('and still returns the full count', guided.count === 60, `got ${guided.count}`);
  check('and still honours the spacing', (() => closestPair(guided.points, guided.count) >= guided.spacing - 1e-6)(),
    `closest=${closestPair(guided.points, guided.count).toFixed(2)} spacing=${guided.spacing.toFixed(2)}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
