/**
 * Reusable aircraft geometry primitives.
 *
 * Model-space convention used by the whole app:
 *   +X = forward (nose)   +Y = up   +Z = starboard (right wing)
 * Units are notional metres; AircraftScene normalises the finished model to fit
 * the viewport, so each aircraft keeps its true relative proportions.
 */

import * as THREE from "three";

/* ───────────────────────── airfoil ───────────────────────── */

/**
 * NACA 4-digit symmetric half-thickness distribution, used for every lifting
 * surface so wings, fins and stabilisers read as real aerofoils rather than
 * flat plates.
 */
function nacaThickness(t: number, x: number): number {
  return (
    (t / 0.2) *
    (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4)
  );
}

/** Closed airfoil outline in chord-normalised coordinates: x 0..1, y ±t/2. */
export function airfoilProfile(thickness = 0.12, steps = 24): Array<[number, number]> {
  const upper: Array<[number, number]> = [];
  const lower: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    // Cosine spacing packs points at the leading edge where curvature is highest.
    const x = 0.5 * (1 - Math.cos((i / steps) * Math.PI));
    const y = nacaThickness(thickness, x);
    upper.push([x, y]);
    lower.push([x, -y]);
  }
  return [...upper, ...lower.reverse().slice(1, -1)];
}

export interface LoftSection {
  /** Span station — distance along the surface's own span axis. */
  span: number;
  chord: number;
  /** Leading-edge offset along +X (negative = swept back). */
  xOffset: number;
  /** Vertical offset (dihedral / fin taper). */
  yOffset: number;
  thickness?: number;
  /** Twist about the span axis, radians (washout). */
  twist?: number;
}

/**
 * Lofts an airfoil through a list of span stations, producing a tapered, swept,
 * dihedralled lifting surface as one closed BufferGeometry.
 *
 * @param axis "z" for wings/stabilisers (span runs sideways), "y" for fins.
 */
export function loftLiftingSurface(
  sections: LoftSection[],
  axis: "y" | "z" = "z",
  profileSteps = 20,
): THREE.BufferGeometry {
  const ringCount = sections.length;
  const rings: THREE.Vector3[][] = [];

  for (const s of sections) {
    const prof = airfoilProfile(s.thickness ?? 0.12, profileSteps);
    const twist = s.twist ?? 0;
    const cos = Math.cos(twist);
    const sin = Math.sin(twist);
    const ring = prof.map(([cx, cy]) => {
      // Rotate the chordwise profile about the quarter-chord for twist.
      const px = (cx - 0.25) * s.chord;
      const py = cy * s.chord;
      const rx = px * cos - py * sin;
      const ry = px * sin + py * cos;
      const xx = s.xOffset - rx; // -rx so +chord runs aft
      const yy = s.yOffset + ry;
      return axis === "z"
        ? new THREE.Vector3(xx, yy, s.span)
        : new THREE.Vector3(xx, s.span, yy);
    });
    rings.push(ring);
  }

  const perRing = rings[0].length;
  const positions: number[] = [];
  const indices: number[] = [];

  for (const ring of rings) for (const v of ring) positions.push(v.x, v.y, v.z);

  // Side skin
  for (let r = 0; r < ringCount - 1; r++) {
    for (let i = 0; i < perRing; i++) {
      const a = r * perRing + i;
      const b = r * perRing + ((i + 1) % perRing);
      const c = (r + 1) * perRing + i;
      const d = (r + 1) * perRing + ((i + 1) % perRing);
      indices.push(a, c, b, b, c, d);
    }
  }

  // Cap both ends with a triangle fan so the solid is closed.
  const capRing = (ringOffset: number, flip: boolean) => {
    const base = positions.length / 3;
    const centre = new THREE.Vector3();
    for (let i = 0; i < perRing; i++) centre.add(rings[ringOffset][i]);
    centre.multiplyScalar(1 / perRing);
    positions.push(centre.x, centre.y, centre.z);
    for (let i = 0; i < perRing; i++) {
      const a = ringOffset * perRing + i;
      const b = ringOffset * perRing + ((i + 1) % perRing);
      if (flip) indices.push(base, b, a);
      else indices.push(base, a, b);
    }
  };
  capRing(0, true);
  capRing(ringCount - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds a wing panel from root/tip parameters.
 * Returns geometry in model space for the STARBOARD (+Z) side; mirror for port.
 */
export function buildWing(opts: {
  halfSpan: number;
  rootChord: number;
  tipChord: number;
  sweepDeg: number;
  dihedralDeg: number;
  rootX: number;
  rootY: number;
  thickness?: number;
  /** Fraction of half-span where a winglet kicks up; 0 disables. */
  winglet?: number;
}): THREE.BufferGeometry {
  const sweep = Math.tan((opts.sweepDeg * Math.PI) / 180);
  const dih = Math.tan((opts.dihedralDeg * Math.PI) / 180);
  const stations = [0, 0.18, 0.45, 0.75, 0.93, 1.0];
  const sections: LoftSection[] = stations.map((f) => {
    const span = f * opts.halfSpan;
    const chord = opts.rootChord + (opts.tipChord - opts.rootChord) * Math.pow(f, 0.85);
    return {
      span,
      chord,
      xOffset: opts.rootX - span * sweep,
      yOffset: opts.rootY + span * dih,
      thickness: (opts.thickness ?? 0.13) * (1 - 0.25 * f),
      twist: (-2.5 * Math.PI) / 180 * f, // mild washout
    };
  });

  const wing = loftLiftingSurface(sections, "z");
  if (!opts.winglet) return wing;

  // Winglet: a short, highly-swept surface canted up from the tip.
  const tip = sections[sections.length - 1];
  const wl = loftLiftingSurface(
    [
      { span: 0, chord: tip.chord, xOffset: tip.xOffset, yOffset: 0, thickness: 0.1 },
      {
        span: opts.halfSpan * 0.085,
        chord: tip.chord * 0.42,
        xOffset: tip.xOffset - opts.halfSpan * 0.07,
        yOffset: 0,
        thickness: 0.09,
      },
    ],
    "y",
  );
  wl.translate(0, tip.yOffset, tip.span);
  return mergeGeometries([wing, wl]);
}

/* ───────────────────────── fuselage ───────────────────────── */

export interface FuselageProfile {
  /** Fraction of length from nose (0) to tail (1). */
  t: number;
  /** Radius at that station. */
  r: number;
  /** Vertical centreline offset (upsweep). */
  y?: number;
  /** Width multiplier — >1 widens the cross-section (cargo holds). */
  wide?: number;
  /** Cross-section squareness: 0 = circle, 1 = rounded rectangle. */
  square?: number;
}

/**
 * Lofts a fuselage from radius stations with optional squared-off cross-section
 * (used for the freighter's boxy hold) and tail upsweep.
 */
export function buildFuselage(
  length: number,
  profile: FuselageProfile[],
  radialSteps = 28,
): THREE.BufferGeometry {
  const rings: THREE.Vector3[][] = [];

  for (const st of profile) {
    const x = length * (0.5 - st.t); // nose at +X
    const ring: THREE.Vector3[] = [];
    const sq = st.square ?? 0;
    const wide = st.wide ?? 1;
    for (let i = 0; i < radialSteps; i++) {
      const a = (i / radialSteps) * Math.PI * 2;
      // Superellipse blend between a circle and a rounded rectangle.
      const n = 2 + sq * 2.4;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const k = Math.pow(Math.pow(Math.abs(c), n) + Math.pow(Math.abs(s), n), -1 / n);
      const rr = st.r * (sq > 0 ? k : 1);
      ring.push(new THREE.Vector3(x, (st.y ?? 0) + rr * s, rr * c * wide));
    }
    rings.push(ring);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) for (const v of ring) positions.push(v.x, v.y, v.z);

  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < radialSteps; i++) {
      const a = r * radialSteps + i;
      const b = r * radialSteps + ((i + 1) % radialSteps);
      const c = (r + 1) * radialSteps + i;
      const d = (r + 1) * radialSteps + ((i + 1) % radialSteps);
      indices.push(a, c, b, b, c, d);
    }
  }

  // Nose and tail caps (apex points).
  const capApex = (ringIdx: number, dir: number) => {
    const base = positions.length / 3;
    const ring = rings[ringIdx];
    const centre = new THREE.Vector3();
    for (const v of ring) centre.add(v);
    centre.multiplyScalar(1 / ring.length);
    positions.push(centre.x + dir * 0.02 * length, centre.y, centre.z);
    for (let i = 0; i < radialSteps; i++) {
      const a = ringIdx * radialSteps + i;
      const b = ringIdx * radialSteps + ((i + 1) % radialSteps);
      if (dir > 0) indices.push(base, a, b);
      else indices.push(base, b, a);
    }
  };
  capApex(0, 1);
  capApex(rings.length - 1, -1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* ───────────────────────── merge helper ───────────────────────── */

/**
 * Minimal non-indexed geometry merge — avoids pulling in the full
 * BufferGeometryUtils addon for what is a handful of position-only solids.
 */
export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of parts) total += g.getAttribute("position").count;

  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    const n = g.getAttribute("normal") as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, o * 3);
    nrm.set(n.array as Float32Array, o * 3);
    o += p.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  for (const g of parts) if (!geos.includes(g)) g.dispose();
  return out;
}

/* ───────────────────────── engine nacelle ───────────────────────── */

/** High-bypass nacelle: cowl, spinner, fan face, exhaust plug and pylon. */
export function buildTurbofan(opts: {
  radius: number;
  length: number;
  shellMat: THREE.Material;
  darkMat: THREE.Material;
  accentMat: THREE.Material;
  /** Slim, afterburning layout instead of a fat high-bypass cowl. */
  military?: boolean;
}): THREE.Group {
  const g = new THREE.Group();
  const r = opts.radius;
  const l = opts.length;

  if (opts.military) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.86, l * 0.8, 24, 1, true), opts.shellMat);
    body.rotation.z = Math.PI / 2;
    g.add(body);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.66, l * 0.26, 24, 1, true), opts.darkMat);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.x = -l * 0.52;
    g.add(nozzle);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.68, r * 0.07, 8, 22), opts.accentMat);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = -l * 0.64;
    g.add(ring);
    return g;
  }

  // Cowl — slightly barrelled, open at both ends.
  const cowl = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.94, r, l * 0.62, 30, 1, true),
    opts.shellMat,
  );
  cowl.rotation.z = Math.PI / 2;
  cowl.position.x = l * 0.1;
  g.add(cowl);

  // Intake lip
  const lip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.97, r * 0.09, 10, 30), opts.accentMat);
  lip.rotation.y = Math.PI / 2;
  lip.position.x = l * 0.41;
  g.add(lip);

  // Fan face + spinner
  const fan = new THREE.Mesh(new THREE.CircleGeometry(r * 0.9, 30), opts.darkMat);
  fan.rotation.y = Math.PI / 2;
  fan.position.x = l * 0.3;
  g.add(fan);
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(r * 0.2, r * 0.6, 18), opts.accentMat);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.x = l * 0.46;
  g.add(spinner);

  // Core cowl + exhaust plug
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.62, r * 0.5, l * 0.48, 24, 1, true),
    opts.darkMat,
  );
  core.rotation.z = Math.PI / 2;
  core.position.x = -l * 0.32;
  g.add(core);
  const plug = new THREE.Mesh(new THREE.ConeGeometry(r * 0.48, r * 0.8, 20), opts.darkMat);
  plug.rotation.z = -Math.PI / 2;
  plug.position.x = -l * 0.66;
  g.add(plug);

  return g;
}

/** Oleo-pneumatic landing-gear leg with wheels. */
export function buildGearLeg(opts: {
  strutLength: number;
  strutRadius: number;
  wheelRadius: number;
  wheelWidth: number;
  wheelPairs: number;
  metalMat: THREE.Material;
  tyreMat: THREE.Material;
}): THREE.Group {
  const g = new THREE.Group();

  const strut = new THREE.Mesh(
    new THREE.CylinderGeometry(opts.strutRadius, opts.strutRadius * 0.82, opts.strutLength, 12),
    opts.metalMat,
  );
  strut.position.y = -opts.strutLength / 2;
  g.add(strut);

  // Polished slider section — visually reads as the oleo piston.
  const slider = new THREE.Mesh(
    new THREE.CylinderGeometry(opts.strutRadius * 0.64, opts.strutRadius * 0.64, opts.strutLength * 0.38, 12),
    opts.metalMat,
  );
  slider.position.y = -opts.strutLength * 0.82;
  g.add(slider);

  const axle = new THREE.Mesh(
    new THREE.CylinderGeometry(opts.strutRadius * 0.4, opts.strutRadius * 0.4, opts.wheelWidth * 2.6, 10),
    opts.metalMat,
  );
  axle.rotation.x = Math.PI / 2;
  axle.position.y = -opts.strutLength;
  g.add(axle);

  for (let p = 0; p < opts.wheelPairs; p++) {
    const xo = (p - (opts.wheelPairs - 1) / 2) * opts.wheelRadius * 2.3;
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(opts.wheelRadius, opts.wheelRadius, opts.wheelWidth, 18),
        opts.tyreMat,
      );
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(xo, -opts.strutLength, side * opts.wheelWidth * 0.85);
      g.add(wheel);
    }
  }
  return g;
}
