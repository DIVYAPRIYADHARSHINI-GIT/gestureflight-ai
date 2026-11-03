/**
 * ExplodedViewController — drives the engineering exploded view.
 *
 * The separation amount is a single 0..1 scalar. Each component travels along
 * its own logical direction (wings outboard, engines down-and-out, gear down,
 * tail aft, nose forward) scaled by that amount — so the animation is smooth,
 * continuous and exactly reversible: amount 0 restores every home position.
 *
 * Hand openness writes the target directly, so the user controls the degree of
 * separation rather than just toggling it.
 */

import * as THREE from "three";
import type { ComponentNode } from "./AircraftModelLoader";
import { clamp, lerp } from "./GestureRecognition";

export class ExplodedViewController {
  private target = 0;
  private current = 0;
  private components: Map<string, ComponentNode> = new Map();
  /** Per-component extra offset for "pull out and inspect". */
  private isolated: string | null = null;
  private isolateAmount = 0;
  private isolateTarget = 0;
  private radius = 10;

  setModel(components: Map<string, ComponentNode>, radius: number): void {
    this.components = components;
    this.radius = radius;
    this.current = 0;
    this.target = 0;
    this.isolated = null;
    this.isolateAmount = 0;
    this.isolateTarget = 0;
    this.apply();
  }

  /** 0 = assembled, 1 = fully exploded. */
  setAmount(v: number): void {
    this.target = clamp(v);
  }

  get amount(): number {
    return this.current;
  }

  get targetAmount(): number {
    return this.target;
  }

  explode(): void {
    this.target = 1;
  }

  assemble(): void {
    this.target = 0;
    this.isolateTarget = 0;
  }

  /** Pulls one component clear of the aircraft for close inspection. */
  isolate(componentId: string | null): void {
    this.isolated = componentId;
    this.isolateTarget = componentId ? 1 : 0;
  }

  get isolatedId(): string | null {
    return this.isolateTarget > 0 ? this.isolated : null;
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 6.5);
    const before = this.current;
    const beforeIso = this.isolateAmount;
    this.current = lerp(this.current, this.target, k);
    this.isolateAmount = lerp(this.isolateAmount, this.isolateTarget, k);
    if (Math.abs(this.current - before) > 1e-5 || Math.abs(this.isolateAmount - beforeIso) > 1e-5) {
      this.apply();
    }
  }

  /** True once the model is within a hair of fully assembled. */
  get isAssembled(): boolean {
    return this.current < 0.015 && this.target === 0;
  }

  private apply(): void {
    const travel = this.radius * 0.72;
    const tmp = new THREE.Vector3();

    for (const node of this.components.values()) {
      const scale = this.explodeScaleFor(node.id);
      tmp.copy(node.explodeDir).multiplyScalar(this.current * travel * scale);

      if (this.isolated === node.id && this.isolateAmount > 0) {
        // Isolation lifts the part out towards the viewer-left, clear of the rest.
        tmp.addScaledVector(node.explodeDir, this.isolateAmount * travel * 0.9);
        tmp.y += this.isolateAmount * this.radius * 0.25;
      } else if (this.isolated && this.isolateAmount > 0) {
        // Everything else recedes slightly so the isolated part reads clearly.
        tmp.multiplyScalar(1 + this.isolateAmount * 0.18);
      }

      node.group.position.copy(node.home).add(tmp);

      // A gentle fan-out rotation sells the engineering-presentation look.
      const spin = this.current * 0.12 * scale;
      node.group.rotation.set(
        node.explodeDir.z * spin,
        node.explodeDir.y * spin * 0.5,
        -node.explodeDir.z * spin * 0.4,
      );
    }
  }

  /**
   * Per-component travel multipliers. Larger values move further so the parts
   * do not collide mid-animation and the result reads like a real exploded
   * assembly drawing.
   */
  private explodeScaleFor(id: string): number {
    switch (id) {
      case "fuselage":
        return 0;
      case "nose":
        return 1.25;
      case "cockpit":
        return 1.1;
      case "wing_left":
      case "wing_right":
        return 1.15;
      case "engine_left":
      case "engine_right":
        return 1.2;
      case "flaps":
        return 1.45;
      case "vstab":
        return 1.1;
      case "rudder":
        return 1.5;
      case "hstab":
        return 1.15;
      case "elevators":
        return 1.55;
      case "gear":
        return 1.35;
      default:
        return 1;
    }
  }
}
