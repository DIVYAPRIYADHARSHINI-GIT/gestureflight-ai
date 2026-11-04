/**
 * Jet engine component library for the Engine Explorer.
 *
 * DATA HONESTY (§6): this describes HOW A TWO-SPOOL HIGH-BYPASS TURBOFAN WORKS
 * in general engineering terms. There are deliberately NO invented dimensions,
 * pressure ratios, temperatures, thrust figures or stage counts presented as
 * fact for a specific engine. Where a representative number genuinely helps
 * teaching, it is marked "typical" and describes the class, not a product.
 *
 * The geometry built from this is explicitly labelled ILLUSTRATIVE in the UI.
 */

export interface EnginePartSpec {
  id: string;
  name: string;
  /** Spool / assembly this part belongs to — drives the hierarchy tree (§9). */
  parent: string;
  stage: "intake" | "fan" | "compressor" | "combustor" | "turbine" | "exhaust" | "structure";
  description: string;
  fn: string;
  /** Qualitative engineering notes — no fabricated performance figures. */
  notes: Record<string, string>;
  /** Axial position along the engine, 0 = intake face, 1 = nozzle exit. */
  axial: number;
  /** Direction the part travels in the engine exploded view. */
  explode: [number, number, number];
  /** Part of the outer casing — hidden in cutaway mode. */
  casing?: boolean;
}

export const ENGINE_PARTS: EnginePartSpec[] = [
  {
    id: "fan_casing",
    name: "Fan Casing",
    parent: "Cold section",
    stage: "fan",
    casing: true,
    description:
      "The large structural ring around the fan, lined with acoustic panels and a containment layer. The containment ring is the heavy structural feature: it must retain a released fan blade inside the nacelle.",
    fn: "Contains a fan-blade-off event, forms the outer wall of the bypass duct, carries nacelle loads and absorbs fan noise.",
    notes: {
      Structure: "Containment ring + acoustic liner",
      "Critical case": "Fan blade-off containment",
      Material: "Composite or aluminium alloy (typical)",
      "Noise control": "Perforated acoustic liner",
    },
    axial: 0.1,
    explode: [0, 1, 0],
  },
  {
    id: "fan",
    name: "Fan Blades",
    parent: "Low-pressure spool",
    stage: "fan",
    description:
      "The first and largest set of blades. On a high-bypass turbofan the fan is the primary thrust producer — most of the air it accelerates bypasses the core entirely and goes straight out of the bypass duct.",
    fn: "Accelerates a large mass of air rearwards at modest velocity, which is the efficient way to make thrust. A small fraction is fed into the core as the engine's air supply.",
    notes: {
      "Driven by": "Low-pressure turbine, via the LP shaft",
      "Blade form": "Wide-chord, swept, hollow or composite",
      "Bypass ratio": "High on modern airliner engines",
      "Why it works": "Large mass flow, small velocity change",
    },
    axial: 0.14,
    explode: [1, 0.3, 0],
  },
  {
    id: "lpc",
    name: "Low-Pressure Compressor",
    parent: "Low-pressure spool",
    stage: "compressor",
    description:
      "The booster: several axial stages immediately behind the fan root, on the same shaft as the fan. Each stage is a rotating blade row followed by a stationary vane row that straightens the flow.",
    fn: "Gives the core air its first real pressure rise before it reaches the high-pressure compressor, and runs at the slower LP shaft speed.",
    notes: {
      "Driven by": "Low-pressure turbine (same shaft as the fan)",
      "Stage design": "Rotor blade row + stator vane row",
      Function: "First stage of core compression",
      "Shaft speed": "Lower than the HP spool",
    },
    axial: 0.26,
    explode: [0.6, -0.8, 0.3],
  },
  {
    id: "hpc",
    name: "High-Pressure Compressor",
    parent: "High-pressure spool",
    stage: "compressor",
    description:
      "Many axial stages that do the bulk of the compression. Blades get dramatically smaller towards the rear because the air occupies far less volume as its pressure rises. Variable stator vanes ahead of the first stages keep the flow angles correct across the operating range.",
    fn: "Raises the core air to its maximum pressure before combustion. Higher overall pressure ratio means better thermal efficiency.",
    notes: {
      "Driven by": "High-pressure turbine",
      "Stage count": "Many stages (varies by engine)",
      "Variable vanes": "Prevent stall away from design point",
      "Why blades shrink": "Air volume falls as pressure rises",
      "Bleed air": "Tapped here for cabin air and anti-ice",
    },
    axial: 0.4,
    explode: [0.3, 1, 0.4],
  },
  {
    id: "combustor",
    name: "Combustion Chamber",
    parent: "Core",
    stage: "combustor",
    description:
      "An annular chamber where fuel burns continuously. Only part of the incoming air takes part in combustion; the rest forms a protective cooling film along the liner walls, because the flame is far hotter than the metal could survive unprotected.",
    fn: "Adds energy to the airflow at essentially constant pressure, producing the hot high-energy gas that drives the turbines.",
    notes: {
      Type: "Annular, continuous combustion",
      "Air split": "Primary (burn) + secondary (cooling/dilution)",
      "Liner cooling": "Film cooling, thermal barrier coating",
      Ignition: "Igniters for start and relight only",
      Emissions: "Staged/lean designs reduce NOx",
    },
    axial: 0.52,
    explode: [0, -1, 0.6],
  },
  {
    id: "fuel",
    name: "Fuel Injection System",
    parent: "Core",
    stage: "combustor",
    description:
      "Fuel nozzles spaced around the combustor dome that atomise fuel into a fine spray and mix it with swirling air. Good atomisation is what makes combustion stable and clean.",
    fn: "Meters and atomises fuel so it burns completely and evenly; the metering unit sets engine power.",
    notes: {
      "Nozzle type": "Airblast or pressure-atomising",
      Arrangement: "Ring of nozzles around the dome",
      Control: "Fuel metering unit sets thrust",
      Goal: "Fine spray, even temperature profile",
    },
    axial: 0.49,
    explode: [-0.2, -0.6, 1],
  },
  {
    id: "hpt",
    name: "High-Pressure Turbine",
    parent: "High-pressure spool",
    stage: "turbine",
    description:
      "The first turbine stage(s) behind the combustor, and the hottest part of the engine. Blades are single-crystal castings with internal cooling passages and a thermal barrier coating — gas temperature at inlet exceeds the melting point of the alloy, so the blades are actively air-cooled from inside.",
    fn: "Extracts energy from the hot gas to drive the high-pressure compressor through the HP shaft.",
    notes: {
      Drives: "High-pressure compressor",
      "Blade tech": "Single-crystal, internally air-cooled",
      Coating: "Thermal barrier coating",
      "Cooling air": "Bled from the HP compressor",
      "Key point": "Gas is hotter than the metal's melting point",
    },
    axial: 0.63,
    explode: [-0.3, 1, -0.4],
  },
  {
    id: "lpt",
    name: "Low-Pressure Turbine",
    parent: "Low-pressure spool",
    stage: "turbine",
    description:
      "Several larger-diameter stages downstream of the HP turbine, running cooler and slower. It is physically bigger because the gas has already expanded and lost much of its pressure.",
    fn: "Extracts the remaining useful energy to drive the fan and low-pressure compressor through the LP shaft.",
    notes: {
      Drives: "Fan + low-pressure compressor",
      "Stage count": "Multiple stages (varies by engine)",
      Conditions: "Cooler and slower than the HP turbine",
      "Why larger": "Gas has expanded, so needs more area",
    },
    axial: 0.73,
    explode: [-0.6, -0.9, -0.3],
  },
  {
    id: "shaft",
    name: "Engine Shafts",
    parent: "Structure",
    stage: "structure",
    description:
      "Two concentric shafts. The inner LP shaft connects the fan and LP compressor to the LP turbine; the hollow outer HP shaft connects the HP compressor to the HP turbine. They rotate independently, at different speeds, and often in opposite directions.",
    fn: "Transmit turbine torque forward to the compressors. Two independent spools let each compressor run at its own efficient speed.",
    notes: {
      Arrangement: "Two concentric spools (LP inside HP)",
      "LP spool": "Fan + LPC ← LP turbine",
      "HP spool": "HPC ← HP turbine",
      "Why two": "Each spool runs at its own best speed",
      Rotation: "Often counter-rotating",
    },
    axial: 0.45,
    explode: [0, 0, -1],
  },
  {
    id: "bearings",
    name: "Bearings & Supports",
    parent: "Structure",
    stage: "structure",
    description:
      "Rolling-element bearings located at structural frames along the engine. Ball bearings take axial thrust load; roller bearings take radial load and allow axial growth as the engine heats up. Each sits in an oil-fed, sealed sump.",
    fn: "Locate and support both rotating spools, carry thrust and radial loads into the engine structure, and keep blade tip clearances controlled.",
    notes: {
      "Ball bearings": "Carry axial thrust load",
      "Roller bearings": "Carry radial load, allow growth",
      Lubrication: "Pressurised oil, sealed sumps",
      "Squeeze film": "Damps rotor vibration",
    },
    axial: 0.35,
    explode: [0.4, -0.4, -0.8],
  },
  {
    id: "nozzle",
    name: "Exhaust Nozzle",
    parent: "Hot section",
    stage: "exhaust",
    casing: true,
    description:
      "The convergent duct and centre plug at the rear. On a civil turbofan the nozzle is a fixed shape; its area is chosen so the core flow expands correctly at cruise. Chevrons on the trailing edge mix the hot core and cold bypass streams to cut noise.",
    fn: "Accelerates the exhaust gas to produce the core's share of thrust and sets the back-pressure the turbines work against.",
    notes: {
      Geometry: "Fixed convergent (civil turbofan)",
      "Centre plug": "Smooths core flow, reduces base drag",
      Chevrons: "Mix hot/cold streams to reduce noise",
      "Military contrast": "Variable con-di nozzle + afterburner",
    },
    axial: 0.9,
    explode: [-1, 0.2, 0],
  },
  {
    id: "core_casing",
    name: "Core Casing",
    parent: "Structure",
    stage: "structure",
    casing: true,
    description:
      "The pressure-bearing wall around the core gas path, with the bypass duct outside it. In cutaway mode this is the surface that is removed to reveal the compressor, combustor and turbine stages.",
    fn: "Contains core pressure, carries structural loads between frames, and forms the inner wall of the bypass duct.",
    notes: {
      Role: "Core pressure vessel + structure",
      "Bypass duct": "Annulus outside this casing",
      "Mount loads": "Transfers thrust to the pylon",
      "In cutaway": "This is the part that is removed",
    },
    axial: 0.45,
    explode: [0, 0.8, 0.5],
  },
];

/** Airflow path shown by the animated arrows (§6) — illustrative, not CFD. */
export const AIRFLOW_PATH = [
  { at: 0.02, label: "Air intake" },
  { at: 0.14, label: "Fan" },
  { at: 0.33, label: "Compressor" },
  { at: 0.52, label: "Combustion chamber" },
  { at: 0.68, label: "Turbine" },
  { at: 0.95, label: "Exhaust" },
] as const;

export function enginePartById(id: string): EnginePartSpec | undefined {
  return ENGINE_PARTS.find((p) => p.id === id);
}

/** Groups parts by their parent assembly for the hierarchy tree. */
export function engineHierarchy(): Map<string, EnginePartSpec[]> {
  const map = new Map<string, EnginePartSpec[]>();
  for (const p of ENGINE_PARTS) {
    const list = map.get(p.parent) ?? [];
    list.push(p);
    map.set(p.parent, list);
  }
  return map;
}
