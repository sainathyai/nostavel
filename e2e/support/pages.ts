// The four static info pages in scope for NOS-38, and the one shared footer
// nav every page renders (src/app/layout.tsx -> SiteFooter). Kept as data so
// each spec just iterates this list instead of re-deriving page facts.
//
// Verified against source directly (not guessed):
//   src/app/about/page.tsx, src/app/how-it-works/page.tsx,
//   src/app/terms/page.tsx, src/app/support/page.tsx,
//   src/components/InfoPage.tsx, src/components/SiteFooter.tsx

export interface StaticPage {
  /** Route path, used both to navigate and as the axe-baseline key. */
  path: string;
  /** The page's `export const metadata = { title }` — a stable loaded check. */
  metadataTitle: string;
  /** The exact text InfoPage renders as its single <h1>. */
  h1: string;
}

export const STATIC_PAGES: StaticPage[] = [
  {
    path: "/about",
    metadataTitle: "About · Nostavel",
    h1: "A concierge, not a search engine.",
  },
  {
    path: "/how-it-works",
    metadataTitle: "How it works · Nostavel",
    h1: "How Nostavel works",
  },
  {
    path: "/terms",
    metadataTitle: "Terms · Nostavel",
    h1: "Terms & privacy",
  },
  {
    path: "/support",
    metadataTitle: "Support · Nostavel",
    h1: "Support",
  },
];

/** SiteFooter's six links, in the exact DOM order it renders them. */
export const FOOTER_LINKS: ReadonlyArray<{ href: string; text: string }> = [
  { href: "/about", text: "About" },
  { href: "/how-it-works", text: "How it works" },
  { href: "/trips", text: "My trips" },
  { href: "/find", text: "Find a trip" },
  { href: "/support", text: "Support" },
  { href: "/terms", text: "Terms" },
];
