/**
 * InteractionState — the explicit state manager required by §15.
 *
 * Gesture conflicts are prevented structurally rather than by ad-hoc guards:
 * every gesture-driven action must first be ADMITTED by this machine. A state
 * declares which actions it accepts, so "pointing must not extract a component"
 * and "closed fist must not move the aircraft" are enforced in one place
 * instead of being scattered across handlers.
 *
 * Pure logic: no DOM, no Three.js, so it is fully unit-testable.
 */

export type InteractionStateId =
  | "IDLE"
  | "AIRCRAFT_EXPLODE"
  | "AIRCRAFT_ASSEMBLE"
  | "AIRCRAFT_CONTROL"
  | "COMPONENT_SELECT"
  | "COMPONENT_EXTRACT"
  | "COMPONENT_INSPECT"
  | "MULTI_PART_SELECT"
  | "X_RAY"
  | "MEASUREMENT";

/** Every discrete thing a gesture or click can ask the app to do. */
export type InteractionAction =
  | "explode"
  | "assemble"
  | "flyAircraft"
  | "orbitCamera"
  | "zoom"
  | "pointSelect"
  | "extract"
  | "moveComponent"
  | "rotateComponent"
  | "addToSelection"
  | "measurePoint"
  | "toggleXray"
  | "stepComponent"
  | "switchMode"
  | "confirm";

/**
 * Actions each state admits.
 *
 * Camera orbit and zoom are admitted almost everywhere because they are
 * non-destructive and never conflict with a manipulation — the user always
 * needs to be able to look at what they are doing.
 */
const ADMITTED: Record<InteractionStateId, InteractionAction[]> = {
  IDLE: [
    "explode", "assemble", "flyAircraft", "orbitCamera", "zoom",
    "pointSelect", "toggleXray", "stepComponent", "switchMode", "confirm",
    "measurePoint",
    // Selection can also come from the component list or a mouse click, which
    // never passes through a gesture state — so extraction and manipulation of
    // an already-selected part must be reachable straight from IDLE.
    "extract", "addToSelection", "moveComponent", "rotateComponent",
  ],
  // While the aircraft is separating, selection and extraction are blocked:
  // parts are in motion, so a pick would land on a moving target.
  AIRCRAFT_EXPLODE: ["explode", "assemble", "orbitCamera", "zoom", "toggleXray", "switchMode"],
  AIRCRAFT_ASSEMBLE: ["assemble", "explode", "orbitCamera", "zoom", "toggleXray", "switchMode"],
  // Flight control owns hand movement, so component manipulation is excluded.
  AIRCRAFT_CONTROL: ["flyAircraft", "assemble", "orbitCamera", "zoom", "switchMode", "confirm"],
  COMPONENT_SELECT: [
    "pointSelect", "extract", "addToSelection", "orbitCamera", "zoom",
    "assemble", "toggleXray", "stepComponent", "switchMode", "confirm", "measurePoint",
  ],
  COMPONENT_EXTRACT: [
    "moveComponent", "rotateComponent", "orbitCamera", "zoom", "assemble",
    "extract", "pointSelect", "switchMode", "confirm",
  ],
  COMPONENT_INSPECT: [
    "rotateComponent", "moveComponent", "orbitCamera", "zoom", "assemble",
    "switchMode", "confirm", "measurePoint",
  ],
  MULTI_PART_SELECT: [
    "pointSelect", "addToSelection", "extract", "orbitCamera", "zoom",
    "assemble", "toggleXray", "switchMode", "confirm",
  ],
  X_RAY: [
    "toggleXray", "pointSelect", "extract", "orbitCamera", "zoom", "explode",
    "assemble", "switchMode", "confirm", "measurePoint",
  ],
  MEASUREMENT: ["measurePoint", "orbitCamera", "zoom", "switchMode", "confirm"],
};

/** Human-readable label for the HUD. */
export const STATE_LABELS: Record<InteractionStateId, string> = {
  IDLE: "Ready",
  AIRCRAFT_EXPLODE: "Exploding",
  AIRCRAFT_ASSEMBLE: "Assembling",
  AIRCRAFT_CONTROL: "Flight control",
  COMPONENT_SELECT: "Selecting",
  COMPONENT_EXTRACT: "Extracting",
  COMPONENT_INSPECT: "Inspecting",
  MULTI_PART_SELECT: "Multi-select",
  X_RAY: "X-Ray",
  MEASUREMENT: "Measuring",
};

export class InteractionStateManager {
  private state: InteractionStateId = "IDLE";
  private enteredAt = 0;
  private listeners = new Set<(s: InteractionStateId, prev: InteractionStateId) => void>();
  /** Per-action cooldown timestamps, keyed by action. */
  private lastAction = new Map<InteractionAction, number>();

  constructor(private now: () => number = () => performance.now()) {
    this.enteredAt = this.now();
  }

  get current(): InteractionStateId {
    return this.state;
  }

  get label(): string {
    return STATE_LABELS[this.state];
  }

  /** Milliseconds spent in the current state. */
  get dwell(): number {
    return this.now() - this.enteredAt;
  }

  /** True when `action` is allowed in the current state. */
  admits(action: InteractionAction): boolean {
    return ADMITTED[this.state].includes(action);
  }

  /**
   * Admission check with an optional per-action cooldown (§15). Returns false
   * when the state forbids the action OR the cooldown has not elapsed, so one
   * pinch cannot fire several extractions.
   */
  tryAction(action: InteractionAction, cooldownMs = 0): boolean {
    if (!this.admits(action)) return false;
    if (cooldownMs > 0) {
      const last = this.lastAction.get(action) ?? -Infinity;
      if (this.now() - last < cooldownMs) return false;
      this.lastAction.set(action, this.now());
    }
    return true;
  }

  /** Forces a transition. Returns true when the state actually changed. */
  set(next: InteractionStateId): boolean {
    if (next === this.state) return false;
    const prev = this.state;
    this.state = next;
    this.enteredAt = this.now();
    this.listeners.forEach((fn) => fn(next, prev));
    return true;
  }

  /**
   * Returns to IDLE, but only from a state that is safe to leave implicitly.
   * COMPONENT_EXTRACT / INSPECT / MEASUREMENT persist until the user ends them,
   * so a momentary tracking dropout cannot discard their work.
   */
  relax(): void {
    const sticky: InteractionStateId[] = [
      "COMPONENT_EXTRACT", "COMPONENT_INSPECT", "MEASUREMENT",
      "MULTI_PART_SELECT", "X_RAY",
    ];
    if (!sticky.includes(this.state)) this.set("IDLE");
  }

  onChange(fn: (s: InteractionStateId, prev: InteractionStateId) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** All actions the current state admits — used by the UI to grey out buttons. */
  get admittedActions(): InteractionAction[] {
    return [...ADMITTED[this.state]];
  }

  reset(): void {
    this.lastAction.clear();
    this.set("IDLE");
  }
}
