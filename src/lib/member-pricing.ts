// How much a member could save vs. the public (SSP) price, rounded down to a
// clean 5% band — used to tease the member rate to logged-out visitors
// without revealing the exact net price (that would break rate parity).
export function memberSavingsBand(you: number, them?: number | null): number {
  if (!them || you >= them) return 0;
  return Math.min(60, Math.ceil((((them - you) / them) * 100) / 5) * 5);
}
