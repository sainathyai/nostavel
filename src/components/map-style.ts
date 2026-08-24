"use client";

// Shared basemap plumbing for every map in the app. Extracted from StaysMap
// when the hotel page gained its own map: the pmtiles protocol may be
// registered only once per page load, and two components each doing their own
// setup is exactly how that invariant gets broken.

import { addProtocol, setWorkerUrl } from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, type Flavor } from "@protomaps/basemaps";

let protocolRegistered = false;

export function ensureProtocol() {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  // MapLibre v6 loads its render worker as an ES module Worker resolved via
  // `new URL(..., import.meta.url)`; Turbopack's dev worker-chunk serving
  // doesn't resolve that correctly (fails with a "non-JavaScript MIME type"
  // browser error — confirmed live). Point it at the prebuilt worker file
  // instead, served as a plain static asset so no bundler ever touches it.
  // public/maplibre-gl-worker.mjs is copied from
  // node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs — must be re-copied
  // whenever the maplibre-gl version bumps. That worker file itself
  // `import`s a sibling module, "./maplibre-gl-shared.mjs" (resolved against
  // the site root once served statically) — public/maplibre-gl-shared.mjs is
  // a copy of node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs and must
  // be re-copied alongside it. Missing this causes the worker module to
  // 404-fail silently inside its own realm: no console error on the main
  // thread, style loads, first frame paints (background only), but vector
  // tiles never get parsed so the map stays visually blank.
  setWorkerUrl("/maplibre-gl-worker.mjs");
  protocolRegistered = true;
}

// Protomaps' public daily planet build. PMTiles is a single cloud-optimized
// file read via HTTP range requests, so the browser only fetches the byte
// ranges for tiles actually on screen — no self-hosting needed to prototype.
//
// THE URL CANNOT BE PINNED. Measured 2026-08-20: builds are deleted after about
// five days. 20260815 through 20260819 answered 206; 20260813 and 20260810 were
// both 404. A hardcoded date therefore works for under a week and then every
// map in the app goes blank with nothing but a "Bad response code: 404" in the
// console — which is exactly what happened to the pinned 20260810.
//
// So the date is resolved at runtime: walk back from today until a build
// answers. One tiny range request (a single byte) per candidate, memoized for
// the page load, shared by every map.
//
// This is a prototype-grade dependency and the lookback only papers over it.
// Before real traffic we should copy one snapshot to our own storage — the same
// hosted-now/self-host-later call docs/planner-research.md makes for Valhalla.
const BUILD_HOST = "https://build.protomaps.com";
const LOOKBACK_DAYS = 10;

function buildDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

let basemapPromise: Promise<string | null> | null = null;

async function probeBasemap(): Promise<string | null> {
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const url = `${BUILD_HOST}/${buildDate(i)}.pmtiles`;
    try {
      // One byte is enough to prove the object exists, and a range request
      // avoids pulling any real payload. A live build answers 206.
      const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
      if (res.ok || res.status === 206) return `pmtiles://${url}`;
    } catch {
      // Network hiccup on one candidate is not fatal — try the next date.
    }
  }
  return null;
}

/**
 * The pmtiles:// URL for a basemap that actually exists right now, or null when
 * no build in the lookback window answers. Memoized per page load: several maps
 * may mount, and they must not each re-probe.
 */
export function resolveBasemapUrl(): Promise<string | null> {
  if (!basemapPromise) basemapPromise = probeBasemap();
  return basemapPromise;
}

// Hand-tuned Protomaps flavors on the "dusk / lamplight" palette (see the
// tokens in globals.css). Every one of the 74 flavor colors is derived from
// the same nine brand tokens rather than left at Protomaps' stock blue-water,
// grey-road defaults, so the map reads as part of the same product as the
// page around it instead of a generic OSM embed dropped in.
const LANTERN_LIGHT: Flavor = {
  background: "#ede4d6",
  earth: "#f1eadd",
  park_a: "#d9e3d3",
  park_b: "#a9c2ab",
  hospital: "#f2e3e1",
  industrial: "#e7ddd0",
  school: "#f1e6d8",
  wood_a: "#cfdece",
  wood_b: "#8fb295",
  pedestrian: "#eee4d3",
  scrub_a: "#dae3d2",
  scrub_b: "#a8c9a0",
  glacier: "#f3efe6",
  sand: "#ecdfc4",
  beach: "#f0e4c2",
  aerodrome: "#e6ddd8",
  runway: "#f0eae3",
  water: "#a7c4c6",
  zoo: "#dde3d5",
  military: "#e6ddd3",
  tunnel_other_casing: "#e2d8c7",
  tunnel_minor_casing: "#e2d8c7",
  tunnel_link_casing: "#e2d8c7",
  tunnel_major_casing: "#e2d8c7",
  tunnel_highway_casing: "#e2d8c7",
  tunnel_other: "#dcd1bf",
  tunnel_minor: "#dcd1bf",
  tunnel_link: "#dcd1bf",
  tunnel_major: "#dcd1bf",
  tunnel_highway: "#dcd1bf",
  pier: "#e6ddd0",
  buildings: "#e6d9c4",
  minor_service_casing: "#e2d8c7",
  minor_casing: "#e2d8c7",
  link_casing: "#e2d8c7",
  major_casing_late: "#e2d8c7",
  highway_casing_late: "#e2d8c7",
  other: "#f5efe6",
  minor_service: "#f5efe6",
  minor_a: "#f5efe6",
  minor_b: "#fbf8f2",
  link: "#fbf8f2",
  major_casing_early: "#e2d8c7",
  major: "#fdfbf7",
  highway_casing_early: "#dcc8a1",
  highway: "#f3e4c8",
  railway: "#a08a6a",
  boundaries: "#c9bca3",
  bridges_other_casing: "#e2d8c7",
  bridges_minor_casing: "#e2d8c7",
  bridges_link_casing: "#e2d8c7",
  bridges_major_casing: "#e2d8c7",
  bridges_highway_casing: "#dcc8a1",
  bridges_other: "#f5efe6",
  bridges_minor: "#fbf8f2",
  bridges_link: "#fbf8f2",
  bridges_major: "#fdfbf7",
  bridges_highway: "#f3e4c8",
  roads_label_minor: "#6a6172",
  roads_label_minor_halo: "#f5efe6",
  roads_label_major: "#54495f",
  roads_label_major_halo: "#f5efe6",
  ocean_label: "#5f8a8d",
  subplace_label: "#8a7f6a",
  subplace_label_halo: "#f5efe6",
  city_label: "#211b2b",
  city_label_halo: "#f5efe6",
  state_label: "#a79a83",
  state_label_halo: "#f5efe6",
  country_label: "#8f8270",
  address_label: "#6a6172",
  address_label_halo: "#fbf8f2",
  pois: {
    blue: "#3f7ea6",
    green: "#5b7a60",
    lapis: "#5a5a9e",
    pink: "#b9577f",
    red: "#b2543f",
    slategray: "#6a6172",
    tangerine: "#b9772b",
    turquoise: "#4a9088",
  },
  landcover: {
    grassland: "rgba(216, 227, 213, 1)",
    barren: "rgba(236, 223, 196, 1)",
    urban_area: "rgba(230, 223, 210, 1)",
    farmland: "rgba(221, 229, 214, 1)",
    glacier: "rgba(242, 238, 229, 1)",
    scrub: "rgba(223, 229, 210, 1)",
    forest: "rgba(207, 222, 207, 1)",
  },
};

const LANTERN_DARK: Flavor = {
  background: "#17131f",
  earth: "#1c1725",
  park_a: "#26332a",
  park_b: "#3c5645",
  hospital: "#2a2130",
  industrial: "#241f2f",
  school: "#241d2c",
  wood_a: "#233024",
  wood_b: "#3c5645",
  pedestrian: "#241d2c",
  scrub_a: "#26302a",
  scrub_b: "#3a5240",
  glacier: "#2a2635",
  sand: "#2c2620",
  beach: "#2e2822",
  aerodrome: "#241f2a",
  runway: "#2a2530",
  water: "#16262b",
  zoo: "#212c26",
  military: "#241f27",
  tunnel_other_casing: "#17131f",
  tunnel_minor_casing: "#17131f",
  tunnel_link_casing: "#17131f",
  tunnel_major_casing: "#17131f",
  tunnel_highway_casing: "#17131f",
  tunnel_other: "#221b2d",
  tunnel_minor: "#221b2d",
  tunnel_link: "#221b2d",
  tunnel_major: "#221b2d",
  tunnel_highway: "#221b2d",
  pier: "#2a2334",
  buildings: "#241d2f",
  minor_service_casing: "#17131f",
  minor_casing: "#17131f",
  link_casing: "#17131f",
  major_casing_late: "#17131f",
  highway_casing_late: "#17131f",
  other: "#2a2335",
  minor_service: "#2a2335",
  minor_a: "#2a2335",
  minor_b: "#332a40",
  link: "#332a40",
  major_casing_early: "#17131f",
  major: "#3d3249",
  highway_casing_early: "#382c1f",
  highway: "#4a3c30",
  railway: "#8a7256",
  boundaries: "#4a3f5c",
  bridges_other_casing: "#17131f",
  bridges_minor_casing: "#17131f",
  bridges_link_casing: "#17131f",
  bridges_major_casing: "#17131f",
  bridges_highway_casing: "#382c1f",
  bridges_other: "#2a2335",
  bridges_minor: "#332a40",
  bridges_link: "#332a40",
  bridges_major: "#3d3249",
  bridges_highway: "#4a3c30",
  roads_label_minor: "#a79dae",
  roads_label_minor_halo: "#17131f",
  roads_label_major: "#c9bfd6",
  roads_label_major_halo: "#17131f",
  ocean_label: "#8fb295",
  subplace_label: "#a79dae",
  subplace_label_halo: "#17131f",
  city_label: "#ede6da",
  city_label_halo: "#17131f",
  state_label: "#6d6379",
  state_label_halo: "#17131f",
  country_label: "#5a5164",
  address_label: "#a79dae",
  address_label_halo: "#1e1826",
  pois: {
    blue: "#6fb8d9",
    green: "#8fb295",
    lapis: "#8f8fd0",
    pink: "#d98cae",
    red: "#d98a6f",
    slategray: "#a79dae",
    tangerine: "#d9a455",
    turquoise: "#7fc9c0",
  },
  landcover: {
    grassland: "rgba(38, 51, 42, 1)",
    barren: "rgba(44, 38, 32, 1)",
    urban_area: "rgba(36, 31, 42, 1)",
    farmland: "rgba(34, 43, 36, 1)",
    glacier: "rgba(42, 38, 53, 1)",
    scrub: "rgba(38, 48, 42, 1)",
    forest: "rgba(30, 44, 34, 1)",
  },
};

export function buildStyle(dark: boolean, pmtilesUrl: string): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${dark ? "dark" : "light"}`,
    sources: {
      protomaps: {
        type: "vector",
        url: pmtilesUrl,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    // Every layer keeps the same id between the light and dark flavors, so
    // MapLibre's setStyle diffs paint properties in place on a theme toggle
    // rather than tearing the map down. This `transition` is what turns that
    // diff into a cross-fade instead of an instant color snap.
    transition: { duration: 300, delay: 0 },
    layers: layers("protomaps", dark ? LANTERN_DARK : LANTERN_LIGHT, { lang: "en" }),
  };
}

export function currentThemeIsDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  return (
    attr === "dark" ||
    (attr !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
}
