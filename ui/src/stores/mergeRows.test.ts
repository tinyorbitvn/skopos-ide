import { expect, test } from "vitest";
import { mergeAdded } from "./mergeRows";

const byName = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/** Rows as a batch leaves them: `listed` in order, then `added` at the end. */
function rowsOf(listed: string[], added: string[]): Map<string, string> {
  return new Map([...listed, ...added].map((name) => [name, name]));
}

test("rows added at the end move to their place before, between and after the listed ones", () => {
  const rows = rowsOf(["b", "d", "f"], ["g", "a", "e", "c"]);
  const merged = mergeAdded(rows, new Set(["g", "a", "e", "c"]), byName);
  expect([...merged.keys()]).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  expect(merged.get("e")).toBe("e");
});

test("an added row that was deleted before the merge is left out", () => {
  const rows = rowsOf(["b", "d"], ["a"]);
  const merged = mergeAdded(rows, new Set(["a", "c"]), byName);
  expect([...merged.keys()]).toEqual(["a", "b", "d"]);
});

test("with nothing left to place, the rows come back as they are", () => {
  const rows = rowsOf(["a", "b"], []);
  expect(mergeAdded(rows, new Set(), byName)).toBe(rows);
  expect(mergeAdded(rows, new Set(["gone"]), byName)).toBe(rows);
});

test("a row that keeps its listed place is not moved by the rows around it", () => {
  // The values differ from the keys: the order is the values', as a list's is its objects'.
  const rows = new Map([
    ["k1", "b"],
    ["k2", "d"],
    ["k3", "a"],
  ]);
  const merged = mergeAdded(rows, new Set(["k3"]), byName);
  expect([...merged]).toEqual([
    ["k3", "a"],
    ["k1", "b"],
    ["k2", "d"],
  ]);
});

test("many rounds of adds and deletes end in the order a full sort gives", () => {
  // A small generator with a fixed seed, so a failure can be run again.
  let seed = 20261120;
  const random = (below: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    // The low bits of such a generator repeat quickly.
    return (seed >>> 8) % below;
  };
  const name = () => `pod-${String(random(500)).padStart(3, "0")}`;
  let rows = new Map<string, string>();
  for (let round = 0; round < 200; round += 1) {
    const added = new Set<string>();
    for (let i = random(8); i > 0; i -= 1) {
      const key = name();
      if (!rows.has(key)) added.add(key);
      rows.set(key, key);
    }
    for (let i = random(4); i > 0; i -= 1) rows.delete(name());
    rows = mergeAdded(rows, added, byName);
    expect([...rows.keys()]).toEqual([...rows.keys()].sort(byName));
  }
  expect(rows.size).toBeGreaterThan(50);
});
