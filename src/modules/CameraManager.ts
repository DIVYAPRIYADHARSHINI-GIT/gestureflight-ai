/**
 * CameraManager — owns the MediaStream lifecycle.
 *
 * Privacy contract (enforced here, documented in the UI):
 *  - getUserMedia is called ONLY from start(), which is only called from an
 *    explicit "Start Camera" click.
 *  - Frames are never uploaded, never recorded and never written anywhere.
 *    The stream is attached to a local <video> and read by the in-browser
 *    MediaPipe WASM graph; nothing leaves the page.
 *  - stop() calls track.stop() on every track and detaches srcObject, which
 *    turns the hardware camera light off.
 */

export type CameraErrorKind =
  | "unsupported"
  | "denied"
  | "not-found"
  | "in-use"
  | "insecure"
  | "unknown";

export interface CameraError {
  kind: CameraErrorKind;
  message: string;
}

export class CameraManager {
  private stream: MediaStream | null = null;

  constructor(private video: HTMLVideoElement) {
    // Belt-and-braces: release the camera if the page is torn down.
    window.addEventListener("pagehide", () => this.stop());
    window.addEventListener("beforeunload", () => this.stop());
  }

  get isActive(): boolean {
    return !!this.stream && this.stream.getTracks().some((t) => t.readyState === "live");
  }

  /** Requests permission and starts the stream. Throws a CameraError. */
  async start(): Promise<void> {
    if (this.isActive) return;

    if (!window.isSecureContext) {
      throw this.err(
        "insecure",
        "Camera access needs a secure context. Open the app over https:// or on http://localhost.",
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw this.err(
        "unsupported",
        "This browser does not expose getUserMedia. Try a recent Chrome, Edge, Firefox or Safari.",
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
          frameRate: { ideal: 30 },
        },
        audio: false, // never request the microphone
      });
    } catch (e) {
      throw this.mapError(e);
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(this.err("unknown", "The camera stream did not start in time.")),
        10_000,
      );
      const onReady = () => {
        window.clearTimeout(timer);
        this.video.removeEventListener("loadeddata", onReady);
        resolve();
      };
      if (this.video.readyState >= 2) onReady();
      else this.video.addEventListener("loadeddata", onReady);
    });

    await this.video.play().catch(() => {
      /* autoplay of a muted local stream rarely fails; tracking still works */
    });
  }

  /** Stops every track and releases the hardware. */
  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video.srcObject) this.video.srcObject = null;
  }

  get resolution(): { w: number; h: number } {
    return { w: this.video.videoWidth || 0, h: this.video.videoHeight || 0 };
  }

  private err(kind: CameraErrorKind, message: string): CameraError {
    return { kind, message };
  }

  private mapError(e: unknown): CameraError {
    const name = (e as DOMException)?.name ?? "";
    switch (name) {
      case "NotAllowedError":
      case "SecurityError":
        return this.err(
          "denied",
          "Camera permission was blocked. Allow camera access for this site in your browser's address-bar permission menu, then press Start Camera again. Manual controls work meanwhile.",
        );
      case "NotFoundError":
      case "OverconstrainedError":
        return this.err(
          "not-found",
          "No camera was found. Connect a webcam and press Start Camera again. Manual controls work meanwhile.",
        );
      case "NotReadableError":
      case "AbortError":
        return this.err(
          "in-use",
          "The camera is already in use by another application. Close the other app (video call, other tab) and try again.",
        );
      default:
        return this.err("unknown", `Could not start the camera: ${(e as Error)?.message ?? name}`);
    }
  }
}
