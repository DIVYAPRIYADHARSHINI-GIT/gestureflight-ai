/**
 * Synthetic hand-landmark fixtures.
 *
 * Builds anatomically plausible 21-point MediaPipe hands procedurally so the
 * gesture classifier can be tested without a camera.
 *
 * Fingers are kinematic chains: each joint adds a bend proportional to `curl`,
 * at a rate that reproduces a real curled finger (roughly 90° MCP + 100° PIP +
 * 70° DIP ≈ 260° total), so a curl of 1.0 genuinely brings the fingertip back
 * to the palm rather than leaving it half-extended.
 *
 * The thumb is modelled separately — it does not curl along the finger plane,
 * it adducts ACROSS the palm — so its tip is interpolated between an abducted
 * "out" target and an adducted "across the palm" target.
 */

import type { Landmark, TrackedHand } from "../../src/types";

export interface HandOptions {
  /** 0 = straight, 1 = fully curled. Order: thumb, index, middle, ring, pinky. */
  curls: [number, number, number, number, number];
  /** Rotation of the whole hand in the image plane, radians. 0 = fingers up. */
  rotation?: number;
  /** Fan-out between fingers; 1 = natural, >1 = splayed, <1 = closed together. */
  spread?: number;
  /** Overall hand size in normalised image units. */
  scale?: number;
  center?: { x: number; y: number };
  /** Snap the thumb tip onto the index tip (a true pinch). */
  pinch?: boolean;
}

/** Per-finger geometry: knuckle angle, length factor, palm radius at the MCP. */
const FINGERS = [
  { angle: -0.22, len: 0.95, mcpR: 0.62 }, // index
  { angle: 0.0, len: 1.0, mcpR: 0.64 }, // middle
  { angle: 0.2, len: 0.9, mcpR: 0.6 }, // ring
  { angle: 0.42, len: 0.74, mcpR: 0.54 }, // pinky
] as const;

/** Total bend of a fully-curled finger, split across MCP / PIP / DIP. */
const BEND = [0.95, 1.1, 0.78];

function rot(x: number, y: number, a: number): [number, number] {
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

export function makeHand(opts: HandOptions): Landmark[] {
  const scale = opts.scale ?? 0.22;
  const cx = opts.center?.x ?? 0.5;
  const cy = opts.center?.y ?? 0.5;
  const rotation = opts.rotation ?? 0;
  const spread = opts.spread ?? 1;

  // Local space: wrist at origin, extended fingers point towards -y (image "up").
  const local: Array<[number, number]> = [];
  const put = (x: number, y: number) => local.push([x, y]);

  put(0, 0); // 0 — wrist

  /* ── thumb (1-4) ─────────────────────────────────────────────────── */
  const thumbCurl = Math.min(1, Math.max(0, opts.curls[0]));
  const cmc: [number, number] = [-0.17, -0.14];
  const mcp: [number, number] = [-0.33, -0.3];
  // Abducted: thumb sticks out and up, well clear of the index knuckle.
  const tipOut: [number, number] = [-0.72, -0.78];
  // Adducted: thumb folds across the palm, close to the index/middle knuckles.
  const tipAcross: [number, number] = [0.08, -0.5];
  const tip: [number, number] = [
    tipOut[0] + (tipAcross[0] - tipOut[0]) * thumbCurl,
    tipOut[1] + (tipAcross[1] - tipOut[1]) * thumbCurl,
  ];
  const ip: [number, number] = [(mcp[0] + tip[0]) / 2, (mcp[1] + tip[1]) / 2];
  put(cmc[0], cmc[1]);
  put(mcp[0], mcp[1]);
  put(ip[0], ip[1]);
  put(tip[0], tip[1]);

  /* ── four fingers (5-20) ─────────────────────────────────────────── */
  for (let fi = 0; fi < FINGERS.length; fi++) {
    const f = FINGERS[fi];
    const curl = Math.min(1, Math.max(0, opts.curls[fi + 1]));
    const base = f.angle * spread;

    let x = Math.sin(base) * f.mcpR;
    let y = -Math.cos(base) * f.mcpR;
    put(x, y); // MCP

    let dir = base;
    const segs = [0.42, 0.3, 0.24];
    for (let s = 0; s < segs.length; s++) {
      dir += curl * BEND[s];
      const L = segs[s] * f.len;
      x += Math.sin(dir) * L;
      y += -Math.cos(dir) * L;
      put(x, y); // PIP / DIP / TIP
    }
  }

  const pts: Landmark[] = local.map(([lx, ly]) => {
    const [rx, ry] = rot(lx, ly, rotation);
    return { x: cx + rx * scale, y: cy + ry * scale, z: 0 };
  });

  if (opts.pinch) {
    // Lay the thumb tip exactly on the index fingertip.
    const idx = pts[8];
    pts[4] = { x: idx.x + 0.003, y: idx.y + 0.003, z: 0 };
    pts[3] = { x: (pts[2].x + pts[4].x) / 2, y: (pts[2].y + pts[4].y) / 2, z: 0 };
  }

  return pts;
}

export function trackedHand(lms: Landmark[], handedness: "Left" | "Right" = "Right"): TrackedHand {
  return { landmarks: lms, handedness, score: 0.95 };
}

/* ───────── canonical poses ───────── */

export const POSES = {
  /** All five digits extended and splayed. */
  openPalm: () => makeHand({ curls: [0, 0, 0, 0, 0], spread: 1.45 }),
  /** Everything curled, thumb folded across the fingers. */
  closedFist: () => makeHand({ curls: [1, 1, 1, 1, 1], spread: 0.75 }),
  /** Index only; thumb tucked. */
  pointing: () => makeHand({ curls: [0.85, 0, 1, 1, 1], spread: 0.9 }),
  /** Index + middle up and separated; ring, pinky and thumb curled. */
  peace: () => makeHand({ curls: [0.9, 0, 0, 1, 1], spread: 1.8 }),
  /** Thumb out, fingers curled. */
  thumbsUp: () => makeHand({ curls: [0, 1, 1, 1, 1], spread: 0.8 }),
  /** Thumb and index tips in contact; other fingers relaxed. */
  pinch: () => makeHand({ curls: [0.35, 0.45, 0.3, 0.3, 0.3], spread: 1.0, pinch: true }),
  /** A relaxed, half-closed hand — the rotation posture. */
  loose: () => makeHand({ curls: [0.55, 0.55, 0.55, 0.6, 0.6], spread: 0.9 }),
};
