import Link from "next/link";

// Slim, site-wide footer. Rendered once in the root layout so every page shares it.
export default function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-auto border-t border-line bg-parchment">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-3 px-6 py-6 text-[12.5px] text-soft sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-brass shadow-[0_0_10px_1px_var(--brass-glow)]" />
          <span className="font-display text-[15px] text-ink">
            Nosta<span className="italic text-brass">vel</span>
          </span>
          <span className="ml-1.5">© {year} · A concierge, not a search engine.</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <Link href="/about" className="hover:text-ink">About</Link>
          <Link href="/how-it-works" className="hover:text-ink">How it works</Link>
          <Link href="/trips" className="hover:text-ink">My trips</Link>
          <Link href="/find" className="hover:text-ink">Find a trip</Link>
          <Link href="/support" className="hover:text-ink">Support</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}
