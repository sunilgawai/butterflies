import { Scene, Color, Timer, WebGPURenderer, NeutralToneMapping } from 'three/webgpu';

import { resolveConfig } from './config.js';
import { PALETTE } from './palette.js';
import { PointerTracker } from './PointerTracker.js';
import { SwarmController } from './SwarmController.js';
import { ButterflySimulation } from './ButterflySimulation.js';
import { ButterflyRenderer } from './ButterflyRenderer.js';
import { CameraController } from './CameraController.js';
import { WordDirector } from './WordDirector.js';
import { DebugOverlay } from './DebugOverlay.js';

/**
 * Wires the pieces together and owns the frame loop.
 *
 *   pointer → camera → cursor target → simulation → GPU upload → render
 *                                          │
 *                        wantsFormation ───┴──▶ WordDirector → slots
 *
 * Simulation and rendering stay strangers: `ButterflySimulation` never imports
 * three.js, `ButterflyRenderer` never decides how anything moves, and neither of
 * them knows that the arrangement they are working on spells anything.
 */
export class ButterflyExperience {
  constructor(canvas, overrides = {}) {
    this.canvas = canvas;
    this.config = resolveConfig(overrides);
    this.palette = PALETTE;

    this.scene = new Scene();
    this.scene.background = new Color(PALETTE.background);

    this.timer = new Timer();
    this.maxDelta = 1 / 20; // a stalled tab must not teleport the swarm

    this.cameraController = new CameraController(this.config);
    this.pointer = new PointerTracker(canvas);
    this.swarm = new SwarmController(this.config, this.cameraController.project);

    this.simulation = new ButterflySimulation(this.config);
    this.butterflies = new ButterflyRenderer(this.config, PALETTE, this.simulation);
    this.scene.add(this.butterflies.mesh);

    // Seeded from the clock, so a reload genuinely changes the language. The
    // simulation's own randomness stays seeded and reproducible.
    this.director = new WordDirector(this.config, makeClockRandom());

    this.debug = new DebugOverlay(this.config, this.simulation, this.scene);
    this.caption = document.querySelector('#caption');

    this.renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this._onResize = this.resize.bind(this);
    this._tick = this.tick.bind(this);
    this.running = false;
  }

  async start() {
    await this.renderer.init();
    await this.director.ready();

    this.backend = this.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';

    this.resize();
    this.simulation.distribute();

    // The first word is set before the first frame, so the swarm is already on
    // its way in when the page fades up rather than milling about.
    this.#formNextWord();
    this.butterflies.sync();

    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);

    this.running = true;
    this.renderer.setAnimationLoop(this._tick);

    return this;
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // High-DPI phones will happily render four times the pixels they need to.
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.config.MAX_PIXEL_RATIO);

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.cameraController.resize(width, height);

    const bounds = this.cameraController.getWorldBounds();
    this.simulation.setBounds(bounds.halfWidth, bounds.halfHeight, bounds.halfDepth);
    this.swarm.setBounds(bounds.halfWidth, bounds.halfHeight);

    const frame = this.cameraController.getVisibleFrame();
    this.director.setFrame(frame.halfWidth, frame.halfHeight);
  }

  /** Asks for the next greeting and hands its slots to the swarm. */
  #formNextWord() {
    const next = this.director.next(this.simulation.formerCount);
    if (next === null) return false;

    this.simulation.setFormation(next.formation);
    this.#showCaption(next.greeting);
    return true;
  }

  #showCaption(greeting) {
    if (!this.caption) return;
    this.caption.textContent = `${greeting.text} · ${greeting.language}`;
    // Restart the fade by letting a frame pass with the class removed.
    this.caption.classList.remove('is-visible');
    requestAnimationFrame(() => this.caption.classList.add('is-visible'));
  }

  tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), this.maxDelta);

    this.pointer.update(dt);
    this.cameraController.update(dt, this.pointer);
    this.swarm.update(dt, this.pointer);
    this.simulation.update(dt, this.swarm);

    if (this.simulation.wantsFormation) this.#formNextWord();

    this.butterflies.sync();
    this.debug.update(dt, this.swarm, this.backend, this.director);

    this.renderer.render(this.scene, this.cameraController.camera);
  }

  dispose() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.pointer.dispose();
    this.butterflies.dispose();
    this.renderer.dispose();
  }
}

/**
 * A small PRNG seeded from the clock. The word choice should differ every
 * reload; everything else in the piece stays deterministic, so this is the only
 * place entropy gets in.
 */
function makeClockRandom() {
  let a = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
