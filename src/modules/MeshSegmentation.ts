/**
 * MeshSegmentation — splits a single mesh into its connected components (§4).
 *
 * This is how an STL, which stores nothing but loose triangles, can still be
 * explored part-by-part: triangles that share a vertex position belong to the
 * same physical shell, so a union-find over welded vertices recovers the
 * separate solids an exporter flattened together.
 *
 * It only ever reports what it can prove. If the mesh is one connected shell,
 * it says so and returns a single group rather than inventing subdivisions.
 */

import * as THREE from "three";

export interface SegmentationResult {
  /** One geometry per connected shell, in descending size order. */
  shells: THREE.BufferGeometry[];
  /** True when the input was genuinely separable. */
  separable: boolean;
  /** Plain-language explanation shown in the UI. */
  reason: string;
}

/** Quantises a position so coincident-but-not-identical vertices weld. */
function vertexKey(x: number, y: number, z: number, precision: number): string {
  const q = 1 / precision;
  return `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
}

class UnionFind {
  private parent: Int32Array;
  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }
  find(a: number): number {
    let root = a;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression keeps this near-linear on big meshes.
    while (this.parent[a] !== root) {
      const next = this.parent[a];
      this.parent[a] = root;
      a = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Splits `geometry` into connected shells.
 *
 * @param maxShells Safety cap — a scan mesh can have thousands of specks, and
 *                  presenting 5,000 "components" would be useless.
 */
export function segmentConnectedShells(
  geometry: THREE.BufferGeometry,
  maxShells = 64,
): SegmentationResult {
  const pos = geometry.getAttribute("position");
  if (!pos || pos.count < 3) {
    return { shells: [], separable: false, reason: "The mesh has no triangles to segment." };
  }

  const indexAttr = geometry.getIndex();
  const triCount = indexAttr ? indexAttr.count / 3 : pos.count / 3;
  if (triCount < 2) {
    return {
      shells: [geometry],
      separable: false,
      reason: "The mesh is a single triangle — nothing to separate.",
    };
  }

  // Very large meshes: segmentation is O(n) but building the key map costs
  // memory, so refuse rather than risk locking the tab.
  if (triCount > 1_200_000) {
    return {
      shells: [geometry],
      separable: false,
      reason: `This mesh has ${Math.round(triCount).toLocaleString()} triangles — too many to segment safely in the browser. It loads as one object.`,
    };
  }

  // Weld tolerance scales with the model so it works at any unit scale.
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  const precision = Math.max(1e-6, Math.max(size.x, size.y, size.z) * 1e-5);

  const idx = (t: number, c: number): number =>
    indexAttr ? indexAttr.getX(t * 3 + c) : t * 3 + c;

  // Map welded positions → a representative vertex id.
  const weld = new Map<string, number>();
  const vertexOf = new Int32Array(pos.count);
  for (let v = 0; v < pos.count; v++) {
    const key = vertexKey(pos.getX(v), pos.getY(v), pos.getZ(v), precision);
    let rep = weld.get(key);
    if (rep === undefined) {
      rep = v;
      weld.set(key, v);
    }
    vertexOf[v] = rep;
  }

  // Union triangles that share a welded vertex.
  const uf = new UnionFind(triCount);
  const triOfVertex = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const rep = vertexOf[idx(t, c)];
      const seen = triOfVertex.get(rep);
      if (seen === undefined) triOfVertex.set(rep, t);
      else uf.union(seen, t);
    }
  }

  // Bucket triangles by root.
  const buckets = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = uf.find(t);
    const list = buckets.get(r);
    if (list) list.push(t);
    else buckets.set(r, [t]);
  }

  if (buckets.size <= 1) {
    return {
      shells: [geometry],
      separable: false,
      reason:
        "This is a single connected shell — every triangle touches its neighbours, so there are no separable parts to extract. GestureFlight will not invent subdivisions that are not in the file.",
    };
  }

  // Largest shells first; a part with 4 triangles is noise next to one with 40k.
  const groups = [...buckets.values()].sort((a, b) => b.length - a.length);

  // Drop specks: anything under 0.5% of the largest shell is almost always
  // exporter debris rather than a real part. The floor of 2 also removes
  // stray single triangles, which are never a meaningful component.
  const minTris = Math.max(2, Math.ceil(groups[0].length * 0.005));
  const kept = groups.filter((g) => g.length >= minTris);
  const dropped = groups.length - kept.length;
  const capped = kept.slice(0, maxShells);

  const normal = geometry.getAttribute("normal");
  const colour = geometry.getAttribute("color");
  const uv = geometry.getAttribute("uv");

  const shells: THREE.BufferGeometry[] = capped.map((tris) => {
    const n = tris.length * 3;
    const p = new Float32Array(n * 3);
    const nr = normal ? new Float32Array(n * 3) : null;
    const cl = colour ? new Float32Array(n * 3) : null;
    const tx = uv ? new Float32Array(n * 2) : null;

    let o = 0;
    for (const t of tris) {
      for (let c = 0; c < 3; c++) {
        const v = idx(t, c);
        p[o * 3] = pos.getX(v);
        p[o * 3 + 1] = pos.getY(v);
        p[o * 3 + 2] = pos.getZ(v);
        if (nr && normal) {
          nr[o * 3] = normal.getX(v);
          nr[o * 3 + 1] = normal.getY(v);
          nr[o * 3 + 2] = normal.getZ(v);
        }
        if (cl && colour) {
          cl[o * 3] = colour.getX(v);
          cl[o * 3 + 1] = colour.getY(v);
          cl[o * 3 + 2] = colour.getZ(v);
        }
        if (tx && uv) {
          tx[o * 2] = uv.getX(v);
          tx[o * 2 + 1] = uv.getY(v);
        }
        o++;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    if (nr) g.setAttribute("normal", new THREE.BufferAttribute(nr, 3));
    else g.computeVertexNormals();
    if (cl) g.setAttribute("color", new THREE.BufferAttribute(cl, 3));
    if (tx) g.setAttribute("uv", new THREE.BufferAttribute(tx, 2));
    return g;
  });

  const parts: string[] = [
    `Found ${groups.length} connected shells in this mesh; ${shells.length} are large enough to explore individually.`,
  ];
  if (dropped > 0) {
    parts.push(`${dropped} tiny fragment${dropped === 1 ? "" : "s"} (under 0.5% of the largest part) ${dropped === 1 ? "was" : "were"} merged out as exporter debris.`);
  }
  if (kept.length > maxShells) {
    parts.push(`Only the ${maxShells} largest are listed.`);
  }
  parts.push("These are geometric shells, not named parts — the file carries no names.");

  return { shells, separable: true, reason: parts.join(" ") };
}
