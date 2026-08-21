import { hash11 } from './utils/math.js';

/**
 * A cheap animated 3D flow field.
 *
 * Two octaves of value noise, sampled at three offset domains to build a
 * vector. It is not curl noise, but sampling offset domains keeps the three
 * components uncorrelated, which is what makes the drift read as *wandering*
 * rather than as everything sliding the same way at once.
 *
 * Nothing here allocates: results land in `NoiseSystem.out`.
 */
export class NoiseSystem {
  constructor(seed = 91) {
    this.seed = seed | 0;
    this.out = new Float32Array(3);
  }

  /** Value noise at a lattice point. */
  #lattice(ix, iy, iz) {
    const h = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1274126177)) + this.seed;
    return hash11(h) * 2 - 1;
  }

  /** Trilinearly interpolated value noise in [-1, 1]. */
  noise3(x, y, z) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    let fx = x - x0, fy = y - y0, fz = z - z0;

    // quintic fade — smoother second derivative than smoothstep, no creases
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);

    const c000 = this.#lattice(x0, y0, z0);
    const c100 = this.#lattice(x0 + 1, y0, z0);
    const c010 = this.#lattice(x0, y0 + 1, z0);
    const c110 = this.#lattice(x0 + 1, y0 + 1, z0);
    const c001 = this.#lattice(x0, y0, z0 + 1);
    const c101 = this.#lattice(x0 + 1, y0, z0 + 1);
    const c011 = this.#lattice(x0, y0 + 1, z0 + 1);
    const c111 = this.#lattice(x0 + 1, y0 + 1, z0 + 1);

    const x00 = c000 + (c100 - c000) * ux;
    const x10 = c010 + (c110 - c010) * ux;
    const x01 = c001 + (c101 - c001) * ux;
    const x11 = c011 + (c111 - c011) * ux;

    const y0i = x00 + (x10 - x00) * uy;
    const y1i = x01 + (x11 - x01) * uy;

    return y0i + (y1i - y0i) * uz;
  }

  /** Two octaves — the second adds flutter without adding chaos. */
  fbm(x, y, z) {
    return this.noise3(x, y, z) + this.noise3(x * 2.17, y * 2.17, z * 2.17) * 0.42;
  }

  /**
   * Samples a 3D drift vector into `this.out`.
   * `phase` is the butterfly's personal offset into the field — two butterflies
   * in the same place still get different answers, so they never move as one.
   */
  sampleVector(x, y, z, t, frequency, phase) {
    const fx = x * frequency;
    const fy = y * frequency;
    const fz = z * frequency;

    this.out[0] = this.fbm(fx + phase, fy - t, fz + 11.3);
    this.out[1] = this.fbm(fx + 41.7, fy + phase, fz - t);
    this.out[2] = this.fbm(fx - t, fy + 73.1, fz + phase) * 0.7;

    return this.out;
  }
}
