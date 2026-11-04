/**
 * EngineExplorer — builds and drives the internal jet-engine model.
 *
 * GEOMETRY PROVENANCE (§6): this is an explicitly ILLUSTRATIVE educational
 * turbofan, generated procedurally. It is offered when the uploaded aircraft
 * has no internal engine geometry of its own — the app never claims internal
 * parts were extracted from an external engine shape. The UI shows a provenance
 * badge on every engine view.
 *
 * It reuses the existing AircraftScene (one renderer, one camera, one gesture
 * engine) rather than creating a second Three.js scene, per §14.
 */

import * as THREE from "three";
import { ENGINE_PARTS, type EnginePartSpec } from "../data/engine";
import { clamp, lerp } from "./GestureRecognition";

export interface EngineNode {
  id: string;
  spec: EnginePartSpec;
  group: THREE.Group;
  home: THREE.Vector3;
  explodeDir: THREE.Vector3;
  meshes: THREE.Mesh[];
  /** Hidden by the user via the visibility toggle. */
  userHidden: boolean;
}

/** Engine length/radius in the same normalised units the aircraft uses. */
const L = 16;
const R = 3.1;

export class EngineExplorer {
  readonly root = new THREE.Group();
  readonly nodes = new Map<string, EngineNode>();

  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private airflow: THREE.Group | null = null;
  private airflowArrows: Array<{ mesh: THREE.Mesh; offset: number }> = [];

  private explodeTarget = 0;
  private explodeCurrent = 0;
  private cutaway = false;
  private airflowOn = true;
  private isolated: string | null = null;
  private isolateAmount = 0;
  private isolateTarget = 0;
  private built = false;

  constructor() {
    this.root.name = "engine-explorer";
    this.root.visible = false;
  }

  get isBuilt(): boolean {
    return this.built;
  }

  /** Builds the engine lazily — only on first entry to Engine mode (§11). */
  build(): void {
    if (this.built) return;

    const mats = this.makeMaterials();

    for (const spec of ENGINE_PARTS) {
      const group = new THREE.Group();
      group.name = `engine:${spec.id}`;
      this.buildPart(spec, group, mats);

      const meshes: THREE.Mesh[] = [];
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.userData.enginePartId = spec.id;
          m.castShadow = true;
          m.receiveShadow = true;
          meshes.push(m);
        }
      });

      this.nodes.set(spec.id, {
        id: spec.id,
        spec,
        group,
        home: group.position.clone(),
        explodeDir: new THREE.Vector3(...spec.explode).normalize(),
        meshes,
        userHidden: false,
      });
      this.root.add(group);
    }

    this.buildAirflow(mats);
    this.built = true;
  }

  private makeMaterials() {
    const track = <T extends THREE.Material>(m: T): T => {
      this.materials.push(m);
      return m;
    };
    return {
      casing: track(
        new THREE.MeshStandardMaterial({
          color: 0x8fa3b4,
          metalness: 0.82,
          roughness: 0.3,
          side: THREE.DoubleSide,
        }),
      ),
      cold: track(new THREE.MeshStandardMaterial({ color: 0xb9c9d6, metalness: 0.9, roughness: 0.22 })),
      hot: track(new THREE.MeshStandardMaterial({ color: 0xd98b5f, metalness: 0.74, roughness: 0.4, emissive: 0x5a1f08, emissiveIntensity: 0.35 })),
      flame: track(new THREE.MeshStandardMaterial({ color: 0xff8a3c, metalness: 0.1, roughness: 0.6, emissive: 0xff5a1e, emissiveIntensity: 1.1, transparent: true, opacity: 0.72 })),
      shaft: track(new THREE.MeshStandardMaterial({ color: 0x6f7d8a, metalness: 0.95, roughness: 0.2 })),
      accent: track(new THREE.MeshStandardMaterial({ color: 0x19b9a7, metalness: 0.5, roughness: 0.35 })),
      arrowCold: track(new THREE.MeshBasicMaterial({ color: 0x38e1f0, transparent: true, opacity: 0.85 })),
      arrowHot: track(new THREE.MeshBasicMaterial({ color: 0xff8a3c, transparent: true, opacity: 0.9 })),
    };
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  /** X position for a 0..1 axial station; intake at +X, nozzle at -X. */
  private xAt(axial: number): number {
    return L * (0.5 - axial);
  }

  /**
   * A bladed rotor disc: hub plus `count` twisted aerofoil blades in a polar
   * array — the visual signature of a real compressor/turbine stage.
   */
  private bladedDisc(opts: {
    hubR: number;
    tipR: number;
    chord: number;
    count: number;
    twist: number;
    mat: THREE.Material;
    hubMat: THREE.Material;
    thickness?: number;
  }): THREE.Group {
    const g = new THREE.Group();
    const hub = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(opts.hubR, opts.hubR, opts.chord * 0.95, 24)),
      opts.hubMat,
    );
    hub.rotation.z = Math.PI / 2;
    g.add(hub);

    const span = opts.tipR - opts.hubR;
    const bladeGeo = this.geo(
      new THREE.BoxGeometry(opts.chord, span, opts.thickness ?? Math.max(0.03, opts.chord * 0.14)),
    );
    // One geometry, instanced across the polar array — cheap and correct.
    const inst = new THREE.InstancedMesh(bladeGeo, opts.mat, opts.count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < opts.count; i++) {
      const a = (i / opts.count) * Math.PI * 2;
      dummy.position.set(0, Math.cos(a) * (opts.hubR + span / 2), Math.sin(a) * (opts.hubR + span / 2));
      dummy.rotation.set(a, 0, 0);
      dummy.rotateX(0);
      // Twist about the blade's own span axis (stagger angle).
      dummy.rotateY(opts.twist);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.castShadow = true;
    g.add(inst);
    return g;
  }

  /** A stator vane ring — stationary, opposite stagger to the rotor. */
  private vaneRing(hubR: number, tipR: number, chord: number, count: number, mat: THREE.Material): THREE.Group {
    return this.bladedDisc({
      hubR: hubR * 0.98,
      tipR,
      chord,
      count,
      twist: -0.5,
      mat,
      hubMat: mat,
      thickness: chord * 0.1,
    });
  }

  private buildPart(spec: EnginePartSpec, g: THREE.Group, m: ReturnType<typeof this.makeMaterials>): void {
    const x = this.xAt(spec.axial);

    switch (spec.id) {
      case "fan_casing": {
        // Nacelle: open cowl around the fan + bypass duct.
        const cowl = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R, R * 0.97, L * 0.3, 44, 1, true)),
          m.casing,
        );
        cowl.rotation.z = Math.PI / 2;
        cowl.position.x = this.xAt(0.14);
        g.add(cowl);
        const lip = new THREE.Mesh(this.geo(new THREE.TorusGeometry(R * 0.99, R * 0.07, 12, 44)), m.accent);
        lip.rotation.y = Math.PI / 2;
        lip.position.x = this.xAt(0.0);
        g.add(lip);
        // Containment ring — the structurally important band.
        const ring = new THREE.Mesh(this.geo(new THREE.TorusGeometry(R * 1.01, R * 0.05, 10, 44)), m.cold);
        ring.rotation.y = Math.PI / 2;
        ring.position.x = this.xAt(0.15);
        g.add(ring);
        break;
      }

      case "fan": {
        const fan = this.bladedDisc({
          hubR: R * 0.22, tipR: R * 0.92, chord: 0.9, count: 22, twist: 0.72,
          mat: m.cold, hubMat: m.shaft,
        });
        fan.position.x = x;
        g.add(fan);
        const spinner = new THREE.Mesh(this.geo(new THREE.ConeGeometry(R * 0.22, R * 0.6, 20)), m.accent);
        spinner.rotation.z = -Math.PI / 2;
        spinner.position.x = x + 0.85;
        g.add(spinner);
        break;
      }

      case "lpc": {
        // Booster: 3 rotor stages + stators, shrinking slightly.
        for (let i = 0; i < 3; i++) {
          const f = i / 3;
          const st = this.bladedDisc({
            hubR: R * (0.2 + f * 0.04), tipR: R * (0.46 - f * 0.04), chord: 0.34, count: 28,
            twist: 0.5, mat: m.cold, hubMat: m.shaft,
          });
          st.position.x = this.xAt(0.22 + i * 0.035);
          g.add(st);
          const vane = this.vaneRing(R * 0.2, R * (0.45 - f * 0.04), 0.22, 32, m.casing);
          vane.position.x = this.xAt(0.238 + i * 0.035);
          g.add(vane);
        }
        break;
      }

      case "hpc": {
        // 7 stages shrinking strongly — blades get smaller as pressure rises.
        for (let i = 0; i < 7; i++) {
          const f = i / 6;
          const tip = R * lerp(0.42, 0.2, f);
          const hub = R * lerp(0.2, 0.145, f);
          const st = this.bladedDisc({
            hubR: hub, tipR: tip, chord: lerp(0.3, 0.14, f), count: 34,
            twist: 0.46, mat: m.cold, hubMat: m.shaft,
          });
          st.position.x = this.xAt(0.33 + i * 0.026);
          g.add(st);
          const vane = this.vaneRing(hub, tip * 0.99, lerp(0.2, 0.1, f), 38, m.casing);
          vane.position.x = this.xAt(0.3435 + i * 0.026);
          g.add(vane);
        }
        break;
      }

      case "combustor": {
        // Annular liner: outer and inner walls, open at both ends.
        const outer = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.42, R * 0.4, L * 0.1, 32, 1, true)),
          m.hot,
        );
        outer.rotation.z = Math.PI / 2;
        outer.position.x = x;
        g.add(outer);
        const inner = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.23, R * 0.22, L * 0.1, 28, 1, true)),
          m.hot,
        );
        inner.rotation.z = Math.PI / 2;
        inner.position.x = x;
        g.add(inner);
        // Dome
        const dome = new THREE.Mesh(this.geo(new THREE.TorusGeometry(R * 0.32, R * 0.095, 12, 32)), m.hot);
        dome.rotation.y = Math.PI / 2;
        dome.position.x = x + L * 0.052;
        g.add(dome);
        // Flame annulus — clearly a glow, not claimed as a simulation.
        const flame = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.33, R * 0.31, L * 0.075, 28, 1, true)),
          m.flame,
        );
        flame.rotation.z = Math.PI / 2;
        flame.position.x = x - L * 0.004;
        g.add(flame);
        break;
      }

      case "fuel": {
        // Ring of injector nozzles around the combustor dome.
        const count = 18;
        const nozzle = this.geo(new THREE.CylinderGeometry(R * 0.028, R * 0.045, R * 0.2, 8));
        const inst = new THREE.InstancedMesh(nozzle, m.accent, count);
        const dummy = new THREE.Object3D();
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          dummy.position.set(this.xAt(0.485), Math.cos(a) * R * 0.32, Math.sin(a) * R * 0.32);
          dummy.rotation.set(0, 0, Math.PI / 2);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        }
        g.add(inst);
        // Fuel manifold ring feeding them.
        const manifold = new THREE.Mesh(this.geo(new THREE.TorusGeometry(R * 0.5, R * 0.03, 8, 32)), m.accent);
        manifold.rotation.y = Math.PI / 2;
        manifold.position.x = this.xAt(0.478);
        g.add(manifold);
        break;
      }

      case "hpt": {
        // 2 hot stages — larger chord, cooled blades.
        for (let i = 0; i < 2; i++) {
          const st = this.bladedDisc({
            hubR: R * 0.2, tipR: R * (0.37 + i * 0.03), chord: 0.3, count: 40,
            twist: -0.62, mat: m.hot, hubMat: m.shaft,
          });
          st.position.x = this.xAt(0.6 + i * 0.045);
          g.add(st);
          const vane = this.vaneRing(R * 0.2, R * (0.38 + i * 0.03), 0.22, 44, m.hot);
          vane.position.x = this.xAt(0.585 + i * 0.045);
          g.add(vane);
        }
        break;
      }

      case "lpt": {
        // 4 larger, cooler stages growing in diameter as gas expands.
        for (let i = 0; i < 4; i++) {
          const f = i / 3;
          const st = this.bladedDisc({
            hubR: R * (0.21 + f * 0.02), tipR: R * lerp(0.44, 0.58, f), chord: 0.3, count: 46,
            twist: -0.58, mat: m.hot, hubMat: m.shaft,
          });
          st.position.x = this.xAt(0.7 + i * 0.042);
          g.add(st);
          const vane = this.vaneRing(R * 0.21, R * lerp(0.44, 0.58, f), 0.2, 50, m.casing);
          vane.position.x = this.xAt(0.684 + i * 0.042);
          g.add(vane);
        }
        break;
      }

      case "shaft": {
        // Two concentric spools: inner LP, hollow outer HP.
        const lp = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.075, R * 0.075, L * 0.78, 20)),
          m.shaft,
        );
        lp.rotation.z = Math.PI / 2;
        lp.position.x = this.xAt(0.46);
        g.add(lp);
        const hp = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.135, R * 0.135, L * 0.34, 20, 1, true)),
          m.cold,
        );
        hp.rotation.z = Math.PI / 2;
        hp.position.x = this.xAt(0.48);
        g.add(hp);
        break;
      }

      case "bearings": {
        for (const axial of [0.18, 0.45, 0.78]) {
          const brg = new THREE.Mesh(this.geo(new THREE.TorusGeometry(R * 0.14, R * 0.04, 10, 26)), m.accent);
          brg.rotation.y = Math.PI / 2;
          brg.position.x = this.xAt(axial);
          g.add(brg);
          // Support frame struts into the casing.
          const strutGeo = this.geo(new THREE.BoxGeometry(R * 0.07, R * 0.3, R * 0.05));
          const inst = new THREE.InstancedMesh(strutGeo, m.casing, 6);
          const d = new THREE.Object3D();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            d.position.set(this.xAt(axial), Math.cos(a) * R * 0.28, Math.sin(a) * R * 0.28);
            d.rotation.set(a, 0, 0);
            d.updateMatrix();
            inst.setMatrixAt(i, d.matrix);
          }
          g.add(inst);
        }
        break;
      }

      case "nozzle": {
        const conv = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.58, R * 0.4, L * 0.14, 32, 1, true)),
          m.casing,
        );
        conv.rotation.z = Math.PI / 2;
        conv.position.x = this.xAt(0.9);
        g.add(conv);
        const plug = new THREE.Mesh(this.geo(new THREE.ConeGeometry(R * 0.22, R * 0.8, 24)), m.hot);
        plug.rotation.z = Math.PI / 2;
        plug.position.x = this.xAt(0.94);
        g.add(plug);
        // Noise-reducing chevrons on the trailing edge.
        const chev = this.geo(new THREE.ConeGeometry(R * 0.055, R * 0.17, 3));
        const inst = new THREE.InstancedMesh(chev, m.accent, 12);
        const d = new THREE.Object3D();
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          d.position.set(this.xAt(0.985), Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4);
          d.rotation.set(0, 0, Math.PI / 2);
          d.updateMatrix();
          inst.setMatrixAt(i, d.matrix);
        }
        g.add(inst);
        break;
      }

      case "core_casing": {
        const core = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.52, R * 0.6, L * 0.56, 36, 1, true)),
          m.casing,
        );
        core.rotation.z = Math.PI / 2;
        core.position.x = this.xAt(0.5);
        g.add(core);
        // Bypass duct outer wall (part of the same structural group).
        const bypass = new THREE.Mesh(
          this.geo(new THREE.CylinderGeometry(R * 0.95, R * 0.72, L * 0.44, 40, 1, true)),
          m.casing,
        );
        bypass.rotation.z = Math.PI / 2;
        bypass.position.x = this.xAt(0.36);
        g.add(bypass);
        break;
      }
    }
  }

  /* ───────────── airflow visualisation ───────────── */

  private buildAirflow(m: ReturnType<typeof this.makeMaterials>): void {
    const g = new THREE.Group();
    g.name = "engine:airflow";
    const arrow = this.geo(new THREE.ConeGeometry(0.17, 0.52, 8));

    // Two streams: cold bypass (outer) and hot core (inner).
    const streams = [
      { radius: R * 0.78, mat: m.arrowCold, count: 10, label: "bypass" },
      { radius: R * 0.3, mat: m.arrowHot, count: 12, label: "core" },
    ];
    for (const s of streams) {
      for (let i = 0; i < s.count; i++) {
        for (const angle of [0.6, 2.7, 4.5]) {
          const mesh = new THREE.Mesh(arrow, s.mat);
          mesh.rotation.z = Math.PI / 2; // point along −X (aft)
          mesh.position.set(0, Math.cos(angle) * s.radius, Math.sin(angle) * s.radius);
          mesh.renderOrder = 8;
          g.add(mesh);
          this.airflowArrows.push({ mesh, offset: i / s.count });
        }
      }
    }
    this.airflow = g;
    this.root.add(g);
  }

  /** Advances the airflow animation; called from the main render loop. */
  update(dt: number, time: number): void {
    if (!this.built) return;

    const k = 1 - Math.exp(-dt * 6.5);
    const before = this.explodeCurrent;
    const beforeIso = this.isolateAmount;
    this.explodeCurrent = lerp(this.explodeCurrent, this.explodeTarget, k);
    this.isolateAmount = lerp(this.isolateAmount, this.isolateTarget, k);
    if (Math.abs(this.explodeCurrent - before) > 1e-5 || Math.abs(this.isolateAmount - beforeIso) > 1e-5) {
      this.applyExplode();
    }

    if (this.airflow) {
      this.airflow.visible = this.airflowOn && this.explodeCurrent < 0.35;
      if (this.airflow.visible) {
        for (const a of this.airflowArrows) {
          // Travel intake → nozzle, looping.
          const t = ((time * 0.22 + a.offset) % 1);
          a.mesh.position.x = this.xAt(t);
          const fade = Math.sin(t * Math.PI);
          (a.mesh.material as THREE.MeshBasicMaterial).opacity = 0.2 + fade * 0.7;
          a.mesh.scale.setScalar(0.7 + fade * 0.5);
        }
      }
    }
  }

  private applyExplode(): void {
    const travel = L * 0.5;
    const tmp = new THREE.Vector3();
    for (const node of this.nodes.values()) {
      tmp.copy(node.explodeDir).multiplyScalar(this.explodeCurrent * travel);
      if (this.isolated === node.id && this.isolateAmount > 0) {
        tmp.addScaledVector(node.explodeDir, this.isolateAmount * travel * 0.8);
      }
      node.group.position.copy(node.home).add(tmp);
    }
  }

  /* ───────────── public controls ───────────── */

  setExplode(amount: number): void {
    this.explodeTarget = clamp(amount);
  }
  explode(): void {
    this.explodeTarget = 1;
  }
  assemble(): void {
    this.explodeTarget = 0;
    this.isolateTarget = 0;
  }
  get explodeAmount(): number {
    return this.explodeCurrent;
  }
  get explodeTargetAmount(): number {
    return this.explodeTarget;
  }
  get isAssembled(): boolean {
    return this.explodeCurrent < 0.015 && this.explodeTarget === 0;
  }

  isolate(id: string | null): void {
    this.isolated = id;
    this.isolateTarget = id ? 1 : 0;
  }
  get isolatedId(): string | null {
    return this.isolateTarget > 0 ? this.isolated : null;
  }

  /** Cutaway mode: hide the outer casings to reveal the internals (§8). */
  setCutaway(on: boolean): void {
    this.cutaway = on;
    this.refreshVisibility();
  }
  get isCutaway(): boolean {
    return this.cutaway;
  }

  setAirflow(on: boolean): void {
    this.airflowOn = on;
    if (this.airflow) this.airflow.visible = on;
  }
  get isAirflowOn(): boolean {
    return this.airflowOn;
  }

  /** Per-component visibility toggle (§5). */
  toggleVisibility(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    node.userHidden = !node.userHidden;
    this.refreshVisibility();
    return !node.userHidden;
  }

  isVisible(id: string): boolean {
    const n = this.nodes.get(id);
    if (!n) return false;
    return !n.userHidden && !(this.cutaway && !!n.spec.casing);
  }

  showAll(): void {
    for (const n of this.nodes.values()) n.userHidden = false;
    this.refreshVisibility();
  }

  private refreshVisibility(): void {
    for (const n of this.nodes.values()) {
      n.group.visible = !n.userHidden && !(this.cutaway && !!n.spec.casing);
    }
  }

  get pickTargets(): THREE.Object3D[] {
    return [...this.nodes.values()].filter((n) => n.group.visible).map((n) => n.group);
  }

  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  reset(): void {
    this.assemble();
    this.isolate(null);
    this.showAll();
    this.setCutaway(false);
    this.setAirflow(true);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
    this.nodes.clear();
    this.airflowArrows = [];
    this.airflow = null;
    this.root.clear();
    this.built = false;
  }
}
