/**
 * HandTracking — MediaPipe Hand Landmarker wrapper + landmark overlay renderer.
 *
 * The model (.task) and the WASM runtime are both vendored into /public, so the
 * app does not depend on any CDN or external service at runtime.
 *
 * Detection runs on its OWN rAF loop, decoupled from the Three.js render loop,
 * and skips frames whose timestamp has not advanced — so a slow camera never
 * blocks 3D rendering (performance requirement §15).
 */

import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { Handedness, Landmark, TrackedHand } from "../types";
import { HAND_CONNECTIONS, LM } from "./GestureRecognition";

export interface HandFrame {
  hands: TrackedHand[];
  /** Measured detection throughput. */
  fps: number;
}

export class HandTracking {
  private landmarker: HandLandmarker | null = null;
  private running = false;
  private rafId = 0;
  private lastVideoTime = -1;
  private frameTimes: number[] = [];
  private fps = 0;
  private loadPromise: Promise<void> | null = null;
  private minConfidence = 0.5;

  constructor(
    private video: HTMLVideoElement,
    private canvas: HTMLCanvasElement,
    private onFrame: (frame: HandFrame) => void,
  ) {}

  get isLoaded(): boolean {
    return !!this.landmarker;
  }

  /** Loads the WASM runtime + model. Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.landmarker) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(
        `${import.meta.env.BASE_URL}wasm`,
      );
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: this.minConfidence,
        minHandPresenceConfidence: this.minConfidence,
        minTrackingConfidence: this.minConfidence,
      });
    })();

    try {
      await this.loadPromise;
    } catch (e) {
      this.loadPromise = null;
      throw new Error(
        `Hand tracking model failed to load: ${(e as Error)?.message ?? "unknown error"}`,
      );
    }
  }

  /** Updates detection confidence thresholds live from the calibration panel. */
  async setConfidence(value: number): Promise<void> {
    this.minConfidence = Math.min(0.95, Math.max(0.1, value));
    if (!this.landmarker) return;
    await this.landmarker.setOptions({
      minHandDetectionConfidence: this.minConfidence,
      minHandPresenceConfidence: this.minConfidence,
      minTrackingConfidence: this.minConfidence,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastVideoTime = -1;
    this.frameTimes = [];
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.clearOverlay();
    this.fps = 0;
  }

  /** Releases the WASM graph. */
  dispose(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.loadPromise = null;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const lm = this.landmarker;
    if (!lm || this.video.readyState < 2) return;

    // Only run inference on genuinely new camera frames.
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = lm.detectForVideo(this.video, performance.now());
    } catch {
      return; // transient GPU hiccup — try again next frame
    }

    const hands: TrackedHand[] = (result.landmarks ?? []).map((landmarks, i) => {
      const cat = result.handedness?.[i]?.[0];
      // The preview is mirrored, so MediaPipe's label is flipped for the user.
      const raw = (cat?.categoryName as Handedness) ?? "Unknown";
      const handedness: Handedness = raw === "Left" ? "Right" : raw === "Right" ? "Left" : "Unknown";
      return {
        landmarks: landmarks as Landmark[],
        worldLandmarks: result.worldLandmarks?.[i] as Landmark[] | undefined,
        handedness,
        score: cat?.score ?? 0,
      };
    });

    this.tickFps();
    this.draw(hands);
    this.onFrame({ hands, fps: this.fps });
  };

  private tickFps(): void {
    const now = performance.now();
    this.frameTimes.push(now);
    while (this.frameTimes.length > 0 && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.fps = this.frameTimes.length;
  }

  /* ───────────── overlay rendering ───────────── */

  private clearOverlay(): void {
    const ctx = this.canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(hands: TrackedHand[]): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 240;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    for (const hand of hands) {
      const pts = hand.landmarks.map((p) => ({ x: p.x * w, y: p.y * h }));
      const tint = hand.handedness === "Left" ? "#38e1f0" : "#19b9a7";

      ctx.lineWidth = 2;
      ctx.strokeStyle = tint;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();

      ctx.globalAlpha = 1;
      pts.forEach((p, i) => {
        const isTip = i === LM.THUMB_TIP || i === LM.INDEX_TIP || i === LM.MIDDLE_TIP || i === LM.RING_TIP || i === LM.PINKY_TIP;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isTip ? 4 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = i === LM.INDEX_TIP ? "#ffffff" : isTip ? tint : "#9fd6e4";
        ctx.fill();
        if (i === LM.INDEX_TIP) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.2;
          ctx.globalAlpha = 0.55;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });

      // Handedness label, un-mirrored so it reads correctly over the flipped video.
      const wrist = pts[LM.WRIST];
      ctx.save();
      ctx.translate(wrist.x, wrist.y);
      ctx.scale(-1, 1);
      ctx.font = "600 11px ui-monospace, monospace";
      ctx.fillStyle = tint;
      ctx.textAlign = "center";
      ctx.fillText(hand.handedness === "Unknown" ? "HAND" : hand.handedness.toUpperCase(), 0, 18);
      ctx.restore();
    }
  }
}
