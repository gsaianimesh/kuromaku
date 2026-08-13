import "server-only";

/**
 * Normalised Levenshtein distance, 0 to 1 (SPEC 7.7).
 *
 * Two rows rather than a full matrix: drafts run to a few thousand characters
 * and a full matrix on a 4,000-character pair would allocate 16M cells for a
 * number we use once.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/**
 * 0 means the human changed nothing; 1 means they replaced it entirely.
 * Normalised by the longer string so a rewrite of a short draft and a rewrite
 * of a long one score comparably.
 */
export function normalisedEditDistance(before: string, after: string): number {
  const a = before.trim();
  const b = after.trim();
  if (a === b) return 0;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return Math.min(1, levenshtein(a, b) / longest);
}
