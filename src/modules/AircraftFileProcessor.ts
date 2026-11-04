/**
 * AircraftFileProcessor — validates and parses user-uploaded aircraft designs.
 *
 * PRIVACY (§12): every byte is read with FileReader/ArrayBuffer and parsed in
 * this tab. Nothing is uploaded, no network request is made, no cloud service
 * and no AI API is involved. Object URLs are tracked and revoked on dispose().
 *
 * FORMAT HONESTY (§2, §15.11): a format is only reported as loaded when real
 * geometry came out of the parser. STEP is parsed by occt-import-js (an
 * OpenCascade WASM build) and verified against real STEP files; when any parser
 * fails the processor returns a structured error instead of a placeholder.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  ALL_EXTENSIONS,
  CAD_FORMATS,
  formatForExtension,
  type CadFormat,
  type FormatStatus,
} from "../data/formats";
import { segmentConnectedShells } from "./MeshSegmentation";

export type UploadKind = "mesh3d" | "blueprint";

export type UploadFormat =
  | "step"
  | "stl"
  | "obj"
  | "glb"
  | "gltf"
  | "pdf"
  | "png"
  | "jpg";

/** Where a piece of geometry in the scene actually came from (§2, §9). */
export type GeometrySource =
  | "imported" // real geometry from the user's file
  | "reconstructed" // built by the assisted blueprint workflow from user input
  | "illustrative"; // app-generated teaching geometry, clearly labelled

/**
 * FormatSpec is now an alias of the universal CadFormat registry in
 * data/formats.ts, so the processor, the file picker and the UI all agree on a
 * single source of truth for what is accepted and what it can actually do.
 */
export type FormatSpec = CadFormat;

export { CAD_FORMATS as FORMATS, ACCEPT_ATTRIBUTE } from "../data/formats";

/** The eight pipeline stages reported to the UI (§3). */
export const STAGES = [
  "File validation",
  "Format detection",
  "Geometry extraction",
  "Structure identification",
  "3D scene generation",
  "Materials and lighting",
  "Component identification",
  "Interactive visualisation",
] as const;

export type StageName = (typeof STAGES)[number];

export interface ProgressReport {
  stage: StageName;
  stageIndex: number;
  /** 0..1 within the whole pipeline. */
  progress: number;
  detail: string;
}

export interface ImportedPart {
  id: string;
  /** Name as it appeared in the file, when the format carries one. */
  name: string;
  object: THREE.Object3D;
  triangles: number;
  /** True when the file itself named this part (vs. a synthesised index). */
  namedInFile: boolean;
}

export interface MeshImportResult {
  kind: "mesh3d";
  format: string;
  root: THREE.Group;
  parts: ImportedPart[];
  triangles: number;
  vertices: number;
  /** Bounding box size in the file's own units. */
  size: THREE.Vector3;
  /** True when the file provided more than one distinct named object. */
  hasSeparateComponents: boolean;
  /** Explanation from assisted segmentation, when it ran (§4). */
  segmentationNote?: string;
  /** Anything the parser had to skip, reported rather than hidden. */
  parserNote?: string;
  /** The registry support tier this format was loaded under. */
  status: FormatStatus;
  /** Units are only known for formats that record them; usually they are not. */
  unitsKnown: boolean;
  source: GeometrySource;
  dispose: () => void;
}

export interface BlueprintPage {
  index: number;
  width: number;
  height: number;
  /** Canvas holding the rendered page/image, kept in memory only. */
  canvas: HTMLCanvasElement;
  /** Heuristic guess at which orthographic view this page shows. */
  viewGuess: "top" | "side" | "front" | "unknown";
  /** Why the heuristic chose that, shown to the user so it is not a black box. */
  viewReason: string;
  /** Parser-level note (e.g. which DXF entity types were not drawn). */
  sourceNote?: string;
}

export interface BlueprintImportResult {
  kind: "blueprint";
  format: string;
  pages: BlueprintPage[];
  dispose: () => void;
}

export type ImportResult = MeshImportResult | BlueprintImportResult;

export class FileValidationError extends Error {
  constructor(
    message: string,
    readonly reason: "unsupported" | "too-large" | "empty" | "corrupt",
  ) {
    super(message);
    this.name = "FileValidationError";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function detectFormat(file: File): FormatSpec | null {
  const byExt = formatForExtension(file.name);
  if (byExt) return byExt;
  // Fall back to MIME only when the extension is missing or unknown.
  if (file.type) {
    for (const spec of CAD_FORMATS) {
      if (spec.mimes?.includes(file.type)) return spec;
    }
  }
  return null;
}

/**
 * Raised for a correctly-identified native CAD file that no free browser parser
 * can open (§3). This is NOT a validation failure — the format is recognised, and
 * the message tells the user exactly how to convert it. It is a distinct type so
 * the UI can present it as guidance rather than as a rejection.
 */
export class ConversionRequiredError extends Error {
  constructor(
    readonly spec: FormatSpec,
    readonly filename: string,
  ) {
    super(`${spec.label} (${spec.vendor}) cannot be opened directly in a browser. ${spec.note}`);
    this.name = "ConversionRequiredError";
  }
}

export function validate(file: File): FormatSpec {
  const spec = detectFormat(file);
  if (!spec) {
    const shown = CAD_FORMATS.slice(0, 10).map((f) => f.extensions[0]).join(", ");
    throw new FileValidationError(
      `"${file.name}" is not a recognised CAD or drawing format. GestureFlight accepts ${ALL_EXTENSIONS.length} extensions including ${shown} and more — see the supported-formats list in the upload panel.`,
      "unsupported",
    );
  }
  if (file.size === 0) {
    throw new FileValidationError(`"${file.name}" is empty (0 bytes).`, "empty");
  }
  if (file.size > spec.maxBytes) {
    throw new FileValidationError(
      `"${file.name}" is ${formatBytes(file.size)}, over the ${formatBytes(spec.maxBytes)} limit for ${spec.label} files.`,
      "too-large",
    );
  }
  // Identified correctly, but honestly unopenable in a browser (§3).
  if (spec.status === "conversion") {
    throw new ConversionRequiredError(spec, file.name);
  }
  return spec;
}

/* ───────────────────────── magic-byte sniffing ───────────────────────── */

/**
 * Confirms the bytes match the claimed format, so a renamed or corrupt file is
 * rejected with a real reason rather than producing an empty scene.
 */
export function sniff(format: string, bytes: Uint8Array): boolean {
  const ascii = (n: number) => new TextDecoder().decode(bytes.subarray(0, n));
  switch (format) {
    case "pdf":
      return ascii(5).startsWith("%PDF-");
    case "png":
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case "jpg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "glb":
      return ascii(4) === "glTF";
    case "gltf":
      return ascii(600).trimStart().startsWith("{");
    case "step":
      return /ISO-10303-21/i.test(ascii(2048));
    case "stl": {
      // Binary STL: 80-byte header + uint32 triangle count that matches length.
      if (bytes.length >= 84) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const tris = dv.getUint32(80, true);
        if (84 + tris * 50 === bytes.length) return true;
      }
      return /^\s*solid/i.test(ascii(512));
    }
    case "obj":
      return /^\s*(v|vn|vt|f|g|o|mtllib|usemtl|#)\s/m.test(ascii(4096));
    case "iges":
      // IGES is column-formatted: a Start/Global record ends column 73 with S/G.
      return /^.{72}[SG]\s*\d/m.test(ascii(4096)) || /\bS\s*0*1\s*$/m.test(ascii(1024));
    case "brep":
      return /^\s*(DBRep_DrawableShape|CASCADE Topology)/.test(ascii(256));
    case "ply":
      return /^ply\s/.test(ascii(16));
    case "3mf":
      // 3MF is a ZIP container (OPC).
      return bytes[0] === 0x50 && bytes[1] === 0x4b;
    case "amf":
      // AMF is XML, or a ZIP-compressed XML.
      return /<\s*amf/i.test(ascii(2048)) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
    case "fbx":
      return ascii(20).startsWith("Kaydara FBX Binary") || /FBXHeaderExtension/.test(ascii(2048));
    case "dae":
      return /<\s*COLLADA/i.test(ascii(4096));
    case "3ds":
      // Primary chunk id 0x4D4D followed by the file length.
      return bytes[0] === 0x4d && bytes[1] === 0x4d;
    case "3dm":
      return ascii(32).startsWith("3D Geometry File Format");
    case "ifc":
      return /ISO-10303-21/i.test(ascii(2048)) && /IFC/i.test(ascii(4096));
    case "dxf":
      return /\bSECTION\b/.test(ascii(4096)) || /^\s*0\s/.test(ascii(64)) || bytes[0] === 0x41;
    default:
      return true;
  }
}

/* ───────────────────────── the processor ───────────────────────── */

export class AircraftFileProcessor {
  private objectUrls = new Set<string>();
  private occt: import("occt-import-js").OcctModule | null = null;

  /**
   * Parses a validated file into either real 3D geometry or blueprint pages.
   * `onProgress` is driven through the eight pipeline stages (§3).
   */
  async process(
    file: File,
    spec: FormatSpec,
    onProgress: (r: ProgressReport) => void,
  ): Promise<ImportResult> {
    const stage = (name: StageName, detail: string, within = 0) => {
      const i = STAGES.indexOf(name);
      onProgress({
        stage: name,
        stageIndex: i,
        progress: (i + Math.min(1, Math.max(0, within))) / STAGES.length,
        detail,
      });
    };

    stage("File validation", `${spec.label} · ${formatBytes(file.size)}`, 1);
    await frame();

    stage("Format detection", `Checking ${spec.id.toUpperCase()} signature`, 0.5);
    const buffer = await readArrayBuffer(file, (p) =>
      stage("Format detection", `Reading file… ${Math.round(p * 100)}%`, p),
    );
    const bytes = new Uint8Array(buffer);
    if (!sniff(spec.id, bytes)) {
      throw new FileValidationError(
        `"${file.name}" does not contain valid ${spec.label} data. The file may be corrupt or renamed from another format.`,
        "corrupt",
      );
    }
    stage("Format detection", `Verified ${spec.label}`, 1);
    await frame();

    if (spec.kind === "blueprint") {
      return this.processBlueprint(file, spec, bytes, stage);
    }
    return this.processMesh(file, spec, buffer, stage);
  }

  /* ───────── 3D geometry ───────── */

  private async processMesh(
    file: File,
    spec: FormatSpec,
    buffer: ArrayBuffer,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<MeshImportResult> {
    stage("Geometry extraction", `Parsing ${spec.label}…`, 0.1);
    await frame();

    let root: THREE.Group;
    // Dispatch on the registry's declared parser, so adding a format is a
    // data change plus one case rather than scattered special-casing.
    switch (spec.parser) {
      case "gltf":
        root = await this.loadGltf(buffer, file.name, stage);
        break;
      case "stl":
        root = this.loadStl(buffer);
        break;
      case "obj":
        root = this.loadObj(buffer);
        break;
      case "occt-step":
      case "occt-iges":
      case "occt-brep":
        root = await this.loadOcct(buffer, spec, stage);
        break;
      case "ply":
        root = await this.loadWithJsmLoader(buffer, "PLYLoader", stage);
        break;
      case "fbx":
        root = await this.loadWithJsmLoader(buffer, "FBXLoader", stage);
        break;
      case "collada":
        root = await this.loadWithJsmLoader(buffer, "ColladaLoader", stage);
        break;
      case "3mf":
        root = await this.loadWithJsmLoader(buffer, "ThreeMFLoader", stage);
        break;
      case "amf":
        root = await this.loadWithJsmLoader(buffer, "AMFLoader", stage);
        break;
      case "3ds":
        root = await this.loadWithJsmLoader(buffer, "TDSLoader", stage);
        break;
      case "rhino3dm":
        root = await this.loadRhino(buffer, stage);
        break;
      case "web-ifc":
        root = await this.loadIfc(buffer, stage);
        break;
      default:
        throw new FileValidationError(
          `No browser parser is wired up for ${spec.label}. ${spec.note}`,
          "unsupported",
        );
    }

    stage("Structure identification", "Collecting meshes and names", 0.3);
    await frame();

    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) meshes.push(m);
    });
    if (meshes.length === 0) {
      throw new FileValidationError(
        `"${file.name}" parsed successfully but contains no renderable geometry. It may hold only curves, annotations or empty assemblies.`,
        "corrupt",
      );
    }

    let triangles = 0;
    let vertices = 0;
    for (const m of meshes) {
      const pos = m.geometry.getAttribute("position");
      vertices += pos?.count ?? 0;
      triangles += m.geometry.index ? m.geometry.index.count / 3 : (pos?.count ?? 0) / 3;
      if (!m.geometry.getAttribute("normal")) m.geometry.computeVertexNormals();
      m.castShadow = true;
      m.receiveShadow = true;
    }

    // ASSISTED SEGMENTATION (§4): when the file gave us exactly one mesh and no
    // names — the STL case — try to recover separable parts geometrically by
    // splitting into connected shells. This only ever reports what it can
    // prove: a single connected shell stays one object.
    let segmentationNote: string | undefined;
    if (!spec.hierarchy && meshes.length === 1) {
      stage("Structure identification", "Looking for separable parts…", 0.4);
      await frame();
      const seg = segmentConnectedShells(meshes[0].geometry);
      segmentationNote = seg.reason;
      if (seg.separable && seg.shells.length > 1) {
        const source = meshes[0];
        const material = source.material;
        const parent = source.parent ?? root;
        parent.remove(source);
        source.geometry.dispose();
        meshes.length = 0;
        seg.shells.forEach((shellGeo, i) => {
          const shell = new THREE.Mesh(shellGeo, material);
          shell.name = `Part ${i + 1}`;
          shell.castShadow = true;
          shell.receiveShadow = true;
          parent.add(shell);
          meshes.push(shell);
        });
      }
    }

    // Group into logical parts. Only treat a part as "named in file" when the
    // format actually gave it a name — we never fabricate component identity.
    const parts: ImportedPart[] = [];
    const topLevel = collectPartRoots(root);
    topLevel.forEach((obj, i) => {
      let tris = 0;
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) {
          const pos = m.geometry.getAttribute("position");
          tris += m.geometry.index ? m.geometry.index.count / 3 : (pos?.count ?? 0) / 3;
        }
      });
      const named = !!obj.name && !/^(object_?\d*|mesh_?\d*|untitled)$/i.test(obj.name);
      parts.push({
        id: `part-${i}`,
        name: named ? obj.name : `Part ${i + 1}`,
        object: obj,
        triangles: Math.round(tris),
        namedInFile: named,
      });
    });

    stage("3D scene generation", "Normalising and centring", 0.6);
    await frame();

    // Centre on the origin and normalise scale for the viewport WITHOUT
    // distorting the geometry: one uniform scale, no per-axis stretching (§4).
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    root.position.sub(centre);

    const wrapper = new THREE.Group();
    wrapper.name = `upload:${file.name}`;
    wrapper.add(root);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    wrapper.scale.setScalar(16 / maxDim);

    stage("Materials and lighting", "Applying aerospace materials", 0.8);
    await frame();
    // glTF carries its own PBR materials; give the others a sensible metal.
    if (spec.id !== "glb" && spec.id !== "gltf") {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xc8d4de,
        metalness: 0.58,
        roughness: 0.36,
        side: THREE.DoubleSide,
      });
      for (const m of meshes) m.material = mat;
    }

    stage("Component identification", `${parts.length} object(s) found`, 0.9);
    await frame();
    stage("Interactive visualisation", "Ready", 1);

    const hasSeparateComponents = parts.length > 1;

    return {
      kind: "mesh3d",
      format: spec.id,
      root: wrapper,
      parts,
      triangles: Math.round(triangles),
      vertices,
      size,
      hasSeparateComponents,
      segmentationNote,
      parserNote: (root.userData.skippedNote as string | undefined) ?? undefined,
      status: spec.status,
      // No format here reliably records real-world units for an arbitrary file;
      // we say so rather than printing a fabricated wingspan (§9).
      unitsKnown: false,
      source: "imported",
      dispose: () => disposeTree(wrapper),
    };
  }

  private async loadGltf(
    buffer: ArrayBuffer,
    name: string,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<THREE.Group> {
    const loader = new GLTFLoader();
    // Resolve any external .bin/texture siblings relative to the blob, which is
    // all a local .gltf can do without the user also supplying those files.
    const url = URL.createObjectURL(new Blob([buffer]));
    this.objectUrls.add(url);
    stage("Geometry extraction", "Decoding glTF nodes", 0.4);
    try {
      const gltf = await loader.parseAsync(buffer, "");
      return gltf.scene as THREE.Group;
    } catch (e) {
      throw new FileValidationError(
        `Could not decode "${name}": ${(e as Error).message}. External .bin or texture files referenced by a .gltf must be embedded — use a self-contained .glb instead.`,
        "corrupt",
      );
    }
  }

  private loadStl(buffer: ArrayBuffer): THREE.Group {
    const geo = new STLLoader().parse(buffer);
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = "STL mesh";
    g.add(mesh);
    return g;
  }

  private loadObj(buffer: ArrayBuffer): THREE.Group {
    const text = new TextDecoder().decode(buffer);
    // OBJLoader resolves `mtllib` over the network; we never do that, so the
    // directive is stripped and a default material is applied instead.
    return new OBJLoader().parse(text.replace(/^\s*mtllib .*$/gim, ""));
  }

  /**
   * STEP / IGES / BREP via occt-import-js (OpenCascade WASM, LGPL-2.1 with the
   * Open CASCADE exception; the .wasm ships unmodified as a separate asset and
   * is credited in the README and About panel).
   *
   * VERIFIED against real STEP and IGES files before shipping — this returns
   * genuine triangulated B-rep geometry with normals, not a placeholder.
   */
  private async loadOcct(
    buffer: ArrayBuffer,
    spec: FormatSpec,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<THREE.Group> {
    stage("Geometry extraction", "Loading OpenCascade (WASM)…", 0.2);
    if (!this.occt) {
      const mod = await import("occt-import-js");
      const factory = mod.default ?? (mod as unknown as typeof mod.default);
      this.occt = await factory({
        locateFile: (f: string) => `${import.meta.env.BASE_URL}occt/${f}`,
      });
    }

    stage("Geometry extraction", `Tessellating ${spec.label} geometry…`, 0.45);
    await frame();

    const bytes = new Uint8Array(buffer);
    const occt = this.occt!;
    const result =
      spec.parser === "occt-iges"
        ? occt.ReadIgesFile!(bytes, null)
        : spec.parser === "occt-brep"
          ? occt.ReadBrepFile!(bytes, null)
          : occt.ReadStepFile(bytes, null);

    if (!result.success || !result.meshes?.length) {
      throw new FileValidationError(
        `OpenCascade could not extract geometry from this ${spec.label} file. It may use an unsupported schema, contain only wireframe or annotation entities, or be corrupt.`,
        "corrupt",
      );
    }

    const group = new THREE.Group();
    group.name = `${spec.label} assembly`;
    for (const m of result.meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(m.attributes.position.array, 3),
      );
      if (m.attributes.normal) {
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
      }
      if (m.index) geo.setIndex(Array.from(m.index.array));
      if (!m.attributes.normal) geo.computeVertexNormals();

      const colour = m.color
        ? new THREE.Color(m.color[0], m.color[1], m.color[2])
        : new THREE.Color(0xc8d4de);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: colour, metalness: 0.55, roughness: 0.38 }),
      );
      mesh.name = m.name || `${spec.label} solid`;
      group.add(mesh);
    }
    return group;
  }

  /**
   * Shared path for the Three.js addon loaders (PLY, FBX, COLLADA, 3MF, AMF,
   * 3DS). Each is dynamically imported so its code is only downloaded when a
   * file of that type is actually opened.
   */
  private async loadWithJsmLoader(
    buffer: ArrayBuffer,
    loaderName: string,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<THREE.Group> {
    stage("Geometry extraction", `Decoding with ${loaderName}…`, 0.35);
    await frame();

    interface ParsingLoader {
      parse(data: ArrayBuffer | string, path?: string): unknown;
    }
    let loader: ParsingLoader;
    switch (loaderName) {
      case "PLYLoader":
        loader = new (await import("three/examples/jsm/loaders/PLYLoader.js")).PLYLoader() as unknown as ParsingLoader;
        break;
      case "FBXLoader":
        loader = new (await import("three/examples/jsm/loaders/FBXLoader.js")).FBXLoader() as unknown as ParsingLoader;
        break;
      case "ColladaLoader":
        loader = new (await import("three/examples/jsm/loaders/ColladaLoader.js")).ColladaLoader() as unknown as ParsingLoader;
        break;
      case "ThreeMFLoader":
        loader = new (await import("three/examples/jsm/loaders/3MFLoader.js")).ThreeMFLoader() as unknown as ParsingLoader;
        break;
      case "AMFLoader":
        loader = new (await import("three/examples/jsm/loaders/AMFLoader.js")).AMFLoader() as unknown as ParsingLoader;
        break;
      case "TDSLoader":
        loader = new (await import("three/examples/jsm/loaders/TDSLoader.js")).TDSLoader() as unknown as ParsingLoader;
        break;
      default:
        throw new FileValidationError(`Unknown loader ${loaderName}.`, "unsupported");
    }

    let parsed: unknown;
    try {
      // COLLADA takes text; the rest take the raw buffer.
      parsed =
        loaderName === "ColladaLoader"
          ? loader.parse(new TextDecoder().decode(buffer), "")
          : loader.parse(buffer, "");
    } catch (e) {
      throw new FileValidationError(
        `${loaderName} could not decode this file: ${(e as Error).message}`,
        "corrupt",
      );
    }

    // PLY returns a BufferGeometry; COLLADA returns { scene }; others Object3D.
    if (parsed instanceof THREE.BufferGeometry) {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(
        parsed,
        new THREE.MeshStandardMaterial({
          vertexColors: !!parsed.getAttribute("color"),
          color: parsed.getAttribute("color") ? 0xffffff : 0xc8d4de,
          metalness: 0.4,
          roughness: 0.5,
        }),
      );
      mesh.name = `${loaderName.replace("Loader", "")} mesh`;
      g.add(mesh);
      return g;
    }
    const scene = (parsed as { scene?: THREE.Object3D }).scene ?? (parsed as THREE.Object3D);
    if (scene instanceof THREE.Group) return scene;
    const wrap = new THREE.Group();
    wrap.add(scene as THREE.Object3D);
    return wrap;
  }

  /**
   * Rhino .3dm via rhino3dm (WASM, MIT). Objects carrying a render mesh are
   * converted; pure NURBS saved without one cannot be tessellated here, and are
   * counted and reported rather than silently dropped.
   */
  private async loadRhino(
    buffer: ArrayBuffer,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<THREE.Group> {
    stage("Geometry extraction", "Loading rhino3dm (WASM)…", 0.25);
    const rhino3dm = (await import("rhino3dm")).default;
    // Serve the WASM from our own origin — no CDN (§6).
    const rhino = await rhino3dm({
      locateFile: (f: string) => `${import.meta.env.BASE_URL}rhino/${f}`,
    } as never);
    stage("Geometry extraction", "Reading Rhino objects…", 0.5);
    await frame();

    const doc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
    if (!doc) {
      throw new FileValidationError("rhino3dm could not open this .3dm file.", "corrupt");
    }

    const group = new THREE.Group();
    group.name = "Rhino document";
    const objects = doc.objects();
    let skipped = 0;

    for (let i = 0; i < objects.count; i++) {
      const obj = objects.get(i);
      const geom = obj?.geometry() as unknown as { toThreejsJSON?: () => unknown } | null;
      if (!geom) continue;
      const json = geom.toThreejsJSON?.();
      if (!json) {
        // NURBS / curves with no render mesh cannot be drawn in the browser.
        skipped++;
        continue;
      }
      try {
        const data = json as {
          data?: {
            attributes?: Record<string, { array: number[]; itemSize: number }>;
            index?: { array: number[] };
          };
        };
        const attrs = data.data?.attributes;
        if (!attrs?.position) {
          skipped++;
          continue;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(attrs.position.array, 3));
        if (attrs.normal) {
          geo.setAttribute("normal", new THREE.Float32BufferAttribute(attrs.normal.array, 3));
        }
        if (data.data?.index) geo.setIndex(Array.from(data.data.index.array));
        if (!attrs.normal) geo.computeVertexNormals();

        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({ color: 0xc8d4de, metalness: 0.5, roughness: 0.4 }),
        );
        const attr = obj?.attributes() as unknown as { name?: string } | null;
        mesh.name = attr?.name || `Rhino object ${i + 1}`;
        group.add(mesh);
      } catch {
        skipped++;
      }
    }
    // (rhino3dm frees the document when it goes out of scope.)

    if (group.children.length === 0) {
      throw new FileValidationError(
        `This .3dm file contains no drawable render meshes${skipped ? ` (${skipped} object(s) have no saved render mesh)` : ""}. In Rhino, save with render meshes enabled, or export STEP/OBJ instead.`,
        "corrupt",
      );
    }
    if (skipped > 0) {
      group.userData.skippedNote = `${skipped} Rhino object(s) skipped — NURBS with no saved render mesh cannot be tessellated in the browser.`;
    }
    return group;
  }

  /** IFC via web-ifc (WASM, MPL-2.0). */
  private async loadIfc(
    buffer: ArrayBuffer,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<THREE.Group> {
    stage("Geometry extraction", "Loading web-ifc (WASM)…", 0.25);
    const { IfcAPI } = await import("web-ifc");
    const api = new IfcAPI();
    api.SetWasmPath(`${import.meta.env.BASE_URL}ifc/`, true);
    await api.Init();

    stage("Geometry extraction", "Reading IFC model…", 0.5);
    await frame();

    const modelId = api.OpenModel(new Uint8Array(buffer));
    const group = new THREE.Group();
    group.name = "IFC model";

    api.StreamAllMeshes(modelId, (ifcMesh) => {
      const placed = ifcMesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geom = api.GetGeometry(modelId, pg.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());

        // web-ifc packs [px,py,pz, nx,ny,nz] per vertex.
        const count = verts.length / 6;
        const pos = new Float32Array(count * 3);
        const nrm = new Float32Array(count * 3);
        for (let v = 0; v < count; v++) {
          pos[v * 3] = verts[v * 6];
          pos[v * 3 + 1] = verts[v * 6 + 1];
          pos[v * 3 + 2] = verts[v * 6 + 2];
          nrm[v * 3] = verts[v * 6 + 3];
          nrm[v * 3 + 1] = verts[v * 6 + 4];
          nrm[v * 3 + 2] = verts[v * 6 + 5];
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
        geo.setIndex(Array.from(idx));

        const c = pg.color;
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(c.x, c.y, c.z),
            transparent: c.w < 1,
            opacity: c.w,
            metalness: 0.2,
            roughness: 0.7,
          }),
        );
        mesh.applyMatrix4(new THREE.Matrix4().fromArray(pg.flatTransformation));
        mesh.name = `IFC element ${ifcMesh.expressID}`;
        group.add(mesh);
      }
    });

    api.CloseModel(modelId);
    if (group.children.length === 0) {
      throw new FileValidationError(
        "web-ifc opened this IFC file but found no geometric representations in it.",
        "corrupt",
      );
    }
    return group;
  }
  /* ───────── blueprints ───────── */

  private async processBlueprint(
    file: File,
    spec: FormatSpec,
    bytes: Uint8Array,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<BlueprintImportResult> {
    stage("Geometry extraction", "Rendering blueprint pages", 0.2);
    await frame();

    const pages: BlueprintPage[] =
      spec.id === "pdf"
        ? await this.renderPdf(bytes, stage)
        : spec.id === "dxf"
          ? [await this.renderDxf(bytes, stage)]
          : [await this.renderImage(file, bytes)];

    stage("Structure identification", "Classifying views", 0.5);
    await frame();
    for (const p of pages) {
      const guess = guessView(p.canvas, p.width, p.height);
      p.viewGuess = guess.view;
      p.viewReason = guess.reason;
    }

    stage("3D scene generation", "Blueprint reference prepared", 0.7);
    stage("Materials and lighting", "n/a for 2D reference", 0.8);
    stage("Component identification", "Awaiting assisted reconstruction", 0.9);
    stage("Interactive visualisation", "Ready", 1);

    return {
      kind: "blueprint",
      format: spec.id,
      pages,
      dispose: () => {
        for (const p of pages) {
          p.canvas.width = 0;
          p.canvas.height = 0;
        }
      },
    };
  }

  private async renderPdf(
    bytes: Uint8Array,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<BlueprintPage[]> {
    const pdfjs = await import("pdfjs-dist");
    // Worker is served from our own origin — no CDN (§12).
    pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const limit = Math.min(doc.numPages, 12);
    const pages: BlueprintPage[] = [];
    for (let i = 1; i <= limit; i++) {
      stage("Geometry extraction", `Rendering PDF page ${i}/${limit}`, 0.2 + (0.25 * i) / limit);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // Cap the raster so a huge E-size sheet cannot exhaust memory.
      const scale = Math.min(2.2, 2200 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new FileValidationError("Could not create a 2D canvas for the PDF.", "corrupt");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push({
        index: i,
        width: canvas.width,
        height: canvas.height,
        canvas,
        viewGuess: "unknown",
        viewReason: "",
      });
      page.cleanup();
      await frame();
    }
    await doc.cleanup();
    return pages;
  }

  /**
   * Renders a DXF drawing to a canvas so it can be used as a blueprint
   * reference (§1). DXF is a 2D exchange format — it is deliberately NOT read
   * as a 3D solid, and the UI says so.
   *
   * Draws the entity types that actually carry a technical drawing: lines,
   * polylines, circles, arcs and ellipses. Unsupported entities are counted and
   * reported rather than silently skipped.
   */
  private async renderDxf(
    bytes: Uint8Array,
    stage: (n: StageName, d: string, w?: number) => void,
  ): Promise<BlueprintPage> {
    stage("Geometry extraction", "Parsing DXF entities…", 0.3);
    const DxfParser = (await import("dxf-parser")).default;
    await frame();

    let dxf: { entities?: Array<Record<string, unknown>> };
    try {
      dxf = new DxfParser().parseSync(new TextDecoder().decode(bytes)) as never;
    } catch (e) {
      throw new FileValidationError(
        `This DXF could not be parsed: ${(e as Error).message}`,
        "corrupt",
      );
    }
    const entities = dxf.entities ?? [];
    if (entities.length === 0) {
      throw new FileValidationError(
        "This DXF file contains no drawable entities.",
        "corrupt",
      );
    }

    // Pass 1: measure the drawing extents.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const see = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    type Pt = { x: number; y: number };
    for (const e of entities) {
      const v = e.vertices as Pt[] | undefined;
      if (v) for (const pt of v) see(pt.x, pt.y);
      const c = e.center as Pt | undefined;
      const r = (e.radius as number) ?? 0;
      if (c) {
        see(c.x - r, c.y - r);
        see(c.x + r, c.y + r);
      }
      const p = e.position as Pt | undefined;
      if (p) see(p.x, p.y);
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
      throw new FileValidationError(
        "This DXF has no measurable extents — it may contain only block definitions or text.",
        "corrupt",
      );
    }

    stage("Geometry extraction", `Drawing ${entities.length} DXF entities…`, 0.45);
    await frame();

    // Fit the drawing into a sheet-sized raster with a margin.
    const pad = 0.04;
    const w = maxX - minX;
    const h = maxY - minY;
    const target = 1800;
    const scale = target / Math.max(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(64, Math.ceil(w * scale * (1 + pad * 2)));
    canvas.height = Math.max(64, Math.ceil(h * scale * (1 + pad * 2)));
    const g = canvas.getContext("2d");
    if (!g) throw new FileValidationError("Could not create a canvas for the DXF.", "corrupt");

    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = "#111820";
    g.lineWidth = Math.max(1, scale * Math.max(w, h) * 0.0008);
    g.lineJoin = "round";

    const ox = w * scale * pad;
    const oy = h * scale * pad;
    // DXF Y points up; canvas Y points down.
    const tx = (x: number) => ox + (x - minX) * scale;
    const ty = (y: number) => oy + (maxY - y) * scale;

    let drawn = 0;
    const skippedTypes = new Set<string>();

    for (const e of entities) {
      const type = String(e.type ?? "");
      const v = e.vertices as Pt[] | undefined;
      const c = e.center as Pt | undefined;
      switch (type) {
        case "LINE":
        case "LWPOLYLINE":
        case "POLYLINE": {
          if (!v || v.length < 2) break;
          g.beginPath();
          g.moveTo(tx(v[0].x), ty(v[0].y));
          for (let i = 1; i < v.length; i++) g.lineTo(tx(v[i].x), ty(v[i].y));
          if (e.shape === true) g.closePath();
          g.stroke();
          drawn++;
          break;
        }
        case "CIRCLE": {
          if (!c) break;
          g.beginPath();
          g.arc(tx(c.x), ty(c.y), ((e.radius as number) ?? 0) * scale, 0, Math.PI * 2);
          g.stroke();
          drawn++;
          break;
        }
        case "ARC": {
          if (!c) break;
          const a0 = (e.startAngle as number) ?? 0;
          const a1 = (e.endAngle as number) ?? Math.PI * 2;
          g.beginPath();
          // Negated because the Y axis is flipped into canvas space.
          g.arc(tx(c.x), ty(c.y), ((e.radius as number) ?? 0) * scale, -a1, -a0);
          g.stroke();
          drawn++;
          break;
        }
        case "ELLIPSE": {
          if (!c) break;
          const maj = e.majorAxisEndPoint as Pt | undefined;
          if (!maj) break;
          const rx = Math.hypot(maj.x, maj.y) * scale;
          const ry = rx * (((e.axisRatio as number) ?? 1));
          const rot = Math.atan2(maj.y, maj.x);
          g.beginPath();
          g.ellipse(tx(c.x), ty(c.y), rx, ry, -rot, 0, Math.PI * 2);
          g.stroke();
          drawn++;
          break;
        }
        case "POINT":
          break;
        default:
          if (type) skippedTypes.add(type);
      }
    }

    if (drawn === 0) {
      throw new FileValidationError(
        `This DXF contains ${entities.length} entities but none are drawable line work (found: ${[...skippedTypes].join(", ") || "none"}).`,
        "corrupt",
      );
    }

    const note = skippedTypes.size
      ? `Rendered ${drawn} of ${entities.length} entities. Not drawn: ${[...skippedTypes].sort().join(", ")}.`
      : `Rendered all ${drawn} drawable entities.`;

    return {
      index: 1,
      width: canvas.width,
      height: canvas.height,
      canvas,
      viewGuess: "unknown",
      viewReason: "",
      sourceNote: note,
    };
  }

  private async renderImage(file: File, bytes: Uint8Array): Promise<BlueprintPage> {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.type || "image/png" }));
    this.objectUrls.add(url);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new FileValidationError(`"${file.name}" could not be decoded as an image.`, "corrupt"));
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { index: 1, width: canvas.width, height: canvas.height, canvas, viewGuess: "unknown", viewReason: "" };
    } finally {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(url);
    }
  }

  /** Releases every object URL this processor created (§12). */
  dispose(): void {
    for (const u of this.objectUrls) URL.revokeObjectURL(u);
    this.objectUrls.clear();
  }
}

/* ───────────────────────── helpers ───────────────────────── */

/** Yields to the browser so the UI never freezes during processing (§11). */
export function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function readArrayBuffer(file: File, onProgress: (p: number) => void): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new FileValidationError(`Could not read "${file.name}".`, "corrupt"));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Picks the objects that should be treated as selectable parts: the children of
 * the deepest node that actually branches, so a GLB wrapped in nested empties
 * still yields its real sub-objects.
 */
function collectPartRoots(root: THREE.Object3D): THREE.Object3D[] {
  let node = root;
  while (node.children.length === 1 && !(node.children[0] as THREE.Mesh).isMesh) {
    node = node.children[0];
  }
  const kids = node.children.filter((c) => {
    let has = false;
    c.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) has = true;
    });
    return has;
  });
  if (kids.length > 0) return kids;
  const meshes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o);
  });
  return meshes.length ? meshes : [root];
}

export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) {
      const anyMat = mat as THREE.MeshStandardMaterial;
      for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"] as const) {
        anyMat[k]?.dispose?.();
      }
      mat.dispose();
    }
  });
  root.clear();
}

/**
 * Heuristic orthographic-view classifier for a blueprint page.
 *
 * This is DELIBERATELY conservative and always reports its reasoning: a 2D
 * sheet cannot be classified with certainty, so the UI presents this as a guess
 * the user confirms or corrects, never as a fact (§2).
 */
export function guessView(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): { view: BlueprintPage["viewGuess"]; reason: string } {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || width < 8 || height < 8) {
    return { view: "unknown", reason: "Page too small to analyse." };
  }

  // Downsample to an ink-occupancy grid.
  const W = 64;
  const H = Math.max(8, Math.round((height / width) * W));
  const tmp = document.createElement("canvas");
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext("2d");
  if (!tctx) return { view: "unknown", reason: "Could not analyse the page." };
  tctx.drawImage(canvas, 0, 0, W, H);
  const d = tctx.getImageData(0, 0, W, H).data;

  const rows = new Array(H).fill(0);
  const cols = new Array(W).fill(0);
  let ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      if (lum < 0.72) {
        ink++;
        rows[y]++;
        cols[x]++;
      }
    }
  }
  if (ink < W * H * 0.01) {
    return { view: "unknown", reason: "Almost no line work detected on this page." };
  }

  const inkRows = rows.filter((v) => v > 1).length;
  const inkCols = cols.filter((v) => v > 1).length;
  const aspect = inkCols / Math.max(1, inkRows);

  // Vertical symmetry of the ink distribution — a plan view of an aircraft is
  // strongly symmetric about its centreline; a side elevation is not.
  let sym = 0;
  for (let x = 0; x < Math.floor(W / 2); x++) {
    const a = cols[x];
    const b = cols[W - 1 - x];
    sym += 1 - Math.abs(a - b) / Math.max(1, a + b);
  }
  sym /= Math.floor(W / 2);

  if (aspect > 1.45 && sym > 0.74) {
    return {
      view: "top",
      reason: `Wide (${aspect.toFixed(1)}:1) and strongly symmetric about the vertical centreline (${Math.round(sym * 100)}%) — typical of a plan/top view.`,
    };
  }
  if (aspect > 1.45) {
    return {
      view: "side",
      reason: `Wide (${aspect.toFixed(1)}:1) but asymmetric (${Math.round(sym * 100)}% symmetry) — typical of a side elevation.`,
    };
  }
  if (aspect < 0.95 && sym > 0.7) {
    return {
      view: "front",
      reason: `Tall/compact (${aspect.toFixed(1)}:1) and symmetric — typical of a front view.`,
    };
  }
  return {
    view: "unknown",
    reason: `Could not classify (${aspect.toFixed(1)}:1 aspect, ${Math.round(sym * 100)}% symmetry). Set the view manually.`,
  };
}
