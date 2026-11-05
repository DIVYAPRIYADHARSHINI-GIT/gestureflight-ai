/**
 * FlightController — half-closed-hand aircraft attitude control (§4C).
 *
 * Distinct from camera orbit: this rotates the AIRCRAFT about its own axes,
 * which is what makes yaw/pitch/roll meaningful. Hand movement maps to rate of
 * change (not absolute angle), so the model holds its attitude when the hand
 * stops instead of snapping back.
 *
 * Damped the same way the camera is, so gesture jitter never produces a sudden
 * rotation (§4C "no unwanted sudden rotations").
 */

import * as THREE from "three";
import { clamp, lerp } from "./GestureRecognition";

export interface FlightState {
  yaw: number;
  pitch: number;
  roll: number;
}

export class FlightController {
  private target: FlightState = { yaw: 0, pitch: 0, roll: 0 };
  private current: FlightState = { yaw: 0, pitch: 0, roll: 0 };
  private anchor: { x: number; y: number; roll: number } | null = null;
  private sensitivity = 0.55;
  /** Aircraft attitude is bounded so the model can never tumble out of view. */
  private readonly limits = { pitch: 0.9, roll: 1.2 };

  setSensitivity(value: number): void {
    this.sensitivity = clamp(value, 0, 1);
  }

  /** Begins a control gesture from the current hand pose. */
  begin(handX: number, handY: number, wristRoll: number): void {
    this.anchor = { x: handX, y: handY, roll: wristRoll };
  }

  get isActive(): boolean {
    return this.anchor !== null;
  }

  /** Ends the gesture; the aircraft holds its current attitude. */
  end(): void {
    this.anchor = null;
  }

  /**
   * Feeds a new hand sample.
   *
   * @param handX normalised palm centre X (image space, already mirrored out)
   * @param handY normalised palm centre Y
   * @param wristRoll palm roll in radians
   */
  update(handX: number, handY: number, wristRoll: number): void {
    if (!this.anchor) {
      this.begin(handX, handY, wristRoll);
      return;
    }
    const gain = lerp(1.2, 4.5, this.sensitivity);

    // Horizontal hand movement → yaw. The preview is mirrored, so moving the
    // hand left must yaw the nose left: invert X here.
    const dx = -(handX - this.anchor.x);
    // Vertical: hand up (smaller Y) raises the nose → positive pitch.
    const dy = -(handY - this.anchor.y);

    this.target.yaw += dx * gain;
    this.target.pitch = clamp(this.target.pitch + dy * gain * 0.8, -this.limits.pitch, this.limits.pitch);
    // Wrist twist maps to roll as an ABSOLUTE offset from the gesture anchor,
    // which feels like holding a yoke rather than ratcheting.
    this.target.roll = clamp(
      (wristRoll - this.anchor.roll) * lerp(0.6, 1.8, this.sensitivity),
      -this.limits.roll,
      this.limits.roll,
    );

    this.anchor = { x: handX, y: handY, roll: this.anchor.roll };
  }

  /** Manual nudge used by the keyboard/button fallback (§12). */
  nudge(axis: "yaw" | "pitch" | "roll", amount: number): void {
    if (axis === "yaw") this.target.yaw += amount;
    if (axis === "pitch") {
      this.target.pitch = clamp(this.target.pitch + amount, -this.limits.pitch, this.limits.pitch);
    }
    if (axis === "roll") {
      this.target.roll = clamp(this.target.roll + amount, -this.limits.roll, this.limits.roll);
    }
  }

  /** Returns the aircraft to level flight. */
  level(): void {
    this.target = { yaw: 0, pitch: 0, roll: 0 };
    this.anchor = null;
  }

  get isLevel(): boolean {
    return (
      Math.abs(this.current.yaw) < 1e-3 &&
      Math.abs(this.current.pitch) < 1e-3 &&
      Math.abs(this.current.roll) < 1e-3
    );
  }

  /** Frame-rate independent damping, then writes the attitude onto the model. */
  apply(dt: number, model: THREE.Object3D | null): void {
    const k = 1 - Math.exp(-dt * 7);
    this.current.yaw = lerp(this.current.yaw, this.target.yaw, k);
    this.current.pitch = lerp(this.current.pitch, this.target.pitch, k);
    this.current.roll = lerp(this.current.roll, this.target.roll, k);
    if (!model) return;
    // Model space: +X forward, +Y up, +Z starboard.
    model.rotation.set(this.current.roll, this.current.yaw, this.current.pitch, "YXZ");
  }

  get attitude(): FlightState {
    return { ...this.current };
  }

  get targetAttitude(): FlightState {
    return { ...this.target };
  }

  /** Degrees, for the HUD readout. */
  get attitudeDegrees(): FlightState {
    const d = 180 / Math.PI;
    return {
      yaw: this.current.yaw * d,
      pitch: this.current.pitch * d,
      roll: this.current.roll * d,
    };
  }

  /** Restores a saved attitude (used by undo/redo). */
  restore(state: FlightState): void {
    this.target = { ...state };
    this.current = { ...state };
    this.anchor = null;
  }
}
