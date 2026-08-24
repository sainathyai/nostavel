"use client";

// A single hotel on a map. Deliberately NOT StaysMap: that one carries price
// pins, popups, an "onOpen" contract and a camera that re-queries the API when
// the viewport moves. None of that applies when there is one property and the
// only question is "where is this, and what is around it".

import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, Marker, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildStyle, currentThemeIsDark, ensureProtocol, resolveBasemapUrl } from "./map-style";
import { groupNearby, type NearbyGroup, type RawFeature } from "@/lib/nearby";

export default function HotelMap({
  lat,
  lng,
  name,
  onNearby,
}: {
  lat: number;
  lng: number;
  name: string;
  /**
   * Called once with what surrounds the hotel, read out of the tiles this map
   * has already downloaded. The map owns the data, so the map hands it over
   * rather than a second component fetching the same bytes again.
   */
  onNearby?: (groups: NearbyGroup[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    // The basemap build has to be resolved before the style can be built —
    // its URL is a date that expires. See map-style.ts.
    (async () => {
      const basemap = await resolveBasemapUrl();
      if (cancelled || !containerRef.current) return;
      if (!basemap) {
        // Say so rather than leaving a blank rectangle that reads as a bug.
        setFailed(true);
        return;
      }
      ensureProtocol();

      const map = new MapLibreMap({
        container: containerRef.current,
        style: buildStyle(currentThemeIsDark(), basemap),
        center: [lng, lat],
        // Close enough to read the surrounding blocks — which is the actual
        // question a guest has about an address they don't know.
        zoom: 15,
        attributionControl: { compact: true },
      });
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");

      const el = document.createElement("div");
      el.className = "hotel-map-pin";
      el.setAttribute("aria-label", name);
      new Marker({ element: el }).setLngLat([lng, lat]).addTo(map);

      // Follow the site's theme toggle: the style is fixed at construction, so
      // a theme flip has to swap it rather than re-render.
      const obs = new MutationObserver(() => {
        map.setStyle(buildStyle(currentThemeIsDark(), basemap));
      });
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      map.once("remove", () => obs.disconnect());

      // "idle" is the first moment every tile for the viewport is loaded AND
      // parsed; querying before it returns a partial neighbourhood. Once only:
      // panning would keep firing it and the answer is about the hotel, not
      // about wherever the guest has dragged to.
      map.once("idle", () => {
        if (cancelled || !onNearby) return;
        try {
          const feats = map.querySourceFeatures("protomaps", { sourceLayer: "pois" });
          const raw: RawFeature[] = [];
          for (const f of feats) {
            // Every POI is a Point; anything else in this layer is not a place
            // a guest can walk to.
            if (f.geometry?.type !== "Point") continue;
            const [flng, flat] = f.geometry.coordinates as [number, number];
            raw.push({ name: f.properties?.name, kind: f.properties?.kind, lat: flat, lng: flng });
          }
          onNearby(groupNearby(raw, lat, lng));
        } catch {
          // A missing pois layer (an older build, a style change) means no
          // nearby section, not a broken page.
        }
      });

      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [lat, lng, name, onNearby]);

  if (failed) {
    return (
      <div className="grid h-full w-full place-items-center px-6 text-center text-[13px] text-soft">
        The map is unavailable right now. The address above is still accurate.
      </div>
    );
  }
  return <div ref={containerRef} className="h-full w-full" />;
}
