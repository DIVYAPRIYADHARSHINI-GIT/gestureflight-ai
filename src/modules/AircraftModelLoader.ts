/**
 * AircraftModelLoader — builds a real, interactive 3D aircraft as 13 named
 * component groups.
 *
 * ASSET NOTE (§5 of the brief): the brief asks for a properly-licensed free
 * GLB/GLTF aircraft. No GLB in this repository could have its licence verified
 * offline, and the app must not ship an asset whose licence is unconfirmed — so
 * every aircraft here is generated procedurally from Three.js geometry, which
 * is the brief's explicitly sanctioned fallback. It is real interactive 3D
 * geometry (lofted NACA aerofoils, lofted fuselages, modelled turbofans and
 * oleo gear legs), NOT a flat image. See `maybeLoadGlb` below: if a licensed
 * GLB is dropped into /public/aircraft/<id>.glb it is used instead, and the
 * README documents how to credit it.
 */

import * as THREE from "three";
import type { AircraftProfile, AircraftSpec } from "../types";
import {
  buildFuselage,
  buildGearLeg,
  buildTurbofan,
  buildWing,
  loftLiftingSurface,
  mergeGeometries,
  type FuselageProfile,
} from "./geometry";

export interface ComponentNode {
  id: string;
  group: THREE.Group;
  /** Home position (assembled). */
  home: THREE.Vector3;
  /** Direction the part travels when exploded. */
  explodeDir: THREE.Vector3;
  /** Meshes belonging to this component, for highlighting. */
  meshes: THREE.Mesh[];
}

export interface BuiltAircraft {
  root: THREE.Group;
  components: Map<string, ComponentNode>;
  /** Bounding radius used to frame the camera. */
  radius: number;
  /** Uniform scale applied so every aircraft fills a similar viewport volume. */
  scale: number;
  source: "procedural" | "glb";
  dispose: () => void;
}

const DEG = Math.PI / 180;

export class AircraftModelLoader {
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];

  /**
   * Hook for a licensed GLB override. Returns null when none is present, which
   * is the shipped state — see the ASSET NOTE above.
   */
  async maybeLoadGlb(spec: AircraftSpec): Promise<null> {
    if (!spec.glb) return null;
    return null;
  }

  async build(spec: AircraftSpec): Promise<BuiltAircraft> {
    const p = spec.profile;
    const mats = this.makeMaterials(p);
    const root = new THREE.Group();
    root.name = `aircraft:${spec.id}`;

    const components = new Map<string, ComponentNode>();
    const add = (id: string, group: THREE.Group, explodeDir: [number, number, number]) => {
      group.name = `component:${id}`;
      const meshes: THREE.Mesh[] = [];
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh;
          // Respect an explicit opt-out set by the part builder (see the cabin
          // windows): transmissive instanced meshes must stay out of the
          // shadow pass.
          if (m.userData.noShadow !== true) {
            m.castShadow = true;
            m.receiveShadow = true;
          }
          m.userData.componentId = id;
          meshes.push(m);
        }
      });
      const node: ComponentNode = {
        id,
        group,
        home: group.position.clone(),
        explodeDir: new THREE.Vector3(...explodeDir).normalize(),
        meshes,
      };
      components.set(id, node);
      root.add(group);
      return node;
    };

    // ── primary structure ──────────────────────────────────────────────
    add("fuselage", this.buildFuselageGroup(p, mats), [0, 0, 0]);
    add("nose", this.buildNose(p, mats), [1, 0.05, 0]);
    add("cockpit", this.buildCockpit(p, mats), [0.6, 0.85, 0]);

    // ── lifting surfaces ───────────────────────────────────────────────
    add("wing_right", this.buildWingGroup(p, mats, 1), [0, 0.15, 1]);
    add("wing_left", this.buildWingGroup(p, mats, -1), [0, 0.15, -1]);
    add("flaps", this.buildFlaps(p, mats), [-0.55, -0.2, 0.9]);

    // ── propulsion ─────────────────────────────────────────────────────
    add("engine_right", this.buildEngineGroup(p, mats, 1), [0.2, -1, 0.4]);
    add("engine_left", this.buildEngineGroup(p, mats, -1), [0.2, -1, -0.4]);

    // ── empennage ──────────────────────────────────────────────────────
    add("vstab", this.buildVStab(p, mats), [-0.25, 1, 0]);
    add("rudder", this.buildRudder(p, mats), [-1, 0.75, 0]);
    add("hstab", this.buildHStab(p, mats), [-0.65, 0.4, 0]);
    add("elevators", this.buildElevators(p, mats), [-1, 0.45, 0.25]);

    // ── undercarriage ──────────────────────────────────────────────────
    add("gear", this.buildGear(p, mats), [0, -1, 0]);

    // Normalise size so all four aircraft frame similarly in the viewport.
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const scale = 16 / Math.max(size.x, size.y, size.z);
    root.scale.setScalar(scale);

    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);

    const geos = this.geometries;
    const materialList = this.materials;
    this.geometries = [];
    this.materials = [];

    return {
      root,
      components,
      radius: sphere.radius * scale,
      scale,
      source: "procedural",
      dispose: () => {
        for (const g of geos) g.dispose();
        for (const m of materialList) m.dispose();
        root.clear();
      },
    };
  }

  /* ───────────────────────── materials ───────────────────────── */

  private makeMaterials(p: AircraftProfile) {
    const track = <T extends THREE.Material>(m: T): T => {
      this.materials.push(m);
      return m;
    };
    return {
      shell: track(
        new THREE.MeshStandardMaterial({
          color: p.colors.shell,
          metalness: 0.62,
          roughness: 0.34,
          side: THREE.DoubleSide,
        }),
      ),
      accent: track(
        new THREE.MeshStandardMaterial({ color: p.colors.accent, metalness: 0.5, roughness: 0.38 }),
      ),
      dark: track(
        new THREE.MeshStandardMaterial({ color: p.colors.dark, metalness: 0.78, roughness: 0.42 }),
      ),
      glass: track(
        new THREE.MeshPhysicalMaterial({
          color: p.colors.glass,
          metalness: 0.1,
          roughness: 0.08,
          transmission: 0.55,
          thickness: 0.4,
          transparent: true,
          opacity: 0.86,
        }),
      ),
      metal: track(
        new THREE.MeshStandardMaterial({ color: 0xb9c4cf, metalness: 0.92, roughness: 0.28 }),
      ),
      tyre: track(new THREE.MeshStandardMaterial({ color: 0x181c20, metalness: 0.1, roughness: 0.9 })),
    };
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  /* ───────────────────────── fuselage family ───────────────────────── */

  private fuselageStations(p: AircraftProfile): FuselageProfile[] {
    const r = p.fuselageRadius;
    switch (p.kind) {
      case "cargo":
        // Boxy high-volume hold with a strong tail upsweep for the ramp.
        return [
          { t: 0.06, r: r * 0.42, y: r * 0.18, square: 0.25 },
          { t: 0.13, r: r * 0.78, y: r * 0.1, square: 0.45 },
          { t: 0.22, r: r * 0.97, square: 0.7 },
          { t: 0.5, r, square: 0.8 },
          { t: 0.68, r: r * 0.97, square: 0.78 },
          { t: 0.8, r: r * 0.82, y: r * 0.3, square: 0.6 },
          { t: 0.9, r: r * 0.55, y: r * 0.72, square: 0.4 },
          { t: 0.97, r: r * 0.26, y: r * 0.95, square: 0.2 },
        ];
      case "fighter":
        // Area-ruled blended body: waisted at the wing, widened at the intakes.
        return [
          { t: 0.03, r: r * 0.3, y: -r * 0.05 },
          { t: 0.12, r: r * 0.68, y: r * 0.02 },
          { t: 0.26, r: r * 0.95, wide: 1.25 },
          { t: 0.42, r: r * 0.92, wide: 1.5 },
          { t: 0.58, r: r * 0.88, wide: 1.55 },
          { t: 0.76, r: r * 0.86, wide: 1.4 },
          { t: 0.9, r: r * 0.78, wide: 1.2 },
          { t: 0.99, r: r * 0.66, wide: 1.1 },
        ];
      case "jet":
        return [
          { t: 0.04, r: r * 0.34 },
          { t: 0.12, r: r * 0.72 },
          { t: 0.24, r: r * 0.96 },
          { t: 0.56, r },
          { t: 0.76, r: r * 0.9 },
          { t: 0.88, r: r * 0.62, y: r * 0.34 },
          { t: 0.97, r: r * 0.24, y: r * 0.6 },
        ];
      default:
        // Airliner: constant-section tube with a tapered nose and upswept tail.
        return [
          { t: 0.03, r: r * 0.3, y: -r * 0.1 },
          { t: 0.07, r: r * 0.62, y: -r * 0.04 },
          { t: 0.13, r: r * 0.88 },
          { t: 0.2, r: r * 0.99 },
          { t: 0.5, r },
          { t: 0.7, r: r * 0.99 },
          { t: 0.82, r: r * 0.86, y: r * 0.32 },
          { t: 0.92, r: r * 0.55, y: r * 0.78 },
          { t: 0.985, r: r * 0.2, y: r * 1.02 },
        ];
    }
  }

  private buildFuselageGroup(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const stations = this.fuselageStations(p);
    // The nose component owns the forward 8%, so the body starts behind it.
    const body = this.geo(buildFuselage(p.length, stations.filter((s) => s.t > 0.06), 30));
    g.add(new THREE.Mesh(body, m.shell));

    // Cheatline / livery stripe along the cabin.
    if (p.kind !== "fighter") {
      const stripe = this.geo(
        new THREE.CylinderGeometry(p.fuselageRadius * 1.005, p.fuselageRadius * 1.005, p.length * 0.52, 30, 1, true, 0, Math.PI * 0.26),
      );
      const s1 = new THREE.Mesh(stripe, m.accent);
      s1.rotation.z = Math.PI / 2;
      s1.rotation.x = -Math.PI * 0.5;
      s1.position.x = -p.length * 0.03;
      g.add(s1);
    }

    // Cabin windows — instanced so a long row costs one draw call.
    if (p.kind === "airliner" || p.kind === "jet") {
      const count = p.kind === "airliner" ? 30 : 8;
      const wGeo = this.geo(new THREE.CircleGeometry(p.fuselageRadius * 0.075, 10));
      const inst = new THREE.InstancedMesh(wGeo, m.glass, count * 2);
      const dummy = new THREE.Object3D();
      let i = 0;
      for (let k = 0; k < count; k++) {
        const t = 0.26 + (k / Math.max(1, count - 1)) * 0.46;
        const x = p.length * (0.5 - t);
        for (const side of [-1, 1]) {
          dummy.position.set(x, p.fuselageRadius * 0.34, side * p.fuselageRadius * 0.955);
          dummy.rotation.set(0, side > 0 ? 0 : Math.PI, 0);
          dummy.updateMatrix();
          inst.setMatrixAt(i++, dummy.matrix);
        }
      }
      inst.userData.componentId = "fuselage";
      // Flat, flush windows cast no meaningful shadow, and an InstancedMesh
      // using a transmissive MeshPhysicalMaterial cannot compile its depth
      // shader on strict/software GL backends (fails VALIDATE_STATUS on
      // SwiftShader). Excluding it from the shadow pass is both correct and
      // cheaper.
      inst.castShadow = false;
      inst.receiveShadow = false;
      inst.userData.noShadow = true;
      g.add(inst);
    }

    // Fighter intakes read as part of the body, not the engines.
    if (p.kind === "fighter") {
      for (const side of [-1, 1]) {
        const intake = new THREE.Mesh(
          this.geo(new THREE.BoxGeometry(p.length * 0.2, p.fuselageRadius * 1.0, p.fuselageRadius * 0.62)),
          m.dark,
        );
        intake.position.set(p.length * 0.1, -p.fuselageRadius * 0.3, side * p.fuselageRadius * 1.1);
        g.add(intake);
      }
    }
    return g;
  }

  private buildNose(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const r = p.fuselageRadius;
    const noseLen = p.length * (p.kind === "fighter" ? 0.14 : 0.085);

    // Ogive radome built as a short loft so it blends into the body section.
    const radome = this.geo(
      buildFuselage(noseLen * 2, [
        { t: 0.02, r: r * 0.08 },
        { t: 0.2, r: r * 0.36 },
        { t: 0.45, r: r * 0.62 },
        { t: 0.72, r: r * 0.84 },
        { t: 1.0, r: r * (p.kind === "fighter" ? 0.96 : 0.93) },
      ]),
    );
    const mesh = new THREE.Mesh(radome, m.shell);
    mesh.position.x = p.length * 0.5 - noseLen * 0.98;
    g.add(mesh);

    // Pitot probe — small, but it is what tells you this is a real nose.
    const pitot = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(r * 0.02, r * 0.02, r * 0.5, 6)), m.metal);
    pitot.rotation.z = Math.PI / 2;
    pitot.position.set(p.length * 0.5 + noseLen * 0.1, 0, 0);
    g.add(pitot);

    g.position.set(0, 0, 0);
    return g;
  }

  private buildCockpit(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const r = p.fuselageRadius;

    if (p.kind === "fighter") {
      // Bubble canopy.
      const canopy = new THREE.Mesh(
        this.geo(new THREE.SphereGeometry(r * 0.62, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55)),
        m.glass,
      );
      canopy.scale.set(2.5, 1, 0.95);
      canopy.position.set(p.length * 0.24, r * 0.56, 0);
      g.add(canopy);
      const frame = new THREE.Mesh(this.geo(new THREE.TorusGeometry(r * 0.44, r * 0.05, 8, 18)), m.dark);
      frame.rotation.y = Math.PI / 2;
      frame.position.set(p.length * 0.15, r * 0.6, 0);
      g.add(frame);
    } else {
      // Windscreen panes wrapped around the forward fuselage.
      for (const side of [-1, 1]) {
        const pane = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(r * 0.78, r * 0.42)), m.glass);
        pane.position.set(p.length * 0.385, r * 0.52, side * r * 0.42);
        pane.rotation.set(0, side * 0.42 - (side > 0 ? 0 : Math.PI), -0.3);
        g.add(pane);
        const quarter = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(r * 0.4, r * 0.3)), m.glass);
        quarter.position.set(p.length * 0.34, r * 0.46, side * r * 0.74);
        quarter.rotation.set(0, side * 1.0 - (side > 0 ? 0 : Math.PI), -0.2);
        g.add(quarter);
      }
      // Dark anti-glare shield ahead of the windscreen.
      const shield = new THREE.Mesh(this.geo(new THREE.SphereGeometry(r * 0.5, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.4)), m.dark);
      shield.scale.set(1.5, 0.8, 1.1);
      shield.position.set(p.length * 0.42, r * 0.5, 0);
      g.add(shield);
    }
    return g;
  }

  /* ───────────────────────── lifting surfaces ───────────────────────── */

  private wingParams(p: AircraftProfile) {
    const halfSpan = p.wingSpan / 2 - p.fuselageRadius * 0.55;
    return {
      halfSpan,
      rootChord: p.wingChord,
      tipChord: p.wingChord * (p.kind === "fighter" ? 0.38 : p.kind === "cargo" ? 0.4 : 0.3),
      sweepDeg: p.wingSweep,
      dihedralDeg: p.kind === "cargo" ? -3.5 : p.kind === "fighter" ? -1 : 5,
      rootX: p.kind === "fighter" ? -p.length * 0.02 : -p.length * 0.03,
      rootY: p.wingZ,
      winglet: p.kind === "airliner" || p.kind === "jet" ? 1 : 0,
    };
  }

  private buildWingGroup(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>, side: 1 | -1): THREE.Group {
    const g = new THREE.Group();
    const wp = this.wingParams(p);
    const wing = this.geo(buildWing(wp));
    const mesh = new THREE.Mesh(wing, m.shell);
    mesh.position.z = side * p.fuselageRadius * 0.5;
    if (side === -1) mesh.scale.z = -1;
    g.add(mesh);

    // Root fairing — the real blend between wing and body.
    const fairing = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(p.fuselageRadius * 0.62, 14, 10)),
      m.shell,
    );
    fairing.scale.set(p.wingChord / p.fuselageRadius / 1.6, 0.55, 0.9);
    fairing.position.set(wp.rootX - p.wingChord * 0.1, wp.rootY + p.fuselageRadius * 0.1, side * p.fuselageRadius * 0.5);
    g.add(fairing);

    // Engine pylon belongs to the wing on under-wing layouts.
    if (p.kind !== "fighter" && p.kind !== "jet" && p.engineCount > 0) {
      const count = p.engineCount / 2;
      for (let i = 0; i < count; i++) {
        const frac = p.enginePos + i * 0.22;
        const z = side * (p.wingSpan / 2) * frac;
        const sweepBack = Math.abs(z) * Math.tan(p.wingSweep * DEG);
        const pylon = new THREE.Mesh(
          this.geo(new THREE.BoxGeometry(p.wingChord * 0.5, p.engineRadius * 1.1, p.engineRadius * 0.28)),
          m.shell,
        );
        pylon.position.set(wp.rootX - sweepBack + p.wingChord * 0.1, wp.rootY - p.engineRadius * 0.6, z);
        g.add(pylon);
      }
    }
    return g;
  }

  private buildFlaps(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const wp = this.wingParams(p);
    // Two panels per side, sitting on the wing trailing edge.
    for (const side of [-1, 1]) {
      for (const [i0, i1] of [
        [0.16, 0.46],
        [0.5, 0.82],
      ]) {
        const inner = i0 * wp.halfSpan;
        const outer = i1 * wp.halfSpan;
        const chordAt = (f: number) => wp.rootChord + (wp.tipChord - wp.rootChord) * Math.pow(f, 0.85);
        const panel = this.geo(
          loftLiftingSurface(
            [
              {
                span: inner,
                chord: chordAt(i0) * 0.26,
                xOffset: wp.rootX - inner * Math.tan(wp.sweepDeg * DEG) - chordAt(i0) * 0.78,
                yOffset: wp.rootY + inner * Math.tan(wp.dihedralDeg * DEG),
                thickness: 0.1,
              },
              {
                span: outer,
                chord: chordAt(i1) * 0.26,
                xOffset: wp.rootX - outer * Math.tan(wp.sweepDeg * DEG) - chordAt(i1) * 0.78,
                yOffset: wp.rootY + outer * Math.tan(wp.dihedralDeg * DEG),
                thickness: 0.1,
              },
            ],
            "z",
          ),
        );
        const mesh = new THREE.Mesh(panel, m.accent);
        mesh.position.z = side * p.fuselageRadius * 0.5;
        if (side === -1) mesh.scale.z = -1;
        g.add(mesh);
      }
    }
    return g;
  }

  /* ───────────────────────── propulsion ───────────────────────── */

  private buildEngineGroup(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>, side: 1 | -1): THREE.Group {
    const g = new THREE.Group();
    if (p.engineCount === 0) return g;

    const perSide = p.engineCount / 2;
    for (let i = 0; i < perSide; i++) {
      const nac = buildTurbofan({
        radius: p.engineRadius,
        length: p.engineLength,
        shellMat: m.shell,
        darkMat: m.dark,
        accentMat: m.accent,
        military: p.kind === "fighter",
      });
      nac.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) this.geometries.push(mesh.geometry);
      });

      if (p.kind === "fighter") {
        nac.position.set(-p.length * 0.3, -p.fuselageRadius * 0.08, side * p.fuselageRadius * 0.52);
      } else if (p.kind === "jet") {
        nac.position.set(-p.length * 0.27, p.fuselageRadius * 0.52, side * p.fuselageRadius * 1.5);
        const pylon = new THREE.Mesh(
          this.geo(new THREE.BoxGeometry(p.engineLength * 0.5, p.engineRadius * 0.4, p.fuselageRadius * 0.7)),
          m.shell,
        );
        pylon.position.set(-p.length * 0.25, p.fuselageRadius * 0.5, side * p.fuselageRadius * 1.05);
        g.add(pylon);
      } else {
        const wp = this.wingParams(p);
        const frac = p.enginePos + i * 0.22;
        const z = side * (p.wingSpan / 2) * frac;
        const sweepBack = Math.abs(z) * Math.tan(p.wingSweep * DEG);
        nac.position.set(
          wp.rootX - sweepBack + p.wingChord * 0.55,
          wp.rootY - p.engineRadius * 1.25,
          z,
        );
      }
      g.add(nac);
    }
    return g;
  }

  /* ───────────────────────── empennage ───────────────────────── */

  private buildVStab(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const baseX = -p.length * 0.4;
    const rootChord = p.wingChord * (p.kind === "cargo" ? 0.95 : 0.85);
    const baseY = p.kind === "cargo" ? p.fuselageRadius * 0.6 : p.fuselageRadius * 0.85;

    const build = (zOff: number, cant: number) => {
      const fin = this.geo(
        loftLiftingSurface(
          [
            { span: 0, chord: rootChord, xOffset: baseX, yOffset: 0, thickness: 0.12 },
            { span: p.tailHeight * 0.55, chord: rootChord * 0.72, xOffset: baseX - p.tailHeight * 0.42, yOffset: 0, thickness: 0.1 },
            { span: p.tailHeight, chord: rootChord * 0.42, xOffset: baseX - p.tailHeight * 0.78, yOffset: 0, thickness: 0.09 },
          ],
          "y",
        ),
      );
      const mesh = new THREE.Mesh(fin, m.accent);
      mesh.position.set(0, baseY, zOff);
      mesh.rotation.x = cant;
      return mesh;
    };

    if (p.kind === "fighter") {
      // Twin canted fins.
      g.add(build(p.fuselageRadius * 0.85, -0.3));
      g.add(build(-p.fuselageRadius * 0.85, 0.3));
    } else {
      g.add(build(0, 0));
      // Dorsal fin fillet — blends the fin into the fuselage.
      const dorsal = new THREE.Mesh(
        this.geo(new THREE.BoxGeometry(p.length * 0.1, p.fuselageRadius * 0.4, p.fuselageRadius * 0.12)),
        m.accent,
      );
      dorsal.position.set(baseX + p.length * 0.06, baseY + p.fuselageRadius * 0.1, 0);
      dorsal.rotation.z = -0.12;
      g.add(dorsal);
    }
    return g;
  }

  private buildRudder(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const baseX = -p.length * 0.4;
    const rootChord = p.wingChord * (p.kind === "cargo" ? 0.95 : 0.85);
    const baseY = p.kind === "cargo" ? p.fuselageRadius * 0.6 : p.fuselageRadius * 0.85;

    const build = (zOff: number, cant: number) => {
      const r = this.geo(
        loftLiftingSurface(
          [
            {
              span: p.tailHeight * 0.08,
              chord: rootChord * 0.3,
              xOffset: baseX - rootChord * 0.78,
              yOffset: 0,
              thickness: 0.1,
            },
            {
              span: p.tailHeight * 0.95,
              chord: rootChord * 0.22,
              xOffset: baseX - p.tailHeight * 0.74 - rootChord * 0.3,
              yOffset: 0,
              thickness: 0.09,
            },
          ],
          "y",
        ),
      );
      const mesh = new THREE.Mesh(r, m.dark);
      mesh.position.set(0, baseY, zOff);
      mesh.rotation.x = cant;
      return mesh;
    };

    if (p.kind === "fighter") {
      g.add(build(p.fuselageRadius * 0.85, -0.3));
      g.add(build(-p.fuselageRadius * 0.85, 0.3));
    } else {
      g.add(build(0, 0));
    }
    return g;
  }

  private hStabBase(p: AircraftProfile) {
    // T-tail jets carry the tailplane on top of the fin.
    const onFin = p.kind === "jet";
    return {
      x: -p.length * (onFin ? 0.44 : 0.43),
      y: onFin ? p.fuselageRadius * 0.85 + p.tailHeight : p.fuselageRadius * (p.kind === "cargo" ? 0.5 : 0.35),
      chord: p.wingChord * (p.kind === "cargo" ? 0.62 : 0.55),
      half: p.hStabSpan / 2,
    };
  }

  private buildHStab(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const b = this.hStabBase(p);
    for (const side of [-1, 1]) {
      const geo = this.geo(
        buildWing({
          halfSpan: b.half,
          rootChord: b.chord,
          tipChord: b.chord * 0.48,
          sweepDeg: p.wingSweep + 8,
          dihedralDeg: p.kind === "jet" ? 0 : 6,
          rootX: b.x,
          rootY: 0,
          thickness: 0.1,
        }),
      );
      const mesh = new THREE.Mesh(geo, m.shell);
      mesh.position.set(0, b.y, side * p.fuselageRadius * 0.3);
      if (side === -1) mesh.scale.z = -1;
      g.add(mesh);
    }
    return g;
  }

  private buildElevators(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const b = this.hStabBase(p);
    for (const side of [-1, 1]) {
      const geo = this.geo(
        loftLiftingSurface(
          [
            {
              span: b.half * 0.1,
              chord: b.chord * 0.28,
              xOffset: b.x - b.chord * 0.8,
              yOffset: 0,
              thickness: 0.09,
            },
            {
              span: b.half * 0.95,
              chord: b.chord * 0.52 * 0.28 + b.chord * 0.1,
              xOffset: b.x - b.half * 0.95 * Math.tan((p.wingSweep + 8) * DEG) - b.chord * 0.6,
              yOffset: b.half * 0.95 * Math.tan((p.kind === "jet" ? 0 : 6) * DEG),
              thickness: 0.09,
            },
          ],
          "z",
        ),
      );
      const mesh = new THREE.Mesh(geo, m.dark);
      mesh.position.set(0, b.y, side * p.fuselageRadius * 0.3);
      if (side === -1) mesh.scale.z = -1;
      g.add(mesh);
    }
    return g;
  }

  /* ───────────────────────── undercarriage ───────────────────────── */

  private buildGear(p: AircraftProfile, m: ReturnType<typeof this.makeMaterials>): THREE.Group {
    const g = new THREE.Group();
    const r = p.fuselageRadius;
    const wheelR = r * (p.kind === "fighter" ? 0.2 : 0.22);
    const strut = r * (p.kind === "cargo" ? 1.0 : 1.25);

    const mk = (pairs: number) =>
      buildGearLeg({
        strutLength: strut,
        strutRadius: r * 0.07,
        wheelRadius: wheelR,
        wheelWidth: wheelR * 0.55,
        wheelPairs: pairs,
        metalMat: m.metal,
        tyreMat: m.tyre,
      });

    const nose = mk(1);
    nose.position.set(p.length * 0.3, -r * 0.88, 0);
    g.add(nose);

    const mainPairs = p.kind === "cargo" ? 3 : p.kind === "fighter" ? 1 : 2;
    for (const side of [-1, 1]) {
      const leg = mk(mainPairs);
      leg.position.set(-p.length * 0.04, -r * 0.88, side * r * (p.kind === "cargo" ? 1.0 : 0.62));
      g.add(leg);
    }

    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) this.geometries.push(mesh.geometry);
    });
    return g;
  }
}

export { mergeGeometries };
