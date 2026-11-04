/**
 * GestureRecognition — PURE functions over MediaPipe hand landmarks.
 *
 * Deliberately has no DOM, no Three.js and no MediaPipe imports, so the whole
 * classifier is unit-testable from Node with plain landmark arrays.
 *
 * Landmark indices (MediaPipe Hand Landmarker):
 *   0 wrist
 *   1-4   thumb   (cmc, mcp, ip, tip)
 *   5-8   index   (mcp, pip, dip, tip)
 *   9-12  middle
 *   13-16 ring
 *   17-20 pinky
 */

import type {
  GestureCandidate,
  GestureId,
  GestureMeta,
  HandFeatures,
  Landmark,
  TrackedHand,
} from "../types";

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

/** Skeleton used by the landmark overlay renderer. */
export const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const GESTURES: Record<GestureId, GestureMeta> = {
  none: { id: "none", name: "None", glyph: "·", action: "Waiting for hands…", how: "Show a hand to the camera.", hands: 1 },
  open_palm: {
    id: "open_palm",
    name: "Open Palm",
    glyph: "✋",
    action: "Explode the aircraft",
    how: "Spread all five fingers wide, palm towards the camera. How far you open your hand sets how far the parts separate.",
    hands: 1,
  },
  closed_fist: {
    id: "closed_fist",
    name: "Closed Fist",
    glyph: "✊",
    action: "Reassemble the aircraft",
    how: "Curl every finger into a fist. Parts travel back to their exact positions.",
    hands: 1,
  },
  pointing: {
    id: "pointing",
    name: "Pointing Finger",
    glyph: "☝",
    action: "Select a component",
    how: "Extend the index finger only. A cursor follows your fingertip and highlights whatever part is under it.",
    hands: 1,
  },
  pinch: {
    id: "pinch",
    name: "Pinch",
    glyph: "🤏",
    action: "Pull out the selected part",
    how: "Touch your thumb and index fingertips together while a component is selected.",
    hands: 1,
  },
  peace: {
    id: "peace",
    name: "Peace Sign",
    glyph: "✌",
    action: "Next aircraft",
    how: "Index and middle fingers up, the rest curled. Cycles through the four aircraft.",
    hands: 1,
  },
  thumbs_up: {
    id: "thumbs_up",
    name: "Thumbs Up",
    glyph: "👍",
    action: "Confirm the current action",
    how: "Thumb up, all other fingers curled. Confirms and locks in the pending action.",
    hands: 1,
  },
  rotate: {
    id: "rotate",
    name: "Hand Rotation",
    glyph: "🔄",
    action: "Rotate the aircraft",
    how: "Hold a loose, partly-closed hand and move or twist it. Horizontal movement yaws, vertical movement pitches, wrist twist rolls.",
    hands: 1,
  },
  two_hand_zoom: {
    id: "two_hand_zoom",
    name: "Two-Hand Distance",
    glyph: "🙌",
    action: "Zoom in / out",
    how: "Show both hands. Move them apart to zoom in, bring them together to zoom out.",
    hands: 2,
  },
  pinch_drag: {
    id: "pinch_drag",
    name: "Pinch + Move",
    glyph: "✊↔",
    action: "Move the isolated component",
    how: "Hold the pinch and move your hand to drag the isolated component through space. Release to drop it.",
    hands: 1,
  },
  swipe_left: {
    id: "swipe_left",
    name: "Swipe Left",
    glyph: "👈",
    action: "Previous component / view",
    how: "With an open hand, sweep quickly to the left to step back through components or views.",
    hands: 1,
  },
  swipe_right: {
    id: "swipe_right",
    name: "Swipe Right",
    glyph: "👉",
    action: "Next component / view",
    how: "With an open hand, sweep quickly to the right to step forward through components or views.",
    hands: 1,
  },
};

/** Gestures shown in the guide and calibration grid, in teaching order. */
export const GESTURE_SEQUENCE: GestureId[] = [
  "open_palm",
  "closed_fist",
  "rotate",
  "pointing",
  "pinch",
  "two_hand_zoom",
  "peace",
  "thumbs_up",
  "pinch_drag",
  "swipe_left",
  "swipe_right",
];

/**
 * SwipeDetector — recognises a fast lateral hand sweep.
 *
 * A swipe is a MOTION, not a hand shape, so it cannot be classified from a
 * single frame like the other gestures. It tracks palm-centre samples over a
 * short window and fires when the hand crosses a distance threshold faster than
 * a velocity threshold, then locks out until the hand slows down again — which
 * stops one physical sweep producing a burst of events.
 */
export class SwipeDetector {
  private samples: Array<{ x: number; t: number }> = [];
  private armed = true;
  private lastFire = -Infinity;

  constructor(
    /** Minimum horizontal travel in normalised image units. */
    private minTravel = 0.17,
    /** Minimum speed in units/second. */
    private minSpeed = 0.55,
    private cooldownMs = 700,
  ) {}

  configure(opts: { minTravel?: number; minSpeed?: number; cooldownMs?: number }): void {
    if (opts.minTravel !== undefined) this.minTravel = opts.minTravel;
    if (opts.minSpeed !== undefined) this.minSpeed = opts.minSpeed;
    if (opts.cooldownMs !== undefined) this.cooldownMs = opts.cooldownMs;
  }

  /** @returns "swipe_left", "swipe_right", or null. */
  push(x: number, now: number): "swipe_left" | "swipe_right" | null {
    this.samples.push({ x, t: now });
    // Keep a 320 ms window — long enough to measure, short enough to be a flick.
    while (this.samples.length > 1 && now - this.samples[0].t > 320) this.samples.shift();
    if (this.samples.length < 3) return null;

    const first = this.samples[0];
    const travel = x - first.x;
    const seconds = Math.max(1e-3, (now - first.t) / 1000);
    const speed = Math.abs(travel) / seconds;

    if (!this.armed) {
      // Re-arm once the hand has clearly slowed.
      if (speed < this.minSpeed * 0.4) this.armed = true;
      return null;
    }

    if (Math.abs(travel) >= this.minTravel && speed >= this.minSpeed) {
      if (now - this.lastFire < this.cooldownMs) return null;
      this.armed = false;
      this.lastFire = now;
      this.samples = [];
      // Image space is mirrored for the user, so +x on screen is a LEFT swipe.
      return travel > 0 ? "swipe_left" : "swipe_right";
    }
    return null;
  }

  reset(): void {
    this.samples = [];
    this.armed = true;
  }
}

/* ───────────────────────── geometry helpers ───────────────────────── */

export function dist2(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dist3(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

export function clamp(v: number, lo = 0, hi = 1): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Maps v from [inMin,inMax] onto [0,1], clamped. */
export function remap01(v: number, inMin: number, inMax: number): number {
  if (inMax === inMin) return 0;
  return clamp((v - inMin) / (inMax - inMin));
}

/**
 * Palm size: wrist→middle-MCP plus index-MCP→pinky-MCP. Used to normalise every
 * other distance so the classifier is scale-invariant (near/far from camera).
 */
export function palmScale(lms: Landmark[]): number {
  const a = dist2(lms[LM.WRIST], lms[LM.MIDDLE_MCP]);
  const b = dist2(lms[LM.INDEX_MCP], lms[LM.PINKY_MCP]);
  return Math.max(1e-4, (a + b) * 0.5);
}

/**
 * A finger is "extended" when its tip is markedly further from the wrist than
 * its PIP joint. This is rotation-invariant, unlike a naive tip.y < pip.y test,
 * so it still works with the hand sideways or upside-down.
 */
function fingerExtension(lms: Landmark[], mcp: number, pip: number, tip: number): number {
  const w = lms[LM.WRIST];
  const tipD = dist2(w, lms[tip]);
  const pipD = dist2(w, lms[pip]);
  const mcpD = dist2(w, lms[mcp]);
  const span = Math.max(1e-4, pipD - mcpD);
  return (tipD - pipD) / span;
}

/**
 * Thumb extension is measured sideways instead: the thumb tip moves AWAY from
 * the index MCP when extended, and tucks across the palm when curled.
 */
function thumbExtension(lms: Landmark[]): number {
  const s = palmScale(lms);
  const spread = dist2(lms[LM.THUMB_TIP], lms[LM.INDEX_MCP]) / s;
  const knuckle = dist2(lms[LM.THUMB_MCP], lms[LM.INDEX_MCP]) / s;
  return (spread - knuckle) / Math.max(0.25, knuckle);
}

/* ───────────────────────── feature extraction ───────────────────────── */

export function extractFeatures(lms: Landmark[]): HandFeatures {
  const s = palmScale(lms);

  const curls = {
    index: fingerExtension(lms, LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP),
    middle: fingerExtension(lms, LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP),
    ring: fingerExtension(lms, LM.RING_MCP, LM.RING_PIP, LM.RING_TIP),
    pinky: fingerExtension(lms, LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP),
  };
  const thumb = thumbExtension(lms);

  // Thresholds calibrated against the synthetic kinematic hand fixtures:
  // a straight finger reads ≈1.3, a half-curled finger ≈0.98, a fist ≈ −0.3.
  // 1.05 therefore accepts only a genuinely extended finger, which keeps a
  // relaxed/half-closed "rotation" hand out of the open-palm class.
  const extendedFlags = {
    thumb: thumb > 0.2,
    index: curls.index > 1.05,
    middle: curls.middle > 1.05,
    ring: curls.ring > 1.05,
    pinky: curls.pinky > 1.02,
  };
  const extended = Object.values(extendedFlags).filter(Boolean).length;

  // Openness: mean normalised fingertip→wrist distance of the four fingers,
  // remapped so a tight fist reads ~0 and a flat spread palm reads ~1.
  const tipDist =
    (dist2(lms[LM.WRIST], lms[LM.INDEX_TIP]) +
      dist2(lms[LM.WRIST], lms[LM.MIDDLE_TIP]) +
      dist2(lms[LM.WRIST], lms[LM.RING_TIP]) +
      dist2(lms[LM.WRIST], lms[LM.PINKY_TIP])) /
    (4 * s);
  const spread = dist2(lms[LM.INDEX_TIP], lms[LM.PINKY_TIP]) / s;
  const openness = clamp(remap01(tipDist, 1.5, 2.8) * 0.72 + remap01(spread, 0.8, 1.8) * 0.28);

  const pinchDistance = dist3(lms[LM.THUMB_TIP], lms[LM.INDEX_TIP]) / s;

  // Palm roll from the wrist→middle-MCP axis. 0 rad = fingers pointing up.
  const roll = Math.atan2(
    lms[LM.MIDDLE_MCP].x - lms[LM.WRIST].x,
    lms[LM.WRIST].y - lms[LM.MIDDLE_MCP].y,
  );

  const center = {
    x: (lms[LM.WRIST].x + lms[LM.MIDDLE_MCP].x + lms[LM.INDEX_MCP].x + lms[LM.PINKY_MCP].x) / 4,
    y: (lms[LM.WRIST].y + lms[LM.MIDDLE_MCP].y + lms[LM.INDEX_MCP].y + lms[LM.PINKY_MCP].y) / 4,
  };

  return { openness, extended, extendedFlags, pinchDistance, roll, center, scale: s };
}

/* ───────────────────────── classification ───────────────────────── */

/**
 * Score every gesture, return the best candidate.
 *
 * `sensitivity` (0..1) shifts the acceptance thresholds: higher means gestures
 * fire from looser hand shapes.
 */
export function classify(f: HandFeatures, sensitivity = 0.5): GestureCandidate {
  const bias = (sensitivity - 0.5) * 0.3; // ±0.15 threshold shift
  const e = f.extendedFlags;
  const scores: Partial<Record<GestureId, number>> = {};

  // PINCH — thumb and index tips in contact. Checked first because a pinching
  // hand also looks like a partly-open hand; a tight pinch outranks everything.
  if (f.pinchDistance < 0.5) {
    const tightness = 1 - remap01(f.pinchDistance, 0.05, 0.5);
    scores.pinch = clamp(0.5 + tightness * 0.5);
  }

  // OPEN PALM — all four fingers genuinely extended AND the hand actually open.
  // The openness gate is what separates a real palm from a relaxed claw.
  if (e.index && e.middle && e.ring && e.pinky && f.openness > 0.45) {
    scores.open_palm = clamp(0.5 + f.openness * 0.5 + bias);
  }

  // CLOSED FIST — nothing extended at all (the thumb may be folded in or out,
  // but a thumb that is clearly OUT with curled fingers is a thumbs up).
  if (f.extended === 0 && f.openness < 0.55) {
    scores.closed_fist = clamp(0.58 + (1 - f.openness) * 0.42 + bias);
  }

  // POINTING — index only.
  if (e.index && !e.middle && !e.ring && !e.pinky) {
    scores.pointing = clamp(0.62 + (f.pinchDistance > 0.5 ? 0.3 : 0.05) + bias);
  }

  // PEACE — index + middle out, ring + pinky curled, fingertips apart.
  if (e.index && e.middle && !e.ring && !e.pinky) {
    const vGap = 0; // separation handled by the caller's landmark spread below
    scores.peace = clamp(0.68 + vGap + bias);
  }

  // THUMBS UP — thumb out, all four fingers curled.
  if (e.thumb && !e.index && !e.middle && !e.ring && !e.pinky) {
    scores.thumbs_up = clamp(0.7 + (1 - f.openness) * 0.25 + bias);
  }

  // ROTATE — the fallback for a loose, partly-closed hand that is none of the
  // above. Deliberately scored low so any deliberate pose wins over it.
  if (f.openness > 0.1 && f.openness < 0.95 && f.pinchDistance > 0.5) {
    const isDeliberate =
      scores.open_palm !== undefined ||
      scores.closed_fist !== undefined ||
      scores.pointing !== undefined ||
      scores.peace !== undefined ||
      scores.thumbs_up !== undefined;
    if (!isDeliberate) scores.rotate = clamp(0.55 + bias * 0.5);
  }

  let best: GestureCandidate = { id: "none", confidence: 0 };
  for (const [id, score] of Object.entries(scores)) {
    if ((score ?? 0) > best.confidence) best = { id: id as GestureId, confidence: score ?? 0 };
  }
  return best;
}

/** Classify directly from a tracked hand (features + peace-sign refinement). */
export function classifyHand(hand: TrackedHand, sensitivity = 0.5): GestureCandidate {
  const f = extractFeatures(hand.landmarks);
  const c = classify(f, sensitivity);
  if (c.id === "peace") {
    // Require a real V: the two fingertips must actually be separated.
    const gap = dist2(hand.landmarks[LM.INDEX_TIP], hand.landmarks[LM.MIDDLE_TIP]) / f.scale;
    if (gap < 0.22) return { id: "pointing", confidence: 0.6 };
    return { id: "peace", confidence: clamp(c.confidence + remap01(gap, 0.22, 0.6) * 0.2) };
  }
  return c;
}

/* ───────────────────────── temporal smoothing ───────────────────────── */

/** Exponential smoothing for a scalar signal (openness, zoom span, …). */
export class Smoothed {
  private value: number | null = null;
  constructor(private alpha = 0.3) {}
  push(v: number): number {
    this.value = this.value === null ? v : lerp(this.value, v, this.alpha);
    return this.value;
  }
  get(): number {
    return this.value ?? 0;
  }
  reset(v: number | null = null): void {
    this.value = v;
  }
  setAlpha(a: number): void {
    this.alpha = clamp(a, 0.02, 1);
  }
}

/**
 * GestureStabiliser — turns a noisy per-frame classification into a stable
 * gesture plus discrete, debounced "fired" events.
 *
 * - A gesture must hold for `holdFrames` consecutive frames before it becomes
 *   the active gesture (debounce).
 * - A discrete gesture only fires once per entry, and not again within
 *   `cooldownMs` (cooldown) — so one peace sign switches ONE aircraft.
 * - Only one gesture is ever active, so conflicting actions cannot co-fire.
 */
export class GestureStabiliser {
  private candidate: GestureId = "none";
  private candidateFrames = 0;
  private active: GestureId = "none";
  private activeConfidence = 0;
  private lastFired = new Map<GestureId, number>();
  private firedForThisEntry = false;

  constructor(
    private holdFrames = 3,
    private minConfidence = 0.5,
    private cooldownMs = 900,
  ) {}

  configure(opts: { holdFrames?: number; minConfidence?: number; cooldownMs?: number }): void {
    if (opts.holdFrames !== undefined) this.holdFrames = Math.max(1, Math.round(opts.holdFrames));
    if (opts.minConfidence !== undefined) this.minConfidence = clamp(opts.minConfidence, 0.05, 0.98);
    if (opts.cooldownMs !== undefined) this.cooldownMs = Math.max(0, opts.cooldownMs);
  }

  /**
   * @returns the stable gesture, its confidence, and whether this frame should
   *          trigger a discrete action.
   */
  update(
    candidate: GestureCandidate,
    now: number,
    discrete: boolean,
  ): { gesture: GestureId; confidence: number; fired: boolean } {
    const accepted = candidate.confidence >= this.minConfidence ? candidate.id : "none";

    if (accepted === this.candidate) {
      this.candidateFrames++;
    } else {
      this.candidate = accepted;
      this.candidateFrames = 1;
    }

    if (this.candidateFrames >= this.holdFrames && this.active !== this.candidate) {
      this.active = this.candidate;
      this.firedForThisEntry = false;
    }
    if (this.active === candidate.id) this.activeConfidence = candidate.confidence;
    if (this.active === "none") this.activeConfidence = 0;

    let fired = false;
    if (discrete && this.active !== "none" && !this.firedForThisEntry) {
      const last = this.lastFired.get(this.active) ?? -Infinity;
      if (now - last >= this.cooldownMs) {
        this.lastFired.set(this.active, now);
        this.firedForThisEntry = true;
        fired = true;
      }
    }

    return { gesture: this.active, confidence: this.activeConfidence, fired };
  }

  /** Called when hands disappear, so re-entry can fire again. */
  clear(): void {
    this.candidate = "none";
    this.candidateFrames = 0;
    this.active = "none";
    this.activeConfidence = 0;
    this.firedForThisEntry = false;
  }

  get current(): GestureId {
    return this.active;
  }
}

/** Gestures that trigger a one-shot action rather than a continuous one. */
export const DISCRETE_GESTURES = new Set<GestureId>(["peace", "thumbs_up", "pinch"]);

/** Normalised span between two hands, used for two-hand zoom. */
export function twoHandSpan(a: Landmark[], b: Landmark[]): number {
  const fa = extractFeatures(a);
  const fb = extractFeatures(b);
  const raw = Math.hypot(fa.center.x - fb.center.x, fa.center.y - fb.center.y);
  // Normalise by mean palm size so moving both hands towards the camera
  // together does not read as a zoom.
  return raw / Math.max(1e-4, (fa.scale + fb.scale) * 0.5);
}
