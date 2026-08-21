/**
 * Headless checks for the simulation. `node test/simulation.test.mjs`
 *
 * The formation is checked the way the eye checks it: does the word assemble,
 * does it stay apart, does the cursor break it, does it come back. Words are
 * rasterised in the browser, so these tests stand in synthetic slot sets — the
 * simulation does not know the difference, which is the point of the seam.
 */
import { CONFIG } from '../src/experience/config.js';
import { ButterflySimulation, MODE_FORMING, MODE_HOLDING, MODE_LOOSE, WINGSPAN } from '../src/experience/ButterflySimulation.js';
import { SwarmController } from '../src/experience/SwarmController.js';
import { samplePoints } from '../src/experience/text/blueNoise.js';
import { makeRandom, TAU } from '../src/experience/utils/math.js';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const config = { ...CONFIG, BUTTERFLY_COUNT: 120 };
const dt = 1 / 60;
const BOUNDS = [12.9, 9.1, config.DEPTH_RANGE];

const project = (ndcX, ndcY, out) => {
  out[0] = ndcX * 10.3;
  out[1] = ndcY * 6.5;
  out[2] = 0;
};

/**
 * A stand-in for a rasterised word: two horizontal bars, so the slot set has
 * the same character as real glyphs — inked regions with empty space between.
 */
function makeFormation(count, spacing = 0.52, seed = 5) {
  const w = 420, h = 150;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBar = (y > 20 && y < 55) || (y > 95 && y < 130);
      if (inBar && x > 15 && x < w - 15) mask[y * w + x] = 1;
    }
  }

  const rng = makeRandom(seed);
  // Size the raster to world so the achieved spacing is the requested one.
  const sampled = samplePoints(mask, w, h, { count, minDistance: 14, rng });
  const worldPerPixel = spacing / sampled.spacing;

  const points = new Float32Array(sampled.count * 3);
  for (let i = 0; i < sampled.count; i++) {
    points[i * 3] = (sampled.points[i * 2] - w / 2) * worldPerPixel;
    points[i * 3 + 1] = -(sampled.points[i * 2 + 1] - h / 2) * worldPerPixel;
    points[i * 3 + 2] = (rng() * 2 - 1) * config.WORD_DEPTH;
  }
  return { points, count: sampled.count, spacing };
}

function makeSim(overrides = {}) {
  const sim = new ButterflySimulation({ ...config, ...overrides }, 12345);
  sim.setBounds(...BOUNDS);
  sim.distribute();
  return sim;
}

/** Drives the sim with a scripted pointer. `pointerAt` returns null for "no pointer". */
function run(sim, swarm, seconds, pointerAt = () => null) {
  const steps = Math.round(seconds / dt);
  for (let s = 0; s < steps; s++) {
    const p = pointerAt(s * dt);
    swarm.update(dt, p
      ? { hasPointer: true, timeSinceMove: 0, ndcX: p.x, ndcY: p.y }
      : { hasPointer: false, timeSinceMove: Infinity, ndcX: 0, ndcY: 0 });
    sim.update(dt, swarm);

    // Stands in for the experience: hand over a new word when one is wanted.
    if (sim.wantsFormation) sim.setFormation(makeFormation(sim.formerCount, 0.52, 5 + sim.formationVersion));
  }
}

/**
 * Runs until the word is standing, or gives up. Needed because a pointer
 * *arriving* is a real movement — in a browser it sweeps in across the frame —
 * so a test about a still cursor has to let it become still first.
 */
function runUntilHolding(sim, swarm, pointerAt, maxSeconds = 30) {
  const steps = Math.round(maxSeconds / dt);
  for (let s = 0; s < steps; s++) {
    run(sim, swarm, dt, pointerAt);
    if (sim.mode === MODE_HOLDING && sim.modeTime > 0.5) return true;
  }
  return false;
}

const stats = (sim) => {
  let maxSpeed = 0, meanSpeed = 0, maxDist = 0, bad = 0, badQuat = 0;
  for (let i = 0; i < sim.count; i++) {
    const p = i * 3;
    const s = Math.hypot(sim.velocities[p], sim.velocities[p + 1], sim.velocities[p + 2]);
    const d = Math.hypot(sim.positions[p], sim.positions[p + 1], sim.positions[p + 2]);
    if (!Number.isFinite(s) || !Number.isFinite(d)) bad++;
    maxSpeed = Math.max(maxSpeed, s);
    meanSpeed += s / sim.count;
    maxDist = Math.max(maxDist, d);

    const q = i * 4;
    const len = Math.hypot(sim.quaternions[q], sim.quaternions[q + 1], sim.quaternions[q + 2], sim.quaternions[q + 3]);
    if (!Number.isFinite(len) || Math.abs(len - 1) > 1e-2) badQuat++;
  }
  return { maxSpeed, meanSpeed, maxDist, bad, badQuat };
};

/** Mean distance from each former to the slot it was given. */
const slotError = (sim) => {
  let mean = 0;
  for (let i = 0; i < sim.count; i++) {
    if (i === sim.leader) continue;
    const p = i * 3;
    mean += Math.hypot(
      sim.positions[p] - sim.slots[p],
      sim.positions[p + 1] - sim.slots[p + 1],
      sim.positions[p + 2] - sim.slots[p + 2],
    ) / sim.formerCount;
  }
  return mean;
};

/**
 * Closest pair among the formers, and how it compares to their wingspan.
 *
 * The wingbeat bob is applied in the shader, *after* the simulation has spaced
 * everyone out, so it is clearance being spent without the separation force
 * knowing. Two neighbours beating in antiphase is the worst case, and it is
 * charged against the gap here — otherwise this check would pass while the thing
 * on screen overlapped.
 */
const closestPair = (sim) => {
  const bob = (i) => config.WING_BOB * sim.energy[i] * sim.energy[i] * sim.scale[i];

  let best = Infinity;
  let worstOverlap = 0;
  for (let i = 0; i < sim.count; i++) {
    if (i === sim.leader) continue;
    for (let j = i + 1; j < sim.count; j++) {
      if (j === sim.leader) continue;
      const a = i * 3, b = j * 3;
      const d = Math.hypot(
        sim.positions[a] - sim.positions[b],
        sim.positions[a + 1] - sim.positions[b + 1],
        sim.positions[a + 2] - sim.positions[b + 2],
      );
      if (d < best) best = d;
      // Half a wingspan each is the distance at which two wings would touch.
      const touch = ((sim.scale[i] + sim.scale[j]) * WINGSPAN) / 2;
      worstOverlap = Math.max(worstOverlap, touch + bob(i) + bob(j) - d);
    }
  }
  return { closest: best, worstOverlap };
};

/* -- 1. numerical health ------------------------------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  run(sim, swarm, 30, (t) => ({ x: Math.sin(t * 2.3) * 0.9, y: Math.cos(t * 1.7) * 0.8 }));
  const s = stats(sim);
  check('no NaN / Infinity after 30s of forming and scattering', s.bad === 0 && s.badQuat === 0,
    `bad=${s.bad} quats=${s.badQuat}`);
  check('quaternions stay unit length', s.badQuat === 0);
  check('speed respects the per-butterfly limit', s.maxSpeed <= config.MAX_SPEED * 1.29,
    `max=${s.maxSpeed.toFixed(2)}`);
}

/* -- 2. the word assembles ----------------------------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  sim.setFormation(makeFormation(sim.formerCount));
  const before = slotError(sim);
  run(sim, swarm, 6);
  const after = slotError(sim);

  check('butterflies converge on their slots', after < before * 0.1, `${before.toFixed(2)} -> ${after.toFixed(3)}`);
  check('and hold them tightly', after < 0.2, `error=${after.toFixed(3)}`);
  check('the word reports itself assembled', sim.formation > config.FORMED_THRESHOLD, `formation=${sim.formation.toFixed(2)}`);
  check('and reaches the holding state', sim.mode === MODE_HOLDING, `mode=${sim.mode}`);
}

/* -- 3. they do not overlap ---------------------------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  sim.setFormation(makeFormation(sim.formerCount));
  run(sim, swarm, 8);

  const { closest, worstOverlap } = closestPair(sim);
  check('no two butterflies share a place', closest > sim.spacing * 0.55,
    `closest=${closest.toFixed(3)} spacing=${sim.spacing.toFixed(3)}`);
  check('no pair of wings overlaps, bob included', worstOverlap <= 0,
    `deepest overlap=${worstOverlap.toFixed(4)} of wingspan ${(sim.scale[1] * WINGSPAN).toFixed(2)}`);
  check('size was derived from spacing', Math.abs(sim.scale[1] / sim.scaleBias[1] - (sim.spacing * config.SLOT_FILL) / WINGSPAN) < 1e-6,
    `scale=${sim.scale[1].toFixed(3)}`);
}

/* -- 3b. a dense word does not quietly widen the butterflies -------- */
{
  // SCALE_MIN used to clamp the derived size upward, making wings wider than the
  // gaps they were sized for and undoing the whole guarantee. Tight spacing is
  // where that shows up.
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  const tight = 0.21;
  sim.setFormation(makeFormation(sim.formerCount, tight));
  run(sim, swarm, 8);

  const derived = (tight * config.SLOT_FILL) / WINGSPAN;
  check('a tight word is not clamped to a larger size',
    Math.abs(sim.scale[1] / sim.scaleBias[1] - derived) < 1e-6,
    `derived=${derived.toFixed(4)} actual=${(sim.scale[1] / sim.scaleBias[1]).toFixed(4)} floor=${config.SCALE_MIN}`);
  check('and its wings still do not overlap', closestPair(sim).worstOverlap <= 0,
    `deepest overlap=${closestPair(sim).worstOverlap.toFixed(4)}`);
}

/* -- 4. the cursor breaks it, and it comes back -------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  sim.setFormation(makeFormation(sim.formerCount));
  run(sim, swarm, 6);
  const settled = slotError(sim);
  const firstWord = sim.formationVersion;
  check('assembled before the disturbance', sim.mode === MODE_HOLDING, `error=${settled.toFixed(3)}`);

  // Sweep a pointer straight through the middle of the word.
  run(sim, swarm, 1.2, (t) => ({ x: -0.6 + t * 1.0, y: 0 }));
  check('a cursor moving through them breaks the word', sim.mode === MODE_LOOSE, `mode=${sim.mode}`);
  check('and they are pushed off their slots', slotError(sim) > settled * 3,
    `${settled.toFixed(3)} -> ${slotError(sim).toFixed(2)}`);

  // Then leave it alone.
  run(sim, swarm, 10);
  check('a new word is asked for', sim.formationVersion > firstWord,
    `version ${firstWord} -> ${sim.formationVersion}`);
  check('and the swarm reassembles', sim.formation > config.FORMED_THRESHOLD,
    `formation=${sim.formation.toFixed(2)}`);
  check('nothing was lost in the scatter', stats(sim).bad === 0);
}

/* -- 5. a parked cursor does not stampede them --------------------- */
{
  // HOLD_DURATION out of the way, so only the disturbance path is under test.
  const patient = { ...config, HOLD_DURATION: 600 };
  const sim = makeSim({ HOLD_DURATION: 600 });
  const swarm = new SwarmController(patient, project);
  const centre = () => ({ x: 0, y: 0 });

  // Let the cursor arrive and the word settle around it first.
  const standing = runUntilHolding(sim, swarm, centre);
  check('a word can stand with a cursor resting inside it', standing, `mode=${sim.mode}`);
  const version = sim.formationVersion;

  // Now hold dead still for a long time.
  run(sim, swarm, 15, centre);
  check('a still cursor never breaks the word', sim.formationVersion === version,
    `version ${version} -> ${sim.formationVersion}`);
  check('but it does clear a space around itself', (() => {
    let nearest = Infinity;
    for (let i = 0; i < sim.count; i++) {
      if (i === sim.leader) continue;
      const p = i * 3;
      nearest = Math.min(nearest, Math.hypot(sim.positions[p] - swarm.targetX, sim.positions[p + 1] - swarm.targetY));
    }
    return nearest > 0.4;
  })(), 'a halo, not a stampede');
}

/* -- 6. the one that follows the cursor ---------------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  sim.setFormation(makeFormation(sim.formerCount));
  run(sim, swarm, 5, () => ({ x: 0.75, y: 0.55 }));

  const l = sim.leader * 3;
  const distance = Math.hypot(sim.positions[l] - swarm.targetX, sim.positions[l + 1] - swarm.targetY);
  check('the leader reaches the cursor', distance < config.LEADER_ORBIT_RADIUS * 2.4, `distance=${distance.toFixed(2)}`);
  check('it is never given a slot', sim.slots[l] === 0 && sim.slots[l + 1] === 0);
  check('it is larger than the crowd', sim.scale[sim.leader] > sim.scale[1] * 1.4,
    `${sim.scale[sim.leader].toFixed(2)} vs ${sim.scale[1].toFixed(2)}`);
  check('and wears the rare colour', sim.colorSeed[sim.leader] === 1);

  // It should circle rather than park: move the cursor away and back.
  run(sim, swarm, 3, (t) => ({ x: -0.8 + t * 0.2, y: -0.5 }));
  const after = Math.hypot(sim.positions[l] - swarm.targetX, sim.positions[l + 1] - swarm.targetY);
  check('it follows the cursor when it moves', after < config.LEADER_ORBIT_RADIUS * 2.4, `distance=${after.toFixed(2)}`);
}

/* -- 7. it moves on by itself -------------------------------------- */
{
  const sim = makeSim({ HOLD_DURATION: 2 });
  const swarm = new SwarmController({ ...config, HOLD_DURATION: 2 }, project);
  sim.setFormation(makeFormation(sim.formerCount));
  run(sim, swarm, 5);
  const version = sim.formationVersion;
  run(sim, swarm, 12);
  check('an undisturbed word still gives way to the next', sim.formationVersion > version,
    `version ${version} -> ${sim.formationVersion}`);
}

/* -- 8. nothing escapes -------------------------------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  run(sim, swarm, 25, (t) => ({ x: t % 2 < 1 ? 1 : -1, y: 1 }));
  const bound = Math.hypot(BOUNDS[0], BOUNDS[1], BOUNDS[2]) * 1.5;
  check('nothing escapes with the cursor jammed in a corner', stats(sim).maxDist < bound,
    `maxDist=${stats(sim).maxDist.toFixed(2)} bound=${bound.toFixed(2)}`);
}

/* -- 9. frame-rate independence ------------------------------------ */
{
  const results = [30, 60, 144].map((fps) => {
    const step = 1 / fps;
    const sim = new ButterflySimulation(config, 999);
    sim.setBounds(...BOUNDS);
    sim.distribute();
    sim.setFormation(makeFormation(sim.formerCount));
    const swarm = new SwarmController(config, project);
    // No pointer: the formation spring is the thing being checked for dt-safety,
    // and a cursor sweeping through would scatter them into a different test.
    for (let t = 0; t < 6; t += step) {
      swarm.update(step, { hasPointer: false, timeSinceMove: Infinity, ndcX: 0, ndcY: 0 });
      sim.update(step, swarm);
    }
    return slotError(sim);
  });
  const spread = Math.max(...results) - Math.min(...results);
  check('same result at 30 / 60 / 144 fps', spread < 0.05,
    `spread=${spread.toFixed(4)} of ${results.map((r) => r.toFixed(3)).join(', ')}`);
}

/* -- 10. individuality --------------------------------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  sim.setFormation(makeFormation(sim.formerCount));
  run(sim, swarm, 2.5); // caught mid-flight, on the way to their slots
  const speeds = [];
  for (let i = 0; i < sim.count; i++) {
    if (i === sim.leader) continue;
    const p = i * 3;
    speeds.push(Math.hypot(sim.velocities[p], sim.velocities[p + 1], sim.velocities[p + 2]));
  }
  const mean = speeds.reduce((a, b) => a + b) / speeds.length;
  const variance = speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length;
  check('butterflies do not move as one object', Math.sqrt(variance) / mean > 0.25,
    `cv=${(Math.sqrt(variance) / mean).toFixed(2)}`);
}

/* -- 11. the wingbeat never jumps ---------------------------------- */
{
  // The wingbeat used to be sin(time * rate) in the shader, with rate riding on
  // the butterfly's speed. That is frequency modulation done by scaling the
  // argument instead of integrating it: every change of rate displaced the phase
  // by time * deltaRate, a jump that grew with how long the page had been open.
  // Thirty seconds in, a hard turn skipped ten wing cycles in a single frame —
  // which is what "the wings flicker" looks like from the outside.
  //
  // Phase is now accumulated, so the only legitimate step is rate * dt.
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  sim.setFormation(makeFormation(sim.formerCount));

  // Let the clock get well away from zero first: the old bug was invisible early.
  run(sim, swarm, 25, (t) => ({ x: Math.sin(t * 3.1) * 0.95, y: Math.cos(t * 2.7) * 0.9 }));

  const fastest = config.WING_FLAP_SPEED * (1 + config.WING_FLAP_SPEED_SPREAD);
  const ceiling = fastest * dt * 1.001; // one frame of the fastest possible beat
  const step = (a, b) => {
    // Phase wraps at TAU, so the short way round is the real step.
    const raw = Math.abs(b - a) % TAU;
    return Math.min(raw, TAU - raw);
  };

  let worstWing = 0;
  let worstSway = 0;
  let worstIndex = -1;

  // Yank the cursor around hard: this is the motion that used to break it.
  for (let s = 0; s < 600; s++) {
    const before = Float32Array.from(sim.wingPhase);
    const beforeSway = Float32Array.from(sim.swayPhase);
    const t = s * dt;
    // Jerked, not smooth — energy has to change as violently as possible.
    const p = { x: Math.sin(t * 14) * 0.98, y: Math.cos(t * 11) * 0.95 };
    swarm.update(dt, { hasPointer: true, timeSinceMove: 0, ndcX: p.x, ndcY: p.y });
    sim.update(dt, swarm);
    if (sim.wantsFormation) sim.setFormation(makeFormation(sim.formerCount, 0.52, 5 + sim.formationVersion));

    for (let i = 0; i < sim.count; i++) {
      const w = step(before[i], sim.wingPhase[i]);
      if (w > worstWing) { worstWing = w; worstIndex = i; }
      worstSway = Math.max(worstSway, step(beforeSway[i], sim.swayPhase[i]));
    }
  }

  check('the wingbeat advances by at most one frame of beat, ever',
    worstWing <= ceiling,
    `worst step=${worstWing.toFixed(4)} rad, ceiling=${ceiling.toFixed(4)}, butterfly ${worstIndex}` +
    `${worstIndex === sim.leader ? ' (the leader)' : ''}`);
  check('the slow sway advances smoothly too', worstSway <= ceiling * config.SWAY_RATIO * 1.001,
    `worst step=${worstSway.toFixed(4)} rad`);
  check('phase stays in a range float32 can resolve',
    (() => {
      for (let i = 0; i < sim.count; i++) {
        if (!(sim.wingPhase[i] >= 0 && sim.wingPhase[i] < TAU)) return false;
        if (!(sim.swayPhase[i] >= 0 && sim.swayPhase[i] < TAU)) return false;
      }
      return true;
    })(), 'wrapped to [0, TAU)');
}

/* -- 12. banking does not snap ------------------------------------- */
{
  const sim = makeSim();
  const swarm = new SwarmController(config, project);
  sim.setFormation(makeFormation(sim.formerCount));
  run(sim, swarm, 6);

  let worst = 0;
  for (let s = 0; s < 400; s++) {
    const before = Float32Array.from(sim.roll);
    const t = s * dt;
    const p = { x: Math.sin(t * 13) * 0.98, y: Math.cos(t * 9) * 0.95 };
    swarm.update(dt, { hasPointer: true, timeSinceMove: 0, ndcX: p.x, ndcY: p.y });
    sim.update(dt, swarm);
    if (sim.wantsFormation) sim.setFormation(makeFormation(sim.formerCount, 0.52, 5 + sim.formationVersion));
    for (let i = 0; i < sim.count; i++) worst = Math.max(worst, Math.abs(sim.roll[i] - before[i]));
  }

  // A roll that can cross its whole range in one frame reads as a flicker on a
  // shape this thin, so it is rate-limited rather than taken straight from the
  // frame's heading change.
  const ceiling = config.MAX_BANK * 2 * config.ROLL_SMOOTHING * dt * 1.05;
  check('bank angle is rate-limited, not taken raw from one frame',
    worst <= ceiling, `worst step=${worst.toFixed(4)} rad, ceiling=${ceiling.toFixed(4)}`);
}

/* -- 13. cost ------------------------------------------------------ */
{
  const heavy = { ...config, BUTTERFLY_COUNT: 1000 };
  const sim = new ButterflySimulation(heavy, 7);
  sim.setBounds(...BOUNDS);
  sim.distribute();
  sim.setFormation(makeFormation(sim.formerCount, 0.2));
  const swarm = new SwarmController(heavy, project);
  run(sim, swarm, 0.5);

  const start = process.hrtime.bigint();
  run(sim, swarm, 2, (t) => ({ x: Math.sin(t * 3), y: Math.cos(t * 2) }));
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / 120;
  check('1000 butterflies fit in a 16ms frame budget', ms < 6, `${ms.toFixed(2)}ms/frame of CPU sim`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
