"use client";

// Shared basemap plumbing for every map in the app. Extracted from StaysMap
// when the hotel page gained its own map: the pmtiles protocol may be
// registered only once per page load, and two components each doing their own
// setup is exactly how that invariant gets broken.

import { addProtocol, setWorkerUrl } from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";

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
    layers: layers("protomaps", namedFlavor(dark ? "dark" : "light"), { lang: "en" }),
  };
}

export function currentThemeIsDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  return (
    attr === "dark" ||
    (attr !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
}
