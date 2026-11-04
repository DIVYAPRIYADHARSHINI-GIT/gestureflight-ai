/**
 * AircraftScene — the Three.js stage: renderer, camera, lights, grid, the
 * pointer cursor, and the orbit/zoom state that gestures and manual controls
 * both drive.
 *
 * Camera state is held as target values and critically damped every frame, so
 * noisy gesture input and discrete button clicks both produce smooth motion.
 */

import * as THREE from "three";
import { clamp, lerp } from "./GestureRecognition";

export class AircraftScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly modelPivot = new THREE.Group();

  /** Target orbit state, damped towards by update(). */
  private targetYaw = 0.6;
  private targetPitch = 0.28;
  private targetRoll = 0;
  private targetDist = 34;
  private yaw = 0.6;
  private pitch = 0.28;
  private roll = 0;
  private dist = 34;

  private minDist = 12;
  private maxDist = 70;
  private baseDist = 34;
  /** Zoom-out multiplier applied while the aircraft is exploded. */
  private explodeFraming = 1;
  /** Key light + env map, retained so quality profiles can retune them (§4). */
  private keyLight: THREE.DirectionalLight | null = null;
  private envMap: THREE.CubeTexture | null = null;
  /** Deferred shadow-map resize, applied at a safe frame boundary. */
  private pendingShadowResize: (() => void) | null = null;

  private cursor: THREE.Mesh;
  private cursorRing: THREE.Mesh;
  private frameTimes: number[] = [];
  private fps = 0;
  private resizeObs: ResizeObserver;
  private disposed = false;
  private raf = 0;
  private onFrame?: (dt: number) => void;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.scene.add(this.modelPivot);

    this.buildEnvironment();

    // Fingertip cursor used by the pointing gesture.
    const cursorGeo = new THREE.SphereGeometry(0.42, 16, 12);
    this.cursor = new THREE.Mesh(
      cursorGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
    );
    this.cursorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 0.95, 24),
      new THREE.MeshBasicMaterial({ color: 0x38e1f0, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
    );
    this.cursor.visible = false;
    this.cursorRing.visible = false;
    this.cursor.renderOrder = 10;
    this.cursorRing.renderOrder = 10;
    this.scene.add(this.cursor, this.cursorRing);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
  }

  private buildEnvironment(): void {
    this.scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x0a1220, 1.15));

    // Environment map for metal reflections (§4). Built as a plain cube texture
    // from canvases rather than via PMREMGenerator: PMREM leaves the renderer in
    // a state that makes the next shadow-map depth pass fail shader validation
    // on software GL backends (reproduced on SwiftShader), and a gradient cube
    // gives the same visual result here for a fraction of the cost.
    this.envMap = this.makeEnvironmentMap();
    this.scene.environment = this.envMap;

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    this.keyLight = key;
    key.position.set(18, 26, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 5;
    key.shadow.camera.far = 90;
    const d = 28;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x38e1f0, 1.5);
    rim.position.set(-20, 8, -16);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0x19b9a7, 0.7);
    fill.position.set(6, -14, 18);
    this.scene.add(fill);

    // Holographic reference grid under the aircraft.
    const grid = new THREE.GridHelper(120, 48, 0x38e1f0, 0x163a4a);
    const gm = grid.material as THREE.Material;
    gm.transparent = true;
    gm.opacity = 0.16;
    grid.position.y = -11;
    this.scene.add(grid);

    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(26, 48),
      new THREE.MeshBasicMaterial({ color: 0x0d3b4a, transparent: true, opacity: 0.3 }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -10.95;
    this.scene.add(glow);
  }

  /** Frames the camera around a newly-built aircraft. */
  frameModel(radius: number): void {
    this.baseDist = radius * 2.35;
    this.minDist = radius * 1.08;
    this.maxDist = radius * 5.4;
    this.targetDist = this.baseDist;
    this.dist = this.baseDist;
  }

  /**
   * Widens the framing as the aircraft explodes so the separated components
   * stay inside the viewport. Applied as a multiplier on the user's own zoom,
   * so gesture/manual zoom still works while exploded.
   */
  setExplodeFraming(amount: number): void {
    const next = 1 + clamp(amount) * 0.55;
    if (Math.abs(next - this.explodeFraming) < 1e-3) return;
    const ratio = next / this.explodeFraming;
    this.explodeFraming = next;
    this.targetDist = clamp(this.targetDist * ratio, this.minDist, this.maxDist * next);
  }

  /* ───────────── orbit API (shared by gestures + manual controls) ───────────── */

  orbit(dYaw: number, dPitch: number): void {
    this.targetYaw += dYaw;
    this.targetPitch = clamp(this.targetPitch + dPitch, -1.25, 1.25);
  }

  setOrbit(yaw: number, pitch: number): void {
    this.targetYaw = yaw;
    this.targetPitch = clamp(pitch, -1.25, 1.25);
  }

  setRoll(r: number): void {
    this.targetRoll = clamp(r, -0.9, 0.9);
  }

  private get farLimit(): number {
    return this.maxDist * this.explodeFraming;
  }

  zoomBy(factor: number): void {
    this.targetDist = clamp(this.targetDist * factor, this.minDist, this.farLimit);
  }

  /** Absolute zoom from a normalised 0..1 input (two-hand distance). */
  setZoomNormalised(t: number): void {
    this.targetDist = lerp(this.farLimit, this.minDist, clamp(t));
  }

  get zoomNormalised(): number {
    return clamp((this.farLimit - this.targetDist) / Math.max(1e-3, this.farLimit - this.minDist));
  }

  resetView(): void {
    this.targetYaw = 0.6;
    this.targetPitch = 0.28;
    this.targetRoll = 0;
    this.targetDist = this.baseDist * this.explodeFraming;
  }

  get orbitState() {
    return { yaw: this.targetYaw, pitch: this.targetPitch, dist: this.targetDist };
  }

  /* ───────────── cursor ───────────── */

  /**
   * Places the 3D cursor from normalised screen coordinates (0..1) on a plane
   * through the model centre, so it visually tracks the fingertip.
   */
  setCursor(nx: number | null, ny?: number): void {
    if (nx === null || ny === undefined) {
      this.cursor.visible = false;
      this.cursorRing.visible = false;
      return;
    }
    const ndc = new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(
      this.camera.getWorldDirection(new THREE.Vector3()).negate(),
      0,
    );
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, hit)) {
      this.cursor.position.copy(hit);
      this.cursorRing.position.copy(hit);
      this.cursorRing.quaternion.copy(this.camera.quaternion);
      this.cursor.visible = true;
      this.cursorRing.visible = true;
    }
  }

  get cursorVisible(): boolean {
    return this.cursor.visible;
  }

  /**
   * Builds a 6-face cube environment map from canvas gradients: a bright "sky"
   * above, a dark hangar floor below, and a cool horizon band. Metal surfaces
   * sample this for their reflections.
   */
  private makeEnvironmentMap(): THREE.CubeTexture {
    const S = 128;
    const faces: HTMLCanvasElement[] = [];
    // Order: +X, -X, +Y, -Y, +Z, -Z
    const specs: Array<[string, string]> = [
      ["#1b4254", "#0a1522"],
      ["#163a4a", "#0a1522"],
      ["#bfe9f5", "#3d7f95"], // up — the bright source
      ["#060a11", "#0a1018"], // down — hangar floor
      ["#1d4759", "#0a1522"],
      ["#12303d", "#0a1522"],
    ];
    for (const [top, bottom] of specs) {
      const c = document.createElement("canvas");
      c.width = S;
      c.height = S;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 0, S);
      grad.addColorStop(0, top);
      grad.addColorStop(1, bottom);
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      faces.push(c);
    }
    const tex = new THREE.CubeTexture(faces);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Applies a render-quality profile (§4). The shadow-map resize is deferred to
   * a frame boundary so the depth pass is never rebuilt mid-call.
   */
  applyQuality(p: {
    pixelRatio: number;
    shadows: boolean;
    shadowMapSize: number;
    reflections: boolean;
  }): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.pixelRatio));
    this.renderer.shadowMap.enabled = p.shadows;
    this.renderer.shadowMap.type = p.shadows ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;

    if (this.keyLight) {
      this.keyLight.castShadow = p.shadows;
      if (p.shadows && this.keyLight.shadow.mapSize.width !== p.shadowMapSize) {
        const light = this.keyLight;
        const size = p.shadowMapSize;
        this.pendingShadowResize = () => {
          light.shadow.mapSize.set(size, size);
          light.shadow.map?.dispose();
          light.shadow.map = null;
        };
      }
    }

    // Reflections come from the env map; dropping it is the cheap win.
    this.scene.environment = p.reflections ? this.envMap : null;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && "envMapIntensity" in m) m.envMapIntensity = p.reflections ? 0.55 : 0;
    });
    this.resize();
  }

  /** Raycast from normalised screen coords against the given meshes. */
  pick(nx: number, ny: number, targets: THREE.Object3D[]): THREE.Intersection | null {
    const ndc = new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(targets, true);
    return hits.length ? hits[0] : null;
  }

  /* ───────────── loop ───────────── */

  start(onFrame: (dt: number) => void): void {
    this.onFrame = onFrame;
    let last = performance.now();
    const tick = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      if (this.pendingShadowResize) {
        const fn = this.pendingShadowResize;
        this.pendingShadowResize = null;
        fn();
      }

      this.onFrame?.(dt);
      this.updateCamera(dt);
      this.renderer.render(this.scene, this.camera);

      this.frameTimes.push(now);
      while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
      this.fps = this.frameTimes.length;
    };
    this.raf = requestAnimationFrame(tick);
  }

  private updateCamera(dt: number): void {
    // Frame-rate independent critical damping.
    const k = 1 - Math.exp(-dt * 9);
    this.yaw = lerp(this.yaw, this.targetYaw, k);
    this.pitch = lerp(this.pitch, this.targetPitch, k);
    this.roll = lerp(this.roll, this.targetRoll, k);
    this.dist = lerp(this.dist, this.targetDist, k);

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.dist * cp * Math.sin(this.yaw),
      this.dist * Math.sin(this.pitch),
      this.dist * cp * Math.cos(this.yaw),
    );
    this.camera.up.set(Math.sin(this.roll), Math.cos(this.roll), 0);
    this.camera.lookAt(0, 0, 0);
  }

  get renderFps(): number {
    return this.fps;
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.envMap?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
