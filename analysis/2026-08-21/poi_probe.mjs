// What guest-useful POIs are actually inside the z15 basemap tile a hotel sits
// in? Decides whether "nearby places" needs a paid third-party source at all.
// Answer: no. See src/lib/nearby.ts.
//
// This script decodes tiles DIRECTLY, which the app does not need to do -- the
// app reads the same features off the live map with querySourceFeatures, since
// MapLibre has already parsed them. So the two decoder packages are not project
// dependencies. To re-run:
//
//     npm i --no-save @mapbox/vector-tile pbf
//     node analysis/2026-08-21/poi_probe.mjs
import { PMTiles, FetchSource } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

const HOTELS = [
  ["Austin downtown", 30.2672, -97.7431],
  ["New Orleans FQ", 29.9584, -90.0644],
  ["Asheville", 35.5951, -82.5515],
];

const tileXY = (lat, lng, z) => {
  const n = 2 ** z;
  return [
    Math.floor(((lng + 180) / 360) * n),
    Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n),
  ];
};

// Web-mercator tile-local (0..4096) back to lat/lng.
function unproject(x, y, z, px, py, extent) {
  const n = 2 ** z;
  const lng = ((x + px / extent) / n) * 360 - 180;
  const yy = Math.PI - 2 * Math.PI * ((y + py / extent) / n);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(yy) - Math.exp(-yy)));
  return [lat, lng];
}

const haversine = (a, b, c, d) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function findBuild() {
  for (let i = 0; i < 10; i++) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    const u = `https://build.protomaps.com/${d.toISOString().slice(0, 10).replace(/-/g, "")}.pmtiles`;
    const r = await fetch(u, { headers: { Range: "bytes=0-0" } });
    if (r.ok || r.status === 206) return u;
  }
  throw new Error("no build");
}

const url = await findBuild();
const p = new PMTiles(new FetchSource(url));
console.log("build:", url, "\n");

const allKinds = new Map();
for (const [label, lat, lng] of HOTELS) {
  const [x, y] = tileXY(lat, lng, 15);
  const res = await p.getZxy(15, x, y);
  if (!res) { console.log(label, "no tile"); continue; }
  const layer = new VectorTile(new PbfReader(res.data)).layers["pois"];
  const rows = [];
  for (let i = 0; i < (layer?.length ?? 0); i++) {
    const f = layer.feature(i);
    const name = f.properties.name;
    if (!name) continue;
    const g = f.loadGeometry()[0][0];
    const [plat, plng] = unproject(x, y, 15, g.x, g.y, f.extent);
    const m = haversine(lat, lng, plat, plng);
    if (m > 1200) continue;
    rows.push({ name, kind: f.properties.kind, m: Math.round(m) });
    allKinds.set(f.properties.kind, (allKinds.get(f.properties.kind) || 0) + 1);
  }
  rows.sort((a, b) => a.m - b.m);
  console.log(`${label}: ${rows.length} named POIs within 1.2 km`);
  for (const r of rows.slice(0, 12)) console.log(`   ${String(r.m).padStart(5)}m  ${r.kind.padEnd(16)} ${r.name}`);
  console.log();
}

console.log("kind vocabulary across all three, by frequency:");
console.log([...allKinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  "));
