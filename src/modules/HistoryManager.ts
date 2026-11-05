/**
 * HistoryManager — the undo/redo system required by §11.
 *
 * Design: snapshot-based, not command-based. Each entry captures the exact
 * position, rotation, scale and visibility of every tracked object plus the
 * app-level flags (explode amount, X-Ray, selection). Undo restores that
 * snapshot wholesale, which is what guarantees "restore the EXACT previous
 * component position" even after a gesture drag that produced hundreds of
 * intermediate frames.
 *
 * Coalescing: continuous gestures (dragging a part) would otherwise flood the
 * stack, so a push with the same `coalesceKey` inside `coalesceMs` replaces the
 * previous entry rather than appending — one drag becomes one undo step.
 */

export interface TransformSnapshot {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
}

export interface HistoryState {
  /** Object id → transform. */
  transforms: Record<string, TransformSnapshot>;
  /** App-level flags restored alongside geometry. */
  flags: {
    explodeAmount: number;
    engineExplodeAmount: number;
    xrayEnabled: boolean;
    xrayOpacity: number;
    selectedIds: string[];
    isolatedId: string | null;
    hiddenIds: string[];
    measurementPoints: Array<[number, number, number]>;
  };
}

export interface HistoryEntry {
  label: string;
  state: HistoryState;
  at: number;
  coalesceKey?: string;
}

export class HistoryManager {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  /** Suppresses recording while an undo/redo is being applied. */
  private applying = false;

  constructor(
    private capture: () => HistoryState,
    private restore: (s: HistoryState) => void,
    private limit = 60,
    private coalesceMs = 450,
  ) {}

  get canUndo(): boolean {
    return this.past.length > 1;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | null {
    return this.canUndo ? this.past[this.past.length - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.future[this.future.length - 1].label : null;
  }

  get depth(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  /** Seeds the stack with the current state. Call once after a model loads. */
  reset(label = "Model loaded"): void {
    this.past = [{ label, state: this.capture(), at: Date.now() }];
    this.future = [];
    this.notify();
  }

  /**
   * Records the state AFTER an action.
   *
   * @param coalesceKey when repeated within the coalesce window, the previous
   *        entry with the same key is replaced instead of a new one appended.
   */
  push(label: string, coalesceKey?: string): void {
    if (this.applying) return;
    const state = this.capture();
    const now = Date.now();

    const top = this.past[this.past.length - 1];
    if (
      coalesceKey &&
      top?.coalesceKey === coalesceKey &&
      now - top.at < this.coalesceMs
    ) {
      // Same continuous gesture — fold into the existing entry.
      top.state = state;
      top.at = now;
      top.label = label;
      this.future = [];
      this.notify();
      return;
    }

    // Never record a duplicate of the state already on top.
    if (top && statesEqual(top.state, state)) return;

    this.past.push({ label, state, at: now, coalesceKey });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.notify();
  }

  undo(): string | null {
    if (!this.canUndo) return null;
    const undone = this.past.pop()!;
    this.future.push(undone);
    const target = this.past[this.past.length - 1];
    this.applying = true;
    try {
      this.restore(target.state);
    } finally {
      this.applying = false;
    }
    this.notify();
    return undone.label;
  }

  redo(): string | null {
    if (!this.canRedo) return null;
    const entry = this.future.pop()!;
    this.past.push(entry);
    this.applying = true;
    try {
      this.restore(entry.state);
    } finally {
      this.applying = false;
    }
    this.notify();
    return entry.label;
  }

  /** True while an undo/redo is being applied — guards re-entrant pushes. */
  get isApplying(): boolean {
    return this.applying;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.notify();
  }
}

/** Deep-ish equality so identical consecutive states are not recorded twice. */
export function statesEqual(a: HistoryState, b: HistoryState): boolean {
  const ak = Object.keys(a.transforms);
  const bk = Object.keys(b.transforms);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const x = a.transforms[k];
    const y = b.transforms[k];
    if (!y) return false;
    if (x.visible !== y.visible) return false;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(x.position[i] - y.position[i]) > 1e-6) return false;
      if (Math.abs(x.rotation[i] - y.rotation[i]) > 1e-6) return false;
      if (Math.abs(x.scale[i] - y.scale[i]) > 1e-6) return false;
    }
  }
  const fa = a.flags;
  const fb = b.flags;
  return (
    Math.abs(fa.explodeAmount - fb.explodeAmount) < 1e-6 &&
    Math.abs(fa.engineExplodeAmount - fb.engineExplodeAmount) < 1e-6 &&
    fa.xrayEnabled === fb.xrayEnabled &&
    Math.abs(fa.xrayOpacity - fb.xrayOpacity) < 1e-6 &&
    fa.isolatedId === fb.isolatedId &&
    sameSet(fa.selectedIds, fb.selectedIds) &&
    sameSet(fa.hiddenIds, fb.hiddenIds) &&
    fa.measurementPoints.length === fb.measurementPoints.length
  );
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
