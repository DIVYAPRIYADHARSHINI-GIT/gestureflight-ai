/**
 * AircraftInformation — renders the aircraft spec panel, the component list and
 * the per-component information panel.
 *
 * All DOM writes go through textContent, never innerHTML with user/derived
 * strings, so the panel cannot inject markup.
 */

import { COMPONENT_ORDER, resolveComponent } from "../data/components";
import type { AircraftSpec } from "../types";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export class AircraftInformation {
  private onSelect: (id: string) => void = () => {};

  bind(onSelect: (id: string) => void): void {
    this.onSelect = onSelect;
  }

  renderAircraft(spec: AircraftSpec): void {
    $("aircraft-name").textContent = spec.name;
    $("aircraft-role").textContent = spec.role;

    const dl = $("aircraft-specs");
    dl.replaceChildren();
    for (const [k, v] of Object.entries(spec.specs)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }

    const note = $("aircraft-disclaimer");
    const omits = spec.profile.omits;
    note.textContent = omits?.length
      ? `${spec.note} Not modelled as separate geometry: ${omits.join(", ")}.`
      : spec.note;

    this.renderList(spec);
  }

  private renderList(spec: AircraftSpec): void {
    const ul = $("component-list");
    ul.replaceChildren();
    for (const id of COMPONENT_ORDER) {
      const c = resolveComponent(spec.profile.kind, id);
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.componentId = id;

      const label = document.createElement("span");
      label.textContent = c.name;
      const cat = document.createElement("span");
      cat.className = "complist__qty";
      cat.textContent = c.category.split(" ")[0];

      btn.append(label, cat);
      btn.addEventListener("click", () => this.onSelect(id));
      li.append(btn);
      ul.append(li);
    }
    $("component-count").textContent = `${COMPONENT_ORDER.length} explorable component groups`;
  }

  /** Marks the active row in the component list. */
  markActive(id: string | null): void {
    document.querySelectorAll<HTMLButtonElement>("#component-list button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.componentId === id);
    });
  }

  renderComponent(aircraftKind: string, componentId: string | null): void {
    const body = $("component-body");
    const hint = $("component-hint");

    if (!componentId) {
      $("component-name").textContent = "No component selected";
      hint.textContent = "Point your index finger at a part, or click it in the 3D view.";
      hint.hidden = false;
      body.hidden = true;
      this.markActive(null);
      return;
    }

    const c = resolveComponent(aircraftKind, componentId);
    $("component-name").textContent = c.name;
    hint.hidden = true;
    body.hidden = false;

    $("component-category").textContent = c.category;
    $("component-description").textContent = c.description;
    $("component-function").textContent = c.fn;
    $("component-location").textContent = c.location;

    const dl = $("component-specs");
    dl.replaceChildren();
    for (const [k, v] of Object.entries(c.specs)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }

    this.markActive(componentId);
  }

  /** Human-readable name, used by toasts and the HUD. */
  nameOf(aircraftKind: string, componentId: string): string {
    return resolveComponent(aircraftKind, componentId).name;
  }
}
