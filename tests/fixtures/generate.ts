/**
 * Serialises the synthetic hand poses to JSON so the browser-based e2e suite
 * can inject the exact same landmark data the Node unit tests assert against.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POSES } from "./hands";

const out: Record<string, unknown> = {};
for (const [name, fn] of Object.entries(POSES)) out[name] = fn();

const path = fileURLToPath(new URL("./poses.json", import.meta.url));
writeFileSync(path, JSON.stringify(out, null, 0));
console.log(`wrote ${Object.keys(out).length} poses → ${path}`);
