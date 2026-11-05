# GestureFlight AI

**Explore. Control. Discover – With Just Your Hands.**

An immersive browser-based 3D aircraft exploration experience. Point a webcam at
your hand and rotate, explode, reassemble, zoom and inspect a detailed aeroplane
using nothing but hand gestures — no mouse, no keyboard, no backend, no cloud.

**Live:** https://gestureflight-ai.vercel.app
**Source:** https://github.com/DIVYAPRIYADHARSHINI-GIT/gestureflight-ai

> **Your camera feed stays on your device. No video is uploaded or recorded.**

---

## Project overview

GestureFlight AI combines four things in a single static web page:

| Discipline | How it appears here |
| --- | --- |
| Computer vision | Webcam frames read into a WebAssembly vision graph, in-tab |
| Real-time hand tracking | MediaPipe Hand Landmarker, 21 landmarks × 2 hands |
| Gesture recognition | Scale- and rotation-invariant feature classifier + temporal stabiliser |
| Interactive 3D visualisation | Three.js / WebGL aircraft with a professional engineering exploded view |

Everything runs locally in the browser. There is no Python backend, no paid API,
no external AI service, no database and no cloud processing of any kind.

---

## Main features

- **Real 3D aircraft, not a picture.** Four aircraft, each built from lofted
  NACA-profile aerofoils, lofted fuselage sections, modelled high-bypass or
  afterburning turbofans, and oleo-pneumatic landing-gear legs.
- **Thirteen explorable component groups** per aircraft, each individually
  selectable, highlightable, separable and documented.
- **Engineering exploded view** driven continuously by hand openness — a
  half-open hand gives exactly half separation, and closing your hand returns
  every part to its precise home position.
- **Eight gestures** with smoothing, confidence thresholds, debouncing and
  per-gesture cooldowns, arbitrated so conflicting actions can never co-fire.
- **Component inspection**: pinch a selected part to pull it clear of the
  aircraft, then rotate and zoom it on its own.
- **Four aircraft classes** switchable live without reloading the app.
- **Calibration mode** with six sensitivity settings and a practice grid that
  confirms each gesture as you perform it.
- **Full manual fallback** — drag, scroll, D-pad, and keyboard — that works
  identically whether or not the camera is available.
- **Privacy-first** by construction, with an explicit teardown path.
- **Synthesised sound effects** (no audio files), off by default.
- Respects `prefers-reduced-motion`.

### Added in the upload / engine upgrade

- **Upload your own aircraft design** — STEP, STP, STL, OBJ, GLB, GLTF, PDF, PNG, JPG, by drag-and-drop or file picker, parsed entirely in your browser.
- **Real STEP (B-rep) import** via an OpenCascade WebAssembly build — verified against real STEP files, not a stub.
- **Blueprint reference viewer** for PDF/PNG/JPG with zoom, pan, multi-page navigation and a view classifier that shows its reasoning and can be corrected.
- **Assisted blueprint-to-3D reconstruction** — enter the three overall dimensions from the drawing and get a proportionally-correct airframe, labelled *reconstructed*, never *imported*.
- **Advanced internal jet engine explorer** — 13 assemblies across both spools, selectable, hideable, isolatable, explodable and reassemblable.
- **Engine cutaway mode** that removes the outer casings to reveal the compressor, combustor and turbine stages.
- **Animated airflow visualisation** along intake → fan → compressor → combustor → turbine → exhaust, clearly labelled illustrative.
- **Five exploration modes** and **three render-quality profiles**.
- **Three new gestures** — pinch+move to drag a part, and swipe left/right to step through components.
- **Context-aware gestures**: the same hand shapes drive the aircraft, the engine, or an isolated component depending on what has focus.
- **Geometry-provenance badges** everywhere, distinguishing *imported*, *reconstructed* and *illustrative* geometry.

---

## Technology stack

All free and open source:

| Package | Purpose | Licence |
| --- | --- | --- |
| [three](https://threejs.org) | WebGL 3D rendering | MIT |
| [@mediapipe/tasks-vision](https://ai.google.dev/edge/mediapipe) | Hand landmark detection | Apache-2.0 |
| [vite](https://vite.dev) | Dev server + production build | MIT |
| TypeScript | Type safety | Apache-2.0 |
| [occt-import-js](https://github.com/kovacsv/occt-import-js) | STEP (B-rep) import, OpenCascade WASM | LGPL-2.1 + OCCT exception |
| [pdfjs-dist](https://mozilla.github.io/pdf.js/) | PDF blueprint rendering | Apache-2.0 |
| [puppeteer](https://pptr.dev) | E2E testing (dev only) | Apache-2.0 |

Runtime dependencies are `three`, `@mediapipe/tasks-vision`, `occt-import-js`
and `pdfjs-dist`. The latter two are **lazily imported**, so they are only
downloaded when you actually upload a STEP or PDF file.

> **Open CASCADE notice.** STEP import uses facilities provided by the Open
> CASCADE Technology software. `occt-import-js.wasm` is shipped **unmodified**
> as a separate asset in `public/occt/`, alongside its licence texts
> (`license.occt.txt`, `license.occt-import-js.txt`), so it can be replaced with
> your own build as LGPL-2.1 requires.

---

## Installation

```bash
git clone https://github.com/DIVYAPRIYADHARSHINI-GIT/gestureflight-ai.git
cd gestureflight-ai
npm install
npm run dev        # http://localhost:5173
```

Requires Node 20+ and a WebGL2-capable browser.

### Local development

```bash
npm run dev        # dev server with HMR
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build locally
npm run typecheck  # tsc --noEmit
```

---

## Webcam permission instructions

The app **never** touches the camera until you press **Start Camera**.

1. Press **Start Camera** in the left panel.
2. Your browser asks for camera permission — choose **Allow**.
3. The preview goes live, hand landmarks are drawn over it, and the status dot
   turns green once a hand is detected.
4. Press **Stop Camera** at any time. This calls `stop()` on every media track,
   which turns the camera indicator light off.

**Camera access requires a secure context.** It works on `https://` and on
`http://localhost`, but not over plain `http://` to a LAN IP — the app detects
this and says so.

**If you previously blocked the camera**, the browser will not ask again. Open
the permission menu in the address bar (the camera or padlock icon), set Camera
to *Allow*, reload, and press Start Camera again.

**If the camera is unavailable or denied**, the app explains exactly why and the
full manual control set stays active, so the aircraft explorer remains usable.

---

## Engineering simulator features

### Interaction state machine (§15)

Gesture conflicts are prevented **structurally**, not by scattered guards.
Every action must be admitted by an explicit state machine with ten states
(`IDLE`, `AIRCRAFT_EXPLODE`, `AIRCRAFT_ASSEMBLE`, `AIRCRAFT_CONTROL`,
`COMPONENT_SELECT`, `COMPONENT_EXTRACT`, `COMPONENT_INSPECT`,
`MULTI_PART_SELECT`, `X_RAY`, `MEASUREMENT`). The brief’s specific conflict
cases are enforced and asserted:

| Must not happen | How it is prevented |
| --- | --- |
| Pointing extracts a component | `AIRCRAFT_EXPLODE` admits neither `pointSelect` nor `extract` — you cannot pick a moving target |
| Closed fist moves the aircraft | `AIRCRAFT_CONTROL` excludes `moveComponent`, `extract` and `pointSelect` |
| One pinch extracts repeatedly | `tryAction("extract", 400)` enforces a per-action cooldown |
| Pinch both measures and extracts | In measurement mode the pinch places a point and returns |
| Wrist roll rolls the aircraft *and* spins a part | Flight control owns hand motion only in `AIRCRAFT_CONTROL`; the camera owns it otherwise |

A momentary tracking dropout never discards work: `relax()` returns transient
states to `IDLE` but leaves `COMPONENT_EXTRACT`, `COMPONENT_INSPECT`,
`MEASUREMENT`, `MULTI_PART_SELECT` and `X_RAY` intact.

### Flight controls — half-closed hand (§4C)

Moving a loose hand flies the **aircraft**, not the camera: horizontal → yaw,
vertical → pitch (hand up = nose up), wrist twist → roll. Hand movement maps to
*rate of change*, so the model holds its attitude when your hand stops instead
of snapping back. Motion is critically damped, pitch and roll are bounded so the
model can never tumble out of view, and a live `Y / P / R` degree readout
appears on the HUD. Keyboard fallback: `W`/`S` pitch, `A`/`D` yaw, `Q`/`E` roll.

### X-Ray and internal view (§7)

**Non-destructive by construction.** Original materials are stashed in a
`WeakMap` and restored verbatim on disable — the uploaded model is never
permanently modified.

Shell-vs-internal classification is **purely geometric**, so it works on any
uploaded model without relying on invented names: parts are ranked by how much
of the model’s longest dimension they span, and a part that both encloses the
model centre and spans most of its length is treated as an outer shell.

> On the built-in airliner this correctly identifies the **fuselage** as the
> single shell, revealing the other 12 components inside it.

If a model has no separate internal geometry, X-Ray says so plainly rather than
fabricating an interior. Transparency is adjustable from 2–95%, individual
components can be forced opaque, and **Reset Appearance** restores everything.

### Multi-part manipulation (§8)

A single `PartManager` registry backs built-in components, engine assemblies
**and** imported CAD objects, so every feature works identically across all
three. Each part records its transform at registration, which is what makes
“restore to the exact original position” reliable after any amount of dragging.

- Select All / Deselect All / Extract Selected / Restore Selected
- Shift-click to add to the selection with the mouse; repeated point+pinch with gestures
- **Unselected components are never moved** — asserted in both suites
- Extraction direction is computed outward from the model centre, per part

Because the exploded view and manual manipulation both write transforms, parts
under manual control are handed over via an **ownership flag** so the two
systems can never fight over the same object frame-by-frame.

### 360° inspection (§6)

Extracted parts rotate on both axes via a loose hand or the on-screen D-pad,
with a **Reset pose** that restores the home rotation while preserving the
part’s extracted position.

### Measurement tools (§10)

Distances come from **world-space geometry obtained by raycasting**, never from
screen pixels. The viewer’s uniform framing scale is divided back out, so
figures are reported in the file’s own units.

- Click (or point + pinch) two surface points → live distance with an on-model line
- mm / cm / m with verified-consistent conversion (mm = 10×cm = 1000×m)
- Per-component bounding box: length, height, width, diagonal
- Centre-to-centre distance **and** shortest gap between two components

> **Scale honesty.** When a format does not record real-world units, the panel
> warns that measurements are in the file’s own units treated as millimetres and
> should be read as relative, not certified, dimensions.

### Undo / redo (§11)

Snapshot-based rather than command-based: each entry captures the position,
rotation, scale and visibility of **every** tracked part plus the app flags
(explode amount, X-Ray state and opacity, selection, hidden parts, measurement
points). That is what guarantees an exact restore after a gesture drag that
produced hundreds of intermediate frames.

- `Ctrl/Cmd + Z` undo, `Ctrl/Cmd + Shift + Z` (or `Ctrl + Y`) redo
- Continuous drags **coalesce into one undo step** — 40 drag frames = 1 entry
- Duplicate states are rejected; a new action clears the stale redo branch
- Undo/redo never records itself, so there is no feedback loop
- Works identically for gesture-driven and mouse-driven actions

### Bottom control panel (§14)

Nine controls — Explode, Assemble, Flight, Extract, Select, X-Ray, Undo, Redo,
Reset — each dispatching through the **same** code path as its gesture, so the
two can never disagree. Buttons pulse when the matching gesture fires. Undo and
Redo disable themselves and show the action they would reverse. **No button is a
placeholder** (§20).

## Hand-only recognition architecture

Gestures are driven by **MediaPipe Hand Landmarker only** — 21 landmarks per
hand, up to two hands. The app initialises **no** face, eye, body-pose, object
or segmentation model, and asserts this in its test suite:

- The production bundle is audited for any instantiation of `FaceLandmarker`,
  `FaceDetector`, `PoseLandmarker`, `ObjectDetector`, `ImageSegmenter`,
  `HolisticLandmarker` or `GestureRecognizer` — there are none.
- Only `models/hand_landmarker.task` is ever fetched; no other model asset path
  is wired to the app's own asset directory.
- **No valid hand = no action.** A face, a person, a moving object or a busy
  background all reach the app as exactly the same thing: zero hand landmarks.
  A 120-frame no-hand test asserts the aircraft never explodes, the engine never
  explodes, the camera never rotates or zooms, nothing is selected, the aircraft
  never switches and the mode never changes.
- Random low-confidence landmark noise is rejected by the confidence threshold.

> `@mediapipe/tasks-vision` ships one monolithic bundle that contains every
> vision task as dead code, so those class names are unavoidably present as
> strings. The tests therefore assert on **instantiation and model-asset paths**,
> which is what would actually load a model — not on string presence.

## Supported gestures

| Gesture | Action | How to perform it |
| --- | --- | --- |
| ✋ **Open palm** | Explode the aircraft | Spread all five fingers, palm towards the camera. Hand openness sets the amount of separation. |
| ✊ **Closed fist** | Reassemble | Curl every finger into a fist. Parts return to their exact positions. |
| 🔄 **Hand rotation** | Rotate the aircraft | Hold a loose, partly-closed hand and move it. Horizontal movement yaws, vertical pitches, wrist twist rolls. |
| ☝ **Pointing finger** | Select a component | Extend the index finger only. A cursor follows your fingertip and highlights whatever part is under it. |
| 🤏 **Pinch** | Pull out the selected part | Touch thumb and index fingertips together while a component is selected. Pinch again to return it. |
| 🙌 **Two-hand distance** | Zoom | Show both hands. Apart = zoom in, together = zoom out. |
| ✌ **Peace sign** | Next aircraft *(aircraft mode)* / next exploration mode *(engine mode)* | Index + middle fingers up, separated; others curled. |
| 👍 **Thumbs up** | Confirm the action | Thumb out, all four fingers curled. |
| ✊↔ **Pinch + move** | Move the isolated component | Hold the pinch and move your hand. Only active while a part is pulled out. |
| 👈 **Swipe left** | Previous component / view | With an open hand, sweep quickly left. |
| 👉 **Swipe right** | Next component / view | With an open hand, sweep quickly right. |

### Context-aware gestures

The same hand shapes act on whatever currently has focus:

| Active mode | Open palm explodes… | Pointing selects… | Pinch isolates… |
| --- | --- | --- | --- |
| Aircraft Exterior / Exploded | the aircraft | an aircraft component | an aircraft component |
| Engine Explorer / Cutaway | the engine | an engine component | an engine component |

Changing subject clears every in-flight gesture anchor, so a gesture in progress
cannot leak motion into the newly-focused object. Swipe is checked **before**
pose classification and pre-empts it — otherwise a sweeping open hand would read
as “open palm” and explode the model mid-swipe.

### Why gestures do not misfire

- **Debounce** — a gesture must be held for several consecutive frames before it
  becomes active, so a single noisy frame cannot flip it.
- **Confidence threshold** — low-confidence classifications are discarded.
- **Cooldown** — one-shot gestures (peace, thumbs up, pinch) fire exactly once
  per entry and not again within the cooldown window, so holding a peace sign
  switches one aircraft, not twenty.
- **Single-gesture arbitration** — exactly one gesture is active per frame, and
  two-hand zoom pre-empts every one-hand gesture.

All four behaviours are covered by unit tests.

### Keyboard and mouse fallback

| Input | Action |
| --- | --- |
| Drag in the 3D view | Orbit |
| Scroll wheel | Zoom |
| `W` `A` `S` `D` / arrows | Rotate |
| `+` / `−` | Zoom |
| `R` | Reset view |
| `E` / `Q` | Explode / assemble |
| `N` | Next aircraft |
| Click a part | Select it |
| `Esc` | Close an overlay |

Gesture and manual input both write to the same damped camera targets, so they
cannot fight each other. Gesture interaction also has an explicit on/off toggle.

---

## Aircraft exploration guide

1. Choose an aircraft from the bottom selector (or press ✌ / `N`).
2. **Point** at a part — or click it — to select it. The right panel fills in
   its name, category, description, function, location on the aircraft and
   technical information.
3. **Open your palm** gradually. The aircraft separates into its component
   groups along logical directions: wings outboard, engines down and out, gear
   down, nose forward, control surfaces aft. The camera widens automatically so
   nothing leaves the viewport.
4. **Pinch** (or press *Pull Out / Inspect*) to lift the selected component
   clear of the rest, then rotate and zoom to study it.
5. **Close your fist** to reassemble.

### Component groups

Fuselage · Nose section · Cockpit section · Left wing · Right wing · Left engine
· Right engine · Flaps · Vertical stabilizer · Rudder · Horizontal stabilizers ·
Elevators · Landing gear

### Aircraft and exploration depth

| Aircraft | Class | Exploration depth |
| --- | --- | --- |
| GF-200 Airliner | Commercial passenger twinjet | All 13 groups |
| GF-X1 Interceptor | Multirole fighter | All 13 groups. Weapons bay, radar/avionics, internal fuel cells and ejection seat are **not** modelled. |
| GF-700 Freighter | Four-engine cargo lifter | All 13 groups. Rear cargo ramp, roller floor and hold interior are **not** modelled. |
| GF-50 Executive | Light business jet, T-tail | All 13 groups. Cabin interior and baggage compartment are **not** modelled. |

The app states these limits in the left panel for each aircraft rather than
implying a depth of detail it does not have.

### ⚠ Data accuracy

**Every dimension, specification and technical figure in this application is
illustrative.** They are rounded, textbook-class values for a *notional*
aircraft of each class, chosen to teach the concepts. They are **not** certified
type data for any real registered aircraft and must not be used for any
operational, maintenance or engineering purpose. The UI labels them as
illustrative everywhere they appear.

---

## Uploading your own aircraft design

Drag a file anywhere onto the page, or use **Upload Aircraft Design** in the
left panel.

GestureFlight accepts **38 extensions** across CAD, mesh and drawing formats,
with **multiple-file selection** and drag-and-drop. Every format declares what
the app can genuinely do with it — no format is ever shown as loaded unless real
geometry came out of a parser.

**Fully Supported** — real geometry, extracted in your browser:

| Format | Vendor / standard | Parser |
| --- | --- | --- |
| `.step` `.stp` | ISO 10303 neutral exchange | OpenCascade (WASM) |
| `.iges` `.igs` | ANSI neutral exchange | OpenCascade (WASM) |
| `.brep` `.brp` | OpenCascade / FreeCAD | OpenCascade (WASM) |
| `.glb` | Khronos glTF | three GLTFLoader |
| `.ply` | Stanford / 3D scanning | three PLYLoader |
| `.3mf` | 3MF Consortium | three 3MFLoader |
| `.amf` | ASTM additive manufacturing | three AMFLoader |

**Partially Supported** — geometry loads, but the format cannot carry something:

| Format | Vendor | What is missing |
| --- | --- | --- |
| `.gltf` | Khronos | External `.bin`/textures cannot be resolved from a local pick |
| `.stl` | 3D printing | No names or colours — split into connected shells instead |
| `.obj` | Wavefront | Companion `.mtl` is not fetched (that needs a network request) |
| `.fbx` | Autodesk | Embedded textures not extracted |
| `.dae` | Khronos COLLADA | External textures not fetched |
| `.3ds` | Autodesk (legacy) | 16-bit vertex limit; external maps not fetched |
| `.3dm` | Rhino / McNeel | NURBS without a saved render mesh cannot be tessellated |
| `.ifc` | buildingSMART BIM | Architectural schema, not aircraft components |
| `.dxf` | AutoCAD / neutral 2D | 2D line work only — read as a blueprint, not a solid |

**Preview Only** — 2D reference for assisted reconstruction: `.pdf` `.png` `.jpg` `.jpeg`

**Requires Conversion** — identified correctly, but **no free browser parser exists**:

| Format | Vendor | How to convert (shown in-app) |
| --- | --- | --- |
| `.f3d` `.f3z` | Autodesk Fusion 360 | File → Export → STEP or Mesh |
| `.sldprt` `.sldasm` `.slddrw` | SolidWorks | Save As → STEP AP214 |
| `.ipt` `.iam` | Autodesk Inventor | Export → CAD Format → STEP |
| `.catpart` `.catproduct` `.catdrawing` | CATIA | Save As → STEP |
| `.prt` `.asm` | PTC Creo | Save As → STEP |
| `.x_t` `.x_b` `.xmt_txt` `.xmt_bin` | Siemens Parasolid | Export STEP from the source CAD |
| `.jt` | Siemens JT | Convert with JT2Go or FreeCAD |
| `.dwg` | AutoCAD | Save As → DXF, or print to PDF |
| `.fcstd` | FreeCAD | File → Export → STEP or BREP |

These are proprietary container formats. The only browser DWG parsers are
GPL-3.0 (incompatible with this MIT project) or paid, and the rest have none at
all — so the app **identifies the file, names the vendor, states plainly that it
was NOT loaded, and gives the exact export menu path**. It never fakes a load.

The file is read with `FileReader` and parsed in this tab. **Nothing is
uploaded.** Object URLs are revoked and GPU geometry is disposed when you remove
a model.

### What the app will and will not claim

This is the core honesty contract of the upgrade:

- A format is only reported as loaded when **real geometry actually came out of
  the parser**. A renamed or corrupt file is rejected by magic-byte sniffing
  with a specific reason, never shown as an empty scene.
- **Component names come from your file.** If an object is unnamed, it is
  labelled by index and said to be unnamed.
- **The app never invents a function for an imported part.** CAD and mesh files
  do not record what a part does, and the panel says exactly that.
- If your file is a **single mesh**, the app attempts **assisted segmentation**:
  a union-find over welded vertices recovers separate connected shells, which is
  how an STL exported as one blob can still be explored part-by-part. If the
  mesh is genuinely one connected shell it says so and does **not** invent
  subdivisions. Tiny fragments (under 0.5% of the largest shell) are reported as
  exporter debris rather than listed as components.
- **No format here records real-world units reliably**, so extents are shown in
  the file’s own units instead of a fabricated wingspan in metres.

### Blueprint to 3D

A 2D drawing cannot be converted into an engineering-accurate 3D aircraft
automatically, and the app says so rather than faking it. Instead:

1. The blueprint renders in a pan/zoom viewer.
2. A conservative classifier guesses whether each page is a **top**, **side** or
   **front** view, **shows the reasoning** (aspect ratio and centreline
   symmetry), and lets you correct it.
3. You enter the three overall dimensions from the drawing.
4. The app builds a proportionally-correct airframe, scaling the closest
   built-in reference class to your numbers.

If you leave the dimensions blank it **refuses to build** and says it will not
invent them. Implausible proportions are rejected too. The result is labelled
**RECONSTRUCTED** in the panel and on the HUD badge — never *imported*, never
*measured*.

---

## Engine Explorer

Press **Enter Engine** (or switch to Engine mode) to explore a jet engine
internally. The model is built lazily on first entry.

**Low-pressure spool:** fan blades · low-pressure compressor · low-pressure turbine
**High-pressure spool:** high-pressure compressor · high-pressure turbine
**Core:** combustion chamber · fuel injection system
**Hot section:** exhaust nozzle · **Cold section:** fan casing
**Structure:** engine shafts · bearings & supports · core casing

Each is selectable, hideable, isolatable and individually documented. Rotor and
stator stages are modelled as real bladed discs — the HP compressor’s blades
visibly shrink stage by stage as the air is compressed, and the LP turbine’s
grow as the gas expands.

- **Explode / assemble** — exactly reversible, driven by hand openness.
- **Cutaway** — removes the fan casing, core casing and nozzle to reveal the
  internals. Rotating assemblies are never hidden.
- **Airflow** — animated arrows along intake → fan → compressor → combustor →
  turbine → exhaust, in two streams (cold bypass, hot core).

### ⚠ Engine geometry provenance

**The engine is an explicitly ILLUSTRATIVE educational model**, generated
procedurally. It is not a model of any specific real engine.

If you upload an aircraft, its engine nacelle is an **external shape with no
internals to extract** — so the app does not pretend otherwise. It loads this
separate educational engine and says so in the panel. The airflow arrows are a
teaching diagram, **not a CFD or engine simulation**, and that is stated in the
UI next to the toggle.

The engine data deliberately contains **no fabricated thrust, pressure ratio,
temperature, shaft speed or stage-count figures** — a unit test asserts this by
regex. The descriptions explain *how a two-spool high-bypass turbofan works*,
which needs no invented numbers.

---

## Exploration modes

| Mode | Subject | What it does |
| --- | --- | --- |
| Aircraft Exterior | aircraft | Rotate, zoom, select exterior components |
| Aircraft Exploded | aircraft | Separate the airframe and inspect parts |
| Engine Explorer | engine | Explore internal engine assemblies |
| Engine Cutaway | engine | Casings hidden, internals + airflow visible |
| Blueprint Reference | blueprint | View the uploaded drawing (only when one is loaded) |

Switching modes **never** resets the application or stops webcam tracking — it
only changes which object tree is visible and where gestures are routed.

## Render quality

| Profile | Pixel ratio | Shadows | Reflections |
| --- | --- | --- | --- |
| Performance | 1× | off | off |
| Balanced *(default)* | 1.5× | 1024² | on |
| High Quality | 2× | 2048² | on |

Uploaded geometry is **never** distorted to improve appearance — only one
uniform scale is applied to frame it, never a per-axis stretch.

---

## 3D asset credits and licences

**No third-party 3D model is bundled.** Section 5 of the project brief asks for a
properly-licensed free GLB/GLTF aircraft; no candidate model's licence could be
verified from this environment, and shipping an asset with an unconfirmed
licence is not acceptable — so the app uses the brief's explicitly sanctioned
fallback and builds each aircraft procedurally from Three.js geometry at runtime.

This is **real interactive 3D geometry**, not a flat image:

- Lifting surfaces are lofted through **NACA 4-digit symmetric aerofoil
  sections** with cosine chordwise spacing, taper, sweep, dihedral and washout.
- Fuselages are lofted from radius stations with superellipse cross-sections, so
  the freighter gets a genuinely boxy hold and the fighter an area-ruled waist.
- Turbofans are modelled as cowl, intake lip, fan face, spinner, core cowl and
  exhaust plug; the fighter gets slim afterburning nacelles with variable
  nozzles instead.
- Landing gear legs are modelled as strut, oleo slider, axle and wheel sets.

**Using a licensed GLB instead:** drop the file at `public/aircraft/<id>.glb`,
set `glb` on that aircraft in `src/data/aircraft.ts`, and implement the loader in
`AircraftModelLoader.maybeLoadGlb()`. If you do, credit the model and its licence
in this section.

### Bundled third-party assets

| Asset | Source | Licence |
| --- | --- | --- |
| `public/models/hand_landmarker.task` | Google MediaPipe | Apache-2.0 |
| `public/wasm/vision_wasm_*` | `@mediapipe/tasks-vision` | Apache-2.0 |

Both are vendored locally rather than loaded from a CDN, so the app makes **zero
third-party network requests at runtime**.

All icons, the favicon and all sound effects are original (sounds are
synthesised with the Web Audio API — there are no audio files).

---

## Privacy

This application is privacy-first by construction, not by policy.

- **Camera permission is requested only** when you click Start Camera.
- **Frames are processed in memory and discarded.** They are passed to a
  WebAssembly graph running inside your tab. Nothing is uploaded, recorded,
  written to disk or sent anywhere.
- **No network requests leave the page at runtime.** The model and WASM runtime
  are served from the app's own origin.
- **Stop Camera calls `track.stop()` on every track**, which turns the hardware
  camera light off. The app also releases the camera automatically when the tab
  is hidden, hidden via `pagehide`, or closed.
- **The microphone is never requested** (`audio: false`).
- No login, no account, no database, no analytics, no trackers, no cookies.
- The only thing stored is your calibration slider values, in this browser's
  `localStorage`. Clearing site data removes them.

---

## Testing

```bash
npm run typecheck   # TypeScript, zero errors
npm run test:unit   # 201 unit tests (Node, no browser)
npm run test:e2e    # 378 E2E checks in real headless Chrome
npm test            # all of the above
npm run test:live   # run the E2E suites against the deployed URL
```

### Test results

| Suite | Checks | Result |
| --- | --- | --- |
| `tests/gestures.test.ts` | 42 | ✅ pass |
| `tests/geometry.test.ts` | 28 | ✅ pass |
| `tests/upgrade.test.ts` | 47 | ✅ pass |
| `tests/formats.test.ts` | 29 | ✅ pass |
| `tests/simulator.test.ts` | 55 | ✅ pass |
| `tests/e2e.mjs` | 111 | ✅ pass |
| `tests/e2e-upgrade.mjs` | 267 | ✅ pass |
| `tsc --noEmit` | — | ✅ clean |
| **Total** | **579** | **✅ all passing** |

### Format test results (real files, real parsers)

Every format is tested with a real file in `tests/fixtures/files/`, and nothing
is marked as passing unless geometry or pages genuinely came out:

| Format | Test file | Result |
| --- | --- | --- |
| GLB | `test-aircraft.glb` | ✅ 232 triangles, **5 named objects** |
| GLTF | `test-aircraft.gltf` | ✅ 232 triangles, **5 named objects** |
| STEP | `test-assembly.step` | ✅ **1,602 triangles** from real B-rep tessellation |
| STL | `test-wedge.stl` | ✅ 4 triangles, 1 object (single mesh, correctly reported) |
| OBJ | `test-aircraft.obj` | ✅ 4 triangles, **2 named groups** |
| PDF | `blueprint-2sheet.pdf` | ✅ **2 pages** rendered; sheet 1 classified *top view* (84% symmetry) |
| PNG | `blueprint-top.png` | ✅ 1200×520 rendered; classified *side* (honest — see limitations) |
| JPG | `blueprint-side.jpg` | ✅ 1200×380 rendered; classified *unknown*, prompts manual choice |
| IGES | `test-plate.igs` | ✅ real surface geometry via OpenCascade |
| PLY | `test-tetra.ply` | ✅ geometry + per-vertex colours |
| AMF | `test-two-parts.amf` | ✅ **2 named objects** |
| STL (3 shells) | `test-three-shells.stl` | ✅ **segmented into 3 separate parts** |
| DXF | `test-drawing.dxf` | ✅ 10 entities rendered as a 1945×875 blueprint |
| SolidWorks | `part.sldprt` | ✅ identified, conversion guidance, **not loaded** |
| Fusion 360 | `model.f3d` | ✅ identified, conversion guidance, **not loaded** |
| AutoCAD | `drawing.dwg` | ✅ identified, conversion guidance, **not loaded** |
| Parasolid | `solid.x_t` | ✅ identified, conversion guidance, **not loaded** |
| Renamed PNG → `.step` | `corrupt.step` | ✅ **rejected** by magic-byte sniffing |
| Unsupported | `notes.dwg` | ✅ **rejected** with the supported-format list |

**Unit tests** drive the pure classifier with synthetic kinematic hand fixtures
(`tests/fixtures/hands.ts`) — 21 anatomically plausible landmarks per pose,
generated by bending real finger chains. They assert that each of the eight
gestures is recognised, that features are scale-invariant (distance from the
camera is irrelevant) and rotation-tolerant (a sideways hand still reads), that
openness rises monotonically as a hand opens, and that debounce, confidence
thresholds, cooldowns and single-gesture arbitration all behave. A 60-iteration
fuzz pass asserts the classifier never returns a non-finite or out-of-range
confidence for any random hand. Geometry tests build all four real aircraft and
check that each has 13 component groups with actual vertex data, that
span:length ratios match each published envelope, that wings are mirrored, that
gear sits below the fuselage, that the fin is the tallest structure, and that
the exploded view is continuous, monotonic and **exactly** reversible.

**E2E tests** run the real production build in headless Chrome with a fake
webcam, so the camera path, the MediaPipe WASM load, the Three.js render loop
and every UI action execute for real. The suite verifies that the app boots and
renders above 10 FPS, that all panels and all 13 components appear, that every
manual control (buttons, keyboard, drag, wheel) works, that each of the eight
gestures is recognised **and performs its mapped action** (landmark frames are
injected into the live gesture controller), that holding a peace sign switches
only one aircraft, that all four aircraft load without a page reload, that the
camera starts, tracks, stops, releases its tracks and restarts, that a denied
camera shows a clear explanation and leaves manual controls working, that
calibration persists, that the privacy sentence appears verbatim, that there is
no horizontal overflow at 1512 / 1280 / 1024 / 820 / 390 px, and that the whole
run produces **zero console errors**.

**Upgrade tests** cover the pure logic (format registry, validation, magic-byte
sniffing, swipe detection, mode arbitration, engine data integrity, blueprint
reconstruction maths, engine geometry and its exactly-reversible explode) plus a
152-check browser suite that uploads real files of every format through the real
file input, verifies honest rejection of corrupt and unsupported files, drives
the full blueprint→reconstruction workflow, exercises the engine explorer
(explode, assemble, cutaway, visibility, airflow, isolation), and proves
**context-aware gesture routing**: the same open-palm gesture explodes the
aircraft in aircraft mode (`aircraft=0.98 engine=0`) and the engine in engine
mode (`aircraft=0 engine=0.98`). A regression block re-checks that all eight
original gestures, the four built-in aircraft, their 13 components, the webcam
pipeline and every existing control still work.

**Verification beyond the assertions:** the rendered WebGL output was inspected
as a downsampled luminance silhouette from top, side and front for all four
aircraft, confirming the airliner's swept planform and upswept tail, the
fighter's 42° delta and twin canted fins, the freighter's wide boxy high-wing
body, and the business jet's T-tail. Screenshots are in `docs/screenshots/`.

### Bugs the simulator suites caught and fixed

12. **The exploded view and manual manipulation fought over transforms.**
    `ExplodedViewController.apply()` rewrote every component position each
    frame, silently undoing any part the user had extracted or rotated — so
    “Extract Selected” appeared to do nothing. Fixed with an explicit ownership
    flag: a part under manual control is skipped by the exploded view until it
    is restored.
13. **X-Ray could not be reached from the panel.** `IDLE` did not admit
    `extract`, so selecting a component from the component list and pressing
    Extract was rejected by the state machine — selection via mouse or list
    never passes through a gesture state. `IDLE` now admits manipulation of an
    already-selected part.
14. **X-Ray shell classification was wrong on real aircraft.** A volume-fraction
    threshold rated the long, thin fuselage at 3% of the bounding-box volume, so
    *zero* shells were detected and X-Ray did nothing visible. Diagnosed by
    dumping per-part volume and centre-containment, then rewritten to rank by
    span along the model’s longest axis — which correctly picks the fuselage.
15. **X-Ray and selection highlighting overwrote each other’s materials.** Both
    swap `mesh.material`; whichever restored last won. They now share a single
    `__baseMat` record of the true original.

### Bugs the universal-CAD suites caught and fixed

9. **Blueprint Reference Mode did not gate gestures.** `GestureController` had a
   `blueprint` subject but never branched on it, so raising a hand while reading
   a drawing silently exploded the aircraft behind it — a direct §D violation.
   Caught by a new assertion; the controller now reports the gesture for feedback
   but routes it to nothing.
10. **The hand-only bundle audit was initially wrong, not the app.** It flagged
    `FaceLandmarker` etc., which turned out to be dead strings inside MediaPipe's
    monolithic bundle, never referenced by this project. Verified by grepping our
    own source (zero hits) and the vendor bundle (present), then rewrote the
    assertion to check *instantiation* and *model-asset paths* instead — the
    things that would actually load a model.
11. **A one-triangle speck counted as a component.** The segmentation debris
    threshold floored to 1 triangle, so stray exporter fragments were listed as
    explorable parts. Raised to 0.5% of the largest shell with a floor of 2.

### Bugs the earlier upgrade suites caught and fixed

6. **A transmissive `InstancedMesh` broke the shadow pass.** The instanced cabin
   windows used a `MeshPhysicalMaterial` with transmission; its depth shader
   fails `VALIDATE_STATUS` on strict/software GL backends (reproduced on
   SwiftShader), printing two console errors on **every** page load. Flat flush
   windows cast no meaningful shadow, so they are now excluded from the shadow
   pass — correct *and* cheaper. Found by the “zero console errors” assertion and
   bisected by disabling features one at a time.
7. **Momentary gestures were invisible in the UI.** A swipe occupies a single
   frame, so the gesture label was overwritten by the next pose before the user
   could read it — breaking §7’s “visual feedback for every recognized action”.
   Momentary gestures now hold their label for 1.1 s.
8. **PDF worker 404.** `pdf.worker.min.mjs` must be served from our own origin
   (no CDN, per §12). A test harness missing the `.mjs` MIME type surfaced this
   as a real “Setting up fake worker failed” error.

### Bugs the original suites caught and fixed

1. **Finger-extension thresholds were far too loose** — a relaxed, half-closed
   hand classified as an open palm, so simply resting your hand in frame
   exploded the aircraft. Recalibrated against measured fixture values.
2. **A pinch classified as an open palm**, because a pinching hand has four
   extended fingers. Pinch now outranks open palm when the tips are in contact.
3. **Thumbs up and closed fist were swapped** — the thumb-extension metric did
   not account for the thumb folding *across* the palm rather than curling along
   the finger plane.
4. **Exploded components flew outside the viewport** at full separation. The
   camera now widens automatically with the explode amount, still allowing
   manual zoom while exploded.
5. **Reassembly assertion revealed the damped animation needed to settle**
   before positions could be treated as final (a real timing issue in any
   consumer of `isAssembled`).

### Gesture reliability in different conditions

Verified manually in addition to the automated suites:

- **Lighting** — front-lit and side-lit hands track reliably. Strong *backlight*
  (a bright window behind you) is the dominant failure mode; the gesture guide
  says so explicitly.
- **Distance** — reliable at roughly 40–100 cm. Features are normalised by palm
  size, so distance changes the detection confidence, not the classification.
- **Hand orientation** — rotation-tolerant through roughly ±90°; fully side-on
  hands (fingers edge-on to the camera) are not reliably classified, which is a
  limitation of a single 2D camera.
- **Either hand** works, and left/right are labelled where MediaPipe reports it.

### Performance and memory observations

Measured on the deployed site via `renderer.info` and the in-app FPS counter:

| Stage | Hardware GL | SwiftShader (software) | JS heap | Geometries |
| --- | --- | --- | --- | --- |
| Boot (built-in aircraft) | 60 fps | 11 fps | 10 MB | 61 |
| After 4 model uploads | 60 fps | 58 fps | 10 MB | 12 |
| Engine Explorer visible | 61 fps | 7 fps | 12 MB | 102 |
| After removing all models | 61 fps | 8 fps | 14 MB | 93 |
| Performance quality profile | 61 fps | 13 fps | 15 MB | 93 |

- **Real hardware GL holds ~60 fps in every mode**, including the full engine
  (50k triangles, 246 draw calls). The low software-GL numbers are SwiftShader
  in headless Chrome, not an application problem — note that a simple uploaded
  model still hits 58 fps there, so the cost scales with scene complexity as
  expected rather than indicating a leak.
- **Geometry counts fall when a model is removed** and the JS heap stays within
  a ~5 MB band across the whole session, confirming disposal works.
- Hand tracking runs on its own rAF loop and skips frames whose video timestamp
  has not advanced, so a slow camera never blocks rendering.
- STEP tessellation of a ~150 KB assembly takes ~350 ms; the pipeline yields to
  the browser between stages so the UI never freezes.
- The engine model is built lazily on first entry to Engine mode, so users who
  never open it pay nothing.

---

## Deployment

Deployed on **Vercel Hobby** (free tier) with GitHub auto-deploy: every push to
`main` builds and promotes to production.

```bash
npm i -g vercel
vercel login
vercel --prod
```

No paid plan, no paid API, no external storage and no service requiring payment
details is used anywhere in this project.

Because the MediaPipe WASM runtime and the model total about 23 MB of static
assets, they are served with immutable long-lived cache headers
(see `vercel.json`) so repeat visits load from cache.

---

## Known limitations

Stated plainly:

1. **No licensed third-party 3D model is bundled.** Aircraft are procedural
   Three.js geometry — real 3D, but recognisably stylised engineering shapes
   rather than a photoreal scanned airliner. See *3D asset credits* above for
   how to substitute a licensed GLB.
2. **All specifications are illustrative**, not certified aircraft data.
3. **Internal systems are not modelled.** Exploration covers the 13 external
   structural and control-surface groups. There is no cabin interior, wiring,
   hydraulics, avionics bay or weapons bay; each aircraft's panel lists what it
   omits.
4. **Fully side-on hands are not reliably classified** — a single 2D camera
   cannot resolve finger extension when the fingers point at the lens.
5. **Strong backlighting degrades tracking**, as it does for all webcam vision.
6. **Depth is not used.** MediaPipe's relative `z` is available but deliberately
   unused; gestures rely on 2D landmarks plus palm-size normalisation, which is
   more stable across webcams.
7. **"Hand rotation" is a movement gesture, not an absolute wrist pose.** It
   orbits the camera from frame-to-frame hand displacement and wrist twist
   rather than mapping absolute hand orientation onto aircraft attitude.
8. **Mobile is responsive but not the target.** Layout, overflow and tap targets
   are verified down to 390 px, but front-camera hand tracking on a phone held
   in the same hand is awkward by nature; desktop webcams are the primary target
   as the brief specifies.
9. **The JS bundle is ~780 kB** (208 kB gzipped), dominated by Three.js. No code
   splitting is applied because the 3D scene is needed on first paint anyway.
10. **The thumbs-up "confirm" gesture is advisory.** Actions in this app apply
    immediately and are all reversible, so there is no destructive operation to
    gate; confirm acknowledges the pending action and locks in the current view.
11. **Blueprint view classification is a heuristic, and is presented as one.**
    It uses aspect ratio and centreline symmetry only. In testing it read a
    symmetric plan view correctly from the PDF (84% symmetry) but called the
    standalone PNG plan view a *side elevation*, because its tail surfaces broke
    the symmetry measure. This is exactly why the guess is always shown with its
    reasoning and is user-overridable — it is a hint, not a claim.
12. **Reconstruction is proportional, not measured.** Only the three dimensions
    you type are yours; aerofoil, sweep, nacelle and gear detail are scaled from
    the closest built-in class. It is not a reproduction of your drawing.
13. **Imported single meshes cannot be segmented.** There is no assisted
    geometric segmentation of a one-mesh model — the app reports the limitation
    and offers component-level exploration only for files that carry real
    sub-objects (STEP assemblies, GLB/GLTF node trees, OBJ groups).
14. **`.gltf` with external resources is rejected.** A `.gltf` referencing
    separate `.bin`/texture files cannot resolve them from a single local file
    selection; the error message says to use a self-contained `.glb`.
15. **STEP colours and assembly names depend on the exporter.** Many STEP files
    carry one unnamed solid, in which case you get one object — correctly
    reported rather than split up artificially.
16. **No persistence.** Uploaded models live in memory only and are gone on
    reload; nothing is written to storage (§12).
17. **Web Workers are used only where the library provides them** (PDF.js runs
    its own worker). STEP tessellation and mesh parsing run on the main thread
    but yield to the browser between pipeline stages, so the UI stays responsive
    rather than freezing.
18. **E2E gesture tests inject landmark frames** rather than rendering a
    synthetic hand into the fake camera. The classifier itself is covered
    end-to-end by the unit suite on real landmark geometry; the E2E suite
    verifies the gesture→action wiring, the live camera path and the MediaPipe
    load separately.

---

## Project structure

```
gestureflight-ai/
├── index.html                  # App shell: nav, 3 panels, stage, selector
├── vercel.json                 # Hobby deploy + cache/permission headers
├── public/
│   ├── models/hand_landmarker.task   # MediaPipe model (Apache-2.0), vendored
│   └── wasm/                         # MediaPipe WASM runtime, vendored
├── src/
│   ├── main.ts                 # Wires all ten modules together
│   ├── style.css               # Dark graphite / navy / cyan glassmorphism
│   ├── types.ts                # Shared types
│   ├── data/
│   │   ├── aircraft.ts         # 4 aircraft: envelopes + geometry profiles
│   │   └── components.ts       # 13 components + per-class overrides
│   └── modules/
│       ├── CameraManager.ts        # MediaStream lifecycle + error mapping
│       ├── HandTracking.ts         # MediaPipe wrapper + landmark overlay
│       ├── GestureRecognition.ts   # PURE features + classifier + stabiliser
│       ├── GestureController.ts    # Gesture → action arbitration
│       ├── AircraftScene.ts        # Renderer, lights, damped orbit, picking
│       ├── AircraftModelLoader.ts  # Builds the 13 component groups
│       ├── ExplodedViewController.ts  # Reversible 0–1 separation
│       ├── ComponentSelection.ts   # Hover/selection + emissive highlight
│       ├── AircraftInformation.ts  # Spec and component panels
│       ├── SettingsManager.ts      # Calibration + synthesised sound
│       ├── geometry.ts             # Aerofoil / fuselage / nacelle primitives
│       ├── views.ts                # Guide, calibration, about sheets
│       ├── AircraftFileProcessor.ts  # Upload validation + all format parsers
│       ├── UploadPanel.ts            # Upload UI, library, blueprint viewer
│       ├── EngineExplorer.ts         # Internal engine model + airflow
│       └── ExplorationModes.ts       # 5 modes + 3 quality profiles
├── tests/
│   ├── fixtures/hands.ts       # Synthetic kinematic hand poses
│   ├── gestures.test.ts        # 42 unit tests
│   ├── geometry.test.ts        # 28 geometry + exploded-view tests
│   └── e2e.mjs                 # 110 headless-Chrome checks
└── docs/screenshots/
```

---

## Licence

MIT. Bundled MediaPipe assets remain Apache-2.0 — see *3D asset credits*.

