import { MeshBasicNodeMaterial, DoubleSide, Color } from 'three/webgpu';
import {
  attribute,
  positionGeometry,
  cameraPosition,
  positionView,
  faceDirection,
  uniform,
  varying,
  vec3,
  float,
  color,
  sin,
  cos,
  mix,
  smoothstep,
  step,
  clamp,
  cross,
  normalize,
  pow,
  max,
} from 'three/tsl';

/**
 * Everything that moves *within* a butterfly happens here, on the GPU.
 *
 * The CPU sends eleven floats per instance per frame (position, orientation,
 * scale, energy, and the two accumulated wing phases). The tip flex, the antenna sway,
 * the abdomen sway, the flight bob, the colour, the two-sided translucency and the
 * depth fade are all evaluated per vertex in TSL — none of it costs a CPU cycle,
 * and none of it is shared between instances.
 *
 * What is *not* here is the wingbeat's phase. Anything whose rate varies has to
 * be integrated, and a shader has nowhere to keep a running total: see the note
 * beside `wingPhase` below.
 *
 * Note on placement: NodeMaterial applies `positionNode` *after* its own
 * instancing node and overwrites the result, so this material does the instance
 * transform itself with a quaternion attribute. That is also cheaper than a
 * matrix — 7 floats per instance instead of 16 — which is why the renderer
 * draws an InstancedBufferGeometry rather than an InstancedMesh.
 *
 * Every attribute read here is interleaved into two buffers (one per-vertex,
 * one per-instance) on the geometry side. WebGPU allows only 8 vertex buffers
 * per pipeline and three.js spends one per distinct BufferAttribute, so the
 * eleven attributes below would not otherwise fit.
 */

/** v rotated by unit quaternion q:  v + 2q.w(q.xyz × v) + 2 q.xyz × (q.xyz × v) */
function rotateByQuaternion(v, q) {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}

/** Rotation about the body axis (local Y): the wing hinge. */
function swingAroundBodyAxis(p, angle) {
  const c = cos(angle);
  const s = sin(angle);
  return vec3(p.x.mul(c).sub(p.z.mul(s)), p.y, p.x.mul(s).add(p.z.mul(c)));
}

export function createButterflyMaterial(config, palette) {
  /* --- per-vertex (shared by every butterfly) ---------------------- */
  const aPart = attribute('aPart', 'float');
  const aSide = attribute('aSide', 'float');
  const aHinge = attribute('aHinge', 'float');
  const aSpan = attribute('aSpan', 'float');

  /* --- per-instance ------------------------------------------------ */
  const iPosition = attribute('iPosition', 'vec3');
  const iQuaternion = attribute('iQuaternion', 'vec4');
  const iMotion = attribute('iMotion', 'vec4'); // scale, energy, colourSeed, wingPhase
  const iFlap = attribute('iFlap', 'vec4'); // swayPhase, amplitude, asymmetry, spare

  const uBob = uniform(float(config.WING_BOB));
  const uFogNear = uniform(float(config.FOG_NEAR));
  const uFogFar = uniform(float(config.FOG_FAR));
  const uBackground = uniform(color(palette.background));

  const energy = iMotion.y;
  const scale = iMotion.x;
  const seed = iMotion.z;

  /* --- wing phase --------------------------------------------------
     Both phases arrive already integrated, per butterfly, per frame. This used
     to be sin(time · rate) evaluated here, with rate riding on the butterfly's
     speed — frequency modulation done by scaling the sine's argument, so every
     change of speed displaced the phase by time · deltaRate. Thirty seconds in, a
     hard turn skipped ten wing cycles between two frames, which is exactly what
     flickering wings look like. Integration belongs on the CPU, where there is
     somewhere to keep the running total. */
  const wingPhase = iMotion.w;
  const swayPhase = iFlap.x;
  const asymmetry = iFlap.z;

  /* --- masks: which part of the body is this vertex? --------------- */
  const isWing = step(0.5, aPart).mul(step(aPart, float(2.5)));
  const isHind = step(1.5, aPart).mul(step(aPart, float(2.5)));
  const isAntenna = step(2.5, aPart);
  const isBody = step(aPart, float(0.5));

  /* --- wingbeat ---------------------------------------------------- */
  // Amplitude rides on the butterfly's own speed, but never reaches zero: a
  // settled butterfly still breathes. (Rate does too, but that is applied where
  // the phase is integrated.)
  const amplitude = iFlap.y.mul(energy.mul(0.45).add(0.62));

  // Hind wings lag the forewings; the two sides are a hair out of step.
  const phase = wingPhase
    .add(isHind.mul(0.38))
    .add(aSide.mul(asymmetry).mul(0.14))
    // The tip lags the root, so the wing bends and whips instead of staying flat.
    .sub(aHinge.mul(0.55));

  const beat = clamp(sin(phase).mul(0.5).add(0.5), 0, 1);
  // Biased so the wings dwell at the top of the stroke and snap through the bottom.
  const stroke = pow(beat, 0.72).mul(1.25).sub(0.28);

  const wingAngle = stroke.mul(amplitude).mul(aHinge).mul(isHind.mul(-0.18).add(1));
  const antennaAngle = sin(swayPhase).mul(0.09).mul(aHinge);

  const swing = wingAngle.mul(isWing).add(antennaAngle.mul(isAntenna)).mul(aSide);

  let local = swingAroundBodyAxis(positionGeometry, swing);
  let localNormal = swingAroundBodyAxis(vec3(0, 0, 1), swing);

  // The abdomen sways gently against the wingbeat — small, but it is the
  // difference between a creature and a decorated triangle.
  const abdomen = clamp(positionGeometry.y.negate().mul(2.2), 0, 1).mul(isBody);
  // Offset from the antennae so the two are never in lockstep.
  local = local.add(vec3(sin(swayPhase.add(1.9)).mul(0.018).mul(abdomen), 0, 0));

  /* --- place the instance ------------------------------------------ */
  // Butterflies bounce. Each downstroke lifts the whole insect, which is why real
  // ones travel in a scalloped line rather than gliding level — and it is the
  // difference between wings that flap and wings that appear to be doing work.
  // Locked to the wingbeat, and quadratic in energy: bobbing is a function of the
  // work of flying, so a butterfly standing in a word barely moves. That matters
  // for more than looks — this displacement happens after the simulation has
  // spaced everyone out, so it is clearance being spent. Squared, a settled pair
  // in antiphase uses about a seventh of the gap the wings leave; linear, half.
  const bob = sin(wingPhase).mul(uBob).mul(energy.mul(energy)).mul(scale);

  const worldPosition = rotateByQuaternion(local.mul(scale), iQuaternion)
    .add(iPosition)
    .add(vec3(0, bob, 0));
  const worldNormal = rotateByQuaternion(localNormal, iQuaternion);

  /* --- colour ------------------------------------------------------ */
  const ember = color(palette.ember);
  const rose = color(palette.rose);
  const gold = color(palette.gold);
  const rare = color(palette.rare);
  const bodyColor = color(palette.body);

  let base = mix(ember, rose, smoothstep(0.0, 0.5, seed));
  base = mix(base, gold, smoothstep(0.5, 0.85, seed));
  base = mix(base, rare, smoothstep(0.94, 1.0, seed)); // a rare few, for sparkle

  // Wing markings: darker outer margin, pale inner field, one soft band.
  const margin = smoothstep(0.66, 0.99, aSpan);
  const inner = smoothstep(0.55, 0.02, aSpan);
  const band = smoothstep(0.5, 0.66, aSpan).mul(smoothstep(0.86, 0.7, aSpan));

  let wing = mix(base, base.mul(0.22), margin.mul(0.9));
  wing = mix(wing, base.mul(1.3).add(0.08), inner.mul(0.4));
  wing = mix(wing, base.mul(1.5).add(0.12), band.mul(0.35));
  wing = mix(wing, wing.mul(0.84), isHind.mul(0.6)); // hind wings sit deeper

  const surface = mix(bodyColor, wing, isWing);

  /* --- two-sided shading ------------------------------------------- */
  // Wings are thin membranes: lit from the front, they read as pigment; lit
  // from behind, the light comes *through* them. Turning butterflies flare.
  const n = normalize(varying(worldNormal)).mul(faceDirection);
  const lightDirection = normalize(vec3(-0.35, 0.55, 0.78));
  const viewDirection = normalize(cameraPosition.sub(varying(worldPosition)));

  const facing = clamp(n.dot(lightDirection), 0, 1);
  const behind = clamp(n.dot(lightDirection).negate(), 0, 1);
  const rim = pow(float(1).sub(clamp(n.dot(viewDirection), 0, 1)), 2.6);

  const brightness = float(0.46).add(facing.mul(0.72));
  const translucency = pow(behind, 1.6).mul(0.62).mul(isWing);

  let lit = surface.mul(brightness);
  lit = lit.add(base.mul(translucency));
  lit = lit.add(base.mul(rim).mul(0.16).mul(isWing));

  // Tiny per-instance exposure variation so no two read identically.
  lit = lit.mul(seed.mul(0.26).add(0.87));

  /* --- atmosphere --------------------------------------------------- */
  const depth = positionView.z.negate();
  const fog = smoothstep(uFogNear, uFogFar, depth);
  const final = mix(lit, uBackground, fog.mul(0.88));

  /* --- material ----------------------------------------------------- */
  const material = new MeshBasicNodeMaterial();
  material.side = DoubleSide;
  material.color = new Color(0xffffff);
  material.positionNode = worldPosition;
  material.colorNode = max(final, vec3(0));
  material.transparent = false; // opaque keeps depth correct and the swarm crisp
  material.userData.uniforms = { uBob, uFogNear, uFogFar, uBackground };

  return material;
}
