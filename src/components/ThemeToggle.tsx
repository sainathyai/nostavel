"use client";

// The light/dark control, extracted from Experience so every page can carry it.
// It lived only on the home page, which meant the theme silently reverted to
// the system default the moment a guest opened a hotel.
//
// The theme is not React state: it lives on the document element and in
// localStorage, i.e. outside React entirely. Reading it with
// useSyncExternalStore rather than useState+useEffect is what keeps hydration
// honest — the server renders the server snapshot, and React re-reads the real
// value on the client without a cascading mount-time setState.

import { useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "nostavel:theme";
const CHANGE_EVENT = "nostavel:themechange";

type Theme = "light" | "dark";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  // Both matter: the OS preference can change under us, and our own toggle
  // announces itself so several toggles on one page stay in agreement.
  mq.addEventListener("change", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    mq.removeEventListener("change", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function getSnapshot(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// There is no document on the server, and guessing would only produce a
// hydration mismatch. "light" matches the CSS default.
function getServerSnapshot(): Theme {
  return "light";
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Restore a previous choice. Client-side navigation keeps `data-theme` on the
  // document, but a direct load of /stay/... starts a fresh document and would
  // otherwise forget what the visitor picked. Writing to the DOM is exactly
  // what an effect is for — note it sets no React state.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved !== "light" && saved !== "dark") return;
      if (document.documentElement.getAttribute("data-theme") === saved) return;
      document.documentElement.setAttribute("data-theme", saved);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      // storage unavailable (privacy mode) — the system theme still applies
    }
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisting is survivable; this page still switches.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <button
      onClick={toggle}
      // Names the destination, not the current state — the same wording the
      // home page has always used.
      className="rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-brass hover:text-ink"
    >
      {theme === "dark" ? "Daylight" : "Dusk"}
    </button>
  );
}
