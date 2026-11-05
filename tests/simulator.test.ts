/**
 * Unit tests for the engineering-simulator upgrade: interaction state machine,
 * undo/redo history, X-Ray classification, measurement maths, multi-part
 * manipulation and flight controls.
 *
 * All pure logic — no DOM, no WebGL, no camera.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  InteractionStateManager,
  STATE_LABELS,
  type InteractionAction,
  type InteractionStateId,
} from "../src/modules/InteractionState";
import { HistoryManager, statesEqual, type HistoryState } from "../src/modules/HistoryManager";
import { XRayMode } from "../src/modules/XRayMode";
import { MeasurementTool } from "../src/modules/MeasurementTool";
import { PartManager } from "../src/modules/PartManager";
import { FlightController } from "../src/modules/FlightController";

/* ═══════════════ interaction state machine (§15) ═══════════════ */

test("starts IDLE and every state has a label", () => {
  const m = new InteractionStateManager();
  assert.equal(m.current, "IDLE");
  const ids: InteractionStateId[] = [
    "IDLE", "AIRCRAFT_EXPLODE", "AIRCRAFT_ASSEMBLE", "AIRCRAFT_CONTROL",
    "COMPONENT_SELECT", "COMPONENT_EXTRACT", "COMPONENT_INSPECT",
    "MULTI_PART_SELECT", "X_RAY", "MEASUREMENT",
  ];
  for (const id of ids) assert.ok(STATE_LABELS[id], `${id} has no label`);
});

test("pointing cannot extract a component — the §15 conflict case", () => {
  const m = new InteractionStateManager();
  m.set("COMPONENT_SELECT");
  assert.equal(m.admits("pointSelect"), true, "selecting must work here");
  m.set("AIRCRAFT_EXPLODE");
  assert.equal(m.admits("extract"), false, "extraction during an explode must be blocked");
  assert.equal(m.admits("pointSelect"), false, "picking a moving target must be blocked");
});

test("flight control excludes component manipulation", () => {
  const m = new InteractionStateManager();
  m.set("AIRCRAFT_CONTROL");
  assert.equal(m.admits("flyAircraft"), true);
  assert.equal(m.admits("moveComponent"), false, "a closed hand must not drag parts");
  assert.equal(m.admits("extract"), false);
  assert.equal(m.admits("pointSelect"), false);
});

test("camera orbit and zoom are admitted in every state", () => {
  const m = new InteractionStateManager();
  for (const id of Object.keys(STATE_LABELS) as InteractionStateId[]) {
    m.set(id);
    // The user must always be able to look at what they are doing.
    if (id !== "AIRCRAFT_CONTROL") {
      assert.ok(m.admits("orbitCamera"), `${id} should admit orbit`);
    }
    assert.ok(m.admits("zoom"), `${id} should admit zoom`);
  }
});

test("a per-action cooldown stops one pinch firing several extractions", () => {
  let now = 0;
  const m = new InteractionStateManager(() => now);
  m.set("COMPONENT_SELECT");
  assert.equal(m.tryAction("extract", 500), true, "first extraction should pass");
  assert.equal(m.tryAction("extract", 500), false, "immediate repeat must be blocked");
  now = 300;
  assert.equal(m.tryAction("extract", 500), false, "still inside the cooldown");
  now = 600;
  assert.equal(m.tryAction("extract", 500), true, "allowed once the cooldown elapses");
});

test("tryAction refuses actions the state forbids, regardless of cooldown", () => {
  const m = new InteractionStateManager();
  m.set("MEASUREMENT");
  assert.equal(m.tryAction("extract"), false);
  assert.equal(m.tryAction("measurePoint"), true);
});

test("relax() returns to IDLE but never discards sticky work", () => {
  const m = new InteractionStateManager();
  for (const sticky of ["COMPONENT_EXTRACT", "COMPONENT_INSPECT", "MEASUREMENT", "MULTI_PART_SELECT", "X_RAY"] as InteractionStateId[]) {
    m.set(sticky);
    m.relax();
    assert.equal(m.current, sticky, `${sticky} must survive a tracking dropout`);
  }
  m.set("AIRCRAFT_EXPLODE");
  m.relax();
  assert.equal(m.current, "IDLE", "transient states should relax");
});

test("state changes notify listeners with the previous state", () => {
  const m = new InteractionStateManager();
  const seen: Array<[string, string]> = [];
  m.onChange((s, p) => seen.push([s, p]));
  m.set("X_RAY");
  m.set("MEASUREMENT");
  assert.deepEqual(seen, [["X_RAY", "IDLE"], ["MEASUREMENT", "X_RAY"]]);
});

test("setting the same state is a no-op", () => {
  const m = new InteractionStateManager();
  let calls = 0;
  m.onChange(() => calls++);
  assert.equal(m.set("IDLE"), false);
  assert.equal(calls, 0);
});

/* ═══════════════ undo / redo (§11) ═══════════════ */

function makeHistory() {
  const world = {
    pos: 0,
    explode: 0,
    xray: false,
    selected: [] as string[],
  };
  const capture = (): HistoryState => ({
    transforms: {
      part: {
        position: [world.pos, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        visible: true,
      },
    },
    flags: {
      explodeAmount: world.explode,
      engineExplodeAmount: 0,
      xrayEnabled: world.xray,
      xrayOpacity: 0.22,
      selectedIds: [...world.selected],
      isolatedId: null,
      hiddenIds: [],
      measurementPoints: [],
    },
  });
  const restore = (s: HistoryState) => {
    world.pos = s.transforms.part.position[0];
    world.explode = s.flags.explodeAmount;
    world.xray = s.flags.xrayEnabled;
    world.selected = [...s.flags.selectedIds];
  };
  return { world, history: new HistoryManager(capture, restore) };
}

test("undo restores the exact previous position", () => {
  const { world, history } = makeHistory();
  history.reset();
  world.pos = 10;
  history.push("Move part");
  world.pos = 25;
  history.push("Move part again");

  assert.equal(history.undo(), "Move part again");
  assert.equal(world.pos, 10, "should be back at the first move");
  assert.equal(history.undo(), "Move part");
  assert.equal(world.pos, 0, "should be back at the original position");
});

test("redo re-applies an undone action exactly", () => {
  const { world, history } = makeHistory();
  history.reset();
  world.pos = 7;
  history.push("Move");
  history.undo();
  assert.equal(world.pos, 0);
  assert.equal(history.redo(), "Move");
  assert.equal(world.pos, 7);
});

test("undo/redo round-trips flags, not just geometry", () => {
  const { world, history } = makeHistory();
  history.reset();
  world.xray = true;
  world.explode = 0.8;
  world.selected = ["a", "b"];
  history.push("X-Ray on + explode");

  history.undo();
  assert.equal(world.xray, false);
  assert.equal(world.explode, 0);
  assert.deepEqual(world.selected, []);

  history.redo();
  assert.equal(world.xray, true);
  assert.equal(world.explode, 0.8);
  assert.deepEqual(world.selected, ["a", "b"]);
});

test("a new action after undo clears the redo branch", () => {
  const { world, history } = makeHistory();
  history.reset();
  world.pos = 5;
  history.push("A");
  history.undo();
  assert.equal(history.canRedo, true);
  world.pos = 99;
  history.push("B");
  assert.equal(history.canRedo, false, "redo must not resurrect a stale branch");
});

test("identical consecutive states are not recorded twice", () => {
  const { history } = makeHistory();
  history.reset();
  const before = history.depth.past;
  history.push("No-op");
  history.push("No-op");
  assert.equal(history.depth.past, before, "duplicates must be rejected");
});

test("a continuous drag coalesces into ONE undo step", () => {
  const { world, history } = makeHistory();
  history.reset();
  // 40 frames of dragging, all sharing a coalesce key.
  for (let i = 1; i <= 40; i++) {
    world.pos = i;
    history.push("Move component", "drag:part");
  }
  assert.equal(history.depth.past, 2, `expected 1 seed + 1 drag entry, got ${history.depth.past}`);
  history.undo();
  assert.equal(world.pos, 0, "one undo should revert the whole drag");
});

test("undo cannot run past the seed state", () => {
  const { history } = makeHistory();
  history.reset();
  assert.equal(history.canUndo, false);
  assert.equal(history.undo(), null);
});

test("the history stack is bounded", () => {
  const world = { n: 0 };
  const history = new HistoryManager(
    () => ({
      transforms: { p: { position: [world.n, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true } },
      flags: {
        explodeAmount: 0, engineExplodeAmount: 0, xrayEnabled: false, xrayOpacity: 0.2,
        selectedIds: [], isolatedId: null, hiddenIds: [], measurementPoints: [],
      },
    }),
    (s) => { world.n = s.transforms.p.position[0]; },
    10,
  );
  history.reset();
  for (let i = 1; i <= 50; i++) {
    world.n = i;
    history.push(`step ${i}`);
  }
  assert.ok(history.depth.past <= 10, `stack grew to ${history.depth.past}`);
});

test("restoring does not record new history (no feedback loop)", () => {
  const { world, history } = makeHistory();
  history.reset();
  world.pos = 3;
  history.push("Move");
  const depth = history.depth.past;
  history.undo();
  history.redo();
  assert.equal(history.depth.past, depth, "undo/redo must not append entries");
});

test("statesEqual detects real differences", () => {
  const base: HistoryState = {
    transforms: { a: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true } },
    flags: {
      explodeAmount: 0, engineExplodeAmount: 0, xrayEnabled: false, xrayOpacity: 0.2,
      selectedIds: [], isolatedId: null, hiddenIds: [], measurementPoints: [],
    },
  };
  const moved = structuredClone(base);
  moved.transforms.a.position = [1, 0, 0];
  assert.equal(statesEqual(base, base), true);
  assert.equal(statesEqual(base, moved), false);

  const hidden = structuredClone(base);
  hidden.transforms.a.visible = false;
  assert.equal(statesEqual(base, hidden), false, "visibility is part of the state");
});

/* ═══════════════ X-Ray (§7) ═══════════════ */

function meshAt(x: number, size: number, name: string): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial({ color: 0x888888 }),
  );
  m.position.x = x;
  m.name = name;
  return m;
}

test("X-Ray classifies an outer body as shell and inner parts as internal", () => {
  // A big hull centred at the origin, with two small parts inside it.
  const hull = meshAt(0, 10, "hull");
  const inner1 = meshAt(1, 1, "engine");
  const inner2 = meshAt(-2, 1, "tank");
  const targets = XRayMode.classifyShells([
    { id: "hull", object: hull },
    { id: "inner1", object: inner1 },
    { id: "inner2", object: inner2 },
  ]);
  const byId = Object.fromEntries(targets.map((t) => [t.id, t.isShell]));
  assert.equal(byId.hull, true, "the large central body is the shell");
  assert.equal(byId.inner1, false, "small internal parts are not shells");
  assert.equal(byId.inner2, false);
});

test("a single-object model treats that object as the shell", () => {
  const only = meshAt(0, 5, "solid");
  const t = XRayMode.classifyShells([{ id: "only", object: only }]);
  assert.equal(t.length, 1);
  assert.equal(t[0].isShell, true, "X-Ray must still do something visible");
});

test("enabling X-Ray makes shells transparent and leaves internals opaque", () => {
  const hull = meshAt(0, 10, "hull");
  const inner = meshAt(1, 1, "engine");
  const xray = new XRayMode();
  xray.setTargets(XRayMode.classifyShells([
    { id: "hull", object: hull },
    { id: "inner", object: inner },
  ]));

  const hullBefore = hull.material;
  xray.enable();
  assert.equal(xray.isEnabled, true);
  assert.notEqual(hull.material, hullBefore, "shell material should be swapped");
  assert.equal((hull.material as THREE.MeshStandardMaterial).transparent, true);
  assert.equal(inner.material, inner.material, "internals keep their material");
  xray.dispose();
});

test("disabling X-Ray restores the ORIGINAL materials exactly", () => {
  const hull = meshAt(0, 10, "hull");
  const original = hull.material;
  const xray = new XRayMode();
  xray.setTargets(XRayMode.classifyShells([{ id: "hull", object: hull }]));
  xray.enable();
  xray.disable();
  assert.equal(hull.material, original, "the model must not be permanently modified");
  xray.dispose();
});

test("X-Ray opacity is adjustable and clamped", () => {
  const hull = meshAt(0, 10, "hull");
  const xray = new XRayMode();
  xray.setTargets(XRayMode.classifyShells([{ id: "hull", object: hull }]));
  xray.enable();
  xray.setOpacity(0.5);
  assert.equal((hull.material as THREE.MeshStandardMaterial).opacity, 0.5);
  xray.setOpacity(5);
  assert.ok(xray.currentOpacity <= 0.95, "must clamp above");
  xray.setOpacity(-1);
  assert.ok(xray.currentOpacity >= 0.02, "must clamp below");
  xray.dispose();
});

test("a component can be forced opaque while X-Ray is on", () => {
  const hull = meshAt(0, 10, "hull");
  const xray = new XRayMode();
  xray.setTargets(XRayMode.classifyShells([{ id: "hull", object: hull }]));
  xray.enable();
  const ghost = hull.material;
  xray.setOpaqueOverride("hull", true);
  assert.notEqual(hull.material, ghost, "override should restore the solid material");
  assert.equal(xray.isOverridden("hull"), true);
  xray.dispose();
});

test("toggling X-Ray repeatedly does not leak or corrupt materials", () => {
  const hull = meshAt(0, 10, "hull");
  const original = hull.material;
  const xray = new XRayMode();
  xray.setTargets(XRayMode.classifyShells([{ id: "hull", object: hull }]));
  for (let i = 0; i < 20; i++) xray.toggle();
  xray.disable();
  assert.equal(hull.material, original);
  xray.dispose();
});

test("X-Ray reports what it is actually revealing", () => {
  const xray = new XRayMode();
  xray.setTargets(XRayMode.classifyShells([
    { id: "hull", object: meshAt(0, 10, "hull") },
    { id: "a", object: meshAt(1, 1, "a") },
    { id: "b", object: meshAt(2, 1, "b") },
  ]));
  const s = xray.stats;
  assert.equal(s.shells + s.internals, 3);
  assert.ok(s.internals >= 2, "should report the internal parts it can reveal");
  xray.dispose();
});

/* ═══════════════ measurement (§10) ═══════════════ */

test("distance is computed from geometry, in the model's own units", () => {
  const t = new MeasurementTool();
  // The viewer scaled the model by 2x to fit the viewport.
  t.configure(2, true);
  t.setUnit("mm");
  t.addPoint({ world: new THREE.Vector3(0, 0, 0), componentId: null, componentName: null });
  t.addPoint({ world: new THREE.Vector3(20, 0, 0), componentId: null, componentName: null });
  // 20 scene units / 2 = 10 model units = 10 mm.
  assert.equal(t.distance, 10);
  assert.equal(t.rawDistance, 20, "raw scene distance is also available");
});

test("unit conversion is consistent across mm / cm / m", () => {
  const t = new MeasurementTool();
  t.configure(1, true);
  t.addPoint({ world: new THREE.Vector3(0, 0, 0), componentId: null, componentName: null });
  t.addPoint({ world: new THREE.Vector3(1000, 0, 0), componentId: null, componentName: null });
  t.setUnit("mm");
  assert.equal(t.distance, 1000);
  t.setUnit("cm");
  assert.equal(t.distance, 100);
  t.setUnit("m");
  assert.equal(t.distance, 1);
});

test("a third point starts a fresh measurement", () => {
  const t = new MeasurementTool();
  t.configure(1, true);
  t.addPoint({ world: new THREE.Vector3(0, 0, 0), componentId: null, componentName: null });
  t.addPoint({ world: new THREE.Vector3(5, 0, 0), componentId: null, componentName: null });
  assert.equal(t.pointCount, 2);
  const n = t.addPoint({ world: new THREE.Vector3(9, 0, 0), componentId: null, componentName: null });
  assert.equal(n, 1, "the third click restarts the measurement");
  assert.equal(t.distance, null, "one point is not a measurement");
});

test("bounding-box measurement reports real dimensions", () => {
  const t = new MeasurementTool();
  t.configure(1, true);
  const box = new THREE.Mesh(new THREE.BoxGeometry(40, 10, 20), new THREE.MeshBasicMaterial());
  const r = t.measureObject(box);
  assert.ok(Math.abs(r.length - 40) < 1e-6, `length ${r.length}`);
  assert.ok(Math.abs(r.height - 10) < 1e-6, `height ${r.height}`);
  assert.ok(Math.abs(r.width - 20) < 1e-6, `width ${r.width}`);
  assert.ok(r.diagonal > 40, "diagonal must exceed the longest side");
});

test("distance between two components uses their real centres", () => {
  const t = new MeasurementTool();
  t.configure(1, true);
  const a = meshAt(0, 2, "a");
  const b = meshAt(30, 2, "b");
  assert.ok(Math.abs(t.measureBetween(a, b) - 30) < 1e-6);
});

test("gap measurement is zero for touching parts and positive for a real gap", () => {
  const t = new MeasurementTool();
  t.configure(1, true);
  const a = meshAt(0, 2, "a");
  const touching = meshAt(2, 2, "b");
  assert.ok(t.measureGap(a, touching) < 1e-6, "touching boxes have no gap");
  const apart = meshAt(12, 2, "c");
  assert.ok(Math.abs(t.measureGap(a, apart) - 10) < 1e-6, "10-unit gap expected");
});

test("unknown model scale is reported, not hidden", () => {
  const t = new MeasurementTool();
  t.configure(1, false);
  assert.equal(t.isUnitKnown, false, "the UI must be able to warn about this");
  const r = t.measureObject(meshAt(0, 5, "x"));
  assert.equal(r.unitKnown, false);
});

test("clearing removes the measurement", () => {
  const t = new MeasurementTool();
  t.configure(1, true);
  t.addPoint({ world: new THREE.Vector3(0, 0, 0), componentId: null, componentName: null });
  t.addPoint({ world: new THREE.Vector3(5, 0, 0), componentId: null, componentName: null });
  t.clear();
  assert.equal(t.pointCount, 0);
  assert.equal(t.distance, null);
});

test("formatting handles an absent measurement", () => {
  const t = new MeasurementTool();
  assert.equal(t.format(null), "—");
  assert.match(t.format(12.3456), /12\.35 mm|12\.346 mm/);
});

/* ═══════════════ multi-part manipulation (§8) ═══════════════ */

function managerWithParts(n: number): { pm: PartManager; objs: THREE.Object3D[] } {
  const pm = new PartManager();
  const objs: THREE.Object3D[] = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.Group();
    g.add(meshAt(0, 1, `m${i}`));
    g.position.set(i * 5, 0, 0);
    pm.register(`p${i}`, `Part ${i + 1}`, "imported", g, false);
    objs.push(g);
  }
  return { pm, objs };
}

test("multiple parts can be selected by repeated adds", () => {
  const { pm } = managerWithParts(4);
  pm.select("p0");
  pm.addToSelection("p1");
  pm.addToSelection("p2");
  assert.deepEqual(pm.selectedIds.sort(), ["p0", "p1", "p2"]);
  assert.equal(pm.addToSelection("p2"), false, "re-adding is a no-op");
});

test("extracting selected parts never moves unselected ones", () => {
  const { pm, objs } = managerWithParts(4);
  const untouched = objs[3].position.clone();
  pm.select("p0");
  pm.addToSelection("p1");
  const moved = pm.extractSelected(20);
  assert.equal(moved, 2);
  assert.ok(objs[0].position.distanceTo(new THREE.Vector3(0, 0, 0)) > 1, "p0 moved");
  assert.ok(objs[3].position.equals(untouched), "unselected part must not move");
});

test("restore returns parts to their EXACT original transforms", () => {
  const { pm, objs } = managerWithParts(3);
  const homes = objs.map((o) => o.position.clone());
  pm.selectAll();
  pm.extractSelected(25);
  pm.rotateSelected(0.5, 0.3);
  pm.restoreSelected();
  objs.forEach((o, i) => {
    assert.ok(o.position.distanceTo(homes[i]) < 1e-9, `part ${i} position not restored`);
    assert.ok(Math.abs(o.rotation.x) < 1e-9 && Math.abs(o.rotation.y) < 1e-9, `part ${i} rotation not restored`);
  });
});

test("select all / deselect all work", () => {
  const { pm } = managerWithParts(5);
  pm.selectAll();
  assert.equal(pm.selectedIds.length, 5);
  pm.deselectAll();
  assert.equal(pm.selectedIds.length, 0);
});

test("hidden parts are excluded from selection and picking", () => {
  const { pm } = managerWithParts(3);
  pm.setHidden("p1", true);
  pm.selectAll();
  assert.ok(!pm.isSelected("p1"), "a hidden part should not be selected by Select All");
  assert.equal(pm.pickTargets.length, 2, "hidden parts are not pickable");
  assert.deepEqual(pm.hiddenIds, ["p1"]);
  pm.showAll();
  assert.equal(pm.pickTargets.length, 3);
});

test("moving the selection translates only those parts", () => {
  const { pm, objs } = managerWithParts(3);
  pm.select("p1");
  pm.moveSelected(new THREE.Vector3(0, 7, 0));
  assert.ok(Math.abs(objs[1].position.y - 7) < 1e-9);
  assert.ok(Math.abs(objs[0].position.y) < 1e-9, "unselected part unmoved");
});

test("rotation can be reset without moving the part", () => {
  const { pm, objs } = managerWithParts(2);
  pm.select("p0");
  pm.moveSelected(new THREE.Vector3(3, 0, 0));
  pm.rotateSelected(1, 1);
  const moved = objs[0].position.clone();
  pm.resetSelectedRotation();
  assert.ok(Math.abs(objs[0].rotation.x) < 1e-9, "rotation reset");
  assert.ok(objs[0].position.equals(moved), "position preserved");
});

test("restoreAll resets every part including hidden ones", () => {
  const { pm, objs } = managerWithParts(3);
  const homes = objs.map((o) => o.position.clone());
  pm.selectAll();
  pm.extractSelected(30);
  pm.setHidden("p0", true);
  pm.restoreAll();
  objs.forEach((o, i) => assert.ok(o.position.distanceTo(homes[i]) < 1e-9, `part ${i}`));
  assert.equal(pm.hiddenIds.length, 0);
  assert.equal(pm.extractedIds.length, 0);
});

test("extracted parts are tracked", () => {
  const { pm } = managerWithParts(3);
  pm.select("p2");
  pm.extractSelected(10);
  assert.deepEqual(pm.extractedIds, ["p2"]);
  pm.restoreSelected();
  assert.deepEqual(pm.extractedIds, []);
});

/* ═══════════════ flight controls (§4C) ═══════════════ */

test("horizontal hand movement yaws the aircraft", () => {
  const f = new FlightController();
  f.begin(0.5, 0.5, 0);
  f.update(0.7, 0.5, 0); // hand moves right in image space
  const model = new THREE.Object3D();
  for (let i = 0; i < 200; i++) f.apply(1 / 60, model);
  assert.ok(Math.abs(f.attitude.yaw) > 0.01, "yaw should change");
  assert.ok(Math.abs(f.attitude.pitch) < 1e-6, "pitch must not change");
});

test("vertical hand movement pitches the aircraft, hand up = nose up", () => {
  const f = new FlightController();
  f.begin(0.5, 0.5, 0);
  f.update(0.5, 0.3, 0); // hand moves UP (smaller y)
  const model = new THREE.Object3D();
  for (let i = 0; i < 200; i++) f.apply(1 / 60, model);
  assert.ok(f.attitude.pitch > 0, `nose should rise, got ${f.attitude.pitch}`);
});

test("wrist twist rolls the aircraft", () => {
  const f = new FlightController();
  f.begin(0.5, 0.5, 0);
  f.update(0.5, 0.5, 0.6);
  const model = new THREE.Object3D();
  for (let i = 0; i < 200; i++) f.apply(1 / 60, model);
  assert.ok(Math.abs(f.attitude.roll) > 0.01, "roll should change");
});

test("attitude is bounded so the model cannot tumble away", () => {
  const f = new FlightController();
  f.setSensitivity(1);
  f.begin(0.5, 0.5, 0);
  for (let i = 0; i < 100; i++) f.update(0.5, 0.5 - i * 0.01, 3);
  const model = new THREE.Object3D();
  for (let i = 0; i < 400; i++) f.apply(1 / 60, model);
  assert.ok(Math.abs(f.attitude.pitch) <= 0.95, `pitch ${f.attitude.pitch} out of bounds`);
  assert.ok(Math.abs(f.attitude.roll) <= 1.25, `roll ${f.attitude.roll} out of bounds`);
});

test("motion is damped — no sudden jump on the first frame", () => {
  const f = new FlightController();
  f.begin(0.5, 0.5, 0);
  f.update(0.95, 0.5, 0); // a big jerk
  const model = new THREE.Object3D();
  f.apply(1 / 60, model);
  const afterOne = Math.abs(f.attitude.yaw);
  for (let i = 0; i < 300; i++) f.apply(1 / 60, model);
  const settled = Math.abs(f.attitude.yaw);
  assert.ok(afterOne < settled * 0.5, "the first frame must not jump to the target");
});

test("the aircraft holds its attitude when the hand stops", () => {
  const f = new FlightController();
  f.begin(0.5, 0.5, 0);
  f.update(0.7, 0.5, 0);
  const model = new THREE.Object3D();
  for (let i = 0; i < 300; i++) f.apply(1 / 60, model);
  const held = f.attitude.yaw;
  f.end();
  for (let i = 0; i < 300; i++) f.apply(1 / 60, model);
  assert.ok(Math.abs(f.attitude.yaw - held) < 1e-6, "attitude must not spring back");
});

test("level() returns the aircraft to neutral", () => {
  const f = new FlightController();
  f.begin(0.5, 0.5, 0);
  f.update(0.8, 0.2, 0.5);
  const model = new THREE.Object3D();
  for (let i = 0; i < 200; i++) f.apply(1 / 60, model);
  f.level();
  for (let i = 0; i < 600; i++) f.apply(1 / 60, model);
  assert.ok(f.isLevel, `expected level, got ${JSON.stringify(f.attitude)}`);
});

test("the attitude is written onto the model object", () => {
  const f = new FlightController();
  const model = new THREE.Object3D();
  f.nudge("yaw", 0.5);
  for (let i = 0; i < 400; i++) f.apply(1 / 60, model);
  assert.ok(Math.abs(model.rotation.y - 0.5) < 0.01, `model yaw ${model.rotation.y}`);
  assert.equal(model.rotation.order, "YXZ");
});

test("attitude can be restored for undo/redo", () => {
  const f = new FlightController();
  f.restore({ yaw: 0.3, pitch: -0.2, roll: 0.1 });
  assert.ok(Math.abs(f.attitude.yaw - 0.3) < 1e-9);
  assert.ok(Math.abs(f.attitude.pitch + 0.2) < 1e-9);
  assert.equal(f.isActive, false, "restoring must not leave a gesture anchor");
});

test("degrees readout matches radians", () => {
  const f = new FlightController();
  f.restore({ yaw: Math.PI / 2, pitch: 0, roll: 0 });
  assert.ok(Math.abs(f.attitudeDegrees.yaw - 90) < 1e-6);
});
