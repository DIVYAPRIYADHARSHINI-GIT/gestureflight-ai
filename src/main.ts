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

import * as THREE from "three";
import { AIRCRAFT, reconstructedAircraft } from "./data/aircraft";
import { ENGINE_PARTS, engineHierarchy } from "./data/engine";
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

/* ── upload / engine upgrade ── */
import {
  AircraftFileProcessor,
  ConversionRequiredError,
  FileValidationError,
  validate,
  type GeometrySource,
  type MeshImportResult,
  type ProgressReport,
} from "./modules/AircraftFileProcessor";
import { EngineExplorer } from "./modules/EngineExplorer";
import {
  MODES,
  ModeManager,
  QUALITY_PROFILES,
  type ExplorationMode,
  type QualityMode,
} from "./modules/ExplorationModes";
import { UploadPanel, type LibraryEntry } from "./modules/UploadPanel";

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

  /* ── upload / engine upgrade state ── */
  private processor = new AircraftFileProcessor();
  private upload = new UploadPanel();
  private engine = new EngineExplorer();
  private modes = new ModeManager();
  private library: LibraryEntry[] = [];
  private activeEntryId: string | null = null;
  /** Imported mesh currently shown in place of a built-in aircraft. */
  private importedMesh: MeshImportResult | null = null;
  private importedParts = new Map<string, { object: THREE.Object3D; home: THREE.Vector3; meshes: THREE.Mesh[]; name: string; namedInFile: boolean }>();
  private geometrySource: GeometrySource = "illustrative";
  private selectedEnginePart: string | null = null;
  private quality: QualityMode = "balanced";
  private clock = 0;
  private busy = false;
  /** The spec currently built — may be a reconstructed one, not just a built-in. */
  private activeSpec: (typeof AIRCRAFT)[number] | null = null;
  /** Holds a momentary gesture label visible for a moment after it fires. */
  private momentaryUntil = 0;

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
        // Context-aware (§7): the SAME gesture acts on whichever subject has
        // focus — aircraft, engine, or an isolated component.
        setExplode: (a) => {
          if (this.modes.subject === "engine") {
            this.engine.setExplode(a);
            this.syncEngineUi();
          } else {
            this.exploded.setAmount(a);
            this.syncExplodeUi();
          }
        },
        assemble: () => {
          if (this.modes.subject === "engine") {
            if (!this.engine.isAssembled && this.engine.explodeTargetAmount !== 0) this.sound.assemble();
            this.engine.assemble();
            this.syncEngineUi();
          } else {
            if (!this.exploded.isAssembled && this.exploded.targetAmount !== 0) this.sound.assemble();
            this.exploded.assemble();
            this.syncExplodeUi();
          }
        },
        orbit: (dy, dp) => this.scene.orbit(dy, dp),
        setRoll: (r) => this.scene.setRoll(r),
        setZoom: (t) => this.scene.setZoomNormalised(t),
        point: (nx, ny) => {
          this.pointerTarget = nx === null || ny === undefined ? null : { nx, ny };
          this.scene.setCursor(nx, ny);
        },
        pinchSelected: () => this.handlePinch(),
        nextAircraft: () => this.handlePeace(),
        confirm: () => this.handleConfirm(),
        report: (s) => this.renderGestureState(s),
        dragIsolated: (dx, dy) => this.dragIsolated(dx, dy),
        step: (dir) => this.stepComponent(dir),
      },
      this.settings.get(),
    );

    this.bindUi();
    this.bindUpgrade();
    this.applySettings();
    void this.loadAircraft(0, true);
    this.startLoop();
  }

  /* ───────────────────────── model lifecycle ───────────────────────── */

  private async loadAircraft(index: number, first = false): Promise<void> {
    this.aircraftIndex = index;
    await this.loadAircraftSpec(AIRCRAFT[index], "illustrative", first);
  }

  /**
   * Builds a procedural aircraft from any spec — the four built-ins, or one
   * reconstructed from blueprint dimensions. `source` records provenance so the
   * UI can label the geometry honestly (§2, §9).
   */
  private async loadAircraftSpec(
    spec: (typeof AIRCRAFT)[number],
    source: GeometrySource,
    first = false,
  ): Promise<void> {
    if (this.switching) return;
    this.switching = true;

    $("loading").hidden = false;
    $("loading-text").textContent = first ? "Building aircraft…" : `Building ${spec.name}…`;

    // Dispose whatever is currently displayed (§11 memory cleanup).
    if (this.built) {
      this.scene.modelPivot.remove(this.built.root);
      this.selection.dispose();
      this.built.dispose();
      this.built = null;
    }
    if (this.importedMesh) {
      this.scene.modelPivot.remove(this.importedMesh.root);
      this.importedMesh = null;
      this.importedParts.clear();
    }

    // Yield a frame so the loading overlay actually paints before the build.
    await new Promise((r) => requestAnimationFrame(r));

    const built = await this.loader.build(spec);
    this.built = built;
    this.activeSpec = spec;
    this.geometrySource = source;
    this.scene.modelPivot.add(built.root);
    built.root.visible = this.modes.subject !== "engine";
    this.scene.frameModel(built.radius);

    this.exploded.setModel(built.components, built.radius);
    this.selection.setModel(built.components);
    this.info.renderAircraft(spec);
    this.info.renderComponent(spec.profile.kind, null);

    this.renderRail();
    this.syncExplodeUi();
    this.updateProvenance();
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
    return this.activeSpec ?? AIRCRAFT[this.aircraftIndex];
  }

  /* ───────────────────────── render loop ───────────────────────── */

  private startLoop(): void {
    this.scene.start((dt) => {
      this.clock += dt;
      this.exploded.update(dt);
      this.selection.update(dt);
      this.engine.update(dt, this.clock);
      // Keep separated components inside the viewport as the model explodes.
      this.scene.setExplodeFraming(
        this.modes.subject === "engine" ? this.engine.explodeAmount : this.exploded.amount,
      );

      // Resolve the pointing cursor into a hover — routed by active context (§7).
      if (this.pointerTarget) {
        if (this.modes.subject === "engine" && this.engine.isBuilt) {
          const hit = this.scene.pick(this.pointerTarget.nx, this.pointerTarget.ny, this.engine.pickTargets);
          const id = (hit?.object.userData.enginePartId as string | undefined) ?? null;
          if (id && id !== this.selectedEnginePart) this.selectEnginePart(id);
        } else if (this.importedMesh) {
          const targets = [...this.importedParts.values()].map((p) => p.object);
          const hit = this.scene.pick(this.pointerTarget.nx, this.pointerTarget.ny, targets);
          const id = (hit?.object.userData.importedPartId as string | undefined) ?? null;
          const active = document.querySelector<HTMLButtonElement>("#component-list button.is-active");
          if (id && id !== active?.dataset.importedPartId) this.selectImportedPart(id);
        } else if (this.built) {
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

    // Momentary gestures (swipe, pinch-drag) occupy a single frame, so without
    // a short hold the label would be overwritten before the user can read it.
    const momentary = s.gesture === "swipe_left" || s.gesture === "swipe_right" || s.gesture === "pinch_drag";
    const now = performance.now();
    if (momentary) this.momentaryUntil = now + 1100;
    const suppressed = !momentary && now < this.momentaryUntil;

    if (!suppressed) {
      $("gesture-glyph").textContent = meta.glyph;
      $("gesture-name").textContent = meta.name;
      $("gesture-action").textContent = meta.action;
      $("gesture-card").dataset.active = s.gesture === "none" ? "false" : "true";
    }

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

    if (s.context && !suppressed && s.gesture !== "none") {
      $("gesture-action").textContent = `${meta.action} · ${s.context}`;
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
    // Engine context: pinch isolates the selected ENGINE part (§7).
    if (this.modes.subject === "engine") {
      const id = this.selectedEnginePart;
      if (!id) {
        this.toast("Select an engine part first, then pinch to pull it out");
        return;
      }
      const name = this.engine.nodes.get(id)?.spec.name ?? "part";
      if (this.engine.isolatedId === id) {
        this.engine.isolate(null);
        this.toast(`Returned ${name}`);
      } else {
        this.engine.isolate(id);
        this.sound.select();
        this.toast(`Pulled out ${name} — pinch and move to reposition it`);
      }
      this.syncGestureContext();
      return;
    }

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
    this.syncGestureContext();
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

  /* ═══════════════ upload / engine upgrade ═══════════════ */

  /** Mounts the upload panel, mode rail and engine controls. */
  private bindUpgrade(): void {
    this.scene.scene.add(this.engine.root);

    this.upload.mount($("upload-mount"), {
      onFiles: (files) => void this.handleFiles(files),
      onSelectEntry: (id) => void this.activateEntry(id),
      onRemoveEntry: (id) => this.removeEntry(id),
      onReconstruct: (dims) => void this.reconstructFromBlueprint(dims),
      onUseGenerated: () => void this.useGeneratedFallback(),
    });

    /* whole-stage drag & drop */
    const drop = $("stage-drop");
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      drop.hidden = false;
    });
    window.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) drop.hidden = true;
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      drop.hidden = true;
      if (e.dataTransfer?.files?.length) void this.handleFiles(e.dataTransfer.files);
    });

    /* mode rail */
    this.renderModeRail();
    this.modes.onChange((mode, previous) => this.onModeChange(mode, previous));

    /* quality rail */
    const qRail = $("quality-rail");
    for (const q of Object.values(QUALITY_PROFILES)) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q.label;
      b.dataset.quality = q.id;
      b.addEventListener("click", () => this.setQuality(q.id));
      qRail.append(b);
    }
    this.setQuality(this.quality);

    /* engine controls */
    $("btn-engine-enter").addEventListener("click", () => this.modes.set("engine"));
    $("btn-engine-exit").addEventListener("click", () => this.modes.set("exterior"));
    $("btn-engine-explode").addEventListener("click", () => {
      this.engine.explode();
      this.sound.explode();
      this.syncEngineUi();
    });
    $("btn-engine-assemble").addEventListener("click", () => {
      this.engine.assemble();
      this.sound.assemble();
      this.syncEngineUi();
    });
    const eSlider = $<HTMLInputElement>("engine-explode-slider");
    eSlider.addEventListener("input", () => {
      this.engine.setExplode(Number(eSlider.value) / 100);
      this.syncEngineUi();
    });
    $<HTMLInputElement>("toggle-cutaway").addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.engine.setCutaway(on);
      this.modes.set(on ? "cutaway" : "engine");
      this.renderEngineTree();
      this.toast(on ? "Cutaway: outer casings hidden" : "Cutaway off");
    });
    $<HTMLInputElement>("toggle-airflow").addEventListener("change", (e) => {
      this.engine.setAirflow((e.target as HTMLInputElement).checked);
    });
    $("btn-engine-showall").addEventListener("click", () => {
      this.engine.showAll();
      this.renderEngineTree();
      this.toast("All engine parts visible");
    });

    this.updateProvenance();
  }

  private renderModeRail(): void {
    const rail = $("mode-rail");
    rail.replaceChildren();
    for (const m of MODES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = m.short;
      b.title = m.hint;
      b.dataset.mode = m.id;
      b.disabled = !this.modes.isAvailable(m.id);
      b.classList.toggle("is-active", this.modes.mode === m.id);
      b.addEventListener("click", () => this.modes.set(m.id));
      rail.append(b);
    }
    $("mode-hint").textContent = this.modes.spec.hint;
    $("hud-exploration").textContent = this.modes.spec.label;
  }

  /**
   * Mode switching only changes visibility and gesture routing — the renderer,
   * camera and webcam tracking are untouched (§8).
   */
  private onModeChange(mode: ExplorationMode, previous: ExplorationMode): void {
    const spec = this.modes.spec;

    if (spec.subject === "engine") {
      if (!this.engine.isBuilt) {
        // Lazy build on first entry (§11).
        $("loading").hidden = false;
        $("loading-text").textContent = "Building engine model…";
        this.engine.build();
        $("loading").hidden = true;
      }
      this.engine.setVisible(true);
      this.engine.setCutaway(mode === "cutaway");
      if (this.built) this.built.root.visible = false;
      if (this.importedMesh) this.importedMesh.root.visible = false;
      $("engine-controls").hidden = false;
      $<HTMLButtonElement>("btn-engine-exit").disabled = false;
      $<HTMLButtonElement>("btn-engine-enter").disabled = true;
      $<HTMLInputElement>("toggle-cutaway").checked = mode === "cutaway";
      this.scene.frameModel(11);
      this.renderEngineTree();
      this.selectEnginePart(this.selectedEnginePart ?? "fan");
    } else {
      this.engine.setVisible(false);
      $("engine-controls").hidden = true;
      $<HTMLButtonElement>("btn-engine-exit").disabled = true;
      $<HTMLButtonElement>("btn-engine-enter").disabled = false;
      if (this.importedMesh) this.importedMesh.root.visible = true;
      else if (this.built) this.built.root.visible = true;
      if (this.built) this.scene.frameModel(this.built.radius);

      if (mode === "exploded") this.exploded.explode();
      if (mode === "exterior" && previous === "exploded") this.exploded.assemble();
      this.syncExplodeUi();
      if (!this.importedMesh) {
        this.info.renderComponent(this.spec.profile.kind, this.selection.selectedId);
      }
    }

    this.renderModeRail();
    this.syncGestureContext();
    this.toast(`${spec.label} — ${spec.hint}`);
  }

  private syncGestureContext(): void {
    const hasIsolated =
      this.modes.subject === "engine"
        ? this.engine.isolatedId !== null
        : this.exploded.isolatedId !== null;
    this.gestures.setContext({ subject: this.modes.subject, hasIsolated });
  }

  private setQuality(q: QualityMode): void {
    this.quality = q;
    const p = QUALITY_PROFILES[q];
    this.scene.applyQuality(p);
    document.querySelectorAll<HTMLButtonElement>("#quality-rail button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.quality === q);
    });
    $("quality-hint").textContent = p.description;
  }

  /* ───────── file handling ───────── */

  /**
   * Handles one OR MANY files (§5). Each is processed in sequence so progress
   * stays readable and memory never spikes; the last 3D model becomes active,
   * and every successful import stays in the library to be combined or swapped.
   */
  private async handleFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    if (!list.length || this.busy) return;
    if (list.length > 1) {
      this.busy = true;
      try {
        const ok: string[] = [];
        const failed: string[] = [];
        for (const f of list) {
          const result = await this.processOne(f, `${ok.length + failed.length + 1}/${list.length}`);
          (result ? ok : failed).push(f.name);
        }
        this.upload.hideProgress();
        if (ok.length) this.sound.confirm();
        this.toast(
          failed.length
            ? `Loaded ${ok.length} of ${list.length} files — ${failed.length} could not be used`
            : `Loaded all ${ok.length} files into the model library`,
        );
      } finally {
        this.busy = false;
      }
      return;
    }

    const file = list[0];
    this.busy = true;
    this.upload.clearError();
    try {
      if (await this.processOne(file)) {
        this.upload.hideProgress();
        this.sound.confirm();
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Validates + parses a single file and adds it to the library.
   * @returns true when it genuinely produced geometry or blueprint pages.
   */
  private async processOne(file: File, counter = ""): Promise<boolean> {
    let spec;
    try {
      spec = validate(file);
    } catch (e) {
      // A "requires conversion" file is identified correctly, not a failure of
      // validation — it gets guidance, never a fake successful load (§3).
      if (e instanceof ConversionRequiredError) {
        this.upload.showConversionNotice(e);
        return false;
      }
      this.upload.showError((e as FileValidationError).message);
      return false;
    }

    this.upload.showProgress(`${counter ? counter + "  " : ""}${file.name}`, spec, file.size, null);
    try {
      const result = await this.processor.process(file, spec, (r: ProgressReport) =>
        this.upload.showProgress(`${counter ? counter + "  " : ""}${file.name}`, spec!, file.size, r),
      );
      const entry: LibraryEntry = {
        id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        format: spec.id,
        bytes: file.size,
        kind: result.kind,
        result,
      };
      this.library.push(entry);
      await this.activateEntry(entry.id);
      return true;
    } catch (e) {
      this.upload.showError(
        e instanceof FileValidationError
          ? e.message
          : `Could not process "${file.name}": ${(e as Error).message}`,
      );
      return false;
    }
  }

  private async activateEntry(id: string): Promise<void> {
    const entry = this.library.find((e) => e.id === id);
    if (!entry) return;
    this.activeEntryId = id;

    if (entry.result.kind === "blueprint") {
      this.modes.setAvailable("blueprint", true);
      this.upload.showBlueprint(entry.result);
      this.modes.set("blueprint");
      this.upload.renderLibrary(this.library, id);
      this.toast(`${entry.name} — blueprint loaded. Use assisted reconstruction to build 3D.`);
      return;
    }

    await this.showImportedMesh(entry.result);
    this.upload.renderLibrary(this.library, id);
  }

  /** Swaps the imported geometry into the existing scene (§4 source of truth). */
  private async showImportedMesh(mesh: MeshImportResult): Promise<void> {
    // Tear down whatever is currently displayed, releasing GPU resources (§11).
    if (this.built) {
      this.scene.modelPivot.remove(this.built.root);
      this.selection.dispose();
      this.built.dispose();
      this.built = null;
    }
    if (this.importedMesh && this.importedMesh !== mesh) {
      this.scene.modelPivot.remove(this.importedMesh.root);
      this.importedMesh = null;
    }

    this.importedMesh = mesh;
    this.importedParts.clear();
    this.scene.modelPivot.add(mesh.root);
    mesh.root.visible = true;

    const box = new THREE.Box3().setFromObject(mesh.root);
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    this.scene.frameModel(radius || 10);

    for (const part of mesh.parts) {
      const meshes: THREE.Mesh[] = [];
      part.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.userData.importedPartId = part.id;
          meshes.push(m);
        }
      });
      this.importedParts.set(part.id, {
        object: part.object,
        home: part.object.position.clone(),
        meshes,
        name: part.name,
        namedInFile: part.namedInFile,
      });
    }

    this.geometrySource = mesh.source;
    this.exploded.setModel(new Map(), radius || 10);
    this.selection.setModel(new Map());
    this.renderImportedInfo(mesh);
    this.renderImportedComponentList(mesh);
    this.updateProvenance();
    if (this.modes.mode !== "exterior") this.modes.set("exterior");
    this.toast(`${mesh.format.toUpperCase()} loaded — ${UploadPanel.describeMesh(mesh)}`);
  }

  private renderImportedInfo(mesh: MeshImportResult): void {
    const entry = this.library.find((e) => e.id === this.activeEntryId);
    $("aircraft-name").textContent = entry?.name ?? "Uploaded design";
    $("aircraft-role").textContent = `${mesh.format.toUpperCase()} import · ${mesh.parts.length} object(s)`;

    const dl = $("aircraft-specs");
    dl.replaceChildren();
    const rows: Array<[string, string]> = [
      ["Original file", entry?.name ?? "—"],
      ["Format", mesh.format.toUpperCase()],
      ["File size", entry ? `${(entry.bytes / 1024 / 1024).toFixed(2)} MB` : "—"],
      ["Triangles", mesh.triangles.toLocaleString()],
      ["Vertices", mesh.vertices.toLocaleString()],
      ["Objects", String(mesh.parts.length)],
      [
        "Model extent",
        `${mesh.size.x.toFixed(1)} × ${mesh.size.y.toFixed(1)} × ${mesh.size.z.toFixed(1)}`,
      ],
      ["Units", mesh.unitsKnown ? "recorded in file" : "not recorded by this format"],
      ["Geometry source", "Imported from your file"],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }

    // §9/§16: say plainly whether the file carried separate components.
    // Surface parser + segmentation findings honestly (§4, §7).
    const notes: string[] = [];
    if (mesh.parserNote) notes.push(mesh.parserNote);
    if (mesh.segmentationNote) notes.push(mesh.segmentationNote);
    $("aircraft-disclaimer").textContent = notes.length
      ? notes.join(" ")
      : mesh.hasSeparateComponents
      ? `This file contains ${mesh.parts.length} separate objects, ${mesh.parts.filter((p) => p.namedInFile).length} of which are named in the file. Component names come from your file, not from GestureFlight. This format does not record real-world units, so extents are shown in the file's own units rather than converted to metres.`
      : `This file is a SINGLE MESH with no separate component information, so GestureFlight cannot extract individual aircraft components from it. The whole model can be rotated, zoomed and inspected as one object. Use a STEP or GLB file with named sub-assemblies for per-component exploration.`;
  }

  private renderImportedComponentList(mesh: MeshImportResult): void {
    const ul = $("component-list");
    ul.replaceChildren();
    for (const part of mesh.parts) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.importedPartId = part.id;
      const label = document.createElement("span");
      label.textContent = part.name;
      const meta = document.createElement("span");
      meta.className = "complist__qty";
      meta.textContent = part.namedInFile ? "named" : `${part.triangles.toLocaleString()}▲`;
      btn.append(label, meta);
      btn.addEventListener("click", () => this.selectImportedPart(part.id));
      li.append(btn);
      ul.append(li);
    }
    $("component-count").textContent = mesh.hasSeparateComponents
      ? `${mesh.parts.length} object(s) from your file`
      : "1 object — single mesh, no separate components";
  }

  private selectImportedPart(id: string): void {
    const part = this.importedParts.get(id);
    if (!part) return;
    document.querySelectorAll<HTMLButtonElement>("#component-list button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.importedPartId === id);
    });

    for (const [pid, p] of this.importedParts) {
      for (const m of p.meshes) {
        if (!m.userData.__origMat) m.userData.__origMat = m.material;
        if (pid === id) {
          if (!m.userData.__hlMat) {
            const src = m.userData.__origMat as THREE.Material;
            const c = (Array.isArray(src) ? src[0] : src).clone() as THREE.MeshStandardMaterial;
            if ("emissive" in c) {
              c.emissive = new THREE.Color(0x38e1f0);
              c.emissiveIntensity = 0.65;
            }
            m.userData.__hlMat = c;
          }
          m.material = m.userData.__hlMat as THREE.Material;
        } else {
          m.material = m.userData.__origMat as THREE.Material;
        }
      }
    }

    $("component-name").textContent = part.name;
    $("component-hint").hidden = true;
    $("component-body").hidden = false;
    $("component-category").textContent = part.namedInFile ? "Named in your file" : "Unnamed object";
    $("component-description").textContent = part.namedInFile
      ? `"${part.name}" is an object defined in your uploaded file. GestureFlight shows its real imported geometry and does not rename or reinterpret it.`
      : "This object has no name in your uploaded file, so GestureFlight has labelled it by index. Its geometry is exactly as imported.";
    $("component-function").textContent =
      "Function is not recorded in CAD or mesh files. GestureFlight does not guess what an imported object does — only the four built-in aircraft carry educational component descriptions.";
    $("component-location").textContent = "Position is as defined in your file's own coordinate system.";

    const dl = $("component-specs");
    dl.replaceChildren();
    const size = new THREE.Box3().setFromObject(part.object).getSize(new THREE.Vector3());
    for (const [k, v] of [
      ["Geometry source", "Imported"],
      ["Named in file", part.namedInFile ? "Yes" : "No"],
      ["Meshes", String(part.meshes.length)],
      ["Extent (file units)", `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`],
    ] as Array<[string, string]>) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }
    this.sound.select();
  }

  private removeEntry(id: string): void {
    const i = this.library.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [entry] = this.library.splice(i, 1);

    if (entry.result.kind === "mesh3d" && this.importedMesh === entry.result) {
      this.scene.modelPivot.remove(entry.result.root);
      this.importedMesh = null;
      this.importedParts.clear();
    }
    if (entry.result.kind === "blueprint") {
      this.upload.hideBlueprint();
      if (!this.library.some((e) => e.result.kind === "blueprint")) {
        this.modes.setAvailable("blueprint", false);
      }
    }
    entry.result.dispose();

    const wasActive = this.activeEntryId === id;
    if (wasActive) this.activeEntryId = null;
    this.upload.renderLibrary(this.library, this.activeEntryId);
    this.toast(`Removed ${entry.name} and released its memory`);
    if (wasActive) void this.loadAircraft(this.aircraftIndex, true);
  }

  private async reconstructFromBlueprint(dims: { length: number; span: number; height: number }): Promise<void> {
    if (this.importedMesh) {
      this.scene.modelPivot.remove(this.importedMesh.root);
      this.importedMesh = null;
      this.importedParts.clear();
    }
    await this.loadAircraftSpec(reconstructedAircraft(dims), "reconstructed");
    this.modes.set("exterior");
    this.toast(`Reconstructed from ${dims.length} × ${dims.span} × ${dims.height} m — proportional, not measured`);
  }

  private async useGeneratedFallback(): Promise<void> {
    if (this.importedMesh) {
      this.scene.modelPivot.remove(this.importedMesh.root);
      this.importedMesh = null;
      this.importedParts.clear();
    }
    await this.loadAircraft(0, true);
    this.toast("Using a generated illustrative aircraft alongside your blueprint");
  }

  private updateProvenance(): void {
    $("hud-source").textContent =
      this.geometrySource === "imported"
        ? "Imported geometry"
        : this.geometrySource === "reconstructed"
          ? "Reconstructed geometry"
          : "Illustrative geometry";

    // §6: the engine is ALWAYS the illustrative educational model — an external
    // nacelle shape has no internals to extract, and we say so.
    const box = $("engine-provenance");
    box.dataset.source = "illustrative";
    box.textContent = this.importedMesh
      ? "Your uploaded file provides the aircraft geometry, but it does not contain internal engine parts — an external nacelle shape has no internals to extract. The Engine Explorer therefore loads a separate ILLUSTRATIVE educational turbofan, generated procedurally. It is not derived from your design."
      : "The Engine Explorer uses an ILLUSTRATIVE educational turbofan, generated procedurally to show how a two-spool high-bypass engine is laid out. It is not a model of any specific real engine and carries no real performance data.";
  }

  /* ───────── engine explorer ───────── */

  private renderEngineTree(): void {
    const tree = $("engine-tree");
    tree.replaceChildren();
    for (const [parent, parts] of engineHierarchy()) {
      const group = document.createElement("div");
      group.className = "tree__group";
      const label = document.createElement("div");
      label.className = "tree__label";
      label.textContent = parent;
      group.append(label);

      for (const p of parts) {
        const row = document.createElement("div");
        row.className = "tree__row";

        const main = document.createElement("button");
        main.type = "button";
        main.className = "tree__main";
        main.textContent = p.name;
        main.dataset.enginePartId = p.id;
        main.classList.toggle("is-active", this.selectedEnginePart === p.id);
        main.addEventListener("click", () => this.selectEnginePart(p.id));

        const eye = document.createElement("button");
        eye.type = "button";
        eye.className = "tree__eye";
        const visible = this.engine.isVisible(p.id);
        eye.textContent = visible ? "👁" : "🚫";
        eye.dataset.hidden = String(!visible);
        eye.title = `${visible ? "Hide" : "Show"} ${p.name}`;
        eye.setAttribute("aria-label", eye.title);
        eye.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.engine.toggleVisibility(p.id);
          this.renderEngineTree();
        });

        row.append(main, eye);
        group.append(row);
      }
      tree.append(group);
    }
  }

  private selectEnginePart(id: string): void {
    const node = this.engine.nodes.get(id);
    if (!node) return;
    this.selectedEnginePart = id;
    const spec = node.spec;

    for (const [pid, n] of this.engine.nodes) {
      for (const m of n.meshes) {
        if (!m.userData.__origMat) m.userData.__origMat = m.material;
        if (pid === id) {
          if (!m.userData.__hlMat) {
            const src = m.userData.__origMat as THREE.Material;
            const c = (Array.isArray(src) ? src[0] : src).clone() as THREE.MeshStandardMaterial;
            if ("emissive" in c) {
              c.emissive = new THREE.Color(0x38e1f0);
              c.emissiveIntensity = 0.6;
            }
            m.userData.__hlMat = c;
          }
          m.material = m.userData.__hlMat as THREE.Material;
        } else {
          m.material = m.userData.__origMat as THREE.Material;
        }
      }
    }

    $("component-name").textContent = spec.name;
    $("component-hint").hidden = true;
    $("component-body").hidden = false;
    $("component-category").textContent = `${spec.parent} · ${spec.stage}`;
    $("component-description").textContent = spec.description;
    $("component-function").textContent = spec.fn;
    $("component-location").textContent = `Part of the ${spec.parent}, at roughly ${Math.round(spec.axial * 100)}% of the way from the intake face to the nozzle exit.`;

    const dl = $("component-specs");
    dl.replaceChildren();
    for (const [k, v] of Object.entries(spec.notes)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }

    document.querySelectorAll<HTMLButtonElement>("#engine-tree .tree__main").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.enginePartId === id);
    });
    $("hud-hint").textContent = `${spec.name} — pinch to pull it out`;
    this.sound.select();
  }

  private syncEngineUi(): void {
    const pct = Math.round(this.engine.explodeTargetAmount * 100);
    const slider = $<HTMLInputElement>("engine-explode-slider");
    if (document.activeElement !== slider) slider.value = String(pct);
    $("val-engine-explode").textContent = `${pct}%`;
    if (this.modes.subject === "engine") {
      $("hud-explode").textContent =
        pct === 0 ? "Engine assembled" : pct >= 98 ? "Engine fully exploded" : `Engine exploded ${pct}%`;
    }
  }

  /* ───────── shared gesture helpers ───────── */

  /** Peace sign: cycles mode in engine context, aircraft otherwise (§7). */
  private handlePeace(): void {
    if (this.modes.subject === "engine") {
      this.modes.cycle(1);
      this.sound.switchAircraft();
    } else {
      void this.cycleAircraft();
    }
  }

  /** Swipe: steps through the component list of whatever is in focus (§7). */
  private stepComponent(direction: 1 | -1): void {
    if (this.modes.subject === "engine") {
      const ids = ENGINE_PARTS.map((p) => p.id);
      const i = ids.indexOf(this.selectedEnginePart ?? ids[0]);
      const next = ids[(i + direction + ids.length) % ids.length];
      this.selectEnginePart(next);
      this.toast(`${direction > 0 ? "▶" : "◀"} ${this.engine.nodes.get(next)?.spec.name ?? ""}`);
      return;
    }

    if (this.importedMesh) {
      const ids = [...this.importedParts.keys()];
      if (!ids.length) return;
      const current = document.querySelector<HTMLButtonElement>("#component-list button.is-active");
      const i = ids.indexOf(current?.dataset.importedPartId ?? ids[0]);
      const next = ids[(i + direction + ids.length) % ids.length];
      this.selectImportedPart(next);
      this.toast(`${direction > 0 ? "▶" : "◀"} ${this.importedParts.get(next)?.name ?? ""}`);
      return;
    }

    const ids = [...(this.built?.components.keys() ?? [])];
    if (!ids.length) return;
    const i = ids.indexOf(this.selection.selectedId ?? ids[0]);
    this.selectComponent(ids[(i + direction + ids.length) % ids.length]);
  }

  /** Pinch + move: translates the isolated component (§7). */
  private dragIsolated(dx: number, dy: number): void {
    const scale = this.scene.orbitState.dist * 0.9;
    const delta = new THREE.Vector3(dx * scale, dy * scale, 0);
    if (this.modes.subject === "engine") {
      const id = this.engine.isolatedId;
      const node = id ? this.engine.nodes.get(id) : null;
      node?.group.position.add(delta);
      return;
    }
    const id = this.exploded.isolatedId;
    const node = id ? this.built?.components.get(id) : null;
    node?.group.position.add(delta);
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
      /* ── upload / engine upgrade ── */
      engine: this.engine,
      modes: this.modes,
      processor: this.processor,
      get library() {
        return self.library;
      },
      get importedMesh() {
        return self.importedMesh;
      },
      get importedParts() {
        return self.importedParts;
      },
      get geometrySource() {
        return self.geometrySource;
      },
      get selectedEnginePart() {
        return self.selectedEnginePart;
      },
      get quality() {
        return self.quality;
      },
      handleFiles: (files: FileList | File[]) => self.handleFiles(files),
      selectEnginePart: (id: string) => self.selectEnginePart(id),
      stepComponent: (d: 1 | -1) => self.stepComponent(d),
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
