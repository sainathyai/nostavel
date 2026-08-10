import Link from "next/link";

// Shared shell for static informational pages (About, Terms, etc.). Sticky
// header matches the rest of the site; the global footer comes from the layout.
export default function InfoPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col bg-parchment text-ink">
      <header className="sticky top-0 z-40 border-b border-line glass">
        <div className="mx-auto flex h-14 max-w-[760px] items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </Link>
          <Link href="/" className="text-[13px] text-soft hover:text-ink">
            Back to search
          </Link>
        </div>
      </header>
      <main className="rise mx-auto w-full max-w-[760px] flex-1 px-6 py-10">
        <h1 className="font-display text-[clamp(26px,4vw,36px)] leading-tight tracking-[-0.01em]">{title}</h1>
        {intro && <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-soft">{intro}</p>}
        <div className="mt-8 flex flex-col gap-6 text-[14.5px] leading-relaxed text-ink/90">{children}</div>
      </main>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-[19px]">{heading}</h2>
      <div className="text-soft">{children}</div>
    </section>
  );
}
