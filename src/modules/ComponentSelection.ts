/**
 * ComponentSelection — hover/selection state plus the emissive highlight.
 *
 * Highlighting clones each mesh's material once, on first highlight, and caches
 * the clone — so repeated hovering does not leak materials, and dispose()
 * releases every clone it made.
 */

import * as THREE from "three";
import type { ComponentNode } from "./AircraftModelLoader";

type AnyStandard = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

export class ComponentSelection {
  private components = new Map<string, ComponentNode>();
  private originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private clones: THREE.Material[] = [];
  private hovered: string | null = null;
  private selected: string | null = null;
  private pulse = 0;

  setModel(components: Map<string, ComponentNode>): void {
    this.disposeClones();
    this.components = components;
    this.hovered = null;
    this.selected = null;
  }

  get pickTargets(): THREE.Object3D[] {
    return [...this.components.values()].map((c) => c.group);
  }

  get hoveredId(): string | null {
    return this.hovered;
  }

  get selectedId(): string | null {
    return this.selected;
  }

  setHovered(id: string | null): boolean {
    if (this.hovered === id) return false;
    this.hovered = id;
    this.refresh();
    return true;
  }

  setSelected(id: string | null): boolean {
    if (this.selected === id) return false;
    this.selected = id;
    this.refresh();
    return true;
  }

  /** Subtle breathing glow so the selection stays legible while rotating. */
  update(dt: number): void {
    if (!this.selected && !this.hovered) return;
    this.pulse = (this.pulse + dt * 2.4) % (Math.PI * 2);
    const amp = 0.55 + Math.sin(this.pulse) * 0.22;
    const node = this.components.get(this.selected ?? this.hovered!);
    if (!node) return;
    for (const mesh of node.meshes) {
      const m = mesh.material as AnyStandard;
      if (m && "emissiveIntensity" in m) m.emissiveIntensity = amp;
    }
  }

  private refresh(): void {
    for (const node of this.components.values()) {
      const state =
        node.id === this.selected ? "selected" : node.id === this.hovered ? "hovered" : "normal";
      for (const mesh of node.meshes) this.paint(mesh, state);
    }
  }

  private paint(mesh: THREE.Mesh, state: "normal" | "hovered" | "selected"): void {
    if (state === "normal") {
      const original = this.originals.get(mesh);
      if (original) mesh.material = original;
      return;
    }

    if (!this.originals.has(mesh)) this.originals.set(mesh, mesh.material);
    const original = this.originals.get(mesh)!;

    // Reuse the cached clone where possible.
    let target = mesh.userData.__highlightMat as THREE.Material | undefined;
    if (!target) {
      const src = Array.isArray(original) ? original[0] : original;
      target = src.clone();
      this.clones.push(target);
      mesh.userData.__highlightMat = target;
    }

    const m = target as AnyStandard;
    if ("emissive" in m) {
      m.emissive = new THREE.Color(state === "selected" ? 0x38e1f0 : 0x19b9a7);
      m.emissiveIntensity = state === "selected" ? 0.7 : 0.4;
    }
    mesh.material = target;
  }

  private disposeClones(): void {
    for (const m of this.clones) m.dispose();
    this.clones = [];
  }

  dispose(): void {
    this.disposeClones();
    this.components = new Map();
  }
}
