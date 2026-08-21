import { NoiseSystem } from './NoiseSystem.js';
import { SpatialHash } from './SpatialHash.js';
import {
  TAU,
  clamp,
  damp,
  dragFactor,
  smoothstep,
  makeRandom,
  randRange,
  randPower,
  quatFromForwardUp,
  quatRollLocalY,
  quatSlerp,
} from './utils/math.js';

/** No word yet, or one that was just broken apart. */
export const MODE_LOOSE = 'loose';
/** Flying to assigned slots. */
export const MODE_FORMING = 'forming';
/** Standing in the word, hovering. */
export const MODE_HOLDING = 'holding';

/**
 * Wingtip to wingtip in the geometry's local space. Butterfly size is derived
 * from slot spacing through this, which is what makes "they must not overlap" a
 * property of the arrangement instead of a force fighting the formation.
 */
export const WINGSPAN = 1.6;

/**
 * The swarm: one butterfly that follows the cursor, and the rest standing in a
 * word until something disturbs them.
 *
 * Three states, and the whole behaviour is in the transitions between them:
 *
 *   loose ──setFormation()──▶ forming ──assembled──▶ holding
 *     ▲                                                 │
 *     └───────── cursor moves through them, or ──────────┘
 *               the word has stood long enough
 *
 * The simulation does not know what a word *is*: it is handed world-space slots
 * and hands back `wantsFormation` when it is ready for the next set. Rasterising
 * text needs a canvas and belongs to the browser; keeping it outside means this
 * file stays plain arithmetic over Float32Arrays, testable in Node, allocating
 * nothing inside the frame loop.
 *
 * Layout: xyz triples for vectors, xyzw quads for quaternions, scalars per index.
 */
export class ButterflySimulation {
  constructor(config, seed = 20260819) {
    this.config = config;
    this.count = config.BUTTERFLY_COUNT;

    /**
     * The one that is yours. Index 0 is excluded from every formation, chases
     * the pointer instead, and is drawn larger in the rare colour so it reads as
     * a companion rather than a stray.
     */
    this.leader = 0;

    const n = this.count;
    const rng = makeRandom(seed);
    this.rng = rng;

    /* state --------------------------------------------------------- */
    this.positions = new Float32Array(n * 3);
    this.velocities = new Float32Array(n * 3);
    this.quaternions = new Float32Array(n * 4);
    this.forwards = new Float32Array(n * 3);
    this.energy = new Float32Array(n);

    /* formation ----------------------------------------------------- */
    this.slots = new Float32Array(n * 3); // indexed by butterfly, not by slot
    this.settle = new Float32Array(n); // 0..1, how arrived this one is
    this.startled = new Float32Array(n); // 0..1, decaying memory of the cursor

    this.mode = MODE_LOOSE;
    this.modeTime = Infinity; // so the very first frame asks for a word
    this.wantsFormation = true;
    this.formationVersion = 0;
    this.formationCount = 0;
    this.formation = 0; // 0..1, mean settle across the formers
    this.disturbance = 0; // 0..1, smoothed startle across the formers
    this.spacing = config.SLOT_SPACING;

    this.scatterX = 0;
    this.scatterY = 0;
    this.scatterZ = 0;
    this.scatterForce = 0;

    /* orbit basis: used for the leader's loop around the cursor ------ */
    this.slotU = new Float32Array(n * 3);
    this.slotV = new Float32Array(n * 3);
    this.slotAngle = new Float32Array(n);
    this.slotSpeed = new Float32Array(n);

    /* personality --------------------------------------------------- */
    this.maxSpeed = new Float32Array(n);
    this.accel = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.attraction = new Float32Array(n);
    this.orbitTendency = new Float32Array(n);
    this.noiseAmp = new Float32Array(n);
    this.noiseFreq = new Float32Array(n);
    this.noisePhase = new Float32Array(n);
    this.hoverPhase = new Float32Array(n);
    this.restTilt = new Float32Array(n);
    this.scaleBias = new Float32Array(n);
    this.scale = new Float32Array(n);

    /* wing personality (uploaded to the GPU once) -------------------- */
    this.flapSpeed = new Float32Array(n);
    this.flapAmplitude = new Float32Array(n);
    this.flapAsymmetry = new Float32Array(n);
    this.colorSeed = new Float32Array(n);

    /* wing state -----------------------------------------------------
       Wingbeat phase is *accumulated* here rather than derived in the shader
       from time and a rate. The shader used to evaluate sin(time · rate), which
       is frequency modulation done by scaling the sine's argument: any change of
       rate displaced the phase by time · deltaRate, so a butterfly that changed
       speed skipped whole wing cycles in a single frame, by an amount that grew
       for as long as the page stayed open. Integrating the rate instead means the
       phase can only ever advance by rate · dt, and the beat stays continuous
       through any change of speed.

       Both wrap to [0, TAU) — sine does not care, and it keeps them in a range
       float32 can still resolve after an hour on screen. */
    this.wingPhase = new Float32Array(n);
    this.swayPhase = new Float32Array(n); // antennae and abdomen, at SWAY_RATIO of the beat
    this.roll = new Float32Array(n); // smoothed bank angle

    /* scratch ------------------------------------------------------- */
    this.center = new Float32Array(3);
    this.averageSpeed = 0;
    this.time = 0;
    this.bounds = new Float32Array([12, 7, config.DEPTH_RANGE]);

    this.noise = new NoiseSystem(seed & 0xffff);
    this.hash = new SpatialHash(n, Math.max(config.SLOT_SPACING, 0.25));

    this._targetQuat = new Float32Array(4);
    this._sep = new Float32Array(3);
    this._sepSelf = 0;
    this._sepX = 0;
    this._sepY = 0;
    this._sepZ = 0;
    this._sepRadius = config.SLOT_SPACING;

    /** Largest size multiplier in the swarm, so separation can be sized to it. */
    this.widestBias = 1;

    // Assignment scratch, allocated once: reforming must not churn the heap.
    this._order = new Int32Array(n);
    this._slotOrder = new Int32Array(n);
    this._angle = new Float32Array(n);
    this._slotAngle = new Float32Array(n);

    // Preallocated visitor so the neighbour walk never allocates a closure.
    this._visitNeighbour = (j) => {
      if (j === this._sepSelf) return;
      const q = j * 3;
      const dx = this._sepX - this.positions[q];
      const dy = this._sepY - this.positions[q + 1];
      const dz = this._sepZ - this.positions[q + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const r = this._sepRadius;
      if (d2 > r * r || d2 < 1e-8) return;
      // Inverse-square-ish push, softened so touching butterflies don't explode.
      const d = Math.sqrt(d2);
      const push = (1 - d / r) / (d + 0.08 * r);
      this._sep[0] += dx * push;
      this._sep[1] += dy * push;
      this._sep[2] += dz * push;
    };

    this.#assignPersonalities(rng);
  }

  /** How many butterflies stand in the word: everyone except the leader. */
  get formerCount() {
    return Math.max(1, this.count - 1);
  }

  #assignPersonalities(rng) {
    const c = this.config;

    for (let i = 0; i < this.count; i++) {
      this.maxSpeed[i] = c.MAX_SPEED * randRange(rng, 0.72, 1.28);
      this.accel[i] = c.ACCELERATION * randRange(rng, 0.7, 1.4);
      this.drag[i] = c.DAMPING * randRange(rng, 0.8, 1.3);
      this.attraction[i] = randRange(rng, 0.78, 1.26);
      this.orbitTendency[i] = randPower(rng, 0.2, 1.5, 1.4) * (rng() < 0.5 ? -1 : 1);
      this.noiseAmp[i] = randRange(rng, 0.4, 1.6);
      this.noiseFreq[i] = c.NOISE_FREQUENCY * randRange(rng, 0.7, 1.55);
      this.noisePhase[i] = rng() * 120;
      this.hoverPhase[i] = rng() * TAU;
      // Resting lean: settled butterflies face the viewer, each at its own angle.
      this.restTilt[i] = randRange(rng, -0.42, 0.42);
      this.scaleBias[i] = randRange(rng, 0.84, 1.16);
      if (this.scaleBias[i] > this.widestBias) this.widestBias = this.scaleBias[i];
      this.scale[i] = c.SCALE_MIN;

      this.slotSpeed[i] = c.SLOT_DRIFT_SPEED * randRange(rng, 0.5, 1.7) * (rng() < 0.5 ? -1 : 1);
      this.slotAngle[i] = rng() * TAU;

      this.flapSpeed[i] = c.WING_FLAP_SPEED * randRange(rng, 1 - c.WING_FLAP_SPEED_SPREAD, 1 + c.WING_FLAP_SPEED_SPREAD);
      this.flapAmplitude[i] =
        c.WING_FLAP_AMPLITUDE * randRange(rng, 1 - c.WING_FLAP_AMPLITUDE_SPREAD, 1 + c.WING_FLAP_AMPLITUDE_SPREAD);
      this.flapAsymmetry[i] = rng() * 2 - 1; // left/right desync
      this.colorSeed[i] = rng();

      // No two start mid-stroke together.
      this.wingPhase[i] = rng() * TAU;
      this.swayPhase[i] = rng() * TAU;

      this.#buildOrbitBasis(i, rng);
    }

    // The leader wears the rare morph, and flaps a little harder than the crowd.
    this.colorSeed[this.leader] = 1;
    this.maxSpeed[this.leader] = this.config.MAX_SPEED * 1.22;
    this.accel[this.leader] = this.config.ACCELERATION * 1.3;
    this.flapAmplitude[this.leader] = this.config.WING_FLAP_AMPLITUDE * 1.05;
  }

  /**
   * Orbit planes are biased toward the screen plane so wings stay readable,
   * but tilted enough that a loop around the cursor never looks like a decal.
   */
  #buildOrbitBasis(i, rng) {
    const tilt = randPower(rng, 0, 0.95, 1.3);
    const spin = rng() * TAU;
    const flip = rng() < 0.5 ? -1 : 1;

    // Plane normal: mostly ±Z, tilted by `tilt` radians in a random direction.
    const nx = Math.sin(tilt) * Math.cos(spin);
    const ny = Math.sin(tilt) * Math.sin(spin);
    const nz = Math.cos(tilt) * flip;

    // Any vector perpendicular to n gives us u; v completes the basis.
    let ux = -ny, uy = nx, uz = 0;
    let len = Math.hypot(ux, uy, uz);
    if (len < 1e-4) {
      ux = 1; uy = 0; uz = 0;
      len = 1;
    }
    ux /= len; uy /= len; uz /= len;

    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    const o = i * 3;
    this.slotU[o] = ux; this.slotU[o + 1] = uy; this.slotU[o + 2] = uz;
    this.slotV[o] = vx; this.slotV[o + 1] = vy; this.slotV[o + 2] = vz;
  }

  setBounds(halfWidth, halfHeight, halfDepth) {
    this.bounds[0] = halfWidth;
    this.bounds[1] = halfHeight;
    this.bounds[2] = halfDepth;
  }

  /**
   * Initial spread, biased to the outside.
   *
   * Rejection sampling against a low-frequency noise field gives soft clusters
   * rather than uniform dust, and the centre is kept clear so the first word
   * assembles into empty space with the swarm visibly converging on it.
   */
  distribute() {
    const { positions, velocities, quaternions, forwards, rng, noise } = this;
    const [bx, by, bz] = this.bounds;
    const clearRadius = Math.min(bx, by) * 0.55;

    for (let i = 0; i < this.count; i++) {
      let x = 0, y = 0, z = 0;

      for (let attempt = 0; attempt < 10; attempt++) {
        x = randRange(rng, -bx, bx);
        y = randRange(rng, -by, by);
        z = randRange(rng, -bz, bz) * 0.8;
        const density = noise.noise3(x * 0.14, y * 0.14, z * 0.2) * 0.5 + 0.5;
        const outside = Math.hypot(x, y) > clearRadius;
        if ((density > 0.34 && outside) || attempt === 9) break;
      }

      const p = i * 3;
      positions[p] = x;
      positions[p + 1] = y;
      positions[p + 2] = clamp(z, -bz, bz);

      const speed = randRange(rng, 0.2, 1.1);
      const a = rng() * TAU;
      const b = randRange(rng, -0.5, 0.5);
      velocities[p] = Math.cos(a) * speed;
      velocities[p + 1] = Math.sin(a) * speed;
      velocities[p + 2] = b * speed * 0.3;

      const len = Math.hypot(velocities[p], velocities[p + 1], velocities[p + 2]) || 1;
      forwards[p] = velocities[p] / len;
      forwards[p + 1] = velocities[p + 1] / len;
      forwards[p + 2] = velocities[p + 2] / len;

      quatFromForwardUp(quaternions, i * 4, forwards[p], forwards[p + 1], forwards[p + 2], 0, 0, 1);
      this.energy[i] = randRange(rng, 0.25, 0.6);
    }
  }

  /**
   * Hands the swarm a new set of world-space slots to stand on.
   *
   * Butterflies and slots are both sorted by angle around their own centre and
   * paired in that order. It is not an optimal assignment, but it is a
   * non-crossing one: the swarm folds inward instead of shuffling through
   * itself, which is the difference between a word arriving and a word being
   * sorted out.
   *
   * @param {{points: Float32Array, count: number, spacing: number}} formation
   */
  setFormation(formation) {
    const c = this.config;
    const { positions } = this;
    const n = this.count;
    const formers = this.formerCount;

    const points = formation.points;
    const used = Math.min(formation.count, formers);
    if (used <= 0) return false;

    this.spacing = formation.spacing;

    // Size follows spacing, so a denser word yields smaller butterflies rather
    // than overlapping ones. SLOT_FILL leaves the gap the wings need.
    const fit = clamp((this.spacing * c.SLOT_FILL) / WINGSPAN, c.SCALE_MIN, c.SCALE_MAX);
    for (let i = 0; i < n; i++) this.scale[i] = fit * this.scaleBias[i];

    // Separation is sized to exactly one wingspan of the widest butterfly here,
    // which makes it mean what it needs to mean: two of them closer than this
    // would be overlapping wings. Slots are further apart than that, so at rest
    // the force is asleep and never fights the formation — it only wakes when
    // hovering or flight actually brings a pair together.
    this._sepRadius = Math.max(fit * this.widestBias * WINGSPAN, 0.2);
    this.hash.setCellSize(this._sepRadius);
    this.scale[this.leader] = Math.min(fit * c.LEADER_SCALE, c.SCALE_MAX * 2);

    /* --- order the butterflies by angle around their own centre ----- */
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      if (i === this.leader) continue;
      cx += positions[i * 3];
      cy += positions[i * 3 + 1];
    }
    cx /= formers;
    cy /= formers;

    let k = 0;
    for (let i = 0; i < n; i++) {
      if (i === this.leader) continue;
      this._order[k++] = i;
      this._angle[i] = Math.atan2(positions[i * 3 + 1] - cy, positions[i * 3] - cx);
    }
    const order = this._order.subarray(0, formers);
    order.sort((a, b) => this._angle[a] - this._angle[b]);

    /* --- and the slots by angle around the word --------------------- */
    let sx = 0, sy = 0;
    for (let j = 0; j < used; j++) {
      sx += points[j * 3];
      sy += points[j * 3 + 1];
    }
    sx /= used;
    sy /= used;

    for (let j = 0; j < used; j++) {
      this._slotOrder[j] = j;
      this._slotAngle[j] = Math.atan2(points[j * 3 + 1] - sy, points[j * 3] - sx);
    }
    const slotOrder = this._slotOrder.subarray(0, used);
    slotOrder.sort((a, b) => this._slotAngle[a] - this._slotAngle[b]);

    /* --- pair them -------------------------------------------------- */
    for (let t = 0; t < formers; t++) {
      const i = order[t];
      const j = slotOrder[used === formers ? t : Math.floor((t * used) / formers)];
      const s = i * 3;
      const q = j * 3;

      // Only reached when the sampler could not fill the swarm: the surplus
      // rings its shared slot instead of standing inside another butterfly.
      let ox = 0, oy = 0;
      if (used < formers) {
        const a = this.hoverPhase[i];
        ox = Math.cos(a) * this.spacing * 0.8;
        oy = Math.sin(a) * this.spacing * 0.8;
      }

      this.slots[s] = points[q] + ox;
      this.slots[s + 1] = points[q + 1] + oy;
      this.slots[s + 2] = points[q + 2];
    }

    this.startled.fill(0);
    this.disturbance = 0;
    this.mode = MODE_FORMING;
    this.modeTime = 0;
    this.wantsFormation = false;
    this.formationCount = used;
    this.formationVersion++;

    return true;
  }

  /** Breaks the word apart, blowing outward from (x, y, z). */
  #beginScatter(x, y, z, startled) {
    const c = this.config;
    this.mode = MODE_LOOSE;
    this.modeTime = 0;
    this.scatterX = x;
    this.scatterY = y;
    this.scatterZ = z;
    this.scatterForce = startled ? c.SCATTER_STRENGTH : c.RELEASE_STRENGTH;
    this.disturbance = 0;
  }

  /**
   * One simulation step.
   *
   * @param {number} dt seconds since the last step (already clamped by the caller)
   * @param {object} swarm target + cursor state from SwarmController
   */
  update(dt, swarm) {
    const c = this.config;
    const n = this.count;
    const { positions, velocities, energy } = this;

    this.time += dt;
    this.modeTime += dt;

    const curX = swarm.targetX;
    const curY = swarm.targetY;
    const curZ = swarm.targetZ;
    const activity = swarm.activity;
    const pointerHere = swarm.pointerActive === true;

    this.hash.build(positions);

    const rotationBlend = 1 - dragFactor(c.ROTATION_SMOOTHING, dt);
    const formed = this.mode === MODE_FORMING || this.mode === MODE_HOLDING;
    const burst = this.scatterForce * Math.max(0, 1 - this.modeTime / Math.max(c.SCATTER_DURATION, 1e-3));

    // Does this pointer read as passing *through* them, or resting among them?
    // Anything deliberate counts fully; a hand at rest counts for nothing.
    const sweeping = pointerHere ? smoothstep(0.04, 0.3, activity) : 0;

    let reached = 0;
    let settleSum = 0;
    let sumX = 0, sumY = 0, sumZ = 0, sumSpeed = 0;

    for (let i = 0; i < n; i++) {
      const p = i * 3;
      const px = positions[p];
      const py = positions[p + 1];
      const pz = positions[p + 2];
      let vx = velocities[p];
      let vy = velocities[p + 1];
      let vz = velocities[p + 2];

      let ax = 0, ay = 0, az = 0;
      let rest = 0;

      const isLeader = i === this.leader;

      let startled = this.startled[i];
      if (startled > 0) startled = Math.max(0, startled - dt * c.STARTLE_DECAY);

      if (isLeader) {
        /* --- the one that follows you ------------------------------- */
        this.slotAngle[i] += this.slotSpeed[i] * dt;
        const a = this.slotAngle[i];
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const ux = this.slotU[p], uy = this.slotU[p + 1], uz = this.slotU[p + 2];
        const wx = this.slotV[p], wy = this.slotV[p + 1], wz = this.slotV[p + 2];

        // It circles the pointer rather than sitting on it — a butterfly that
        // lands on the cursor and stops reads as a bug, in both senses.
        const radius = c.LEADER_ORBIT_RADIUS * (0.78 + 0.32 * Math.sin(this.time * 0.7));

        // Aim where the cursor is going, not where it was. Chasing the current
        // position of something faster than you means arriving behind it and
        // turning constantly; a little anticipation turns that into one long
        // sweeping curve. Capped, so a flicked cursor does not fling the goal
        // off screen.
        const leadX = clamp(swarm.cursorVX * c.LEADER_LEAD, -c.LEADER_LEAD_MAX, c.LEADER_LEAD_MAX);
        const leadY = clamp(swarm.cursorVY * c.LEADER_LEAD, -c.LEADER_LEAD_MAX, c.LEADER_LEAD_MAX);

        const goalX = curX + leadX + (ux * ca + wx * sa) * radius;
        const goalY = curY + leadY + (uy * ca + wy * sa) * radius;
        const goalZ = curZ + (uz * ca + wz * sa) * radius * 0.5;

        let dx = goalX - px;
        let dy = goalY - py;
        let dz = goalZ - pz;
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const inv = 1 / dist;
        dx *= inv; dy *= inv; dz *= inv;

        const desired = this.maxSpeed[i] * smoothstep(0.12, 2.6, dist);
        const gain = this.accel[i] * 1.35;
        ax = (dx * desired - vx) * gain;
        ay = (dy * desired - vy) * gain;
        az = (dz * desired - vz) * gain;

        // The tangential force is for circling, so it fades out with distance.
        // Applied while still far away it is a sideways shove during a chase,
        // which spirals the approach instead of curving it.
        const circling = c.LEADER_ORBIT_STRENGTH * (1 - smoothstep(radius * 1.3, radius * 4.5, dist));
        ax += (-ux * sa + wx * ca) * circling;
        ay += (-uy * sa + wy * ca) * circling;
        az += (-uz * sa + wz * ca) * circling * 0.5;
      } else if (formed) {
        /* --- standing in the word ---------------------------------- */
        // A lissajous rather than a circle: shared phase would make the whole
        // word breathe in unison, which no swarm does.
        const hoverA = this.time * c.HOVER_SPEED + this.hoverPhase[i];
        const hover = this.spacing * c.HOVER_RADIUS;
        const goalX = this.slots[p] + Math.cos(hoverA) * hover;
        const goalY = this.slots[p + 1] + Math.sin(hoverA * 1.31 + 0.6) * hover;
        const goalZ = this.slots[p + 2] + Math.sin(hoverA * 0.77) * hover * 0.7;

        const dx = goalX - px;
        const dy = goalY - py;
        const dz = goalZ - pz;
        const dist = Math.hypot(dx, dy, dz);

        // A critically damped spring, not arrival steering: it has to hold a
        // precise point without ringing around it, or the word never sharpens.
        const k = c.FORM_STIFFNESS * this.attraction[i];
        const damping = 2 * Math.sqrt(k) * c.FORM_DAMPING;
        ax = dx * k - vx * damping;
        ay = dy * k - vy * damping;
        az = dz * k - vz * damping;

        // Arc the long approach. A straight line to a slot is what makes a
        // formation look assembled rather than flown.
        if (dist > this.spacing * 4) {
          const curl = c.FORM_CURL * this.orbitTendency[i];
          ax += -dy * curl;
          ay += dx * curl;
        }

        rest = (1 - smoothstep(this.spacing * 0.5, this.spacing * 5, dist)) * (1 - startled);
        settleSum += rest;
      } else {
        /* --- loose: no word yet, or one just broken ---------------- */
        let dx = px - this.scatterX;
        let dy = py - this.scatterY;
        let dz = pz - this.scatterZ;
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const inv = 1 / d;
        ax += dx * inv * burst;
        ay += dy * inv * burst;
        az += dz * inv * burst * 0.6;

        // A light leash, so the pause is not spent pressed against a wall.
        ax -= px * c.LOOSE_COHESION;
        ay -= py * c.LOOSE_COHESION;
        az -= pz * c.LOOSE_COHESION;
      }

      this.settle[i] = rest;

      if (!isLeader) {
        /* --- the cursor is a disturbance --------------------------- */
        const rx = px - curX;
        const ry = py - curY;
        const rz = pz - curZ;
        const r2 = rx * rx + ry * ry + rz * rz;
        const radius = c.DISTURB_RADIUS;

        if (pointerHere && r2 < radius * radius) {
          const r = Math.sqrt(r2) || 1e-4;
          const near = 1 - r / radius;
          const push = (c.DISTURB_STRENGTH * near * near) / r;
          ax += rx * push;
          ay += ry * push;
          az += rz * push * 0.6;

          // The shove above is unconditional — a resting cursor keeps its halo.
          // Being *startled* is not: that belongs to a cursor going somewhere.
          const hit = near * sweeping;
          if (hit > startled) startled = hit;
          reached++;
        }
      }

      this.startled[i] = startled;

      /* --- flow field --------------------------------------------- */
      const nv = this.noise.sampleVector(
        px, py, pz,
        this.time * c.NOISE_TIME_SCALE,
        this.noiseFreq[i],
        this.noisePhase[i],
      );
      // Turned down to a shimmer once settled, or the letters blur; a startled
      // butterfly gets more of it, which is what the scatter looks like.
      const calm = formed && !isLeader ? c.FORM_NOISE_FLOOR + (1 - c.FORM_NOISE_FLOOR) * (1 - rest) : 1;
      const nGain = c.NOISE_STRENGTH * this.noiseAmp[i] * calm * (1 + startled * 1.8);
      ax += nv[0] * nGain;
      ay += nv[1] * nGain;
      az += nv[2] * nGain * 0.5;

      /* --- separation --------------------------------------------- */
      this._sep[0] = 0; this._sep[1] = 0; this._sep[2] = 0;
      this._sepSelf = i;
      this._sepX = px; this._sepY = py; this._sepZ = pz;
      this.hash.forEachNeighbour(px, py, pz, c.MAX_NEIGHBOURS, this._visitNeighbour);
      ax += this._sep[0] * c.SEPARATION_STRENGTH;
      ay += this._sep[1] * c.SEPARATION_STRENGTH;
      az += this._sep[2] * c.SEPARATION_STRENGTH;

      /* --- soft walls --------------------------------------------- */
      ax -= this.#wall(px, this.bounds[0]);
      ay -= this.#wall(py, this.bounds[1]);
      az -= this.#wall(pz, this.bounds[2]) * 1.6;

      /* --- integrate ---------------------------------------------- */
      const forceMag = Math.hypot(ax, ay, az);
      if (forceMag > c.MAX_FORCE) {
        const k = c.MAX_FORCE / forceMag;
        ax *= k; ay *= k; az *= k;
      }

      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;

      // The spring supplies its own damping; doubling it up would make the
      // formation sluggish and rob the flight in of its glide.
      if (!(formed && !isLeader)) {
        const decay = dragFactor(this.drag[i], dt);
        vx *= decay; vy *= decay; vz *= decay;
      }

      const speedLimit = this.maxSpeed[i];
      let speed = Math.hypot(vx, vy, vz);
      if (speed > speedLimit) {
        const k = speedLimit / speed;
        vx *= k; vy *= k; vz *= k;
        speed = speedLimit;
      }

      velocities[p] = vx;
      velocities[p + 1] = vy;
      velocities[p + 2] = vz;

      positions[p] = px + vx * dt;
      positions[p + 1] = py + vy * dt;
      positions[p + 2] = pz + vz * dt;

      /* --- orientation -------------------------------------------- */
      this.#orient(i, vx, vy, vz, speed, rotationBlend, dt, rest);

      /* --- wing energy -------------------------------------------- */
      // Settled butterflies keep a slow flap, startled ones beat hard. The
      // envelope is asymmetric on purpose: a butterfly picks up the beat quickly
      // and lets it die away slowly, which is what reads as bursts and glides
      // rather than as a rate being dialled up and down.
      const speedRatio = clamp(speed / this.maxSpeed[i], 0, 1);
      const target = Math.max(speedRatio, rest * 0.3, startled * 0.9);
      const envelope = target > energy[i] ? c.ENERGY_ATTACK : c.ENERGY_RELEASE;
      energy[i] = damp(energy[i], target, envelope, dt);

      /* --- wingbeat phase ----------------------------------------- */
      // Integrated, never derived from the clock: see the note on `wingPhase`.
      const drive = c.WING_IDLE_FLOOR + (1 - c.WING_IDLE_FLOOR) * energy[i];
      const beatRate = this.flapSpeed[i] * drive;
      this.wingPhase[i] = (this.wingPhase[i] + beatRate * dt) % TAU;
      this.swayPhase[i] = (this.swayPhase[i] + beatRate * c.SWAY_RATIO * dt) % TAU;

      if (!isLeader) {
        sumX += positions[p];
        sumY += positions[p + 1];
        sumZ += positions[p + 2];
      }
      sumSpeed += speed;
    }

    const formers = this.formerCount;
    this.center[0] = sumX / formers;
    this.center[1] = sumY / formers;
    this.center[2] = sumZ / formers;
    this.averageSpeed = sumSpeed / n;
    this.formation = settleSum / formers;

    // Disturbance is the share of the swarm the cursor is currently reaching
    // through, nothing subtler — so DISTURB_TRIGGER reads as "this fraction of
    // them, and the word comes apart".
    this.disturbance = damp(this.disturbance, (reached / formers) * sweeping, 8, dt);

    this.#advanceMode(dt, curX, curY, curZ);
  }

  /** The state machine. Everything interesting about the piece is in here. */
  #advanceMode(dt, curX, curY, curZ) {
    const c = this.config;

    if (this.mode === MODE_FORMING && this.formation > c.FORMED_THRESHOLD) {
      this.mode = MODE_HOLDING;
      this.modeTime = 0;
    }

    // A word can be broken once it is up, or once a forming one has had a
    // moment — without the grace period the burst that scattered them would
    // immediately scatter the regrouping.
    const breakable =
      this.mode === MODE_HOLDING || (this.mode === MODE_FORMING && this.modeTime > c.DISTURB_GRACE);

    if (breakable && this.disturbance > c.DISTURB_TRIGGER) {
      this.#beginScatter(curX, curY, curZ, true);
      return;
    }

    // Left alone, it still moves on: a page that only ever says one word is a
    // screenshot.
    if (this.mode === MODE_HOLDING && this.modeTime > c.HOLD_DURATION) {
      this.#beginScatter(0, 0, 0, false);
      return;
    }

    if (this.mode === MODE_LOOSE && this.modeTime > c.SCATTER_DURATION + c.REGROUP_PAUSE) {
      this.wantsFormation = true;
    }
  }

  /** Restoring force that grows past the boundary — nothing ever escapes. */
  #wall(value, limit) {
    const over = Math.abs(value) - limit;
    if (over <= 0) return 0;
    return Math.sign(value) * Math.min(over * over * 2.2 + over * 3, 40);
  }

  /**
   * Heading follows velocity, but never instantly, and never at all once a
   * butterfly has arrived: a settled one turns to face the viewer at its own
   * slight lean, so the word reads as a field of open wings rather than a row of
   * edge-on slivers.
   */
  #orient(i, vx, vy, vz, speed, blend, dt, rest) {
    const p = i * 3;
    const q = i * 4;
    const { forwards, quaternions } = this;

    const prevFx = forwards[p];
    const prevFy = forwards[p + 1];
    const prevFz = forwards[p + 2];

    let tx = prevFx, ty = prevFy, tz = prevFz;
    if (speed > 1e-3) {
      const inv = 1 / speed;
      tx = vx * inv; ty = vy * inv; tz = vz * inv;
    }

    if (rest > 1e-3) {
      const lean = this.restTilt[i] + Math.sin(this.time * 0.6 + this.hoverPhase[i]) * 0.07;
      tx += (Math.sin(lean) - tx) * rest;
      ty += (Math.cos(lean) - ty) * rest;
      tz += -tz * rest;
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
    }

    let fx = prevFx, fy = prevFy, fz = prevFz;

    // Below ~0.9 u/s the velocity direction is mostly noise, so a slow butterfly
    // turns only slowly — unless it is settling, which has a definite target.
    const trust = Math.max(smoothstep(0.05, 0.9, speed), rest * 0.85);
    const maxStep = this.config.MAX_TURN_RATE * dt * (0.22 + 0.78 * trust);

    let dot = prevFx * tx + prevFy * ty + prevFz * tz;
    dot = dot > 1 ? 1 : dot < -1 ? -1 : dot;

    // Exactly antipodal has no unique rotation and would lerp through zero,
    // so nudge the target off the axis before measuring.
    if (dot < -0.9995) {
      tx += 0.03; ty -= 0.02;
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
      dot = -0.999;
    }

    const angle = Math.acos(dot);
    if (angle > 1e-5) {
      // Rate-limited turn. Taking a bounded step along the chord keeps the
      // result well away from the origin, so no renormalisation blow-ups.
      const t = Math.min(1, maxStep / angle);
      fx = prevFx + (tx - prevFx) * t;
      fy = prevFy + (ty - prevFy) * t;
      fz = prevFz + (tz - prevFz) * t;
      const len = Math.hypot(fx, fy, fz) || 1;
      fx /= len; fy /= len; fz /= len;
    }

    forwards[p] = fx;
    forwards[p + 1] = fy;
    forwards[p + 2] = fz;

    // Wing plane faces the viewer by default; the roll below tips it into turns.
    quatFromForwardUp(this._targetQuat, 0, fx, fy, fz, 0, 0, 1);

    // Bank: how much the heading rotated this frame, about the world view axis.
    // Settled butterflies do not bank — there is no turn to lean into.
    //
    // Taken raw, this is one frame's heading change divided by dt, which is a
    // noisy quantity: on a shape as thin as a butterfly a bank angle that can
    // cross its whole range between frames reads as the body flickering rather
    // than leaning. So it is a target that the actual roll eases toward.
    const turn = (prevFx * fy - prevFy * fx) * (1 - rest);
    const targetRoll = clamp(
      (turn / Math.max(dt, 1e-3)) * this.config.BANK_STRENGTH,
      -this.config.MAX_BANK,
      this.config.MAX_BANK,
    );
    this.roll[i] = damp(this.roll[i], targetRoll, this.config.ROLL_SMOOTHING, dt);
    quatRollLocalY(this._targetQuat, 0, this.roll[i]);

    quatSlerp(quaternions, q, this._targetQuat, 0, blend);
  }
}
