import {
  BufferGeometry,
  InstancedBufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Shape,
  ShapeGeometry,
} from 'three/webgpu';

/**
 * One butterfly, built procedurally and shared by every instance.
 *
 * Local space:
 *   +Y  head / direction of flight
 *   +X  right wingtip
 *   +Z  wing-plane normal (the side you see when it flies across the screen)
 *
 * Wings are bezier outlines triangulated by ShapeGeometry, which gives a real
 * silhouette — swallowtail-ish forewings with a forward apex, rounder hindwings
 * tucked behind them — instead of a triangle pretending to be a wing.
 *
 * Extra vertex attributes ride along so the GPU can animate it:
 *   aPart    0 body · 1 forewing · 2 hindwing · 3 antenna
 *   aSide    -1 left · 0 centre · +1 right
 *   aHinge   0 at the wing root → 1 at the tip (how much this vertex swings)
 *   aSpan    0 at the root → 1 at the outline (used for the wing pattern)
 *
 * All of it is packed into a single interleaved buffer. WebGPU only allows
 * `maxVertexBuffers` (8 on every current implementation) vertex buffers per
 * pipeline, and three.js WebGPU backend spends one per distinct BufferAttribute
 * — seven here, plus the renderer's per-instance attributes, blows the limit.
 * One interleaved buffer costs one slot no matter how many attributes read it,
 * and reads better on the GPU besides.
 */

const HALF_SPAN = 0.80;

function forewingShape() {
  const s = new Shape();
  s.moveTo(0.03, 0.05);
  s.bezierCurveTo(0.18, 0.33, 0.38, 0.51, 0.60, 0.59); // leading edge
  s.bezierCurveTo(0.72, 0.62, 0.80, 0.60, 0.80, 0.46); // apex — pointed, not domed
  s.bezierCurveTo(0.80, 0.32, 0.70, 0.13, 0.53, -0.01); // outer margin
  s.bezierCurveTo(0.38, -0.09, 0.19, -0.11, 0.03, 0.05); // trailing edge
  return s;
}

function hindwingShape() {
  const s = new Shape();
  s.moveTo(0.03, -0.01);
  s.bezierCurveTo(0.21, -0.03, 0.39, -0.10, 0.50, -0.24);
  s.bezierCurveTo(0.61, -0.38, 0.57, -0.56, 0.42, -0.62);
  s.bezierCurveTo(0.36, -0.645, 0.34, -0.60, 0.30, -0.63); // small tail lobe
  s.bezierCurveTo(0.19, -0.665, 0.10, -0.50, 0.05, -0.30);
  s.bezierCurveTo(0.02, -0.18, 0.01, -0.08, 0.03, -0.01);
  return s;
}

function bodyShape() {
  const s = new Shape();
  s.moveTo(0, 0.35);
  s.bezierCurveTo(0.052, 0.31, 0.058, 0.24, 0.052, 0.15);
  s.bezierCurveTo(0.046, 0.02, 0.036, -0.24, 0.013, -0.47);
  s.bezierCurveTo(0.006, -0.52, -0.006, -0.52, -0.013, -0.47);
  s.bezierCurveTo(-0.036, -0.24, -0.046, 0.02, -0.052, 0.15);
  s.bezierCurveTo(-0.058, 0.24, -0.052, 0.31, 0, 0.35);
  return s;
}

function antennaShape() {
  const s = new Shape();
  s.moveTo(0.012, 0.30);
  s.bezierCurveTo(0.07, 0.42, 0.12, 0.50, 0.175, 0.555);
  s.lineTo(0.205, 0.60); // club at the tip
  s.lineTo(0.178, 0.605);
  s.bezierCurveTo(0.10, 0.53, 0.05, 0.44, -0.004, 0.315);
  return s;
}

/** Pulls a ShapeGeometry apart into plain arrays we can transform and tag. */
function extract(shape, detail) {
  const geometry = new ShapeGeometry(shape, detail);
  const position = Array.from(geometry.attributes.position.array);
  const index = geometry.index ? Array.from(geometry.index.array) : position.map((_, i) => i / 3);
  geometry.dispose();
  return { position, index };
}

export function createButterflyGeometry({ detail = 6, antennae = true, instanceCount = null } = {}) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const parts = [];
  const sides = [];
  const hinges = [];
  const spans = [];
  const indices = [];

  const push = (piece, { part, side, hingeX, hingeY, maxRadius, mirror, tilt = 0, shrink = 1 }) => {
    const base = positions.length / 3;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);

    for (let i = 0; i < piece.position.length; i += 3) {
      let x = piece.position[i];
      let y = piece.position[i + 1];

      // Slight natural asymmetry: the left pair is a touch smaller and set at a
      // marginally different angle, the way a real specimen never quite matches.
      x *= shrink;
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      x = mirror ? -rx : rx;
      y = ry;

      positions.push(x, y, 0);
      normals.push(0, 0, 1);
      uvs.push(Math.abs(x) / HALF_SPAN, (y + 0.7) / 1.3);
      parts.push(part);
      sides.push(side);

      const dx = Math.abs(x) - hingeX;
      const dy = y - hingeY;
      const reach = Math.max(dx, 0) / (HALF_SPAN - hingeX);
      hinges.push(part === 0 ? 0 : Math.pow(Math.min(reach, 1), 0.9));
      spans.push(Math.min(Math.hypot(dx, dy) / maxRadius, 1));
    }

    // Mirroring flips the winding, so the index order has to flip with it.
    for (let i = 0; i < piece.index.length; i += 3) {
      if (mirror) {
        indices.push(base + piece.index[i + 2], base + piece.index[i + 1], base + piece.index[i]);
      } else {
        indices.push(base + piece.index[i], base + piece.index[i + 1], base + piece.index[i + 2]);
      }
    }
  };

  const fore = extract(forewingShape(), detail);
  const hind = extract(hindwingShape(), detail);
  const body = extract(bodyShape(), Math.max(3, detail - 2));
  const antenna = antennae ? extract(antennaShape(), Math.max(3, detail - 3)) : null;

  push(fore, { part: 1, side: 1, hingeX: 0.03, hingeY: 0.05, maxRadius: 0.85, mirror: false });
  push(fore, { part: 1, side: -1, hingeX: 0.03, hingeY: 0.05, maxRadius: 0.85, mirror: true, tilt: 0.026, shrink: 0.975 });
  push(hind, { part: 2, side: 1, hingeX: 0.03, hingeY: -0.01, maxRadius: 0.72, mirror: false });
  push(hind, { part: 2, side: -1, hingeX: 0.03, hingeY: -0.01, maxRadius: 0.72, mirror: true, tilt: 0.02, shrink: 0.98 });
  push(body, { part: 0, side: 0, hingeX: 0, hingeY: 0, maxRadius: 0.9, mirror: false });

  if (antenna) {
    push(antenna, { part: 3, side: 1, hingeX: 0.0, hingeY: 0.30, maxRadius: 0.4, mirror: false });
    push(antenna, { part: 3, side: -1, hingeX: 0.0, hingeY: 0.30, maxRadius: 0.4, mirror: true });
  }

  const vertexCount = positions.length / 3;

  // position(3) normal(3) uv(2) aPart aSide aHinge aSpan
  const STRIDE = 12;
  const vertexData = new Float32Array(vertexCount * STRIDE);

  for (let i = 0; i < vertexCount; i++) {
    const o = i * STRIDE;
    const p = i * 3;
    const t = i * 2;

    vertexData[o] = positions[p];
    vertexData[o + 1] = positions[p + 1];
    vertexData[o + 2] = positions[p + 2];
    vertexData[o + 3] = normals[p];
    vertexData[o + 4] = normals[p + 1];
    vertexData[o + 5] = normals[p + 2];
    vertexData[o + 6] = uvs[t];
    vertexData[o + 7] = uvs[t + 1];
    vertexData[o + 8] = parts[i];
    vertexData[o + 9] = sides[i];
    vertexData[o + 10] = hinges[i];
    vertexData[o + 11] = spans[i];
  }

  const vertexBuffer = new InterleavedBuffer(vertexData, STRIDE);

  const geometry = instanceCount === null ? new BufferGeometry() : new InstancedBufferGeometry();
  if (instanceCount !== null) geometry.instanceCount = instanceCount;

  geometry.setAttribute('position', new InterleavedBufferAttribute(vertexBuffer, 3, 0));
  geometry.setAttribute('normal', new InterleavedBufferAttribute(vertexBuffer, 3, 3));
  geometry.setAttribute('uv', new InterleavedBufferAttribute(vertexBuffer, 2, 6));
  geometry.setAttribute('aPart', new InterleavedBufferAttribute(vertexBuffer, 1, 8));
  geometry.setAttribute('aSide', new InterleavedBufferAttribute(vertexBuffer, 1, 9));
  geometry.setAttribute('aHinge', new InterleavedBufferAttribute(vertexBuffer, 1, 10));
  geometry.setAttribute('aSpan', new InterleavedBufferAttribute(vertexBuffer, 1, 11));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  geometry.userData.triangleCount = indices.length / 3;
  geometry.userData.vertexCount = positions.length / 3;

  return geometry;
}
