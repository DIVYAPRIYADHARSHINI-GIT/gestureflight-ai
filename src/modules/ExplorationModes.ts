/**
 * ExplorationModes — the five exploration modes (§8) and the context they give
 * to gesture handling (§7).
 *
 * Switching a mode NEVER tears down the scene, the renderer, the camera or the
 * webcam/tracking pipeline: it only changes which object tree is visible and
 * which controller the gestures are routed to.
 */

export type ExplorationMode =
  | "exterior" // Aircraft Exterior Mode
  | "exploded" // Aircraft Exploded Mode
  | "engine" // Engine Explorer Mode
  | "cutaway" // Engine Cutaway Mode
  | "blueprint"; // Blueprint Reference Mode

export interface ModeSpec {
  id: ExplorationMode;
  label: string;
  short: string;
  /** Which subject the gestures act on while this mode is active. */
  subject: "aircraft" | "engine" | "blueprint";
  hint: string;
}

export const MODES: ModeSpec[] = [
  {
    id: "exterior",
    label: "Aircraft Exterior",
    short: "Exterior",
    subject: "aircraft",
    hint: "Rotate, zoom and select exterior components.",
  },
  {
    id: "exploded",
    label: "Aircraft Exploded",
    short: "Exploded",
    subject: "aircraft",
    hint: "Separate the aircraft and inspect individual components.",
  },
  {
    id: "engine",
    label: "Engine Explorer",
    short: "Engine",
    subject: "engine",
    hint: "Explore the internal engine assemblies.",
  },
  {
    id: "cutaway",
    label: "Engine Cutaway",
    short: "Cutaway",
    subject: "engine",
    hint: "Outer casings hidden — internal structure and airflow visible.",
  },
  {
    id: "blueprint",
    label: "Blueprint Reference",
    short: "Blueprint",
    subject: "blueprint",
    hint: "View the uploaded blueprint and compare it with the 3D model.",
  },
];

export function modeSpec(id: ExplorationMode): ModeSpec {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

export class ModeManager {
  private current: ExplorationMode = "exterior";
  private available = new Set<ExplorationMode>(["exterior", "exploded", "engine", "cutaway"]);
  private listeners = new Set<(m: ExplorationMode, previous: ExplorationMode) => void>();

  get mode(): ExplorationMode {
    return this.current;
  }

  get spec(): ModeSpec {
    return modeSpec(this.current);
  }

  get subject(): ModeSpec["subject"] {
    return this.spec.subject;
  }

  isAvailable(id: ExplorationMode): boolean {
    return this.available.has(id);
  }

  /** Blueprint mode only becomes available once a blueprint is loaded. */
  setAvailable(id: ExplorationMode, available: boolean): void {
    if (available) this.available.add(id);
    else {
      this.available.delete(id);
      if (this.current === id) this.set("exterior");
    }
  }

  set(id: ExplorationMode): boolean {
    if (!this.available.has(id) || id === this.current) return false;
    const previous = this.current;
    this.current = id;
    this.listeners.forEach((fn) => fn(id, previous));
    return true;
  }

  /** Cycles to the next available mode — bound to the peace sign (§7). */
  cycle(direction: 1 | -1 = 1): ExplorationMode {
    const list = MODES.filter((m) => this.available.has(m.id));
    const i = list.findIndex((m) => m.id === this.current);
    const next = list[(i + direction + list.length) % list.length];
    this.set(next.id);
    return next.id;
  }

  onChange(fn: (m: ExplorationMode, previous: ExplorationMode) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/* ───────────────────────── render quality (§4) ───────────────────────── */

export type QualityMode = "performance" | "balanced" | "high";

export interface QualityProfile {
  id: QualityMode;
  label: string;
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  antialias: boolean;
  /** Environment-style reflections on metal surfaces. */
  reflections: boolean;
  description: string;
}

export const QUALITY_PROFILES: Record<QualityMode, QualityProfile> = {
  performance: {
    id: "performance",
    label: "Performance",
    pixelRatio: 1,
    shadows: false,
    shadowMapSize: 512,
    antialias: false,
    reflections: false,
    description: "Lowest GPU load — shadows and reflections off. Use on integrated graphics or if tracking stutters.",
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    antialias: true,
    reflections: true,
    description: "Default. Shadows and reflections on at a moderate resolution.",
  },
  high: {
    id: "high",
    label: "High Quality",
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    reflections: true,
    description: "Full resolution shadows and reflections. Needs a discrete GPU for smooth hand tracking at the same time.",
  },
};
