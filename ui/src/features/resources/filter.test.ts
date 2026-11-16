import { describe, expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import {
  buildFilterIndex,
  chipText,
  type FilterOperator,
  type FilterProperty,
  filterText,
  keyCounts,
  LAST_APPLIED,
  matchChips,
  matchesFilter,
  type ObjectFilter,
  operatorsOf,
  parseFilter,
  passes,
  propertyWords,
  typedFilter,
  valueCounts,
} from "./filter";

const web: KubeObject = {
  metadata: {
    name: "web-1",
    namespace: "Team-A",
    labels: { app: "web", tier: "Front", "k8s.io/role": "edge" },
  },
};
const node: KubeObject = { metadata: { name: "node-1" } };
const scraped: KubeObject = {
  metadata: {
    name: "api-1",
    namespace: "shop",
    labels: { app: "api" },
    annotations: {
      "prometheus.io/scrape": "true",
      note: "",
      [LAST_APPLIED]: '{"secret":"hidden"}',
    },
  },
};

const NAME: FilterProperty = { type: "name" };
const NAMESPACE: FilterProperty = { type: "namespace" };
const label = (key: string): FilterProperty => ({ type: "label", key });
const anno = (key: string): FilterProperty => ({ type: "annotation", key });
const f = (
  property: FilterProperty,
  operator: FilterOperator,
  value: string,
): ObjectFilter => ({ property, operator, value });
const text = (value: string, operator: FilterOperator = ":") =>
  f({ type: "text" }, operator, value);

/** Today's search, now a text filter with `:` (spec M10). */
const search = (o: KubeObject, query: string) => matchesFilter(o, text(query));

describe("parseFilter", () => {
  test("nothing or white space gives null", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("   ")).toBeNull();
  });

  test("a property, an operator and a value give that filter, with spaces around the operator or none", () => {
    expect(parseFilter("name = web")).toEqual(f(NAME, "=", "web"));
    expect(parseFilter("name=web")).toEqual(f(NAME, "=", "web"));
    expect(parseFilter("  namespace   !=  shop  ")).toEqual(
      f(NAMESPACE, "!=", "shop"),
    );
    expect(parseFilter("label:tier : fr")).toEqual(f(label("tier"), ":", "fr"));
    expect(parseFilter("anno:note !: x y")).toEqual(
      f(anno("note"), "!:", "x y"),
    );
  });

  test("operators match longest first", () => {
    expect(parseFilter("label:a!=b")).toEqual(f(label("a"), "!=", "b"));
    expect(parseFilter("label:a!:b")).toEqual(f(label("a"), "!:", "b"));
    expect(parseFilter("label:a=!b")).toEqual(f(label("a"), "=", "!b"));
    expect(parseFilter("label:a:b=c")).toEqual(f(label("a"), ":", "b=c"));
  });

  test("the property ignores case; the key and the value keep theirs", () => {
    expect(parseFilter("NAME = Web")).toEqual(f(NAME, "=", "Web"));
    expect(parseFilter("NameSpace:Shop")).toEqual(f(NAMESPACE, ":", "Shop"));
    expect(parseFilter("LABEL:Tier = Front")).toEqual(
      f(label("Tier"), "=", "Front"),
    );
    expect(parseFilter("Anno:X = 1")).toEqual(f(anno("X"), "=", "1"));
  });

  test("keys may hold / and .", () => {
    expect(parseFilter("label:app.kubernetes.io/name=web")).toEqual(
      f(label("app.kubernetes.io/name"), "=", "web"),
    );
    expect(parseFilter("anno:prometheus.io/scrape = true")).toEqual(
      f(anno("prometheus.io/scrape"), "=", "true"),
    );
  });

  test("an empty value is any value for : and !:, and incomplete for = and !=", () => {
    expect(parseFilter("label:tier :")).toEqual(f(label("tier"), ":", ""));
    expect(parseFilter("anno:note !: ")).toEqual(f(anno("note"), "!:", ""));
    expect(parseFilter("name:")).toEqual(f(NAME, ":", ""));
    expect(parseFilter("label:tier =")).toBe("incomplete");
    expect(parseFilter("label:tier != ")).toBe("incomplete");
    expect(parseFilter("namespace =")).toBe("incomplete");
  });

  test("a property alone is incomplete once a space follows it; label: and anno: are until an operator", () => {
    expect(parseFilter("name ")).toBe("incomplete");
    expect(parseFilter("namespace  ")).toBe("incomplete");
    expect(parseFilter("label:tier ")).toBe("incomplete");
    expect(parseFilter("label:tier")).toBe("incomplete");
    expect(parseFilter("anno:")).toBe("incomplete");
    expect(parseFilter("label:")).toBe("incomplete");
    expect(parseFilter("label:tier web")).toBe("incomplete");
  });

  test("any other text is a text filter, so name, namespace and k=v search as before", () => {
    expect(parseFilter("web")).toEqual(text("web"));
    expect(parseFilter("  web  team-a ")).toEqual(text("web  team-a"));
    expect(parseFilter("name")).toEqual(text("name"));
    expect(parseFilter("namespace")).toEqual(text("namespace"));
    expect(parseFilter("app=web")).toEqual(text("app=web"));
    expect(parseFilter("names=web")).toEqual(text("names=web"));
    expect(parseFilter("name web")).toEqual(text("name web"));
  });

  test("typedFilter keeps only a filter", () => {
    expect(typedFilter("app=web")).toEqual(text("app=web"));
    expect(typedFilter("label:tier =")).toBeNull();
    expect(typedFilter(" ")).toBeNull();
  });
});

describe("text forms and words", () => {
  test("a filter reads property, operator, value; a text filter is quoted", () => {
    expect(filterText(f(label("tier"), "=", "web"))).toBe("label:tier = web");
    expect(filterText(f(anno("a/b"), ":", ""))).toBe("anno:a/b :");
    expect(filterText(f(NAME, "!=", "x"))).toBe("name != x");
    expect(filterText(f(NAMESPACE, "!:", "x"))).toBe("namespace !: x");
    expect(filterText(text("web"))).toBe('"web"');
    expect(filterText(text("web", "!:"))).toBe('not "web"');
  });

  test("properties have words and their operators", () => {
    expect(propertyWords(label("tier"))).toBe("Label tier");
    expect(propertyWords(anno("prometheus.io/scrape"))).toBe(
      "Annotation prometheus.io/scrape",
    );
    expect(propertyWords(NAME)).toBe("Name");
    expect(propertyWords(NAMESPACE)).toBe("Namespace");
    expect(propertyWords({ type: "text" })).toBe("Free text");
    expect(operatorsOf({ type: "text" })).toEqual([":", "!:"]);
    expect(operatorsOf(NAME)).toEqual(["=", "!=", ":", "!:"]);
  });
});

describe("text filters keep today's search", () => {
  test("an empty query matches everything", () => {
    expect(search(web, "")).toBe(true);
    expect(search(node, "   ")).toBe(true);
  });

  test("matches the name", () => {
    expect(search(web, "web-")).toBe(true);
    expect(search(web, "absent")).toBe(false);
  });

  test("matches the namespace", () => {
    expect(search(web, "team-a")).toBe(true);
    expect(search(node, "team-a")).toBe(false);
  });

  test("matches a label key or value", () => {
    expect(search(web, "tier")).toBe(true);
    expect(search(web, "front")).toBe(true);
    expect(search(node, "front")).toBe(false);
  });

  test("k=v matches a label with that key and value", () => {
    expect(search(web, "app=web")).toBe(true);
    expect(search(web, "k8s.io/role=edge")).toBe(true);
    // Each side has to match the whole of its part.
    expect(search(web, "app=we")).toBe(false);
    expect(search(web, "ap=web")).toBe(false);
    expect(search(web, "tier=web")).toBe(false);
    expect(search(node, "app=web")).toBe(false);
  });

  test("terms separated by spaces must all match", () => {
    expect(search(web, "web team-a")).toBe(true);
    expect(search(web, "web   app=web  front")).toBe(true);
    expect(search(web, "web team-b")).toBe(false);
    expect(search(web, "app=web tier=back")).toBe(false);
  });

  test("matching ignores case", () => {
    expect(search(web, "WEB-1")).toBe(true);
    expect(search(web, "TEAM-a")).toBe(true);
    expect(search(web, "TIER=front")).toBe(true);
  });

  test("an object without labels or a namespace is fine", () => {
    expect(search(node, "node")).toBe(true);
    expect(search(node, "k=v")).toBe(false);
  });

  test("text never reads annotations, and !: turns it around", () => {
    expect(search(scraped, "scrape")).toBe(false);
    expect(matchesFilter(web, text("web", "!:"))).toBe(false);
    expect(matchesFilter(web, text("absent", "!:"))).toBe(true);
  });
});

describe("matchesFilter", () => {
  test("name and namespace: equals, does not equal, contains, does not contain, ignoring case", () => {
    expect(matchesFilter(web, f(NAME, "=", "WEB-1"))).toBe(true);
    expect(matchesFilter(web, f(NAME, "=", "web"))).toBe(false);
    expect(matchesFilter(web, f(NAME, "!=", "web"))).toBe(true);
    expect(matchesFilter(web, f(NAME, "!=", "web-1"))).toBe(false);
    expect(matchesFilter(web, f(NAME, ":", "EB"))).toBe(true);
    expect(matchesFilter(web, f(NAME, "!:", "eb"))).toBe(false);
    expect(matchesFilter(web, f(NAMESPACE, "=", "team-a"))).toBe(true);
    expect(matchesFilter(web, f(NAMESPACE, ":", "team"))).toBe(true);
    expect(matchesFilter(web, f(NAMESPACE, "!:", "shop"))).toBe(true);
  });

  test("a cluster-scoped object's namespace is empty", () => {
    expect(matchesFilter(node, f(NAMESPACE, ":", ""))).toBe(true);
    expect(matchesFilter(node, f(NAMESPACE, "!=", "x"))).toBe(true);
    expect(matchesFilter(node, f(NAMESPACE, ":", "x"))).toBe(false);
  });

  test("labels: the key compared ignoring case, and each operator", () => {
    expect(matchesFilter(web, f(label("TIER"), "=", "front"))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), "=", "fro"))).toBe(false);
    expect(matchesFilter(web, f(label("tier"), "!=", "back"))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), "!=", "Front"))).toBe(false);
    expect(matchesFilter(node, f(label("tier"), "!=", "front"))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), ":", "ron"))).toBe(true);
    expect(matchesFilter(node, f(label("tier"), ":", "ron"))).toBe(false);
    expect(matchesFilter(web, f(label("tier"), "!:", "ron"))).toBe(false);
    expect(matchesFilter(node, f(label("tier"), "!:", "ron"))).toBe(true);
  });

  test("annotations: each operator", () => {
    const scrape = anno("prometheus.io/scrape");
    expect(matchesFilter(scraped, f(scrape, "=", "TRUE"))).toBe(true);
    expect(matchesFilter(scraped, f(scrape, "!=", "true"))).toBe(false);
    expect(matchesFilter(web, f(scrape, "!=", "true"))).toBe(true);
    expect(matchesFilter(scraped, f(scrape, ":", "ru"))).toBe(true);
    expect(matchesFilter(scraped, f(scrape, "!:", "ru"))).toBe(false);
    expect(matchesFilter(web, f(scrape, "!:", "ru"))).toBe(true);
  });

  test("an empty value with : means the key is there, and with !: that it is missing", () => {
    expect(matchesFilter(scraped, f(anno("note"), ":", ""))).toBe(true);
    expect(matchesFilter(web, f(anno("note"), ":", ""))).toBe(false);
    expect(matchesFilter(scraped, f(anno("note"), "!:", ""))).toBe(false);
    expect(matchesFilter(web, f(anno("note"), "!:", ""))).toBe(true);
    expect(matchesFilter(web, f(label("tier"), ":", ""))).toBe(true);
    expect(matchesFilter(node, f(label("tier"), "!:", ""))).toBe(true);
  });

  test("the last-applied annotation never matches, in any case of its key", () => {
    const applied = anno(LAST_APPLIED);
    expect(matchesFilter(scraped, f(applied, ":", ""))).toBe(false);
    expect(matchesFilter(scraped, f(applied, ":", "secret"))).toBe(false);
    expect(matchesFilter(scraped, f(applied, "!:", ""))).toBe(true);
    expect(
      matchesFilter(scraped, f(anno(LAST_APPLIED.toUpperCase()), ":", "")),
    ).toBe(false);
  });
});

describe("passes", () => {
  const tier = f(label("tier"), "=", "front");
  const scrape = f(anno("prometheus.io/scrape"), "=", "true");

  test("and needs every token, or any; no token passes everything", () => {
    expect(passes(web, [tier, scrape], "and", null)).toBe(false);
    expect(passes(web, [tier, scrape], "or", null)).toBe(true);
    expect(passes(scraped, [tier, scrape], "or", null)).toBe(true);
    expect(passes(node, [tier, scrape], "or", null)).toBe(false);
    expect(passes(node, [], "and", null)).toBe(true);
    expect(passes(node, [], "or", null)).toBe(true);
  });

  test("the typed filter always narrows, whatever the join", () => {
    expect(passes(web, [tier, scrape], "or", text("api"))).toBe(false);
    expect(passes(scraped, [tier, scrape], "or", text("api"))).toBe(true);
    expect(passes(web, [], "or", text("absent"))).toBe(false);
    expect(passes(web, [], "and", f(NAME, ":", "web"))).toBe(true);
  });
});

describe("matchChips", () => {
  test("a label or annotation that matched with = or : gives a chip", () => {
    expect(
      matchChips(scraped, [
        f(anno("prometheus.io/scrape"), "=", "true"),
        f(label("APP"), ":", "ap"),
      ]),
    ).toEqual([
      { kind: "anno", key: "prometheus.io/scrape", value: "true" },
      { kind: "label", key: "app", value: "api" },
    ]);
  });

  test("a text word that matched a label gives a chip, k=v or part of a key or value", () => {
    expect(matchChips(web, [text("app=web")])).toEqual([
      { kind: "label", key: "app", value: "web" },
    ]);
    expect(matchChips(web, [text("fron edge")])).toEqual([
      { kind: "label", key: "tier", value: "Front" },
      { kind: "label", key: "k8s.io/role", value: "edge" },
    ]);
  });

  test("!=, !:, names, namespaces, filters that do not match and duplicates add none", () => {
    expect(
      matchChips(web, [
        f(label("tier"), "!=", "back"),
        f(label("app"), "!:", "x"),
        f(NAME, "=", "web-1"),
        f(NAMESPACE, ":", "team"),
        f(label("tier"), "=", "back"),
        text("web-1"),
      ]),
    ).toEqual([]);
    expect(
      matchChips(web, [f(label("app"), "=", "web"), text("app=web")]),
    ).toEqual([{ kind: "label", key: "app", value: "web" }]);
  });

  test("the last-applied annotation never gives a chip", () => {
    expect(matchChips(scraped, [f(anno(LAST_APPLIED), ":", "")])).toEqual([]);
  });

  test("chipText is key=value", () => {
    expect(chipText({ kind: "anno", key: "a/b", value: "c" })).toBe("a/b=c");
  });
});

describe("the filter index", () => {
  const objects: KubeObject[] = [
    {
      metadata: {
        name: "a",
        namespace: "shop",
        labels: { tier: "web", app: "a" },
        annotations: { note: "x", [LAST_APPLIED]: "{}" },
      },
    },
    {
      metadata: {
        name: "b",
        namespace: "shop",
        labels: { tier: "web" },
        annotations: { note: "" },
      },
    },
    {
      metadata: { name: "c", namespace: "ops", labels: { tier: "db" } },
    },
    { metadata: { name: "n1" } },
  ];
  const index = buildFilterIndex(objects);

  test("keys count the objects that carry them, most common first, then by key, never last-applied", () => {
    expect(keyCounts(index, "label")).toEqual([
      { text: "tier", count: 3 },
      { text: "app", count: 1 },
    ]);
    expect(keyCounts(index, "annotation")).toEqual([
      { text: "note", count: 2 },
    ]);
  });

  test("values count per property, most common first, then by value", () => {
    expect(valueCounts(index, label("tier"))).toEqual([
      { text: "web", count: 2 },
      { text: "db", count: 1 },
    ]);
    expect(valueCounts(index, label("TIER"))).toEqual(
      valueCounts(index, label("tier")),
    );
    expect(valueCounts(index, anno("note"))).toEqual([
      { text: "", count: 1 },
      { text: "x", count: 1 },
    ]);
    expect(valueCounts(index, NAMESPACE)).toEqual([
      { text: "shop", count: 2 },
      { text: "", count: 1 },
      { text: "ops", count: 1 },
    ]);
    expect(valueCounts(index, NAME).map((c) => c.text)).toEqual([
      "a",
      "b",
      "c",
      "n1",
    ]);
    expect(valueCounts(index, anno(LAST_APPLIED))).toEqual([]);
    expect(valueCounts(index, { type: "text" })).toEqual([]);
  });
});
