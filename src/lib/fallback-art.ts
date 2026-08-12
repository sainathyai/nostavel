// Deterministic placeholder art for a hotel/destination with no (or not-yet-loaded)
// photo — same seed always produces the same gradient, so it never flickers on rerender.
export function fallbackArt(seed: string) {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) % 360;
  const h2 = (n + 40) % 360;
  return `radial-gradient(120% 90% at 78% 12%, hsl(${h2} 40% 42%) 0%, transparent 55%), linear-gradient(150deg, hsl(${n} 32% 26%), hsl(${(n + 300) % 360} 30% 16%))`;
}
