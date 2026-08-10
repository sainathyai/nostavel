// Small, dependency-free fuzzy matching for city autocomplete. Bounded Levenshtein
// (edit distance) so a typo like "Nashvile" still finds "Nashville" — used only as
// a fallback tier when prefix/substring matching comes up short, since exact
// matching is cheaper and usually right.
export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1; // can't possibly be within bound
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1; // whole row exceeded the bound, bail early
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Typo tolerance scales with query length. Distance 2 on a short query matches
// an implausible number of unrelated names (verified: "austn" at threshold 2
// pulled in Anson, Duson, Tustin — real distance-2 neighbors, just not what
// anyone meant), so most single-typo queries stay at threshold 1; only longer
// queries get room for a second typo.
export function fuzzyThreshold(queryLen: number): number {
  return queryLen <= 7 ? 1 : 2;
}
