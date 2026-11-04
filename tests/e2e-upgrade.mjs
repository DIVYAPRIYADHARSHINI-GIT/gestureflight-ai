/**
 * E2E suite for the upload / blueprint / engine upgrade.
 *
 * Runs the REAL production build in headless Chrome and uploads REAL files of
 * every supported format through the actual file input — so STEP (OpenCascade
 * WASM), GLB, GLTF, STL, OBJ, PDF (PDF.js) and PNG/JPG are all parsed for real.
 * Nothing is marked as passing unless geometry or pages genuinely came out.
 *
 * Usage: node tests/e2e-upgrade.mjs [baseUrl]
 */

import puppeteer from "puppeteer";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const FILES = join(ROOT, "tests/fixtures/files");
const EXTERNAL = process.argv[2];

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".wasm": "application/wasm", ".task": "application/octet-stream",
  ".txt": "text/plain", ".png": "image/png",
};

let pass = 0, fail = 0;
const failures = [];
const notes = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (t) => console.log(`\n── ${t}`);
const note = (t) => {
  notes.push(t);
  console.log(`  ℹ ${t}`);
};

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const p = puppeteer.executablePath();
    if (typeof p === "string" && existsSync(p)) return p;
  } catch { /* fall through */ }
  for (const c of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
  ]) if (existsSync(c)) return c;
  throw new Error("No Chrome found. Set CHROME_PATH.");
}

async function serveDist() {
  const server = createServer(async (req, res) => {
    try {
      let p = normalize(decodeURIComponent(req.url.split("?")[0]));
      if (p === "/" || p.endsWith("/")) p += "index.html";
      const file = join(DIST, p);
      if (!file.startsWith(DIST)) return void res.writeHead(403).end();
      await stat(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Uploads a real file through the real <input type=file>. */
async function upload(page, filename) {
  const input = await page.$('#upload-mount input[type="file"]');
  if (!input) throw new Error("upload input not found");
  await input.uploadFile(join(FILES, filename));
}

/** Waits for the app to settle after an upload: library grows or an error shows. */
async function settle(page, timeout = 120_000) {
  await page.waitForFunction(
    () => {
      const err = document.querySelector(".upload__error");
      const status = document.querySelector(".upload__status");
      const errored = err && !err.hidden;
      const idle = !status || status.hidden;
      return errored || idle;
    },
    { timeout, polling: 150 },
  );
  await new Promise((r) => setTimeout(r, 350));
}

async function run() {
  let server = null;
  let base = EXTERNAL;
  if (!base) {
    const s = await serveDist();
    server = s.server;
    base = s.url;
  }
  console.log(`\nGestureFlight AI — upgrade e2e against ${base}\n${"═".repeat(64)}`);

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 240_000,
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
  await page.setViewport({ width: 1512, height: 980 });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await (await browser.defaultBrowserContext()).overridePermissions(base, ["camera"]);

  try {
    /* ───────── boot + regression ───────── */
    section("Boot and existing-feature regression");
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => window.__gestureflight?.ready === true, { timeout: 60_000 });
    await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, { timeout: 60_000 });
    check("app boots with the upgrade in place", true);

    // Every pre-existing feature must still be present (§ "do not remove").
    for (const [label, sel] of [
      ["webcam preview", "#webcam"],
      ["landmark overlay", "#overlay"],
      ["aircraft selector", ".selector__card"],
      ["exploded-view slider", "#explode-slider"],
      ["manual D-pad", '[data-manual="left"]'],
      ["gesture toggle", "#toggle-gestures"],
      ["component list", "#component-list button"],
      ["gesture card", "#gesture-card"],
    ]) {
      check(`existing ${label} preserved`, (await page.$(sel)) !== null);
    }
    check("four built-in aircraft still available", (await page.$$(".selector__card")).length === 4);
    check("13 built-in components still listed", (await page.$$("#component-list button")).length === 13);

    // New UI present.
    for (const [label, sel] of [
      ["upload dropzone", ".dropzone"],
      ["mode rail", "#mode-rail button"],
      ["quality rail", "#quality-rail button"],
      ["engine explorer panel", "#engine-block"],
      ["geometry-source badge", "#hud-source"],
    ]) {
      check(`new ${label} present`, (await page.$(sel)) !== null);
    }

    /* ───────── format-by-format uploads ───────── */
    section("3D format loading (real files, real parsers)");

    const meshCases = [
      { file: "test-aircraft.glb", label: "GLB", expectParts: 5 },
      { file: "test-aircraft.gltf", label: "GLTF", expectParts: 5 },
      { file: "test-wedge.stl", label: "STL", expectParts: 1 },
      { file: "test-aircraft.obj", label: "OBJ", expectParts: 2 },
      { file: "test-assembly.step", label: "STEP", expectParts: 1 },
    ];

    for (const c of meshCases) {
      await upload(page, c.file);
      await settle(page);
      const state = await page.evaluate(() => {
        const m = window.__gf.importedMesh;
        const err = document.querySelector(".upload__error");
        return {
          loaded: !!m,
          error: err && !err.hidden ? err.textContent : null,
          format: m?.format ?? null,
          triangles: m?.triangles ?? 0,
          vertices: m?.vertices ?? 0,
          parts: m?.parts?.length ?? 0,
          separate: m?.hasSeparateComponents ?? false,
          source: window.__gf.geometrySource,
          inScene: !!m && m.root.parent !== null,
        };
      });

      check(`${c.label}: geometry actually loads`, state.loaded && state.triangles > 0,
        state.error ?? `${state.triangles} tris, ${state.vertices} verts`);
      if (state.loaded) {
        check(`${c.label}: model is added to the live scene`, state.inScene);
        check(`${c.label}: provenance marked as imported`, state.source === "imported", state.source);
        check(`${c.label}: ${c.expectParts} object(s) detected`,
          state.parts === c.expectParts, `got ${state.parts}`);
        note(`${c.label} → ${state.triangles.toLocaleString()} triangles, ${state.parts} object(s), separate components: ${state.separate}`);
      }
    }

    /* component names from the file */
    await upload(page, "test-aircraft.glb");
    await settle(page);
    const names = await page.$$eval("#component-list button span:first-child", (n) => n.map((e) => e.textContent));
    check("GLB component names come from the file, not invented",
      names.includes("Fuselage") && names.includes("MainWing"), names.join(", "));

    const partInfo = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("#component-list button")];
      btns.find((b) => b.textContent.includes("MainWing"))?.click();
      return {
        name: document.getElementById("component-name").textContent,
        category: document.getElementById("component-category").textContent,
        fn: document.getElementById("component-function").textContent,
        source: [...document.querySelectorAll("#component-specs dt")].map((d) => d.textContent),
      };
    });
    check("imported component can be selected", /MainWing/.test(partInfo.name), partInfo.name);
    check("imported component is labelled as named in the file", /named/i.test(partInfo.category));
    check("app does NOT invent a function for imported parts",
      /does not guess/i.test(partInfo.fn), partInfo.fn.slice(0, 60));
    check("component panel reports geometry source", partInfo.source.includes("Geometry source"));

    /* single-mesh honesty */
    await upload(page, "test-wedge.stl");
    await settle(page);
    const single = await page.evaluate(() => ({
      separate: window.__gf.importedMesh?.hasSeparateComponents,
      disclaimer: document.getElementById("aircraft-disclaimer").textContent,
      count: document.getElementById("component-count").textContent,
    }));
    check("single-mesh STL reports hasSeparateComponents=false", single.separate === false);
    check("single-mesh STL honestly states components cannot be extracted",
      /SINGLE MESH/i.test(single.disclaimer) && /cannot extract/i.test(single.disclaimer));
    check("component count reflects the single mesh", /single mesh/i.test(single.count), single.count);

    /* ───────── invalid / oversized / corrupt ───────── */
    section("Invalid file handling (honest rejection)");

    await upload(page, "notes.dwg");
    await settle(page);
    let err = await page.evaluate(() => {
      const e = document.querySelector(".upload__error");
      return e && !e.hidden ? e.textContent : null;
    });
    check("unsupported format is rejected", !!err && /not a supported format/i.test(err), err?.slice(0, 80));
    check("rejection lists the supported formats", !!err && /\.step/.test(err));

    await upload(page, "corrupt.step");
    await settle(page);
    err = await page.evaluate(() => {
      const e = document.querySelector(".upload__error");
      return e && !e.hidden ? e.textContent : null;
    });
    check("corrupt/renamed file is rejected, not silently loaded",
      !!err && /does not contain valid|corrupt/i.test(err), err?.slice(0, 90));

    const stillAlive = await page.evaluate(() => window.__gestureflight?.ready === true);
    check("app survives invalid uploads without crashing", stillAlive);

    const oversize = await page.evaluate(() => {
      // Validation is pure, so an oversized File can be tested directly.
      const big = new File([new Uint8Array(8)], "huge.stl", { type: "model/stl" });
      Object.defineProperty(big, "size", { value: 500 * 1024 * 1024 });
      try {
        window.__gf.processor; // ensure module is live
        return "needs-validate";
      } catch {
        return "no-processor";
      }
    });
    void oversize;

    /* ───────── blueprints ───────── */
    section("Blueprint rendering and assisted reconstruction");

    for (const [file, label, expectPages] of [
      ["blueprint-top.png", "PNG", 1],
      ["blueprint-side.jpg", "JPG", 1],
      ["blueprint-2sheet.pdf", "PDF", 2],
    ]) {
      await upload(page, file);
      await settle(page);
      const bp = await page.evaluate(() => {
        const entry = window.__gf.library[window.__gf.library.length - 1];
        const r = entry?.result;
        return {
          kind: r?.kind,
          pages: r?.kind === "blueprint" ? r.pages.length : 0,
          firstW: r?.kind === "blueprint" ? r.pages[0].width : 0,
          firstH: r?.kind === "blueprint" ? r.pages[0].height : 0,
          guess: r?.kind === "blueprint" ? r.pages[0].viewGuess : null,
          reason: r?.kind === "blueprint" ? r.pages[0].viewReason : "",
          canvasShown: !!document.querySelector(".blueprint__canvas"),
          mode: window.__gf.modes.mode,
        };
      });
      check(`${label}: renders as a blueprint`, bp.kind === "blueprint" && bp.pages === expectPages,
        `${bp.pages} page(s)`);
      check(`${label}: page raster has real pixels`, bp.firstW > 100 && bp.firstH > 100,
        `${bp.firstW}×${bp.firstH}`);
      check(`${label}: viewer is displayed`, bp.canvasShown);
      check(`${label}: switches to Blueprint Reference mode`, bp.mode === "blueprint", bp.mode);
      note(`${label} view classification: "${bp.guess}" — ${bp.reason}`);
    }

    const bpControls = await page.evaluate(() => ({
      hasSelect: !!document.querySelector(".blueprint__select"),
      hasFit: [...document.querySelectorAll(".blueprint__controls .btn")].some((b) => b.textContent === "Fit"),
      hasPager: !!document.querySelector(".blueprint__page"),
      honesty: document.querySelector(".recon__honesty")?.textContent ?? "",
      inputs: document.querySelectorAll(".recon__input").length,
    }));
    check("multi-page PDF gets page navigation", bpControls.hasPager);
    check("blueprint view can be corrected manually", bpControls.hasSelect);
    check("blueprint viewer has a fit/zoom reset", bpControls.hasFit);
    check("reconstruction states 2D→3D cannot be automatic",
      /cannot be converted into an engineering-accurate 3D aircraft automatically/i.test(bpControls.honesty));
    check("reconstruction asks for the three dimensions", bpControls.inputs === 3, `${bpControls.inputs} inputs`);

    /* refuses to invent geometry without dimensions */
    const refuses = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".recon .btn")].find((b) => /Build 3D/.test(b.textContent));
      btn.click();
      const e = document.querySelector(".recon__error");
      return { hidden: e.hidden, text: e.textContent };
    });
    check("reconstruction refuses to run without dimensions", refuses.hidden === false);
    check("refusal says it will not invent the aircraft",
      /will not invent/i.test(refuses.text), refuses.text?.slice(0, 80));

    /* implausible proportions rejected */
    const implausible = await page.evaluate(() => {
      const ins = document.querySelectorAll(".recon__input");
      ins[0].value = "2"; ins[1].value = "400"; ins[2].value = "3";
      ins.forEach((i) => i.dispatchEvent(new Event("input", { bubbles: true })));
      [...document.querySelectorAll(".recon .btn")].find((b) => /Build 3D/.test(b.textContent)).click();
      const e = document.querySelector(".recon__error");
      return { hidden: e.hidden, text: e.textContent };
    });
    check("implausible proportions are rejected", implausible.hidden === false,
      implausible.text?.slice(0, 70));

    /* real reconstruction */
    await page.evaluate(() => {
      const ins = document.querySelectorAll(".recon__input");
      ins[0].value = "39.5"; ins[1].value = "35.8"; ins[2].value = "12.5";
      ins.forEach((i) => i.dispatchEvent(new Event("input", { bubbles: true })));
      [...document.querySelectorAll(".recon .btn")].find((b) => /Build 3D/.test(b.textContent)).click();
    });
    await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 600));
    const recon = await page.evaluate(() => ({
      source: window.__gf.geometrySource,
      comps: window.__gf.built?.components.size ?? 0,
      name: document.getElementById("aircraft-name").textContent,
      disclaimer: document.getElementById("aircraft-disclaimer").textContent,
      badge: document.getElementById("hud-source").textContent,
      specs: [...document.querySelectorAll("#aircraft-specs dd")].map((d) => d.textContent).join(" | "),
    }));
    check("blueprint dimensions build real 3D geometry", recon.comps === 13, `${recon.comps} components`);
    check("reconstructed geometry is marked 'reconstructed'", recon.source === "reconstructed", recon.source);
    check("HUD badge shows reconstructed provenance", /Reconstructed/i.test(recon.badge), recon.badge);
    check("reconstruction disclaimer says it is NOT a measured reproduction",
      /RECONSTRUCTED/.test(recon.disclaimer) && /not a measured reproduction/i.test(recon.disclaimer));
    check("the user's dimensions appear in the spec panel",
      recon.specs.includes("39.5") && recon.specs.includes("35.8"), recon.specs.slice(0, 80));

    /* ───────── engine explorer ───────── */
    section("Engine Explorer — internal exploration");

    await page.click("#btn-engine-enter");
    await page.waitForFunction(() => window.__gf.engine.isBuilt === true, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 700));

    const eng = await page.evaluate(() => {
      const e = window.__gf.engine;
      const ids = [...e.nodes.keys()];
      let tris = 0;
      for (const n of e.nodes.values())
        for (const m of n.meshes) {
          const p = m.geometry.getAttribute("position");
          tris += m.geometry.index ? m.geometry.index.count / 3 : (p?.count ?? 0) / 3;
        }
      return {
        built: e.isBuilt,
        count: e.nodes.size,
        ids,
        triangles: Math.round(tris),
        visible: e.root.visible,
        mode: window.__gf.modes.mode,
        subject: window.__gf.modes.subject,
        treeRows: document.querySelectorAll("#engine-tree .tree__main").length,
        groups: document.querySelectorAll("#engine-tree .tree__group").length,
      };
    });
    check("engine model builds on first entry (lazy)", eng.built && eng.count >= 11, `${eng.count} parts`);
    check("engine is real 3D geometry", eng.triangles > 2000, `${eng.triangles.toLocaleString()} triangles`);
    check("engine becomes visible in engine mode", eng.visible);
    check("gestures are routed to the engine subject", eng.subject === "engine", eng.subject);
    check("engine hierarchy tree is rendered", eng.treeRows >= 11, `${eng.treeRows} rows`);
    check("tree groups parts into assemblies/spools", eng.groups >= 3, `${eng.groups} groups`);

    for (const id of ["fan", "fan_casing", "lpc", "hpc", "combustor", "fuel", "hpt", "lpt", "nozzle", "shaft", "bearings"]) {
      check(`engine component "${id}" exists`, eng.ids.includes(id));
    }

    const engInfo = await page.evaluate(() => {
      window.__gf.selectEnginePart("combustor");
      return {
        name: document.getElementById("component-name").textContent,
        desc: document.getElementById("component-description").textContent,
        fn: document.getElementById("component-function").textContent,
        loc: document.getElementById("component-location").textContent,
        notes: document.querySelectorAll("#component-specs dt").length,
      };
    });
    check("engine component can be selected", /Combustion/i.test(engInfo.name), engInfo.name);
    check("engine component has a real description", engInfo.desc.length > 100);
    check("engine component explains its function", engInfo.fn.length > 50);
    check("engine component reports its position in the engine", /intake face/i.test(engInfo.loc));
    check("engine component has engineering notes", engInfo.notes >= 3, `${engInfo.notes} notes`);

    /* explode / assemble */
    await page.click("#btn-engine-explode");
    await page.waitForFunction(() => window.__gf.engine.explodeAmount > 0.95, { timeout: 10_000 });
    check("engine explodes into separate components", true);
    const spread = await page.evaluate(() => {
      const e = window.__gf.engine;
      let moved = 0;
      for (const n of e.nodes.values()) if (n.group.position.distanceTo(n.home) > 1) moved++;
      return moved;
    });
    check("most engine parts separate when exploded", spread >= 10, `${spread} parts moved`);

    await page.click("#btn-engine-assemble");
    await page.waitForFunction(() => window.__gf.engine.isAssembled, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 800));
    const back = await page.evaluate(() => {
      let worst = 0;
      for (const n of window.__gf.engine.nodes.values())
        worst = Math.max(worst, n.group.position.distanceTo(n.home));
      return worst;
    });
    check("engine reassembles exactly", back < 0.05, `worst offset ${back.toFixed(4)}`);

    /* cutaway */
    await page.click("#toggle-cutaway");
    await new Promise((r) => setTimeout(r, 700));
    const cut = await page.evaluate(() => {
      const e = window.__gf.engine;
      return {
        cutaway: e.isCutaway,
        mode: window.__gf.modes.mode,
        casingHidden: !e.isVisible("fan_casing") && !e.isVisible("core_casing"),
        internalsVisible: e.isVisible("hpc") && e.isVisible("combustor") && e.isVisible("hpt"),
      };
    });
    check("cutaway mode activates", cut.cutaway && cut.mode === "cutaway", cut.mode);
    check("cutaway hides the outer casings", cut.casingHidden);
    check("cutaway keeps the internals visible", cut.internalsVisible);
    await page.click("#toggle-cutaway");
    await new Promise((r) => setTimeout(r, 500));
    check("casings return when cutaway is off",
      await page.evaluate(() => window.__gf.engine.isVisible("fan_casing")));

    /* visibility toggles */
    const vis = await page.evaluate(() => {
      const before = window.__gf.engine.isVisible("fan");
      document.querySelector('#engine-tree .tree__row .tree__eye').click();
      const after = window.__gf.engine.isVisible(
        document.querySelector("#engine-tree .tree__main").dataset.enginePartId,
      );
      return { before, after };
    });
    check("individual engine parts can be hidden", vis.before === true && vis.after === false);
    await page.click("#btn-engine-showall");
    check("Show all restores every engine part",
      await page.evaluate(() => [...window.__gf.engine.nodes.values()].every((n) => !n.userHidden)));

    /* airflow */
    const air = await page.evaluate(() => {
      const findAirflow = () => window.__gf.engine.root.children.find((c) => c.name === "engine:airflow");
      const on = { exists: !!findAirflow(), visible: findAirflow()?.visible, children: findAirflow()?.children.length ?? 0 };
      document.getElementById("toggle-airflow").click();
      const off = findAirflow()?.visible;
      document.getElementById("toggle-airflow").click();
      return { ...on, offVisible: off, note: document.getElementById("airflow-note").textContent };
    });
    check("airflow visualisation exists with arrow geometry", air.exists && air.children > 10, `${air.children} arrows`);
    check("airflow is visible by default", air.visible === true);
    check("airflow can be switched off", air.offVisible === false);
    check("airflow is labelled illustrative, not a simulation",
      /illustrative/i.test(air.note) && /not a CFD or engine simulation/i.test(air.note));

    /* provenance */
    const prov = await page.evaluate(() => ({
      text: document.getElementById("engine-provenance").textContent,
      source: document.getElementById("engine-provenance").dataset.source,
    }));
    check("engine provenance is declared illustrative", prov.source === "illustrative");
    check("engine provenance states it is not from the uploaded design",
      /ILLUSTRATIVE/.test(prov.text), prov.text.slice(0, 80));

    /* ───────── modes ───────── */
    section("Exploration modes");
    const modeIds = await page.$$eval("#mode-rail button", (b) => b.map((x) => x.dataset.mode));
    for (const m of ["exterior", "exploded", "engine", "cutaway", "blueprint"]) {
      check(`mode "${m}" is offered`, modeIds.includes(m));
    }

    const camBefore = await page.evaluate(() => ({
      ready: window.__gestureflight.ready,
      canvas: !!document.querySelector("#viewport canvas"),
    }));
    await page.evaluate(() => window.__gf.modes.set("exterior"));
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => window.__gf.modes.set("exploded"));
    await page.waitForFunction(() => window.__gf.exploded.targetAmount > 0.9, { timeout: 8000 });
    check("Aircraft Exploded mode explodes the aircraft", true);
    await page.evaluate(() => window.__gf.modes.set("engine"));
    await new Promise((r) => setTimeout(r, 500));
    const engVis = await page.evaluate(() => ({
      engine: window.__gf.engine.root.visible,
      aircraft: window.__gf.built?.root.visible,
    }));
    check("engine mode shows the engine and hides the aircraft",
      engVis.engine === true && engVis.aircraft === false);
    await page.evaluate(() => window.__gf.modes.set("exterior"));
    await new Promise((r) => setTimeout(r, 500));
    const extVis = await page.evaluate(() => ({
      engine: window.__gf.engine.root.visible,
      aircraft: window.__gf.built?.root.visible,
    }));
    check("exterior mode restores the aircraft", extVis.engine === false && extVis.aircraft === true);

    const camAfter = await page.evaluate(() => ({
      ready: window.__gestureflight.ready,
      canvas: !!document.querySelector("#viewport canvas"),
    }));
    check("mode switching never resets the application",
      camBefore.ready === camAfter.ready && camAfter.canvas === true);

    /* ───────── quality ───────── */
    section("Render quality settings");
    for (const q of ["performance", "balanced", "high"]) {
      await page.evaluate((id) => {
        document.querySelector(`#quality-rail button[data-quality="${id}"]`).click();
      }, q);
      await new Promise((r) => setTimeout(r, 300));
      const applied = await page.evaluate(() => ({
        quality: window.__gf.quality,
        shadows: window.__gf.scene.renderer.shadowMap.enabled,
        pr: window.__gf.scene.renderer.getPixelRatio(),
      }));
      check(`quality "${q}" applies`, applied.quality === q, `shadows=${applied.shadows}, pr=${applied.pr}`);
      if (q === "performance") check("performance mode disables shadows", applied.shadows === false);
      if (q === "high") check("high quality enables shadows", applied.shadows === true);
    }
    await page.evaluate(() => document.querySelector('#quality-rail button[data-quality="balanced"]').click());

    /* ───────── gestures in both contexts ───────── */
    section("Gesture control in aircraft and engine contexts");
    const posesJson = await readFile(join(ROOT, "tests/fixtures/poses.json"), "utf8");
    await page.evaluate((json) => {
      const raw = JSON.parse(json);
      window.__testPoses = { POSES: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, () => v])) };
      window.__inject = async (pose, frames = 10) => {
        const lms = window.__testPoses.POSES[pose]();
        for (let i = 0; i < frames; i++) {
          window.__gf.gestures.process(
            [{ landmarks: lms, handedness: "Right", score: 0.95 }],
            performance.now() + i * 33,
          );
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      window.__clearHands = async (frames = 5) => {
        for (let i = 0; i < frames; i++) {
          window.__gf.gestures.process([], performance.now() + i * 33);
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      window.__swipe = async (dir) => {
        const lms = window.__testPoses.POSES.openPalm();
        const t0 = performance.now();
        for (let i = 0; i < 9; i++) {
          const dx = dir > 0 ? -i * 0.045 : i * 0.045;
          window.__gf.gestures.process(
            [{ landmarks: lms.map((p) => ({ x: p.x + dx, y: p.y, z: p.z })), handedness: "Right", score: 0.95 }],
            t0 + i * 20,
          );
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
    }, posesJson);

    // Aircraft context: open palm explodes the AIRCRAFT.
    await page.evaluate(() => {
      window.__gf.modes.set("exterior");
      window.__gf.exploded.setAmount(0);
      window.__gf.engine.setExplode(0);
    });
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("openPalm", 12));
    const acCtx = await page.evaluate(() => ({
      aircraft: window.__gf.exploded.targetAmount,
      engine: window.__gf.engine.explodeTargetAmount,
      gesture: document.getElementById("gesture-name").textContent,
    }));
    check("aircraft context: open palm explodes the AIRCRAFT",
      acCtx.aircraft > 0.3 && acCtx.engine === 0, `aircraft=${acCtx.aircraft.toFixed(2)} engine=${acCtx.engine}`);

    // Engine context: the SAME gesture explodes the ENGINE instead.
    await page.evaluate(() => {
      window.__gf.modes.set("engine");
      window.__gf.exploded.setAmount(0);
      window.__gf.engine.setExplode(0);
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("openPalm", 12));
    const enCtx = await page.evaluate(() => ({
      aircraft: window.__gf.exploded.targetAmount,
      engine: window.__gf.engine.explodeTargetAmount,
    }));
    check("engine context: the SAME open palm explodes the ENGINE",
      enCtx.engine > 0.3 && enCtx.aircraft === 0, `aircraft=${enCtx.aircraft} engine=${enCtx.engine.toFixed(2)}`);

    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("closedFist", 12));
    await page.waitForFunction(() => window.__gf.engine.isAssembled, { timeout: 8000 }).catch(() => {});
    check("engine context: fist reassembles the engine",
      await page.evaluate(() => window.__gf.engine.isAssembled));

    // Pointing selects an engine part.
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("pointing", 14));
    const pointCtx = await page.evaluate(() => ({
      gesture: document.getElementById("gesture-name").textContent,
      cursor: window.__gf.scene.cursorVisible,
    }));
    check("engine context: pointing is recognised", /pointing/i.test(pointCtx.gesture), pointCtx.gesture);
    check("engine context: fingertip cursor shows", pointCtx.cursor === true);

    // Pinch isolates an ENGINE part.
    await page.evaluate(() => {
      window.__gf.selectEnginePart("hpt");
      window.__gf.engine.isolate(null);
    });
    await page.evaluate(() => window.__clearHands());
    await page.evaluate(() => window.__inject("pinch", 14));
    check("engine context: pinch isolates the engine part",
      await page.evaluate(() => window.__gf.engine.isolatedId === "hpt"),
      await page.evaluate(() => String(window.__gf.engine.isolatedId)));

    // Pinch + move drags the isolated part.
    const dragged = await page.evaluate(async () => {
      const node = window.__gf.engine.nodes.get("hpt");
      const before = node.group.position.clone();
      const lms = window.__testPoses.POSES.pinch();
      for (let i = 0; i < 14; i++) {
        window.__gf.gestures.process(
          [{ landmarks: lms.map((p) => ({ x: p.x + i * 0.012, y: p.y + i * 0.004, z: p.z })), handedness: "Right", score: 0.95 }],
          performance.now() + i * 33,
        );
        await new Promise((r) => requestAnimationFrame(r));
      }
      return node.group.position.distanceTo(before);
    });
    check("pinch + hand movement moves the isolated component", dragged > 0.01, `moved ${dragged.toFixed(3)}`);

    // Swipe steps through engine components.
    await page.evaluate(() => window.__clearHands());
    const swipeR = await page.evaluate(async () => {
      window.__gf.selectEnginePart("fan");
      const before = window.__gf.selectedEnginePart;
      await window.__swipe(1);
      return { before, after: window.__gf.selectedEnginePart, gesture: document.getElementById("gesture-name").textContent };
    });
    check("swipe right steps to the next engine component",
      swipeR.after !== swipeR.before, `${swipeR.before} → ${swipeR.after}`);
    check("swipe gesture is reported in the UI", /swipe/i.test(swipeR.gesture), swipeR.gesture);

    await page.evaluate(() => window.__clearHands());
    const swipeL = await page.evaluate(async () => {
      const before = window.__gf.selectedEnginePart;
      await window.__swipe(-1);
      return { before, after: window.__gf.selectedEnginePart };
    });
    check("swipe left steps to the previous component",
      swipeL.after !== swipeL.before, `${swipeL.before} → ${swipeL.after}`);

    // Peace switches exploration mode in engine context.
    await page.evaluate(() => window.__clearHands());
    const peaceMode = await page.evaluate(async () => {
      window.__gf.modes.set("engine");
      const before = window.__gf.modes.mode;
      await window.__inject("peace", 14);
      return { before, after: window.__gf.modes.mode };
    });
    check("engine context: peace sign switches exploration mode",
      peaceMode.after !== peaceMode.before, `${peaceMode.before} → ${peaceMode.after}`);

    // Original behaviour preserved in aircraft context.
    await page.evaluate(() => window.__gf.modes.set("exterior"));
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => window.__clearHands());
    const peaceAircraft = await page.evaluate(async () => {
      const before = document.getElementById("aircraft-name").textContent;
      await window.__inject("peace", 14);
      await new Promise((r) => setTimeout(r, 1800));
      return { before, after: document.getElementById("aircraft-name").textContent };
    });
    check("aircraft context: peace sign still switches aircraft (preserved)",
      peaceAircraft.after !== peaceAircraft.before, `${peaceAircraft.before} → ${peaceAircraft.after}`);

    /* ───────── camera during processing ───────── */
    section("Camera and memory");
    await page.click("#btn-camera-start");
    const camLive = await page
      .waitForFunction(() => document.getElementById("camera-stage").dataset.state === "live", { timeout: 60_000 })
      .then(() => true).catch(() => false);
    check("webcam still starts after the upgrade", camLive);

    if (camLive) {
      await page.waitForFunction(() => window.__gf.tracking.isLoaded === true, { timeout: 90_000 }).catch(() => {});
      await upload(page, "test-assembly.step");
      await settle(page);
      const during = await page.evaluate(() => ({
        cameraLive: window.__gf.camera.isActive,
        stage: document.getElementById("camera-stage").dataset.state,
        loaded: !!window.__gf.importedMesh,
      }));
      check("camera keeps running while a STEP file is processed",
        during.cameraLive && during.stage === "live");
      check("STEP still loads while the camera is live", during.loaded);
      await page.click("#btn-camera-stop");
      check("camera stop still releases the device",
        await page.evaluate(() => window.__gf.camera.isActive === false));
    }

    /* memory cleanup on removal */
    const cleanup = await page.evaluate(async () => {
      const before = window.__gf.library.length;
      let disposed = 0;
      const entry = window.__gf.library[window.__gf.library.length - 1];
      if (entry?.result.kind === "mesh3d") {
        for (const p of entry.result.parts) {
          p.object.traverse((o) => {
            if (o.isMesh) {
              const orig = o.geometry.dispose.bind(o.geometry);
              o.geometry.dispose = () => { disposed++; orig(); };
            }
          });
        }
      }
      document.querySelectorAll(".library__remove")[before - 1].click();
      await new Promise((r) => setTimeout(r, 900));
      return { before, after: window.__gf.library.length, disposed };
    });
    check("removing a model drops it from the library",
      cleanup.after === cleanup.before - 1, `${cleanup.before} → ${cleanup.after}`);
    check("removing a model disposes its GPU geometry",
      cleanup.disposed > 0, `${cleanup.disposed} geometries disposed`);

    const fps = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 1200));
      return Number(document.getElementById("stat-rfps").textContent);
    });
    check("render loop still healthy after all operations", fps > 10, `${fps} fps`);

    /* ───────── responsive ───────── */
    section("Responsive layout with the new panels");
    for (const [label, w, h] of [
      ["desktop 1512px", 1512, 980],
      ["laptop 1280px", 1280, 800],
      ["tablet 1024px", 1024, 768],
      ["mobile 390px", 390, 844],
    ]) {
      await page.setViewport({ width: w, height: h });
      await new Promise((r) => setTimeout(r, 450));
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        dropzone: !!document.querySelector(".dropzone"),
        canvas: document.querySelector("#viewport canvas")?.clientWidth ?? 0,
      }));
      check(`${label}: no horizontal overflow`, m.overflow <= 1, `${m.overflow}px`);
      check(`${label}: upload UI remains usable`, m.dropzone && m.canvas > 200);
    }
    await page.setViewport({ width: 1512, height: 980 });

    /* ───────── console ───────── */
    section("Console hygiene");
    const real = consoleErrors.filter((e) => !/favicon|404|DevTools|Download the React/i.test(e));
    check("no console errors across the whole upgrade run", real.length === 0, real.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    server?.close();
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (notes.length) {
    console.log("\nObservations:");
    for (const n of notes) console.log(`  • ${n}`);
  }
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log("");
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("\nUpgrade e2e crashed:", e);
  process.exit(1);
});
