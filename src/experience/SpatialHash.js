/**
 * Uniform spatial hash over an unbounded domain.
 *
 * Rebuilt every frame with a counting sort — two linear passes, zero
 * allocations, no O(N²) neighbour scan. Cell size is the separation radius, so
 * a butterfly only ever has to look at its own cell plus the 26 around it.
 * `setCellSize` keeps that true when the radius changes with the formation.
 */
export class SpatialHash {
  constructor(count, cellSize) {
    this.count = count;
    this.cellSize = cellSize;
    this.inverseCellSize = 1 / cellSize;

    // Table sized to the next power of two above 2N: cheap masking, low collisions.
    let size = 1;
    while (size < count * 2) size <<= 1;
    this.tableSize = Math.max(size, 64);
    this.mask = this.tableSize - 1;

    this.cellCount = new Int32Array(this.tableSize + 1);
    this.cellStart = new Int32Array(this.tableSize + 1);
    this.sorted = new Int32Array(count);
    this.keys = new Int32Array(count);
  }

  /**
   * Retunes the grid. Cell size tracks the separation radius, which now comes
   * from the formation's slot spacing rather than a constant — a grid left at
   * the old size still finds neighbours, just by scanning more of them.
   */
  setCellSize(cellSize) {
    this.cellSize = cellSize;
    this.inverseCellSize = 1 / cellSize;
  }

  hashCell(ix, iy, iz) {
    return (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481)) & this.mask;
  }

  /** @param {Float32Array} positions xyz triples */
  build(positions) {
    const { count, inverseCellSize, cellCount, cellStart, sorted, keys } = this;

    cellCount.fill(0);

    for (let i = 0; i < count; i++) {
      const p = i * 3;
      const ix = Math.floor(positions[p] * inverseCellSize);
      const iy = Math.floor(positions[p + 1] * inverseCellSize);
      const iz = Math.floor(positions[p + 2] * inverseCellSize);
      const key = this.hashCell(ix, iy, iz);
      keys[i] = key;
      cellCount[key]++;
    }

    let running = 0;
    for (let c = 0; c < this.tableSize; c++) {
      cellStart[c] = running;
      running += cellCount[c];
      cellCount[c] = cellStart[c]; // reuse as a write cursor
    }
    cellStart[this.tableSize] = running;

    for (let i = 0; i < count; i++) {
      sorted[cellCount[keys[i]]++] = i;
    }
  }

  /**
   * Calls `visit(neighbourIndex)` for candidates in the 3×3×3 cell block around
   * a point, stopping after `budget` candidates. Returning `false` from `visit`
   * also stops the walk.
   */
  forEachNeighbour(x, y, z, budget, visit) {
    const { inverseCellSize, cellStart, sorted } = this;
    const cx = Math.floor(x * inverseCellSize);
    const cy = Math.floor(y * inverseCellSize);
    const cz = Math.floor(z * inverseCellSize);

    let visited = 0;

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const key = this.hashCell(cx + ox, cy + oy, cz + oz);
          const start = cellStart[key];
          const end = cellStart[key + 1];

          for (let s = start; s < end; s++) {
            if (visit(sorted[s]) === false) return;
            if (++visited >= budget) return;
          }
        }
      }
    }
  }
}
