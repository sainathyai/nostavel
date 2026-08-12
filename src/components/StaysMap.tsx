"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  Popup,
  NavigationControl,
  LngLatBounds,
  addProtocol,
  setWorkerUrl,
} from "maplibre-gl";
import type { StyleSpecification, MapMovementEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { HotelStay } from "@/lib/liteapi";
import { fallbackArt } from "@/lib/fallback-art";

// Register the pmtiles:// protocol once per page load (addProtocol is meant to
// be called a single time; module scope guarantees that regardless of how many
// times this component mounts/unmounts).
let protocolRegistered = false;
function ensureProtocol() {
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
// NOTE: this is the public daily build (rolls off after a few days, no SLA);
// fine for Phase 1, but before real production traffic we should copy a
// snapshot to our own storage (see docs/planner-research.md's own guidance on
// hosted-now/self-host-later for the same reason it gives for Valhalla).
const PMTILES_URL = "pmtiles://https://build.protomaps.com/20260810.pmtiles";

function buildStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${dark ? "dark" : "light"}`,
    sources: {
      protomaps: {
        type: "vector",
        url: PMTILES_URL,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers("protomaps", namedFlavor(dark ? "dark" : "light"), { lang: "en" }),
  };
}

function currentThemeIsDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "dark" || (attr !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

// Great-circle distance in meters — used to turn the current viewport into a
// center + radius for the "search this area" area query.
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Same rate-parity gate as StayCard: members see the real (lower) price;
// everyone else sees the SSP-floor public price, never the member number.
function priceFor(stay: HotelStay, isMember: boolean, inclFees: boolean): number {
  if (isMember) {
    return inclFees ? stay.you + stay.feeAtHotel : stay.you;
  }
  const publicBase = stay.them ?? stay.you;
  return inclFees ? publicBase + stay.feeAtHotel : publicBase;
}

function buildPopupContent(
  stay: HotelStay,
  isMember: boolean,
  inclFees: boolean,
  onView: () => void,
): HTMLDivElement {
  const price = priceFor(stay, isMember, inclFees);

  const root = document.createElement("div");
  root.className = "stays-map-popup";

  const img = document.createElement("div");
  img.className = "stays-map-popup-img";
  img.style.background = stay.photo
    ? `center / cover no-repeat url("${stay.photo}")`
    : fallbackArt(stay.id);
  root.appendChild(img);

  const body = document.createElement("div");
  body.className = "stays-map-popup-body";

  const name = document.createElement("div");
  name.className = "stays-map-popup-name";
  name.textContent = stay.name;
  body.appendChild(name);

  if (stay.rating != null) {
    const rating = document.createElement("div");
    rating.className = "stays-map-popup-rating";
    rating.textContent =
      stay.reviewCount > 0
        ? `${stay.rating.toFixed(1)} · ${stay.reviewCount.toLocaleString()} reviews`
        : stay.rating.toFixed(1);
    body.appendChild(rating);
  }

  const priceRow = document.createElement("div");
  priceRow.className = "stays-map-popup-price";
  priceRow.textContent = `$${price}`;
  if (!isMember) {
    const unit = document.createElement("span");
    unit.textContent = "public";
    priceRow.appendChild(unit);
  }
  body.appendChild(priceRow);

  const viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "stays-map-popup-view";
  viewBtn.textContent = "View";
  viewBtn.onclick = onView;
  body.appendChild(viewBtn);

  root.appendChild(body);
  return root;
}

export default function StaysMap({
  stays,
  onOpen,
  isMember,
  inclFees,
  checkin,
  nights,
}: {
  stays: HotelStay[];
  onOpen: (s: HotelStay, i: "view" | "book") => void;
  isMember: boolean;
  inclFees: boolean;
  checkin: string;
  nights: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const popupRef = useRef<Popup | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSeq = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Imperative marker code (event handlers registered once) needs the latest
  // pricing/search inputs without forcing the map to remount on every change.
  const latest = useRef({ isMember, inclFees, onOpen, checkin, nights });
  latest.current = { isMember, inclFees, onOpen, checkin, nights };

  // Draws the given stays as pins; `fit` controls whether the camera moves to
  // frame them. Prop-driven placement fits; a "search this area" refresh
  // (below) never does — the whole point is to leave the user's own framing
  // alone and just refresh what's pinned inside it.
  const drawMarkers = useCallback((list: HotelStay[], fit: boolean) => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current.clear();
    popupRef.current?.remove();
    popupRef.current = null;

    const geo = list.filter(
      (s): s is HotelStay & { lat: number; lng: number } => s.lat != null && s.lng != null,
    );
    if (!geo.length) return;

    const bounds = new LngLatBounds();
    for (const s of geo) {
      const el = document.createElement("button");
      el.type = "button";
      el.setAttribute("aria-label", `${s.name} — open details`);
      el.className = "stays-map-pin";
      el.textContent = `$${priceFor(s, latest.current.isMember, latest.current.inclFees)}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        popupRef.current?.remove();
        const content = buildPopupContent(s, latest.current.isMember, latest.current.inclFees, () => {
          popupRef.current?.remove();
          popupRef.current = null;
          latest.current.onOpen(s, "view");
        });
        const popup = new Popup({
          closeButton: true,
          closeOnClick: true,
          offset: 20,
          maxWidth: "240px",
          className: "stays-map-popup-wrap",
        })
          .setLngLat([s.lng, s.lat])
          .setDOMContent(content)
          .addTo(map);
        popupRef.current = popup;
      };

      const marker = new Marker({ element: el, anchor: "bottom" }).setLngLat([s.lng, s.lat]).addTo(map);
      markersRef.current.set(s.id, marker);
      bounds.extend([s.lng, s.lat]);
    }
    if (fit) map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 400 });
  }, []);

  // Mount the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    ensureProtocol();
    const map = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(currentThemeIsDark()),
      center: [-98, 39],
      zoom: 3,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-skin the basemap when the site theme toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const observer = new MutationObserver(() => map.setStyle(buildStyle(currentThemeIsDark())));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Place pins from the search result whenever it changes (new search, new
  // filter/sort) — this is the one case that reframes the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const run = () => drawMarkers(stays, true);
    if (map.isStyleLoaded()) run();
    else map.once("load", run);
  }, [stays, drawMarkers]);

  // "Search this area": panning or zooming the map refetches hotels for the
  // new viewport, like every major booking site's map view. Only genuine user
  // gestures trigger it — `originalEvent` is unset on our own fitBounds/setStyle
  // calls, so those don't cause the map to refetch itself.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMoveEnd = (e: MapMovementEvent) => {
      if (!e.originalEvent) return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        const b = map.getBounds();
        const center = b.getCenter();
        const ne = b.getNorthEast();
        const radius = haversineMeters(center.lat, center.lng, ne.lat, ne.lng);
        if (radius > 30000) return; // too zoomed out for a meaningful "this area" search

        const seq = ++refreshSeq.current;
        setRefreshing(true);
        try {
          const params = new URLSearchParams({
            lat: String(center.lat),
            lng: String(center.lng),
            radius: String(Math.round(radius)),
            checkin: latest.current.checkin,
            nights: String(latest.current.nights),
          });
          const res = await fetch(`/api/stays-in-area?${params}`);
          const data = await res.json();
          if (seq !== refreshSeq.current) return; // superseded by a later move
          if (Array.isArray(data.items)) drawMarkers(data.items, false);
        } catch {
          // network hiccup — leave the existing pins as they are
        } finally {
          if (seq === refreshSeq.current) setRefreshing(false);
        }
      }, 450);
    };

    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [drawMarkers]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {refreshing && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[12px] font-medium text-white backdrop-blur-sm">
          Searching this area…
        </div>
      )}
    </div>
  );
}
