/**
 * Unit tests for the upload / engine / modes upgrade.
 *
 * Covers the PURE, DOM-free logic: file validation, magic-byte sniffing, swipe
 * detection, mode arbitration, engine data integrity and blueprint-derived
 * reconstruction. Browser-only paths (parsers, canvas, WebGL) are covered by
 * the e2e suite with real files instead.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  FORMATS,
  FileValidationError,
  detectFormat,
  formatBytes,
  sniff,
  validate,
  type UploadFormat,
} from "../src/modules/AircraftFileProcessor";
import { SwipeDetector, GESTURES, GESTURE_SEQUENCE } from "../src/modules/GestureRecognition";
import { MODES, ModeManager, QUALITY_PROFILES } from "../src/modules/ExplorationModes";
import { ENGINE_PARTS, AIRFLOW_PATH, engineHierarchy, enginePartById } from "../src/data/engine";
import { reconstructedAircraft } from "../src/data/aircraft";
import { EngineExplorer } from "../src/modules/EngineExplorer";

/* ───────────────────────── format registry ───────────────────────── */

const file = (name: string, size = 1024, type = ""): File =>
  ({ name, size, type }) as File;

test("the original nine formats are still registered after the universal upgrade", () => {
  const exts = FORMATS.flatMap((f) => f.extensions);
  for (const required of [".step", ".stp", ".stl", ".obj", ".glb", ".gltf", ".pdf", ".png", ".jpg", ".jpeg"]) {
    assert.ok(exts.includes(required), `missing extension ${required}`);
  }
});

// NOTE: extension/MIME detection, unsupported-format rejection and size-limit
// enforcement moved to tests/formats.test.ts when the registry became universal,
// so they are asserted there against all 38 extensions rather than the old 8.

test("formats are split correctly into 3D models and 2D blueprints", () => {
  const mesh = FORMATS.filter((f) => f.kind === "mesh3d").flatMap((f) => f.extensions);
  const bp = FORMATS.filter((f) => f.kind === "blueprint").flatMap((f) => f.extensions);
  for (const e of [".step", ".stp", ".stl", ".obj", ".glb", ".gltf"]) assert.ok(mesh.includes(e), `${e} should be 3D`);
  for (const e of [".pdf", ".png", ".jpg", ".jpeg"]) assert.ok(bp.includes(e), `${e} should be a blueprint`);
});




test("empty files are rejected", () => {
  assert.throws(
    () => validate(file("empty.stl", 0)),
    (e: FileValidationError) => e.reason === "empty",
  );
});


test("every format has a positive, sane size limit", () => {
  for (const f of FORMATS) {
    assert.ok(f.maxBytes > 1024 * 1024, `${f.id} limit too small`);
    assert.ok(f.maxBytes <= 256 * 1024 * 1024, `${f.id} limit unreasonably large`);
  }
});

test("formatBytes renders B / KB / MB correctly", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

/* ───────────────────────── magic-byte sniffing ───────────────────────── */

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

test("sniffing accepts genuine file signatures", () => {
  assert.ok(sniff("pdf", bytesOf("%PDF-1.7\nstuff")));
  assert.ok(sniff("png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])));
  assert.ok(sniff("jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])));
  assert.ok(sniff("glb", bytesOf("glTF\u0002\u0000\u0000\u0000")));
  assert.ok(sniff("gltf", bytesOf('  {"asset":{"version":"2.0"}}')));
  assert.ok(sniff("step", bytesOf("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION")));
  assert.ok(sniff("stl", bytesOf("solid wing\nfacet normal 0 0 1")));
  assert.ok(sniff("obj", bytesOf("# exported\nv 0 0 0\nv 1 0 0\nf 1 2 3\n")));
});

test("sniffing rejects a file renamed from another format", () => {
  // A PNG renamed to .step must not be treated as CAD.
  assert.equal(sniff("step", new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
  // A text file renamed to .glb.
  assert.equal(sniff("glb", bytesOf("hello world, not a model")), false);
  // HTML renamed to .pdf.
  assert.equal(sniff("pdf", bytesOf("<!doctype html><html>")), false);
  assert.equal(sniff("png", bytesOf("%PDF-1.4")), false);
});

test("binary STL is recognised by its triangle-count header", () => {
  const tris = 3;
  const buf = new Uint8Array(84 + tris * 50);
  new DataView(buf.buffer).setUint32(80, tris, true);
  assert.ok(sniff("stl", buf), "valid binary STL should pass");

  const bad = new Uint8Array(84 + tris * 50);
  new DataView(bad.buffer).setUint32(80, 9999, true);
  assert.equal(sniff("stl", bad), false, "mismatched triangle count should fail");
});

/* ───────────────────────── swipe detection ───────────────────────── */

test("a fast rightward sweep fires one swipe", () => {
  const s = new SwipeDetector();
  let fired: string | null = null;
  // Image x DECREASES for a physical right-hand sweep (mirrored preview).
  for (let i = 0; i < 8; i++) {
    const r = s.push(0.7 - i * 0.045, i * 20);
    if (r) fired = r;
  }
  assert.equal(fired, "swipe_right");
});

test("a fast leftward sweep fires the opposite direction", () => {
  const s = new SwipeDetector();
  let fired: string | null = null;
  for (let i = 0; i < 8; i++) {
    const r = s.push(0.3 + i * 0.045, i * 20);
    if (r) fired = r;
  }
  assert.equal(fired, "swipe_left");
});

test("a slow hand drift never fires a swipe", () => {
  const s = new SwipeDetector();
  for (let i = 0; i < 60; i++) {
    // Same total distance, but spread over 3 seconds.
    assert.equal(s.push(0.2 + i * 0.008, i * 50), null, `fired on a slow drift at frame ${i}`);
  }
});

test("a tiny fast jitter never fires a swipe", () => {
  const s = new SwipeDetector();
  for (let i = 0; i < 20; i++) {
    assert.equal(s.push(0.5 + (i % 2) * 0.01, i * 16), null, "jitter must not fire");
  }
});

test("one physical sweep produces exactly one event, not a burst", () => {
  const s = new SwipeDetector();
  let count = 0;
  // Keep moving fast for a long time — a naive detector would fire repeatedly.
  for (let i = 0; i < 40; i++) {
    if (s.push(0.95 - i * 0.02, i * 16)) count++;
  }
  assert.equal(count, 1, `expected 1 swipe, got ${count}`);
});

test("a second swipe is possible after the hand slows and the cooldown passes", () => {
  const s = new SwipeDetector();
  let first: string | null = null;
  for (let i = 0; i < 8; i++) {
    const r = s.push(0.7 - i * 0.045, i * 20);
    if (r) first = r;
  }
  assert.ok(first, "first swipe should fire");

  // Hand slows right down — re-arms the detector.
  for (let i = 0; i < 25; i++) s.push(0.35, 200 + i * 40);

  let second: string | null = null;
  for (let i = 0; i < 8; i++) {
    const r = s.push(0.35 + i * 0.045, 1400 + i * 20);
    if (r) second = r;
  }
  assert.equal(second, "swipe_left", "a later swipe should fire again");
});

test("reset() clears swipe history", () => {
  const s = new SwipeDetector();
  for (let i = 0; i < 4; i++) s.push(0.7 - i * 0.045, i * 20);
  s.reset();
  // Too few samples after reset to conclude anything.
  assert.equal(s.push(0.4, 100), null);
});

/* ───────────────────────── exploration modes ───────────────────────── */

test("all five exploration modes from the brief exist", () => {
  const ids = MODES.map((m) => m.id);
  for (const required of ["exterior", "exploded", "engine", "cutaway", "blueprint"]) {
    assert.ok(ids.includes(required as never), `missing mode ${required}`);
  }
});

test("each mode routes gestures to a defined subject", () => {
  for (const m of MODES) {
    assert.ok(["aircraft", "engine", "blueprint"].includes(m.subject), `${m.id} has no subject`);
    assert.ok(m.hint.length > 10, `${m.id} has no hint text`);
  }
});

test("blueprint mode is unavailable until a blueprint is loaded", () => {
  const mm = new ModeManager();
  assert.equal(mm.isAvailable("blueprint"), false);
  assert.equal(mm.set("blueprint"), false, "must not switch to an unavailable mode");
  assert.equal(mm.mode, "exterior");

  mm.setAvailable("blueprint", true);
  assert.equal(mm.set("blueprint"), true);
  assert.equal(mm.mode, "blueprint");
});

test("removing the last blueprint leaves blueprint mode and returns to exterior", () => {
  const mm = new ModeManager();
  mm.setAvailable("blueprint", true);
  mm.set("blueprint");
  mm.setAvailable("blueprint", false);
  assert.equal(mm.mode, "exterior", "must fall back when the active mode disappears");
});

test("mode changes notify listeners with the previous mode", () => {
  const mm = new ModeManager();
  const seen: Array<[string, string]> = [];
  mm.onChange((m, prev) => seen.push([m, prev]));
  mm.set("engine");
  mm.set("cutaway");
  assert.deepEqual(seen, [
    ["engine", "exterior"],
    ["cutaway", "engine"],
  ]);
});

test("cycling steps only through AVAILABLE modes", () => {
  const mm = new ModeManager();
  const visited = new Set<string>();
  for (let i = 0; i < 6; i++) visited.add(mm.cycle(1));
  assert.ok(!visited.has("blueprint"), "must not cycle into an unavailable mode");
  assert.equal(visited.size, 4, "should cycle the four always-available modes");
});

test("engine and cutaway modes both target the engine subject", () => {
  const mm = new ModeManager();
  mm.set("engine");
  assert.equal(mm.subject, "engine");
  mm.set("cutaway");
  assert.equal(mm.subject, "engine");
  mm.set("exterior");
  assert.equal(mm.subject, "aircraft");
});

test("all three quality profiles exist and are ordered by cost", () => {
  const p = QUALITY_PROFILES;
  assert.equal(p.performance.shadows, false, "performance mode should drop shadows");
  assert.ok(p.balanced.shadows && p.high.shadows);
  assert.ok(p.performance.pixelRatio < p.balanced.pixelRatio);
  assert.ok(p.balanced.pixelRatio < p.high.pixelRatio);
  assert.ok(p.performance.shadowMapSize < p.high.shadowMapSize);
  for (const q of Object.values(p)) assert.ok(q.description.length > 20, `${q.id} has no description`);
});

/* ───────────────────────── engine data ───────────────────────── */

test("all 11 engine components required by the brief are present", () => {
  const required = [
    "fan", "fan_casing", "lpc", "hpc", "combustor",
    "fuel", "hpt", "lpt", "nozzle", "shaft", "bearings",
  ];
  for (const id of required) {
    assert.ok(enginePartById(id), `missing engine component: ${id}`);
  }
  assert.ok(ENGINE_PARTS.length >= 11, `expected at least 11 parts, got ${ENGINE_PARTS.length}`);
});

test("every engine part carries full educational information", () => {
  for (const p of ENGINE_PARTS) {
    assert.ok(p.name.length > 2, `${p.id} has no name`);
    assert.ok(p.description.length > 80, `${p.id} description is too thin`);
    assert.ok(p.fn.length > 40, `${p.id} has no function text`);
    assert.ok(Object.keys(p.notes).length >= 3, `${p.id} needs engineering notes`);
    assert.ok(p.parent.length > 2, `${p.id} has no parent assembly`);
  }
});

test("engine parts are ordered correctly along the gas path", () => {
  const order = ["fan", "lpc", "hpc", "combustor", "hpt", "lpt", "nozzle"];
  for (let i = 1; i < order.length; i++) {
    const prev = enginePartById(order[i - 1])!;
    const cur = enginePartById(order[i])!;
    assert.ok(
      cur.axial > prev.axial,
      `${cur.id} (${cur.axial}) should sit downstream of ${prev.id} (${prev.axial})`,
    );
  }
});

test("engine part axial stations are all within the engine", () => {
  for (const p of ENGINE_PARTS) {
    assert.ok(p.axial >= 0 && p.axial <= 1, `${p.id} axial ${p.axial} is out of range`);
  }
});

test("the hierarchy groups parts into real spools and assemblies", () => {
  const h = engineHierarchy();
  assert.ok(h.size >= 3, "expected several assemblies");
  // The two-spool arrangement must be represented.
  assert.ok(h.has("Low-pressure spool"), "missing LP spool");
  assert.ok(h.has("High-pressure spool"), "missing HP spool");
  // The fan and LP turbine must be on the SAME spool — that is the whole point.
  assert.equal(enginePartById("fan")!.parent, enginePartById("lpt")!.parent);
  // HP compressor and HP turbine likewise.
  assert.equal(enginePartById("hpc")!.parent, enginePartById("hpt")!.parent);
  let total = 0;
  for (const parts of h.values()) total += parts.length;
  assert.equal(total, ENGINE_PARTS.length, "every part must appear exactly once");
});

test("casing parts are flagged so cutaway mode can hide them", () => {
  const casings = ENGINE_PARTS.filter((p) => p.casing);
  assert.ok(casings.length >= 2, "cutaway needs casings to remove");
  for (const id of ["fan_casing", "core_casing"]) {
    assert.ok(enginePartById(id)!.casing, `${id} should be a casing`);
  }
  // The rotating parts must NOT be hidden by cutaway.
  for (const id of ["fan", "hpc", "combustor", "hpt", "shaft"]) {
    assert.ok(!enginePartById(id)!.casing, `${id} must stay visible in cutaway`);
  }
});

test("the airflow path follows intake → fan → compressor → combustor → turbine → exhaust", () => {
  const labels = AIRFLOW_PATH.map((p) => p.label.toLowerCase());
  assert.match(labels[0], /intake/);
  assert.match(labels[1], /fan/);
  assert.match(labels[2], /compressor/);
  assert.match(labels[3], /combustion/);
  assert.match(labels[4], /turbine/);
  assert.match(labels[labels.length - 1], /exhaust/);
  for (let i = 1; i < AIRFLOW_PATH.length; i++) {
    assert.ok(AIRFLOW_PATH[i].at > AIRFLOW_PATH[i - 1].at, "airflow stations must advance");
  }
});

test("engine data contains NO fabricated performance figures", () => {
  // §6 forbids inventing thrust, pressure ratios, temperatures or stage counts.
  const text = ENGINE_PARTS.map((p) => `${p.description} ${p.fn} ${Object.values(p.notes).join(" ")}`).join(" ");
  const fabricated = [
    /\d+\s?kN/i, // thrust
    /\d+\s?°?C\b/i, // temperature
    /\d+\s?bar\b/i, // pressure
    /\d+:1\s?(pressure|overall)/i, // pressure ratio
    /\d+\s?rpm/i, // shaft speed
  ];
  for (const re of fabricated) {
    const m = text.match(re);
    assert.equal(m, null, `engine data must not state a specific ${re} figure, found "${m?.[0]}"`);
  }
});

/* ───────────────────────── engine geometry ───────────────────────── */

test("the engine builds real 3D geometry for every component", () => {
  const e = new EngineExplorer();
  e.build();
  assert.equal(e.isBuilt, true);
  assert.equal(e.nodes.size, ENGINE_PARTS.length);
  for (const [id, node] of e.nodes) {
    assert.ok(node.meshes.length > 0, `${id} has no meshes`);
    for (const m of node.meshes) {
      const pos = m.geometry.getAttribute("position");
      assert.ok(pos && pos.count >= 3, `${id} mesh has no vertices`);
      assert.equal(m.userData.enginePartId, id, `${id} mesh is not tagged for picking`);
    }
  }
  e.dispose();
});

test("the engine assembly spans a real volume with staged components", () => {
  const e = new EngineExplorer();
  e.build();
  const box = new THREE.Box3().setFromObject(e.root);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.x > 10, `engine should be long, got ${size.x}`);
  assert.ok(size.y > 4 && size.z > 4, "engine should have real diameter");

  // The fan must sit forward of the nozzle along +X.
  const fan = new THREE.Box3().setFromObject(e.nodes.get("fan")!.group).getCenter(new THREE.Vector3());
  const noz = new THREE.Box3().setFromObject(e.nodes.get("nozzle")!.group).getCenter(new THREE.Vector3());
  assert.ok(fan.x > noz.x, "the fan must be upstream of the nozzle");
  e.dispose();
});

test("engine explode separates parts and assemble restores them exactly", () => {
  const e = new EngineExplorer();
  e.build();
  const homes = new Map([...e.nodes].map(([id, n]) => [id, n.group.position.clone()]));

  e.explode();
  for (let i = 0; i < 400; i++) e.update(1 / 60, i / 60);
  assert.ok(e.explodeAmount > 0.99, `should fully explode, got ${e.explodeAmount}`);
  let moved = 0;
  for (const [id, n] of e.nodes) {
    if (n.group.position.distanceTo(homes.get(id)!) > 1) moved++;
  }
  assert.ok(moved >= ENGINE_PARTS.length - 1, `expected most parts to separate, only ${moved} did`);

  e.assemble();
  for (let i = 0; i < 600; i++) e.update(1 / 60, i / 60);
  for (const [id, n] of e.nodes) {
    assert.ok(
      n.group.position.distanceTo(homes.get(id)!) < 1e-3,
      `${id} did not return home`,
    );
  }
  assert.ok(e.isAssembled);
  e.dispose();
});

test("cutaway hides only the casings, never the internals", () => {
  const e = new EngineExplorer();
  e.build();
  e.setCutaway(true);
  assert.equal(e.isCutaway, true);
  for (const p of ENGINE_PARTS) {
    const visible = e.isVisible(p.id);
    assert.equal(visible, !p.casing, `${p.id} visibility wrong in cutaway`);
  }
  e.setCutaway(false);
  for (const p of ENGINE_PARTS) assert.ok(e.isVisible(p.id), `${p.id} should return after cutaway off`);
  e.dispose();
});

test("per-component visibility toggles independently of cutaway", () => {
  const e = new EngineExplorer();
  e.build();
  assert.equal(e.isVisible("fan"), true);
  e.toggleVisibility("fan");
  assert.equal(e.isVisible("fan"), false);
  assert.equal(e.isVisible("hpc"), true, "hiding one part must not hide others");
  e.showAll();
  assert.equal(e.isVisible("fan"), true);
  e.dispose();
});

test("picking only targets currently-visible engine parts", () => {
  const e = new EngineExplorer();
  e.build();
  const before = e.pickTargets.length;
  e.setCutaway(true);
  // After update() the visibility flags are applied to the groups.
  e.update(1 / 60, 0);
  assert.ok(e.pickTargets.length < before, "hidden casings must not be pickable");
  e.dispose();
});

test("isolating an engine part moves it clear and returning restores it", () => {
  const e = new EngineExplorer();
  e.build();
  const node = e.nodes.get("combustor")!;
  const home = node.group.position.clone();
  e.isolate("combustor");
  for (let i = 0; i < 400; i++) e.update(1 / 60, i / 60);
  assert.equal(e.isolatedId, "combustor");
  assert.ok(node.group.position.distanceTo(home) > 1, "isolated part must pull clear");
  e.isolate(null);
  for (let i = 0; i < 600; i++) e.update(1 / 60, i / 60);
  assert.equal(e.isolatedId, null);
  assert.ok(node.group.position.distanceTo(home) < 1e-3, "returned part must go home");
  e.dispose();
});

test("airflow can be toggled and hides itself when exploded", () => {
  const e = new EngineExplorer();
  e.build();
  assert.equal(e.isAirflowOn, true);
  e.update(1 / 60, 0);
  e.setAirflow(false);
  assert.equal(e.isAirflowOn, false);
  e.setAirflow(true);
  // When the engine explodes the arrows no longer describe anything useful.
  e.explode();
  for (let i = 0; i < 400; i++) e.update(1 / 60, i / 60);
  const airflow = e.root.children.find((c) => c.name === "engine:airflow");
  assert.equal(airflow?.visible, false, "airflow should hide while exploded");
  e.dispose();
});

test("disposing the engine releases its GPU resources", () => {
  const e = new EngineExplorer();
  e.build();
  let disposed = 0;
  for (const n of e.nodes.values()) {
    for (const m of n.meshes) {
      const orig = m.geometry.dispose.bind(m.geometry);
      m.geometry.dispose = () => {
        disposed++;
        orig();
      };
    }
  }
  e.dispose();
  assert.ok(disposed > 0, "geometries must be disposed");
  assert.equal(e.isBuilt, false);
  assert.equal(e.nodes.size, 0);
});

/* ───────────────────────── blueprint reconstruction ───────────────────────── */

test("reconstruction uses the user's dimensions, not invented ones", () => {
  const spec = reconstructedAircraft({ length: 40, span: 36, height: 12 });
  assert.equal(spec.profile.length, 40);
  assert.equal(spec.profile.wingSpan, 36);
  assert.match(spec.specs.Length, /40/);
  assert.match(spec.specs.Wingspan, /36/);
  assert.match(spec.specs.Length, /blueprint/i, "should attribute the figure to the blueprint");
});

test("reconstructed geometry is labelled as reconstructed, never imported", () => {
  const spec = reconstructedAircraft({ length: 40, span: 36, height: 12 });
  assert.match(spec.note, /RECONSTRUCTED/);
  assert.match(spec.note, /not a measured reproduction/i);
  assert.match(spec.category, /[Rr]econstructed/);
  assert.match(spec.specs.Geometry, /not imported/i);
});

test("reconstruction picks a sensible reference class from the proportions", () => {
  // A long, narrow-span aircraft should resemble the fighter/jet classes;
  // a wide-span one should resemble an airliner or freighter.
  const wide = reconstructedAircraft({ length: 53, span: 50, height: 16 });
  const narrow = reconstructedAircraft({ length: 17, span: 11, height: 5 });
  assert.notEqual(wide.specs["Reference class"], narrow.specs["Reference class"]);
});

test("reconstruction scales the whole airframe consistently", () => {
  const small = reconstructedAircraft({ length: 20, span: 18, height: 6 });
  const big = reconstructedAircraft({ length: 40, span: 36, height: 12 });
  assert.ok(big.profile.fuselageRadius > small.profile.fuselageRadius);
  assert.ok(big.profile.wingChord > small.profile.wingChord);
  assert.ok(big.profile.engineRadius > small.profile.engineRadius);
  // The span:length ratio the user supplied must be preserved exactly.
  assert.ok(Math.abs(big.profile.wingSpan / big.profile.length - 0.9) < 1e-9);
});

test("the measured height drives the fin, and stays positive", () => {
  for (const h of [4, 8, 12, 20]) {
    const spec = reconstructedAircraft({ length: 40, span: 36, height: h });
    assert.ok(spec.profile.tailHeight > 0, `height ${h} produced a non-positive fin`);
  }
});

/* ───────────────────────── gesture vocabulary ───────────────────────── */

test("the three new gestures are documented in the guide", () => {
  for (const id of ["pinch_drag", "swipe_left", "swipe_right"] as const) {
    const g = GESTURES[id];
    assert.ok(g, `${id} has no metadata`);
    assert.ok(g.how.length > 25, `${id} has no instructions`);
    assert.ok(GESTURE_SEQUENCE.includes(id), `${id} missing from the guide sequence`);
  }
});

test("all original gesture mappings are preserved", () => {
  // §7 requires the existing vocabulary to survive the upgrade unchanged.
  const original: Array<[string, RegExp]> = [
    ["open_palm", /explode/i],
    ["closed_fist", /assemble|reassemble/i],
    ["rotate", /rotate/i],
    ["pointing", /select/i],
    ["pinch", /pull out|grab/i],
    ["two_hand_zoom", /zoom/i],
    ["peace", /aircraft|mode/i],
    ["thumbs_up", /confirm/i],
  ];
  for (const [id, re] of original) {
    const g = GESTURES[id as keyof typeof GESTURES];
    assert.ok(g, `original gesture ${id} was removed`);
    assert.match(g.action, re, `${id} action changed unexpectedly: "${g.action}"`);
  }
});
