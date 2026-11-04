/**
 * Unit tests for the universal CAD format registry, segmentation and the
 * hand-only gesture guarantees.
 *
 * These are pure-logic tests: no DOM, no WebGL, no camera. Browser-only paths
 * (the actual parsers) are covered by the e2e suite with real files.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  ALL_EXTENSIONS,
  CAD_FORMATS,
  SUPPORT_TIERS,
  formatById,
  formatForExtension,
  tierCounts,
  type FormatStatus,
} from "../src/data/formats";
import {
  ConversionRequiredError,
  FileValidationError,
  detectFormat,
  sniff,
  validate,
} from "../src/modules/AircraftFileProcessor";
import { segmentConnectedShells } from "../src/modules/MeshSegmentation";
import { GESTURES, GESTURE_SEQUENCE } from "../src/modules/GestureRecognition";

const file = (name: string, size = 4096, type = ""): File => ({ name, size, type }) as File;

/* ───────────────────────── every requested extension ───────────────────────── */

/** Exactly the list from the brief (§1). */
const REQUIRED = [
  ".f3d", ".f3z",
  ".sldprt", ".sldasm", ".slddrw",
  ".dwg", ".dxf",
  ".step", ".stp",
  ".iges", ".igs",
  ".ipt", ".iam",
  ".catpart", ".catproduct", ".catdrawing",
  ".prt", ".asm",
  ".3dm",
  ".fcstd",
  ".x_t", ".x_b",
  ".stl", ".obj", ".3mf", ".amf", ".ply", ".fbx", ".3ds", ".dae",
  ".glb", ".gltf", ".jt", ".ifc",
  ".pdf", ".png", ".jpg", ".jpeg",
];

test("every extension requested in the brief is accepted by the picker", () => {
  const missing = REQUIRED.filter((e) => !ALL_EXTENSIONS.includes(e));
  assert.deepEqual(missing, [], `missing extensions: ${missing.join(", ")}`);
});

test("the file picker is not restricted to STL and GLB", () => {
  assert.ok(ALL_EXTENSIONS.length >= REQUIRED.length, `only ${ALL_EXTENSIONS.length} extensions`);
  // Spot-check a spread of vendors.
  for (const e of [".step", ".iges", ".3dm", ".ifc", ".dxf", ".fbx", ".sldprt", ".catpart"]) {
    assert.ok(ALL_EXTENSIONS.includes(e), `${e} must be accepted`);
  }
});

test("each extension maps to exactly one format", () => {
  const seen = new Map<string, string>();
  for (const f of CAD_FORMATS) {
    for (const e of f.extensions) {
      assert.equal(seen.get(e), undefined, `${e} claimed by both ${seen.get(e)} and ${f.id}`);
      seen.set(e, f.id);
    }
  }
});

test("every format declares a status, parser, vendor and user-facing note", () => {
  for (const f of CAD_FORMATS) {
    assert.ok(["full", "partial", "preview", "conversion"].includes(f.status), `${f.id} status`);
    assert.ok(f.vendor.length > 3, `${f.id} has no vendor`);
    assert.ok(f.note.length > 40, `${f.id} note too thin: "${f.note}"`);
    assert.ok(f.maxBytes > 1024 * 1024, `${f.id} size limit too small`);
    assert.ok(["mesh3d", "blueprint"].includes(f.kind), `${f.id} kind`);
  }
});

test("formats needing conversion declare no parser; loadable ones declare a real parser", () => {
  for (const f of CAD_FORMATS) {
    if (f.status === "conversion") {
      assert.equal(f.parser, "none", `${f.id} must not claim a parser`);
    } else {
      assert.notEqual(f.parser, "none", `${f.id} is marked ${f.status} but has no parser`);
    }
  }
});

test("every conversion-required format tells the user how to convert it", () => {
  for (const f of CAD_FORMATS.filter((x) => x.status === "conversion")) {
    assert.match(
      f.note,
      /STEP|STL|OBJ|DXF|glTF|BREP|PDF/i,
      `${f.id} must name a concrete export target`,
    );
  }
});

test("all four support tiers are populated and described", () => {
  const counts = tierCounts();
  for (const tier of ["full", "partial", "preview", "conversion"] as FormatStatus[]) {
    assert.ok(counts[tier] > 0, `tier ${tier} is empty`);
    assert.ok(SUPPORT_TIERS[tier].label.length > 3);
    assert.ok(SUPPORT_TIERS[tier].blurb.length > 30);
  }
});

/* ───────────────────────── identification ───────────────────────── */

test("each vendor's native format is identified by name", () => {
  const cases: Array<[string, RegExp]> = [
    ["wing.f3d", /Fusion/i],
    ["bracket.SLDPRT", /SolidWorks/i],
    ["assembly.sldasm", /SolidWorks/i],
    ["plan.dwg", /AutoCAD/i],
    ["shaft.ipt", /Inventor/i],
    ["frame.CATPart", /CATIA/i],
    ["housing.prt", /Creo/i],
    ["body.x_t", /Parasolid/i],
    ["viz.jt", /Siemens/i],
    ["doc.FCStd", /FreeCAD/i],
    ["hull.3dm", /Rhino/i],
    ["tower.ifc", /buildingSMART/i],
  ];
  for (const [name, vendor] of cases) {
    const spec = formatForExtension(name);
    assert.ok(spec, `${name} was not identified`);
    assert.match(spec!.vendor, vendor, `${name} → ${spec!.vendor}`);
  }
});

test("extension matching is case-insensitive", () => {
  for (const n of ["A.STEP", "a.Step", "a.sTp", "B.SLDPRT", "c.CatPart"]) {
    assert.ok(formatForExtension(n), `${n} should match`);
  }
});

test("longer extensions win over shorter prefixes", () => {
  assert.equal(formatForExtension("m.xmt_txt")?.id, "parasolid");
  assert.equal(formatForExtension("m.x_t")?.id, "parasolid");
});

test("MIME fallback identifies files with no usable extension", () => {
  assert.equal(detectFormat(file("blob", 10, "application/pdf"))?.id, "pdf");
  assert.equal(detectFormat(file("blob", 10, "model/gltf-binary"))?.id, "glb");
});

test("truly unknown formats are rejected with a helpful message", () => {
  assert.throws(
    () => validate(file("notes.xyz")),
    (e: FileValidationError) => {
      assert.equal(e.reason, "unsupported");
      assert.match(e.message, /not a recognised CAD or drawing format/i);
      assert.match(e.message, /\d+ extensions/, "should say how many it does accept");
      return true;
    },
  );
});

/* ───────────── the core honesty guarantee (§3, §7) ───────────── */

test("native CAD files raise ConversionRequired, NOT a fake success", () => {
  for (const name of ["a.f3d", "b.sldprt", "c.ipt", "d.CATPart", "e.prt", "f.x_b", "g.jt", "h.dwg", "i.FCStd"]) {
    assert.throws(
      () => validate(file(name)),
      (e: unknown) => {
        assert.ok(e instanceof ConversionRequiredError, `${name} should request conversion, got ${e}`);
        const err = e as ConversionRequiredError;
        assert.equal(err.spec.status, "conversion");
        assert.match(err.message, /cannot be opened directly in a browser/i);
        return true;
      },
      `${name} must not validate as loadable`,
    );
  }
});

test("ConversionRequiredError is distinct from a validation failure", () => {
  // The UI relies on this distinction to show guidance instead of an error.
  const conv = (() => {
    try {
      validate(file("x.sldprt"));
    } catch (e) {
      return e;
    }
  })();
  const bad = (() => {
    try {
      validate(file("x.zzz"));
    } catch (e) {
      return e;
    }
  })();
  assert.ok(conv instanceof ConversionRequiredError);
  assert.ok(bad instanceof FileValidationError);
  assert.ok(!(bad instanceof ConversionRequiredError));
});

test("loadable formats pass validation cleanly", () => {
  for (const name of [
    "a.step", "a.igs", "a.brep", "a.stl", "a.obj", "a.glb", "a.gltf",
    "a.ply", "a.3mf", "a.amf", "a.fbx", "a.dae", "a.3ds", "a.3dm",
    "a.ifc", "a.dxf", "a.pdf", "a.png", "a.jpg",
  ]) {
    const spec = validate(file(name));
    assert.notEqual(spec.status, "conversion", `${name} should be loadable`);
  }
});

test("size limits are enforced per format", () => {
  const stl = formatById("stl")!;
  assert.throws(
    () => validate(file("big.stl", stl.maxBytes + 1)),
    (e: FileValidationError) => e.reason === "too-large",
  );
  assert.doesNotThrow(() => validate(file("ok.stl", stl.maxBytes)));
});

/* ───────────────────────── magic-byte sniffing ───────────────────────── */

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

test("sniffing accepts the new formats' real signatures", () => {
  assert.ok(sniff("ply", bytesOf("ply\nformat ascii 1.0\n")));
  assert.ok(sniff("3dm", bytesOf("3D Geometry File Format 8.0")));
  assert.ok(sniff("fbx", bytesOf("Kaydara FBX Binary  \u0000")));
  assert.ok(sniff("dae", bytesOf('<?xml version="1.0"?><COLLADA xmlns="...">')));
  assert.ok(sniff("3mf", new Uint8Array([0x50, 0x4b, 0x03, 0x04])));
  assert.ok(sniff("amf", bytesOf('<?xml version="1.0"?><amf unit="millimeter">')));
  assert.ok(sniff("3ds", new Uint8Array([0x4d, 0x4d, 0x00, 0x01])));
  assert.ok(sniff("ifc", bytesOf("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));")));
});

test("sniffing still rejects renamed files for the new formats", () => {
  assert.equal(sniff("ply", bytesOf("not a ply file")), false);
  assert.equal(sniff("3dm", bytesOf("%PDF-1.7")), false);
  assert.equal(sniff("3mf", bytesOf("<html>")), false);
  assert.equal(sniff("fbx", new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
});

/* ───────────────────────── assisted segmentation (§4) ───────────────────────── */

function mergedBoxes(offsets: number[]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const o of offsets) {
    const g = new THREE.BoxGeometry(2, 2, 2).translate(o, 0, 0).toNonIndexed();
    const a = g.getAttribute("position");
    for (let i = 0; i < a.count; i++) pos.push(a.getX(i), a.getY(i), a.getZ(i));
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.computeVertexNormals();
  return merged;
}

test("a mesh of disjoint solids is split into one shell per solid", () => {
  const r = segmentConnectedShells(mergedBoxes([0, 10, 20, 30]));
  assert.equal(r.separable, true);
  assert.equal(r.shells.length, 4, `got ${r.shells.length} shells`);
  for (const s of r.shells) {
    assert.equal(s.getAttribute("position").count / 3, 12, "each box is 12 triangles");
  }
});

test("a single connected mesh is NEVER artificially subdivided", () => {
  for (const geo of [
    new THREE.SphereGeometry(1, 12, 8).toNonIndexed(),
    new THREE.BoxGeometry(1, 1, 1).toNonIndexed(),
    new THREE.TorusGeometry(2, 0.5, 8, 16).toNonIndexed(),
  ]) {
    const r = segmentConnectedShells(geo);
    assert.equal(r.separable, false, "a connected shell must stay one object");
    assert.equal(r.shells.length, 1);
    assert.match(r.reason, /single connected shell/i);
    assert.match(r.reason, /will not invent/i, "must state it does not fabricate parts");
  }
});

test("segmentation preserves total triangle count", () => {
  const src = mergedBoxes([0, 10, 20]);
  const before = src.getAttribute("position").count / 3;
  const r = segmentConnectedShells(src);
  const after = r.shells.reduce((a, s) => a + s.getAttribute("position").count / 3, 0);
  assert.equal(after, before, `lost triangles: ${before} → ${after}`);
});

test("segmentation preserves each shell's position in space", () => {
  const r = segmentConnectedShells(mergedBoxes([0, 40]));
  const centres = r.shells.map((s) => {
    s.computeBoundingBox();
    return s.boundingBox!.getCenter(new THREE.Vector3()).x;
  });
  centres.sort((a, b) => a - b);
  assert.ok(Math.abs(centres[0] - 0) < 0.01, `first shell at ${centres[0]}`);
  assert.ok(Math.abs(centres[1] - 40) < 0.01, `second shell at ${centres[1]}`);
});

test("tiny fragments are reported as debris rather than listed as parts", () => {
  const big = new THREE.SphereGeometry(5, 24, 16).toNonIndexed();
  const pos: number[] = [];
  const a = big.getAttribute("position");
  for (let i = 0; i < a.count; i++) pos.push(a.getX(i), a.getY(i), a.getZ(i));
  // One stray triangle far away.
  pos.push(100, 100, 100, 100.1, 100, 100, 100, 100.1, 100);
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));

  const r = segmentConnectedShells(merged);
  assert.equal(r.shells.length, 1, "the speck must not become a component");
  assert.match(r.reason, /fragment/i, "should explain the speck was dropped");
});

test("segmentation reports honestly that shells are unnamed", () => {
  const r = segmentConnectedShells(mergedBoxes([0, 10]));
  assert.match(r.reason, /not named parts|carries no names/i);
});

test("segmentation refuses meshes too large to process safely", () => {
  // Fake a huge geometry cheaply via a stubbed attribute count.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", {
    count: 5_000_000,
    getX: () => 0,
    getY: () => 0,
    getZ: () => 0,
    array: new Float32Array(0),
    itemSize: 3,
  } as unknown as THREE.BufferAttribute);
  const r = segmentConnectedShells(geo);
  assert.equal(r.separable, false);
  assert.match(r.reason, /too many to segment/i);
});

test("segmentation handles degenerate input without throwing", () => {
  const empty = new THREE.BufferGeometry();
  empty.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  assert.doesNotThrow(() => segmentConnectedShells(empty));
  assert.equal(segmentConnectedShells(empty).separable, false);
});

/* ───────────── hand-only recognition guarantees (§A) ───────────── */

test("the gesture vocabulary covers all twelve required gestures", () => {
  // The brief's 12 map onto this vocabulary; rotate covers "hand rotation",
  // two_hand_zoom covers both "hands apart" and "hands together".
  const required: Array<[string, RegExp]> = [
    ["open_palm", /explode/i],
    ["closed_fist", /assemble/i],
    ["pinch", /pull out|grab/i],
    ["pinch_drag", /move/i],
    ["pointing", /select/i],
    ["rotate", /rotate/i],
    ["two_hand_zoom", /zoom/i],
    ["swipe_left", /previous/i],
    ["swipe_right", /next/i],
    ["thumbs_up", /confirm/i],
    ["peace", /aircraft|mode/i],
  ];
  for (const [id, action] of required) {
    const g = GESTURES[id as keyof typeof GESTURES];
    assert.ok(g, `gesture ${id} is missing`);
    assert.match(g.action, action, `${id} action is "${g.action}"`);
    assert.ok(g.how.length > 25, `${id} has no instructions`);
  }
  assert.ok(GESTURE_SEQUENCE.length >= 11, `only ${GESTURE_SEQUENCE.length} documented`);
});

test("two-hand zoom is the only gesture requiring two hands", () => {
  const twoHanded = GESTURE_SEQUENCE.filter((id) => GESTURES[id].hands === 2);
  assert.deepEqual(twoHanded, ["two_hand_zoom"]);
});

test("no gesture metadata references faces, eyes, bodies or poses", () => {
  // §A: hand landmarks only. This guards against vocabulary drift.
  const text = Object.values(GESTURES)
    .map((g) => `${g.name} ${g.action} ${g.how}`)
    .join(" ")
    .toLowerCase();
  for (const banned of ["face", "eye", "nose", "mouth", "body pose", "skeleton pose", "full-body"]) {
    assert.ok(!text.includes(banned), `gesture copy must not mention "${banned}"`);
  }
});
