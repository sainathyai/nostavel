"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  Popup,
  NavigationControl,
  LngLatBounds,
} from "maplibre-gl";
import type { MapMovementEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildStyle, currentThemeIsDark, ensureProtocol, resolveBasemapUrl } from "./map-style";
import type { HotelStay } from "@/lib/liteapi";
import { fallbackArt } from "@/lib/fallback-art";

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
  const [basemapFailed, setBasemapFailed] = useState(false);
  // Flipped when the async mount finishes, so the marker effect re-runs against
  // a map that did not exist on its first pass.
  const [mapReady, setMapReady] = useState(false);
  // The guest has moved the camera since the pins were last filled, so what is
  // on screen no longer matches what was searched. This is what offers the
  // button; it is never set by our own fitBounds (see the moveend handler).
  const [dirty, setDirty] = useState(false);
  // One line of feedback after a search, e.g. "No stays in this area". Cleared
  // on the next move, because it describes a search of the previous viewport.
  const [note, setNote] = useState<string | null>(null);
  const refreshSeq = useRef(0);

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

  // Mount the map once. Async because the basemap build URL is a date that
  // expires and has to be resolved first — see map-style.ts.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    (async () => {
      const basemap = await resolveBasemapUrl();
      if (cancelled || !containerRef.current) return;
      if (!basemap) {
        setBasemapFailed(true);
        return;
      }
      ensureProtocol();
      const map = new MapLibreMap({
        container: containerRef.current,
        style: buildStyle(currentThemeIsDark(), basemap),
        center: [-98, 39],
        zoom: 3,
        attributionControl: { compact: true },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");

      // Re-skin when the site theme toggles. Lives here rather than in its own
      // effect now that the map is created asynchronously — a separate effect
      // would run before the map exists and silently never attach.
      const observer = new MutationObserver(() =>
        map.setStyle(buildStyle(currentThemeIsDark(), basemap)),
      );
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      map.once("remove", () => observer.disconnect());

      mapRef.current = map;
      // The pin-drawing effect below may have already run and found no map.
      setMapReady(true);
    })();

    return () => {
      cancelled = true;
      popupRef.current?.remove();
      popupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Place pins from the search result whenever it changes (new search, new
  // filter/sort) — this is the one case that reframes the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const run = () => drawMarkers(stays, true);
    if (map.isStyleLoaded()) run();
    else map.once("load", run);
    // A new result set replaces whatever an area search had put on the map, so
    // any pending "search this area" offer and its note no longer apply.
    setDirty(false);
    setNote(null);
    // `mapReady` is the async-mount signal: without it this effect runs once
    // against a null map and never again, so the pins never appear.
  }, [stays, drawMarkers, mapReady]);

  // Arm the button when the guest moves the camera themselves. `originalEvent`
  // is unset on our own fitBounds and on setStyle re-renders, so the map never
  // arms itself and a theme toggle does not look like a pan.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onMoveEnd = (e: MapMovementEvent) => {
      if (!e.originalEvent) return;
      setDirty(true);
      setNote(null);
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapReady]);

  // "Search this area" — explicit, because it is a real supplier fan-out
  // costing about five seconds. This used to run automatically on a debounced
  // moveend, which meant a guest reading the map paid for a search on every
  // pan, and it bailed out silently above a 30 km radius, so zooming out looked
  // exactly like a city with no hotels in it.
  const searchThisArea = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const b = map.getBounds();
    const center = b.getCenter();
    const ne = b.getNorthEast();
    const radius = haversineMeters(center.lat, center.lng, ne.lat, ne.lng);

    const seq = ++refreshSeq.current;
    setRefreshing(true);
    setNote(null);
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
      if (seq !== refreshSeq.current) return; // superseded by a later search

      if (!Array.isArray(data.items)) {
        setNote("Could not search this area. Try again.");
        return;
      }
      // `fit: false` on purpose — the guest chose this framing by moving here,
      // and refitting the camera to the results would move it out from under
      // them and re-arm the button.
      drawMarkers(data.items, false);
      setDirty(false);

      const n = data.items.length;
      if (n === 0) {
        setNote("No stays found in this area.");
      } else if (data.clamped) {
        // The viewport was wider than AREA_MAX_RADIUS_M, so what came back is
        // the middle of it, not all of it. Saying so beats a pin pattern that
        // silently ignores the edges of the screen.
        setNote(`${n} ${n === 1 ? "stay" : "stays"} near the centre of this view`);
      } else {
        setNote(`${n} ${n === 1 ? "stay" : "stays"} in this area`);
      }
    } catch {
      if (seq === refreshSeq.current) setNote("Could not search this area. Try again.");
    } finally {
      if (seq === refreshSeq.current) setRefreshing(false);
    }
  }, [drawMarkers]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {/* A blank rectangle reads as a broken page. Say what happened and point
          at the list, which does not depend on the basemap. */}
      {basemapFailed && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-soft">
          The map is unavailable right now — the list view has the same stays.
        </div>
      )}
      {/* One slot, three states: the offer, the progress, the outcome. Keeping
          them in the same place means the button does not jump away from the
          cursor the moment it is clicked. */}
      {!basemapFailed && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2">
          {refreshing ? (
            <div className="pointer-events-none rounded-full bg-black/60 px-3.5 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm">
              Searching this area…
            </div>
          ) : dirty ? (
            <button
              type="button"
              onClick={searchThisArea}
              className="smooth rounded-full border border-line bg-surface px-4 py-1.5 text-[13px] font-medium text-ink shadow-lg hover:border-brass focus-visible:border-brass focus-visible:outline-none"
            >
              Search this area
            </button>
          ) : note ? (
            <div className="pointer-events-none rounded-full bg-black/55 px-3.5 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm">
              {note}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
