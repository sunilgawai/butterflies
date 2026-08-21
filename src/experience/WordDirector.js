import { pickGreeting, glyphCount } from './greetings.js';
import { TextSampler } from './text/TextSampler.js';

/**
 * Butterflies across a typical stroke, below which a word stops being readable.
 *
 * Calibrated by looking: at 2.3 "Hello" reads, at 1.8 the same word is a scatter
 * of butterflies with no letters in it. Measured rather than assumed, so it holds
 * for any script — eight Latin letters and two Chinese characters can share a
 * glyph count and a width while differing threefold in stroke length, and no
 * amount of counting glyphs would tell them apart.
 */
const MIN_STROKE_RATIO = 2.25;

/**
 * Decides which word the swarm says next, and turns it into slots.
 *
 * This is the seam between the browser and the simulation. Rasterising text
 * needs a canvas; steering butterflies must not. So the simulation raises
 * `wantsFormation`, this asks for a greeting, samples it, and hands back
 * world-space points — and the simulation never learns that words exist.
 *
 * The greeting is always "hello": only the language changes, so a viewer who
 * reloads or disturbs the swarm sees the same thing said again rather than a
 * different message.
 */
export class WordDirector {
  constructor(config, rng) {
    this.config = config;
    this.rng = rng;
    this.sampler = new TextSampler();

    this.current = null; // { language, text }
    this.formation = null;
    this.changes = 0;
    this.retired = new Set(); // words this system turned out to have no font for
    this.tooFine = new Set(); // words too intricate to read at the current size

    // World half-extents a word may occupy; set from the camera on resize.
    this.maxWidth = 8;
    this.maxHeight = 4;
  }

  /** Waits for system fonts, so the first word is not measured before they load. */
  async ready() {
    await TextSampler.ready();
  }

  /**
   * The word must fit the frame with room to breathe, and a narrow frame also
   * caps how long a word may be: a long one laid across a phone shrinks until
   * neither the letters nor the butterflies survive it.
   */
  setFrame(halfWidth, halfHeight) {
    const margin = this.config.WORD_MARGIN;
    this.maxWidth = halfWidth * 2 * margin;
    // Less vertical room than horizontal: a word tall enough to fill the frame
    // leaves the companion butterfly nowhere to be, and reads as a wall.
    this.maxHeight = halfHeight * 2 * margin * 0.7;

    // Word length has to be rationed by width. A word is only ever as tall as
    // its width allows, and butterflies are sized to the gap between slots — so
    // laying a long word across a narrow frame shrinks them twice over, once for
    // the width and once again for every extra letter sharing it.
    this.maxGlyphs =
      this.maxWidth < 7 ? 3
      : this.maxWidth < 11 ? 4
      : this.maxWidth < 16 ? 5
      : 8;

    // A word rejected as too intricate may be perfectly legible at a new size.
    this.tooFine.clear();
  }

  /**
   * Picks the next greeting and samples it into slots.
   *
   * @param {number} count how many butterflies need somewhere to stand
   * @returns {?{greeting: object, formation: object}} null if nothing could be sampled
   */
  next(count) {
    const pinned = this.config.WORD;

    // A script this system has no font for comes out as a row of tofu boxes,
    // which has ink and would be spelled out as rectangles. Retire it and try
    // another: bounded attempts, because "every word failed" has to end in a
    // return rather than in a stack overflow.
    for (let attempt = 0; attempt < 6; attempt++) {
      const greeting = pinned
        ? { language: 'pinned', text: pinned }
        : pickGreeting(this.rng, {
            maxGlyphs: this.maxGlyphs,
            exclude: this.current?.text ?? null,
            unavailable: this.unavailable,
          });

      if (!this.sampler.supports(greeting.text)) {
        this.retired.add(greeting.text);
        if (pinned) break;
        continue;
      }

      const formation = this.#sample(greeting.text, count);

      // Both ways a word can fail to be worth showing are properties of this word
      // at this frame size rather than of the word, so they go in a set a resize
      // clears rather than the permanent one. A pinned word is shown regardless:
      // the viewer asked for it.
      if (formation !== null && !pinned && this.#tooFineToRead(formation)) {
        this.tooFine.add(greeting.text);
        continue;
      }

      if (formation !== null) {
        this.current = greeting;
        this.formation = formation;
        this.changes++;
        return { greeting, formation };
      }

      this.retired.add(greeting.text);
      if (pinned) break;
    }

    // Last resort: the one word every system on earth can draw.
    const formation = this.#sample('Hello', count);
    if (formation === null) return null;

    this.current = { language: 'English', text: 'Hello' };
    this.formation = formation;
    this.changes++;
    return { greeting: this.current, formation };
  }

  /**
   * Two ways a word can be not worth standing in: too few butterflies across a
   * stroke to read it, or butterflies too small to see. Both come out of the same
   * quantity — how far apart the slots ended up — pulling in opposite directions,
   * which is why a word can fail either way and neither can be fixed by resizing
   * anything afterwards.
   */
  #tooFineToRead(formation) {
    if (formation.strokeRatio < MIN_STROKE_RATIO) return true;
    return formation.spacing * this.config.SLOT_FILL < this.config.MIN_WINGSPAN;
  }

  #sample(text, count) {
    return this.sampler.sample(text, {
      count,
      spacing: this.config.SLOT_SPACING,
      maxWidth: this.maxWidth,
      maxHeight: this.maxHeight,
      depth: this.config.WORD_DEPTH,
      rng: this.rng,
    });
  }

  /** Everything the picker should currently skip, for whatever reason. */
  get unavailable() {
    return this.retired.size ? new Set([...this.retired, ...this.tooFine]) : this.tooFine;
  }

  /** Longest word this frame can take, for the record. */
  get limit() {
    return this.maxGlyphs === Infinity ? 'any' : `${this.maxGlyphs} glyphs`;
  }

  /** Glyph count of what is on screen, for the debug panel. */
  get glyphs() {
    return this.current ? glyphCount(this.current.text) : 0;
  }
}
