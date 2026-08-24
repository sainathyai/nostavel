"use client";

// Thin wrapper around the browser's native View Transitions API — not React's
// <ViewTransition>, which needs a React canary build this app deliberately
// does not run (package.json pins react/react-dom to stable 19.2.4; Next's
// own docs example assumes canary is already installed). The browser API
// needs no dependency change and covers same-page state swaps like the
// List/Map toggle, which is all that's used for today.
//
// Not a fit for cross-route morphs (stay card photo -> detail hero): that
// needs the DOM mutation and the browser snapshot to be coordinated with
// Next's router, which is what React's canary-only integration exists for.
export function withViewTransition(update: () => void) {
  const supported =
    typeof document !== "undefined" &&
    "startViewTransition" in document &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!supported) {
    update();
    return;
  }
  (document as Document & { startViewTransition: (cb: () => void) => void }).startViewTransition(update);
}
