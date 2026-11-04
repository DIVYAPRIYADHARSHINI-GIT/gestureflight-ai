/**
 * Shared types for GestureFlight AI.
 */

export type Vec3 = [number, number, number];

/** Canonical gesture vocabulary recognised by the app. */
export type GestureId =
  | "none"
  | "open_palm"
  | "closed_fist"
  | "pointing"
  | "pinch"
  | "peace"
  | "thumbs_up"
  | "rotate"
  | "two_hand_zoom"
  // Added by the upload/engine upgrade — see GestureController for arbitration.
  | "pinch_drag"
  | "swipe_left"
  | "swipe_right";

export interface GestureMeta {
  id: GestureId;
  name: string;
  glyph: string;
  action: string;
  how: string;
  hands: 1 | 2;
}

/** 21 MediaPipe hand landmarks, normalised 0..1 image space (z is relative depth). */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export type Handedness = "Left" | "Right" | "Unknown";

export interface TrackedHand {
  landmarks: Landmark[];
  /** World landmarks in metres relative to the hand's geometric centre (may be absent). */
  worldLandmarks?: Landmark[];
  handedness: Handedness;
  /** MediaPipe handedness classification score. */
  score: number;
}

export interface HandFeatures {
  /** 0..1 — how open the hand is (curled fist → flat palm). */
  openness: number;
  /** Count of fingers considered extended (thumb included). */
  extended: number;
  extendedFlags: { thumb: boolean; index: boolean; middle: boolean; ring: boolean; pinky: boolean };
  /** Normalised thumb-tip → index-tip distance (1.0 ≈ one palm width). */
  pinchDistance: number;
  /** Palm roll in radians; 0 = fingers up. */
  roll: number;
  /** Palm centre in normalised image space. */
  center: { x: number; y: number };
  /** Palm size in normalised units — a crude proximity proxy. */
  scale: number;
}

export interface GestureCandidate {
  id: GestureId;
  confidence: number;
}

/** A single physical part of an aircraft. */
export interface ComponentSpec {
  id: string;
  name: string;
  category: string;
  description: string;
  fn: string;
  location: string;
  /** Illustrative technical values — explicitly NOT certified aircraft data. */
  specs: Record<string, string>;
  /** Direction the part travels in the exploded view (model space, unit-ish). */
  explode: Vec3;
  /** Multiplier on the global explode distance. */
  explodeScale?: number;
}

export interface AircraftSpec {
  id: string;
  category: string;
  name: string;
  role: string;
  /** Illustrative envelope figures shown in the left panel. */
  specs: Record<string, string>;
  /** Note about data provenance / exploration depth. */
  note: string;
  /** Geometry profile used by the procedural builder. */
  profile: AircraftProfile;
  /** Optional GLB override — used when the file exists in /public. */
  glb?: string;
}

export interface AircraftProfile {
  kind: "airliner" | "fighter" | "cargo" | "jet";
  /** Overall length in model units (1 unit ≈ 1 m of the illustrative aircraft). */
  length: number;
  fuselageRadius: number;
  wingSpan: number;
  wingChord: number;
  wingSweep: number;
  /** Vertical offset of the wing from the fuselage centreline. */
  wingZ: number;
  engineCount: 0 | 2 | 4;
  engineRadius: number;
  engineLength: number;
  /** Fraction of half-span where engines sit. */
  enginePos: number;
  tailHeight: number;
  hStabSpan: number;
  gearCount: number;
  colors: { shell: number; accent: number; dark: number; glass: number };
  /** Components that this profile does not model (reported in the UI). */
  omits?: string[];
}

export interface Settings {
  sensitivity: number;
  detectionConfidence: number;
  cooldownMs: number;
  rotationSensitivity: number;
  explodeSensitivity: number;
  zoomSensitivity: number;
  sound: boolean;
  gesturesEnabled: boolean;
}
