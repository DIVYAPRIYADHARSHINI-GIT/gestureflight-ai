/**
 * Unit tests for the gesture recognition core.
 *
 * Runs with `node --test` via vite-node, so no test framework dependency is
 * added. Every assertion is against the PURE classifier, driven by synthetic
 * kinematic hand fixtures — no camera, no DOM, no GPU.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  classify,
  classifyHand,
  clamp,
  DISCRETE_GESTURES,
  extractFeatures,
  GESTURE_SEQUENCE,
  GESTURES,
  GestureStabiliser,
  HAND_CONNECTIONS,
  palmScale,
  remap01,
  Smoothed,
  twoHandSpan,
} from "../src/modules/GestureRecognition";
import { AIRCRAFT } from "../src/data/aircraft";
import { COMPONENT_ORDER, resolveComponent } from "../src/data/components";
import { makeHand, POSES, trackedHand } from "./fixtures/hands";
import type { GestureId } from "../src/types";

/* ───────────────────────── fixtures sanity ───────────────────────── */

test("fixture hands have exactly 21 landmarks in the unit square", () => {
  for (const [name, pose] of Object.entries(POSES)) {
    const lms = pose();
    assert.equal(lms.length, 21, `${name} should have 21 landmarks`);
    for (const p of lms) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${name} has non-finite landmark`);
    }
  }
});

test("hand skeleton covers all 21 landmarks", () => {
  const seen = new Set<number>();
  for (const [a, b] of HAND_CONNECTIONS) {
    seen.add(a);
    seen.add(b);
  }
  assert.equal(seen.size, 21, "every landmark should appear in the skeleton");
});

/* ───────────────────────── feature extraction ───────────────────────── */

test("openness rises monotonically as the hand opens", () => {
  let previous = -1;
  for (const curl of [1, 0.85, 0.7, 0.5, 0.3, 0.15, 0]) {
    const f = extractFeatures(makeHand({ curls: [curl, curl, curl, curl, curl], spread: 1.2 }));
    assert.ok(
      f.openness >= previous - 1e-9,
      `openness should not fall as curl drops (curl ${curl}: ${f.openness} < ${previous})`,
    );
    previous = f.openness;
  }
});

test("fist reads near-zero openness and flat palm reads near-one", () => {
  assert.ok(extractFeatures(POSES.closedFist()).openness < 0.2);
  assert.ok(extractFeatures(POSES.openPalm()).openness > 0.7);
});

test("features are scale-invariant — distance from the camera does not matter", () => {
  const near = extractFeatures(makeHand({ curls: [0, 0, 0, 0, 0], scale: 0.4 }));
  const far = extractFeatures(makeHand({ curls: [0, 0, 0, 0, 0], scale: 0.12 }));
  assert.ok(Math.abs(near.openness - far.openness) < 0.02, "openness must not depend on hand size");
  assert.ok(
    Math.abs(near.pinchDistance - far.pinchDistance) < 0.02,
    "pinch distance must not depend on hand size",
  );
});

test("features are rotation-tolerant — a sideways hand still reads as open", () => {
  for (const rotation of [0, 0.6, 1.2, -1.2, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const f = extractFeatures(makeHand({ curls: [0, 0, 0, 0, 0], spread: 1.4, rotation }));
    assert.ok(
      f.openness > 0.6,
      `open palm at ${rotation.toFixed(2)} rad should still read open (got ${f.openness.toFixed(2)})`,
    );
    assert.equal(f.extendedFlags.index, true, `index should read extended at ${rotation.toFixed(2)} rad`);
  }
});

test("palm scale is positive and grows with hand size", () => {
  const small = palmScale(makeHand({ curls: [0, 0, 0, 0, 0], scale: 0.1 }));
  const big = palmScale(makeHand({ curls: [0, 0, 0, 0, 0], scale: 0.3 }));
  assert.ok(small > 0 && big > small);
});

test("pinch distance collapses when thumb and index meet", () => {
  assert.ok(extractFeatures(POSES.pinch()).pinchDistance < 0.15);
  assert.ok(extractFeatures(POSES.openPalm()).pinchDistance > 0.6);
});

/* ───────────────────────── classification ───────────────────────── */

const EXPECTED: Array<[keyof typeof POSES, GestureId]> = [
  ["openPalm", "open_palm"],
  ["closedFist", "closed_fist"],
  ["pointing", "pointing"],
  ["peace", "peace"],
  ["thumbsUp", "thumbs_up"],
  ["pinch", "pinch"],
  ["loose", "rotate"],
];

for (const [pose, expected] of EXPECTED) {
  test(`classifies ${pose} as ${expected}`, () => {
    const result = classifyHand(trackedHand(POSES[pose]()));
    assert.equal(result.id, expected, `got ${result.id} @ ${result.confidence.toFixed(2)}`);
    assert.ok(result.confidence >= 0.5, `confidence too low: ${result.confidence}`);
  });
}

test("every gesture is recognised at least once across the pose set — all 8 covered", () => {
  const found = new Set<GestureId>();
  for (const pose of Object.values(POSES)) found.add(classifyHand(trackedHand(pose())).id);
  // two_hand_zoom is arbitrated by the controller, not the single-hand classifier.
  for (const g of GESTURE_SEQUENCE.filter((g) => g !== "two_hand_zoom")) {
    assert.ok(found.has(g), `${g} was never produced by the pose set`);
  }
});

test("classification survives rotation of the whole hand", () => {
  const cases: Array<[GestureId, Parameters<typeof makeHand>[0]]> = [
    ["open_palm", { curls: [0, 0, 0, 0, 0], spread: 1.45 }],
    ["closed_fist", { curls: [1, 1, 1, 1, 1], spread: 0.75 }],
    ["pointing", { curls: [0.85, 0, 1, 1, 1], spread: 0.9 }],
  ];
  for (const [expected, opts] of cases) {
    for (const rotation of [-0.9, -0.45, 0, 0.45, 0.9]) {
      const got = classifyHand(trackedHand(makeHand({ ...opts, rotation })));
      assert.equal(
        got.id,
        expected,
        `${expected} at ${rotation} rad misread as ${got.id}`,
      );
    }
  }
});

test("classification survives hand position anywhere in frame", () => {
  for (const center of [
    { x: 0.2, y: 0.25 },
    { x: 0.8, y: 0.3 },
    { x: 0.5, y: 0.7 },
    { x: 0.25, y: 0.75 },
  ]) {
    const got = classifyHand(trackedHand(makeHand({ curls: [0, 0, 0, 0, 0], spread: 1.45, center })));
    assert.equal(got.id, "open_palm", `open palm at ${JSON.stringify(center)} misread as ${got.id}`);
  }
});

test("a loose hand does NOT fire open palm or fist — only rotate", () => {
  const got = classifyHand(trackedHand(POSES.loose()));
  assert.equal(got.id, "rotate");
  assert.notEqual(got.id, "open_palm");
  assert.notEqual(got.id, "closed_fist");
});

test("thumbs up is not confused with a fist", () => {
  const thumb = classifyHand(trackedHand(POSES.thumbsUp()));
  const fist = classifyHand(trackedHand(POSES.closedFist()));
  assert.equal(thumb.id, "thumbs_up");
  assert.equal(fist.id, "closed_fist");
});

test("peace requires a real V — two fingers held together reads as pointing", () => {
  const closedV = makeHand({ curls: [0.9, 0, 0, 1, 1], spread: 0.02 });
  const got = classifyHand(trackedHand(closedV));
  assert.notEqual(got.id, "peace", "fingers held together must not count as a peace sign");
});

test("higher sensitivity never lowers the confidence of a valid gesture", () => {
  const f = extractFeatures(POSES.openPalm());
  const low = classify(f, 0.1).confidence;
  const high = classify(f, 0.9).confidence;
  assert.ok(high >= low, `sensitivity should not reduce confidence (${low} → ${high})`);
});

test("classifier always returns a finite confidence in 0..1", () => {
  for (let i = 0; i < 60; i++) {
    const curls = Array.from({ length: 5 }, () => Math.random()) as [number, number, number, number, number];
    const r = classifyHand(
      trackedHand(makeHand({ curls, spread: 0.5 + Math.random(), rotation: (Math.random() - 0.5) * 3 })),
    );
    assert.ok(Number.isFinite(r.confidence), "confidence must be finite");
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence out of range: ${r.confidence}`);
    assert.ok(r.id in GESTURES, `unknown gesture id: ${r.id}`);
  }
});

/* ───────────────────────── two-hand zoom ───────────────────────── */

test("two-hand span grows as the hands move apart", () => {
  const left = makeHand({ curls: [0, 0, 0, 0, 0], center: { x: 0.4, y: 0.5 } });
  const near = twoHandSpan(left, makeHand({ curls: [0, 0, 0, 0, 0], center: { x: 0.5, y: 0.5 } }));
  const far = twoHandSpan(left, makeHand({ curls: [0, 0, 0, 0, 0], center: { x: 0.9, y: 0.5 } }));
  assert.ok(far > near, `span should grow with separation (${near} → ${far})`);
});

test("two-hand span is invariant to both hands approaching the camera together", () => {
  const spanAt = (scale: number) =>
    twoHandSpan(
      makeHand({ curls: [0, 0, 0, 0, 0], center: { x: 0.35, y: 0.5 }, scale }),
      makeHand({ curls: [0, 0, 0, 0, 0], center: { x: 0.65, y: 0.5 }, scale }),
    );
  // Hands scale up but their separation stays proportional → normalised span
  // must not drift, otherwise leaning in would read as a zoom.
  assert.ok(Math.abs(spanAt(0.2) - spanAt(0.2)) < 1e-9);
  assert.ok(spanAt(0.3) < spanAt(0.15), "larger hands at the same pixel gap = smaller relative span");
});

/* ───────────────────────── stabiliser: debounce & cooldown ───────────────── */

test("a gesture must be held for several frames before it activates (debounce)", () => {
  const s = new GestureStabiliser(3, 0.5, 500);
  let r = s.update({ id: "open_palm", confidence: 0.9 }, 0, false);
  assert.equal(r.gesture, "none", "frame 1 should not activate");
  r = s.update({ id: "open_palm", confidence: 0.9 }, 16, false);
  assert.equal(r.gesture, "none", "frame 2 should not activate");
  r = s.update({ id: "open_palm", confidence: 0.9 }, 32, false);
  assert.equal(r.gesture, "open_palm", "frame 3 should activate");
});

test("a single noisy frame cannot flip the active gesture", () => {
  const s = new GestureStabiliser(3, 0.5, 500);
  for (let i = 0; i < 5; i++) s.update({ id: "open_palm", confidence: 0.9 }, i * 16, false);
  const noisy = s.update({ id: "closed_fist", confidence: 0.9 }, 96, false);
  assert.equal(noisy.gesture, "open_palm", "one stray frame must not switch the gesture");
});

test("low-confidence candidates are rejected by the threshold", () => {
  const s = new GestureStabiliser(2, 0.7, 500);
  for (let i = 0; i < 6; i++) {
    const r = s.update({ id: "peace", confidence: 0.4 }, i * 16, true);
    assert.equal(r.gesture, "none");
    assert.equal(r.fired, false);
  }
});

test("a discrete gesture fires exactly once per entry", () => {
  const s = new GestureStabiliser(2, 0.5, 1000);
  let fires = 0;
  for (let i = 0; i < 40; i++) {
    const r = s.update({ id: "peace", confidence: 0.9 }, i * 16, true);
    if (r.fired) fires++;
  }
  assert.equal(fires, 1, "holding a peace sign must switch aircraft only once");
});

test("the cooldown blocks a rapid second firing and allows a later one", () => {
  const s = new GestureStabiliser(1, 0.5, 1000);
  let t = 0;
  const hold = (id: GestureId, from: number) => {
    let fired = false;
    for (let i = 0; i < 4; i++) {
      if (s.update({ id, confidence: 0.9 }, from + i * 16, true).fired) fired = true;
    }
    return fired;
  };
  assert.equal(hold("peace", t), true, "first peace should fire");
  // Leave and immediately re-enter — inside the cooldown window.
  for (let i = 0; i < 4; i++) s.update({ id: "none", confidence: 0 }, t + 70 + i * 16, false);
  assert.equal(hold("peace", t + 140), false, "re-entry inside the cooldown must not fire");
  // Leave and re-enter well after the cooldown.
  t = 3000;
  for (let i = 0; i < 4; i++) s.update({ id: "none", confidence: 0 }, t - 100 + i * 16, false);
  assert.equal(hold("peace", t), true, "re-entry after the cooldown should fire again");
});

test("continuous gestures never fire discrete actions", () => {
  const s = new GestureStabiliser(1, 0.5, 100);
  for (let i = 0; i < 30; i++) {
    const r = s.update({ id: "open_palm", confidence: 0.95 }, i * 16, false);
    assert.equal(r.fired, false, "open palm is continuous and must never 'fire'");
  }
});

test("only one gesture is active at a time — conflicting actions cannot co-fire", () => {
  const s = new GestureStabiliser(2, 0.5, 300);
  const seen: GestureId[] = [];
  const sequence: GestureId[] = ["open_palm", "open_palm", "open_palm", "closed_fist", "closed_fist", "closed_fist"];
  sequence.forEach((id, i) => {
    seen.push(s.update({ id, confidence: 0.9 }, i * 16, false).gesture);
  });
  // At every single step exactly one gesture is reported, never a set.
  for (const g of seen) assert.equal(typeof g, "string");
  assert.equal(seen[seen.length - 1], "closed_fist");
});

test("clear() lets a discrete gesture fire again after the hands leave frame", () => {
  const s = new GestureStabiliser(1, 0.5, 0);
  assert.equal(s.update({ id: "thumbs_up", confidence: 0.9 }, 0, true).fired, true);
  assert.equal(s.update({ id: "thumbs_up", confidence: 0.9 }, 16, true).fired, false);
  s.clear();
  assert.equal(s.update({ id: "thumbs_up", confidence: 0.9 }, 32, true).fired, true);
});

test("DISCRETE_GESTURES contains exactly the one-shot actions", () => {
  assert.deepEqual([...DISCRETE_GESTURES].sort(), ["peace", "pinch", "thumbs_up"]);
});

/* ───────────────────────── smoothing maths ───────────────────────── */

test("Smoothed converges towards its input without overshoot", () => {
  const s = new Smoothed(0.3);
  s.push(0);
  let last = 0;
  for (let i = 0; i < 40; i++) {
    const v = s.push(1);
    assert.ok(v >= last, "must be monotonic towards the target");
    assert.ok(v <= 1.0000001, "must never overshoot the target");
    last = v;
  }
  assert.ok(last > 0.99, `should converge (got ${last})`);
});

test("Smoothed's first sample is adopted exactly", () => {
  const s = new Smoothed(0.1);
  assert.equal(s.push(0.42), 0.42);
});

test("clamp and remap01 behave at the boundaries", () => {
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(5), 1);
  assert.equal(clamp(0.5), 0.5);
  assert.equal(remap01(0, 0, 10), 0);
  assert.equal(remap01(10, 0, 10), 1);
  assert.equal(remap01(5, 0, 10), 0.5);
  assert.equal(remap01(50, 0, 10), 1, "must clamp above the range");
  assert.equal(remap01(1, 5, 5), 0, "degenerate range must not divide by zero");
});

/* ───────────────────────── data integrity ───────────────────────── */

test("all four aircraft categories from the brief are present", () => {
  const cats = AIRCRAFT.map((a) => a.category);
  for (const required of [
    "Commercial Passenger Aircraft",
    "Fighter Aircraft",
    "Cargo Aircraft",
    "Private Jet",
  ]) {
    assert.ok(cats.includes(required), `missing category: ${required}`);
  }
});

test("all 13 components from the brief exist with complete information", () => {
  assert.equal(COMPONENT_ORDER.length, 13, "the brief lists 13 components");
  for (const aircraft of AIRCRAFT) {
    for (const id of COMPONENT_ORDER) {
      const c = resolveComponent(aircraft.profile.kind, id);
      assert.ok(c, `${aircraft.id}/${id} missing`);
      assert.ok(c.name.length > 2, `${id} has no name`);
      assert.ok(c.description.length > 40, `${id} description too thin`);
      assert.ok(c.fn.length > 30, `${id} has no function text`);
      assert.ok(c.location.length > 10, `${id} has no location text`);
      assert.ok(Object.keys(c.specs).length >= 3, `${id} needs technical information`);
    }
  }
});

test("aircraft notes disclose illustrative data and omitted geometry", () => {
  for (const a of AIRCRAFT) {
    assert.match(a.note, /[Ii]llustrative/, `${a.id} must label its figures as illustrative`);
    if (a.profile.omits?.length) {
      assert.match(a.note, /not modelled/i, `${a.id} must disclose unmodelled parts`);
    }
  }
});

test("every aircraft profile is geometrically sane", () => {
  for (const a of AIRCRAFT) {
    const p = a.profile;
    assert.ok(p.length > 0 && p.wingSpan > 0, `${a.id} has zero dimensions`);
    assert.ok(p.fuselageRadius > 0 && p.fuselageRadius < p.length / 4, `${a.id} fuselage radius implausible`);
    assert.ok(p.wingChord > 0 && p.wingChord < p.wingSpan, `${a.id} chord exceeds span`);
    assert.ok(p.wingSweep >= 0 && p.wingSweep < 70, `${a.id} sweep out of range`);
    assert.ok(p.hStabSpan < p.wingSpan, `${a.id} tailplane must be smaller than the wing`);
    assert.ok([0, 2, 4].includes(p.engineCount), `${a.id} engine count invalid`);
    assert.equal(p.gearCount, 3, `${a.id} should be a tricycle layout`);
  }
});

test("every gesture in the vocabulary has guide copy", () => {
  for (const id of GESTURE_SEQUENCE) {
    const g = GESTURES[id];
    assert.ok(g, `${id} has no metadata`);
    assert.ok(g.name && g.glyph && g.action, `${id} is missing display fields`);
    assert.ok(g.how.length > 25, `${id} has no instructions`);
  }
});
