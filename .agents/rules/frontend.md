---
name: frontend
description: Pages, client components and styling. Read before editing any .tsx page or anything in src/components.
globs:
  - "src/app/**/*.tsx"
  - "src/components/**"
---

# Frontend rules

Source of truth: `docs/conventions.md` §2, §4, §7 and §9. This file is a digest; when they differ, the conventions win.

## Next.js 16 and React 19
- **This is Next 16.** Read the matching guide in `node_modules/next/dist/docs/` before using a Next API. Don't rely on memory. `next lint` no longer exists (§9).
- **Page structure:** pages are server components that load data and pass props to a client component (`*Client.tsx`, `Experience.tsx`). Keep data fetching and secrets on the server side of that line.
- **Every prop that reaches a client component is public** (§2). Before adding a field, ask what it reveals. Supplier net prices, margins and internal IDs never cross.
- **Effects** (§9):
  - Never guard an effect with a once-only ref. Build on mount, tear down in cleanup.
  - Never call setState in an effect body for a value you can derive while rendering.

## Layout traps that already shipped (§9)
- A sticky panel that can be taller than the viewport needs a max height and internal scroll.
- A flex row pairing a label with a number needs `min-w-0` on the label and `shrink-0` on the number.

## Design system
- **Colours come from tokens only.** Use the Tailwind classes backed by `src/app/globals.css`: `parchment`, `parchment2`, `surface`, `line`, `ink`, `soft`, `brass`, `brassglow`, `sage`. Never write a raw hex value in a component.
- **Fonts:** `font-display` (Fraunces) for headings, `font-sans` (Geist) for body, `font-mono` for figures that need alignment.
- **Existing utilities:** `.btn-brass`, `.glass`, `.gloss`, `.gloss-lift`, `.smooth`, `.rise`, `.stagger`, `.rail`. Reuse them before inventing new ones.
- **Dark mode** is automatic (`prefers-color-scheme`) unless the viewer picked a theme; `ThemeToggle` stamps `data-theme` on `<html>`. Check both themes, and don't style against one hard-coded palette.
- **No UI library.** Components are hand-written Tailwind. Adding a UI dependency needs an ADR.

## Accessibility floor
- Every input has a label, and every meaningful image has `alt` (decorative images get `alt=""`).
- Everything clickable is a `button` or `a` and is reachable by keyboard. Don't remove the global `:focus-visible` outline.
- Motion must respect `prefers-reduced-motion`; the global rule already disables animations, so don't override it.
- Don't convey information by colour alone (prices, errors, availability).

## Claims on screen (§4)
- Deadlines, savings, fees and inclusions need a source in the API response or a measurement in `analysis/`. Otherwise show nothing.
- Label estimates as estimates (e.g. walking times from straight-line distance).

## Maps
- `public/maplibre-gl-*.mjs` are copies of the installed package. After a maplibre upgrade, run `npm run vendored:fix`; CI fails otherwise.
- The public basemap is down (the Protomaps build host stopped sending CORS headers). The map shows its fallback message until Segment 6. Don't work around it with another third-party tile host.

## Done
- Run `npm run verify`.
- Visual and interaction checks belong to the human owner (§7). Hand over the URL and say exactly what to look at: both themes, a phone-width viewport, keyboard focus.
