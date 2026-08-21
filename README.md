# Butterfly swarm

A swarm of butterflies that spells **hello**. Three.js + TSL, GPU instancing, one
draw call.

One butterfly — larger, in the rare pale-cyan morph — follows your cursor. The
rest fly in from across the frame and settle onto sampled points of a word: hello
in one of thirty-four languages, picked fresh on every load. Move the cursor
*through* them and they scatter, then regroup to say the same thing in a language
they have not used yet.

---

## Run it

**No build step.** The page carries an import map, so any static server works:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the address it prints. Opening `index.html` directly from the file
system will *not* work — ES modules need to be served over http.

**With a bundler**, if you'd rather have a local copy of three:

```bash
npm install
npm run dev
```

Vite resolves `three/webgpu` and `three/tsl` from `node_modules` and ignores the
import map.

**Tests** (headless, no browser needed):

```bash
npm test
```

---

## Requirements

Runs on **WebGPU** where available and falls back to **WebGL 2** automatically —
`WebGPURenderer` picks the backend at `init()`. The debug panel shows which one
you got.

Needs three.js **≥ 0.16x** for the `three/webgpu` and `three/tsl` entry points.
Pinned to 0.185.1 in the import map.

---

## Techniques

Grouped by where the work happens. The prose sections below explain the ones
that were load-bearing; this is the inventory.

**Rendering**
- `WebGPURenderer` with automatic WebGL 2 fallback, chosen at `init()`
- TSL node materials throughout — no hand-written GLSL or WGSL anywhere
- One instanced draw call for the whole swarm, `InstancedBufferGeometry` over a
  plain `Mesh` rather than an `InstancedMesh` carrying an unread `instanceMatrix`
- Eleven vertex attributes packed into two interleaved buffers, to live inside
  WebGPU's cap of eight vertex buffers per pipeline
- Instance placement from a quaternion attribute in `positionNode` — seven floats
  per instance instead of a matrix's sixteen
- Procedural geometry: bezier wing outlines triangulated by `ShapeGeometry`, with
  deliberate left/right asymmetry, plus body and antennae
- Two-sided translucency, rim light, per-instance exposure variation, depth fog

**On the GPU, per vertex, per instance**
- Wingbeat with a biased stroke — dwelling at the top, snapping through the bottom
- Wing-tip phase lag, so the wing bends and whips rather than staying flat
- Hindwings trailing the forewings; the two sides a hair out of step
- Antenna and abdomen sway; flight bob locked to the beat and quadratic in effort
- Wing markings derived from a per-vertex span coordinate

**Simulation** — plain arithmetic over `Float32Array`s, imports no three.js
- Critically damped spring onto each formation slot, with a curl so long
  approaches arc instead of running straight
- Spatial hash rebuilt per frame by counting sort — two linear passes, no
  allocation, no O(N²) neighbour scan
- Separation radius derived from achieved slot spacing, so it sleeps at rest
- Rate-limited heading change and smoothed banking; quaternion slerp orientation
  with a rest pose so settled butterflies turn to face the viewer
- **Integrated** wingbeat phase, asymmetric energy envelope, soft quadratic walls
- Frame-rate independent exponential smoothing; seeded PRNG for reproducibility
- Per-butterfly personality across fourteen parameters
- Three-state machine — loose, forming, holding — driven by arrival and disturbance
- Two-octave value-noise flow field sampled at offset domains

**Turning a word into places to stand**
- Canvas rasterisation, so the *browser* shapes and lays out the text: every
  script the system has a font for arrives correct for free
- Blue-noise sampling by dart-throwing over a grid of `minDistance/√2` cells
- Closed-form sizing — solve for the word scale whose ink area holds N points at
  the target spacing, then give way to the frame
- Chamfer distance transform, and priority-ordered sampling from it, so points
  land along stroke centrelines instead of scattering across their width
- A **measured** legibility gate, plus a minimum-wingspan gate that refuses a word
  rather than resizing the butterflies
- Tofu detection against a known-notdef codepoint, so a missing script falls back
  instead of spelling rectangles
- Non-crossing assignment: butterflies and slots sorted by angle and paired, so
  the swarm folds inward rather than shuffling through itself

**Interaction**
- One pointer listener, no per-event allocation, `touch-action: none`
- Smoothed world-space target with an asymmetric activity envelope
- Disturbance defined as the share of the swarm the cursor is reaching through
- An always-on repulsion halo, but a movement-gated scatter trigger — so a
  resting cursor is a presence, not a stampede
- Autonomous word changes, and an idle cursor tour that never crosses the letters

**Adapting to the device**
- Count scaled by frame aspect with a floor; word length rationed by frame width
- `prefers-reduced-motion`, capped device pixel ratio, inline SVG favicon,
  `aria-live` caption naming the greeting and its language

**Verification**
- 60 headless checks, two suites, no browser — the simulation is testable in Node
  precisely because it knows nothing about three.js or about words
- Spacing guarantee checked by brute-force closest pair; wingbeat continuity and
  bank rate limits guarded by regression tests
- Frame-rate independence at 30 / 60 / 144; 1000 butterflies under 1 ms of CPU
- Browser runs driven over the Chrome DevTools Protocol, with the GPU instance
  buffer read back and compared field-by-field against the simulation

---

## Architecture

```
src/
  main.js
  experience/
    ButterflyExperience.js   renderer, frame loop, resize
    ButterflySimulation.js   formation springs, the leader, disturbance, orientation
    ButterflyRenderer.js     one instanced draw call; copies sim buffers to the GPU
    ButterflyGeometry.js     procedural bezier wings, body, antennae
    ButterflyMaterial.js     TSL: wing deformation, placement, shading
    WordDirector.js          picks the next greeting, turns it into slots
    greetings.js             hello in thirty-four languages
    text/
      TextSampler.js         canvas raster → world-space points
      blueNoise.js           dart-throwing with a spacing guarantee
      distanceField.js       depth inside a stroke, for centreline placement
    SwarmController.js       smoothed target, cursor velocity, activity level
    PointerTracker.js        pointer / touch / pen → normalised coordinates
    NoiseSystem.js           two-octave value-noise flow field
    SpatialHash.js           counting-sort grid for O(N) separation
    CameraController.js      perspective camera, parallax, unprojection
    DebugOverlay.js          FPS, stats, radius and velocity helpers
    config.js                every tunable number
    palette.js               colour
    utils/math.js            vector, quaternion and easing helpers
test/
  simulation.test.mjs        formation, scatter, regroup, spacing, cost
  text.test.mjs              spacing guarantee, distance field, greeting list
```

The frame is:

```
pointer → camera → cursor target → simulation → GPU upload → render
                                       │
                     wantsFormation ───┴──▶ WordDirector → slots
```

The swarm has three states, and the whole piece is in the transitions:

```
loose ──setFormation()──▶ forming ──assembled──▶ holding
  ▲                                                 │
  └───────── cursor moves through them, or ──────────┘
            the word has stood long enough
```

**Simulation and rendering are strangers.** `ButterflySimulation` imports no
three.js at all — it is plain arithmetic over `Float32Array`s. That is why the
motion can be tested headlessly in Node, and it means the renderer never gets a
vote on how anything moves.

**The simulation also does not know that words exist.** It is handed world-space
slots and raises `wantsFormation` when it wants the next set. Rasterising text
needs a canvas, so that lives in `WordDirector` on the other side of the seam —
which is what lets the formation be tested in Node against synthetic slots.

### What runs where

| CPU (`ButterflySimulation`) | GPU (`ButterflyMaterial`, TSL) |
| --- | --- |
| formation springs, hover | wing-tip flex and whip |
| separation, soft walls | antenna sway, abdomen sway |
| the leader's chase and orbit | flight bob, locked to the beat |
| cursor disturbance, scatter | instance placement (quaternion) |
| heading, banking, energy | wing markings, two-sided translucency, depth fade |
| **wingbeat phase** (see below) | amplitude and stroke shaping |

The CPU sends **11 floats per instance per frame** (position, orientation, scale,
energy, and two accumulated wing phases). Everything else that happens *within* a
butterfly is evaluated per vertex on the GPU and is never shared between
instances.

### How a word gets built

The sizing runs backwards from the butterflies, not from the type. Given how many
there are and how far apart they must stay, there is exactly one word size whose
inked area holds them all:

```
inkArea(world) = count · spacing² / PACKING_EFFICIENCY
worldPerPixel  = √( inkArea(world) / inkPixels )
```

So the word is scaled to the swarm rather than the swarm being crammed into the
word. Only when that size overflows the frame does anything give — and then it is
the spacing, reported back so the butterflies can shrink to match.

Three things follow from that, and each of them was a bug before it was a rule:

**Non-overlap is a property of the arrangement, not a force.** Slots come from
dart-throwing with a guaranteed minimum separation, and butterfly size is
*derived* from the spacing actually achieved (`SLOT_FILL` is the wingspan as a
fraction of the gap). Separation exists only to cover the moments when hovering
or flight brings a pair together — at rest every pair is already further apart
than its radius, so it is asleep and never fights the formation. This is also why
`SCALE_MIN` is set well below anything the derivation can ask for: clamping it
upward would make wings wider than the gaps they were sized to fit.

**Points go on the stroke centreline.** With barely two butterflies across a
stroke, sampling at random scatters them across the width and reads as noise. A
chamfer distance transform gives each pixel its depth inside the ink, and
candidates are offered to the sampler deepest-first — so they line up along the
spine and the letter survives. It is the single largest legibility win in here.

**Legibility is measured, not assumed.** `strokeRatio` — butterflies across a
typical stroke — is computed from the distance field and the achieved spacing,
and a word below `MIN_STROKE_RATIO` is refused and another tried. Calibrated by
looking: at 2.3 "Hello" reads, at 1.8 the same word is a scatter with no letters
in it. Counting glyphs could not do this job; eight Latin letters and two Chinese
characters can share a glyph count *and* a width while differing threefold in
total stroke length.

The browser does the typesetting. Rasterising through canvas means every script
the system has a font for — Devanagari, Arabic, Thai, CJK — arrives correctly
shaped for free. A script with *no* font does not arrive blank, though; it arrives
as tofu boxes, which have plenty of ink and would be dutifully spelled out as
rectangles, so each word is checked glyph-by-glyph against a codepoint that
certainly has no glyph before it is used.

---

### Four implementation details worth knowing

**`positionNode` overwrites instancing.** `NodeMaterial.setupPosition()` applies
its instancing node *first*, then assigns `positionNode` over the top. A wing
deformation written against `positionLocal` would therefore be operating in
post-instance space and rotate about the wrong axis. This material does the
instance transform itself, from a quaternion attribute — which is also cheaper
than a matrix (7 floats instead of 16), and means the draw is a plain `Mesh`
over an `InstancedBufferGeometry` rather than an `InstancedMesh` carrying an
`instanceMatrix` nothing reads. The mesh sits at the origin with
`frustumCulled = false`, since its transform no longer describes where anything
actually is.

**WebGPU allows only 8 vertex buffers per pipeline.** The three.js WebGPU
backend spends one buffer slot per distinct `BufferAttribute`, and this
butterfly wants eleven attributes — `position`, `normal`, `uv`, four per-vertex
tags and four per-instance records. Declared separately that is a hard
`Vertex buffer count (10) exceeds the maximum number of vertex buffers (8)`
pipeline failure and a black screen. They are therefore packed into two
interleaved buffers — one per-vertex (stride 12), one per-instance (stride 16) —
which cost one slot each no matter how many attributes read from them. Anything
added later should join a stride, not claim a new attribute.

**A varying rate has to be integrated, not multiplied.** The wingbeat was
`sin(time · rate)` in the shader, with `rate` riding on the butterfly's speed.
That is frequency modulation done by scaling the sine's argument, and it is wrong
in a way that hides: any change of rate displaces the phase by `time · Δrate`, so
the error grows with how long the page has been open. Thirty seconds in, a hard
turn skipped **ten wing cycles in a single frame** against 0.25 radians of
legitimate motion — which is what "the wings flicker" looks like from the outside,
and why it was worst on the one butterfly whose speed never settles. Phase is now
accumulated on the CPU (`wingPhase`, `swayPhase`, wrapped to `TAU`) and passed in
as an attribute; a shader has nowhere to keep a running total. `npm test` asserts
the phase can never advance by more than one frame of the fastest possible beat.

A second-order version of the same mistake: the bank angle was one frame's heading
change divided by `dt`, taken raw. On a shape this thin a roll that can cross its
whole range between frames reads as the body flickering rather than leaning, so it
is now a target the roll eases toward.

**The import map must map `three/webgpu`, not just `three`.** `three.tsl.js`
imports that bare specifier internally. Map only `three` and you load the library
twice, and the renderer will not recognise TSL nodes built by the other copy.

---

## Tuning

Everything lives in `src/experience/config.js`. Three ways to change it:

```js
// live, in the console — no reload
swarm.config.HOLD_DURATION = 4;
swarm.config.DISTURB_RADIUS = 5;
```

```
?word=Hello&count=300&spacing=0.6&hold=4&disturb=5&debug=1
```

```js
new ButterflyExperience(canvas, { BUTTERFLY_COUNT: 300 });
```

The knobs that change the feel most:

| Parameter | Effect |
| --- | --- |
| `BUTTERFLY_COUNT` | the whole trade: more spell a clearer word out of smaller butterflies |
| `SLOT_SPACING` | the gap aimed for between them, and so how big they end up |
| `SLOT_FILL` | wingspan as a fraction of that gap. The rest is air |
| `HOLD_DURATION` | how long a word stands before it moves on by itself |
| `DISTURB_RADIUS` / `_STRENGTH` | how far the cursor is felt, and how hard it shoves |
| `DISTURB_TRIGGER` | share of the swarm a sweep must reach to break the word |
| `FORM_STIFFNESS` / `FORM_DAMPING` | how urgently they arrive, and whether they ring |
| `HOVER_RADIUS` | how much a settled butterfly drifts. Too much blurs the letters |
| `WING_BOB` | how much each downstroke lifts the insect. This is most of "it flies" |
| `ENERGY_ATTACK` / `_RELEASE` | asymmetric, so the beat picks up fast and dies away slow |
| `ROLL_SMOOTHING` | how much the bank is allowed to change per second |
| `MAX_TURN_RATE` | hard ceiling on heading change — the anti-snap guarantee |
| `WING_IDLE_FLOOR` | how alive a fully settled butterfly looks |

`?word=` pins one greeting, which is the only way to look at a specific script on
purpose. Pinned words skip the legibility gate — you asked for it.

Count, pixel ratio and geometry detail scale down on small screens, word length is
rationed by frame width, and `prefers-reduced-motion` is respected. The count
floor matters more than it looks: how many butterflies land across a stroke
depends on their *number*, not on the size of the frame, so cutting the count on a
phone buys visible butterflies and pays for them in legibility.

---

## Debug mode

Press **`d`**, or load with `?debug=1`. Shows backend, FPS and worst frame time,
which word is up and in what language, slot count and achieved spacing, the size
it produced, the current state and how long it has been in it, plus bars for how
assembled the word is and how close the cursor is to breaking it. Draws the
disturbance radius around the cursor and a velocity vector on every butterfly.
Off in production.

---

## Verified

`npm test` runs two headless suites — 31 checks on the simulation, 20 on the text
pipeline. No browser needed.

**The formation** (`test/simulation.test.mjs`). Words are rasterised in the
browser, so these stand in synthetic slot sets; the simulation cannot tell the
difference, which is the point of the seam.

```
no NaN / Infinity after 30s of forming and scattering
speed respects the per-butterfly limit
the wingbeat advances by at most one frame of beat, ever
the slow sway advances smoothly too, and phase stays float32-resolvable
bank angle is rate-limited, not taken raw from one frame
butterflies converge on their slots        (5.87 → 0.096)
the word reports itself assembled, and reaches holding
no two butterflies share a place           (closest 0.487 of 0.520 spacing)
no pair of wings overlaps, bob included    (deepest overlap 0.000)
a tight word is not clamped to a larger size
a cursor moving through them breaks the word
a new word is asked for, and the swarm reassembles
a still cursor never breaks the word — but does clear a halo
the leader reaches the cursor, is never given a slot, wears the rare colour
an undisturbed word still gives way to the next
nothing escapes with the cursor jammed in a corner
same result at 30 / 60 / 144 fps           (spread 0.0001)
butterflies do not move as one object      (speed CV 0.74)
1000 butterflies fit in a 16ms budget      (0.94ms/frame of CPU sim)
```

**The word pipeline** (`test/text.test.mjs`) — the spacing guarantee everything
else rests on, checked by brute-force closest-pair:

```
no two points closer than the reported spacing, on open and concave masks
every point sits on an inked pixel
reduces spacing rather than returning too few, in one pass
the density estimate is honest (predicted spacing fits without relaxing)
same seed gives the same arrangement
priority pulls points toward the stroke centre  (4.43px → 2.55px offset)
the distance field is exact on a known bar
```

**In a real browser** (WebGPU, headless Chrome over CDP), driven with real pointer
events rather than simulated state. The instance attributes are read back off the
GPU buffer and checked field-by-field against the simulation, since a layout
mismatch there is silent:

```
Jambo · Swahili        assembled 1.00, 219 slots, worst wing overlap 0.000
  ↓ pointer swept through the middle
scattered              mode loose
  ↓ pointer parked out of the way
Szia · Hungarian       assembled 0.95, a language it had not used
console output         0 messages — no warnings, no validation errors
```

And the wingbeat, sampled every frame while the pointer is yanked around hard
enough to swing the leader's energy from 0.18 to 0.85 and its speed to 9 u/s:

```
worst wing-phase step   0.313 rad   (ceiling 0.387 — one frame of the fastest beat)
phase jumps             0
worst roll step         0.244 rad
GPU buffer vs sim       all 7 per-instance fields match
```

Checked at 414×896, 1024×768, 1440×900 and 1920×1080; with
`prefers-reduced-motion`; and with a script the system has no font for, which
falls back to English rather than spelling rectangles.
