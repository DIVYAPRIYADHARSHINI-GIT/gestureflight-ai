/**
 * UploadPanel — the Upload Aircraft Design UI, the model library, the
 * blueprint reference viewer and the assisted-reconstruction form.
 *
 * It owns only DOM; all parsing is delegated to AircraftFileProcessor and all
 * geometry to the existing scene. Markup is built with createElement + textContent
 * (never innerHTML with file-derived strings), so a hostile filename cannot
 * inject markup.
 */

import {
  ACCEPT_ATTRIBUTE,
  FORMATS,
  formatBytes,
  STAGES,
  type BlueprintImportResult,
  type BlueprintPage,
  type ImportResult,
  type MeshImportResult,
  type ProgressReport,
} from "./AircraftFileProcessor";

export interface LibraryEntry {
  id: string;
  name: string;
  format: string;
  bytes: number;
  kind: "mesh3d" | "blueprint";
  result: ImportResult;
}

export interface UploadPanelHandlers {
  onFiles(files: FileList | File[]): void;
  onSelectEntry(id: string): void;
  onRemoveEntry(id: string): void;
  onReconstruct(dims: { length: number; span: number; height: number }): void;
  onUseGenerated(): void;
}

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

export class UploadPanel {
  private handlers!: UploadPanelHandlers;
  private dropZone!: HTMLElement;
  private input!: HTMLInputElement;
  private statusBox!: HTMLElement;
  private libraryBox!: HTMLElement;
  private errorBox!: HTMLElement;
  private blueprintBox!: HTMLElement;

  /** Blueprint viewer pan/zoom state. */
  private bpZoom = 1;
  private bpPan = { x: 0, y: 0 };
  private bpPage = 0;
  private bpCurrent: BlueprintImportResult | null = null;

  mount(container: HTMLElement, handlers: UploadPanelHandlers): void {
    this.handlers = handlers;
    container.replaceChildren();

    /* ── drop zone ── */
    this.input = el("input", { type: "file", accept: ACCEPT_ATTRIBUTE, multiple: false });
    this.input.style.display = "none";
    this.input.addEventListener("change", () => {
      if (this.input.files?.length) handlers.onFiles(this.input.files);
      this.input.value = ""; // allow re-uploading the same file
    });

    this.dropZone = el("div", { className: "dropzone", tabIndex: 0 }, [
      el("div", { className: "dropzone__icon", textContent: "⬆" }),
      el("strong", { className: "dropzone__title", textContent: "Upload Aircraft Design" }),
      el("span", {
        className: "dropzone__hint",
        textContent: "Drag a file here, or click to browse",
      }),
      el("span", {
        className: "dropzone__formats",
        textContent: "STEP · STP · STL · OBJ · GLB · GLTF · PDF · PNG · JPG",
      }),
      el("span", {
        className: "dropzone__privacy",
        textContent: "Processed in your browser. Your file is never uploaded.",
      }),
    ]);

    const open = () => this.input.click();
    this.dropZone.addEventListener("click", open);
    this.dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });

    for (const type of ["dragenter", "dragover"]) {
      this.dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        this.dropZone.classList.add("is-over");
      });
    }
    for (const type of ["dragleave", "drop"]) {
      this.dropZone.addEventListener(type, (e) => {
        e.preventDefault();
        this.dropZone.classList.remove("is-over");
      });
    }
    this.dropZone.addEventListener("drop", (e) => {
      const dt = (e as DragEvent).dataTransfer;
      if (dt?.files?.length) handlers.onFiles(dt.files);
    });

    this.errorBox = el("p", { className: "upload__error" });
    this.errorBox.hidden = true;

    this.statusBox = el("div", { className: "upload__status" });
    this.statusBox.hidden = true;

    this.libraryBox = el("div", { className: "library" });

    this.blueprintBox = el("div", { className: "blueprint" });
    this.blueprintBox.hidden = true;

    container.append(
      this.input,
      this.dropZone,
      this.errorBox,
      this.statusBox,
      el("h3", { className: "panel__subtitle", textContent: "Uploaded model library" }),
      this.libraryBox,
      this.blueprintBox,
    );

    this.renderLibrary([], null);
  }

  /* ───────── processing status (§1, §3) ───────── */

  showProgress(filename: string, spec: { label: string }, bytes: number, r: ProgressReport | null): void {
    this.statusBox.hidden = false;
    this.errorBox.hidden = true;
    this.statusBox.replaceChildren();

    const head = el("div", { className: "upload__head" }, [
      el("span", { className: "upload__name", textContent: filename }),
      el("span", { className: "upload__meta", textContent: `${spec.label} · ${formatBytes(bytes)}` }),
    ]);

    const pct = r ? Math.round(r.progress * 100) : 0;
    const bar = el("div", { className: "upload__bar" }, [
      el("div", { className: "upload__fill" }),
    ]);
    (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;

    const stageLine = el("div", { className: "upload__stage" }, [
      el("span", {
        textContent: r ? `${r.stageIndex + 1}/${STAGES.length} ${r.stage}` : "Queued",
      }),
      el("b", { textContent: `${pct}%` }),
    ]);

    const detail = el("span", { className: "upload__detail", textContent: r?.detail ?? "" });

    this.statusBox.append(head, stageLine, bar, detail);
  }

  hideProgress(): void {
    this.statusBox.hidden = true;
  }

  showError(message: string): void {
    this.statusBox.hidden = true;
    this.errorBox.hidden = false;
    this.errorBox.textContent = message;
  }

  clearError(): void {
    this.errorBox.hidden = true;
  }

  /* ───────── library (§10) ───────── */

  renderLibrary(entries: LibraryEntry[], activeId: string | null): void {
    this.libraryBox.replaceChildren();
    if (entries.length === 0) {
      this.libraryBox.append(
        el("p", {
          className: "panel__hint",
          textContent: "No uploaded designs yet. The four built-in aircraft remain available in the selector below.",
        }),
      );
      return;
    }

    for (const entry of entries) {
      const row = el("div", {
        className: `library__row${entry.id === activeId ? " is-active" : ""}`,
      });

      const main = el("button", { className: "library__main", type: "button" }, [
        el("span", { className: "library__name", textContent: entry.name }),
        el("span", {
          className: "library__meta",
          textContent:
            entry.result.kind === "mesh3d"
              ? `${entry.format.toUpperCase()} · ${entry.result.triangles.toLocaleString()} tris · ${entry.result.parts.length} part(s)`
              : `${entry.format.toUpperCase()} · ${entry.result.pages.length} page(s) · 2D reference`,
        }),
      ]);
      main.addEventListener("click", () => this.handlers.onSelectEntry(entry.id));

      const remove = el("button", {
        className: "library__remove",
        type: "button",
        title: `Remove ${entry.name}`,
        textContent: "✕",
      });
      remove.setAttribute("aria-label", `Remove ${entry.name}`);
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handlers.onRemoveEntry(entry.id);
      });

      row.append(main, remove);
      this.libraryBox.append(row);
    }
  }

  /* ───────── blueprint reference viewer (§2, §8) ───────── */

  showBlueprint(result: BlueprintImportResult): void {
    this.bpCurrent = result;
    this.bpPage = 0;
    this.bpZoom = 1;
    this.bpPan = { x: 0, y: 0 };
    this.blueprintBox.hidden = false;
    this.renderBlueprint();
  }

  hideBlueprint(): void {
    this.blueprintBox.hidden = true;
    this.bpCurrent = null;
  }

  private renderBlueprint(): void {
    const result = this.bpCurrent;
    if (!result) return;
    const page = result.pages[this.bpPage];
    this.blueprintBox.replaceChildren();

    const stage = el("div", { className: "blueprint__stage" });
    const holder = el("div", { className: "blueprint__holder" });
    // The page canvas is reused directly — no extra copy in memory.
    page.canvas.className = "blueprint__canvas";
    holder.append(page.canvas);
    stage.append(holder);
    this.applyBlueprintTransform(holder);

    // Pan by drag, zoom by wheel.
    let dragging = false;
    let last = { x: 0, y: 0 };
    stage.addEventListener("pointerdown", (e) => {
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.bpPan.x += e.clientX - last.x;
      this.bpPan.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      this.applyBlueprintTransform(holder);
    });
    const end = (e: PointerEvent) => {
      dragging = false;
      stage.releasePointerCapture?.(e.pointerId);
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.bpZoom = Math.min(8, Math.max(0.2, this.bpZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
        this.applyBlueprintTransform(holder);
      },
      { passive: false },
    );

    /* page / view controls */
    const controls = el("div", { className: "blueprint__controls" });
    if (result.pages.length > 1) {
      const prev = el("button", { className: "btn btn--sq", type: "button", textContent: "◀" });
      prev.addEventListener("click", () => {
        this.bpPage = (this.bpPage - 1 + result.pages.length) % result.pages.length;
        this.renderBlueprint();
      });
      const next = el("button", { className: "btn btn--sq", type: "button", textContent: "▶" });
      next.addEventListener("click", () => {
        this.bpPage = (this.bpPage + 1) % result.pages.length;
        this.renderBlueprint();
      });
      controls.append(prev, el("span", { className: "blueprint__page", textContent: `Page ${page.index}/${result.pages.length}` }), next);
    }
    const fit = el("button", { className: "btn", type: "button", textContent: "Fit" });
    fit.addEventListener("click", () => {
      this.bpZoom = 1;
      this.bpPan = { x: 0, y: 0 };
      this.applyBlueprintTransform(holder);
    });
    controls.append(fit);

    /* view classification — presented as a GUESS the user can override (§2) */
    const viewRow = el("div", { className: "blueprint__view" });
    const label = el("span", { className: "blueprint__viewlabel", textContent: "Detected view:" });
    const select = el("select", { className: "blueprint__select" });
    for (const v of ["top", "side", "front", "unknown"] as const) {
      const opt = el("option", { value: v, textContent: v === "unknown" ? "Not sure" : `${v[0].toUpperCase()}${v.slice(1)} view` });
      if (v === page.viewGuess) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      page.viewGuess = select.value as BlueprintPage["viewGuess"];
      page.viewReason = "Set manually by you.";
      this.renderBlueprint();
    });
    viewRow.append(label, select);

    const reason = el("p", { className: "blueprint__reason", textContent: page.viewReason });

    this.blueprintBox.append(
      el("h3", { className: "panel__subtitle", textContent: "Blueprint reference" }),
      stage,
      controls,
      viewRow,
      reason,
      this.buildReconstructionForm(result),
    );
  }

  private applyBlueprintTransform(holder: HTMLElement): void {
    holder.style.transform = `translate(${this.bpPan.x}px, ${this.bpPan.y}px) scale(${this.bpZoom})`;
  }

  /**
   * Assisted reconstruction (§2, §3). A 2D sheet cannot be turned into an
   * engineering-accurate 3D aircraft automatically, and this form says so. It
   * asks for the three dimensions needed to build a proportionally correct
   * envelope and labels the output RECONSTRUCTED, never imported.
   */
  private buildReconstructionForm(result: BlueprintImportResult): HTMLElement {
    const wrap = el("div", { className: "recon" });

    const views = new Set(result.pages.map((p) => p.viewGuess).filter((v) => v !== "unknown"));
    const have = views.size
      ? `Identified view(s): ${[...views].join(", ")}.`
      : "No orthographic view could be identified automatically.";

    wrap.append(
      el("h3", { className: "panel__subtitle", textContent: "Assisted 3D reconstruction" }),
      el("p", {
        className: "recon__honesty",
        textContent:
          "A 2D blueprint cannot be converted into an engineering-accurate 3D aircraft automatically. Enter the three overall dimensions from the drawing and GestureFlight will build a proportionally-correct airframe from them. The result is labelled RECONSTRUCTED, not imported.",
      }),
      el("p", { className: "panel__hint", textContent: have }),
    );

    const fields: Array<{ key: "length" | "span" | "height"; label: string; placeholder: string }> = [
      { key: "length", label: "Overall length (m)", placeholder: "e.g. 39.5" },
      { key: "span", label: "Wingspan (m)", placeholder: "e.g. 35.8" },
      { key: "height", label: "Overall height (m)", placeholder: "e.g. 12.5" },
    ];
    const inputs = new Map<string, HTMLInputElement>();
    const grid = el("div", { className: "recon__grid" });
    for (const f of fields) {
      const input = el("input", {
        className: "recon__input",
        type: "number",
        min: "0.1",
        step: "0.1",
        placeholder: f.placeholder,
      });
      inputs.set(f.key, input);
      grid.append(el("label", { className: "recon__field" }, [el("span", { textContent: f.label }), input]));
    }
    wrap.append(grid);

    const err = el("p", { className: "recon__error" });
    err.hidden = true;

    const build = el("button", { className: "btn btn--primary", type: "button", textContent: "Build 3D from dimensions" });
    build.addEventListener("click", () => {
      const vals = {
        length: Number(inputs.get("length")!.value),
        span: Number(inputs.get("span")!.value),
        height: Number(inputs.get("height")!.value),
      };
      const missing = Object.entries(vals).filter(([, v]) => !Number.isFinite(v) || v <= 0);
      if (missing.length) {
        // §3: ask for the information rather than inventing geometry.
        err.hidden = false;
        err.textContent = `Enter a positive value for: ${missing.map(([k]) => k).join(", ")}. Without these dimensions the aircraft cannot be reconstructed — GestureFlight will not invent them.`;
        return;
      }
      if (vals.span > vals.length * 4 || vals.length > vals.span * 6) {
        err.hidden = false;
        err.textContent = `Those proportions look implausible (length ${vals.length} m vs span ${vals.span} m). Check the units on the drawing.`;
        return;
      }
      err.hidden = true;
      this.handlers.onReconstruct(vals);
    });

    const fallback = el("button", { className: "btn btn--ghost", type: "button", textContent: "Use a generated aircraft instead" });
    fallback.addEventListener("click", () => this.handlers.onUseGenerated());

    wrap.append(
      el("div", { className: "btnrow" }, [build]),
      err,
      el("p", {
        className: "panel__hint",
        textContent: "Or skip reconstruction and explore a generated illustrative aircraft alongside the blueprint.",
      }),
      el("div", { className: "btnrow" }, [fallback]),
    );
    return wrap;
  }

  /** Summary line shown for a 3D import (§9, §16). */
  static describeMesh(r: MeshImportResult): string {
    const parts = r.hasSeparateComponents
      ? `${r.parts.length} separate objects`
      : "a single mesh (no separate components in the file)";
    return `${r.triangles.toLocaleString()} triangles, ${parts}.`;
  }
}

export { FORMATS };
