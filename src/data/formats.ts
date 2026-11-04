/**
 * Universal CAD format registry.
 *
 * HONESTY CONTRACT (§3, §7): every entry declares a `status` that reflects what
 * the app can ACTUALLY do in a browser, verified by test:
 *
 *   "full"       — a real parser extracts real geometry. Tested with real files.
 *   "partial"    — geometry loads, but something meaningful is lost (e.g. no
 *                  assembly tree, no materials, 2D only).
 *   "preview"    — the file is readable as a 2D reference only, never as 3D.
 *   "conversion" — the file picker accepts it and the app identifies it
 *                  correctly, but NO free browser parser exists. The app says
 *                  so and tells the user exactly how to convert it. It is never
 *                  reported as loaded.
 *
 * Nothing in the "conversion" tier is ever silently treated as a loaded model.
 */

export type FormatStatus = "full" | "partial" | "preview" | "conversion";

export type ParserId =
  | "occt-step"
  | "occt-iges"
  | "occt-brep"
  | "gltf"
  | "stl"
  | "obj"
  | "ply"
  | "fbx"
  | "collada"
  | "3mf"
  | "amf"
  | "3ds"
  | "rhino3dm"
  | "web-ifc"
  | "dxf"
  | "pdf"
  | "image"
  | "none";

export interface CadFormat {
  id: string;
  label: string;
  /** Originating software / standard, shown in the UI. */
  vendor: string;
  extensions: string[];
  mimes?: string[];
  status: FormatStatus;
  parser: ParserId;
  /** 3D geometry, a 2D reference drawing, or neither. */
  kind: "mesh3d" | "blueprint";
  maxBytes: number;
  /** Does the format itself carry an assembly/part hierarchy we can read? */
  hierarchy: boolean;
  /** Shown to the user — what to expect, or how to convert. */
  note: string;
}

const MB = 1024 * 1024;

export const CAD_FORMATS: CadFormat[] = [
  /* ───────── neutral CAD exchange — fully supported ───────── */
  {
    id: "step",
    label: "STEP",
    vendor: "ISO 10303 neutral exchange",
    extensions: [".step", ".stp"],
    mimes: ["application/step", "model/step"],
    status: "full",
    parser: "occt-step",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Parsed by OpenCascade (WASM). Real B-rep solids are tessellated in your browser; named solids and assembly structure are preserved where the exporter wrote them.",
  },
  {
    id: "iges",
    label: "IGES",
    vendor: "ANSI neutral exchange",
    extensions: [".iges", ".igs"],
    mimes: ["model/iges"],
    status: "full",
    parser: "occt-iges",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: false,
    note: "Parsed by OpenCascade (WASM). IGES is mostly surface-based, so you may get loose surfaces rather than closed solids, and it carries no real assembly tree.",
  },
  {
    id: "brep",
    label: "OpenCascade BREP",
    vendor: "OpenCascade / FreeCAD",
    extensions: [".brep", ".brp"],
    status: "full",
    parser: "occt-brep",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: false,
    note: "Native OpenCascade boundary-representation format, parsed directly by the same WASM kernel.",
  },

  /* ───────── mesh formats — fully supported ───────── */
  {
    id: "glb",
    label: "glTF binary",
    vendor: "Khronos",
    extensions: [".glb"],
    mimes: ["model/gltf-binary"],
    status: "full",
    parser: "gltf",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Self-contained glTF. Full node hierarchy, names and PBR materials are preserved.",
  },
  {
    id: "gltf",
    label: "glTF JSON",
    vendor: "Khronos",
    extensions: [".gltf"],
    mimes: ["model/gltf+json"],
    status: "partial",
    parser: "gltf",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Works when the file is self-contained. A .gltf that references external .bin or texture files cannot resolve them from a local selection — select those files together, or export a .glb instead.",
  },
  {
    id: "stl",
    label: "STL mesh",
    vendor: "Stereolithography / 3D printing",
    extensions: [".stl"],
    mimes: ["model/stl", "application/sla"],
    status: "partial",
    parser: "stl",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "STL stores only loose triangles — no names, no colours, no assembly. GestureFlight splits it into connected shells so separable parts can still be explored individually.",
  },
  {
    id: "obj",
    label: "OBJ mesh",
    vendor: "Wavefront",
    extensions: [".obj"],
    mimes: ["model/obj"],
    status: "partial",
    parser: "obj",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: true,
    note: "Object and group names are preserved. Materials in a companion .mtl are not fetched (that would require a network request), so a default metal is applied.",
  },
  {
    id: "ply",
    label: "PLY mesh",
    vendor: "Stanford / scanning",
    extensions: [".ply"],
    status: "full",
    parser: "ply",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "Common 3D-scan format. Geometry and per-vertex colours load; PLY has no assembly structure.",
  },
  {
    id: "3mf",
    label: "3MF",
    vendor: "3MF Consortium / 3D printing",
    extensions: [".3mf"],
    mimes: ["model/3mf"],
    status: "full",
    parser: "3mf",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Modern 3D-printing format. Object names, the build hierarchy and colours are preserved.",
  },
  {
    id: "amf",
    label: "AMF",
    vendor: "ASTM / 3D printing",
    extensions: [".amf"],
    status: "full",
    parser: "amf",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Additive-manufacturing format. Named objects and volumes are preserved.",
  },
  {
    id: "fbx",
    label: "FBX",
    vendor: "Autodesk interchange",
    extensions: [".fbx"],
    status: "partial",
    parser: "fbx",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: true,
    note: "Node hierarchy and names load. Binary FBX 7.x is well supported; very old ASCII FBX may fail. Embedded textures are not extracted.",
  },
  {
    id: "dae",
    label: "COLLADA",
    vendor: "Khronos interchange",
    extensions: [".dae"],
    mimes: ["model/vnd.collada+xml"],
    status: "partial",
    parser: "collada",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Scene graph and names load. Externally-referenced textures are not fetched.",
  },
  {
    id: "3ds",
    label: "3DS",
    vendor: "Autodesk 3ds Max (legacy)",
    extensions: [".3ds"],
    status: "partial",
    parser: "3ds",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Legacy format with a 16-bit vertex limit per mesh. Object names load; external texture maps do not.",
  },
  {
    id: "3dm",
    label: "Rhino 3DM",
    vendor: "Rhinoceros / McNeel",
    extensions: [".3dm"],
    status: "partial",
    parser: "rhino3dm",
    kind: "mesh3d",
    maxBytes: 150 * MB,
    hierarchy: true,
    note: "Parsed by rhino3dm (WASM). Objects that carry render meshes load with their layer names. Pure NURBS surfaces saved without a render mesh cannot be tessellated in the browser and are reported as skipped.",
  },
  {
    id: "ifc",
    label: "IFC (BIM)",
    vendor: "buildingSMART",
    extensions: [".ifc"],
    status: "partial",
    parser: "web-ifc",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: true,
    note: "Parsed by web-ifc (WASM). Building elements load with their IFC type and name. IFC is an architectural format, so aircraft-specific component naming does not apply.",
  },

  /* ───────── 2D drawings ───────── */
  {
    id: "dxf",
    label: "DXF drawing",
    vendor: "AutoCAD / neutral 2D",
    extensions: [".dxf"],
    mimes: ["image/vnd.dxf"],
    status: "partial",
    parser: "dxf",
    kind: "blueprint",
    maxBytes: 80 * MB,
    hierarchy: false,
    note: "DXF is a 2D drawing exchange format. GestureFlight renders its lines, arcs, circles and polylines as a blueprint reference you can measure and reconstruct from — it is not read as a 3D solid.",
  },
  {
    id: "pdf",
    label: "PDF drawing",
    vendor: "Adobe / drawing sheets",
    extensions: [".pdf"],
    mimes: ["application/pdf"],
    status: "preview",
    parser: "pdf",
    kind: "blueprint",
    maxBytes: 60 * MB,
    hierarchy: false,
    note: "Rendered page-by-page as a blueprint reference. 3D PDFs (PRC/U3D payloads) are not extracted — only the printed sheet is shown.",
  },
  {
    id: "png",
    label: "PNG image",
    vendor: "Raster blueprint",
    extensions: [".png"],
    mimes: ["image/png"],
    status: "preview",
    parser: "image",
    kind: "blueprint",
    maxBytes: 40 * MB,
    hierarchy: false,
    note: "Shown as a blueprint reference for the assisted reconstruction workflow.",
  },
  {
    id: "jpg",
    label: "JPEG image",
    vendor: "Raster blueprint",
    extensions: [".jpg", ".jpeg"],
    mimes: ["image/jpeg"],
    status: "preview",
    parser: "image",
    kind: "blueprint",
    maxBytes: 40 * MB,
    hierarchy: false,
    note: "Shown as a blueprint reference for the assisted reconstruction workflow.",
  },

  /* ───────── native CAD — identified, but require conversion ─────────
     These are proprietary, undocumented container formats. No free
     browser-side parser exists for any of them (verified). The picker accepts
     them so the app can identify the file and tell the user precisely how to
     convert it — it NEVER pretends the model loaded. */
  {
    id: "f3d",
    label: "Fusion 360 archive",
    vendor: "Autodesk Fusion 360",
    extensions: [".f3d", ".f3z"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "Fusion 360's native archive is proprietary and has no free browser parser. In Fusion: File → Export → choose STEP (.step) or Mesh (.stl / .obj), then upload that. Fusion 360 Personal can export STEP for free.",
  },
  {
    id: "sldprt",
    label: "SolidWorks part/assembly",
    vendor: "Dassault SolidWorks",
    extensions: [".sldprt", ".sldasm", ".slddrw"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "SolidWorks' native format is proprietary with no free browser parser. In SolidWorks: File → Save As → STEP AP214 (.step), which preserves the assembly tree. Free alternative: open it in FreeCAD and export STEP.",
  },
  {
    id: "ipt",
    label: "Inventor part/assembly",
    vendor: "Autodesk Inventor",
    extensions: [".ipt", ".iam"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "Inventor's native format is proprietary with no free browser parser. In Inventor: File → Export → CAD Format → STEP (.stp). FreeCAD can also convert IPT files to STEP for free.",
  },
  {
    id: "catpart",
    label: "CATIA part/product",
    vendor: "Dassault CATIA",
    extensions: [".catpart", ".catproduct", ".catdrawing"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "CATIA's native format is proprietary with no free browser parser. In CATIA: File → Save As → STEP. FreeCAD can open many CATPart files and export STEP for free.",
  },
  {
    id: "creo",
    label: "Creo part/assembly",
    vendor: "PTC Creo / Pro-E",
    extensions: [".prt", ".asm"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "Creo's native format is proprietary with no free browser parser, and the .prt/.asm extensions are shared with other systems. In Creo: File → Save As → STEP (.stp).",
  },
  {
    id: "parasolid",
    label: "Parasolid",
    vendor: "Siemens Parasolid kernel",
    extensions: [".x_t", ".x_b", ".xmt_txt", ".xmt_bin"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "Parasolid is a licensed commercial kernel with no free browser parser. Export STEP from the originating CAD system, or convert with FreeCAD, to upload here.",
  },
  {
    id: "jt",
    label: "JT visualisation",
    vendor: "Siemens JT (ISO 14306)",
    extensions: [".jt"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "JT is an ISO standard, but its free tooling is desktop-only — there is no maintained browser parser. Convert to STEP or glTF with Siemens JT2Go or FreeCAD, then upload.",
  },
  {
    id: "dwg",
    label: "AutoCAD drawing",
    vendor: "Autodesk AutoCAD",
    extensions: [".dwg"],
    status: "conversion",
    parser: "none",
    kind: "blueprint",
    maxBytes: 100 * MB,
    hierarchy: false,
    note: "DWG is a proprietary binary format whose only browser parsers are GPL-3.0 (incompatible with this MIT project) or paid. In AutoCAD: Save As → DXF, or print to PDF — both upload here and work as blueprint references.",
  },
  {
    id: "fcstd",
    label: "FreeCAD document",
    vendor: "FreeCAD",
    extensions: [".fcstd"],
    status: "conversion",
    parser: "none",
    kind: "mesh3d",
    maxBytes: 200 * MB,
    hierarchy: false,
    note: "An .FCStd is a ZIP containing an OpenCascade BREP payload, but its internal layout is version-specific and not a stable parse target. In FreeCAD: File → Export → STEP or BREP — both are fully supported here.",
  },
];

/** Every extension the file picker accepts (§1). */
export const ALL_EXTENSIONS: string[] = CAD_FORMATS.flatMap((f) => f.extensions);

export const ACCEPT_ATTRIBUTE: string = ALL_EXTENSIONS.join(",");

/** Formats that genuinely load geometry or a reference, grouped for the UI. */
export const SUPPORT_TIERS: Record<FormatStatus, { label: string; blurb: string }> = {
  full: {
    label: "Fully Supported",
    blurb: "Real geometry is extracted in your browser, with names and structure where the format carries them.",
  },
  partial: {
    label: "Partially Supported",
    blurb: "Geometry loads, but something the format cannot carry is missing — see each format's note.",
  },
  preview: {
    label: "Preview Only",
    blurb: "Shown as a 2D blueprint reference. Use assisted reconstruction to build 3D from it.",
  },
  conversion: {
    label: "Requires Conversion",
    blurb: "Identified correctly, but no free browser parser exists. Export STEP (or STL/OBJ) from your CAD system — the app tells you exactly how.",
  },
};

export function formatForExtension(filename: string): CadFormat | null {
  const lower = filename.toLowerCase();
  // Longest extension first, so ".xmt_txt" beats ".x_t"-style prefixes.
  const sorted = [...CAD_FORMATS].sort(
    (a, b) => Math.max(...b.extensions.map((e) => e.length)) - Math.max(...a.extensions.map((e) => e.length)),
  );
  for (const f of sorted) {
    if (f.extensions.some((e) => lower.endsWith(e))) return f;
  }
  return null;
}

export function formatById(id: string): CadFormat | undefined {
  return CAD_FORMATS.find((f) => f.id === id);
}

/** Counts for the UI summary line. */
export function tierCounts(): Record<FormatStatus, number> {
  const out: Record<FormatStatus, number> = { full: 0, partial: 0, preview: 0, conversion: 0 };
  for (const f of CAD_FORMATS) out[f.status]++;
  return out;
}
