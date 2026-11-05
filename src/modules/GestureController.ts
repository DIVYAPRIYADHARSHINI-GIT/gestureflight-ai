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
  SwipeDetector,
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

  /* ── added by the upload / engine upgrade (§7) ── */
  /** Drag the currently isolated component by a normalised screen delta. */
  dragIsolated?(dx: number, dy: number): void;
  /** Swipe steps through components or views. */
  step?(direction: 1 | -1): void;
  /** Place a measurement point at the fingertip (§10). */
  measureAt?(nx: number, ny: number): void;
}

export interface GestureState {
  gesture: GestureId;
  confidence: number;
  openness: number;
  hands: number;
  sides: string;
  fired: boolean;
  /** What the gesture is currently acting on, for the HUD (§7). */
  context?: string;
}

/**
 * Context supplied by the host each frame so the SAME gestures act on whichever
 * subject is in focus (§7): the aircraft, the engine, or an isolated component.
 */
export interface GestureContext {
  subject: "aircraft" | "engine" | "blueprint";
  /** True when a single component is pulled out and has focus. */
  hasIsolated: boolean;
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
  private swipe = new SwipeDetector();
  private pinchDragAnchor: { x: number; y: number } | null = null;
  /** Updated by the host every frame; drives context-aware routing (§7). */
  private context: GestureContext = { subject: "aircraft", hasIsolated: false };

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

  /** Host updates this when the mode or isolation state changes (§7). */
  setContext(ctx: GestureContext): void {
    if (this.context.subject !== ctx.subject) {
      // Changing subject invalidates every in-flight anchor, so a gesture in
      // progress cannot leak motion into the newly-focused object.
      this.rotateAnchor = null;
      this.rollAnchor = null;
      this.pinchDragAnchor = null;
      this.swipe.reset();
      this.stabiliser.clear();
    }
    this.context = ctx;
  }

  get currentContext(): GestureContext {
    return { ...this.context };
  }

  private contextLabel(): string {
    if (this.context.hasIsolated) return "isolated component";
    return this.context.subject;
  }

  /** Clears all anchors; called when hands vanish or gestures are disabled. */
  reset(): void {
    this.stabiliser.clear();
    this.rotateAnchor = null;
    this.rollAnchor = null;
    this.zoomAnchor = null;
    this.pinchDragAnchor = null;
    this.swipe.reset();
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
      context: this.contextLabel(),
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

    /* ── Blueprint Reference Mode (§D) ────────────────────────────────
       The blueprint is a 2D reference, not a model. Gestures must NOT reach
       the aircraft or engine here, or a hand raised while reading a drawing
       would silently explode the model behind it. Tracking stays live and the
       recognised gesture is still reported, so the user keeps their feedback —
       it simply drives nothing. */
    if (this.context.subject === "blueprint") {
      const candidate = classifyHand(hands[0], this.settings.sensitivity);
      const res = this.stabiliser.update(candidate, now, false);
      this.actions.point(null);
      this.actions.report({
        gesture: res.gesture,
        confidence: res.confidence,
        openness: this.openness.push(extractFeatures(hands[0].landmarks).openness),
        hands: hands.length,
        sides,
        fired: false,
        context: "blueprint (view only)",
      });
      return;
    }

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
        context: this.contextLabel(),
      });
      return;
    }

    this.zoomAnchor = null;

    /* ── one hand ─────────────────────────────────────────────────── */
    const hand = hands[0];
    const f = extractFeatures(hand.landmarks);
    const candidate = classifyHand(hand, this.settings.sensitivity);

    // SWIPE is motion, not pose: it is checked before pose classification and
    // pre-empts it, because a sweeping open hand would otherwise read as
    // open_palm and explode the model mid-swipe.
    if (candidate.id === "open_palm" || candidate.id === "pointing") {
      const swiped = this.swipe.push(f.center.x, now);
      if (swiped) {
        this.stabiliser.clear();
        this.rotateAnchor = null;
        this.actions.step?.(swiped === "swipe_right" ? 1 : -1);
        this.actions.report({
          gesture: swiped,
          confidence: 0.9,
          openness: this.openness.get(),
          hands: 1,
          sides,
          fired: true,
          context: this.contextLabel(),
        });
        return;
      }
    } else {
      this.swipe.reset();
    }

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
    if (res.gesture !== "pinch") this.pinchDragAnchor = null;

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
        const mx = this.pointX.push(1 - tip.x);
        const my = this.pointY.push(tip.y);
        this.actions.point(mx, my);
        if (res.fired) {
          // In measurement mode a pinch places a point rather than extracting,
          // so one gesture never triggers both (§15 conflict prevention).
          if (this.actions.measureAt) this.actions.measureAt(mx, my);
          this.actions.pinchSelected();
        }

        // PINCH + MOVE (§7): while a component is isolated, holding the pinch
        // and moving the hand drags that component. The pinch itself already
        // fired once, so this only adds translation — no conflict.
        if (this.context.hasIsolated && this.actions.dragIsolated) {
          if (!this.pinchDragAnchor) {
            this.pinchDragAnchor = { x: f.center.x, y: f.center.y };
          } else {
            const gain = lerp(1.0, 3.0, this.settings.rotationSensitivity);
            const dx = -(f.center.x - this.pinchDragAnchor.x) * gain;
            const dy = (f.center.y - this.pinchDragAnchor.y) * gain;
            if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
              this.actions.dragIsolated(dx, dy);
              this.actions.report({
                gesture: "pinch_drag",
                confidence: res.confidence,
                openness,
                hands: 1,
                sides,
                fired: false,
                context: this.contextLabel(),
              });
            }
            this.pinchDragAnchor = { x: f.center.x, y: f.center.y };
          }
        }
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
      context: this.contextLabel(),
    });
  }

  /** Supplied by the host so zoom anchoring starts from the live camera state. */
  currentZoom = 0.5;
}
