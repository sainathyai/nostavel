#!/usr/bin/env node
// Files copied out of node_modules into public/ must match the installed
// package. MapLibre loads its worker from public/ (src/components/map-style.ts),
// and a worker from a different version than the bundled library breaks the map
// with no build or type error. This happened on 2026-09-17: Dependabot bumped
// maplibre-gl 6.3.0 -> 6.4.1 and the copies stayed at 6.3.0.
//
//   node scripts/check-vendored.mjs         fail if any copy is stale (verify, CI)
//   node scripts/check-vendored.mjs --fix   re-copy from node_modules
import { copyFileSync, readFileSync } from "node:fs";

const VENDORED = [
  ["node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", "public/maplibre-gl-worker.mjs"],
  ["node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs", "public/maplibre-gl-shared.mjs"],
];

const fix = process.argv.includes("--fix");
const stale = VENDORED.filter(([from, to]) => !readFileSync(from).equals(readFileSync(to)));
if (fix) for (const [from, to] of stale) copyFileSync(from, to);

if (stale.length && !fix) {
  console.error("check-vendored: stale copies in public/ (the installed package was upgraded)");
  for (const [from, to] of stale) console.error(`  - ${to} differs from ${from}`);
  console.error("Run `npm run vendored:fix` and commit the result.");
  process.exit(1);
}
console.log(`check-vendored: ${fix ? `re-copied ${stale.length} file(s)` : `${VENDORED.length} vendored files match node_modules`}`);
