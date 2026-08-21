/**
 * Every number that shapes the feel of the piece lives here.
 *
 * Tune at runtime without a reload:  window.swarm.config.HOLD_DURATION = 4
 * Tune from the URL:                 ?count=200&debug=1&word=Hello
 */

export const CONFIG = {
  /* population ---------------------------------------------------- */
  // One of these follows the cursor; the rest stand in the word. Frame time is
  // not the constraint — a thousand of them cost about a millisecond of CPU. The
  // trade is legibility against size: butterflies are scaled to the gap between
  // slots, so more of them spell a clearer word out of smaller butterflies, and
  // fewer give big obvious butterflies in a word you have to guess at. Around
  // two hundred is where both survive.
  BUTTERFLY_COUNT: 220,
  GEOMETRY_DETAIL: 6, // bezier segments per wing curve

  /* world --------------------------------------------------------- */
  DEPTH_RANGE: 3.4, // ± z spread when loose
  BOUNDS_PADDING: 2.6, // how far past the visible frame they may stray
  TARGET_PLANE_Z: 0, // depth of the plane the cursor is projected onto

  /* the word ------------------------------------------------------ */
  SLOT_SPACING: 0.52, // world gap to aim for between neighbouring butterflies
  SLOT_FILL: 0.76, // wingspan as a fraction of that gap — the rest is air
  WORD_MARGIN: 0.84, // fraction of the visible frame a word may fill
  WORD_DEPTH: 0.75, // ± z given to the word, for a little volume
  FORM_STIFFNESS: 7.5, // spring constant pulling a butterfly onto its slot
  FORM_DAMPING: 1.0, // 1 = critically damped: arrives without ringing
  FORM_CURL: 0.55, // sideways bias on the long approach, so paths arc
  FORM_NOISE_FLOOR: 0.14, // flow field left running once settled — a shimmer
  HOVER_RADIUS: 0.18, // hover excursion, as a fraction of slot spacing
  HOVER_SPEED: 0.9,
  FORMED_THRESHOLD: 0.82, // mean arrival at which the word counts as standing
  HOLD_DURATION: 16, // seconds a word stands before moving on by itself

  /* disturbance --------------------------------------------------- */
  DISTURB_RADIUS: 2.6, // how far the cursor's presence is felt
  DISTURB_STRENGTH: 26, // how hard it shoves
  DISTURB_TRIGGER: 0.06, // share of the swarm the cursor must sweep through to break it
  DISTURB_GRACE: 1.1, // seconds a forming word is immune, so it can regroup
  STARTLE_DECAY: 0.55, // 1/s — how fast a butterfly forgets being startled
  SCATTER_STRENGTH: 15, // outward burst when the cursor breaks a word
  RELEASE_STRENGTH: 5, // gentler bloom when a word simply times out
  SCATTER_DURATION: 1.5, // seconds of flight before regrouping is considered
  REGROUP_PAUSE: 0.5, // beat of drifting before the next word arrives
  LOOSE_COHESION: 0.35, // light leash so a scatter never ends against a wall

  /* the one that follows you -------------------------------------- */
  LEADER_SCALE: 1.85, // larger than the crowd, so it reads as a companion
  LEADER_ORBIT_RADIUS: 1.1, // it circles the pointer rather than landing on it
  LEADER_ORBIT_STRENGTH: 3.2,
  LEADER_LEAD: 0.14, // seconds of cursor motion to aim ahead of — anticipation
  LEADER_LEAD_MAX: 2.2, // world units, so a flicked cursor cannot fling the goal

  /* steering ------------------------------------------------------ */
  MAX_SPEED: 8.4, // world units / second
  ACCELERATION: 4.6, // steering responsiveness (the leader's chase)
  MAX_FORCE: 34, // hard cap so nothing snaps
  DAMPING: 0.66, // drag rate (1/s), applied when not held by a spring
  SLOT_DRIFT_SPEED: 0.42, // how fast the leader's orbit plane rotates

  /* organic motion ------------------------------------------------ */
  NOISE_STRENGTH: 2.4,
  NOISE_FREQUENCY: 0.24, // spatial frequency of the flow field
  NOISE_TIME_SCALE: 0.28, // how fast the field itself evolves

  /* crowding ------------------------------------------------------ */
  // Radius is derived from the achieved slot spacing, not set here: at rest
  // every pair is already further apart than that, so this force stays asleep
  // until two butterflies actually converge.
  SEPARATION_STRENGTH: 9.0,
  // Candidates examined per butterfly, not neighbours found. The 3x3x3 cell
  // block around a butterfly in a formed word holds roughly this many, and a
  // budget that runs out early is worse than useless here: the walk visits
  // cells in a fixed order, so it would keep sampling the same far corner and
  // never look at whichever butterfly is actually closest.
  MAX_NEIGHBOURS: 28,

  /* cursor -------------------------------------------------------- */
  CURSOR_SMOOTHING: 7.0, // rate for raw -> smoothed pointer
  CURSOR_REFERENCE_SPEED: 13.0, // cursor speed that counts as activity = 1
  ACTIVITY_ATTACK: 9.0, // rise rate of activityLevel
  ACTIVITY_RELEASE: 0.85, // fall rate — deliberately slow
  IDLE_WANDER_DELAY: 2.4, // seconds without a pointer before it drifts on its own
  IDLE_WANDER_RADIUS: 6.2, // it drifts on a ring *around* the word, never through

  /* orientation --------------------------------------------------- */
  ROTATION_SMOOTHING: 6.5,
  MAX_TURN_RATE: 7.0, // rad/s — the hard stop against any visible snap
  BANK_STRENGTH: 0.85, // roll into turns
  MAX_BANK: 1.0,
  ROLL_SMOOTHING: 9.0, // 1/s — a raw per-frame bank angle reads as flickering

  /* wings --------------------------------------------------------- */
  WING_FLAP_SPEED: 15.0, // ~2.4 Hz at full energy
  WING_FLAP_SPEED_SPREAD: 0.42,
  WING_FLAP_AMPLITUDE: 1.12, // radians at the wingtip
  WING_FLAP_AMPLITUDE_SPREAD: 0.3,
  WING_IDLE_FLOOR: 0.5, // wings never stop, even fully settled
  WING_BOB: 0.5, // lift per downstroke, in wingspans — butterflies bounce
  SWAY_RATIO: 0.3, // antenna and abdomen sway, as a fraction of the beat rate
  ENERGY_ATTACK: 7.0, // 1/s — how fast the beat picks up
  ENERGY_RELEASE: 2.2, // and how slowly it dies away. Asymmetry reads as gliding

  /* size ---------------------------------------------------------- */
  // Bounds on the scale *derived* from slot spacing, not the scale itself. These
  // are a guard against absurdity, not a design choice: SCALE_MIN in particular
  // must stay below anything the derivation can ask for, because clamping it
  // upward would make butterflies wider than the gaps they were sized to fit —
  // quietly undoing the one property the whole arrangement exists to guarantee.
  // MIN_WINGSPAN is the real floor, and it is enforced by refusing the word
  // rather than by resizing the butterflies.
  SCALE_MIN: 0.09,
  SCALE_MAX: 0.62,
  MIN_WINGSPAN: 0.15, // world units; below this a butterfly is a speck

  /* rendering ----------------------------------------------------- */
  MAX_PIXEL_RATIO: 1.75,
  CAMERA_DISTANCE: 17,
  CAMERA_FOV: 42,
  CAMERA_PARALLAX: 0.55,
  CAMERA_PARALLAX_SMOOTHING: 1.6,
  FOG_NEAR: 12,
  FOG_FAR: 34,

  /* debug --------------------------------------------------------- */
  DEBUG: false,
  WORD: null, // ?word=Hello pins the greeting, for looking at one of them
};

const URL_KEYS = {
  count: 'BUTTERFLY_COUNT',
  spacing: 'SLOT_SPACING',
  hold: 'HOLD_DURATION',
  disturb: 'DISTURB_RADIUS',
  noise: 'NOISE_STRENGTH',
  speed: 'MAX_SPEED',
  maxSpeed: 'MAX_SPEED',
  depth: 'DEPTH_RANGE',
  debug: 'DEBUG',
  word: 'WORD',
};

/**
 * Returns a fresh config adapted to the device, with URL overrides applied.
 *
 * A narrow screen gets fewer butterflies — not for frame time, but because the
 * word has to fit across it, and the same crowd spread over less width means
 * slots too close together for anything to be legible.
 */
export function resolveConfig(overrides = {}) {
  const config = { ...CONFIG, ...overrides };

  if (typeof window !== 'undefined') {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const width = window.innerWidth;

    // A narrow frame gets fewer butterflies, but far fewer than it first appears
    // it should. The camera's vertical span is fixed, so a portrait phone shows a
    // world barely six units across, and butterflies are scaled to the gap
    // between slots — so cutting the count is the only way to keep them from
    // becoming specks.
    //
    // The floor matters more than the curve. How many butterflies land across a
    // stroke — the thing that decides whether the word can be read at all —
    // depends on their *number*, not on the size of the frame they are in: halve
    // the frame and both stroke and spacing halve with it. So cutting the count
    // on a small screen buys visible butterflies and pays for them in legibility,
    // and below about ninety there is no word left to look at.
    const aspect = width / Math.max(window.innerHeight, 1);
    const roominess = Math.min(1, Math.pow(aspect / 1.6, 1.5));
    config.BUTTERFLY_COUNT = Math.max(90, Math.round(config.BUTTERFLY_COUNT * roominess));

    if (width < 700 || coarse) {
      config.MAX_PIXEL_RATIO = Math.min(config.MAX_PIXEL_RATIO, 1.5);
      config.DEPTH_RANGE *= 0.8;
      config.GEOMETRY_DETAIL = 5;
      config.DISTURB_RADIUS *= 0.85;
    }

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      config.MAX_SPEED *= 0.55;
      config.NOISE_STRENGTH *= 0.4;
      config.WING_FLAP_SPEED *= 0.6;
      config.HOVER_RADIUS *= 0.5;
      config.SCATTER_STRENGTH *= 0.6;
      config.HOLD_DURATION *= 2;
    }

    const params = new URLSearchParams(window.location.search);
    for (const [param, key] of Object.entries(URL_KEYS)) {
      if (!params.has(param)) continue;
      const raw = params.get(param);
      if (key === 'DEBUG') config[key] = raw !== '0' && raw !== 'false';
      else if (key === 'WORD') config[key] = raw || null;
      else config[key] = Number(raw);
    }
  }

  return config;
}
