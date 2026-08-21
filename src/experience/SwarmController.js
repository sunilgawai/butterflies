import { clamp, damp, dragFactor } from './utils/math.js';

/**
 * The bridge between a raw pointer and something a swarm can react to.
 *
 * Raw pointer coordinates are jittery and arrive at unpredictable rates, so the
 * swarm never sees them. It sees a smoothed world-space point, its velocity, and
 * `activity` — a continuous 0..1 value that replaces any isMoving boolean.
 *
 * It also reports `pointerActive`, which is the one thing the word depends on:
 * only a pointer the viewer is actually holding may disturb the formation. When
 * they let go, the target drifts on a slow tour around the frame — the companion
 * butterfly still has somewhere to be, and a drifting target that nobody is
 * steering must not carve a hole through the letters.
 *
 * `project` is injected: (ndcX, ndcY, out) -> world point on the target plane.
 */
export class SwarmController {
  constructor(config, project) {
    this.config = config;
    this.project = project;

    this.rawX = 0; this.rawY = 0; this.rawZ = config.TARGET_PLANE_Z;
    this.targetX = 0; this.targetY = 0; this.targetZ = config.TARGET_PLANE_Z;

    this.cursorVX = 0;
    this.cursorVY = 0;
    this.cursorVZ = 0;
    this.cursorSpeed = 0;

    this.activity = 0;
    this.pointerActive = false;
    this.time = 0;

    // Half-extents of the tour the target takes when nobody is steering.
    this.wanderX = config.IDLE_WANDER_RADIUS;
    this.wanderY = config.IDLE_WANDER_RADIUS * 0.6;

    this._out = new Float32Array(3);
    this._wander = new Float32Array(3);
  }

  /** Keeps the idle tour just inside the visible frame at any aspect ratio. */
  setBounds(halfWidth, halfHeight) {
    this.wanderX = halfWidth * 0.72;
    this.wanderY = halfHeight * 0.6;
  }

  update(dt, pointer) {
    const c = this.config;
    this.time += dt;

    if (pointer.hasPointer) {
      this.project(pointer.ndcX, pointer.ndcY, this._out);
      this.rawX = this._out[0];
      this.rawY = this._out[1];
      this.rawZ = this._out[2];
    }

    // A pointer only counts as held while it is still being moved. Past that the
    // swarm stops treating it as a presence at all, which is what keeps an
    // abandoned cursor from standing in the middle of the word forever.
    this.pointerActive = pointer.hasPointer && pointer.timeSinceMove < c.IDLE_WANDER_DELAY;

    const idleAmount = pointer.hasPointer
      ? clamp((pointer.timeSinceMove - c.IDLE_WANDER_DELAY) / 3, 0, 1)
      : 1;

    if (idleAmount > 0) {
      const t = this.time;
      // A slow circuit of the frame, at two incommensurable rates so it never
      // repeats and never quite closes into a circle.
      const angle = t * 0.19 + Math.sin(t * 0.11) * 0.85;
      const breathe = 1 + Math.sin(t * 0.27 + 1.3) * 0.12;

      this._wander[0] = Math.cos(angle) * this.wanderX * breathe;
      this._wander[1] = Math.sin(angle) * this.wanderY * breathe;
      this._wander[2] = Math.sin(t * 0.13 + 2.3) * c.DEPTH_RANGE * 0.3;

      const pull = 0.8 * idleAmount;
      this.rawX = damp(this.rawX, this._wander[0], pull, dt);
      this.rawY = damp(this.rawY, this._wander[1], pull, dt);
      this.rawZ = damp(this.rawZ, c.TARGET_PLANE_Z + this._wander[2], pull, dt);
    }

    const prevX = this.targetX;
    const prevY = this.targetY;
    const prevZ = this.targetZ;

    this.targetX = damp(this.targetX, this.rawX, c.CURSOR_SMOOTHING, dt);
    this.targetY = damp(this.targetY, this.rawY, c.CURSOR_SMOOTHING, dt);
    this.targetZ = damp(this.targetZ, this.rawZ, c.CURSOR_SMOOTHING, dt);

    const invDt = 1 / Math.max(dt, 1e-4);
    const vx = (this.targetX - prevX) * invDt;
    const vy = (this.targetY - prevY) * invDt;
    const vz = (this.targetZ - prevZ) * invDt;

    // Smooth the velocity too — a single dropped frame should not spike the swarm.
    const k = dragFactor(12, dt);
    this.cursorVX = vx + (this.cursorVX - vx) * k;
    this.cursorVY = vy + (this.cursorVY - vy) * k;
    this.cursorVZ = vz + (this.cursorVZ - vz) * k;
    this.cursorSpeed = Math.hypot(this.cursorVX, this.cursorVY, this.cursorVZ);

    // Asymmetric envelope: energy arrives fast, drains slowly. This is what
    // decides whether a cursor is passing through the word or resting in it.
    const targetActivity = clamp(this.cursorSpeed / c.CURSOR_REFERENCE_SPEED, 0, 1);
    const rate = targetActivity > this.activity ? c.ACTIVITY_ATTACK : c.ACTIVITY_RELEASE;
    this.activity = damp(this.activity, targetActivity, rate, dt);
  }
}
