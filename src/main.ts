/**
 * GestureFlight AI — application entry point.
 *
 * Wires the ten modules together:
 *   CameraManager → HandTracking → GestureRecognition → GestureController
 *        ↓
 *   AircraftScene + AircraftModelLoader + ExplodedViewController
 *        + ComponentSelection + AircraftInformation + SettingsManager
 */

import "./style.css";

import { AIRCRAFT } from "./data/aircraft";
import { AircraftInformation } from "./modules/AircraftInformation";
import { AircraftModelLoader, type BuiltAircraft } from "./modules/AircraftModelLoader";
import { AircraftScene } from "./modules/AircraftScene";
import { CameraManager, type CameraError } from "./modules/CameraManager";
import { ComponentSelection } from "./modules/ComponentSelection";
import { ExplodedViewController } from "./modules/ExplodedViewController";
import { GestureController, type GestureState } from "./modules/GestureController";
import { GESTURES, clamp } from "./modules/GestureRecognition";
import { HandTracking } from "./modules/HandTracking";
import { Sound, SettingsManager } from "./modules/SettingsManager";
import { renderAbout, renderCalibration, renderGuide } from "./modules/views";
import type { GestureId } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

class App {
  private settings = new SettingsManager();
  private sound = new Sound();
  private scene: AircraftScene;
  private loader = new AircraftModelLoader();
  private exploded = new ExplodedViewController();
  private selection = new ComponentSelection();
  private info = new AircraftInformation();
  private camera: CameraManager;
  private tracking: HandTracking;
  private gestures: GestureController;

  private built: BuiltAircraft | null = null;
  private aircraftIndex = 0;
  private switching = false;
  private toastTimer = 0;
  private pointerTarget: { nx: number; ny: number } | null = null;
  private pendingAction: string | null = null;
  private lastGesture: GestureId = "none";
  private statTimer = 0;

  constructor() {
    this.scene = new AircraftScene($("viewport"));
    this.camera = new CameraManager($<HTMLVideoElement>("webcam"));
    this.tracking = new HandTracking(
      $<HTMLVideoElement>("webcam"),
      $<HTMLCanvasElement>("overlay"),
      (frame) => {
        this.gestures.currentZoom = this.scene.zoomNormalised;
        this.gestures.process(frame.hands);
        $("stat-vfps").textContent = String(frame.fps);
      },
    );

    this.gestures = new GestureController(
      {
        setExplode: (a) => {
          this.exploded.setAmount(a);
          this.syncExplodeUi();
        },
        assemble: () => {
          if (!this.exploded.isAssembled && this.exploded.targetAmount !== 0) {
            this.sound.assemble();
          }
          this.exploded.assemble();
          this.syncExplodeUi();
        },
        orbit: (dy, dp) => this.scene.orbit(dy, dp),
        setRoll: (r) => this.scene.setRoll(r),
        setZoom: (t) => this.scene.setZoomNormalised(t),
        point: (nx, ny) => {
          this.pointerTarget = nx === null || ny === undefined ? null : { nx, ny };
          this.scene.setCursor(nx, ny);
        },
        pinchSelected: () => this.handlePinch(),
        nextAircraft: () => void this.cycleAircraft(),
        confirm: () => this.handleConfirm(),
        report: (s) => this.renderGestureState(s),
      },
      this.settings.get(),
    );

    this.bindUi();
    this.applySettings();
    void this.loadAircraft(0, true);
    this.startLoop();
  }

  /* ───────────────────────── model lifecycle ───────────────────────── */

  private async loadAircraft(index: number, first = false): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    const spec = AIRCRAFT[index];

    $("loading").hidden = false;
    $("loading-text").textContent = first ? "Building aircraft…" : `Building ${spec.name}…`;

    // Dispose the previous model: geometries, materials and highlight clones.
    if (this.built) {
      this.scene.modelPivot.remove(this.built.root);
      this.selection.dispose();
      this.built.dispose();
      this.built = null;
    }

    // Yield a frame so the loading overlay actually paints before the build.
    await new Promise((r) => requestAnimationFrame(r));

    const built = await this.loader.build(spec);
    this.built = built;
    this.scene.modelPivot.add(built.root);
    this.scene.frameModel(built.radius);

    this.exploded.setModel(built.components, built.radius);
    this.selection.setModel(built.components);
    this.info.renderAircraft(spec);
    this.info.renderComponent(spec.profile.kind, null);

    this.aircraftIndex = index;
    this.renderRail();
    this.syncExplodeUi();
    $("loading").hidden = true;
    this.switching = false;

    if (!first) {
      this.sound.switchAircraft();
      this.toast(`${spec.name} — ${spec.category}`);
    }
  }

  private async cycleAircraft(): Promise<void> {
    await this.loadAircraft((this.aircraftIndex + 1) % AIRCRAFT.length);
  }

  private get spec() {
    return AIRCRAFT[this.aircraftIndex];
  }

  /* ───────────────────────── render loop ───────────────────────── */

  private startLoop(): void {
    this.scene.start((dt) => {
      this.exploded.update(dt);
      this.selection.update(dt);
      // Keep separated components inside the viewport as the model explodes.
      this.scene.setExplodeFraming(this.exploded.amount);

      // Resolve the pointing cursor into a component hover, once per frame.
      if (this.pointerTarget && this.built) {
        const hit = this.scene.pick(
          this.pointerTarget.nx,
          this.pointerTarget.ny,
          this.selection.pickTargets,
        );
        const id = (hit?.object.userData.componentId as string | undefined) ?? null;
        if (this.selection.setHovered(id)) {
          if (id) {
            this.selectComponent(id, false);
            this.sound.select();
          }
        }
      } else if (this.selection.hoveredId) {
        this.selection.setHovered(null);
      }

      // Throttle the FPS readout to 4 Hz.
      this.statTimer += dt;
      if (this.statTimer > 0.25) {
        this.statTimer = 0;
        $("stat-rfps").textContent = String(this.scene.renderFps);
      }
    });
  }

  /* ───────────────────────── gesture feedback ───────────────────────── */

  private renderGestureState(s: GestureState): void {
    const meta = GESTURES[s.gesture];
    const changed = this.lastGesture !== s.gesture;
    this.lastGesture = s.gesture;

    $("gesture-glyph").textContent = meta.glyph;
    $("gesture-name").textContent = meta.name;
    $("gesture-action").textContent = s.gesture === "none" ? meta.action : meta.action;
    $("gesture-card").dataset.active = s.gesture === "none" ? "false" : "true";

    const conf = Math.round(s.confidence * 100);
    $("val-confidence").textContent = `${conf}%`;
    ($("bar-confidence") as HTMLProgressElement).value = conf;
    const open = Math.round(s.openness * 100);
    $("val-openness").textContent = `${open}%`;
    ($("bar-openness") as HTMLProgressElement).value = open;

    $("stat-hands").textContent = String(s.hands);
    $("stat-sides").textContent = s.sides;

    const dot = $("track-dot");
    if (!this.camera.isActive) {
      dot.dataset.state = "idle";
      $("track-status").textContent = "Idle — camera not started";
    } else if (s.hands > 0) {
      dot.dataset.state = "live";
      $("track-status").textContent = `Tracking ${s.hands} hand${s.hands > 1 ? "s" : ""}`;
    } else {
      dot.dataset.state = "searching";
      $("track-status").textContent = "Camera live — show a hand";
    }

    if (changed && s.gesture !== "none") {
      this.sound.gesture();
      this.toast(`${meta.glyph} ${meta.name} → ${meta.action}`);
      if (s.gesture === "open_palm") this.sound.explode();
    }
    this.syncExplodeUi();
  }

  /* ───────────────────────── components ───────────────────────── */

  private selectComponent(id: string | null, announce = true): void {
    this.selection.setSelected(id);
    this.info.renderComponent(this.spec.profile.kind, id);
    if (id && announce) {
      this.sound.select();
      this.toast(`Selected ${this.info.nameOf(this.spec.profile.kind, id)}`);
    }
    $("hud-hint").textContent = id
      ? `${this.info.nameOf(this.spec.profile.kind, id)} selected — pinch to pull it out`
      : "Point at a part to inspect it";
  }

  private handlePinch(): void {
    const id = this.selection.selectedId ?? this.selection.hoveredId;
    if (!id) {
      this.toast("Pinch with a component selected to pull it out");
      return;
    }
    if (this.exploded.isolatedId === id) {
      this.exploded.isolate(null);
      this.toast(`Returned ${this.info.nameOf(this.spec.profile.kind, id)}`);
    } else {
      this.selectComponent(id, false);
      this.exploded.isolate(id);
      this.sound.select();
      this.toast(`Pulled out ${this.info.nameOf(this.spec.profile.kind, id)} — rotate and zoom to inspect`);
    }
  }

  private handleConfirm(): void {
    this.sound.confirm();
    if (this.pendingAction) {
      this.toast(`Confirmed: ${this.pendingAction}`);
      this.pendingAction = null;
      return;
    }
    // With nothing pending, thumbs up locks in the current view as the new rest state.
    const id = this.selection.selectedId;
    this.toast(id ? `Confirmed — ${this.info.nameOf(this.spec.profile.kind, id)} locked in` : "Confirmed — current view locked in");
  }

  /* ───────────────────────── UI binding ───────────────────────── */

  private bindUi(): void {
    this.info.bind((id) => {
      this.selectComponent(id);
      this.pendingAction = `select ${this.info.nameOf(this.spec.profile.kind, id)}`;
    });

    /* camera */
    $("btn-camera-start").addEventListener("click", () => void this.startCamera());
    $("btn-camera-stop").addEventListener("click", () => this.stopCamera());

    /* explode */
    const slider = $<HTMLInputElement>("explode-slider");
    slider.addEventListener("input", () => {
      this.exploded.setAmount(Number(slider.value) / 100);
      this.syncExplodeUi();
    });
    $("btn-explode").addEventListener("click", () => {
      this.exploded.explode();
      this.sound.explode();
      this.syncExplodeUi();
      this.pendingAction = "explode the aircraft";
    });
    $("btn-assemble").addEventListener("click", () => {
      this.exploded.assemble();
      this.sound.assemble();
      this.syncExplodeUi();
      this.pendingAction = "reassemble the aircraft";
    });
    $("btn-reset").addEventListener("click", () => {
      this.exploded.assemble();
      this.exploded.isolate(null);
      this.scene.resetView();
      this.selectComponent(null);
      this.syncExplodeUi();
      this.toast("Aircraft reset");
    });

    /* isolate / return */
    $("btn-isolate").addEventListener("click", () => {
      const id = this.selection.selectedId;
      if (!id) return;
      this.exploded.isolate(id);
      this.sound.select();
      this.toast(`Pulled out ${this.info.nameOf(this.spec.profile.kind, id)}`);
    });
    $("btn-return").addEventListener("click", () => {
      this.exploded.isolate(null);
      this.toast("Part returned");
    });

    /* gesture toggle */
    const toggle = $<HTMLInputElement>("toggle-gestures");
    toggle.addEventListener("change", () => {
      this.settings.set("gesturesEnabled", toggle.checked);
      this.gestures.setEnabled(toggle.checked);
      $("hud-mode").textContent = `Gestures: ${toggle.checked ? "on" : "off"}`;
      if (!toggle.checked) this.scene.setCursor(null);
      this.toast(toggle.checked ? "Gesture interaction enabled" : "Gesture interaction disabled — manual controls only");
    });

    /* manual controls — these deliberately drive the SAME scene API as gestures,
       so they can never conflict: both write to the damped camera targets. */
    document.querySelectorAll<HTMLButtonElement>("[data-manual]").forEach((btn) => {
      btn.addEventListener("click", () => this.manual(btn.dataset.manual!));
    });

    /* mouse drag + wheel on the viewport */
    const vp = $("viewport");
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;
    vp.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      vp.setPointerCapture(e.pointerId);
    });
    vp.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX;
      lastY = e.clientY;
      this.scene.orbit(dx * 0.008, dy * 0.006);
    });
    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      vp.releasePointerCapture?.(e.pointerId);
      // A click (not a drag) picks a component.
      if (moved < 5 && this.built) {
        const r = vp.getBoundingClientRect();
        const hit = this.scene.pick(
          (e.clientX - r.left) / r.width,
          (e.clientY - r.top) / r.height,
          this.selection.pickTargets,
        );
        const id = (hit?.object.userData.componentId as string | undefined) ?? null;
        this.selectComponent(id);
      }
    };
    vp.addEventListener("pointerup", endDrag);
    vp.addEventListener("pointercancel", endDrag);
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.scene.zoomBy(e.deltaY > 0 ? 1.08 : 0.926);
      },
      { passive: false },
    );

    /* keyboard */
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const map: Record<string, string> = {
        w: "up", arrowup: "up",
        s: "down", arrowdown: "down",
        a: "left", arrowleft: "left",
        d: "right", arrowright: "right",
        "+": "zoom-in", "=": "zoom-in",
        "-": "zoom-out", _: "zoom-out",
        r: "center",
      };
      const key = e.key.toLowerCase();
      if (map[key]) {
        e.preventDefault();
        this.manual(map[key]);
        return;
      }
      if (key === "e") { this.exploded.explode(); this.sound.explode(); this.syncExplodeUi(); }
      if (key === "q") { this.exploded.assemble(); this.sound.assemble(); this.syncExplodeUi(); }
      if (key === "n") void this.cycleAircraft();
      if (key === "escape") this.closeSheet();
    });

    /* nav + sheets */
    document.querySelectorAll<HTMLElement>("[data-nav]").forEach((n) => {
      n.addEventListener("click", (e) => {
        e.preventDefault();
        this.openView(n.dataset.nav!);
      });
    });
    $("sheet-close").addEventListener("click", () => this.closeSheet());
    $("sheet").addEventListener("click", (e) => {
      if (e.target === $("sheet")) this.closeSheet();
    });
    document.addEventListener("calibration:reset", () => {
      this.applySettings();
      this.openView("calibration");
    });

    /* sound + fullscreen */
    const soundBtn = $("btn-sound");
    soundBtn.addEventListener("click", () => {
      const on = !this.sound.isEnabled;
      this.sound.setEnabled(on);
      this.settings.set("sound", on);
      soundBtn.setAttribute("aria-pressed", String(on));
      soundBtn.textContent = on ? "🔊" : "🔇";
      if (on) this.sound.confirm();
    });
    $("btn-fullscreen").addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => {});
    });

    /* release the camera when the tab is hidden for real */
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && this.camera.isActive) {
        this.stopCamera();
        this.toast("Camera released while the tab was hidden");
      }
    });
  }

  private manual(action: string): void {
    const step = 0.22;
    switch (action) {
      case "up": this.scene.orbit(0, -step); break;
      case "down": this.scene.orbit(0, step); break;
      case "left": this.scene.orbit(-step, 0); break;
      case "right": this.scene.orbit(step, 0); break;
      case "zoom-in": this.scene.zoomBy(0.85); break;
      case "zoom-out": this.scene.zoomBy(1.18); break;
      case "center": this.scene.resetView(); break;
    }
  }

  /* ───────────────────────── camera control ───────────────────────── */

  private async startCamera(): Promise<void> {
    const startBtn = $<HTMLButtonElement>("btn-camera-start");
    const stopBtn = $<HTMLButtonElement>("btn-camera-stop");
    const errBox = $("camera-error");

    startBtn.disabled = true;
    errBox.hidden = true;
    $("track-status").textContent = "Requesting camera permission…";
    $("track-dot").dataset.state = "searching";

    try {
      await this.camera.start();
      $("track-status").textContent = "Loading hand tracking model…";
      await this.tracking.load();
      await this.tracking.setConfidence(this.settings.get().detectionConfidence);
      this.tracking.start();

      $("camera-stage").dataset.state = "live";
      stopBtn.disabled = false;
      $("track-dot").dataset.state = "searching";
      $("track-status").textContent = "Camera live — show a hand";
      $("camera-placeholder").querySelector("span")!.textContent = "Camera live";
      this.toast("Camera live — your feed stays on your device");
    } catch (e) {
      const err = e as CameraError & { message: string };
      errBox.textContent = err.message ?? String(e);
      errBox.hidden = false;
      $("track-dot").dataset.state = "error";
      $("track-status").textContent = "Camera unavailable — manual controls active";
      startBtn.disabled = false;
      this.camera.stop();
      this.toast("Camera unavailable — use the manual controls");
    }
  }

  private stopCamera(): void {
    this.tracking.stop();
    this.camera.stop();
    this.gestures.reset();
    $("camera-stage").dataset.state = "idle";
    $("camera-placeholder").querySelector("span")!.textContent = "Camera off";
    $<HTMLButtonElement>("btn-camera-start").disabled = false;
    $<HTMLButtonElement>("btn-camera-stop").disabled = true;
    $("track-dot").dataset.state = "idle";
    $("track-status").textContent = "Idle — camera stopped";
    $("stat-vfps").textContent = "—";
    this.scene.setCursor(null);
    this.toast("Camera stopped and released");
  }

  /* ───────────────────────── views & chrome ───────────────────────── */

  private openView(view: string): void {
    document.querySelectorAll<HTMLElement>(".topnav__link").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.nav === view);
    });
    if (view === "explorer") {
      this.closeSheet();
      document.querySelector(".topnav__link")?.classList.add("is-active");
      return;
    }
    const content = $("sheet-content");
    content.replaceChildren(
      view === "guide"
        ? renderGuide()
        : view === "about"
          ? renderAbout()
          : renderCalibration(this.settings, () => this.lastGesture),
    );
    $("sheet").hidden = false;
  }

  private closeSheet(): void {
    $("sheet").hidden = true;
    $("sheet-content").replaceChildren();
    document.querySelectorAll<HTMLElement>(".topnav__link").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.nav === "explorer");
    });
  }

  private renderRail(): void {
    const rail = $("aircraft-rail");
    rail.replaceChildren();
    AIRCRAFT.forEach((a, i) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `selector__card${i === this.aircraftIndex ? " is-active" : ""}`;
      const cat = document.createElement("span");
      cat.className = "selector__cat";
      cat.textContent = a.category;
      const name = document.createElement("span");
      name.className = "selector__name";
      name.textContent = a.name;
      const meta = document.createElement("span");
      meta.className = "selector__meta";
      meta.textContent = `${a.specs.Length} · ${a.specs.Wingspan ?? ""}`.trim();
      card.append(cat, name, meta);
      card.addEventListener("click", () => void this.loadAircraft(i));
      rail.append(card);
    });
  }

  private syncExplodeUi(): void {
    const pct = Math.round(this.exploded.targetAmount * 100);
    const slider = $<HTMLInputElement>("explode-slider");
    if (document.activeElement !== slider) slider.value = String(pct);
    $("val-explode").textContent = `${pct}%`;
    $("hud-explode").textContent =
      pct === 0 ? "Assembled" : pct >= 98 ? "Fully exploded" : `Exploded ${pct}%`;
  }

  private toast(message: string): void {
    const t = $("toast");
    t.textContent = message;
    t.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      t.hidden = true;
    }, 2600);
  }

  /** Read/drive handle used by the automated e2e suite. */
  testHandle(): unknown {
    const self = this;
    return {
      scene: this.scene,
      exploded: this.exploded,
      selection: this.selection,
      gestures: this.gestures,
      tracking: this.tracking,
      camera: this.camera,
      get built() {
        return self.built;
      },
      get aircraftIndex() {
        return self.aircraftIndex;
      },
    };
  }

  private applySettings(): void {
    const s = this.settings.get();
    this.gestures.applySettings(s);
    this.gestures.setEnabled(s.gesturesEnabled);
    this.sound.setEnabled(s.sound);
    void this.tracking.setConfidence(s.detectionConfidence);

    const soundBtn = $("btn-sound");
    soundBtn.setAttribute("aria-pressed", String(s.sound));
    soundBtn.textContent = s.sound ? "🔊" : "🔇";
    $<HTMLInputElement>("toggle-gestures").checked = s.gesturesEnabled;
    $("hud-mode").textContent = `Gestures: ${s.gesturesEnabled ? "on" : "off"}`;

    this.settings.onChange((next) => {
      this.gestures.applySettings(next);
      void this.tracking.setConfidence(next.detectionConfidence);
      this.sound.setEnabled(next.sound);
    });
  }
}

/**
 * Test surface. The e2e suite drives the real modules through this handle:
 * it injects landmark frames into the gesture controller and reads scene,
 * exploded-view and selection state. It exposes no user data and performs no
 * network access, so it is harmless in production.
 */
declare global {
  interface Window {
    __gestureflight?: { ready: boolean; aircraftCount: number };
    __gf?: unknown;
  }
}

const app = new App();
window.__gestureflight = { ready: true, aircraftCount: AIRCRAFT.length };
window.__gf = app.testHandle();
void clamp;
