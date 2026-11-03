/**
 * SettingsManager — calibration values, persisted to localStorage.
 * No account, no server, no analytics: settings never leave the browser.
 */

import type { Settings } from "../types";

const KEY = "gestureflight.settings.v1";

export const DEFAULTS: Settings = {
  sensitivity: 0.5,
  detectionConfidence: 0.5,
  cooldownMs: 900,
  rotationSensitivity: 0.55,
  explodeSensitivity: 0.6,
  zoomSensitivity: 0.55,
  sound: false,
  gesturesEnabled: true,
};

export class SettingsManager {
  private state: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor() {
    this.state = { ...DEFAULTS, ...this.read() };
  }

  private read(): Partial<Settings> {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  get(): Settings {
    return { ...this.state };
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.state[key] === value) return;
    this.state = { ...this.state, [key]: value };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* private browsing — settings simply do not persist */
    }
    this.listeners.forEach((fn) => fn(this.get()));
  }

  reset(): void {
    this.state = { ...DEFAULTS };
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    this.listeners.forEach((fn) => fn(this.get()));
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Sound — synthesised Web Audio cues. No audio files, so nothing to license and
 * nothing to download. Off by default; respects the user's toggle.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private enabled = false;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctor) this.ctx = new Ctor();
    }
    if (on) void this.ctx?.resume();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private blip(freq: number, duration: number, type: OscillatorType = "sine", gain = 0.07): void {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  gesture(): void {
    this.blip(880, 0.08, "triangle", 0.045);
  }
  select(): void {
    this.blip(1180, 0.07, "sine", 0.05);
  }
  explode(): void {
    this.blip(320, 0.26, "sawtooth", 0.035);
    setTimeout(() => this.blip(520, 0.2, "sine", 0.03), 70);
  }
  assemble(): void {
    this.blip(620, 0.12, "sine", 0.04);
    setTimeout(() => this.blip(880, 0.16, "sine", 0.035), 90);
  }
  switchAircraft(): void {
    this.blip(500, 0.1, "square", 0.03);
    setTimeout(() => this.blip(760, 0.14, "triangle", 0.04), 90);
  }
  confirm(): void {
    this.blip(700, 0.1, "sine", 0.05);
    setTimeout(() => this.blip(1050, 0.18, "sine", 0.045), 95);
  }
}
