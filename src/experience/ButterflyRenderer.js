import { Mesh, InstancedInterleavedBuffer, InterleavedBufferAttribute, DynamicDrawUsage } from 'three/webgpu';
import { createButterflyGeometry } from './ButterflyGeometry.js';
import { createButterflyMaterial } from './ButterflyMaterial.js';

/** Floats per instance: iPosition(3+pad) iQuaternion(4) iMotion(4) iFlap(4). */
const INSTANCE_STRIDE = 16;

/**
 * The rendering half. It owns one geometry, one material and one draw call, and
 * its only job each frame is to copy the simulation's buffers into instanced
 * attributes.
 *
 * It never reads back from the GPU and never allocates: `sync()` is one strided
 * write into a single interleaved buffer, plus one upload flag.
 *
 * All sixteen per-instance floats share one InstancedInterleavedBuffer. WebGPU
 * caps a pipeline at `maxVertexBuffers` (8), and three.js spends one slot per
 * distinct BufferAttribute — four here on top of the geometry's own would break
 * that ceiling. Interleaved, the whole set costs a single slot.
 */
export class ButterflyRenderer {
  constructor(config, palette, simulation) {
    this.config = config;
    this.simulation = simulation;

    const count = simulation.count;

    this.geometry = createButterflyGeometry({
      detail: config.GEOMETRY_DETAIL,
      antennae: true,
      instanceCount: count,
    });

    /* Per-instance data, one interleaved record per butterfly:
         0..2   iPosition   world position               (3, offset 0)
         4..7   iQuaternion orientation                  (4, offset 4)
         8..11  iMotion     scale, energy, seed, beat    (4, offset 8)
         12..15 iFlap       sway, amplitude, asym, -     (4, offset 12)
       Position, orientation, scale, energy and the two wing phases change every
       frame. Scale because it is derived from the spacing of whichever word the
       swarm is standing in; the phases because they are accumulated on the CPU
       rather than derived in the shader from the clock. Colour seed, flap
       amplitude and left/right desync are written once. */
    this.instanceData = new InstancedInterleavedBuffer(new Float32Array(count * INSTANCE_STRIDE), INSTANCE_STRIDE);
    this.instanceData.setUsage(DynamicDrawUsage);

    this.geometry.setAttribute('iPosition', new InterleavedBufferAttribute(this.instanceData, 3, 0));
    this.geometry.setAttribute('iQuaternion', new InterleavedBufferAttribute(this.instanceData, 4, 4));
    this.geometry.setAttribute('iMotion', new InterleavedBufferAttribute(this.instanceData, 4, 8));
    this.geometry.setAttribute('iFlap', new InterleavedBufferAttribute(this.instanceData, 4, 12));

    this.material = createButterflyMaterial(config, palette);

    // A plain Mesh over an InstancedBufferGeometry, not an InstancedMesh: the
    // shader places every butterfly from iPosition/iQuaternion, so the built-in
    // instanceMatrix would be sixteen dead floats per instance — and one more
    // vertex buffer to pay for.
    this.mesh = new Mesh(this.geometry, this.material);
    // Placement happens in the shader, so the mesh itself stays at the origin —
    // and must not be culled against that origin.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;

    this.#writeWingPersonalities();
    this.sync();
  }

  /** Written once: the parts of a butterfly that never change again. */
  #writeWingPersonalities() {
    const { simulation } = this;
    const data = this.instanceData.array;

    for (let i = 0; i < simulation.count; i++) {
      const o = i * INSTANCE_STRIDE;

      data[o + 13] = simulation.flapAmplitude[i];
      data[o + 14] = simulation.flapAsymmetry[i];

      // Colour is fixed for the life of a butterfly.
      data[o + 10] = simulation.colorSeed[i];
    }
    this.instanceData.needsUpdate = true;
  }

  /** Copy this frame's simulation state to the GPU. */
  sync() {
    const { simulation } = this;
    const { positions, quaternions, energy, scale, wingPhase, swayPhase } = simulation;
    const data = this.instanceData.array;

    for (let i = 0, count = simulation.count; i < count; i++) {
      const o = i * INSTANCE_STRIDE;
      const p = i * 3;
      const q = i * 4;

      data[o] = positions[p];
      data[o + 1] = positions[p + 1];
      data[o + 2] = positions[p + 2];

      data[o + 4] = quaternions[q];
      data[o + 5] = quaternions[q + 1];
      data[o + 6] = quaternions[q + 2];
      data[o + 7] = quaternions[q + 3];

      data[o + 8] = scale[i];
      data[o + 9] = energy[i];
      data[o + 11] = wingPhase[i];
      data[o + 12] = swayPhase[i];
    }

    this.instanceData.needsUpdate = true;
  }

  get triangleCount() {
    return this.geometry.userData.triangleCount * this.simulation.count;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose?.();
  }
}
