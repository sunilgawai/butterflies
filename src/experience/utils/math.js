/**
 * Dependency-free math helpers.
 *
 * The simulation runs on flat Float32Arrays and never imports three.js, which
 * keeps it testable in plain Node and cheap to run (no per-frame allocations).
 */

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const smoothstep = (edge0, edge1, x) => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is "how fast", in units of 1/second. dt-safe at any frame rate.
 */
export const damp = (current, target, rate, dt) =>
  target + (current - target) * Math.exp(-rate * dt);

/** Multiplier form of the same curve, for velocities: v *= dragFactor(rate, dt) */
export const dragFactor = (rate, dt) => Math.exp(-rate * dt);

/** Deterministic 32-bit hash -> [0,1). Same seed always gives the same swarm. */
export function hash11(seed) {
  let n = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

/** Small seeded PRNG (mulberry32) for reproducible personalities. */
export function makeRandom(seed = 1337) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randRange = (rng, min, max) => min + (max - min) * rng();

/** Biased random: `power` > 1 clusters toward min, < 1 toward max. */
export const randPower = (rng, min, max, power) =>
  min + (max - min) * Math.pow(rng(), power);

/* ------------------------------------------------------------------ *
 * Quaternion helpers operating on a flat array at offset `o` (x,y,z,w)
 * ------------------------------------------------------------------ */

/**
 * Build a quaternion from an orthonormal-ish basis where the object's local
 * +Y points along `forward` and local +Z points along `up`.
 * (Butterfly local space: +Y = head, +X = right wingtip, +Z = wing-plane normal.)
 */
export function quatFromForwardUp(out, o, fx, fy, fz, ux, uy, uz) {
  // Gram-Schmidt: project `up` off `forward`
  const d = fx * ux + fy * uy + fz * uz;
  let zx = ux - fx * d;
  let zy = uy - fy * d;
  let zz = uz - fz * d;
  let len = Math.hypot(zx, zy, zz);

  if (len < 1e-5) {
    // forward is parallel to up: pick any perpendicular axis
    zx = Math.abs(fz) < 0.9 ? -fy : 1;
    zy = Math.abs(fz) < 0.9 ? fx : 0;
    zz = 0;
    len = Math.hypot(zx, zy, zz) || 1;
  }
  zx /= len;
  zy /= len;
  zz /= len;

  // x = forward x up  (right-handed: X cross Y = Z)
  const xx = fy * zz - fz * zy;
  const xy = fz * zx - fx * zz;
  const xz = fx * zy - fy * zx;

  // Rotation matrix columns: X = (xx,xy,xz), Y = (fx,fy,fz), Z = (zx,zy,zz)
  const m00 = xx, m01 = fx, m02 = zx;
  const m10 = xy, m11 = fy, m12 = zy;
  const m20 = xz, m21 = fz, m22 = zz;

  const trace = m00 + m11 + m22;
  let x, y, z, w;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }

  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = w;
}

/** q = q * quaternion(axis=localY, angle) — banking roll around the body axis. */
export function quatRollLocalY(out, o, angle) {
  const s = Math.sin(angle * 0.5);
  const c = Math.cos(angle * 0.5);
  const ax = out[o], ay = out[o + 1], az = out[o + 2], aw = out[o + 3];
  const bx = 0, by = s, bz = 0, bw = c;
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by + ay * bw + az * bx - ax * bz;
  out[o + 2] = aw * bz + az * bw + ax * by - ay * bx;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** Spherical interpolation, writing into `out` at offset `o`. */
export function quatSlerp(out, o, src, so, t) {
  let ax = out[o], ay = out[o + 1], az = out[o + 2], aw = out[o + 3];
  let bx = src[so], by = src[so + 1], bz = src[so + 2], bw = src[so + 3];

  let cosom = ax * bx + ay * by + az * bz + aw * bw;
  if (cosom < 0) {
    cosom = -cosom;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }

  let scale0, scale1;
  if (1 - cosom > 1e-6) {
    const omega = Math.acos(cosom);
    const sinom = Math.sin(omega);
    scale0 = Math.sin((1 - t) * omega) / sinom;
    scale1 = Math.sin(t * omega) / sinom;
  } else {
    scale0 = 1 - t;
    scale1 = t;
  }

  ax = scale0 * ax + scale1 * bx;
  ay = scale0 * ay + scale1 * by;
  az = scale0 * az + scale1 * bz;
  aw = scale0 * aw + scale1 * bw;

  const len = Math.hypot(ax, ay, az, aw) || 1;
  out[o] = ax / len;
  out[o + 1] = ay / len;
  out[o + 2] = az / len;
  out[o + 3] = aw / len;
}
