/**
 * `rows` with the rows of `added` moved from where they are, the end, to their place in
 * the order of `compare`. The other rows must be in that order already, and keep it.
 *
 * This is one pass over `rows` and a sort of the added rows alone. Sorting every row
 * again for each batch that adds one costs far more on a long list.
 */
export function mergeAdded<T>(
  rows: Map<string, T>,
  added: ReadonlySet<string>,
  compare: (a: T, b: T) => number,
): Map<string, T> {
  const fresh: [string, T][] = [];
  for (const key of added) {
    const row = rows.get(key);
    if (row !== undefined) fresh.push([key, row]);
  }
  if (fresh.length === 0) return rows;
  fresh.sort(([, a], [, b]) => compare(a, b));

  const merged = new Map<string, T>();
  let next = 0;
  for (const [key, row] of rows) {
    if (added.has(key)) continue;
    for (
      let entry = fresh[next];
      entry !== undefined && compare(entry[1], row) < 0;
      entry = fresh[next]
    ) {
      merged.set(entry[0], entry[1]);
      next += 1;
    }
    merged.set(key, row);
  }
  for (const [key, row] of fresh.slice(next)) merged.set(key, row);
  return merged;
}
