/**
 * Turns pointer, touch and pen input into normalised device coordinates.
 *
 * Nothing here knows about the swarm — it only reports where the pointer is,
 * whether it is down, and how long it has been quiet. One listener, no
 * per-event allocation, and `touch-action: none` on the canvas so dragging on a
 * phone steers the swarm instead of scrolling the page.
 */
export class PointerTracker {
  constructor(element) {
    this.element = element;

    this.ndcX = 0;
    this.ndcY = 0;
    this.isDown = false;
    this.hasPointer = false;
    this.timeSinceMove = Infinity;

    this._onMove = this._onMove.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onLeave = this._onLeave.bind(this);

    element.addEventListener('pointermove', this._onMove, { passive: true });
    element.addEventListener('pointerdown', this._onDown, { passive: true });
    window.addEventListener('pointerup', this._onUp, { passive: true });
    element.addEventListener('pointerleave', this._onLeave, { passive: true });
  }

  _read(event) {
    const rect = this.element.getBoundingClientRect();
    this.ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.hasPointer = true;
    this.timeSinceMove = 0;
  }

  _onMove(event) {
    this._read(event);
  }

  _onDown(event) {
    this.isDown = true;
    this._read(event);
  }

  _onUp() {
    this.isDown = false;
  }

  _onLeave() {
    // Keep the last known position: the swarm should drift, not teleport home.
    this.isDown = false;
  }

  update(dt) {
    this.timeSinceMove += dt;
  }

  dispose() {
    this.element.removeEventListener('pointermove', this._onMove);
    this.element.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    this.element.removeEventListener('pointerleave', this._onLeave);
  }
}
