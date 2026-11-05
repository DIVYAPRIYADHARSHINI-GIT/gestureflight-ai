/**
 * XRayMode — see-through rendering for internal inspection (§7).
 *
 * Non-destructive by construction: the original material of every mesh is
 * stashed in a WeakMap and restored verbatim on disable, so the uploaded model
 * is never permanently modified. Transparent clones are cached per mesh, so
 * toggling repeatedly does not leak materials.
 *
 * It only reveals geometry that is ACTUALLY in the model. It never fabricates
 * internal structure — if a model is a hollow shell, X-Ray shows an empty
 * interior, and the app says so.
 */

import * as THREE from "three";

export interface XRayTarget {
  id: string;
  object: THREE.Object3D;
  /** Outer/body parts are the ones made transparent. */
  isShell: boolean;
}

export class XRayMode {
  private enabled = false;
  private opacity = 0.22;
  private originals = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private clones: THREE.Material[] = [];
  private targets: XRayTarget[] = [];
  /** Ids the user has explicitly excluded from the transparency pass. */
  private opaqueOverrides = new Set<string>();

  get isEnabled(): boolean {
    return this.enabled;
  }

  get currentOpacity(): number {
    return this.opacity;
  }

  /**
   * Registers the objects X-Ray can act on.
   *
   * `isShell` decides what turns transparent. Callers classify by geometry
   * (largest bounding volume / outermost parts), never by invented names.
   */
  setTargets(targets: XRayTarget[]): void {
    if (this.enabled) this.disable();
    this.targets = targets;
  }

  /**
   * Classifies parts into shell vs internal by bounding-box containment.
   *
   * A part is treated as "shell" when its bounding box contains the centre of
   * the whole model AND it is among the largest by volume — i.e. it is an outer
   * body you would need to see through. This is geometric, so it works on any
   * uploaded model without relying on names.
   */
  static classifyShells(
    entries: Array<{ id: string; object: THREE.Object3D }>,
  ): XRayTarget[] {
    if (entries.length === 0) return [];

    const measured = entries.map((e) => {
      const box = new THREE.Box3().setFromObject(e.object);
      const size = box.getSize(new THREE.Vector3());
      return {
        ...e,
        box,
        volume: Math.max(1e-9, size.x * size.y * size.z),
      };
    });

    const whole = new THREE.Box3();
    for (const m of measured) whole.union(m.box);
    const centre = whole.getCenter(new THREE.Vector3());
    const wholeSize = whole.getSize(new THREE.Vector3());
    const wholeVolume = Math.max(1e-9, wholeSize.x * wholeSize.y * wholeSize.z);

    // A single object cannot be "shell vs internal" — treat it as the shell so
    // X-Ray still does something visible and honest.
    if (measured.length === 1) {
      return [{ id: measured[0].id, object: measured[0].object, isShell: true }];
    }

    // Volume fraction is a poor test on its own: a long thin fuselage occupies
    // only a few percent of the model's bounding-box volume yet is obviously
    // the outer body. So rank parts by how much of the model's LONGEST
    // dimension they span, and treat the biggest spanners that also enclose
    // the model centre as shells.
    const longestAxis = Math.max(wholeSize.x, wholeSize.y, wholeSize.z);
    const scored = measured.map((m) => {
      const size = m.box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z) / Math.max(1e-9, longestAxis);
      return { ...m, span, spansCentre: m.box.containsPoint(centre) };
    });

    const maxSpan = Math.max(...scored.map((s) => s.span));
    return scored.map((m) => ({
      id: m.id,
      object: m.object,
      // A shell either encloses the model centre (a body you look through), or
      // spans most of the model's length while being comparatively hollow.
      isShell:
        (m.spansCentre && m.span > maxSpan * 0.45) ||
        (m.span > maxSpan * 0.9 && m.volume / wholeVolume < 0.5),
    }));
  }

  setOpacity(value: number): void {
    this.opacity = Math.min(0.95, Math.max(0.02, value));
    if (this.enabled) this.apply();
  }

  /** Keeps one component fully opaque even while X-Ray is on. */
  setOpaqueOverride(id: string, opaque: boolean): void {
    if (opaque) this.opaqueOverrides.add(id);
    else this.opaqueOverrides.delete(id);
    if (this.enabled) this.apply();
  }

  isOverridden(id: string): boolean {
    return this.opaqueOverrides.has(id);
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.apply();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    // Restore every original material exactly as it was.
    for (const t of this.targets) {
      t.object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Prefer PartManager's live base material so a part that is currently
        // selected keeps its highlight after X-Ray turns off.
        const base = mesh.userData.__baseMat as THREE.Material | undefined;
        const original = base ?? this.originals.get(mesh);
        if (original) mesh.material = original;
        mesh.renderOrder = 0;
      });
    }
  }

  toggle(): boolean {
    if (this.enabled) this.disable();
    else this.enable();
    return this.enabled;
  }

  /** Counts what X-Ray is actually revealing, for honest UI reporting. */
  get stats(): { shells: number; internals: number } {
    return {
      shells: this.targets.filter((t) => t.isShell).length,
      internals: this.targets.filter((t) => !t.isShell).length,
    };
  }

  private apply(): void {
    for (const t of this.targets) {
      const transparent = t.isShell && !this.opaqueOverrides.has(t.id);
      t.object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;

        // Capture the pre-X-Ray material once. PartManager may also swap
        // materials for selection highlighting, so only record a material that
        // is NOT one of our own ghosts, and prefer PartManager's recorded base
        // so the two systems agree on what "original" means.
        if (!this.originals.has(mesh)) {
          const base = (mesh.userData.__baseMat as THREE.Material | undefined) ?? mesh.material;
          this.originals.set(mesh, base);
        }
        const original = this.originals.get(mesh)!;

        if (!transparent) {
          mesh.material = original;
          mesh.renderOrder = 1;
          return;
        }

        let ghost = mesh.userData.__xrayMat as THREE.Material | undefined;
        if (!ghost) {
          const src = Array.isArray(original) ? original[0] : original;
          const clone = src.clone() as THREE.MeshStandardMaterial;
          clone.transparent = true;
          clone.depthWrite = false;
          clone.side = THREE.DoubleSide;
          if ("emissive" in clone) {
            clone.emissive = new THREE.Color(0x1d6b84);
            clone.emissiveIntensity = 0.35;
          }
          this.clones.push(clone);
          mesh.userData.__xrayMat = clone;
          ghost = clone;
        }
        (ghost as THREE.MeshStandardMaterial).opacity = this.opacity;
        mesh.material = ghost;
        // Draw shells last so internals are not hidden behind them.
        mesh.renderOrder = 2;
      });
    }
  }

  dispose(): void {
    this.disable();
    for (const m of this.clones) m.dispose();
    this.clones = [];
    this.targets = [];
    this.opaqueOverrides.clear();
  }
}
