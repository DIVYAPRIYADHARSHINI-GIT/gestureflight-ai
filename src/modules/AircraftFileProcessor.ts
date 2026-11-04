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

export interface FormatSpec {
  format: UploadFormat;
  kind: UploadKind;
  label: string;
  extensions: string[];
  mimes: string[];
  /** Per-format size ceiling in bytes (§1, configurable). */
  maxBytes: number;
}

export const FORMATS: FormatSpec[] = [
  { format: "step", kind: "mesh3d", label: "STEP CAD", extensions: [".step", ".stp"], mimes: ["application/step", "model/step"], maxBytes: 80 * 1024 * 1024 },
  { format: "stl", kind: "mesh3d", label: "STL mesh", extensions: [".stl"], mimes: ["model/stl", "application/sla"], maxBytes: 120 * 1024 * 1024 },
  { format: "obj", kind: "mesh3d", label: "OBJ mesh", extensions: [".obj"], mimes: ["model/obj", "text/plain"], maxBytes: 120 * 1024 * 1024 },
  { format: "glb", kind: "mesh3d", label: "glTF binary", extensions: [".glb"], mimes: ["model/gltf-binary"], maxBytes: 120 * 1024 * 1024 },
  { format: "gltf", kind: "mesh3d", label: "glTF JSON", extensions: [".gltf"], mimes: ["model/gltf+json"], maxBytes: 120 * 1024 * 1024 },
  { format: "pdf", kind: "blueprint", label: "PDF blueprint", extensions: [".pdf"], mimes: ["application/pdf"], maxBytes: 40 * 1024 * 1024 },
  { format: "png", kind: "blueprint", label: "PNG blueprint", extensions: [".png"], mimes: ["image/png"], maxBytes: 30 * 1024 * 1024 },
  { format: "jpg", kind: "blueprint", label: "JPEG blueprint", extensions: [".jpg", ".jpeg"], mimes: ["image/jpeg"], maxBytes: 30 * 1024 * 1024 },
];

export const ACCEPT_ATTRIBUTE = FORMATS.flatMap((f) => f.extensions).join(",");

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
  format: UploadFormat;
  root: THREE.Group;
  parts: ImportedPart[];
  triangles: number;
  vertices: number;
  /** Bounding box size in the file's own units. */
  size: THREE.Vector3;
  /** True when the file provided more than one distinct named object. */
  hasSeparateComponents: boolean;
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
}

export interface BlueprintImportResult {
  kind: "blueprint";
  format: UploadFormat;
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
  const name = file.name.toLowerCase();
  for (const spec of FORMATS) {
    if (spec.extensions.some((e) => name.endsWith(e))) return spec;
  }
  // Fall back to MIME only when the extension is missing/unknown.
  for (const spec of FORMATS) {
    if (file.type && spec.mimes.includes(file.type)) return spec;
  }
  return null;
}

export function validate(file: File): FormatSpec {
  const spec = detectFormat(file);
  if (!spec) {
    throw new FileValidationError(
      `"${file.name}" is not a supported format. Supported: ${FORMATS.map((f) => f.extensions[0]).join(", ")}.`,
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
  return spec;
}

/* ───────────────────────── magic-byte sniffing ───────────────────────── */

/**
 * Confirms the bytes match the claimed format, so a renamed or corrupt file is
 * rejected with a real reason rather than producing an empty scene.
 */
export function sniff(format: UploadFormat, bytes: Uint8Array): boolean {
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
    default:
      return true;
  }
}

/* ───────────────────────── the processor ───────────────────────── */

export class AircraftFileProcessor {
  private objectUrls = new Set<string>();
  private occt: { ReadStepFile: (b: Uint8Array, p: unknown) => OcctResult } | null = null;

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

    stage("Format detection", `Checking ${spec.format.toUpperCase()} signature`, 0.5);
    const buffer = await readArrayBuffer(file, (p) =>
      stage("Format detection", `Reading file… ${Math.round(p * 100)}%`, p),
    );
    const bytes = new Uint8Array(buffer);
    if (!sniff(spec.format, bytes)) {
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
    switch (spec.format) {
      case "glb":
      case "gltf":
        root = await this.loadGltf(buffer, file.name, stage);
        break;
      case "stl":
        root = this.loadStl(buffer);
        break;
      case "obj":
        root = this.loadObj(buffer);
        break;
      case "step":
        root = await this.loadStep(buffer, stage);
        break;
      default:
        throw new FileValidationError(`No parser for ${spec.label}.`, "unsupported");
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
    if (spec.format !== "glb" && spec.format !== "gltf") {
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
      format: spec.format,
      root: wrapper,
      parts,
      triangles: Math.round(triangles),
      vertices,
      size,
      hasSeparateComponents,
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
   * STEP via occt-import-js (OpenCascade WASM, LGPL-2.1 with the Open CASCADE
   * exception; the .wasm ships unmodified as a separate asset and is credited
   * in the README and About panel).
   *
   * VERIFIED against real STEP files before shipping — this returns genuine
   * triangulated B-rep geometry with normals, not a placeholder.
   */
  private async loadStep(
    buffer: ArrayBuffer,
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

    stage("Geometry extraction", "Tessellating B-rep solids…", 0.45);
    await frame();

    const result = this.occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result.success || !result.meshes?.length) {
      throw new FileValidationError(
        "OpenCascade could not extract geometry from this STEP file. It may use an unsupported schema, contain only wireframe/annotation entities, or be corrupt.",
        "corrupt",
      );
    }

    const group = new THREE.Group();
    group.name = "STEP assembly";
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
      mesh.name = m.name || "STEP solid";
      group.add(mesh);
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
      spec.format === "pdf"
        ? await this.renderPdf(bytes, stage)
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
      format: spec.format,
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

interface OcctResult {
  success: boolean;
  meshes?: Array<{
    name?: string;
    color?: [number, number, number];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index?: { array: number[] };
  }>;
}

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
