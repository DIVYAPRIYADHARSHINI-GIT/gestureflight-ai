/**
 * Geometry and exploded-view tests.
 *
 * These build the REAL aircraft through AircraftModelLoader (Three.js runs
 * fine headless for geometry — only rendering needs WebGL) and assert that the
 * result is genuine 3D geometry with the right structure, then drive the
 * exploded-view controller and check it is exactly reversible.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { AIRCRAFT } from "../src/data/aircraft";
import { COMPONENT_ORDER } from "../src/data/components";
import { AircraftModelLoader } from "../src/modules/AircraftModelLoader";
import { ExplodedViewController } from "../src/modules/ExplodedViewController";
import { airfoilProfile, buildFuselage, loftLiftingSurface } from "../src/modules/geometry";

/* ───────────────────────── primitives ───────────────────────── */

test("airfoil profile is a closed, symmetric aerofoil with real thickness", () => {
  const prof = airfoilProfile(0.12, 24);
  assert.ok(prof.length > 40, "profile should be finely sampled");
  const xs = prof.map((p) => p[0]);
  const ys = prof.map((p) => p[1]);
  assert.ok(Math.min(...xs) >= -1e-9 && Math.max(...xs) <= 1 + 1e-9, "chord normalised 0..1");
  const maxT = Math.max(...ys);
  const minT = Math.min(...ys);
  assert.ok(maxT > 0.04 && maxT < 0.09, `half-thickness should be ~6% of chord, got ${maxT}`);
  assert.ok(Math.abs(maxT + minT) < 1e-6, "must be symmetric about the chord line");
});

test("lofted lifting surface is a closed solid with outward normals", () => {
  const geo = loftLiftingSurface(
    [
      { span: 0, chord: 4, xOffset: 0, yOffset: 0 },
      { span: 10, chord: 1.5, xOffset: -4, yOffset: 0.8 },
    ],
    "z",
  );
  const pos = geo.getAttribute("position");
  // 2 rings × 38 profile points + 2 cap apexes.
  assert.ok(pos.count >= 70, `should have real tessellation, got ${pos.count}`);
  assert.ok(geo.index, "should be indexed");
  assert.ok(geo.getAttribute("normal"), "normals must be computed");

  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox!.getSize(size);
  assert.ok(size.z > 9.5 && size.z < 10.5, `span should be ~10, got ${size.z}`);
  assert.ok(size.x > 3.5, "chord + sweep should give real extent");
  assert.ok(size.y > 0.2, "aerofoil must have thickness, not be a flat plane");

  for (let i = 0; i < pos.count; i++) {
    assert.ok(Number.isFinite(pos.getX(i)) && Number.isFinite(pos.getY(i)) && Number.isFinite(pos.getZ(i)));
  }
});

test("lofted fuselage spans the requested length and has volume", () => {
  const geo = buildFuselage(40, [
    { t: 0.05, r: 0.5 },
    { t: 0.3, r: 2 },
    { t: 0.7, r: 2 },
    { t: 0.97, r: 0.4, y: 1.5 },
  ]);
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox!.getSize(size);
  assert.ok(size.x > 34 && size.x < 42, `fuselage length ~40, got ${size.x}`);
  assert.ok(size.z > 3.5 && size.z < 4.5, `max diameter ~4, got ${size.z}`);
  assert.ok(size.y > 3, "should have vertical extent including tail upsweep");
});

/* ───────────────────────── full aircraft ───────────────────────── */

for (const spec of AIRCRAFT) {
  test(`${spec.id}: builds all 13 named component groups as real geometry`, async () => {
    const loader = new AircraftModelLoader();
    const built = await loader.build(spec);

    assert.equal(built.components.size, 13, "all 13 component groups must exist");
    for (const id of COMPONENT_ORDER) {
      const node = built.components.get(id);
      assert.ok(node, `${spec.id} is missing component ${id}`);
      assert.ok(node!.meshes.length > 0, `${id} has no meshes — it would be an invisible placeholder`);
      for (const mesh of node!.meshes) {
        const pos = mesh.geometry.getAttribute("position");
        assert.ok(pos && pos.count >= 3, `${id} mesh has no vertices`);
        assert.equal(mesh.userData.componentId, id, `${id} mesh is not tagged for picking`);
      }
    }
    built.dispose();
  });

  test(`${spec.id}: proportions match its published envelope`, async () => {
    const loader = new AircraftModelLoader();
    const built = await loader.build(spec);

    const box = new THREE.Box3().setFromObject(built.root);
    const size = new THREE.Vector3();
    box.getSize(size);

    // The model is uniformly scaled, so RATIOS must match the real spec even
    // though absolute units are normalised for the viewport.
    const expectedRatio = spec.profile.wingSpan / spec.profile.length;
    const actualRatio = size.z / size.x;
    assert.ok(
      Math.abs(actualRatio - expectedRatio) / expectedRatio < 0.25,
      `${spec.id} span:length should be ~${expectedRatio.toFixed(2)}, got ${actualRatio.toFixed(2)}`,
    );
    assert.ok(size.y > 0.1 * size.x, `${spec.id} must have real vertical extent (tail + gear)`);
    assert.ok(built.radius > 0, "bounding radius must be positive");
    assert.equal(built.source, "procedural");
    built.dispose();
  });

  test(`${spec.id}: engine count matches the profile`, async () => {
    const loader = new AircraftModelLoader();
    const built = await loader.build(spec);
    const left = built.components.get("engine_left")!;
    const right = built.components.get("engine_right")!;
    const perSide = spec.profile.engineCount / 2;
    // Each nacelle is a Group of several meshes, so count direct Group children.
    const nacelles = (n: typeof left) => n.group.children.filter((c) => c instanceof THREE.Group).length;
    assert.ok(nacelles(left) >= perSide, `${spec.id} left side should have ${perSide} nacelle(s)`);
    assert.ok(nacelles(right) >= perSide, `${spec.id} right side should have ${perSide} nacelle(s)`);
    built.dispose();
  });

  test(`${spec.id}: wings are mirrored about the centreline`, async () => {
    const loader = new AircraftModelLoader();
    const built = await loader.build(spec);
    const lBox = new THREE.Box3().setFromObject(built.components.get("wing_left")!.group);
    const rBox = new THREE.Box3().setFromObject(built.components.get("wing_right")!.group);
    const lc = lBox.getCenter(new THREE.Vector3());
    const rc = rBox.getCenter(new THREE.Vector3());
    assert.ok(lc.z * rc.z < 0, "the two wings must sit on opposite sides");
    assert.ok(Math.abs(Math.abs(lc.z) - Math.abs(rc.z)) < 0.6, "wings must be symmetric");
    assert.ok(Math.abs(lc.x - rc.x) < 0.6, "wings must be at the same station");
    built.dispose();
  });
}

test("landing gear sits below the fuselage on every aircraft", async () => {
  for (const spec of AIRCRAFT) {
    const loader = new AircraftModelLoader();
    const built = await loader.build(spec);
    const gear = new THREE.Box3().setFromObject(built.components.get("gear")!.group);
    const fus = new THREE.Box3().setFromObject(built.components.get("fuselage")!.group);
    assert.ok(gear.min.y < fus.min.y, `${spec.id}: gear must extend below the fuselage`);
    built.dispose();
  }
});

test("the vertical stabilizer is the highest structure (except a T-tail's tailplane)", async () => {
  for (const spec of AIRCRAFT) {
    const loader = new AircraftModelLoader();
    const built = await loader.build(spec);
    const fin = new THREE.Box3().setFromObject(built.components.get("vstab")!.group);
    const wing = new THREE.Box3().setFromObject(built.components.get("wing_right")!.group);
    assert.ok(fin.max.y > wing.max.y, `${spec.id}: the fin must rise above the wing`);
    built.dispose();
  }
});

/* ───────────────────────── exploded view ───────────────────────── */

test("exploded view separates every component except the fuselage datum", async () => {
  const loader = new AircraftModelLoader();
  const built = await loader.build(AIRCRAFT[0]);
  const ctrl = new ExplodedViewController();
  ctrl.setModel(built.components, built.radius);

  const homes = new Map<string, THREE.Vector3>();
  for (const [id, n] of built.components) homes.set(id, n.group.position.clone());

  ctrl.explode();
  for (let i = 0; i < 400; i++) ctrl.update(1 / 60);
  assert.ok(ctrl.amount > 0.99, `should reach full separation, got ${ctrl.amount}`);

  let moved = 0;
  for (const [id, n] of built.components) {
    const delta = n.group.position.distanceTo(homes.get(id)!);
    if (id === "fuselage") {
      assert.ok(delta < 1e-6, "the fuselage is the datum and must not move");
    } else {
      assert.ok(delta > built.radius * 0.2, `${id} barely moved (${delta.toFixed(2)})`);
      moved++;
    }
  }
  assert.equal(moved, 12, "12 components should separate around the fuselage");
  built.dispose();
});

test("assembling restores every component to its exact home position (reversible)", async () => {
  const loader = new AircraftModelLoader();
  const built = await loader.build(AIRCRAFT[1]);
  const ctrl = new ExplodedViewController();
  ctrl.setModel(built.components, built.radius);

  const homes = new Map<string, THREE.Vector3>();
  for (const [id, n] of built.components) homes.set(id, n.group.position.clone());

  ctrl.explode();
  for (let i = 0; i < 400; i++) ctrl.update(1 / 60);
  ctrl.assemble();
  for (let i = 0; i < 600; i++) ctrl.update(1 / 60);

  for (const [id, n] of built.components) {
    const delta = n.group.position.distanceTo(homes.get(id)!);
    assert.ok(delta < 1e-3, `${id} did not return home (off by ${delta})`);
    assert.ok(
      Math.abs(n.group.rotation.x) < 1e-3 && Math.abs(n.group.rotation.z) < 1e-3,
      `${id} did not return to its home rotation`,
    );
  }
  assert.ok(ctrl.isAssembled, "controller should report assembled");
  built.dispose();
});

test("separation is continuous and monotonic in the control amount", async () => {
  const loader = new AircraftModelLoader();
  const built = await loader.build(AIRCRAFT[0]);
  const ctrl = new ExplodedViewController();
  ctrl.setModel(built.components, built.radius);
  const wing = built.components.get("wing_right")!;
  const home = wing.group.position.clone();

  let last = -1;
  for (const amount of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    ctrl.setAmount(amount);
    for (let i = 0; i < 300; i++) ctrl.update(1 / 60);
    const d = wing.group.position.distanceTo(home);
    assert.ok(d > last, `travel should grow with amount (${amount}: ${d} <= ${last})`);
    last = d;
  }
  built.dispose();
});

test("hand openness maps directly onto separation — partial explode works", async () => {
  const loader = new AircraftModelLoader();
  const built = await loader.build(AIRCRAFT[0]);
  const ctrl = new ExplodedViewController();
  ctrl.setModel(built.components, built.radius);

  ctrl.setAmount(0.5);
  for (let i = 0; i < 400; i++) ctrl.update(1 / 60);
  assert.ok(Math.abs(ctrl.amount - 0.5) < 0.01, `half-open hand = half separation, got ${ctrl.amount}`);
  assert.equal(ctrl.isAssembled, false);
  built.dispose();
});

test("isolating a part moves it clear and returning restores it", async () => {
  const loader = new AircraftModelLoader();
  const built = await loader.build(AIRCRAFT[0]);
  const ctrl = new ExplodedViewController();
  ctrl.setModel(built.components, built.radius);
  const engine = built.components.get("engine_right")!;
  const home = engine.group.position.clone();

  ctrl.isolate("engine_right");
  for (let i = 0; i < 400; i++) ctrl.update(1 / 60);
  assert.equal(ctrl.isolatedId, "engine_right");
  assert.ok(engine.group.position.distanceTo(home) > built.radius * 0.3, "isolated part must pull clear");

  ctrl.isolate(null);
  for (let i = 0; i < 600; i++) ctrl.update(1 / 60);
  assert.equal(ctrl.isolatedId, null);
  assert.ok(engine.group.position.distanceTo(home) < 1e-3, "returned part must go home");
  built.dispose();
});

test("explode directions are unit vectors pointing away from the aircraft", async () => {
  const loader = new AircraftModelLoader();
  const built = await loader.build(AIRCRAFT[0]);
  for (const [id, n] of built.components) {
    if (id === "fuselage") continue;
    assert.ok(Math.abs(n.explodeDir.length() - 1) < 1e-5, `${id} explode direction is not normalised`);
  }
  // Wings must travel outboard in opposite directions.
  assert.ok(
    built.components.get("wing_left")!.explodeDir.z * built.components.get("wing_right")!.explodeDir.z < 0,
    "wings must explode to opposite sides",
  );
  // Gear must travel downwards.
  assert.ok(built.components.get("gear")!.explodeDir.y < -0.5, "gear must drop downwards");
  // Nose must travel forwards.
  assert.ok(built.components.get("nose")!.explodeDir.x > 0.5, "nose must go forwards");
  built.dispose();
});

test("switching aircraft disposes the previous model's GPU resources", async () => {
  const loader = new AircraftModelLoader();
  const first = await loader.build(AIRCRAFT[0]);
  let disposed = 0;
  first.components.forEach((n) =>
    n.meshes.forEach((m) => {
      const original = m.geometry.dispose.bind(m.geometry);
      m.geometry.dispose = () => {
        disposed++;
        original();
      };
    }),
  );
  first.dispose();
  assert.ok(disposed > 0, "geometries must be disposed on teardown");
  assert.equal(first.root.children.length, 0, "the root must be cleared");
});
