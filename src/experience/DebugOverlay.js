import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
} from 'three/webgpu';

/**
 * Development instrumentation. Off in production; press `d` or add ?debug=1.
 *
 * Shows the numbers that matter while tuning (frame time, which word is up, how
 * assembled it is, how close the cursor is to breaking it) and draws the
 * invisible structure: the radius within which the cursor is felt, and every
 * velocity vector.
 */
export class DebugOverlay {
  constructor(config, simulation, scene) {
    this.config = config;
    this.simulation = simulation;
    this.enabled = false;

    this.frames = 0;
    this.elapsed = 0;
    this.fps = 0;
    this.worst = 0;

    this.group = new Group();
    this.group.visible = false;
    this.group.frustumCulled = false;
    scene.add(this.group);

    // The disturbance radius, and the halo inside it where the shove is hardest.
    this.rings = [
      this.#ring(config.DISTURB_RADIUS, 0xe2707e),
      this.#ring(config.DISTURB_RADIUS * 0.45, 0xf5d08a),
    ];

    const velocities = new BufferGeometry();
    velocities.setAttribute('position', new BufferAttribute(new Float32Array(simulation.count * 6), 3));
    this.velocityLines = new LineSegments(velocities, new LineBasicMaterial({ color: 0x8fb8ff }));
    this.velocityLines.frustumCulled = false;
    this.group.add(this.velocityLines);

    this.element = document.createElement('div');
    this.element.className = 'debug-panel';
    this.element.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.element);

    window.addEventListener('keydown', (event) => {
      if (event.key === 'd' || event.key === 'D') this.toggle();
    });

    if (config.DEBUG) this.toggle();
  }

  #ring(radius, color) {
    const segments = 72;
    const points = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      points[i * 3] = Math.cos(a) * radius;
      points[i * 3 + 1] = Math.sin(a) * radius;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(points, 3));
    const line = new Line(geometry, new LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
    line.frustumCulled = false;
    this.group.add(line);
    return line;
  }

  toggle() {
    this.enabled = !this.enabled;
    this.group.visible = this.enabled;
    this.element.style.display = this.enabled ? 'block' : 'none';
  }

  update(dt, swarm, backend, director) {
    this.frames++;
    this.elapsed += dt;
    this.worst = Math.max(this.worst, dt);

    if (this.elapsed >= 0.5) {
      this.fps = this.frames / this.elapsed;
      this.frames = 0;
      this.elapsed = 0;
    }

    if (!this.enabled) return;

    for (const ring of this.rings) {
      ring.position.set(swarm.targetX, swarm.targetY, swarm.targetZ);
    }

    const { positions, velocities, count } = this.simulation;
    const line = this.velocityLines.geometry.attributes.position.array;
    for (let i = 0; i < count; i++) {
      const p = i * 3;
      const o = i * 6;
      line[o] = positions[p];
      line[o + 1] = positions[p + 1];
      line[o + 2] = positions[p + 2];
      line[o + 3] = positions[p] + velocities[p] * 0.12;
      line[o + 4] = positions[p + 1] + velocities[p + 1] * 0.12;
      line[o + 5] = positions[p + 2] + velocities[p + 2] * 0.12;
    }
    this.velocityLines.geometry.attributes.position.needsUpdate = true;

    const sim = this.simulation;
    const word = director?.current;
    const trigger = this.config.DISTURB_TRIGGER;

    // A bar is easier to read at a glance than a number you have to compare
    // against a threshold you can't see.
    const bar = (value, max) => {
      const filled = Math.round(clampUnit(value / max) * 12);
      return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(12 - filled)}`;
    };

    this.element.textContent = [
      `backend      ${backend}`,
      `fps          ${this.fps.toFixed(0)}  (worst frame ${(this.worst * 1000).toFixed(1)}ms)`,
      `butterflies  ${count}  (1 follows the cursor)`,
      '',
      `word         ${word ? `${word.text}  ${word.language}` : '—'}`,
      `words shown  ${director?.changes ?? 0}`,
      `slots        ${sim.formationCount}  spacing ${sim.spacing.toFixed(3)}`,
      `size         ${sim.scale[1]?.toFixed(3) ?? '—'}  (wingspan ${(sim.scale[1] * 1.6).toFixed(2)})`,
      '',
      `mode         ${sim.mode}  ${sim.modeTime.toFixed(1)}s`,
      `assembled    ${bar(sim.formation, 1)} ${sim.formation.toFixed(2)}`,
      `disturbance  ${bar(sim.disturbance, trigger)} ${sim.disturbance.toFixed(3)} / ${trigger}`,
      `pointer      ${swarm.pointerActive ? 'held' : 'idle'}  activity ${swarm.activity.toFixed(2)}`,
      `mean speed   ${sim.averageSpeed.toFixed(2)}`,
      '',
      'd  toggle debug',
    ].join('\n');

    this.worst = 0;
  }
}

const clampUnit = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
