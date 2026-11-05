/**
 * PartManager — unified multi-part selection and manipulation (§8).
 *
 * This is the single registry of "things the user can select", whatever their
 * origin: built-in aircraft components, engine assemblies, or objects imported
 * from a user's CAD file. Every part records its ORIGINAL transform on
 * registration, which is what makes "restore to the exact original position"
 * reliable no matter how it was moved.
 *
 * Unselected parts are never touched by any operation here (§8).
 */

import * as THREE from "three";

export type PartOrigin = "builtin" | "engine" | "imported";

export interface ManagedPart {
  id: string;
  name: string;
  origin: PartOrigin;
  object: THREE.Object3D;
  meshes: THREE.Mesh[];
  /** Transform at registration — the restore target. */
  home: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
  /** True when the file itself named it; false when we labelled it by index. */
  namedInFile: boolean;
  /** Extracted = pulled clear of the assembly by the user. */
  extracted: boolean;
  hidden: boolean;
}

export class PartManager {
  private parts = new Map<string, ManagedPart>();
  private selection = new Set<string>();
  private listeners = new Set<() => void>();
  /** Material clones used for highlighting, disposed on clear(). */
  private highlightClones: THREE.Material[] = [];

  /* ───────────── registration ───────────── */

  clear(): void {
    for (const m of this.highlightClones) m.dispose();
    this.highlightClones = [];
    this.parts.clear();
    this.selection.clear();
    this.notify();
  }

  register(
    id: string,
    name: string,
    origin: PartOrigin,
    object: THREE.Object3D,
    namedInFile = false,
  ): ManagedPart {
    const meshes: THREE.Mesh[] = [];
    object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.userData.partId = id;
        meshes.push(m);
      }
    });

    const part: ManagedPart = {
      id,
      name,
      origin,
      object,
      meshes,
      home: {
        position: object.position.clone(),
        rotation: object.rotation.clone(),
        scale: object.scale.clone(),
      },
      namedInFile,
      extracted: false,
      hidden: false,
    };
    this.parts.set(id, part);
    return part;
  }

  get all(): ManagedPart[] {
    return [...this.parts.values()];
  }

  get(id: string): ManagedPart | undefined {
    return this.parts.get(id);
  }

  get count(): number {
    return this.parts.size;
  }

  /** Objects eligible for raycasting — hidden parts are excluded. */
  get pickTargets(): THREE.Object3D[] {
    return this.all.filter((p) => !p.hidden).map((p) => p.object);
  }

  /* ───────────── selection ───────────── */

  get selectedIds(): string[] {
    return [...this.selection];
  }

  get selected(): ManagedPart[] {
    return this.selectedIds.map((id) => this.parts.get(id)!).filter(Boolean);
  }

  isSelected(id: string): boolean {
    return this.selection.has(id);
  }

  /** Replaces the selection with a single part (or clears it). */
  select(id: string | null): void {
    this.selection.clear();
    if (id && this.parts.has(id)) this.selection.add(id);
    this.refreshHighlight();
    this.notify();
  }

  /** Adds to the selection — the repeated point+pinch flow of §8. */
  addToSelection(id: string): boolean {
    if (!this.parts.has(id) || this.selection.has(id)) return false;
    this.selection.add(id);
    this.refreshHighlight();
    this.notify();
    return true;
  }

  toggleSelection(id: string): boolean {
    if (!this.parts.has(id)) return false;
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.refreshHighlight();
    this.notify();
    return this.selection.has(id);
  }

  selectAll(): void {
    for (const p of this.all) if (!p.hidden) this.selection.add(p.id);
    this.refreshHighlight();
    this.notify();
  }

  deselectAll(): void {
    this.selection.clear();
    this.refreshHighlight();
    this.notify();
  }

  /* ───────────── manipulation ───────────── */

  /**
   * Pulls the selected parts clear of the assembly along their outward
   * direction from the model centre. Unselected parts never move (§8).
   */
  /** Called when a part's transform changes owner (extracted/restored). */
  onOwnershipChange: ((id: string, manual: boolean) => void) | null = null;

  extractSelected(distance: number): number {
    const centre = this.modelCentre();
    let moved = 0;
    for (const p of this.selected) {
      const box = new THREE.Box3().setFromObject(p.object);
      const partCentre = box.getCenter(new THREE.Vector3());
      const dir = partCentre.sub(centre);
      if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
      dir.normalize();
      p.object.position.copy(p.home.position).addScaledVector(dir, distance);
      p.extracted = true;
      this.onOwnershipChange?.(p.id, true);
      moved++;
    }
    if (moved) this.notify();
    return moved;
  }

  /** Returns the selected parts to their exact registered transforms. */
  restoreSelected(): number {
    let n = 0;
    for (const p of this.selected) {
      p.object.position.copy(p.home.position);
      p.object.rotation.copy(p.home.rotation);
      p.object.scale.copy(p.home.scale);
      p.extracted = false;
      this.onOwnershipChange?.(p.id, false);
      n++;
    }
    if (n) this.notify();
    return n;
  }

  /** Returns every part, selected or not. */
  restoreAll(): void {
    for (const p of this.all) {
      p.object.position.copy(p.home.position);
      p.object.rotation.copy(p.home.rotation);
      p.object.scale.copy(p.home.scale);
      p.object.visible = true;
      p.extracted = false;
      p.hidden = false;
      this.onOwnershipChange?.(p.id, false);
    }
    this.notify();
  }

  /** Translates every selected part by a world-space delta. */
  moveSelected(delta: THREE.Vector3): void {
    for (const p of this.selected) p.object.position.add(delta);
  }

  /** Rotates every selected part about its own centre (§6 inspection). */
  rotateSelected(dx: number, dy: number): void {
    for (const p of this.selected) {
      this.onOwnershipChange?.(p.id, true);
      p.object.rotation.y += dx;
      p.object.rotation.x += dy;
    }
  }

  /** Resets only the ROTATION of selected parts — reset inspection pose (§6). */
  resetSelectedRotation(): void {
    for (const p of this.selected) {
      p.object.rotation.copy(p.home.rotation);
      // Back at the home pose and not extracted — give the transform back.
      if (!p.extracted) this.onOwnershipChange?.(p.id, false);
    }
    this.notify();
  }

  setHidden(id: string, hidden: boolean): void {
    const p = this.parts.get(id);
    if (!p) return;
    p.hidden = hidden;
    p.object.visible = !hidden;
    this.notify();
  }

  get hiddenIds(): string[] {
    return this.all.filter((p) => p.hidden).map((p) => p.id);
  }

  showAll(): void {
    for (const p of this.all) {
      p.hidden = false;
      p.object.visible = true;
    }
    this.notify();
  }

  get extractedIds(): string[] {
    return this.all.filter((p) => p.extracted).map((p) => p.id);
  }

  modelCentre(): THREE.Vector3 {
    const box = new THREE.Box3();
    for (const p of this.all) {
      if (!p.hidden) box.expandByObject(p.object);
    }
    return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  }

  /* ───────────── highlighting ───────────── */

  private refreshHighlight(): void {
    for (const p of this.all) {
      const on = this.selection.has(p.id);
      for (const mesh of p.meshes) {
        if (!mesh.userData.__baseMat) mesh.userData.__baseMat = mesh.material;
        if (!on) {
          mesh.material = mesh.userData.__baseMat as THREE.Material;
          continue;
        }
        let hl = mesh.userData.__selMat as THREE.Material | undefined;
        if (!hl) {
          const base = mesh.userData.__baseMat as THREE.Material | THREE.Material[];
          const src = Array.isArray(base) ? base[0] : base;
          const clone = src.clone() as THREE.MeshStandardMaterial;
          if ("emissive" in clone) {
            clone.emissive = new THREE.Color(0x38e1f0);
            clone.emissiveIntensity = 0.7;
          }
          this.highlightClones.push(clone);
          mesh.userData.__selMat = clone;
          hl = clone;
        }
        mesh.material = hl;
      }
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }
}
