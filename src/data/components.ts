/**
 * Component library — the 13 explorable parts plus per-aircraft overrides.
 *
 * IMPORTANT: every numeric value here is ILLUSTRATIVE for this visualisation.
 * These are generic, rounded, textbook-style figures for a notional aircraft of
 * each class. They are NOT certified type-certificate data for any real
 * registered aircraft, and the UI labels them as such everywhere they appear.
 */

import type { ComponentSpec } from "../types";

export const COMPONENT_LIBRARY: Record<string, ComponentSpec> = {
  fuselage: {
    id: "fuselage",
    name: "Main Fuselage",
    category: "Primary structure",
    description:
      "The central pressurised body of the aircraft. It is a semi-monocoque tube: a thin stressed skin carrying most of the load, stiffened by circumferential frames and longitudinal stringers.",
    fn: "Carries the payload, joins the wings, tail and landing gear into one load path, and holds cabin pressure at altitude.",
    location: "Centre of the aircraft, running nose to tail along the longitudinal axis.",
    specs: {
      Structure: "Semi-monocoque",
      Material: "Al-Li alloy / CFRP skin",
      "Skin thickness": "~1.8–4 mm (illustrative)",
      "Frame pitch": "~500 mm (illustrative)",
      "Cabin ΔP": "~0.55 bar (illustrative)",
    },
    explode: [0, 0, 0],
  },
  nose: {
    id: "nose",
    name: "Nose Section",
    category: "Primary structure",
    description:
      "The forward fairing ahead of the pressure bulkhead. Its non-metallic radome covers the weather radar antenna and is shaped for low drag and bird-strike tolerance.",
    fn: "Streamlines the airflow entering the fuselage and houses the weather radar, pitot/static probes and forward avionics.",
    location: "Forward extremity of the fuselage, ahead of the cockpit.",
    specs: {
      "Radome material": "Glass-fibre laminate",
      "Radar band": "X-band (typical)",
      "Bird strike": "Certification case",
      Length: "~2.5 m (illustrative)",
    },
    explode: [1, 0.05, 0],
    explodeScale: 1.25,
  },
  cockpit: {
    id: "cockpit",
    name: "Cockpit Section",
    category: "Flight deck",
    description:
      "The crew compartment with the flight controls, instrument panels, glareshield and multi-pane windscreen. Windscreens are heated laminate to resist icing and impact.",
    fn: "Provides the crew with outside visibility, flight instruments and all primary and secondary control interfaces.",
    location: "Immediately aft of the nose, at the top of the forward fuselage.",
    specs: {
      Crew: "2 (typical airliner)",
      Windscreen: "Heated laminated glass/acrylic",
      Displays: "Glass cockpit, 4–6 LCDs",
      "Side window": "Openable (direct-vision)",
    },
    explode: [0.6, 0.85, 0],
    explodeScale: 1.1,
  },
  wing_left: {
    id: "wing_left",
    name: "Left Wing",
    category: "Lifting surface",
    description:
      "The port lifting surface. A swept cantilever box built from front and rear spars, ribs and stressed skin, with integral fuel tanks between the spars.",
    fn: "Generates roughly half the lift, carries fuel, mounts the left engine and transfers all of that load into the centre wing box.",
    location: "Port side of the fuselage, at the wing root fairing.",
    specs: {
      Planform: "Swept, tapered cantilever",
      Sweep: "~25° at ¼-chord (illustrative)",
      Dihedral: "~5° (illustrative)",
      Structure: "Two-spar torsion box",
      "Fuel volume": "Integral wet wing",
    },
    explode: [0, 0.15, -1],
    explodeScale: 1.15,
  },
  wing_right: {
    id: "wing_right",
    name: "Right Wing",
    category: "Lifting surface",
    description:
      "The starboard lifting surface, geometrically the mirror of the left wing. It carries the right engine, integral fuel tanks and the starboard high-lift devices.",
    fn: "Generates roughly half the lift, carries fuel, mounts the right engine and feeds load into the centre wing box.",
    location: "Starboard side of the fuselage, at the wing root fairing.",
    specs: {
      Planform: "Swept, tapered cantilever",
      Sweep: "~25° at ¼-chord (illustrative)",
      Dihedral: "~5° (illustrative)",
      Structure: "Two-spar torsion box",
      Winglet: "Drag-reducing tip device",
    },
    explode: [0, 0.15, 1],
    explodeScale: 1.15,
  },
  engine_left: {
    id: "engine_left",
    name: "Left Engine",
    category: "Propulsion",
    description:
      "The port powerplant in its nacelle, hung on a pylon beneath and ahead of the wing. On an airliner this is a high-bypass turbofan: a large fan, a core, and a bypass duct.",
    fn: "Produces thrust, supplies bleed air for the air-conditioning and anti-ice systems, and drives the electrical and hydraulic generators.",
    location: "Under the left wing, on a forward-mounted pylon.",
    specs: {
      Type: "High-bypass turbofan",
      "Bypass ratio": "~9:1 (illustrative)",
      "Fan diameter": "~2.0 m (illustrative)",
      Thrust: "~120 kN class (illustrative)",
      Reverser: "Cascade-type",
    },
    explode: [0.2, -1, -0.4],
    explodeScale: 1.2,
  },
  engine_right: {
    id: "engine_right",
    name: "Right Engine",
    category: "Propulsion",
    description:
      "The starboard powerplant, identical to the left unit and mounted symmetrically. Nacelle, pylon, thrust reverser and accessory gearbox form one removable power unit.",
    fn: "Produces thrust and secondary power. With one engine inoperative the remaining engine must sustain certified climb performance.",
    location: "Under the right wing, on a forward-mounted pylon.",
    specs: {
      Type: "High-bypass turbofan",
      "Bypass ratio": "~9:1 (illustrative)",
      "Fan diameter": "~2.0 m (illustrative)",
      Thrust: "~120 kN class (illustrative)",
      Mount: "Fail-safe pylon links",
    },
    explode: [0.2, -1, 0.4],
    explodeScale: 1.2,
  },
  vstab: {
    id: "vstab",
    name: "Vertical Stabilizer",
    category: "Empennage",
    description:
      "The fin — the fixed vertical surface at the tail. It is a swept torsion box attached to the aft fuselage at reinforced frames, and carries the rudder on its trailing edge.",
    fn: "Provides directional (yaw) stability — it weather-vanes the aircraft back into the relative wind after a disturbance.",
    location: "Top of the aft fuselage, on the aircraft centreline.",
    specs: {
      Surface: "Fixed fin + rudder",
      Sweep: "~35° (illustrative)",
      Height: "~7 m above fuselage (illustrative)",
      Structure: "Multi-spar box, CFRP skins",
    },
    explode: [-0.25, 1, 0],
    explodeScale: 1.1,
  },
  hstab: {
    id: "hstab",
    name: "Horizontal Stabilizers",
    category: "Empennage",
    description:
      "The tailplane — a symmetric pair of small swept surfaces at the tail. On large aircraft the whole surface is trimmable, pivoting a few degrees for long-term pitch trim.",
    fn: "Provides longitudinal (pitch) stability and carries the elevators. It usually produces a small download that balances the nose-down moment of the wing.",
    location: "Both sides of the aft fuselage, below or on the fin.",
    specs: {
      Configuration: "Trimmable horizontal stabilizer",
      "Trim range": "~+3° / −12° (illustrative)",
      Span: "~12 m (illustrative)",
      Actuation: "Screwjack + elevators",
    },
    explode: [-0.65, 0.4, 0],
    explodeScale: 1.1,
  },
  rudder: {
    id: "rudder",
    name: "Rudder",
    category: "Control surface",
    description:
      "The hinged trailing-edge surface on the fin, driven by hydraulic actuators and usually limited at high speed by a rudder-travel limiter.",
    fn: "Controls yaw: used for crosswind landings, coordinating turns, and above all to counter the asymmetric thrust of an engine failure.",
    location: "Trailing edge of the vertical stabilizer.",
    specs: {
      Deflection: "±25° low speed (illustrative)",
      Actuation: "3× hydraulic actuators",
      "Critical case": "Engine-out V\u2098\u1D04",
      Limiter: "Speed-scheduled",
    },
    explode: [-1, 0.75, 0],
    explodeScale: 1.25,
  },
  elevators: {
    id: "elevators",
    name: "Elevators",
    category: "Control surface",
    description:
      "Hinged surfaces on the trailing edge of each horizontal stabilizer. They move together for pitch, and are driven by independent hydraulic systems for redundancy.",
    fn: "Control pitch attitude — rotation at takeoff, flare at landing, and all short-term pitch manoeuvring in flight.",
    location: "Trailing edge of both horizontal stabilizers.",
    specs: {
      Deflection: "+15° / −25° (illustrative)",
      Actuation: "Dual hydraulic, per side",
      Linkage: "Independent left/right",
      "Trim backup": "Stabilizer trim",
    },
    explode: [-1, 0.45, 0.25],
    explodeScale: 1.3,
  },
  flaps: {
    id: "flaps",
    name: "Flaps",
    category: "High-lift device",
    description:
      "Trailing-edge high-lift panels, typically Fowler flaps that translate aft on tracks before deflecting down — increasing both wing area and camber.",
    fn: "Raise the maximum lift coefficient so the aircraft can take off and land at much lower speeds, at the cost of extra drag.",
    location: "Inboard and outboard trailing edges of both wings.",
    specs: {
      Type: "Single/double-slotted Fowler",
      Settings: "0 / 1 / 2 / 5 / 15 / 30 / 40°",
      Drive: "Central PDU + torque tubes",
      "CL\u2098\u2090\u2093 gain": "~+0.9 (illustrative)",
    },
    explode: [-0.55, -0.2, 0.9],
    explodeScale: 1.2,
  },
  gear: {
    id: "gear",
    name: "Landing Gear",
    category: "Undercarriage",
    description:
      "Retractable tricycle undercarriage: a steerable nose leg and two main legs. Each leg is an oleo-pneumatic strut — oil forced through an orifice absorbs the landing energy.",
    fn: "Supports the aircraft on the ground, absorbs touchdown loads, provides braking and nosewheel steering, then retracts to cut drag.",
    location: "Nose gear under the forward fuselage; main gear in the wing-root / centre fuselage bays.",
    specs: {
      Arrangement: "Tricycle, retractable",
      Strut: "Oleo-pneumatic",
      "Main wheels": "4 (2 per leg)",
      Brakes: "Carbon multi-disc + anti-skid",
      "Tyre pressure": "~14 bar (illustrative)",
    },
    explode: [0, -1, 0],
    explodeScale: 1.35,
  },
};

/** Component ids in presentation order. */
export const COMPONENT_ORDER = [
  "nose",
  "cockpit",
  "fuselage",
  "wing_left",
  "wing_right",
  "engine_left",
  "engine_right",
  "flaps",
  "vstab",
  "rudder",
  "hstab",
  "elevators",
  "gear",
] as const;

/**
 * Per-aircraft text overrides. Only the fields that genuinely differ by class
 * are overridden; everything else falls through to the shared library entry.
 */
export const COMPONENT_OVERRIDES: Record<string, Record<string, Partial<ComponentSpec>>> = {
  fighter: {
    engine_left: {
      name: "Left Engine",
      description:
        "A low-bypass afterburning turbofan buried in the aft fuselage and fed by a side intake. The afterburner injects fuel into the hot exhaust for a large short-term thrust increase.",
      fn: "Provides high thrust-to-weight for supersonic acceleration and sustained manoeuvring; the nozzle area varies with power setting.",
      location: "Inside the aft fuselage, port side, fed by the port intake duct.",
      specs: {
        Type: "Afterburning low-bypass turbofan",
        "Bypass ratio": "~0.3:1 (illustrative)",
        "Dry thrust": "~65 kN (illustrative)",
        "Wet thrust": "~105 kN (illustrative)",
        Nozzle: "Variable convergent-divergent",
      },
    },
    engine_right: {
      description:
        "The starboard afterburning turbofan, mounted side-by-side with the port engine in the aft fuselage for twin-engine redundancy.",
      specs: {
        Type: "Afterburning low-bypass turbofan",
        "Bypass ratio": "~0.3:1 (illustrative)",
        "Dry thrust": "~65 kN (illustrative)",
        "Wet thrust": "~105 kN (illustrative)",
        Intake: "Fixed-geometry side intake",
      },
    },
    flaps: {
      name: "Flaps / Leading-edge Devices",
      description:
        "Combined trailing-edge flaperons and automatically scheduled leading-edge flaps. On a fighter these also deflect in cruise to optimise camber during manoeuvring.",
      fn: "Increase lift for takeoff and landing and improve turn performance by matching wing camber to angle of attack.",
      specs: {
        Type: "Flaperon + LE flap",
        Scheduling: "Automatic with AoA/Mach",
        Deflection: "±20° (illustrative)",
        Drive: "Hydraulic",
      },
    },
    gear: {
      specs: {
        Arrangement: "Tricycle, retractable",
        Strut: "Oleo-pneumatic, short-stroke",
        "Main wheels": "2 (1 per leg)",
        "Arrestor hook": "Fitted (naval variants)",
      },
    },
    fuselage: {
      description:
        "A blended fuselage housing the radar, cockpit, fuel, both engines and the weapons systems. It is not a simple pressurised tube — the structure is shaped for area-ruling and low drag.",
      specs: {
        Structure: "Frame + longeron, CFRP skins",
        Cockpit: "Single-seat pressurised capsule",
        "Design load": "+9 g / −3 g (illustrative)",
        "Fuel fraction": "~30% (illustrative)",
      },
    },
  },
  cargo: {
    fuselage: {
      description:
        "A wide, high-volume unpressurised-floor freight hold with a flat loading deck close to the ground, a full-section rear ramp and a roller/latch cargo-handling system.",
      fn: "Carries oversize and palletised freight, and allows straight-in loading of vehicles via the rear ramp.",
      specs: {
        "Hold cross-section": "~4 × 4 m (illustrative)",
        Floor: "Roller + latch system",
        "Rear ramp": "Full-section, drive-on",
        "Max payload": "~70 t class (illustrative)",
      },
    },
    gear: {
      description:
        "A high-flotation multi-wheel bogie undercarriage with a kneeling capability, designed for semi-prepared strips and for lowering the cargo deck to truck-bed height.",
      specs: {
        Arrangement: "Multi-wheel bogies",
        "Main wheels": "12+ (illustrative)",
        Kneeling: "Yes — lowers cargo floor",
        Surface: "Semi-prepared capable",
      },
    },
    engine_left: {
      specs: {
        Type: "High-bypass turbofan",
        Count: "2 per side on this model",
        Thrust: "~180 kN class (illustrative)",
        Reverser: "Cascade, ground-only",
      },
    },
  },
  jet: {
    fuselage: {
      description:
        "A narrow pressurised cabin tube optimised for a small number of passengers at high cruise altitude, with a large unobstructed baggage compartment aft.",
      specs: {
        Structure: "Semi-monocoque",
        Cabin: "6–9 passengers (illustrative)",
        "Cabin altitude": "~1,800 m at FL450 (illustrative)",
        "Baggage hold": "Aft, externally accessed",
      },
    },
    engine_left: {
      description:
        "A medium-bypass turbofan mounted on a pylon on the side of the aft fuselage rather than under the wing — this keeps the wing clean and the cabin quiet.",
      location: "Port side of the aft fuselage, on a stub pylon.",
      specs: {
        Type: "Medium-bypass turbofan",
        Mount: "Aft-fuselage pylon",
        Thrust: "~15 kN class (illustrative)",
        "Fan diameter": "~0.7 m (illustrative)",
      },
    },
    engine_right: {
      location: "Starboard side of the aft fuselage, on a stub pylon.",
      specs: {
        Type: "Medium-bypass turbofan",
        Mount: "Aft-fuselage pylon",
        Thrust: "~15 kN class (illustrative)",
        "Fan diameter": "~0.7 m (illustrative)",
      },
    },
    hstab: {
      name: "Horizontal Stabilizers",
      description:
        "A T-tail: the tailplane sits on top of the fin, clear of the wing wake and the aft-fuselage engine exhaust.",
      location: "Mounted on top of the vertical stabilizer.",
      specs: {
        Configuration: "T-tail, trimmable",
        Reason: "Clear of wake and jet efflux",
        Span: "~5 m (illustrative)",
        Caution: "Deep-stall boundary",
      },
    },
  },
};

/** Resolve the component spec for an aircraft, applying class overrides. */
export function resolveComponent(aircraftKind: string, componentId: string): ComponentSpec {
  const base = COMPONENT_LIBRARY[componentId];
  const override = COMPONENT_OVERRIDES[aircraftKind]?.[componentId];
  if (!override) return base;
  return {
    ...base,
    ...override,
    specs: { ...base.specs, ...(override.specs ?? {}) },
  };
}
