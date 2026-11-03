/**
 * views.ts — the Gesture Guide, Calibration and About overlay sheets.
 * Rendered into #sheet-content; all values are bound to SettingsManager.
 */

import { GESTURE_SEQUENCE, GESTURES } from "./GestureRecognition";
import type { SettingsManager } from "./SettingsManager";
import type { GestureId, Settings } from "../types";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
};

export function renderGuide(): HTMLElement {
  const root = el("div");
  root.append(
    el("h2", { textContent: "Gesture Guide" }),
    el("p", {
      textContent:
        "Eight gestures drive the whole aircraft explorer. Hold a gesture steady for a few frames — the app debounces each one so a shaky hand cannot fire an action twice. Only one gesture is ever active at a time, and two-hand zoom overrides the one-hand gestures.",
    }),
  );

  const grid = el("div", { className: "gguide" });
  for (const id of GESTURE_SEQUENCE) {
    const g = GESTURES[id];
    grid.append(
      el("div", { className: "gcard" }, [
        el("span", { className: "gcard__glyph", textContent: g.glyph }),
        el("div", { className: "gcard__body" }, [
          el("strong", { textContent: `${g.name} — ${g.action}` }),
          el("span", { textContent: g.how }),
        ]),
      ]),
    );
  }
  root.append(grid);

  root.append(
    el("h3", { textContent: "Keyboard and mouse fallback" }),
    el("ul", {}, [
      el("li", { innerHTML: "Drag in the 3D view to orbit; scroll to zoom." }),
      el("li", { innerHTML: "<span class='kbd'>W</span> <span class='kbd'>A</span> <span class='kbd'>S</span> <span class='kbd'>D</span> or arrow keys to rotate." }),
      el("li", { innerHTML: "<span class='kbd'>+</span> / <span class='kbd'>−</span> to zoom, <span class='kbd'>R</span> to reset the view." }),
      el("li", { innerHTML: "<span class='kbd'>E</span> explode, <span class='kbd'>Q</span> assemble, <span class='kbd'>N</span> next aircraft." }),
      el("li", { innerHTML: "Click a part in the 3D view or in the Components list to select it." }),
    ]),
    el("h3", { textContent: "Tips for reliable recognition" }),
    el("ul", {}, [
      el("li", { textContent: "Sit 50–90 cm from the camera so your whole hand is in frame." }),
      el("li", { textContent: "Front-light your hand. Strong backlight (a bright window behind you) is the single most common cause of dropouts." }),
      el("li", { textContent: "Keep your palm roughly facing the camera — the classifier is rotation-tolerant but not fully side-on." }),
      el("li", { textContent: "If gestures feel twitchy, lower Gesture sensitivity in Calibration; if they feel unresponsive, raise it." }),
    ]),
  );
  return root;
}

export function renderAbout(): HTMLElement {
  const root = el("div");
  root.append(
    el("h2", { textContent: "About GestureFlight AI" }),
    el("div", {
      className: "privacy-banner",
      textContent:
        "Your camera feed stays on your device. No video is uploaded or recorded.",
    }),
    el("p", {
      textContent:
        "GestureFlight AI combines computer vision, real-time hand tracking, gesture recognition and interactive 3D engineering visualisation in a single browser page — no backend, no paid API, no cloud processing.",
    }),

    el("h3", { textContent: "How it works" }),
    el("ul", {}, [
      el("li", { textContent: "The webcam frame is read into Google's MediaPipe Hand Landmarker, compiled to WebAssembly and executed inside this tab." }),
      el("li", { textContent: "21 landmarks per hand are converted into scale-invariant features (finger extension, openness, pinch distance, palm roll), then classified into one of eight gestures." }),
      el("li", { textContent: "A stabiliser debounces the classification over several frames and applies a per-gesture cooldown, so one gesture produces exactly one action." }),
      el("li", { textContent: "Actions drive a Three.js scene: an orbit camera, a 0–1 exploded-view scalar, and raycast component picking." }),
    ]),

    el("h3", { textContent: "Privacy" }),
    el("ul", {}, [
      el("li", { textContent: "Camera permission is requested only when you press Start Camera." }),
      el("li", { textContent: "Frames are processed in memory and discarded. Nothing is uploaded, recorded or stored." }),
      el("li", { textContent: "Stop Camera calls stop() on every media track, which turns the camera light off. The app also releases the camera when the page is hidden or closed." }),
      el("li", { textContent: "No login, no account, no database, no analytics, no trackers. Only your calibration sliders are saved, in this browser's localStorage." }),
      el("li", { textContent: "The microphone is never requested." }),
    ]),

    el("h3", { textContent: "3D assets" }),
    el("ul", {}, [
      el("li", { textContent: "All four aircraft are generated procedurally from Three.js geometry at runtime — lofted NACA-profile aerofoils, lofted fuselage sections, modelled turbofans and oleo-pneumatic gear legs." }),
      el("li", { textContent: "No third-party 3D model is bundled, so there is no external asset licence to honour. The MediaPipe hand_landmarker model (Apache-2.0) is vendored locally." }),
    ]),

    el("h3", { textContent: "Data accuracy" }),
    el("p", {
      textContent:
        "Every aircraft and component figure in this app is illustrative, rounded, textbook-class data for a notional aircraft of that class. None of it is certified type data for a real registered aircraft, and it must not be used for any operational, maintenance or engineering purpose.",
    }),

    el("h3", { textContent: "Built with" }),
    el("ul", {}, [
      el("li", { textContent: "Three.js — WebGL 3D rendering (MIT)" }),
      el("li", { textContent: "MediaPipe Tasks Vision — hand landmark detection (Apache-2.0)" }),
      el("li", { textContent: "Vite + TypeScript — build tooling (MIT)" }),
    ]),
  );
  return root;
}

export function renderCalibration(settings: SettingsManager, liveGesture: () => GestureId): HTMLElement {
  const root = el("div");
  root.append(
    el("h2", { textContent: "Gesture Calibration" }),
    el("p", {
      textContent:
        "Tune recognition to your hands, camera and lighting, then practise each gesture below. A card turns green once you have performed that gesture successfully — so you can verify all eight before going back to the aircraft explorer.",
    }),
  );

  const s = settings.get();
  const fields: Array<{
    key: keyof Settings;
    label: string;
    note: string;
    min: number;
    max: number;
    step: number;
    format: (v: number) => string;
  }> = [
    {
      key: "sensitivity",
      label: "Gesture sensitivity",
      note: "Higher fires gestures from looser hand shapes and after fewer frames. Lower is steadier but needs more deliberate poses.",
      min: 0, max: 1, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
    },
    {
      key: "detectionConfidence",
      label: "Hand detection confidence",
      note: "MediaPipe's own threshold for accepting a hand. Raise it in a busy or cluttered frame; lower it in dim light.",
      min: 0.1, max: 0.9, step: 0.05,
      format: (v) => v.toFixed(2),
    },
    {
      key: "cooldownMs",
      label: "Gesture cooldown",
      note: "Minimum time between two firings of the same one-shot gesture (peace, thumbs up, pinch).",
      min: 200, max: 2500, step: 50,
      format: (v) => `${v} ms`,
    },
    {
      key: "rotationSensitivity",
      label: "Rotation sensitivity",
      note: "How far the aircraft turns for a given hand movement.",
      min: 0, max: 1, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
    },
    {
      key: "explodeSensitivity",
      label: "Exploded-view sensitivity",
      note: "How much of the separation range your hand-openness range covers.",
      min: 0, max: 1, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
    },
    {
      key: "zoomSensitivity",
      label: "Zoom sensitivity",
      note: "How strongly two-hand distance maps onto camera distance.",
      min: 0, max: 1, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
    },
  ];

  const grid = el("div", { className: "calib" });
  for (const f of fields) {
    const out = el("b", { textContent: f.format(s[f.key] as number) });
    const input = el("input", {
      type: "range",
      min: String(f.min),
      max: String(f.max),
      step: String(f.step),
      value: String(s[f.key]),
    });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      out.textContent = f.format(v);
      settings.set(f.key, v as never);
    });
    grid.append(
      el("label", { className: "calib__field" }, [
        el("span", { className: "slider__label" }, [document.createTextNode(f.label), out]),
        input,
        el("p", { className: "calib__note", textContent: f.note }),
      ]),
    );
  }
  root.append(grid);

  const resetBtn = el("button", { className: "btn btn--ghost", textContent: "Reset to defaults", type: "button" });
  resetBtn.style.marginTop = "14px";
  resetBtn.addEventListener("click", () => {
    settings.reset();
    // Re-render by reopening the sheet.
    root.dispatchEvent(new CustomEvent("calibration:reset", { bubbles: true }));
  });
  root.append(resetBtn);

  root.append(
    el("h3", { textContent: "Practice mode" }),
    el("p", {
      textContent:
        "Start the camera, then try each gesture. Cards light cyan while you hold the gesture and turn green once it has registered at least once.",
    }),
  );

  const grid2 = el("div", { className: "gguide" });
  const cards = new Map<GestureId, HTMLElement>();
  for (const id of GESTURE_SEQUENCE) {
    const g = GESTURES[id];
    const done = el("span", { className: "gcard__done", textContent: "" });
    const card = el("div", { className: "gcard" }, [
      el("span", { className: "gcard__glyph", textContent: g.glyph }),
      el("div", { className: "gcard__body" }, [
        el("strong", { textContent: g.name }),
        el("span", { textContent: g.how }),
        done,
      ]),
    ]);
    card.dataset.gestureId = id;
    cards.set(id, card);
    grid2.append(card);
  }
  root.append(grid2);

  // Poll the live gesture so the practice grid responds while the sheet is open.
  const hit = new Set<GestureId>();
  const timer = window.setInterval(() => {
    if (!root.isConnected) {
      window.clearInterval(timer);
      return;
    }
    const current = liveGesture();
    for (const [id, card] of cards) {
      card.classList.toggle("is-live", id === current);
      if (id === current && !hit.has(id)) {
        hit.add(id);
        card.classList.add("is-hit");
        const done = card.querySelector(".gcard__done");
        if (done) done.textContent = "✓ recognised";
      }
    }
  }, 120);

  return root;
}
