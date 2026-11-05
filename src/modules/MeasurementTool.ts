/**
 * MeasurementTool — real geometric measurement (§10).
 *
 * All distances are computed from WORLD-SPACE geometry coordinates obtained by
 * raycasting against the actual mesh, never from screen pixels. The model's own
 * uniform framing scale is divided back out so figures are reported in the
 * file's own units, and the UI states plainly when that unit is unknown.
 */

import * as THREE from "three";

export type MeasurementUnit = "mm" | "cm" | "m";

export interface MeasurePoint {
  /** World-space position of the picked surface point. */
  world: THREE.Vector3;
  /** Component the point landed on, for the readout. */
  componentId: string | null;
  componentName: string | null;
}

export interface BoundingReport {
  length: number;
  width: number;
  height: number;
  /** Diagonal of the bounding box. */
  diagonal: number;
  unit: MeasurementUnit;
  unitKnown: boolean;
}

const TO_MM: Record<MeasurementUnit, number> = { mm: 1, cm: 10, m: 1000 };

export class MeasurementTool {
  private points: MeasurePoint[] = [];
  private unit: MeasurementUnit = "mm";
  /**
   * Model units per scene unit. AircraftScene applies one uniform scale to fit
   * the viewport, so dividing it back out recovers the file's own numbers.
   */
  private modelScale = 1;
  private unitKnown = false;
  private group = new THREE.Group();
  private line: THREE.Line | null = null;
  private markers: THREE.Mesh[] = [];
  private disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  constructor() {
    this.group.name = "measurement-overlay";
    this.group.renderOrder = 20;
  }

  get overlay(): THREE.Group {
    return this.group;
  }

  get pointCount(): number {
    return this.points.length;
  }

  get currentUnit(): MeasurementUnit {
    return this.unit;
  }

  get isUnitKnown(): boolean {
    return this.unitKnown;
  }

  /**
   * @param modelScale scene-units-per-model-unit applied by the viewer.
   * @param unitKnown  whether the source format actually recorded real units.
   */
  configure(modelScale: number, unitKnown: boolean): void {
    this.modelScale = modelScale > 0 ? modelScale : 1;
    this.unitKnown = unitKnown;
  }

  setUnit(unit: MeasurementUnit): void {
    this.unit = unit;
  }

  /** Adds a measurement point. Returns the number of points now held. */
  addPoint(p: MeasurePoint): number {
    // A third point starts a fresh measurement rather than accumulating.
    if (this.points.length >= 2) this.points = [];
    this.points.push(p);
    this.redraw();
    return this.points.length;
  }

  clear(): void {
    this.points = [];
    this.redraw();
  }

  /** Raw scene-space distance between the two points, or null. */
  get rawDistance(): number | null {
    if (this.points.length < 2) return null;
    return this.points[0].world.distanceTo(this.points[1].world);
  }

  /** Distance converted into the active unit, in the model's own scale. */
  get distance(): number | null {
    const raw = this.rawDistance;
    if (raw === null) return null;
    return this.toUnit(raw);
  }

  /** Converts a scene-space length into the active display unit. */
  toUnit(sceneLength: number, unit: MeasurementUnit = this.unit): number {
    const modelUnits = sceneLength / this.modelScale;
    // Model units are treated as millimetres unless the format says otherwise;
    // the UI flags this with `unitKnown` so the number is never passed off as
    // a verified real-world dimension.
    return modelUnits / TO_MM[unit];
  }

  /** Formats a converted length for display. */
  format(value: number | null, unit: MeasurementUnit = this.unit): string {
    if (value === null || !Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    const decimals = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
    return `${value.toFixed(decimals)} ${unit}`;
  }

  get endpoints(): MeasurePoint[] {
    return [...this.points];
  }

  /** Bounding-box report for any object, in the active unit (§10). */
  measureObject(object: THREE.Object3D): BoundingReport {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    return {
      length: this.toUnit(size.x),
      width: this.toUnit(size.z),
      height: this.toUnit(size.y),
      diagonal: this.toUnit(size.length()),
      unit: this.unit,
      unitKnown: this.unitKnown,
    };
  }

  /** Centre-to-centre distance between two components (§10). */
  measureBetween(a: THREE.Object3D, b: THREE.Object3D): number {
    const ca = new THREE.Box3().setFromObject(a).getCenter(new THREE.Vector3());
    const cb = new THREE.Box3().setFromObject(b).getCenter(new THREE.Vector3());
    return this.toUnit(ca.distanceTo(cb));
  }

  /** Shortest gap between two components' bounding boxes (0 when touching). */
  measureGap(a: THREE.Object3D, b: THREE.Object3D): number {
    const ba = new THREE.Box3().setFromObject(a);
    const bb = new THREE.Box3().setFromObject(b);
    const dx = Math.max(0, Math.max(ba.min.x - bb.max.x, bb.min.x - ba.max.x));
    const dy = Math.max(0, Math.max(ba.min.y - bb.max.y, bb.min.y - ba.max.y));
    const dz = Math.max(0, Math.max(ba.min.z - bb.max.z, bb.min.z - ba.max.z));
    return this.toUnit(Math.hypot(dx, dy, dz));
  }

  /* ───────────── overlay rendering ───────────── */

  private redraw(): void {
    for (const m of this.markers) this.group.remove(m);
    this.markers = [];
    if (this.line) {
      this.group.remove(this.line);
      this.line = null;
    }
    this.disposeTemp();

    for (const p of this.points) {
      const geo = new THREE.SphereGeometry(0.22, 12, 10);
      const mat = new THREE.MeshBasicMaterial({ color: 0xf3b23c, depthTest: false });
      const marker = new THREE.Mesh(geo, mat);
      marker.position.copy(p.world);
      marker.renderOrder = 21;
      this.disposables.push(geo, mat);
      this.markers.push(marker);
      this.group.add(marker);
    }

    if (this.points.length === 2) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        this.points[0].world.clone(),
        this.points[1].world.clone(),
      ]);
      const mat = new THREE.LineBasicMaterial({ color: 0xf3b23c, depthTest: false });
      this.line = new THREE.Line(geo, mat);
      this.line.renderOrder = 21;
      this.disposables.push(geo, mat);
      this.group.add(this.line);
    }
  }

  private disposeTemp(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  dispose(): void {
    this.points = [];
    this.redraw();
    this.disposeTemp();
    this.group.clear();
  }
}
