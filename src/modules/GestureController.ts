/**
 * GestureController — maps the stabilised gesture stream onto aircraft actions.
 *
 * This is the single arbitration point for §6's "do not trigger multiple
 * conflicting gestures simultaneously": exactly ONE gesture is active per
 * frame, two-hand zoom pre-empts all one-hand gestures, and the discrete
 * gestures (peace / thumbs up / pinch) fire once per entry with a cooldown.
 */

import type { GestureId, Settings, TrackedHand } from "../types";
import {
  classifyHand,
  clamp,
  DISCRETE_GESTURES,
  extractFeatures,
  GestureStabiliser,
  lerp,
  LM,
  remap01,
  Smoothed,
  twoHandSpan,
} from "./GestureRecognition";

export interface GestureActions {
  /** Continuous 0..1 explode amount from hand openness. */
  setExplode(amount: number): void;
  assemble(): void;
  /** Incremental orbit in radians. */
  orbit(dYaw: number, dPitch: number): void;
  setRoll(roll: number): void;
  /** Absolute zoom, normalised 0..1 (0 = far, 1 = near). */
  setZoom(t: number): void;
  /** Fingertip in normalised viewport coords, or null to hide the cursor. */
  point(nx: number | null, ny?: number): void;
  pinchSelected(): void;
  nextAircraft(): void;
  confirm(): void;
  /** UI feedback for the recognised gesture. */
  report(state: GestureState): void;
}

export interface GestureState {
  gesture: GestureId;
  confidence: number;
  openness: number;
  hands: number;
  sides: string;
  fired: boolean;
}

export class GestureController {
  private stabiliser = new GestureStabiliser(3, 0.5, 900);
  private openness = new Smoothed(0.25);
  private zoomSpan = new Smoothed(0.2);
  private pointX = new Smoothed(0.4);
  private pointY = new Smoothed(0.4);
  private rotateAnchor: { x: number; y: number } | null = null;
  private rollAnchor: number | null = null;
  private zoomAnchor: { span: number; zoom: number } | null = null;
  private settings: Settings;
  private enabled = true;

  constructor(
    private actions: GestureActions,
    settings: Settings,
  ) {
    this.settings = settings;
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    this.stabiliser.configure({
      // Higher sensitivity = fewer frames needed and a lower confidence floor.
      holdFrames: Math.round(lerp(6, 2, s.sensitivity)),
      minConfidence: lerp(0.62, 0.34, s.sensitivity),
      cooldownMs: s.cooldownMs,
    });
    this.openness.setAlpha(lerp(0.12, 0.45, s.explodeSensitivity));
    this.zoomSpan.setAlpha(lerp(0.1, 0.38, s.zoomSensitivity));
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) this.reset();
  }

  /** Clears all anchors; called when hands vanish or gestures are disabled. */
  reset(): void {
    this.stabiliser.clear();
    this.rotateAnchor = null;
    this.rollAnchor = null;
    this.zoomAnchor = null;
    this.openness.reset();
    this.zoomSpan.reset();
    this.actions.point(null);
    this.actions.report({
      gesture: "none",
      confidence: 0,
      openness: 0,
      hands: 0,
      sides: "—",
      fired: false,
    });
  }

  /** Called once per detection frame. */
  process(hands: TrackedHand[], now = performance.now()): void {
    if (!this.enabled) return;

    if (hands.length === 0) {
      this.reset();
      return;
    }

    const sides = hands.map((h) => h.handedness.charAt(0)).join("/") || "—";

    /* ── two hands → zoom pre-empts everything else ───────────────── */
    if (hands.length >= 2) {
      const span = this.zoomSpan.push(twoHandSpan(hands[0].landmarks, hands[1].landmarks));
      if (!this.zoomAnchor) {
        this.zoomAnchor = { span, zoom: this.currentZoom };
      } else {
        const gain = lerp(0.16, 0.5, this.settings.zoomSensitivity);
        const delta = (span - this.zoomAnchor.span) * gain;
        this.actions.setZoom(clamp(this.zoomAnchor.zoom + delta));
      }
      this.rotateAnchor = null;
      this.rollAnchor = null;
      this.actions.point(null);

      const res = this.stabiliser.update({ id: "two_hand_zoom", confidence: 0.9 }, now, false);
      this.actions.report({
        gesture: res.gesture,
        confidence: res.confidence,
        openness: this.openness.get(),
        hands: hands.length,
        sides,
        fired: false,
      });
      return;
    }

    this.zoomAnchor = null;

    /* ── one hand ─────────────────────────────────────────────────── */
    const hand = hands[0];
    const f = extractFeatures(hand.landmarks);
    const candidate = classifyHand(hand, this.settings.sensitivity);
    const res = this.stabiliser.update(
      candidate,
      now,
      DISCRETE_GESTURES.has(candidate.id),
    );
    const openness = this.openness.push(f.openness);

    // Anchors only make sense while their gesture is held.
    if (res.gesture !== "rotate") {
      this.rotateAnchor = null;
      this.rollAnchor = null;
    }
    if (res.gesture !== "pointing" && res.gesture !== "pinch") this.actions.point(null);

    switch (res.gesture) {
      case "open_palm": {
        // Openness maps onto separation. The usable range is narrowed by the
        // explode sensitivity so a small hand movement can span the full travel.
        const lo = lerp(0.52, 0.34, this.settings.explodeSensitivity);
        const hi = lerp(0.95, 0.78, this.settings.explodeSensitivity);
        this.actions.setExplode(remap01(openness, lo, hi));
        break;
      }

      case "closed_fist":
        this.actions.assemble();
        break;

      case "rotate": {
        // Palm translation orbits; wrist twist rolls.
        if (!this.rotateAnchor) {
          this.rotateAnchor = { x: f.center.x, y: f.center.y };
          this.rollAnchor = f.roll;
        } else {
          const gain = lerp(1.4, 5.2, this.settings.rotationSensitivity);
          // The preview is mirrored, so invert X for natural "push left → spin left".
          const dx = -(f.center.x - this.rotateAnchor.x);
          const dy = f.center.y - this.rotateAnchor.y;
          this.actions.orbit(dx * gain * 0.35, dy * gain * 0.22);
          this.rotateAnchor = { x: f.center.x, y: f.center.y };
          if (this.rollAnchor !== null) {
            this.actions.setRoll(clamp((f.roll - this.rollAnchor) * 0.8, -0.9, 0.9));
          }
        }
        break;
      }

      case "pointing": {
        const tip = hand.landmarks[LM.INDEX_TIP];
        // Mirror X to match the un-mirrored 3D viewport.
        const nx = this.pointX.push(1 - tip.x);
        const ny = this.pointY.push(tip.y);
        this.actions.point(nx, ny);
        break;
      }

      case "pinch": {
        const tip = hand.landmarks[LM.INDEX_TIP];
        this.actions.point(this.pointX.push(1 - tip.x), this.pointY.push(tip.y));
        if (res.fired) this.actions.pinchSelected();
        break;
      }

      case "peace":
        if (res.fired) this.actions.nextAircraft();
        break;

      case "thumbs_up":
        if (res.fired) this.actions.confirm();
        break;

      default:
        break;
    }

    this.actions.report({
      gesture: res.gesture,
      confidence: res.confidence,
      openness,
      hands: hands.length,
      sides,
      fired: res.fired,
    });
  }

  /** Supplied by the host so zoom anchoring starts from the live camera state. */
  currentZoom = 0.5;
}
