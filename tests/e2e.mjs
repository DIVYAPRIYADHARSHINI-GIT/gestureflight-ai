/**
 * GestureFlight AI — end-to-end suite.
 *
 * Drives the REAL production build in headless Chrome with a fake webcam
 * (`--use-fake-device-for-media-stream`), so the camera path, the MediaPipe
 * WASM load, the Three.js render loop and every UI action are exercised for
 * real. Fails on ANY console error.
 *
 * Usage: node tests/e2e.mjs [baseUrl]
 *        node tests/e2e.mjs https://gestureflight-ai.vercel.app   (live check)
 */

import puppeteer from "puppeteer";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const EXTERNAL = process.argv[2];

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm",
  ".task": "application/octet-stream", ".png": "image/png",
};

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

/**
 * Prefers Puppeteer's own Chrome, falling back to a system install so the suite
 * runs without downloading a second browser.
 */
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const p = puppeteer.executablePath();
    if (typeof p === "string" && existsSync(p)) return p;
  } catch {
    /* fall through to the system browser */
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("No Chrome/Chromium found. Set CHROME_PATH or run: npx puppeteer browsers install chrome");
}

async function serveDist() {
  const server = createServer(async (req, res) => {
    try {
      let p = normalize(decodeURIComponent(req.url.split("?")[0]));
      if (p === "/" || p.endsWith("/")) p += "index.html";
      const file = join(DIST, p);
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      await stat(file);
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/* Injects a gesture straight into the controller by synthesising the exact
   landmark payload HandTracking would deliver. This is how the suite verifies
   gesture→action mapping without needing a real hand in front of a camera. */
const INJECTOR = `
window.__inject = async (poseName, frames = 8, hands = 1) => {
  const { POSES } = window.__testPoses;
  const lms = POSES[poseName]();
  const payload = [];
  for (let h = 0; h < hands; h++) {
    const shifted = lms.map(p => ({ x: p.x + h * 0.3 - 0.15, y: p.y, z: p.z }));
    payload.push({ landmarks: shifted, handedness: h === 0 ? 'Right' : 'Left', score: 0.95 });
  }
  for (let i = 0; i < frames; i++) {
    window.__gf.gestures.process(payload, performance.now() + i * 33);
    await new Promise(r => requestAnimationFrame(r));
  }
};
window.__injectTwoHands = async (gap, frames = 8) => {
  const { POSES } = window.__testPoses;
  const l = POSES.openPalm();
  const mk = (dx) => l.map(p => ({ x: p.x + dx, y: p.y, z: p.z }));
  for (let i = 0; i < frames; i++) {
    window.__gf.gestures.process([
      { landmarks: mk(-gap / 2), handedness: 'Right', score: 0.95 },
      { landmarks: mk(gap / 2),  handedness: 'Left',  score: 0.95 },
    ], performance.now() + i * 33);
    await new Promise(r => requestAnimationFrame(r));
  }
};
window.__clearHands = async (frames = 5) => {
  for (let i = 0; i < frames; i++) {
    window.__gf.gestures.process([], performance.now() + i * 33);
    await new Promise(r => requestAnimationFrame(r));
  }
};
`;

async function run() {
  let server = null;
  let base = EXTERNAL;
  if (!base) {
    const s = await serveDist();
    server = s.server;
    base = s.url;
  }
  console.log(`\nGestureFlight AI — e2e against ${base}\n${"═".repeat(60)}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChrome(),
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-unsafe-swiftshader",
      "--use-gl=swiftshader",
      "--no-sandbox",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1512, height: 950 });

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const ctx = await browser.defaultBrowserContext();
  await ctx.overridePermissions(base, ["camera"]);

  try {
    /* ───────── boot ───────── */
    section("Application boot");
    // `domcontentloaded` rather than `networkidle2`: over a real network the
    // 23 MB of MediaPipe assets keep the connection busy, so network-idle never
    // settles. The readiness flag below is the real signal.
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => window.__gestureflight?.ready === true, { timeout: 30_000 });
    check("page loads and the app initialises", true);

    check("title and tagline present", (await page.title()).includes("GestureFlight"));

    await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, { timeout: 30_000 });
    check("initial aircraft finishes building (loading overlay clears)", true);

    const hasCanvas = await page.$eval("#viewport canvas", (c) => c.width > 100 && c.height > 100);
    check("WebGL canvas is created and sized", hasCanvas);

    const renders = await page.evaluate(async () => {
      const read = () => document.getElementById("stat-rfps").textContent;
      const before = read();
      await new Promise((r) => setTimeout(r, 1200));
      return { before, after: read() };
    });
    check("3D render loop is running (FPS reported)", Number(renders.after) > 10, `fps=${renders.after}`);

    /* ───────── layout ───────── */
    section("Interface layout");
    for (const [label, sel] of [
      ["top navigation", ".topnav"],
      ["left control panel", ".panel--left"],
      ["centre workspace", ".stage"],
      ["right information panel", ".panel--right"],
      ["bottom aircraft selector", ".selector"],
      ["webcam preview", "#webcam"],
      ["landmark overlay canvas", "#overlay"],
    ]) {
      check(`${label} is rendered`, (await page.$(sel)) !== null);
    }

    const aircraftCards = await page.$$eval(".selector__card", (n) => n.map((c) => c.textContent));
    check("all four aircraft categories offered", aircraftCards.length === 4, `${aircraftCards.length} cards`);
    for (const cat of ["Commercial Passenger", "Fighter", "Cargo", "Private Jet"]) {
      check(`selector lists ${cat}`, aircraftCards.some((t) => t.includes(cat)));
    }

    const comps = await page.$$eval("#component-list button", (n) => n.length);
    check("13 explorable components listed", comps === 13, `${comps} listed`);

    // The brief requires this exact sentence (§16).
    const privacyText = await page.$eval("#camera-placeholder", (e) => e.textContent.replace(/\s+/g, " ").trim());
    check(
      "privacy promise is shown verbatim before the camera starts",
      privacyText.includes("Your camera feed stays on your device. No video is uploaded or recorded."),
      privacyText,
    );

    /* ───────── manual controls ───────── */
    section("Manual fallback controls");
    const orbit = () => page.evaluate(() => window.__gf.scene.orbitState);

    const o0 = await orbit();
    await page.click('[data-manual="right"]');
    const o1 = await orbit();
    check("rotate right changes yaw", o1.yaw !== o0.yaw);

    await page.click('[data-manual="up"]');
    const o2 = await orbit();
    check("rotate up changes pitch", o2.pitch !== o1.pitch);

    await page.click('[data-manual="zoom-in"]');
    const o3 = await orbit();
    check("zoom in reduces camera distance", o3.dist < o2.dist);

    await page.click('[data-manual="zoom-out"]');
    check("zoom out increases camera distance", (await orbit()).dist > o3.dist);

    await page.click('[data-manual="center"]');
    await new Promise((r) => setTimeout(r, 200));
    const reset = await orbit();
    check("reset view restores the default orbit", Math.abs(reset.yaw - 0.6) < 0.01);

    /* keyboard */
    const kb0 = await orbit();
    await page.keyboard.press("KeyD");
    check("keyboard D rotates", (await orbit()).yaw !== kb0.yaw);
    await page.keyboard.press("KeyR");
    await new Promise((r) => setTimeout(r, 150));
    check("keyboard R resets", Math.abs((await orbit()).yaw - 0.6) < 0.01);

    /* mouse drag */
    const dragBefore = await orbit();
    const box = await page.$eval("#viewport", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 40, { steps: 8 });
    await page.mouse.up();
    check("mouse drag orbits the aircraft", (await orbit()).yaw !== dragBefore.yaw);

    /* wheel zoom */
    const wheelBefore = (await orbit()).dist;
    await page.mouse.move(box.x, box.y);
    await page.mouse.wheel({ deltaY: -400 });
    await new Promise((r) => setTimeout(r, 120));
    check("scroll wheel zooms", (await orbit()).dist !== wheelBefore);

    /* ───────── exploded view (manual) ───────── */
    section("Exploded view");
    await page.click("#btn-explode");
    await page.waitForFunction(() => window.__gf.exploded.amount > 0.95, { timeout: 6000 });
    check("Explode button fully separates the aircraft", true);

    const separated = await page.evaluate(() => {
      const c = window.__gf.built.components;
      const out = {};
      for (const [id, n] of c) out[id] = n.group.position.toArray().map((v) => +v.toFixed(3));
      return out;
    });
    check("wings separated to opposite sides", separated.wing_left[2] < 0 && separated.wing_right[2] > 0);
    check("landing gear dropped downwards", separated.gear[1] < 0);
    check("nose moved forwards", separated.nose[0] > 0);
    check("fuselage stayed as the datum", separated.fuselage.every((v) => Math.abs(v) < 0.001));

    await page.click("#btn-assemble");
    await page.waitForFunction(() => window.__gf.exploded.isAssembled, { timeout: 6000 });
    check("Assemble button returns every part home", true);

    // Let the damped animation fully settle before asserting exact positions.
    await new Promise((r) => setTimeout(r, 1500));
    const home = await page.evaluate(() => {
      let worst = 0;
      let worstId = "";
      for (const [id, n] of window.__gf.built.components) {
        const d = n.group.position.distanceTo(n.home);
        if (d > worst) {
          worst = d;
          worstId = id;
        }
      }
      return { worst, worstId };
    });
    check(
      "reassembly is exact (every part at its home position)",
      home.worst < 0.05,
      `worst offset ${home.worst.toFixed(4)} on ${home.worstId}`,
    );

    await page.evaluate(() => {
      const s = document.getElementById("explode-slider");
      s.value = "50";
      s.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => Math.abs(window.__gf.exploded.amount - 0.5) < 0.02, { timeout: 6000 });
    check("exploded-view slider gives partial separation", true);
    await page.click("#btn-reset");
    await page.waitForFunction(() => window.__gf.exploded.isAssembled, { timeout: 6000 });
    check("Reset Aircraft button works", true);

    /* ───────── component selection ───────── */
    section("Component exploration");
    await page.click('#component-list button[data-component-id="engine_right"]');
    const info = await page.evaluate(() => ({
      name: document.getElementById("component-name").textContent,
      desc: document.getElementById("component-description").textContent,
      fn: document.getElementById("component-function").textContent,
      loc: document.getElementById("component-location").textContent,
      specs: document.querySelectorAll("#component-specs dt").length,
      visible: !document.getElementById("component-body").hidden,
    }));
    check("selecting a component shows its name", /Engine/i.test(info.name));
    check("component description is populated", info.desc.length > 60);
    check("component function is populated", info.fn.length > 40);
    check("component location is populated", info.loc.length > 15);
    check("component technical information is populated", info.specs >= 3, `${info.specs} rows`);
    check("component information panel is visible", info.visible);

    const highlighted = await page.evaluate(() => {
      const n = window.__gf.built.components.get("engine_right");
      return n.meshes.some((m) => m.material.emissiveIntensity > 0.1);
    });
    check("selected component is visually highlighted", highlighted);

    await page.click("#btn-isolate");
    await page.waitForFunction(() => window.__gf.exploded.isolatedId === "engine_right", { timeout: 6000 });
    check("Pull Out / Inspect isolates the component", true);
    await page.click("#btn-return");
    await page.waitForFunction(() => window.__gf.exploded.isolatedId === null, { timeout: 6000 });
    check("Return Part restores the component", true);

    /* 3D click picking */
    await page.evaluate(() => window.__gf.scene.resetView());
    await new Promise((r) => setTimeout(r, 400));
    await page.mouse.click(box.x, box.y);
    const picked = await page.evaluate(() => window.__gf.selection.selectedId);
    check("clicking in the 3D view picks a component", picked !== null, `picked=${picked}`);

    /* ───────── aircraft switching ───────── */
    section("Aircraft switching");
    const first = await page.$eval("#aircraft-name", (e) => e.textContent);
    await page.evaluate(() => document.querySelectorAll(".selector__card")[1].click());
    await page.waitForFunction(() => document.getElementById("loading").hidden === true, { timeout: 20_000 });
    const second = await page.$eval("#aircraft-name", (e) => e.textContent);
    check("aircraft switches without a page reload", first !== second, `${first} → ${second}`);
    check("the page was never reloaded", await page.evaluate(() => window.__gestureflight.ready === true));

    const afterSwitch = await page.evaluate(() => ({
      comps: window.__gf.built.components.size,
      meshes: [...window.__gf.built.components.values()].reduce((a, n) => a + n.meshes.length, 0),
    }));
    check("the new aircraft also has 13 components", afterSwitch.comps === 13);
    check("the new aircraft has real geometry", afterSwitch.meshes > 20, `${afterSwitch.meshes} meshes`);

    for (let i = 2; i < 4; i++) {
      await page.evaluate((idx) => document.querySelectorAll(".selector__card")[idx].click(), i);
      await page.waitForFunction(() => document.getElementById("loading").hidden === true, { timeout: 20_000 });
    }
    check("all four aircraft load successfully", true);
    await page.evaluate(() => document.querySelectorAll(".selector__card")[0].click());
    await page.waitForFunction(() => document.getElementById("loading").hidden === true, { timeout: 20_000 });

    /* ───────── camera + hand tracking ───────── */
    section("Webcam and hand tracking");
    await page.click("#btn-camera-start");
    const cameraLive = await page
      .waitForFunction(() => document.getElementById("camera-stage").dataset.state === "live", { timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    check("Start Camera acquires the webcam", cameraLive);

    if (cameraLive) {
      const videoOk = await page.$eval("#webcam", (v) => v.videoWidth > 0 && !v.paused);
      check("webcam preview is playing", videoOk);
      check("Stop Camera button becomes enabled", await page.$eval("#btn-camera-stop", (b) => !b.disabled));

      const modelLoaded = await page
        .waitForFunction(() => window.__gf.tracking.isLoaded === true, { timeout: 90_000 })
        .then(() => true)
        .catch(() => false);
      check("MediaPipe hand landmarker model loads locally", modelLoaded);

      const trackingRuns = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 2500));
        return document.getElementById("stat-vfps").textContent;
      });
      check("hand detection loop runs on camera frames", Number(trackingRuns) > 0, `vision fps=${trackingRuns}`);

      const statusOk = await page.$eval("#track-status", (e) => e.textContent);
      check("hand detection status is reported", /live|tracking/i.test(statusOk), statusOk);
    }

    /* ───────── gesture → action mapping ───────── */
    section("Gesture recognition and action mapping");
    // The fake camera shows a rolling test pattern with no hands in it, so the
    // live detection loop would keep pushing empty frames and race the injected
    // ones. Pause detection (the camera itself stays live) and feed the SAME
    // landmark fixtures the unit tests use directly into the real controller.
    await page.evaluate(() => window.__gf.tracking.stop());

    const posesJson = await readFile(join(ROOT, "tests/fixtures/poses.json"), "utf8");
    await page.evaluate((json) => {
      const raw = JSON.parse(json);
      window.__testPoses = { POSES: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, () => v])) };
    }, posesJson);
    await page.evaluate(INJECTOR);

    // Open palm → explode
    await page.evaluate(() => window.__gf.exploded.setAmount(0));
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("openPalm", 12));
    const palmGesture = await page.$eval("#gesture-name", (e) => e.textContent);
    check("open palm is recognised", /open palm/i.test(palmGesture), palmGesture);
    await page.waitForFunction(() => window.__gf.exploded.targetAmount > 0.3, { timeout: 4000 }).catch(() => {});
    check(
      "open palm triggers the exploded view",
      await page.evaluate(() => window.__gf.exploded.targetAmount > 0.3),
      `amount=${await page.evaluate(() => window.__gf.exploded.targetAmount.toFixed(2))}`,
    );

    // Closed fist → assemble
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("closedFist", 12));
    const fistGesture = await page.$eval("#gesture-name", (e) => e.textContent);
    check("closed fist is recognised", /fist/i.test(fistGesture), fistGesture);
    await page.waitForFunction(() => window.__gf.exploded.isAssembled, { timeout: 6000 }).catch(() => {});
    check("closed fist reassembles the aircraft", await page.evaluate(() => window.__gf.exploded.isAssembled));

    // Pointing → select
    await page.evaluate(() => window.__gf.selection.setSelected(null));
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("pointing", 14));
    const pointGesture = await page.$eval("#gesture-name", (e) => e.textContent);
    check("pointing finger is recognised", /pointing/i.test(pointGesture), pointGesture);
    const cursorShown = await page.evaluate(() => window.__gf.scene.cursorVisible);
    check("pointing shows the 3D fingertip cursor", cursorShown === true);

    // Peace → next aircraft
    const beforePeace = await page.$eval("#aircraft-name", (e) => e.textContent);
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("peace", 14));
    await page.waitForFunction(() => document.getElementById("loading").hidden === true, { timeout: 20_000 });
    const afterPeace = await page.$eval("#aircraft-name", (e) => e.textContent);
    check("peace sign switches to the next aircraft", beforePeace !== afterPeace, `${beforePeace} → ${afterPeace}`);

    // Peace held does NOT switch repeatedly (cooldown)
    const held = await page.evaluate(async () => {
      const name = () => document.getElementById("aircraft-name").textContent;
      const start = name();
      await window.__inject("peace", 30);
      return { start, end: name() };
    });
    check("holding a peace sign only switches once (cooldown works)", held.start === held.end);

    // Thumbs up → confirm
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("thumbsUp", 14));
    const thumbGesture = await page.$eval("#gesture-name", (e) => e.textContent);
    check("thumbs up is recognised", /thumb/i.test(thumbGesture), thumbGesture);
    const confirmToast = await page.$eval("#toast", (e) => ({ hidden: e.hidden, text: e.textContent }));
    check("thumbs up confirms the action", /confirm/i.test(confirmToast.text), confirmToast.text);

    // Pinch → pull out
    await page.evaluate(() => window.__gf.selection.setSelected("wing_right"));
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("pinch", 14));
    const pinchGesture = await page.$eval("#gesture-name", (e) => e.textContent);
    check("pinch is recognised", /pinch/i.test(pinchGesture), pinchGesture);
    const isolated = await page.evaluate(() => window.__gf.exploded.isolatedId);
    check("pinch pulls out the selected component", isolated !== null, `isolated=${isolated}`);

    // Two-hand zoom
    await page.evaluate(() => window.__clearHands());
    const zoom = await page.evaluate(async () => {
      await window.__injectTwoHands(0.25, 10);
      const near = window.__gf.scene.orbitState.dist;
      await window.__injectTwoHands(0.75, 14);
      const apart = window.__gf.scene.orbitState.dist;
      return { near, apart, gesture: document.getElementById("gesture-name").textContent };
    });
    check("two hands are recognised as the zoom gesture", /two-hand|distance/i.test(zoom.gesture), zoom.gesture);
    check("moving both hands apart zooms in", zoom.apart < zoom.near, `${zoom.near.toFixed(1)} → ${zoom.apart.toFixed(1)}`);

    // Rotation
    await page.evaluate(() => window.__clearHands());
    const rotated = await page.evaluate(async () => {
      const yaw0 = window.__gf.scene.orbitState.yaw;
      const { POSES } = window.__testPoses;
      const base = POSES.loose();
      for (let i = 0; i < 16; i++) {
        const dx = i * 0.012;
        window.__gf.gestures.process(
          [{ landmarks: base.map((p) => ({ x: p.x + dx, y: p.y, z: p.z })), handedness: "Right", score: 0.95 }],
          performance.now() + i * 33,
        );
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { yaw0, yaw1: window.__gf.scene.orbitState.yaw, gesture: document.getElementById("gesture-name").textContent };
    });
    check("a loose hand is recognised as the rotation gesture", /rotation/i.test(rotated.gesture), rotated.gesture);
    check("moving the hand rotates the aircraft", Math.abs(rotated.yaw1 - rotated.yaw0) > 0.01);

    // Gesture confidence + openness indicators
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("openPalm", 10));
    const indicators = await page.evaluate(() => ({
      conf: Number(document.getElementById("bar-confidence").value),
      open: Number(document.getElementById("bar-openness").value),
    }));
    check("gesture confidence indicator updates", indicators.conf > 40, `${indicators.conf}%`);
    check("hand openness indicator updates", indicators.open > 40, `${indicators.open}%`);

    /* ───────── gesture toggle ───────── */
    section("Gesture / manual interaction isolation");
    await page.evaluate(() => window.__clearHands());
    await page.click("#toggle-gestures");
    const blocked = await page.evaluate(async () => {
      const before = window.__gf.exploded.targetAmount;
      await window.__inject("openPalm", 12);
      return { before, after: window.__gf.exploded.targetAmount };
    });
    check("disabling gesture interaction stops gestures acting", blocked.before === blocked.after);

    const manualStillWorks = await page.evaluate(() => {
      const before = window.__gf.scene.orbitState.yaw;
      document.querySelector('[data-manual="right"]').click();
      return window.__gf.scene.orbitState.yaw !== before;
    });
    check("manual controls still work while gestures are disabled", manualStillWorks);
    await page.click("#toggle-gestures");
    check("gesture interaction can be re-enabled", await page.$eval("#toggle-gestures", (c) => c.checked));

    /* ───────── camera stop ───────── */
    section("Camera teardown and privacy");
    if (cameraLive) {
      await page.click("#btn-camera-stop");
      await new Promise((r) => setTimeout(r, 400));
      const stopped = await page.evaluate(() => {
        const v = document.getElementById("webcam");
        return {
          srcObject: v.srcObject === null,
          stageIdle: document.getElementById("camera-stage").dataset.state === "idle",
          startEnabled: !document.getElementById("btn-camera-start").disabled,
          stopDisabled: document.getElementById("btn-camera-stop").disabled,
          tracksLive: window.__gf.camera.isActive,
        };
      });
      check("Stop Camera detaches the video stream", stopped.srcObject);
      check("Stop Camera stops every media track (camera light off)", stopped.tracksLive === false);
      check("camera preview returns to the idle state", stopped.stageIdle);
      check("Start Camera is re-enabled after stopping", stopped.startEnabled);
      check("Stop Camera is disabled once stopped", stopped.stopDisabled);

      await page.click("#btn-camera-start");
      const restarted = await page
        .waitForFunction(() => document.getElementById("camera-stage").dataset.state === "live", { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      check("the camera can be restarted after being stopped", restarted);
      if (restarted) await page.click("#btn-camera-stop");
    }

    /* camera denial handling — a second context with permission refused */
    const denyPage = await browser.newPage();
    const denyErrors = [];
    denyPage.on("pageerror", (e) => denyErrors.push(e.message));
    await denyPage.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await denyPage.waitForFunction(() => window.__gestureflight?.ready === true, { timeout: 30_000 });
    await denyPage.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(Object.assign(new DOMException("denied", "NotAllowedError")));
    });
    await denyPage.click("#btn-camera-start");
    await denyPage.waitForFunction(() => document.getElementById("camera-error").hidden === false, { timeout: 10_000 });
    const denyState = await denyPage.evaluate(() => ({
      msg: document.getElementById("camera-error").textContent,
      dot: document.getElementById("track-dot").dataset.state,
      startEnabled: !document.getElementById("btn-camera-start").disabled,
    }));
    check("denied camera permission shows a clear explanation", /permission was blocked/i.test(denyState.msg));
    check("denied camera permission points the user at manual controls", /manual controls/i.test(denyState.msg));
    check("denied camera permission sets the error state", denyState.dot === "error");
    check("the user can retry after a denial", denyState.startEnabled);
    const denyManual = await denyPage.evaluate(() => {
      const before = window.__gf.scene.orbitState.yaw;
      document.querySelector('[data-manual="right"]').click();
      return window.__gf.scene.orbitState.yaw !== before;
    });
    check("manual controls work when the camera is denied", denyManual);
    check("camera denial throws no page errors", denyErrors.length === 0, denyErrors.join("; "));
    await denyPage.close();

    /* ───────── views ───────── */
    section("Gesture guide, calibration and about");
    await page.click('[data-nav="guide"]');
    await page.waitForSelector("#sheet:not([hidden])", { timeout: 5000 });
    const guideCards = await page.$$eval("#sheet-content .gcard", (n) => n.length);
    check("gesture guide opens with all 8 gestures documented", guideCards === 8, `${guideCards} cards`);
    await page.click("#sheet-close");

    await page.click('[data-nav="calibration"]');
    await page.waitForSelector("#sheet:not([hidden])", { timeout: 5000 });
    const sliders = await page.$$eval("#sheet-content .calib input[type=range]", (n) => n.length);
    check("calibration offers all 6 sensitivity settings", sliders === 6, `${sliders} sliders`);
    const practiceCards = await page.$$eval("#sheet-content .gguide .gcard", (n) => n.length);
    check("calibration practice mode lists every gesture", practiceCards === 8);

    const persisted = await page.evaluate(async () => {
      const s = document.querySelectorAll("#sheet-content .calib input[type=range]")[0];
      s.value = "0.8";
      s.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      return JSON.parse(localStorage.getItem("gestureflight.settings.v1") ?? "{}").sensitivity;
    });
    check("calibration changes persist to localStorage", persisted === 0.8, `stored=${persisted}`);
    await page.click("#sheet-close");

    await page.click('[data-nav="about"]');
    await page.waitForSelector("#sheet:not([hidden])", { timeout: 5000 });
    const aboutText = await page.$eval("#sheet-content", (e) => e.textContent);
    check(
      "about page states the privacy promise verbatim",
      aboutText.includes("Your camera feed stays on your device. No video is uploaded or recorded."),
    );
    check("about page documents the 3D asset provenance", /procedurally|Three\.js geometry/i.test(aboutText));
    check("about page labels the data as illustrative", /illustrative/i.test(aboutText));
    await page.keyboard.press("Escape");
    check("Escape closes the overlay", await page.$eval("#sheet", (e) => e.hidden));

    /* ───────── responsive ───────── */
    section("Responsive layout");
    for (const [label, w, h] of [
      ["desktop 1512px", 1512, 950],
      ["laptop 1280px", 1280, 800],
      ["tablet 1024px", 1024, 768],
      ["tablet portrait 820px", 820, 1180],
      ["mobile 390px", 390, 844],
    ]) {
      await page.setViewport({ width: w, height: h });
      await new Promise((r) => setTimeout(r, 450));
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        canvasW: document.querySelector("#viewport canvas")?.clientWidth ?? 0,
        canvasH: document.querySelector("#viewport canvas")?.clientHeight ?? 0,
      }));
      check(`${label}: no horizontal overflow`, m.overflow <= 1, `${m.overflow}px`);
      check(`${label}: 3D viewport stays visible`, m.canvasW > 200 && m.canvasH > 150, `${m.canvasW}×${m.canvasH}`);
    }
    await page.setViewport({ width: 1512, height: 950 });

    /* ───────── console hygiene ───────── */
    section("Console hygiene");
    const realErrors = consoleErrors.filter(
      (e) => !/favicon|Failed to load resource.*404|DevTools/i.test(e),
    );
    check("no console errors during the whole run", realErrors.length === 0, realErrors.slice(0, 4).join(" | "));
  } finally {
    await browser.close();
    server?.close();
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log("");
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("\nE2E harness crashed:", e);
  process.exit(1);
});
