import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { damp } from './utils/math.js';

/**
 * A perspective camera that mostly stays out of the way.
 *
 * It does two jobs: give the swarm real depth, and turn pointer coordinates
 * into a world-space attractor on the focal plane. The parallax is deliberately
 * almost imperceptible — the cursor is the interaction, not the camera.
 */
export class CameraController {
  constructor(config) {
    this.config = config;
    this.camera = new PerspectiveCamera(config.CAMERA_FOV, 1, 0.1, 120);
    this.camera.position.set(0, 0, config.CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, 0);

    this.offsetX = 0;
    this.offsetY = 0;

    this._ray = new Vector3();
    this._origin = new Vector3();

    this.project = this.project.bind(this);
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Half-extents of what is actually on screen at the target plane. */
  getVisibleFrame() {
    const { camera, config } = this;
    const distance = Math.abs(camera.position.z - config.TARGET_PLANE_Z);
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * distance;
    return { halfWidth: halfHeight * camera.aspect, halfHeight };
  }

  /**
   * The same frame plus padding: how far past the edge the swarm may stray.
   * A word is sized against `getVisibleFrame`, since a letter outside the frame
   * is not a letter; the swarm is bounded by this, since a butterfly outside it
   * is just off stage.
   */
  getWorldBounds() {
    const { halfWidth, halfHeight } = this.getVisibleFrame();
    const { BOUNDS_PADDING, DEPTH_RANGE } = this.config;
    return {
      halfWidth: halfWidth + BOUNDS_PADDING,
      halfHeight: halfHeight + BOUNDS_PADDING,
      halfDepth: DEPTH_RANGE,
    };
  }

  /**
   * Unprojects normalised device coordinates onto the target plane.
   * Written into `out` (a Float32Array of 3) — called once per frame, so it
   * reuses two vectors rather than allocating.
   */
  project(ndcX, ndcY, out) {
    const { camera, config } = this;

    this._ray.set(ndcX, ndcY, 0.5).unproject(camera);
    this._origin.copy(camera.position);
    this._ray.sub(this._origin);

    const denominator = this._ray.z;
    const t = Math.abs(denominator) < 1e-6 ? 0 : (config.TARGET_PLANE_Z - this._origin.z) / denominator;

    out[0] = this._origin.x + this._ray.x * t;
    out[1] = this._origin.y + this._ray.y * t;
    out[2] = config.TARGET_PLANE_Z;
  }

  update(dt, pointer) {
    const { config, camera } = this;
    const amount = config.CAMERA_PARALLAX;

    this.offsetX = damp(this.offsetX, pointer.ndcX * amount, config.CAMERA_PARALLAX_SMOOTHING, dt);
    this.offsetY = damp(this.offsetY, pointer.ndcY * amount * 0.6, config.CAMERA_PARALLAX_SMOOTHING, dt);

    camera.position.x = this.offsetX;
    camera.position.y = this.offsetY;
    camera.lookAt(this.offsetX * 0.35, this.offsetY * 0.35, 0);
    camera.updateMatrixWorld();
  }
}
